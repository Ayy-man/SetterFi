import { describe, expect, it, vi } from "vitest";

import { isPublicIngressPath } from "@/lib/auth/claims";
import { createMockStripeEventFixtures } from "@/lib/integrations/stripe/mock";
import type { ClaimedStripeWebhookReceipt } from "@/lib/repositories/stripe-webhooks";

import { createStripeWebhookJobHandler } from "./handler";

const fixtures = createMockStripeEventFixtures();

function claimed(id: string, kind: "invoice" | "unsupported" = "invoice"): ClaimedStripeWebhookReceipt {
  const event = kind === "unsupported" ? fixtures.unknown : fixtures.invoicePaid;
  return {
    id,
    eventId: `${event.id}_${id}`,
    eventType: event.type,
    tenantId: null,
    event: { ...event, id: `${event.id}_${id}` },
    status: "received",
    attempts: 1,
    error: "STRIPE_CLAIM:2026-08-17T12:00:00.000Z:claim_synthetic",
    receivedAt: "2026-08-17T12:00:00.000Z",
    processedAt: null,
    result: null,
    inserted: false,
    claimToken: "claim_synthetic",
  };
}

function request(token = "synthetic-cron-token") {
  return new Request("http://localhost/api/jobs/stripe-webhooks", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

function setup(overrides: Partial<Parameters<typeof createStripeWebhookJobHandler>[0]> = {}) {
  const claimBatch = vi.fn(async () => [] as ClaimedStripeWebhookReceipt[]);
  const processReceipt = vi.fn(async (receipt: ClaimedStripeWebhookReceipt) => ({
    status: receipt.event.type === "unsupported" ? "skipped" as const : "processed" as const,
  }));
  const dependencies = {
    enabled: () => true,
    secret: "synthetic-cron-token",
    claimBatch,
    processReceipt,
    ...overrides,
  };
  const handler = createStripeWebhookJobHandler(dependencies);
  return {
    handler,
    claimBatch: dependencies.claimBatch,
    processReceipt: dependencies.processReceipt,
  };
}

describe("Stripe webhook replay job", () => {
  it("keeps the job prefix public while requiring the CRON secret in the handler", () => {
    expect(isPublicIngressPath("/api/jobs/stripe-webhooks")).toBe(true);
  });

  it("rejects absent, wrong, and unconfigured secrets without claiming work", async () => {
    for (const input of [
      { request: request("wrong"), secret: "synthetic-cron-token" },
      { request: new Request("http://localhost/api/jobs/stripe-webhooks", { method: "POST" }), secret: "synthetic-cron-token" },
      { request: request(), secret: null },
    ]) {
      const { handler, claimBatch } = setup({ secret: input.secret });
      const response = await handler(input.request);
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(claimBatch).not.toHaveBeenCalled();
    }
  });

  it("does nothing while either Phase 6 Stripe flag is off", async () => {
    const { handler, claimBatch } = setup({ enabled: () => false });
    const response = await handler(request());
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(claimBatch).not.toHaveBeenCalled();
  });

  it("claims at most 25 receipts and returns processed, skipped, and failed counts", async () => {
    const receipts = [claimed("one"), claimed("two", "unsupported"), claimed("three")];
    const processReceipt = vi.fn(async (receipt: ClaimedStripeWebhookReceipt) => {
      if (receipt.id === "three") throw new Error("PROCESSING_FAILED");
      return { status: receipt.event.type === "unsupported" ? "skipped" as const : "processed" as const };
    });
    const { handler, claimBatch } = setup({
      claimBatch: vi.fn(async () => receipts),
      processReceipt,
    });

    const response = await handler(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(claimBatch).toHaveBeenCalledWith(25);
    expect(await response.json()).toEqual({ selected: 3, processed: 1, skipped: 1, failed: 1 });
  });

  it("continues after a processing failure and allows the failed receipt to replay", async () => {
    const failed = claimed("failed");
    const other = claimed("other");
    const claimBatch = vi.fn()
      .mockResolvedValueOnce([failed, other])
      .mockResolvedValueOnce([{ ...failed, attempts: 2 }]);
    const processReceipt = vi.fn()
      .mockRejectedValueOnce(new Error("TRANSIENT_FAILURE"))
      .mockResolvedValueOnce({ status: "processed" })
      .mockResolvedValueOnce({ status: "processed" });
    const { handler } = setup({ claimBatch, processReceipt });

    const first = await handler(request());
    const second = await handler(request());

    expect(await first.json()).toEqual({ selected: 2, processed: 1, skipped: 0, failed: 1 });
    expect(await second.json()).toEqual({ selected: 1, processed: 1, skipped: 0, failed: 0 });
    expect(processReceipt).toHaveBeenCalledTimes(3);
  });

  it("fails closed when the durable inbox cannot be claimed", async () => {
    const { handler } = setup({
      claimBatch: vi.fn().mockRejectedValue(new Error("DB_UNAVAILABLE")),
    });
    const response = await handler(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
