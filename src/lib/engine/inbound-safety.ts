/**
 * Maps persisted inbound safety state to pre-generation actions.
 *
 * Detection rules and counters live in the repository. This module accepts only the repository's
 * classified signal and persists it through an injected port, so a caller cannot recreate a
 * lower counter from request history or let output-check retries mutate inbound evidence.
 */

export const TRIPWIRE_SEVERITIES = ["refuse", "escalate"] as const;
export type TripwireSeverity = (typeof TRIPWIRE_SEVERITIES)[number];

export type PersistedInboundSafetyState = {
  tenantId: string;
  conversationId: string;
  status: "agent" | "needs_human" | "human" | "scope_blocked" | "opted_out";
  statusReason?: string | null;
  scopeAttackCount: number;
  tripwireCount: number;
  tripwireClasses: readonly string[];
  lastScopeSignalKey?: string | null;
  lastTripwireSignalKey?: string | null;
};

export type ApprovedInboundSafetyContent = {
  approved: boolean;
  scopeDeflection1: string;
  scopeDeflection2: string;
  scopeClosing: string;
};

export type InboundSafetySignal =
  | { kind: "none" }
  | { kind: "scope"; signalKey: string }
  | {
      kind: "tripwire";
      signalKey: string;
      class: string;
      severity: TripwireSeverity;
      reply: string;
      replyApproved: boolean;
    };

export type InboundSafetyInput = {
  state: PersistedInboundSafetyState;
  content: ApprovedInboundSafetyContent;
  signal: InboundSafetySignal;
};

export type InboundSafetyPersistence = {
  applyScopeSignal(input: {
    expectedTenantId: string;
    conversationId: string;
    signalKey: string;
  }): Promise<{ persistedCount: number; action: "deflect_1" | "deflect_2" | "scope_blocked" }>;
  applyTripwireSignal(input: {
    expectedTenantId: string;
    conversationId: string;
    signalKey: string;
    class: string;
    severity: TripwireSeverity;
  }): Promise<{ persistedCount: number; action: "refused" | "escalated" }>;
};

export type InboundSafetyDecision =
  | { kind: "continue" }
  | {
      kind: "no_outbound";
      state: PersistedInboundSafetyState["status"];
      reason: "safety_state_held";
    }
  | {
      kind: "copy_unapproved";
      state: "agent" | "needs_human" | "scope_blocked";
      reason: "copy_unapproved";
    }
  | {
      kind: "send_approved";
      state: "agent" | "needs_human" | "scope_blocked";
      body: string;
      reason: "scope_deflection_1" | "scope_deflection_2" | "scope_closing" |
        "tripwire_refused" | "tripwire_escalated";
    };

function approvedCopy(
  approved: boolean,
  body: string,
  state: "agent" | "needs_human" | "scope_blocked",
  reason: Extract<InboundSafetyDecision, { kind: "send_approved" }>["reason"],
): InboundSafetyDecision {
  if (!approved || !body.trim()) return { kind: "copy_unapproved", state, reason: "copy_unapproved" };
  return { kind: "send_approved", state, body: body.trim(), reason };
}

export function mapPersistedScopeAction(
  action: "deflect_1" | "deflect_2" | "scope_blocked",
  content: ApprovedInboundSafetyContent,
): InboundSafetyDecision {
  if (action === "deflect_1") {
    return approvedCopy(content.approved, content.scopeDeflection1, "agent", "scope_deflection_1");
  }
  if (action === "deflect_2") {
    return approvedCopy(content.approved, content.scopeDeflection2, "agent", "scope_deflection_2");
  }
  return approvedCopy(content.approved, content.scopeClosing, "scope_blocked", "scope_closing");
}

export function mapPersistedTripwireAction(
  action: "refused" | "escalated",
  signal: Extract<InboundSafetySignal, { kind: "tripwire" }>,
): InboundSafetyDecision {
  return approvedCopy(
    signal.replyApproved,
    signal.reply,
    action === "escalated" ? "needs_human" : "agent",
    action === "escalated" ? "tripwire_escalated" : "tripwire_refused",
  );
}

export async function resolveInboundSafety(
  input: InboundSafetyInput,
  persistence?: InboundSafetyPersistence,
): Promise<InboundSafetyDecision> {
  if (input.state.status !== "agent" && !isPersistedInboundSafetyReplay(input)) {
    return { kind: "no_outbound", state: input.state.status, reason: "safety_state_held" };
  }
  if (input.signal.kind === "none") return { kind: "continue" };
  if (!persistence) throw new Error("INBOUND_SAFETY_PERSISTENCE_REQUIRED");
  if (input.signal.kind === "scope") {
    const result = await persistence.applyScopeSignal({
      expectedTenantId: input.state.tenantId,
      conversationId: input.state.conversationId,
      signalKey: input.signal.signalKey,
    });
    return mapPersistedScopeAction(result.action, input.content);
  }
  const result = await persistence.applyTripwireSignal({
    expectedTenantId: input.state.tenantId,
    conversationId: input.state.conversationId,
    signalKey: input.signal.signalKey,
    class: input.signal.class,
    severity: input.signal.severity,
  });
  return mapPersistedTripwireAction(result.action, input.signal);
}

export function isPersistedInboundSafetyReplay(input: InboundSafetyInput) {
  if (input.signal.kind === "scope") {
    return input.state.status === "scope_blocked" && input.state.statusReason === "scope_exit_cap" &&
      input.state.lastScopeSignalKey === input.signal.signalKey;
  }
  if (input.signal.kind === "tripwire") {
    return input.state.status === "needs_human" &&
      (input.state.statusReason === "tripwire_escalate" ||
        input.state.statusReason === "tripwire_repeated") &&
      input.state.lastTripwireSignalKey === input.signal.signalKey;
  }
  return false;
}

export function decideHumanSafetyRevival(input: {
  state: PersistedInboundSafetyState["status"];
  actor: "human" | "system";
  reason: string;
}) {
  if (input.state !== "scope_blocked" && input.state !== "needs_human") {
    return { kind: "not_held" as const };
  }
  if (input.actor !== "human" || !input.reason.trim()) {
    return { kind: "refused" as const, reason: "HUMAN_REASON_REQUIRED" as const };
  }
  return { kind: "revive" as const, state: "agent" as const, reason: input.reason.trim() };
}
