/**
 * What an audit row means, derived from the row and the closed action registry.
 *
 * These are the live audit surface's own derivations. That component keeps them private and it is
 * not ours to edit, so the rehaul screen carries its own copy rather than a second, looser rule:
 * the phrase table is typed against `AuditActionKey`, so a registry key without a sentence fails
 * the build here exactly as it does there. Nothing in this file reads anything; every function
 * takes a row the loader already returned.
 */

import { AUDIT_ACTIONS, type AuditActionKey } from "@/lib/audit/actions";

import type { AdminAuditRow } from "@/components/workspace/live/admin-audit-log";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** One human predicate per registry key: the verb the actor performed and the object it hit. */
export type EventPhrase = { verb: string; object: string };

const EVENT_PHRASES: Record<AuditActionKey, EventPhrase> = {
  "affiliate.payout.approved": { verb: "approved", object: "an affiliate payout" },
  "affiliate.payout.sent": { verb: "sent", object: "an affiliate payout" },
  "appointment.attendance_set": { verb: "recorded", object: "attendance for a booked call" },
  "appointment.attendance_set.system": { verb: "recorded", object: "attendance from the calendar provider" },
  "appointment.canceled": { verb: "canceled", object: "a booked call" },
  "appointment.created": { verb: "booked", object: "a call" },
  "appointment.rescheduled": { verb: "rescheduled", object: "a booked call" },
  "billing.checkout.created": { verb: "started", object: "a checkout" },
  "billing.correction.approved": { verb: "approved", object: "a billing correction" },
  "billing.correction.rejected": { verb: "rejected", object: "a billing correction" },
  "billing.correction.requested": { verb: "requested", object: "a billing correction" },
  "billing.tenant.suspended": { verb: "suspended", object: "a client's subscription" },
  "billing.tenant.unsuspended": { verb: "restored", object: "a client's subscription" },
  "billing.tenant_override.updated": { verb: "updated", object: "a client's call allowance override" },
  "billing.tier.updated": { verb: "changed", object: "a client's plan" },
  "brain.import.accepted": { verb: "accepted", object: "an import into the Brain" },
  "brain.published": { verb: "published", object: "a new version of the Brain" },
  "brain.rolled_back": { verb: "rolled back", object: "the Brain to an earlier version" },
  "calendar.connected": { verb: "connected", object: "a calendar" },
  "calendar.disconnected": { verb: "disconnected", object: "a calendar" },
  "capi.dataset.provisioned": { verb: "set up", object: "a conversion tracking dataset" },
  "channel.connect.completed": { verb: "completed", object: "a channel connection" },
  "channel.connect.started": { verb: "started", object: "a channel connection" },
  "channel.disconnected": { verb: "disconnected", object: "a channel" },
  "channel.provider.switched": { verb: "switched", object: "a channel to another provider" },
  "channel.went_live": { verb: "activated", object: "a channel" },
  "compliance.control_reply.published": { verb: "published", object: "an approved STOP, HELP or START reply" },
  "consent.opt_in": { verb: "recorded", object: "a consent opt-in" },
  "consent.opt_out": { verb: "recorded", object: "an opt-out" },
  "consent.web_form_recorded": { verb: "recorded", object: "consent from a web form" },
  "contact.created.manual": { verb: "created", object: "a lead record by hand" },
  "contact.delete": { verb: "deleted", object: "a lead record" },
  "contact.delete.preview": { verb: "previewed", object: "a lead deletion" },
  "contact.imported": { verb: "imported", object: "a batch of lead records" },
  "contact.merged": { verb: "merged", object: "two lead records" },
  "contact.note.added": { verb: "added", object: "a note to a lead record" },
  "contact.tag.added": { verb: "tagged", object: "a lead record" },
  "contact.tag.removed": { verb: "removed", object: "a tag from a lead record" },
  "contact.pipeline_stage.set": { verb: "moved", object: "a lead to another stage" },
  "contact.unmerged": { verb: "undid", object: "a lead merge" },
  "conversation.channel_continued": { verb: "continued", object: "a conversation on another channel" },
  "conversation.closed": { verb: "closed", object: "a conversation" },
  "conversation.closed.stale": { verb: "closed", object: "a conversation that went quiet" },
  "conversation.escalated": { verb: "escalated", object: "a conversation" },
  "conversation.guardrail.cleared": { verb: "cleared", object: "a guardrail hold" },
  "conversation.internal_note.added": { verb: "added", object: "an internal note" },
  "conversation.message.sent.human": { verb: "sent", object: "a message by hand" },
  "conversation.scope_blocked": { verb: "blocked", object: "a reply outside the agent's scope" },
  "conversation.takeover.claimed": { verb: "took over", object: "a conversation" },
  "conversation.takeover.released": { verb: "handed back", object: "a conversation" },
  "conversation.tripwire.refused": { verb: "refused", object: "a message that hit a tripwire" },
  "eval.case.promoted": { verb: "promoted", object: "an eval case" },
  "eval.model_config.created": { verb: "created", object: "a model configuration" },
  "export.finished": { verb: "finished", object: "an export" },
  "export.started": { verb: "started", object: "an export" },
  "followup.canceled.inbound": { verb: "canceled", object: "a follow-up after the lead replied" },
  "followup.claimed": { verb: "claimed", object: "a follow-up" },
  "followup.completed": { verb: "completed", object: "a follow-up" },
  "followup.deferred.quiet_hours": { verb: "deferred", object: "a follow-up past quiet hours" },
  "followup.discarded.window_closed": { verb: "discarded", object: "a follow-up whose window closed" },
  "impersonation.ended": { verb: "ended", object: "a view-as session" },
  "impersonation.started": { verb: "started", object: "a view-as session" },
  "keyword_goal.deactivated": { verb: "deactivated", object: "a keyword goal" },
  "keyword_goal.saved": { verb: "saved", object: "a keyword goal" },
  "message_template.rejected": { verb: "recorded", object: "a rejected message template" },
  "message_template.submitted": { verb: "submitted", object: "a message template" },
  "offer.published": { verb: "published", object: "an offer" },
  "onboarding.a2p_blocked_permanent": { verb: "recorded", object: "a permanent block on text message registration" },
  "onboarding.a2p_filing_confirmed": { verb: "confirmed", object: "the text message registration filing" },
  "onboarding.artifact_confirmed": { verb: "confirmed", object: "an onboarding artifact" },
  "onboarding.content_acknowledged": { verb: "acknowledged", object: "onboarding content" },
  "onboarding.content_admin_confirmed": { verb: "confirmed", object: "onboarding content" },
  "onboarding.signup_completed": { verb: "completed", object: "a signup" },
  "onboarding.step_failed": { verb: "recorded", object: "a failed provisioning step" },
  "onboarding.step_retried": { verb: "retried", object: "a provisioning step" },
  "onboarding.step_unblocked": { verb: "unblocked", object: "a provisioning step" },
  "platform_export.finished": { verb: "finished", object: "a platform export" },
  "platform_export.started": { verb: "started", object: "a platform export" },
  "provider.rotation.verified": { verb: "verified", object: "a provider key rotation" },
  "quiet_hours.window.change": { verb: "changed", object: "the quiet hours window" },
  "referral.code_rejected": { verb: "rejected", object: "a referral code" },
  "send.refused.no_consent": { verb: "refused", object: "a send without consent" },
  "send.refused.suppressed": { verb: "refused", object: "a send to a suppressed contact" },
  "send.refused.window_expired": { verb: "refused", object: "a send outside the messaging window" },
  "suppression.clear.provider": { verb: "cleared", object: "a suppression at the provider" },
  "suppression.correct": { verb: "corrected", object: "a suppression record" },
  "suppression.insert.keyword": { verb: "suppressed", object: "a contact after a stop keyword" },
  "suppression.insert.manual": { verb: "suppressed", object: "a contact by hand" },
  "suppression.provider.confirmed": { verb: "confirmed", object: "a suppression with the provider" },
  "suppression.provider.unconfirmed": { verb: "recorded", object: "a suppression the provider has not confirmed" },
  "suppression.push.failed": { verb: "recorded", object: "a failed suppression push" },
  "suppression.push.provider": { verb: "pushed", object: "a suppression to the provider" },
  "tenant.billing_contact_changed": { verb: "changed", object: "a client's billing contact" },
  "tenant.demo_flag.changed": { verb: "changed", object: "a client's test data flag" },
  "tenant.success_owner.reassigned": { verb: "reassigned", object: "a client's success owner" },
  "tenant.went_live": { verb: "activated", object: "a client workspace" },
  "test_recipient.registered": { verb: "registered", object: "a test recipient" },
};

const UNKNOWN_PHRASE: EventPhrase = { verb: "recorded", object: "an action" };

export function knownActionKey(value: string): AuditActionKey | null {
  return Object.prototype.hasOwnProperty.call(AUDIT_ACTIONS, value)
    ? value as AuditActionKey
    : null;
}

export function eventPhrase(action: string): EventPhrase {
  const key = knownActionKey(action);
  return key ? EVENT_PHRASES[key] : UNKNOWN_PHRASE;
}

/** The sentence as one string: "Published a new version of the Brain". */
export function eventLabel(action: string) {
  const phrase = eventPhrase(action);
  return `${phrase.verb.charAt(0).toLocaleUpperCase()}${phrase.verb.slice(1)} ${phrase.object}`;
}

/** The registry's "\u2026 logged" line for an event, or the neutral fallback for an unknown key. */
export function auditMicrocopy(action: string) {
  const key = knownActionKey(action);
  return key ? AUDIT_ACTIONS[key].microcopy : "Logged";
}

export function isSystemAction(action: string) {
  const key = knownActionKey(action);
  return key ? AUDIT_ACTIONS[key].actorKind === "system" : false;
}

/**
 * The outcome column reads the event itself, never a separate field the log does not carry. A
 * refusal, a block or a failure is a different thing to review than a completion, and everything
 * else is simply a recorded change.
 */
export type OutcomeTone = "bad" | "amber" | "good" | "grey";

export const AUDIT_OUTCOMES = {
  refused: { label: "Refused", tone: "amber" },
  failed: { label: "Failed", tone: "bad" },
  reversed: { label: "Reversed", tone: "bad" },
  completed: { label: "Applied", tone: "good" },
  recorded: { label: "Recorded", tone: "grey" },
} as const satisfies Record<string, { label: string; tone: OutcomeTone }>;

export const AUDIT_OUTCOME_KEYS = ["refused", "failed", "reversed", "completed", "recorded"] as const;

export type OutcomeKey = (typeof AUDIT_OUTCOME_KEYS)[number];

const OUTCOME_SUFFIXES: readonly (readonly [string, OutcomeKey])[] = [
  [".refused", "refused"],
  [".rejected", "refused"],
  ["_blocked", "refused"],
  [".scope_blocked", "refused"],
  [".a2p_blocked_permanent", "refused"],
  [".failed", "failed"],
  [".unconfirmed", "failed"],
  [".canceled", "reversed"],
  [".rolled_back", "reversed"],
  [".unmerged", "reversed"],
  [".disconnected", "reversed"],
  [".discarded.window_closed", "reversed"],
  [".suspended", "reversed"],
  [".approved", "completed"],
  [".completed", "completed"],
  [".confirmed", "completed"],
  [".verified", "completed"],
  [".finished", "completed"],
  [".published", "completed"],
  [".went_live", "completed"],
  [".accepted", "completed"],
  [".sent", "completed"],
];

export function outcomeOf(action: string): { label: string; tone: OutcomeTone } {
  for (const [suffix, key] of OUTCOME_SUFFIXES) {
    if (action.endsWith(suffix)) return AUDIT_OUTCOMES[key];
  }
  return AUDIT_OUTCOMES.recorded;
}

/** An outcome that did not simply go through, which is the one figure the summary line counts. */
export function needsReading(action: string) {
  const tone = outcomeOf(action).tone;
  return tone === "amber" || tone === "bad";
}

/** Two actor roles reach the screen, because the registry records exactly two actor kinds. */
export const ACTOR_ROLES = [
  { key: "human", label: "Person" },
  { key: "system", label: "SetterFi system" },
] as const;

export function actorRoleOf(row: AdminAuditRow) {
  return isSystemAction(row.action) ? ACTOR_ROLES[1] : ACTOR_ROLES[0];
}

export type AuditActor = { name: string; kind: "person" | "system" | "unknown" };

/** A name when the row carries one, "Operator" for a bare user id, and the system otherwise. */
export function actorFor(row: AdminAuditRow): AuditActor {
  const name = row.actorName?.trim();
  if (name) return { name, kind: "person" };
  if (row.actor === "Actor unavailable") {
    return isSystemAction(row.action)
      ? { name: "SetterFi", kind: "system" }
      : { name: "Actor unavailable", kind: "unknown" };
  }
  if (UUID_PATTERN.test(row.actor)) return { name: "Operator", kind: "person" };
  return { name: row.actor, kind: isSystemAction(row.action) ? "system" : "person" };
}

export function actorLabel(row: AdminAuditRow) {
  return actorFor(row).name;
}

/**
 * Which workspaces the change landed on. The registry's own `scope` is the authority: a
 * platform-scoped key reaches everyone by construction, and a tenant-scoped row names its
 * workspace when the loader resolved one. Nothing here counts agents.
 */
export function scopeOf(row: AdminAuditRow): { label: string; platformWide: boolean } {
  const key = knownActionKey(row.action);
  const platformWide = key ? AUDIT_ACTIONS[key].scope === "platform" : row.tenantId == null;
  if (platformWide) return { label: "Every workspace", platformWide: true };
  const name = row.tenantName?.trim();
  return { label: name || "One workspace", platformWide: false };
}

export function targetParts(value: string) {
  if (value === "Target unavailable") {
    return { label: value, type: null, id: null };
  }
  const separator = value.indexOf(": ");
  if (separator === -1) return { label: "Affected record", type: null, id: value };
  const type = value.slice(0, separator);
  const id = value.slice(separator + 2);
  const label = type.startsWith("ghl_")
    ? "Text messages (SMS)"
    : type.startsWith("calendar_") || type === "appointment"
      ? "Calendar"
      : type.startsWith("brain_")
        ? "The Brain"
        : type
          .replaceAll(/[._-]+/g, " ")
          .replace(/^./, (character) => character.toLocaleUpperCase());
  return { label: label || "Affected record", type, id };
}

export function sourceLabel(value: string) {
  return value
    .replaceAll(/[._-]+/g, " ")
    .replace(/^./, (character) => character.toLocaleUpperCase());
}
