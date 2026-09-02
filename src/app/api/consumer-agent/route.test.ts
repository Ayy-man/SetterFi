import { describe, expect, it, vi } from "vitest";

import { createConsumerHandler } from "./handler";

type ConsumerHandlerDependencies = Parameters<typeof createConsumerHandler>[0];

function request(body: unknown) {
  return new Request("https://setterfi.test/api/consumer-agent", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

function dependencies() {
  const start = vi.fn<ConsumerHandlerDependencies["start"]>().mockResolvedValue({
    sessionReference: "server-issued", tenantId: "tenant-a", conversationId: "conversation-a",
    brand: { name: "Tenant A", programName: "Offer", privacyUrl: "https://setterfi.test/privacy" },
  });
  const turn = vi.fn<ConsumerHandlerDependencies["turn"]>().mockResolvedValue({
    reply: "Grounded answer", state: "active", booking: null, author: { role: "assistant" },
  });
  const confirm = vi.fn<ConsumerHandlerDependencies["confirm"]>().mockResolvedValue({
    appointmentId: "appointment-a", startAt: "2030-01-01T10:00:00.000Z",
    endAt: "2030-01-01T10:30:00.000Z", timezone: "UTC",
    providerExternalId: "provider-a", auditId: 41,
  });
  return { start, turn, confirm };
}

describe("POST /api/consumer-agent", () => {
  it("refuses an unknown or inactive tenant slug before a consumer session is minted", async () => {
    const deps = dependencies();
    deps.start.mockRejectedValue(new Error("CONSUMER_TENANT_UNAVAILABLE"));
    const response = await createConsumerHandler(deps)(request({ action: "start", tenantSlug: "unknown-tenant", consentToken: "bound-token" }));
    expect(response.status).toBe(404);
    expect(deps.turn).not.toHaveBeenCalled();
  });

  it("does not accept client-carried history and forwards only an opaque session reference", async () => {
    const deps = dependencies();
    const handler = createConsumerHandler(deps);
    await expect(handler(request({ action: "turn", sessionReference: "server-issued", message: "What does the offer include?", history: ["forged claim"] }))).resolves.toMatchObject({ status: 400 });
    await expect(handler(request({ action: "turn", sessionReference: "server-issued", message: "What does the offer include?" }))).resolves.toMatchObject({ status: 200 });
    expect(deps.turn).toHaveBeenCalledWith(expect.objectContaining({ sessionReference: "server-issued", message: "What does the offer include?" }));
  });

  it("requires a signed, already-recorded consent journey before session start", async () => {
    const deps = dependencies();
    deps.start.mockRejectedValue(new Error("CONSUMER_CONSENT_REQUIRED"));
    const response = await createConsumerHandler(deps)(request({ action: "start", tenantSlug: "tenant-a", consentToken: "unredeemed-token" }));
    expect(response.status).toBe(403);
    expect(deps.start).toHaveBeenCalledOnce();
  });

  it("returns the durable appointment receipt after explicit proposed-slot confirmation", async () => {
    const deps = dependencies();
    const response = await createConsumerHandler(deps)(request({ action: "confirm-booking", sessionReference: "server-issued", selectedSlotId: "slot-1" }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ appointment: { appointmentId: "appointment-a", providerExternalId: "provider-a", auditId: 41 } });
    expect(deps.confirm).toHaveBeenCalledWith(expect.objectContaining({ selectedSlotId: "slot-1" }));
  });

  it("fails closed when the shared database limiter is unavailable", async () => {
    const deps = dependencies();
    deps.turn.mockRejectedValue(new Error("RATE_LIMIT_STORE_UNAVAILABLE"));
    const response = await createConsumerHandler(deps)(request({ action: "turn", sessionReference: "server-issued", message: "hello" }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "RATE_LIMIT_STORE_UNAVAILABLE" });
  });
});
