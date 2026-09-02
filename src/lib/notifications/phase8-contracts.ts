import { ALERT_EVENT_KEYS } from "@/lib/booking/types";
import { BILLING_NOTIFICATION_EVENT_KEYS } from "@/lib/billing/contracts";
import { ONBOARDING_ALERT_KEYS } from "@/lib/onboarding/a2p-probe";

import { CHANNEL_EVENT_KEYS } from "./channel-events";
import { AGENT_INACTIVITY_EVENT_KEY } from "./agent-inactivity";

export type AlertScope = "tenant" | "platform";
export type ScopedAlertBinding = Readonly<{ eventKey: string; scope: AlertScope }>;

export type PrebuiltAlertRule = Readonly<{
  id: string;
  label: string;
  bindings: readonly ScopedAlertBinding[];
  unboundReason: string | null;
}>;

type OwnerArrays = Readonly<{
  alertEventKeys: readonly string[];
  channelEventKeys: readonly string[];
  onboardingAlertKeys: readonly string[];
  billingEventKeys: readonly string[];
}>;

const PHASE3_REQUIRED = [
  "conversation.needs_human",
  "conversation.tripwire_escalated",
  "conversation.outbound_send_unconfirmed",
  "suppression.provider_unconfirmed",
  "contact.deleted",
] as const;

const PHASE4_REQUIRED = [
  "send.refused.window_expired",
  "message_template.rejected",
  "conversation.needs_human",
] as const;

const PHASE5_REQUIRED = [
  "onboarding.stalled_system:platform",
  "onboarding.stalled_coach:tenant",
  "onboarding.stalled_external:platform",
  "onboarding.stalled_external:tenant",
  "onboarding.paying_not_live:tenant",
] as const;

const PHASE6_REQUIRED = [
  "billing.payment_failed",
  "billing.account_overdue",
  "billing.account_suspended",
  "billing.allowance_warning",
  "billing.allowance_crossed",
  "billing.tier_upgraded",
] as const;

const PHASE8_CHANNEL_REQUIRED = [
  "channel.disconnected",
  "onboarding.a2p_cleared",
  "onboarding.stalled",
] as const;

const PHASE8_BILLING_REQUIRED = ["billing.payment_completed"] as const;

// These bindings are deliberately hand-traced to state owners that currently invoke a durable
// notification emitter. The owner key arrays below are declarations, so deriving bindings from
// them would make uncalled event types look live.
const LIVE_OWNER_BINDINGS = [
  { eventKey: "appointment.booked", scope: "tenant" },
  { eventKey: "appointment.rescheduled", scope: "tenant" },
  { eventKey: "appointment.canceled", scope: "tenant" },
  { eventKey: "brain.publish_failed", scope: "platform" },
  { eventKey: "conversation.outbound_send_unconfirmed", scope: "platform" },
  { eventKey: "conversation.outbound_send_unconfirmed", scope: "tenant" },
  { eventKey: "conversation.tripwire_escalated", scope: "platform" },
  { eventKey: "conversation.tripwire_escalated", scope: "tenant" },
  { eventKey: "suppression.provider_unconfirmed", scope: "platform" },
  { eventKey: "suppression.provider_unconfirmed", scope: "tenant" },
  { eventKey: "contact.deleted", scope: "tenant" },
  { eventKey: "conversation.channel_continuation_unavailable", scope: "tenant" },
  { eventKey: "channel.disconnected", scope: "tenant" },
  { eventKey: "onboarding.a2p_cleared", scope: "tenant" },
  { eventKey: "onboarding.stalled", scope: "tenant" },
  { eventKey: "billing.payment_completed", scope: "tenant" },
  { eventKey: "billing.payment_failed", scope: "tenant" },
  { eventKey: "billing.account_overdue", scope: "tenant" },
  { eventKey: "billing.account_suspended", scope: "tenant" },
  { eventKey: "billing.allowance_warning", scope: "tenant" },
  { eventKey: "billing.allowance_crossed", scope: "tenant" },
  { eventKey: "billing.tier_upgraded", scope: "tenant" },
  { eventKey: AGENT_INACTIVITY_EVENT_KEY, scope: "tenant" },
] as const satisfies readonly ScopedAlertBinding[];

/**
 * The admin Alerts surface promises these eight product rules. A declaration, audit action, or
 * provisioning evidence row is not an emitted notification: a binding belongs here only after the
 * state owner persists the durable notification through its registered event emitter.
 */
export const PREBUILT_ALERT_RULES = [
  {
    id: "booking-made",
    label: "Booking made",
    bindings: [{ eventKey: "appointment.booked", scope: "tenant" }],
    unboundReason: null,
  },
  {
    id: "payment-failed",
    label: "Payment failed",
    bindings: [{ eventKey: "billing.payment_failed", scope: "tenant" }],
    unboundReason: null,
  },
  {
    id: "channel-disconnected",
    label: "Channel disconnected",
    bindings: [{ eventKey: "channel.disconnected", scope: "tenant" }],
    unboundReason: null,
  },
  {
    id: "a2p-cleared",
    label: "A2P cleared",
    bindings: [{ eventKey: "onboarding.a2p_cleared", scope: "tenant" }],
    unboundReason: null,
  },
  {
    id: "agent-inactive-72h",
    label: "Agent inactive 72h",
    bindings: [{ eventKey: AGENT_INACTIVITY_EVENT_KEY, scope: "tenant" }],
    unboundReason: null,
  },
  {
    id: "onboarding-stalled",
    label: "Onboarding stalled",
    bindings: [{ eventKey: "onboarding.stalled", scope: "tenant" }],
    unboundReason: null,
  },
  {
    id: "completed-payment",
    label: "Completed payment",
    bindings: [{ eventKey: "billing.payment_completed", scope: "tenant" }],
    unboundReason: null,
  },
  {
    id: "client-upgraded",
    label: "Client upgraded to next tier",
    bindings: [{ eventKey: "billing.tier_upgraded", scope: "tenant" }],
    unboundReason: null,
  },
] as const satisfies readonly PrebuiltAlertRule[];

export const PREBUILT_ALERT_RULE_BINDINGS = PREBUILT_ALERT_RULES.flatMap<ScopedAlertBinding>(
  (rule) => rule.bindings as readonly ScopedAlertBinding[],
);

export const PREBUILT_ALERT_RULES_WITHOUT_EMITTER = PREBUILT_ALERT_RULES.filter(
  (rule) => rule.unboundReason !== null,
);

function requireOwnerKeys(
  actual: readonly string[],
  expected: readonly string[],
  code: string,
) {
  if (expected.some((key) => !actual.includes(key))) throw new Error(code);
}

export function buildEmittedAlertRuleBindings(ownerArrays: OwnerArrays): ScopedAlertBinding[] {
  requireOwnerKeys(ownerArrays.alertEventKeys, PHASE3_REQUIRED, "PHASE3_ALERT_EVENTS_MISSING");
  requireOwnerKeys(ownerArrays.channelEventKeys, PHASE4_REQUIRED, "PHASE4_CHANNEL_EVENTS_MISSING");
  requireOwnerKeys(ownerArrays.onboardingAlertKeys, PHASE5_REQUIRED, "PHASE5_ALERT_EMITTERS_MISSING");
  requireOwnerKeys(ownerArrays.billingEventKeys, PHASE6_REQUIRED, "PHASE6_BILLING_EVENTS_MISSING");
  requireOwnerKeys(ownerArrays.channelEventKeys, PHASE8_CHANNEL_REQUIRED, "PHASE8_CHANNEL_EVENTS_MISSING");
  requireOwnerKeys(ownerArrays.billingEventKeys, PHASE8_BILLING_REQUIRED, "PHASE8_BILLING_EVENTS_MISSING");

  const bindings: readonly ScopedAlertBinding[] = LIVE_OWNER_BINDINGS;
  const unique = new Map(bindings.map((binding) => [
    `${binding.eventKey}:${binding.scope}`,
    binding,
  ]));
  return [...unique.values()].sort((left, right) =>
    `${left.eventKey}:${left.scope}`.localeCompare(`${right.eventKey}:${right.scope}`));
}

export const PHASE8_OWNER_ARRAYS = {
  alertEventKeys: ALERT_EVENT_KEYS,
  channelEventKeys: CHANNEL_EVENT_KEYS,
  onboardingAlertKeys: ONBOARDING_ALERT_KEYS,
  billingEventKeys: BILLING_NOTIFICATION_EVENT_KEYS,
} as const satisfies OwnerArrays;
