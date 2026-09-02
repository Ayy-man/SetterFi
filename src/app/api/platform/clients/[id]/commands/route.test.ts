import { describe, expect, it, vi } from "vitest";

import type { SupportSession } from "@/lib/support/service";
import type { ClientCommandReceipt, OperatorCommandUndoReceipt } from "@/lib/platform/operator-commands";

import { createClientCommandHandler, type ClientCommandDependencies } from "./handler";

const admin: SupportSession = {
  userId: "admin-1",
  role: "admin",
  tenantId: null,
  impersonatingTenant: null,
  impersonationSessionId: null,
};
const context = { params: Promise.resolve({ id: "tenant-a" }) };
const request = (body: unknown) => new Request("https://setterfi.test/api/platform/clients/tenant-a/commands", { method: "POST", body: JSON.stringify(body) });
const receipt: Extract<ClientCommandReceipt, { state: "applied" }> = { commandId: "command-1", tenantId: "tenant-a", action: "client_pause", state: "applied", tenantStatus: "paused", auditId: 91, undoAvailable: true };
const rejectedSessions: Array<SupportSession | null> = [
  null,
  { ...admin, role: "coach" },
  { ...admin, impersonatingTenant: "tenant-a" },
];

function dependencies() {
  return {
    enabled: () => true,
    session: vi.fn<ClientCommandDependencies["session"]>(async () => admin),
    command: vi.fn<ClientCommandDependencies["command"]>(async () => receipt),
    undo: vi.fn<ClientCommandDependencies["undo"]>(async (): Promise<OperatorCommandUndoReceipt> => ({ ...receipt, state: "undone", undoAvailable: false, tenantStatus: "active", platformOwnerId: null })),
  } satisfies ClientCommandDependencies;
}

describe("POST /api/platform/clients/[id]/commands", () => {
  it.each(rejectedSessions)("refuses a non-platform or impersonated session before work", async (session) => {
    const deps = dependencies(); deps.session.mockResolvedValue(session);
    const response = await createClientCommandHandler(deps)(request({ action: "pause", reason: "Synthetic pause" }), context);
    expect(response.status).toBe(session ? 403 : 401);
    expect(deps.command).not.toHaveBeenCalled();
  });

  it("requires reasons for consequential lifecycle and intent commands", async () => {
    const deps = dependencies();
    for (const action of ["pause", "resume", "resend_signup", "nudge_onboarding", "archive"]) {
      const response = await createClientCommandHandler(deps)(request({ action, reason: "" }), context);
      expect(response.status).toBe(400);
    }
    expect(deps.command).not.toHaveBeenCalled();
  });

  it.each([
    [{ action: "resume", reason: "Synthetic resume" }, { action: "resume", reason: "Synthetic resume" }],
    [{ action: "nudge_onboarding", reason: "Synthetic nudge" }, { action: "nudge_onboarding", reason: "Synthetic nudge" }],
    [{ action: "archive", reason: "Synthetic archive" }, { action: "archive", reason: "Synthetic archive" }],
    [{ action: "note", note: "Synthetic internal note" }, { action: "note", note: "Synthetic internal note" }],
  ])("forwards the valid %o client command", async (body, expected) => {
    const deps = dependencies();
    const response = await createClientCommandHandler(deps)(request(body), context);
    expect(response.status).toBe(200);
    expect(deps.command).toHaveBeenCalledWith({ expectedTenant: "tenant-a", actorId: "admin-1", ...expected });
  });

  it("reads back a lifecycle effect, audit receipt, and available undo", async () => {
    const deps = dependencies();
    const response = await createClientCommandHandler(deps)(request({ action: "pause", reason: "Synthetic pause" }), context);
    expect(deps.command).toHaveBeenCalledWith({ expectedTenant: "tenant-a", actorId: "admin-1", action: "pause", reason: "Synthetic pause" });
    await expect(response.json()).resolves.toEqual({
      command: { id: "command-1", action: "client_pause", state: "applied" },
      effect: { status: "applied", tenantStatus: "paused" },
      undo: { available: true, commandId: "command-1" },
      audit: { id: 91 },
    });
  });

  it("reports resend and nudge as intent recorded when no provider dispatch is wired", async () => {
    const deps = dependencies();
    deps.command.mockResolvedValue({ ...receipt, action: "client_resend_signup", state: "intent_recorded", undoAvailable: false });
    const response = await createClientCommandHandler(deps)(request({ action: "resend_signup", reason: "Synthetic resend" }), context);
    await expect(response.json()).resolves.toMatchObject({ effect: { status: "intent_recorded", providerDispatch: "not_wired" }, undo: { available: false } });
  });

  it("uses the path tenant for undo and rejects a mismatched read-back", async () => {
    const deps = dependencies();
    const accepted = await createClientCommandHandler(deps)(request({ action: "undo", commandId: "command-1", reason: "Synthetic undo" }), context);
    expect(accepted.status).toBe(200);
    expect(deps.undo).toHaveBeenCalledWith({ expectedTenant: "tenant-a", commandId: "command-1", actorId: "admin-1", reason: "Synthetic undo" });
    deps.undo.mockResolvedValue({ ...receipt, tenantId: "tenant-b", state: "undone", undoAvailable: false, platformOwnerId: null });
    expect((await createClientCommandHandler(deps)(request({ action: "undo", commandId: "command-1", reason: "Synthetic undo" }), context)).status).toBe(409);
  });
});
