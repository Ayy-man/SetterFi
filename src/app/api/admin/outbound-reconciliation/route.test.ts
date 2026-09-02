import { describe, expect, it, vi } from "vitest";

import { createOutboundReconciliationAdminHandler } from "./handler";

const ACTOR = { userId: "actor-1", role: "admin" as const, tenantId: null };
const body = {
  tenantId: "tenant-1",
  idempotencyKey: "inbound:ghl:provider-1",
  resolution: "accepted" as const,
  providerMessageId: "provider-outbound-1",
  acceptedAt: "2026-08-27T12:00:00.000Z",
  evidence: {
    provider: "ghl" as const,
    channel: "sms" as const,
    kind: "provider_receipt" as const,
    evidenceId: "receipt-evidence-1",
    result: "accepted" as const,
    providerMessageId: "provider-outbound-1",
    observedAt: "2026-08-27T12:01:00.000Z",
  },
  reason: "Provider receipt confirms acceptance.",
};

function request(value: unknown = body) {
  return new Request("https://setterfi.test/api/admin/outbound-reconciliation", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
  });
}

describe("outbound reconciliation admin API", () => {
  it("requires a non-impersonating platform operator", async () => {
    const reconcile = vi.fn(async () => "42");
    expect((await createOutboundReconciliationAdminHandler({
      enabled: () => true, session: async () => null, reconcile,
    })(request())).status).toBe(401);
    expect((await createOutboundReconciliationAdminHandler({
      enabled: () => true,
      session: async () => ({ ...ACTOR, impersonatingTenant: "tenant-1" }), reconcile,
    })(request())).status).toBe(403);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("passes accepted provider evidence to the guarded reconciliation RPC", async () => {
    const reconcile = vi.fn(async () => "42");
    const response = await createOutboundReconciliationAdminHandler({
      enabled: () => true, session: async () => ACTOR, reconcile,
    })(request());
    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalledWith({ ...body, actorId: "actor-1" });
    await expect(response.json()).resolves.toEqual({
      resolution: "accepted",
      receipt: { auditId: "42", actionKey: "conversation.outbound_send.reconciled" },
    });
  });

  it("accepts only a provider read-back identifier for verified non-acceptance", async () => {
    const reconcile = vi.fn(async () => "43");
    const notAccepted = {
      ...body,
      resolution: "not_accepted" as const,
      providerMessageId: null,
      acceptedAt: null,
      evidence: {
        ...body.evidence,
        kind: "provider_readback" as const,
        evidenceId: "readback-not-found-1",
        result: "not_found" as const,
        providerMessageId: null,
      },
    };
    const response = await createOutboundReconciliationAdminHandler({
      enabled: () => true, session: async () => ACTOR, reconcile,
    })(request(notAccepted));
    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalledWith({ ...notAccepted, actorId: "actor-1" });
  });

  it("rejects unsupported or contradictory evidence envelopes before mutation", async () => {
    const reconcile = vi.fn(async () => "42");
    const handler = createOutboundReconciliationAdminHandler({
      enabled: () => true, session: async () => ACTOR, reconcile,
    });
    expect((await handler(request({ ...body, evidence: {} }))).status).toBe(400);
    expect((await handler(request({
      ...body, resolution: "not_accepted", providerMessageId: "must-be-null", acceptedAt: null,
    }))).status).toBe(400);
    expect((await handler(request({
      ...body,
      evidence: { ...body.evidence, providerMessageId: "different-provider-message" },
    }))).status).toBe(400);
    expect((await handler(request({
      ...body,
      resolution: "not_accepted",
      providerMessageId: null,
      acceptedAt: null,
      evidence: {
        ...body.evidence,
        kind: "provider_receipt",
        result: "not_found",
        providerMessageId: null,
      },
    }))).status).toBe(400);
    expect(reconcile).not.toHaveBeenCalled();
  });
});
