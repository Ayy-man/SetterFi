import { describe, expect, it, vi } from "vitest";

import { createAdminProvisioningHandlers } from "./handler";

const actor = { userId: "admin-1", role: "admin" as const, impersonatingTenant: null };
function dependencies() {
  return {
    enabled: () => true,
    session: vi.fn().mockResolvedValue(actor),
    list: vi.fn().mockResolvedValue([]),
    retry: vi.fn().mockResolvedValue("71"),
    unblock: vi.fn().mockResolvedValue("72"),
    confirm: vi.fn().mockResolvedValue({ auditId: "73", actionKey: "onboarding.a2p_filing_confirmed" as const }),
    command: vi.fn().mockResolvedValue({
      commandId: "command-1", tenantId: "tenant-1", step: "a2p_brand", action: "provisioning_reassign",
      state: "applied", platformOwnerId: "success-1", auditId: 74, undoAvailable: true,
    }),
    undo: vi.fn().mockResolvedValue({
      tenantId: "tenant-1", action: "provisioning_reassign", state: "undone", platformOwnerId: null, auditId: 75,
    }),
  };
}
function request(body: unknown) { return new Request("https://setterfi.test/api/admin/provisioning", { method: "POST", body: JSON.stringify(body) }); }

describe("admin provisioning routes", () => {
  it("refuses non-platform roles before the tracker query", async () => {
    const deps = dependencies();
    deps.session.mockResolvedValue({ userId: "coach-1", role: "coach" });
    const response = await createAdminProvisioningHandlers(deps).GET();
    expect(response.status).toBe(403);
    expect(deps.list).not.toHaveBeenCalled();
  });

  it("calls exactly the tracker role-boundary seam", async () => {
    const deps = dependencies();
    const response = await createAdminProvisioningHandlers(deps).GET();
    expect(response.status).toBe(200);
    expect(deps.list).toHaveBeenCalledWith("admin");
  });

  it("rejects blocked retry without calling the RPC", async () => {
    const deps = dependencies();
    const response = await createAdminProvisioningHandlers(deps).POST(request({ action: "retry", tenantId: "tenant-1", step: "a2p_brand", expectedState: "blocked" }));
    expect(response.status).toBe(409);
    expect(deps.retry).not.toHaveBeenCalled();
  });

  it("passes expected tenant and failed state to retry", async () => {
    const deps = dependencies();
    const response = await createAdminProvisioningHandlers(deps).POST(request({ action: "retry", tenantId: "tenant-1", step: "a2p_brand", expectedState: "failed" }));
    expect(response.status).toBe(200);
    expect(deps.retry).toHaveBeenCalledWith({ tenantId: "tenant-1", step: "a2p_brand", expectedState: "failed", actorId: "admin-1" });
    await expect(response.json()).resolves.toMatchObject({ receipt: { auditId: "71" } });
  });

  it("requires a typed reason to unblock and a receipt to label success", async () => {
    const deps = dependencies();
    expect((await createAdminProvisioningHandlers(deps).POST(request({ action: "unblock", tenantId: "tenant-1", step: "a2p_brand", reason: "" }))).status).toBe(400);
    deps.unblock.mockResolvedValue("");
    const response = await createAdminProvisioningHandlers(deps).POST(request({ action: "unblock", tenantId: "tenant-1", step: "a2p_brand", reason: "Synthetic correction evidence" }));
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toMatch(/sql|audit_required/i);
  });

  it("confirms flagged content through the evidence repository", async () => {
    const deps = dependencies();
    const response = await createAdminProvisioningHandlers(deps).POST(request({ action: "confirm_content", tenantId: "tenant-1", screenId: "screen-1" }));
    expect(response.status).toBe(200);
    expect(deps.confirm).toHaveBeenCalledWith({ tenantId: "tenant-1", screenId: "screen-1", actorId: "admin-1" });
  });

  it("returns the A2P filing receipt that stamps the registration start date", async () => {
    const deps = dependencies();
    const response = await createAdminProvisioningHandlers(deps).POST(request({ action: "confirm_content", tenantId: "tenant-1", screenId: "screen-1" }));
    // confirm_content is the one admin action wired to confirm_onboarding_content_screen, which
    // is where external_ref.submittedAt gets written; the receipt has to name that filing action.
    await expect(response.json()).resolves.toEqual({
      screenId: "screen-1",
      receipt: { auditId: "73", actionKey: "onboarding.a2p_filing_confirmed" },
    });
    deps.confirm.mockResolvedValue({ auditId: " ", actionKey: "onboarding.a2p_filing_confirmed" as const });
    expect((await createAdminProvisioningHandlers(deps).POST(request({ action: "confirm_content", tenantId: "tenant-1", screenId: "screen-1" }))).status).toBe(409);
  });

  it("requires reasons for provisioning command intents and reassignments", async () => {
    const deps = dependencies();
    for (const action of [
      { action: "nudge", tenantId: "tenant-1", step: "a2p_brand", reason: "" },
      { action: "resend", tenantId: "tenant-1", step: "a2p_brand", reason: "" },
      { action: "reassign", tenantId: "tenant-1", step: "a2p_brand", assigneeId: "success-1", reason: "" },
    ]) {
      expect((await createAdminProvisioningHandlers(deps).POST(request(action))).status).toBe(400);
    }
    expect(deps.command).not.toHaveBeenCalled();
  });

  it("returns an honest intent state for nudge and resend because delivery is not wired", async () => {
    const deps = dependencies();
    deps.command.mockResolvedValue({
      commandId: "command-2", tenantId: "tenant-1", step: "a2p_brand", action: "provisioning_nudge",
      state: "intent_recorded", platformOwnerId: null, auditId: 76, undoAvailable: false,
    });
    const response = await createAdminProvisioningHandlers(deps).POST(request({ action: "nudge", tenantId: "tenant-1", step: "a2p_brand", reason: "Synthetic nudge" }));
    await expect(response.json()).resolves.toMatchObject({
      effect: { status: "intent_recorded", providerDispatch: "not_wired" },
      undo: { available: false }, audit: { id: 76 },
    });
    await createAdminProvisioningHandlers(deps).POST(request({ action: "resend", tenantId: "tenant-1", step: "a2p_brand", reason: "Synthetic resend" }));
    expect(deps.command).toHaveBeenLastCalledWith({
      expectedTenant: "tenant-1", step: "a2p_brand", actorId: "admin-1", action: "resend", reason: "Synthetic resend",
    });
  });

  it("reassigns the distinct provisioning owner with read-back and exposes undo", async () => {
    const deps = dependencies();
    const response = await createAdminProvisioningHandlers(deps).POST(request({
      action: "reassign", tenantId: "tenant-1", step: "a2p_brand", assigneeId: "success-1", reason: "Synthetic routing",
    }));
    expect(deps.command).toHaveBeenCalledWith({
      expectedTenant: "tenant-1", step: "a2p_brand", actorId: "admin-1", action: "reassign",
      assigneeId: "success-1", reason: "Synthetic routing",
    });
    await expect(response.json()).resolves.toMatchObject({ platformOwnerId: "success-1", undo: { available: true, commandId: "command-1" }, audit: { id: 74 } });
  });

  it("uses the supplied tenant as the undo boundary and rejects a mismatched read-back", async () => {
    const deps = dependencies();
    const accepted = await createAdminProvisioningHandlers(deps).POST(request({ action: "undo", tenantId: "tenant-1", commandId: "command-1", reason: "Synthetic undo" }));
    expect(accepted.status).toBe(200);
    expect(deps.undo).toHaveBeenCalledWith({ expectedTenant: "tenant-1", commandId: "command-1", actorId: "admin-1", reason: "Synthetic undo" });
    deps.undo.mockResolvedValue({ tenantId: "tenant-2", action: "provisioning_reassign", state: "undone", platformOwnerId: null, auditId: 75 });
    expect((await createAdminProvisioningHandlers(deps).POST(request({ action: "undo", tenantId: "tenant-1", commandId: "command-1", reason: "Synthetic undo" }))).status).toBe(409);
  });

  it.each([[null, 401], [{ ...actor, impersonatingTenant: "tenant-1" }, 403], [{ userId: "build-1", role: "build" as const }, 403]])("refuses unauthorized mutation before work", async (candidate, status) => {
    const deps = dependencies();
    deps.session.mockResolvedValue(candidate);
    const response = await createAdminProvisioningHandlers(deps).POST(request({ action: "retry", tenantId: "tenant-1", step: "a2p_brand", expectedState: "failed" }));
    expect(response.status).toBe(status);
    expect(deps.retry).not.toHaveBeenCalled();
  });
});
