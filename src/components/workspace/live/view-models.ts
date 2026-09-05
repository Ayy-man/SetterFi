import type {
  ConversationMessageRead,
  ConversationRead,
} from "@/lib/repositories/conversations";
import { a2pRegistrationDay, a2pRegistrationLabel } from "@/lib/onboarding/a2p-clock";
import type { ChannelConnectionView } from "@/lib/repositories/channel-connections";
import type {
  ContactIdentityDetail,
  ContactRead,
  DuplicateCandidateView,
} from "@/lib/repositories/contacts";
import type { MessageTemplateView } from "@/lib/repositories/message-templates";

export type PersistedReadBack =
  | { ok: true; conversation: ConversationRead }
  | { ok: false; error: string };

export type ConversationView = {
  id: string;
  contactId: string;
  contactName: string;
  channel: ConversationRead["channel"];
  status: ConversationRead["status"];
  statusLabel: string;
  statusReason: string | null;
  takenOverBy: string | null;
  isHuman: boolean;
  unread: boolean;
  disclosurePending: boolean;
  currentStepAsks: number;
  isDemo: boolean;
  isTest: boolean;
  lastActivityAt: string;
  qualification: ConversationRead["qualification"];
  appointment: ConversationRead["appointment"];
  messages: ConversationMessageRead[];
  readBackError: string | null;
};

const STATUS_LABELS: Record<ConversationRead["status"], string> = {
  agent: "Agent active",
  needs_human: "Handoff requested",
  human: "Human handling",
  nurture: "Nurture",
  closed: "Closed",
  scope_blocked: "Scope blocked",
  opted_out: "Opted out",
};

function persistedConversation(
  original: ConversationRead,
  readBack?: PersistedReadBack,
): { row: ConversationRead; error: string | null } {
  if (!readBack) return { row: original, error: null };
  if (!readBack.ok) return { row: original, error: readBack.error };
  if (readBack.conversation.id !== original.id) {
    return { row: original, error: "The saved conversation did not match this thread. Nothing changed here." };
  }
  return { row: readBack.conversation, error: null };
}

/** Derives the screen only from a repository row or a route's persisted read-back. */
export function deriveConversationView(
  original: ConversationRead,
  readBack?: PersistedReadBack,
): ConversationView {
  const { row, error } = persistedConversation(original, readBack);
  return {
    id: row.id,
    contactId: row.contactId,
    contactName: row.contactName,
    channel: row.channel,
    status: row.status,
    statusLabel: STATUS_LABELS[row.status],
    statusReason: row.statusReason,
    takenOverBy: row.takenOverBy,
    isHuman: row.status === "human" && row.takenOverBy !== null,
    unread: row.unreadByCoach,
    disclosurePending: row.disclosurePending,
    currentStepAsks: row.currentStepAsks,
    isDemo: row.isDemo,
    isTest: row.isTest,
    lastActivityAt: row.lastActivityAt,
    qualification: row.qualification,
    appointment: row.appointment,
    messages: row.messages.map((message) => ({
      ...message,
      delivered: message.direction === "system" ? false : message.delivered,
    })),
    readBackError: error,
  };
}

export type ContactView = ContactRead & {
  primaryChannel: ContactRead["channels"][number] | null;
};

export function deriveContactView(contact: ContactRead): ContactView {
  return { ...contact, primaryChannel: contact.channels[0] ?? null };
}

export type TestingArmInput = {
  id: string;
  /** The configuration's own name. Never joined with the role -- that produced "Generator, Generator". */
  label: string;
  /** What the arm does in the comparison. Rendered as a tag beside the name, not appended to it. */
  role: string | null;
  selector: "mock" | "real";
  hasUsableKey: boolean;
  persistedTrace: MessageTraceRead | null;
};

export type MessageTraceRead = {
  id: string;
  tenantId: string;
  model: string;
  ruleFired: string | null;
  retrievedEntryIds: string[];
  checks: Record<string, boolean>;
  violations: string[];
  moderatorState: "allowed" | "blocked" | "unavailable" | "not_recorded";
  moderatorClass: string | null;
  moderatorRuleId: string | null;
  moderatorModelConfigId: string | null;
  createdAt: string;
};

export type TestingView = {
  moderatorUnavailableCount: number;
  arms: Array<{
    id: string;
    label: string;
    role: string | null;
    state: "Mock" | "Real" | "Skipped";
    reason: string | null;
    trace: MessageTraceRead | null;
    grounded: boolean;
  }>;
};

export function deriveTestingView(input: {
  arms: TestingArmInput[];
  moderatorUnavailableCount: number;
}): TestingView {
  return {
    moderatorUnavailableCount: input.moderatorUnavailableCount,
    arms: input.arms.map((arm) => {
      const state = arm.selector === "mock"
        ? "Mock" as const
        : arm.hasUsableKey
          ? "Real" as const
          : "Skipped" as const;
      const reason = state === "Skipped"
        ? "Real driver selected without a usable key"
        : null;
      const grounded = Boolean(
        arm.persistedTrace
        && arm.persistedTrace.retrievedEntryIds.length > 0
        && Object.keys(arm.persistedTrace.checks).length > 0
        && Object.values(arm.persistedTrace.checks).every(Boolean)
        && arm.persistedTrace.violations.length === 0,
      );
      return {
        id: arm.id,
        label: arm.label,
        role: arm.role,
        state,
        reason,
        trace: arm.persistedTrace,
        grounded,
      };
    }),
  };
}

// Phase 4
export const PHASE4_CHANNELS = ["instagram", "messenger", "whatsapp", "sms"] as const;
export type Phase4Channel = (typeof PHASE4_CHANNELS)[number];

const PHASE4_CHANNEL_LABELS: Record<Phase4Channel, string> = {
  instagram: "Instagram",
  messenger: "Facebook Messenger",
  whatsapp: "WhatsApp",
  sms: "Text messages (SMS)",
};

export type ChannelTruth = {
  channel: Phase4Channel;
  label: string;
  stateLabel: string;
  tone: "neutral" | "good" | "pending" | "bad";
  accountLabel: string | null;
  windowLabel: string;
  templateLabel: string;
  templateTone: "neutral" | "good" | "pending" | "bad";
  templateIsDemo: boolean;
  /**
   * Why the provider put the connection where it is, and when its credential stops working.
   *
   * Screen 1f opens a broken channel on a cause -- "Instagram revoked the token when the account
   * password changed" -- and the row has carried both facts since the first migration
   * (`channel_connections.error`, `.token_expires_at`); the read simply dropped them. They are
   * passed through verbatim, never rewritten into a friendlier sentence, because the provider's
   * own words are the thing an operator searches for. A row with no recorded reason yields null
   * and the surface says the reason was not recorded, which is a different claim from "no reason".
   */
  errorText: string | null;
  tokenExpiresAt: string | null;
  prerequisites: Array<{ label: string; complete: boolean }>;
};

function connectionState(
  connection: ChannelConnectionView | null,
  channel: Phase4Channel,
  now: Date,
  a2pSubmittedAt: string | null,
): Pick<ChannelTruth, "stateLabel" | "tone"> {
  if (!connection) return { stateLabel: "Not connected", tone: "neutral" };
  if (connection.state === "blocked_permanent") {
    return { stateLabel: "Permanently blocked", tone: "bad" };
  }
  if (channel === "sms" && ["connecting", "pending_review", "ready", "flagged"].includes(connection.state)) {
    // Counted from the A2P submission receipt, the same row the go-live
    // checklist reads. The connection row's own createdAt predates the filing,
    // so counting from it put a different day number on each screen.
    return {
      stateLabel: a2pRegistrationLabel(a2pRegistrationDay(a2pSubmittedAt, now)),
      tone: "pending",
    };
  }
  if (connection.state === "live" && connection.receipts.signedRoundTripAt) {
    return { stateLabel: "Live", tone: "good" };
  }
  if (connection.state === "pending_review") {
    return { stateLabel: "Pending review", tone: "pending" };
  }
  const connected = connection.state === "ready"
    && Boolean(connection.externalAccountLabel)
    && Boolean(connection.receipts.oauthCompletedAt)
    && Boolean(connection.receipts.assetVerifiedAt)
    && Boolean(connection.receipts.webhookSubscribedAt);
  if (connected || (connection.state === "live" && !connection.receipts.signedRoundTripAt)) {
    return { stateLabel: "Connected", tone: connected ? "good" : "pending" };
  }
  if (connection.state === "connecting") return { stateLabel: "Connecting", tone: "pending" };
  if (["error", "expired", "restricted", "flagged"].includes(connection.state)) {
    return { stateLabel: "Needs attention", tone: "bad" };
  }
  if (connection.state === "disconnected") return { stateLabel: "Not connected", tone: "neutral" };
  return { stateLabel: "Setup incomplete", tone: "pending" };
}

export type TemplateTruth = {
  label: string;
  tone: "neutral" | "good" | "pending" | "bad";
  isDemo: boolean;
};

/** Provider lifecycle and its persisted timestamp must agree before approval is rendered. */
export function deriveTemplateTruth(template: MessageTemplateView): TemplateTruth {
  if (template.status === "approved" && template.approvedAt) {
    return { label: "Approved", tone: "good", isDemo: template.dataLabel === "Demo" };
  }
  if (template.status === "submitted") {
    return { label: "Pending review", tone: "pending", isDemo: template.dataLabel === "Demo" };
  }
  if (template.status === "rejected") {
    return { label: "Rejected", tone: "bad", isDemo: template.dataLabel === "Demo" };
  }
  if (template.status === "paused") {
    return { label: "Paused", tone: "pending", isDemo: template.dataLabel === "Demo" };
  }
  if (template.status === "disabled") {
    return { label: "Disabled", tone: "bad", isDemo: template.dataLabel === "Demo" };
  }
  if (template.status === "approved") {
    return { label: "Status unavailable", tone: "pending", isDemo: template.dataLabel === "Demo" };
  }
  return { label: "Draft", tone: "neutral", isDemo: template.dataLabel === "Demo" };
}

function templatePriority(template: MessageTemplateView) {
  return ["approved", "submitted", "rejected", "paused", "draft", "disabled"].indexOf(template.status);
}

export function deriveChannelTruths(
  connections: readonly ChannelConnectionView[],
  templates: readonly MessageTemplateView[],
  now = new Date(),
  /** The persisted A2P `submitted_at`; null when nothing has been filed yet. */
  a2pSubmittedAt: string | null = null,
): ChannelTruth[] {
  return PHASE4_CHANNELS.map((channel) => {
    const connection = connections.find((candidate) => candidate.channel === channel) ?? null;
    const channelTemplates = templates
      .filter((template) => template.channel === channel)
      .sort((left, right) => templatePriority(left) - templatePriority(right));
    const template = channelTemplates[0] ?? null;
    const templateTruth = template
      ? deriveTemplateTruth(template)
      : connection?.capabilities.templates
        ? { label: "No approved templates", tone: "pending" as const, isDemo: false }
        : { label: "Not required", tone: "neutral" as const, isDemo: false };

    return {
      channel,
      label: PHASE4_CHANNEL_LABELS[channel],
      ...connectionState(connection, channel, now, a2pSubmittedAt),
      accountLabel: connection?.externalAccountLabel ?? null,
      windowLabel: connection?.capabilities.windowed
        ? "Provider window enforced"
        : "No provider window required",
      templateLabel: templateTruth.label,
      templateTone: templateTruth.tone,
      templateIsDemo: templateTruth.isDemo,
      errorText: connection?.error?.trim() ? connection.error.trim() : null,
      tokenExpiresAt: connection?.tokenExpiresAt ?? null,
      prerequisites: [
        { label: "OAuth completed", complete: Boolean(connection?.receipts.oauthCompletedAt) },
        { label: "Asset verified", complete: Boolean(connection?.receipts.assetVerifiedAt) },
        { label: "Webhook subscribed", complete: Boolean(connection?.receipts.webhookSubscribedAt) },
        { label: "Signed round trip", complete: Boolean(connection?.receipts.signedRoundTripAt) },
      ],
    };
  });
}

export type MetaReviewReceipt = {
  state: "filed" | "under_review" | "approved" | "rejected";
  reference: string | null;
};

/** A provider review state needs a human-entered reference; missing evidence remains not filed. */
export function deriveMetaReviewTruth(receipt: MetaReviewReceipt | null) {
  if (!receipt?.reference?.trim()) return { label: "Not filed", tone: "neutral" as const };
  if (receipt.state === "under_review") return { label: "Under review", tone: "pending" as const };
  if (receipt.state === "approved") return { label: "Approved", tone: "good" as const };
  if (receipt.state === "rejected") return { label: "Rejected", tone: "bad" as const };
  return { label: "Filed", tone: "pending" as const };
}

export function deriveCandidateMergeTruth(
  candidate: DuplicateCandidateView,
  impersonating: boolean,
) {
  if (impersonating) return { canMerge: false, reason: "Merge is unavailable in a read-only impersonated view." };
  if (candidate.testBoundary === "mixed") return { canMerge: false, reason: "Test and real contact histories cannot be merged." };
  if (candidate.state !== "open") return { canMerge: false, reason: "This possible duplicate is no longer open." };
  return { canMerge: true, reason: null };
}

export function deriveContactUndoTruth(
  detail: ContactIdentityDetail,
  impersonating: boolean,
) {
  if (impersonating || detail.mergeState.status !== "merged" || !detail.undo?.auditRowId) {
    return null;
  }
  return {
    contactId: detail.contactId,
    winnerId: detail.mergeState.mergedIntoContactId,
    auditRowId: detail.undo.auditRowId,
  };
}

// Phase 3
export type DeleteFlowPreview = import("@/lib/deletion/contracts").DeletionPreview;
export type DeleteFlowResult = import("@/lib/deletion/contracts").DeleteLeadResult;
export type DeleteFlowRetry = import("@/lib/deletion/contracts").DeletionRetryReceipt;

export type DeleteFlowState = {
  kind: "idle" | "previewing" | "confirming" | "deleting" | "failed" | "deleted";
  preview: DeleteFlowPreview | null;
  reason: string;
  retry: DeleteFlowRetry | null;
  error: string | null;
  reasonError: string | null;
  auditId: number | null;
  tombstoneCount: number | null;
};

export type DeleteFlowEvent =
  | { type: "open" }
  | { type: "preview_loaded"; preview: DeleteFlowPreview }
  | { type: "preview_failed"; error: string }
  | { type: "reason_changed"; reason: string }
  | { type: "submit" }
  | { type: "result"; result: DeleteFlowResult }
  | { type: "retry" }
  | { type: "cancel" };

export const INITIAL_DELETE_FLOW_STATE: DeleteFlowState = {
  kind: "idle",
  preview: null,
  reason: "",
  retry: null,
  error: null,
  reasonError: null,
  auditId: null,
  tombstoneCount: null,
};

function deletionFailure(result: Extract<DeleteFlowResult, { kind: "incomplete" }>): string {
  if (result.stage === "provider_delete") return "The connected contact could not be deleted. Retry uses the saved provider receipt.";
  if (result.stage === "provider_readback") return "The connected contact deletion could not be confirmed. No local deletion was claimed.";
  if (result.stage === "local_delete") return "The provider step finished, but SetterFi did not complete the local deletion.";
  return "SetterFi could not confirm contact absence, tombstones, and the surviving audit receipt.";
}

/** Closed reducer: only the deletion service's receipt union can enter the terminal Deleted state. */
export function deleteFlowState(
  state: DeleteFlowState,
  event: DeleteFlowEvent,
): DeleteFlowState {
  if (event.type === "cancel") return INITIAL_DELETE_FLOW_STATE;
  if (event.type === "open") {
    return { ...INITIAL_DELETE_FLOW_STATE, kind: "previewing" };
  }
  if (event.type === "preview_loaded") {
    return {
      ...INITIAL_DELETE_FLOW_STATE,
      kind: "confirming",
      preview: event.preview,
    };
  }
  if (event.type === "preview_failed") {
    return { ...state, kind: "failed", error: event.error };
  }
  if (event.type === "reason_changed") {
    return { ...state, reason: event.reason, reasonError: null };
  }
  if (event.type === "submit") {
    if (state.kind !== "confirming" || !state.preview) return state;
    if (!state.reason.trim()) {
      return { ...state, reasonError: "Enter the privacy-request reason before deleting this contact." };
    }
    return { ...state, kind: "deleting", error: null, reasonError: null };
  }
  if (event.type === "retry") {
    if (state.kind !== "failed") return state;
    return state.preview
      ? { ...state, kind: "deleting", error: null }
      : { ...INITIAL_DELETE_FLOW_STATE, kind: "previewing" };
  }

  const result = event.result;
  if (result.kind === "deleted") {
    return {
      ...state,
      kind: "deleted",
      retry: null,
      error: null,
      reasonError: null,
      auditId: result.auditId,
      tombstoneCount: result.tombstoneCount,
    };
  }
  if (result.kind === "refused") {
    const previewInvalid = result.reason === "preview_invalid" || result.reason === "preview_stale";
    return {
      ...state,
      kind: "failed",
      preview: previewInvalid ? null : state.preview,
      retry: null,
      error: previewInvalid
        ? "The deletion preview is no longer current. Load a fresh preview before retrying."
        : "Contact deletion is not enabled for this workspace.",
    };
  }
  return {
    ...state,
    kind: "failed",
    retry: result.retry,
    error: deletionFailure(result),
  };
}

export type ComplianceAffirmativeEvidence =
  | {
      kind: "provider_confirmation";
      providerSyncState: string;
      providerSyncedAt: string | null;
    }
  | {
      kind: "audit";
      auditId: string | null;
      actionKey: string | null;
      label: string | null;
    }
  | {
      kind: "escalation";
      needsHumanAt: string | null;
      auditId: number | null;
      alertIntentId: string | null;
    }
  | { kind: "deletion"; result: DeleteFlowResult | null };

/** Affirmative copy stays unavailable until the exact persisted receipt fields agree. */
export function complianceAffirmativeLabel(
  evidence: ComplianceAffirmativeEvidence,
): "Confirmed by provider" | "Logged" | "Escalated" | "Deleted" | null {
  if (evidence.kind === "provider_confirmation") {
    return evidence.providerSyncState === "confirmed" && Boolean(evidence.providerSyncedAt)
      ? "Confirmed by provider"
      : null;
  }
  if (evidence.kind === "audit") {
    return evidence.auditId && evidence.actionKey && evidence.label?.toLowerCase().includes("logged")
      ? "Logged"
      : null;
  }
  if (evidence.kind === "escalation") {
    return evidence.needsHumanAt && evidence.auditId && evidence.alertIntentId ? "Escalated" : null;
  }
  return evidence.result?.kind === "deleted" ? "Deleted" : null;
}

export type CoachCadenceCapability = import("@/lib/sends/channel-capabilities").ChannelCapability;
export type CoachCadenceClass = import("@/lib/sends/channel-capabilities").CadenceClass;

/** The live schedule follows the resolved capability, never a stored advisory channel class. */
export function resolvedCoachCadenceClass(
  channel: string | null,
  capability: CoachCadenceCapability | null,
): CoachCadenceClass {
  if (!channel || !capability) return "none";
  return capability.postWindow === "freeform" ||
    (capability.postWindow === "template" && capability.templateSend)
    ? "durable"
    : "window_bound";
}
// End Phase 3

// Phase 6
export type AdminMoneySurface = "tiers" | "billing" | "corrections" | "affiliates";

export function moneyPageAccessStatus(
  role: import("@/lib/auth/claims").UserRole,
  surface: AdminMoneySurface,
): 200 | 403 {
  if (role === "owner" || role === "admin") return 200;
  return role === "success" && surface === "corrections" ? 200 : 403;
}

export type MoneyReceipt = {
  auditId?: number | null;
  eventId?: string | null;
};

export function moneyReceiptLabel(
  receipt: MoneyReceipt | null,
  affirmative: "Logged" | "Approved" | "Suspended",
) {
  return receipt?.auditId && (affirmative !== "Approved" || receipt.eventId)
    ? affirmative
    : "Pending";
}

export function deriveTierView(input: {
  id: string;
  name: string;
  priceCents: number;
  callAllowance: number;
  fairUseCap: number | null;
  fairUseNote: string | null;
  active: boolean;
  isDemo: boolean;
  receipt?: { priceVersionId: string; auditId: number } | null;
}) {
  return {
    id: input.id,
    name: input.name,
    priceCents: input.priceCents,
    callAllowance: input.callAllowance,
    fairUseCap: input.fairUseCap,
    fairUseNote: input.fairUseNote,
    active: input.active,
    dataLabel: input.isDemo ? "Demo" as const : null,
    stateLabel: input.receipt?.priceVersionId && input.receipt.auditId ? "Logged" as const : "Persisted" as const,
  };
}

export function deriveOverrideView(input: {
  id: string;
  tenantId: string;
  tenantName: string;
  priceCents: number;
  effectiveAt: string;
  endsAt: string | null;
  isDemo: boolean;
  auditId: number | null;
}) {
  return {
    ...input,
    dataLabel: input.isDemo ? "Demo" as const : null,
    stateLabel: input.auditId ? "Logged" as const : "Pending" as const,
  };
}

export function deriveBillingStatusView(input: {
  tenantId: string;
  tenantName: string;
  tenantStatus: "active" | "overdue" | "suspended";
  providerStatus: string | null;
  providerUpdatedAt: string | null;
  pendingTierName: string | null;
  pendingEffectiveAt: string | null;
  isDemo: boolean;
  suspensionReceipt?: { auditId: number } | null;
}) {
  const suspended = input.tenantStatus === "suspended";
  return {
    ...input,
    dataLabel: input.isDemo ? "Demo" as const : null,
    providerLabel: input.providerStatus && input.providerUpdatedAt
      ? input.providerStatus
      : "Provider state unavailable",
    movementLabel: input.pendingTierName && input.pendingEffectiveAt
      ? `${input.pendingTierName} on ${input.pendingEffectiveAt}`
      : "No pending renewal movement",
    stateLabel: suspended && input.suspensionReceipt?.auditId ? "Suspended" as const : input.tenantStatus,
  };
}

export type CorrectionEvidence = {
  requestId: string;
  tenantId: string;
  /** The coach the dispute is against; null only where the tenant row could not be read. */
  businessName?: string | null;
  /**
   * "Demo" when the disputing coach is a seeded workspace. Optional on the wire for the same
   * reason `decisionReason` is: an older cached payload will not carry it, and a queue that
   * refuses to render is a worse failure than a row that cannot state its provenance. Absent is
   * read as "not labelled" by the table, which is the same thing a real row shows -- so the
   * degradation is toward the row looking real, and that is why the field is threaded from the
   * projection rather than derived anywhere downstream.
   */
  dataLabel?: string | null;
  billableEventId: string;
  quantityDelta: number;
  reason: string;
  requestedAt: string;
  requestAuditId: number;
  decision: "approved" | "rejected" | null;
  decisionId: string | null;
  /**
   * The deciding admin's own sentence. Optional on the wire because an older cached payload will
   * not carry it, and a queue that refuses to render rather than show a decision without its
   * reason is a worse failure than the missing sentence.
   */
  decisionReason?: string | null;
  decisionAuditId: number | null;
  offsetEventId: string | null;
};

export function deriveCorrectionView(input: CorrectionEvidence) {
  const receiptBacked = input.decision === "approved"
    ? Boolean(input.decisionId && input.decisionAuditId && input.offsetEventId)
    : input.decision === "rejected"
      ? Boolean(input.decisionId && input.decisionAuditId)
      : false;
  return {
    ...input,
    stateLabel: input.decision && receiptBacked ? input.decision : "pending" as const,
  };
}

/** The success projection contains request evidence only and has no decision or economics arm. */
export function deriveSuccessCorrectionQueue(rows: readonly CorrectionEvidence[]) {
  return rows.map((row) => ({
    requestId: row.requestId,
    tenantId: row.tenantId,
    billableEventId: row.billableEventId,
    quantityDelta: row.quantityDelta,
    reason: row.reason,
    requestedAt: row.requestedAt,
    requestAuditId: row.requestAuditId,
    // The narrowing drops decisions and economics, which a success reviewer does not carry. It
    // must not drop provenance: a seeded dispute is exactly as misleading to a reviewer as to an
    // admin, and this is the arm whose export is built in the browser from these very fields.
    dataLabel: row.dataLabel ?? null,
  }));
}

export type SuccessCorrectionEvidence = ReturnType<typeof deriveSuccessCorrectionQueue>[number];

export function deriveCommissionView(input: {
  ledgerId: string;
  affiliateId: string;
  affiliateName: string;
  tenantName: string;
  commissionCents: number;
  entryKind: "accrual" | "offset" | "recovery";
  reversesLedgerId: string | null;
  isDemo: boolean;
}) {
  return {
    ...input,
    dataLabel: input.isDemo ? "Demo" as const : null,
    stateLabel: input.entryKind === "accrual" ? "Accrued" as const : "Reversal recorded" as const,
  };
}

export function derivePayoutView(input: {
  payoutId: string;
  affiliateId: string;
  affiliateName: string;
  totalCents: number;
  approvedEventId: string | null;
  approvedAuditId: number | null;
  sentEventId: string | null;
  sentAuditId: number | null;
  reference: string | null;
  paidOn: string | null;
}) {
  if (input.sentEventId && input.sentAuditId && input.reference && input.paidOn) {
    return { ...input, stateLabel: "Recorded sent" as const };
  }
  if (input.approvedEventId && input.approvedAuditId) {
    return { ...input, stateLabel: "Approved for payout" as const };
  }
  return { ...input, stateLabel: "Pending approval" as const };
}

export type CostRollupInput = import("@/lib/billing/contracts").PlatformCostRollupResult;

export function deriveCostView(input: CostRollupInput | null) {
  if (!input) return { stateLabel: "Cost evidence absent" as const };
  const base = {
    rollupId: input.rollupId,
    tenantId: input.tenantId,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    revenueCents: input.revenueCents,
    modelCostCents: input.modelCostCents,
    messagingCostCents: input.messagingCostCents,
    embeddingCostCents: input.embeddingCostCents,
    complete: input.complete,
    missingSources: input.missingSources,
    sourceEvidenceAt: input.sourceEvidenceAt,
  };
  if (!input.complete) return { ...base, stateLabel: "Cost evidence incomplete" as const };
  const totalCostCents = (input.modelCostCents ?? 0)
    + (input.messagingCostCents ?? 0)
    + (input.embeddingCostCents ?? 0);
  return {
    ...base,
    stateLabel: "Cost evidence complete" as const,
    margin: { cents: input.revenueCents - totalCostCents, totalCostCents },
  };
}
// End Phase 6

// Monthly movement (R4-29)
const MOVEMENT_CURRENCY = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

type MovementItem = {
  label: string;
  value: import("react").ReactNode;
  direction: "up" | "down" | "warn" | "flat";
};

/** A zero and an unknown are different facts, so an absent figure never formats as an amount. */
function movementAmount(cents: number | null) {
  return cents === null
    ? "Unavailable"
    : `${cents >= 0 ? "+" : "−"}${MOVEMENT_CURRENCY.format(Math.abs(cents) / 100)}`;
}

/**
 * The array order is the column order: New, Upgrades, Churn, Downgrades. The projection decides
 * every sign; this only formats it.
 */
export function deriveMovementView(
  movement: import("@/lib/repositories/billing").MrrMovementRead | null,
) {
  if (!movement) return null;
  const items: MovementItem[] = [
    { label: "New", value: movementAmount(movement.newCents), direction: "up" },
    { label: "Upgrades", value: movementAmount(movement.upgradeCents), direction: "up" },
    { label: "Churn", value: movementAmount(movement.churnCents), direction: "down" },
    { label: "Downgrades", value: movementAmount(movement.downgradeCents), direction: "warn" },
  ];
  const caveats: string[] = [];
  if (movement.missingSources.includes("tier_reassignment")) {
    caveats.push(
      "Tier reassignment is not counted: no row records a tenant's previous tier, so a move between tiers leaves nothing to replay.",
    );
  }
  caveats.push(movement.scheduledCancellations === 1
    ? "1 subscription is scheduled to cancel at period end and is not counted until it takes effect."
    : `${movement.scheduledCancellations} subscriptions are scheduled to cancel at period end and are not counted until they take effect.`);
  if (movement.missingSources.includes("unpriced_tenant")) {
    caveats.push(
      "A tenant with no resolvable price leaves the figure unavailable rather than zero.",
    );
  }
  if (movement.missingSources.includes("unpriced_at_window_start")) {
    caveats.push(
      "A tenant whose price at the window start cannot be resolved is left out of upgrades and downgrades rather than read as no movement.",
    );
  }
  return {
    headline: movement.mrrCents === null
      ? "MRR unavailable"
      : `MRR ${MOVEMENT_CURRENCY.format(movement.mrrCents / 100)}`,
    chip: movement.clientCount === 1 ? "1 live subscription" : `${movement.clientCount} live subscriptions`,
    items,
    caveats,
  };
}
