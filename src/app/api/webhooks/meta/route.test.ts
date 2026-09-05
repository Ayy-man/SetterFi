import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createMetaWebhookHandler,
  createMetaWebhookVerificationHandler,
} from "./handler";
import type { NormalizedInboundBatch } from "@/lib/integrations/types";
import { processInboundReceipt, type WebhookReceiptRead } from "@/lib/webhooks/process-inbound";

const APP_SECRET = "synthetic-meta-route-secret";

const message = {
  kind: "message" as const,
  eventId: "message-1",
  providerMessageId: "message-1",
  body: "Hello",
  externalAccountId: "page-active",
  identity: {
    channel: "messenger" as const,
    provider: "meta_direct" as const,
    externalId: "lead-1",
    normalizedPhone: null,
    normalizedEmail: null,
  },
  providerWindow: {
    observedAt: "2026-08-17T00:00:00.000Z",
    expiresAt: "2026-08-18T00:00:00.000Z",
    source: "derived_24h" as const,
  },
};

function request(payload: unknown, signature = true) {
  const body = JSON.stringify(payload);
  return new Request("https://setterfi.test/api/webhooks/meta", {
    method: "POST",
    headers: signature
      ? { "x-hub-signature-256": `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}` }
      : { "x-hub-signature-256": "sha256=invalid" },
    body,
  });
}

function dependencies(batch: NormalizedInboundBatch) {
  const scheduled: Array<() => Promise<unknown>> = [];
  const persistReceipt = vi.fn(async (input) => ({
    id: `receipt-${input.providerEventId}`,
    ...input,
    status: "received" as const,
    inserted: true,
  }));
  const processReceipt = vi.fn(async (receipt: WebhookReceiptRead): Promise<void> => {
    void receipt;
  });
  const resolveTenant = vi.fn(async (externalAccountId: string): Promise<string | null> =>
    externalAccountId === "page-active" ? "tenant-1" : null
  );
  return {
    scheduled,
    persistReceipt,
    processReceipt,
    resolveTenant,
    handler: createMetaWebhookHandler({
      driver: {
        verifyWebhook: async (bytes, signature) => {
          const expected = `sha256=${createHmac("sha256", APP_SECRET).update(bytes).digest("hex")}`;
          return signature === expected;
        },
        normalizeInbound: async () => batch,
      },
      resolveTenant,
      persistReceipt,
      processReceipt,
      schedule: (callback) => scheduled.push(callback),
    }),
  };
}

describe("Meta webhook route", () => {
  beforeEach(() => vi.stubEnv("SETTERFI_PHASE4_LIVE", "true"));
  afterEach(() => vi.unstubAllEnvs());

  it("returns the exact challenge only for the configured subscribe token", async () => {
    const get = createMetaWebhookVerificationHandler({ verifyToken: () => "verify-me" });
    const accepted = await get(new Request(
      "https://setterfi.test/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=exact-challenge",
    ));
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toBe("exact-challenge");
    expect(accepted.headers.get("Cache-Control")).toBe("no-store");

    const refused = await get(new Request(
      "https://setterfi.test/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=ignored",
    ));
    expect(refused.status).toBe(403);
  });

  it("does not expose Meta webhooks to a GHL-only first-customer deployment", async () => {
    vi.stubEnv("SETTERFI_PHASE1_LIVE", "true");
    vi.stubEnv("SETTERFI_PHASE4_LIVE", "false");
    const verifyToken = vi.fn(() => "verify-me");
    const get = createMetaWebhookVerificationHandler({ verifyToken });
    const response = await get(new Request(
      "https://setterfi.test/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=ignored",
    ));
    expect(response.status).toBe(404);
    expect(verifyToken).not.toHaveBeenCalled();

    const route = dependencies({ events: [message] });
    expect((await route.handler(request({ object: "page" }))).status).toBe(404);
    expect(route.persistReceipt).not.toHaveBeenCalled();
  });

  it("fails a bad signature before normalization, tenant lookup, or persistence", async () => {
    const route = dependencies({ events: [message] });
    const response = await route.handler(request({ object: "page" }, false));
    expect(response.status).toBe(401);
    expect(route.resolveTenant).not.toHaveBeenCalled();
    expect(route.persistReceipt).not.toHaveBeenCalled();
  });

  it("persists every signed batch event and absorbs a processed replay", async () => {
    const route = dependencies({
      events: [
        message,
        { ...message, eventId: "message-2", providerMessageId: "message-2" },
      ],
    });
    const seen = new Set<string>();
    route.persistReceipt.mockImplementation(async (input) => {
      const inserted = !seen.has(input.providerEventId);
      seen.add(input.providerEventId);
      return {
        id: `receipt-${input.providerEventId}`,
        ...input,
        status: inserted ? "received" as const : "processed" as const,
        inserted,
      };
    });

    expect((await route.handler(request({ object: "page" }))).status).toBe(200);
    expect(route.persistReceipt).toHaveBeenCalledTimes(2);
    expect(route.scheduled).toHaveLength(2);
    for (const scheduled of route.scheduled.splice(0)) await scheduled();
    expect(route.processReceipt).toHaveBeenCalledTimes(2);

    expect((await route.handler(request({ object: "page" }))).status).toBe(200);
    expect(route.persistReceipt).toHaveBeenCalledTimes(4);
    expect(route.scheduled).toHaveLength(0);
  });

  it("acknowledges echo and status receipts without engine or outbound work", async () => {
    const runEngine = vi.fn();
    const sendToLead = vi.fn();
    const route = dependencies({
      events: [
        { kind: "ignored", eventId: "echo-1", externalAccountId: "page-active", reason: "echo" },
        { kind: "status", eventId: "status-1", externalAccountId: "page-active", status: "delivered" },
      ],
    });
    route.processReceipt.mockImplementation(async (receipt: WebhookReceiptRead) => {
      await processInboundReceipt({
        id: receipt.id,
        leaseToken: "00000000-0000-4000-8000-000000000001",
        attemptNumber: 1,
        tenantId: receipt.tenantId ?? "",
        provider: "meta_direct",
        batch: receipt.payload.normalized as NormalizedInboundBatch,
      }, {
        tenantAccess: { assertInboundAllowed: vi.fn(async () => ({ allowed: true as const, existingConversation: false })) },
        persistInbound: vi.fn(),
        loadConversation: vi.fn(),
        loadHistory: vi.fn(),
        loadQualificationState: vi.fn(),
        loadEngineTurn: vi.fn(),
        recordEngineTurn: vi.fn(),
        markEngineTurnDelivered: vi.fn(),
        completeEngineTurn: vi.fn(),
        resumeConversation: vi.fn(),
        consumeRateLimit: vi.fn(),
        processSuppression: vi.fn(),
        cancelCadence: vi.fn(),
        reanchorCadence: vi.fn(),
        loadInboundSafety: vi.fn(),
        loadContactIsTest: vi.fn(),
        persistInboundSafety: { applyScopeSignal: vi.fn(), applyTripwireSignal: vi.fn() },
        runEngine,
        sendToLead,
        persistResult: vi.fn(),
        markReceipt: vi.fn(),
      });
    });

    expect((await route.handler(request({ object: "page" }))).status).toBe(200);
    for (const scheduled of route.scheduled) await scheduled();
    expect(runEngine).not.toHaveBeenCalled();
    expect(sendToLead).not.toHaveBeenCalled();
  });

  it("ignores a demoted historical mapping and refuses ambiguous active mappings before writes", async () => {
    const historical = dependencies({ events: [message] });
    historical.resolveTenant.mockImplementation(async (accountId) => {
      const rows = [
        { accountId, state: "disconnected", tenantId: "tenant-old" },
        { accountId, state: "ready", tenantId: "tenant-current" },
      ].filter((row) => ["ready", "live"].includes(row.state));
      return rows.length === 1 ? rows[0].tenantId : null;
    });
    expect((await historical.handler(request({ object: "page" }))).status).toBe(200);
    expect(historical.persistReceipt).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-current",
    }));

    const ambiguous = dependencies({ events: [message] });
    ambiguous.resolveTenant.mockResolvedValue(null);
    expect((await ambiguous.handler(request({ object: "page" }))).status).toBe(404);
    expect(ambiguous.persistReceipt).not.toHaveBeenCalled();
  });

  it("uses 400 for a signed invalid envelope and 503 for lookup or receipt infrastructure", async () => {
    const invalid = dependencies({ events: [message] });
    invalid.handler = createMetaWebhookHandler({
      driver: {
        verifyWebhook: async () => true,
        normalizeInbound: async () => { throw new Error("invalid envelope"); },
      },
      resolveTenant: invalid.resolveTenant,
      persistReceipt: invalid.persistReceipt,
      processReceipt: invalid.processReceipt,
      schedule: (callback) => invalid.scheduled.push(callback),
    });
    expect((await invalid.handler(request({ object: "invalid" }))).status).toBe(400);

    const lookup = dependencies({ events: [message] });
    lookup.resolveTenant.mockRejectedValue(new Error("database unavailable"));
    expect((await lookup.handler(request({ object: "page" }))).status).toBe(503);
    expect(lookup.persistReceipt).not.toHaveBeenCalled();

    const persistence = dependencies({ events: [message] });
    persistence.persistReceipt.mockRejectedValue(new Error("database unavailable"));
    expect((await persistence.handler(request({ object: "page" }))).status).toBe(503);
  });
});
