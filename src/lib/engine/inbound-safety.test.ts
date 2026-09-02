import { describe, expect, it, vi } from "vitest";

import {
  decideHumanSafetyRevival,
  mapPersistedScopeAction,
  mapPersistedTripwireAction,
  resolveInboundSafety,
  TRIPWIRE_SEVERITIES,
  type InboundSafetyInput,
  type InboundSafetyPersistence,
} from "@/lib/engine/inbound-safety";

const CONTENT = {
  approved: true,
  scopeDeflection1: "Approved first deflection.",
  scopeDeflection2: "Approved second deflection.",
  scopeClosing: "Approved closing response.",
};

const BASE: InboundSafetyInput = {
  state: {
    tenantId: "tenant-1",
    conversationId: "conversation-1",
    status: "agent",
    scopeAttackCount: 0,
    tripwireCount: 0,
    tripwireClasses: [],
  },
  content: CONTENT,
  signal: { kind: "none" },
};

function persistence(): InboundSafetyPersistence & {
  applyScopeSignal: ReturnType<typeof vi.fn<InboundSafetyPersistence["applyScopeSignal"]>>;
  applyTripwireSignal: ReturnType<typeof vi.fn<InboundSafetyPersistence["applyTripwireSignal"]>>;
} {
  return {
    applyScopeSignal: vi.fn(async () => ({ persistedCount: 1, action: "deflect_1" as const })),
    applyTripwireSignal: vi.fn(async () => ({ persistedCount: 1, action: "refused" as const })),
  };
}

describe("inbound safety mapping", () => {
  it("keeps exactly two tripwire severities so a caller cannot invent a third behavior", () => {
    expect(TRIPWIRE_SEVERITIES).toEqual(["refuse", "escalate"]);
  });

  it("maps the persisted three-hit scope ladder to approved repository content", () => {
    expect(mapPersistedScopeAction("deflect_1", CONTENT)).toEqual({
      kind: "send_approved", state: "agent", body: CONTENT.scopeDeflection1,
      reason: "scope_deflection_1",
    });
    expect(mapPersistedScopeAction("deflect_2", CONTENT)).toEqual({
      kind: "send_approved", state: "agent", body: CONTENT.scopeDeflection2,
      reason: "scope_deflection_2",
    });
    expect(mapPersistedScopeAction("scope_blocked", CONTENT)).toEqual({
      kind: "send_approved", state: "scope_blocked", body: CONTENT.scopeClosing,
      reason: "scope_closing",
    });
  });

  it("refuses unapproved scope content instead of borrowing simulator wording", () => {
    expect(mapPersistedScopeAction("deflect_1", { ...CONTENT, approved: false })).toEqual({
      kind: "copy_unapproved", state: "agent", reason: "copy_unapproved",
    });
    expect(mapPersistedScopeAction("scope_blocked", { ...CONTENT, approved: false })).toEqual({
      kind: "copy_unapproved", state: "scope_blocked", reason: "copy_unapproved",
    });
  });

  it("escalates the first severe tripwire and the persisted second refuse hit across classes", () => {
    const severe = {
      kind: "tripwire" as const,
      signalKey: "message-1:LEGAL",
      class: "LEGAL",
      severity: "escalate" as const,
      reply: "Approved legal holding response.",
      replyApproved: true,
    };
    expect(mapPersistedTripwireAction("escalated", severe)).toEqual({
      kind: "send_approved", state: "needs_human", body: severe.reply,
      reason: "tripwire_escalated",
    });
    const secondAcrossClasses = { ...severe, class: "CPN", severity: "refuse" as const };
    expect(mapPersistedTripwireAction("escalated", secondAcrossClasses)).toMatchObject({
      kind: "send_approved", state: "needs_human", reason: "tripwire_escalated",
    });
  });

  it("never persists or sends again from a server-held safety state", async () => {
    const repository = persistence();
    const decision = await resolveInboundSafety({
      ...BASE,
      state: { ...BASE.state, status: "scope_blocked", scopeAttackCount: 3 },
      signal: { kind: "scope", signalKey: "message-4:SCOPE" },
    }, repository);
    expect(decision).toEqual({
      kind: "no_outbound", state: "scope_blocked", reason: "safety_state_held",
    });
    expect(repository.applyScopeSignal).not.toHaveBeenCalled();
    expect(repository.applyTripwireSignal).not.toHaveBeenCalled();
  });

  it("replays the exact scope signal that caused the held state after a crash", async () => {
    const repository = persistence();
    repository.applyScopeSignal.mockResolvedValue({ persistedCount: 3, action: "scope_blocked" });
    const decision = await resolveInboundSafety({
      ...BASE,
      state: {
        ...BASE.state,
        status: "scope_blocked",
        statusReason: "scope_exit_cap",
        scopeAttackCount: 3,
        lastScopeSignalKey: "message-4:SCOPE",
      },
      signal: { kind: "scope", signalKey: "message-4:SCOPE" },
    }, repository);
    expect(repository.applyScopeSignal).toHaveBeenCalledOnce();
    expect(decision).toMatchObject({ kind: "send_approved", state: "scope_blocked" });
  });

  it("replays the exact tripwire signal that caused escalation after a crash", async () => {
    const repository = persistence();
    repository.applyTripwireSignal.mockResolvedValue({ persistedCount: 1, action: "escalated" });
    const signal = {
      kind: "tripwire" as const,
      signalKey: "message-5:PII",
      class: "PII",
      severity: "escalate" as const,
      reply: "Approved refusal.",
      replyApproved: true,
    };
    const decision = await resolveInboundSafety({
      ...BASE,
      state: {
        ...BASE.state,
        status: "needs_human",
        statusReason: "tripwire_escalate",
        lastTripwireSignalKey: signal.signalKey,
      },
      signal,
    }, repository);
    expect(repository.applyTripwireSignal).toHaveBeenCalledOnce();
    expect(decision).toMatchObject({ kind: "send_approved", state: "needs_human" });
  });

  it.each([
    ["human", "lead_requested_human"],
    ["opted_out", "stop_keyword"],
    ["needs_human", "output_check_failed"],
  ] as const)("lets a later %s/%s hold override an old matching tripwire key", async (
    status,
    statusReason,
  ) => {
    const repository = persistence();
    const decision = await resolveInboundSafety({
      ...BASE,
      state: {
        ...BASE.state,
        status,
        statusReason,
        lastTripwireSignalKey: "message-5:PII",
      },
      signal: {
        kind: "tripwire",
        signalKey: "message-5:PII",
        class: "PII",
        severity: "escalate",
        reply: "Approved refusal.",
        replyApproved: true,
      },
    }, repository);
    expect(decision).toEqual({ kind: "no_outbound", state: status, reason: "safety_state_held" });
    expect(repository.applyTripwireSignal).not.toHaveBeenCalled();
  });

  it("passes the server-held tenant, conversation, class, and severity to persistence", async () => {
    const repository = persistence();
    await resolveInboundSafety({
      ...BASE,
      signal: {
        kind: "tripwire",
        signalKey: "message-2:CPN",
        class: "CPN",
        severity: "refuse",
        reply: "Approved refusal.",
        replyApproved: true,
      },
    }, repository);
    expect(repository.applyTripwireSignal).toHaveBeenCalledWith({
      expectedTenantId: "tenant-1",
      conversationId: "conversation-1",
      signalKey: "message-2:CPN",
      class: "CPN",
      severity: "refuse",
    });
  });

  it("allows a held state to revive only through a human action with a reason", () => {
    expect(decideHumanSafetyRevival({ state: "scope_blocked", actor: "system", reason: "timer" }))
      .toEqual({ kind: "refused", reason: "HUMAN_REASON_REQUIRED" });
    expect(decideHumanSafetyRevival({ state: "scope_blocked", actor: "human", reason: " " }))
      .toEqual({ kind: "refused", reason: "HUMAN_REASON_REQUIRED" });
    expect(decideHumanSafetyRevival({
      state: "scope_blocked", actor: "human", reason: "Reviewed the conversation",
    })).toEqual({ kind: "revive", state: "agent", reason: "Reviewed the conversation" });
  });
});
