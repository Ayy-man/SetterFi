/**
 * Fail-closed validation for the hosted-form consent artifact Phase 5 will write.
 *
 * The allowlist rejects extra free-form fields so raw IP addresses, user agents, and personal
 * data cannot be smuggled into the evidence JSON beside the permitted one-way digests.
 */

import { MESSAGING_CHANNELS, type MessagingChannel } from "@/lib/integrations/types";
import { SEND_PURPOSES, type SendPurpose } from "@/lib/sends/contracts";

export type WebFormConsentEvidence = {
  schemaVersion: 1;
  formSubmissionId: string;
  formUrl: string;
  disclosureVersion: string;
  disclosureTextHash: string;
  submittedAt: string;
  purposes: readonly SendPurpose[];
  channels: readonly MessagingChannel[];
  ipHash?: string;
  userAgentHash?: string;
};

export type ConsentEvidenceValidation =
  | { kind: "verified"; evidence: WebFormConsentEvidence }
  | { kind: "unverified"; reason: "missing" | "invalid" | "unsupported_schema" };

const REQUIRED_KEYS = [
  "schemaVersion",
  "formSubmissionId",
  "formUrl",
  "disclosureVersion",
  "disclosureTextHash",
  "submittedAt",
  "purposes",
  "channels",
] as const;

const ALLOWED_KEYS = new Set<string>([
  ...REQUIRED_KEYS,
  "ipHash",
  "userAgentHash",
]);

const PURPOSES = new Set<string>(SEND_PURPOSES);
const CHANNELS = new Set<string>(MESSAGING_CHANNELS);
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function exactUniqueMembers(value: unknown, allowed: ReadonlySet<string>) {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (value.some((entry) => typeof entry !== "string" || !allowed.has(entry))) return false;
  return new Set(value).size === value.length;
}

function validUrl(value: unknown) {
  if (!nonEmpty(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function validInstant(value: unknown) {
  return nonEmpty(value) && Number.isFinite(Date.parse(value));
}

export function validateWebFormConsentEvidence(value: unknown): ConsentEvidenceValidation {
  if (value === null || value === undefined) return { kind: "unverified", reason: "missing" };
  if (!isRecord(value)) return { kind: "unverified", reason: "invalid" };
  if (value.schemaVersion !== 1) return { kind: "unverified", reason: "unsupported_schema" };
  if (Object.keys(value).some((key) => !ALLOWED_KEYS.has(key)) ||
    REQUIRED_KEYS.some((key) => !(key in value))) {
    return { kind: "unverified", reason: "invalid" };
  }
  if (!nonEmpty(value.formSubmissionId) || !validUrl(value.formUrl) ||
    !nonEmpty(value.disclosureVersion) ||
    typeof value.disclosureTextHash !== "string" ||
    !HASH_PATTERN.test(value.disclosureTextHash) || !validInstant(value.submittedAt) ||
    !exactUniqueMembers(value.purposes, PURPOSES) ||
    !exactUniqueMembers(value.channels, CHANNELS)) {
    return { kind: "unverified", reason: "invalid" };
  }
  for (const optionalHash of [value.ipHash, value.userAgentHash]) {
    if (optionalHash !== undefined &&
      (typeof optionalHash !== "string" || !HASH_PATTERN.test(optionalHash))) {
      return { kind: "unverified", reason: "invalid" };
    }
  }
  return { kind: "verified", evidence: value as WebFormConsentEvidence };
}
