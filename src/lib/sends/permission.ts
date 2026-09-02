/**
 * Pure outbound permission policy for the single lead-facing send gate.
 *
 * I/O is deliberately absent: send-to-lead loads each fact in the required order, then this
 * module names the exact check that refused, discarded, deferred, or allowed the message.
 */

import type { MessagingChannel } from "@/lib/booking/types";
import { validateWebFormConsentEvidence } from "@/lib/compliance/consent-evidence";
import type { ChannelCapability } from "@/lib/sends/channel-capabilities";
import {
  CONTROL_MESSAGE_PURPOSES,
  type QuietHoursDecision,
  type SendContent,
  type SendDiscardReason,
  type SendPurpose,
  type SendRefusalReason,
} from "@/lib/sends/contracts";

export const CONSENT_STATES = [
  "none",
  "reply_only",
  "conversation",
  "opted_in",
  "unverified",
  "suppressed",
] as const;

export type ConsentState = (typeof CONSENT_STATES)[number];

export const CONSENT_SOURCES = [
  "inbound_message",
  "web_form",
  "lead_confirmed_sms",
  "verbal_recorded",
  "imported_attested",
  "platform_admin",
  "opt_back_in",
] as const;

export type ConsentSource = (typeof CONSENT_SOURCES)[number];
export type ConsentBasis = "reply_in_turn" | "conversation" | "standing" | null;

export type ConsentFacts = {
  state: ConsentState;
  source: ConsentSource | null;
  expiresAt: string | null;
  evidence: unknown;
  replyInTurn: boolean;
  conversationChannel: MessagingChannel;
  targetChannel: MessagingChannel;
};

export type SendPermissionFacts = {
  phaseEnabled: boolean;
  requestValid: boolean;
  targetValid: boolean;
  isTest: boolean;
  testRecipientVerified: boolean;
  tombstoned: boolean;
  locallySuppressed: boolean;
  purpose: SendPurpose;
  content: SendContent;
  controlCopyApproved: boolean;
  consentBasis: ConsentBasis;
  providerWindowOpen: boolean;
  capability: ChannelCapability;
  templateApproved: boolean;
  quietHours: QuietHoursDecision;
};

export type SendPermissionDecision =
  | { kind: "allow" }
  | { kind: "refused"; reason: SendRefusalReason }
  | { kind: "deferred"; at: string; timezoneSource: "contact" | "npa" | "continental_intersection" }
  | { kind: "discarded"; reason: SendDiscardReason };

const CONTROL_PURPOSES = new Set<SendPurpose>(CONTROL_MESSAGE_PURPOSES);
const STANDING_SOURCES = new Set<ConsentSource>([
  "web_form",
  "lead_confirmed_sms",
  "verbal_recorded",
  "platform_admin",
  "opt_back_in",
]);

export function isControlPurpose(purpose: SendPurpose) {
  return CONTROL_PURPOSES.has(purpose);
}

export function resolveConsentBasis(
  purpose: SendPurpose,
  facts: ConsentFacts,
  occurredAt: string,
): ConsentBasis {
  if (isControlPurpose(purpose)) return "standing";
  if (facts.replyInTurn && facts.conversationChannel === facts.targetChannel) {
    return "reply_in_turn";
  }
  const occurredAtMs = Date.parse(occurredAt);
  const expiresAtMs = facts.expiresAt === null ? Number.NaN : Date.parse(facts.expiresAt);
  if (
    facts.state === "conversation" &&
    facts.conversationChannel === facts.targetChannel &&
    Number.isFinite(occurredAtMs) && Number.isFinite(expiresAtMs) && occurredAtMs <= expiresAtMs
  ) {
    return "conversation";
  }
  if (facts.state !== "opted_in" || facts.source === null || !STANDING_SOURCES.has(facts.source)) {
    return null;
  }
  if (facts.expiresAt !== null && (
    !Number.isFinite(occurredAtMs) || !Number.isFinite(expiresAtMs) || occurredAtMs > expiresAtMs
  )) {
    return null;
  }
  if (facts.source !== "web_form") return "standing";
  const validation = validateWebFormConsentEvidence(facts.evidence);
  if (validation.kind !== "verified") return null;
  return validation.evidence.purposes.includes(purpose) &&
    validation.evidence.channels.includes(facts.targetChannel)
    ? "standing"
    : null;
}

export function approvedControlCopy(value: { approved: boolean; body: string } | null) {
  if (!value?.approved || !value.body.trim() || value.body.includes("SETTERFI_DEMO_PLACEHOLDER_")) {
    return null;
  }
  const body = value.body.trim();
  const hasLink = /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|co)\b)/iu.test(body);
  const hasOffer = /(?:[$£€]\s*\d|\b\d+\s*%|\b(?:discount|sale|special offer|apply now|book now|buy now)\b)/iu
    .test(body);
  return hasLink || hasOffer ? null : body;
}

export function evaluateSendPermission(facts: SendPermissionFacts): SendPermissionDecision {
  if (!facts.phaseEnabled) return { kind: "refused", reason: "phase_disabled" };
  if (!facts.requestValid || !facts.targetValid) {
    return { kind: "refused", reason: "invalid_request" };
  }
  if (facts.isTest && !facts.testRecipientVerified) {
    return { kind: "refused", reason: "test_recipient_not_verified" };
  }

  const controlPurpose = isControlPurpose(facts.purpose);
  if ((facts.tombstoned || facts.locallySuppressed) && !controlPurpose) {
    return { kind: "refused", reason: "suppressed" };
  }
  if (controlPurpose && !facts.controlCopyApproved) {
    return { kind: "refused", reason: "copy_unapproved" };
  }
  if (!controlPurpose && facts.consentBasis === null) {
    return { kind: "refused", reason: "no_consent_basis" };
  }
  if (facts.content.kind === "approved_template" && !facts.templateApproved) {
    return { kind: "refused", reason: "template_not_approved" };
  }
  if (!facts.providerWindowOpen) {
    const canSendFreeform = facts.content.kind === "freeform" &&
      facts.capability.postWindow === "freeform";
    const canSendTemplate = facts.content.kind === "approved_template" &&
      facts.capability.postWindow === "template" && facts.capability.templateSend;
    if (!canSendFreeform && !canSendTemplate) {
      return { kind: "discarded", reason: "provider_window_closed" };
    }
  }
  if (controlPurpose) return { kind: "allow" };
  if (facts.quietHours.kind === "defer_once") {
    return {
      kind: "deferred",
      at: facts.quietHours.at,
      timezoneSource: facts.quietHours.timezoneSource,
    };
  }
  if (facts.quietHours.kind === "cancel_stale") {
    return { kind: "discarded", reason: facts.quietHours.reason };
  }
  return { kind: "allow" };
}
