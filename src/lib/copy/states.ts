import type { CoachPipelineRow } from "@/lib/repositories/analytics";
import type {
  ChannelConnectionState,
  ChannelConnectionView,
} from "@/lib/repositories/channel-connections";
import type { ConversationStatus } from "@/lib/repositories/conversations";
import type { QualificationOutcome } from "@/lib/domain/qualification";

export type StateTone = "neutral" | "good" | "warning" | "critical" | "info";

export type StateCopy = Readonly<{
  label: string;
  tone: StateTone;
}>;

export const CHANNEL_CONNECTION_STATE_COPY = {
  disconnected: { label: "Not connected", tone: "neutral" },
  connecting: { label: "Connecting", tone: "info" },
  pending_review: { label: "In review", tone: "warning" },
  ready: { label: "Ready to switch on", tone: "info" },
  live: { label: "Live", tone: "good" },
  error: { label: "Needs attention", tone: "critical" },
  expired: { label: "Reconnect needed", tone: "warning" },
  blocked_permanent: { label: "Blocked", tone: "critical" },
  flagged: { label: "Flagged", tone: "warning" },
  restricted: { label: "Restricted", tone: "warning" },
} as const satisfies Record<ChannelConnectionState, StateCopy>;

export const CONVERSATION_STATE_COPY = {
  agent: { label: "Agent handling", tone: "good" },
  needs_human: { label: "Needs you", tone: "warning" },
  human: { label: "You have it", tone: "info" },
  nurture: { label: "Nurturing", tone: "info" },
  closed: { label: "Closed", tone: "neutral" },
  scope_blocked: { label: "Outside scope", tone: "critical" },
  opted_out: { label: "Opted out", tone: "neutral" },
} as const satisfies Record<ConversationStatus, StateCopy>;

export const BILLING_SUBSCRIPTION_STATE_COPY: Readonly<Record<string, StateCopy>> = {
  active: { label: "Active", tone: "good" },
  trialing: { label: "Trial", tone: "info" },
  past_due: { label: "Payment due", tone: "warning" },
  unpaid: { label: "Payment overdue", tone: "critical" },
  canceled: { label: "Canceled", tone: "neutral" },
  incomplete: { label: "Setup pending", tone: "warning" },
  incomplete_expired: { label: "Setup expired", tone: "critical" },
  paused: { label: "Paused", tone: "warning" },
};

export const BILLING_INVOICE_STATE_COPY: Readonly<Record<string, StateCopy>> = {
  active: { label: "Current", tone: "good" },
  paid: { label: "Paid", tone: "good" },
  // An invoice that is merely issued and not yet paid is not an informational in-progress
  // state; `info` sits close enough to the accent that a column of them reads as selected rows.
  open: { label: "Open", tone: "neutral" },
  draft: { label: "Preparing", tone: "neutral" },
  past_due: { label: "Payment due", tone: "warning" },
  unpaid: { label: "Payment overdue", tone: "critical" },
  uncollectible: { label: "Needs attention", tone: "critical" },
  void: { label: "Voided", tone: "neutral" },
  canceled: { label: "Canceled", tone: "neutral" },
};

export const PIPELINE_STAGE_COPY = {
  new_lead: { label: "New lead", tone: "neutral" },
  qualifying: { label: "Qualifying", tone: "info" },
  booked: { label: "Booked", tone: "good" },
  qualified_no_buy: { label: "Qualified, no buy", tone: "warning" },
  long_term_followup: { label: "Long-term follow-up", tone: "info" },
  no_show: { label: "No show", tone: "warning" },
  disqualified: { label: "Disqualified", tone: "critical" },
} as const satisfies Record<CoachPipelineRow["stage"], StateCopy>;

export const QUALIFICATION_OUTCOME_COPY = {
  BOOK: { label: "Ready to book", tone: "good" },
  SOFT_DQ: { label: "Not a fit yet", tone: "warning" },
  HARD_DQ: { label: "Not a fit", tone: "critical" },
} as const satisfies Record<QualificationOutcome, StateCopy>;

export const MODERATOR_STATE_COPY = {
  allowed: { label: "Allowed", tone: "good" },
  blocked: { label: "Blocked", tone: "critical" },
  unavailable: { label: "No moderator response", tone: "warning" },
  not_recorded: { label: "No moderator result recorded", tone: "neutral" },
} as const satisfies Record<
  "allowed" | "blocked" | "unavailable" | "not_recorded",
  StateCopy
>;

export const TRACE_RULE_FALLBACK_COPY = {
  not_recorded: { label: "No matching rule recorded", tone: "neutral" },
} as const satisfies Record<"not_recorded", StateCopy>;

export type ChannelReceipts = ChannelConnectionView["receipts"];

export function receiptState(receipts: ChannelReceipts): "live" | "ready" | "connecting" {
  if (receipts.signedRoundTripAt !== null) return "live";
  if (receipts.oauthCompletedAt !== null && receipts.assetVerifiedAt !== null) return "ready";
  return "connecting";
}
