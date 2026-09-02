import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { isPublicIngressPath } from "@/lib/auth/claims";
import {
  createMockStripeDriver,
  createMockStripeEventFixtures,
  mockStripeWebhookBody,
} from "@/lib/integrations/stripe/mock";
import type { StripeEvent } from "@/lib/integrations/stripe/types";
import type { StripeWebhookReceipt } from "@/lib/repositories/stripe-webhooks";

import { createStripeWebhookHandler } from "./handler";

const SYNTHETIC_SECRET = "setterfi-synthetic-stripe-webhook-secret";
const NOW = new Date("2026-08-17T12:00:00.000Z");
const fixtures = createMockStripeEventFixtures({ clock: () => NOW });

function signature(body: Uint8Array, timestamp = Math.floor(NOW.getTime() / 1_000)) {
  const digest = createHmac("sha256", SYNTHETIC_SECRET)
    .update(`${timestamp}.`)
    .update(body)
    .digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

function receipt(event: StripeEvent, inserted = true): StripeWebhookReceipt {
  return {
    id: "receipt_synthetic",
    eventId: event.id,
    eventType: event.type,
    tenantId: null,
    event,
    status: "received",
    attempts: 0,
    error: null,
    receivedAt: NOW.toISOString(),
    processedAt: null,
    result: null,
    inserted,
  };
}

function signedRequest(event: StripeEvent, options: { body?: Uint8Array; timestamp?: number } = {}) {
  const body = options.body ?? mockStripeWebhookBody(event);
  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    body: Buffer.from(body),
    headers: { "Stripe-Signature": signature(body, options.timestamp) },
  });
}

function setup(overrides: Partial<Parameters<typeof createStripeWebhookHandler>[0]> = {}) {
  const driver = createMockStripeDriver({
    clock: () => NOW,
    webhookSecret: SYNTHETIC_SECRET,
  });
  const persistReceipt = vi.fn(async (event: StripeEvent) => receipt(event));
  const processReceipt = vi.fn(async () => undefined);
  const scheduled: Promise<void>[] = [];
  const dependencies = {
    enabled: () => true,
    driver,
    persistReceipt,
    processReceipt,
    schedule: (callback: () => Promise<void>) => { scheduled.push(callback()); },
    ...overrides,
  };
  const handler = createStripeWebhookHandler(dependencies);
  return {
    handler,
    persistReceipt: dependencies.persistReceipt,
    processReceipt: dependencies.processReceipt,
    scheduled,
  };
}

describe("Stripe webhook ingress", () => {
  it("keeps the webhook prefix public while signature verification remains route-local", () => {
    expect(isPublicIngressPath("/api/webhooks/stripe")).toBe(true);
  });

  it("fails closed before reading the body when live provider configuration is unavailable", async () => {
    const arrayBuffer = vi.fn();
    const { handler, persistReceipt } = setup({ enabled: () => { throw new Error("missing selector"); } });
    const response = await handler({
      headers: new Headers({ "stripe-signature": "synthetic" }),
      arrayBuffer,
    } as unknown as Request);
    expect(response.status).toBe(503);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(persistReceipt).not.toHaveBeenCalled();
  });

  it("does not read, parse, persist, or schedule when the signature is absent", async () => {
    const arrayBuffer = vi.fn();
    const { handler, persistReceipt, processReceipt } = setup();
    const response = await handler({
      headers: new Headers(),
      arrayBuffer,
    } as unknown as Request);

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(persistReceipt).not.toHaveBeenCalled();
    expect(processReceipt).not.toHaveBeenCalled();
  });

  it("verifies exact raw bytes, persists before scheduling, and exposes no provider payload", async () => {
    const order: string[] = [];
    const persistReceipt = vi.fn(async (event: StripeEvent) => {
      order.push("persist");
      return receipt(event);
    });
    const processReceipt = vi.fn(async () => { order.push("process"); });
    const { handler, scheduled } = setup({ persistReceipt, processReceipt });

    const response = await handler(signedRequest(fixtures.invoicePaid));
    await Promise.all(scheduled);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(order).toEqual(["persist", "process"]);
    expect(persistReceipt).toHaveBeenCalledWith(fixtures.invoicePaid);
    expect(body).not.toContain("amountPaidCents");
    expect(body).not.toContain(SYNTHETIC_SECRET);
  });

  it("rejects raw mutation, wrong signatures, and out-of-tolerance timestamps without a row", async () => {
    const original = mockStripeWebhookBody(fixtures.invoicePaid);
    const mutated = new TextEncoder().encode(`${new TextDecoder().decode(original)} `);
    const cases = [
      new Request("http://localhost/api/webhooks/stripe", {
        method: "POST",
        body: Buffer.from(mutated),
        headers: { "Stripe-Signature": signature(original) },
      }),
      new Request("http://localhost/api/webhooks/stripe", {
        method: "POST",
        body: Buffer.from(original),
        headers: { "Stripe-Signature": "t=1786968000,v1=wrong" },
      }),
      signedRequest(fixtures.invoicePaid, {
        timestamp: Math.floor(NOW.getTime() / 1_000) - 301,
      }),
    ];

    for (const request of cases) {
      const { handler, persistReceipt } = setup();
      const response = await handler(request);
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(persistReceipt).not.toHaveBeenCalled();
    }
  });

  it("returns the existing receipt on duplicate event ids and does not reschedule terminal work", async () => {
    const persistReceipt = vi.fn()
      .mockResolvedValueOnce(receipt(fixtures.subscriptionUpdated, true))
      .mockResolvedValueOnce({
        ...receipt(fixtures.subscriptionUpdated, false),
        status: "processed",
        processedAt: NOW.toISOString(),
        result: {
          kind: "subscription_updated",
          tenantId: "tenant_fixture",
          subscriptionRowId: "subscription_row_synthetic",
          status: "active",
        },
      });
    const { handler, processReceipt, scheduled } = setup({ persistReceipt });

    const first = await handler(signedRequest(fixtures.subscriptionUpdated));
    await Promise.all(scheduled);
    const second = await handler(signedRequest(fixtures.subscriptionUpdated));

    expect(first.status).toBe(200);
    expect(await second.json()).toMatchObject({ duplicate: true, status: "processed" });
    expect(processReceipt).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the feature flag is off or durable persistence fails", async () => {
    const off = setup({ enabled: () => false });
    const offResponse = await off.handler(signedRequest(fixtures.invoicePaid));
    expect(offResponse.status).toBe(404);
    expect(offResponse.headers.get("cache-control")).toBe("no-store");
    expect(off.persistReceipt).not.toHaveBeenCalled();

    const down = setup({ persistReceipt: vi.fn().mockRejectedValue(new Error("DB_UNAVAILABLE")) });
    const downResponse = await down.handler(signedRequest(fixtures.invoicePaid));
    expect(downResponse.status).toBe(503);
    expect(downResponse.headers.get("cache-control")).toBe("no-store");
    expect(down.processReceipt).not.toHaveBeenCalled();
  });
});
