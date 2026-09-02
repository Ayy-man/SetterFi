/**
 * Service-role RPC boundary for Phase 5 onboarding evidence.
 *
 * Phase 3 remains the only authority that validates hosted-form evidence, and Plan 01's RPCs are
 * the only persistence path so confirmation and the audit receipt commit in one transaction.
 */

import { createHash } from "node:crypto";

import {
  validateWebFormConsentEvidence,
  type WebFormConsentEvidence,
} from "@/lib/compliance/consent-evidence";
import type { MessagingChannel } from "@/lib/integrations/types";
import { PROVISIONING_STATES, type ProvisioningState } from "@/lib/onboarding/contracts";
import { disclosureHostIsReachable } from "@/lib/onboarding/disclosure-url";
import type { SendPurpose } from "@/lib/sends/contracts";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

type RpcResult = { data: unknown; error: { message: string } | null };
export type OnboardingEvidenceRpcClient = {
  rpc(name: string, args: Record<string, unknown>): Promise<RpcResult>;
};

type ConsentValidator = typeof validateWebFormConsentEvidence;

export type HostedArtifactPage = "consent" | "terms" | "privacy";

export type HostedArtifactProjection = {
  artifactId: string;
  version: number;
  templateVersion: string;
  tenantSlug: string;
  businessName: string;
  isDemo: boolean;
  marketingLanguage: string;
  marketingLanguageHash: string;
  nonMarketingLanguage: string;
  nonMarketingLanguageHash: string;
  termsBody: string | null;
  termsBodyHash: string | null;
  privacyBody: string | null;
  privacyBodyHash: string | null;
  termsUrl: string;
  privacyUrl: string;
  /**
   * Whether `privacyUrl`'s host can ever resolve for anybody, by the same rule the database uses
   * to decide whether a lead is handed the link at all
   * (`app.disclosure_host_is_reachable`, kept in step by
   * `supabase/tests/disclosure-url-agreement.test.ts`).
   *
   * Derived beside the value, never in place of it. `privacyUrl` keeps whatever is stored.
   */
  privacyUrlReachable: boolean;
  campaignDescriptionHash: string;
  artifactHash: string;
  placeholder: boolean;
  confirmedAt: string;
};

export type CoachA2pRegistrationProjection = {
  submittedAt: string | null;
  registrationState: ProvisioningState;
  terminalRejection: boolean;
  terminalCode: string | null;
};

type HostedArtifactRow = Record<
  | "artifact_id" | "version" | "template_version" | "tenant_slug" | "business_name"
  | "is_demo" | "marketing_language" | "marketing_language_hash"
  | "non_marketing_language" | "non_marketing_language_hash" | "terms_body"
  | "terms_body_hash" | "privacy_body" | "privacy_body_hash" | "terms_url"
  | "privacy_url" | "campaign_description_hash" | "artifact_hash" | "placeholder"
  | "confirmed_at",
  unknown
>;

type CoachA2pRegistrationRow = {
  submitted_at: unknown;
  registration_state: unknown;
  terminal_rejection: unknown;
  terminal_code: unknown;
};

export type RecordWebFormConsentInput = {
  tenantId: string;
  artifactId: string;
  contactIdentityId: string;
  renderedLanguage: string;
  pageUrl: string;
  submittedAt: string;
  formSubmissionId: string;
  disclosureVersion: string;
  purposes: readonly SendPurpose[];
  channels: readonly MessagingChannel[];
};

export type OnboardingEvidenceRepository = {
  recordWebFormConsent(input: RecordWebFormConsentInput): Promise<{
    auditId: string;
    actionKey: "consent.web_form_recorded";
    evidence: WebFormConsentEvidence;
  }>;
  confirmArtifact(input: { tenantId: string; artifactId: string; actorId: string }): Promise<{
    auditId: string;
    actionKey: "onboarding.artifact_confirmed";
  }>;
  acknowledgeContentScreen(input: {
    tenantId: string;
    screenId: string;
    actorId: string;
  }): Promise<{ auditId: string; actionKey: "onboarding.content_acknowledged" }>;
  confirmContentScreen(input: {
    tenantId: string;
    screenId: string;
    actorId: string;
  }): Promise<{ auditId: string; actionKey: "onboarding.a2p_filing_confirmed" }>;
  recordA2pProbeReceipt(input: {
    tenantId: string;
    probeKey: string;
    targetHash: string;
    result: "inconclusive" | "retryable_failure" | "delivered" | "terminal_rejection";
    providerReference: string | null;
    providerCode: string | null;
    observedAt: string;
  }): Promise<{ receiptId: string }>;
};

function auditId(value: unknown, code: string) {
  if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim()) {
    throw new Error(code);
  }
  return String(value);
}

function rpcFailure(prefix: string, error: { message: string } | null) {
  return new Error(`${prefix}:${error?.message ?? "empty"}`);
}

function requiredString(value: unknown, code: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value;
}

function nullableString(value: unknown, code: string) {
  return value === null ? null : requiredString(value, code);
}

function sha256(value: unknown, code: string) {
  const normalized = requiredString(value, code);
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error(code);
  return normalized;
}

function mapHostedArtifact(row: HostedArtifactRow): HostedArtifactProjection {
  if (
    typeof row.version !== "number"
    || !Number.isInteger(row.version)
    || typeof row.is_demo !== "boolean"
    || typeof row.placeholder !== "boolean"
  ) throw new Error("HOSTED_ARTIFACT_ROW_INVALID");
  return {
    artifactId: requiredString(row.artifact_id, "HOSTED_ARTIFACT_ROW_INVALID"),
    version: row.version,
    templateVersion: requiredString(row.template_version, "HOSTED_ARTIFACT_ROW_INVALID"),
    tenantSlug: requiredString(row.tenant_slug, "HOSTED_ARTIFACT_ROW_INVALID"),
    businessName: requiredString(row.business_name, "HOSTED_ARTIFACT_ROW_INVALID"),
    isDemo: row.is_demo,
    marketingLanguage: requiredString(row.marketing_language, "HOSTED_ARTIFACT_ROW_INVALID"),
    marketingLanguageHash: sha256(row.marketing_language_hash, "HOSTED_ARTIFACT_ROW_INVALID"),
    nonMarketingLanguage: requiredString(row.non_marketing_language, "HOSTED_ARTIFACT_ROW_INVALID"),
    nonMarketingLanguageHash: sha256(row.non_marketing_language_hash, "HOSTED_ARTIFACT_ROW_INVALID"),
    termsBody: nullableString(row.terms_body, "HOSTED_ARTIFACT_ROW_INVALID"),
    termsBodyHash: row.terms_body_hash === null
      ? null
      : sha256(row.terms_body_hash, "HOSTED_ARTIFACT_ROW_INVALID"),
    privacyBody: nullableString(row.privacy_body, "HOSTED_ARTIFACT_ROW_INVALID"),
    privacyBodyHash: row.privacy_body_hash === null
      ? null
      : sha256(row.privacy_body_hash, "HOSTED_ARTIFACT_ROW_INVALID"),
    termsUrl: requiredString(row.terms_url, "HOSTED_ARTIFACT_ROW_INVALID"),
    privacyUrl: requiredString(row.privacy_url, "HOSTED_ARTIFACT_ROW_INVALID"),
    privacyUrlReachable: disclosureHostIsReachable(
      requiredString(row.privacy_url, "HOSTED_ARTIFACT_ROW_INVALID"),
    ),
    campaignDescriptionHash: sha256(row.campaign_description_hash, "HOSTED_ARTIFACT_ROW_INVALID"),
    artifactHash: sha256(row.artifact_hash, "HOSTED_ARTIFACT_ROW_INVALID"),
    placeholder: row.placeholder,
    confirmedAt: requiredString(row.confirmed_at, "HOSTED_ARTIFACT_ROW_INVALID"),
  };
}

function mapCoachA2pRegistration(
  row: CoachA2pRegistrationRow,
): CoachA2pRegistrationProjection {
  if (
    typeof row.registration_state !== "string"
    || !PROVISIONING_STATES.includes(row.registration_state as ProvisioningState)
    || typeof row.terminal_rejection !== "boolean"
  ) throw new Error("COACH_A2P_REGISTRATION_ROW_INVALID");
  const terminalCode = nullableString(row.terminal_code, "COACH_A2P_REGISTRATION_ROW_INVALID");
  if (row.terminal_rejection !== Boolean(terminalCode)) {
    throw new Error("COACH_A2P_REGISTRATION_ROW_INVALID");
  }
  return {
    submittedAt: nullableString(row.submitted_at, "COACH_A2P_REGISTRATION_ROW_INVALID"),
    registrationState: row.registration_state as ProvisioningState,
    terminalRejection: row.terminal_rejection,
    terminalCode,
  };
}

async function hostedArtifactRows(
  tenantSlug: string,
  page: HostedArtifactPage,
): Promise<readonly HostedArtifactRow[]> {
  const client = await createSupabaseServerClient();
  const { data, error } = await client.rpc("read_hosted_onboarding_artifact", {
    p_tenant_slug: tenantSlug,
    p_page: page,
  });
  if (error) throw new Error("HOSTED_ARTIFACT_READ_FAILED");
  return (data ?? []) as HostedArtifactRow[];
}

export async function loadHostedOnboardingArtifact(
  tenantSlug: string,
  page: HostedArtifactPage,
  source: (
    tenantSlug: string,
    page: HostedArtifactPage,
  ) => Promise<readonly HostedArtifactRow[]> = hostedArtifactRows,
): Promise<HostedArtifactProjection | null> {
  const rows = await source(tenantSlug, page);
  if (rows.length > 1) throw new Error("HOSTED_ARTIFACT_ROW_INVALID");
  return rows[0] ? mapHostedArtifact(rows[0]) : null;
}

async function coachA2pRows(tenantId: string): Promise<readonly CoachA2pRegistrationRow[]> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.rpc("read_coach_a2p_registration", {
    p_expected_tenant: tenantId,
  });
  if (error) throw new Error("COACH_A2P_REGISTRATION_READ_FAILED");
  return (data ?? []) as CoachA2pRegistrationRow[];
}

export async function loadCoachA2pRegistration(
  tenantId: string,
  source: (tenantId: string) => Promise<readonly CoachA2pRegistrationRow[]> = coachA2pRows,
): Promise<CoachA2pRegistrationProjection | null> {
  const rows = await source(tenantId);
  if (rows.length > 1) throw new Error("COACH_A2P_REGISTRATION_ROW_INVALID");
  return rows[0] ? mapCoachA2pRegistration(rows[0]) : null;
}

export function createOnboardingEvidenceRepository(
  options: {
    client?: OnboardingEvidenceRpcClient;
    validator?: ConsentValidator | null;
  } = {},
): OnboardingEvidenceRepository {
  const client = options.client ?? createSupabaseServiceClient();
  const validator = options.validator === undefined
    ? validateWebFormConsentEvidence
    : options.validator;

  return {
    recordWebFormConsent: async (input) => {
      if (typeof validator !== "function") throw new Error("PHASE3_CONSENT_CONTRACT_MISSING");
      const evidence = {
        schemaVersion: 1,
        formSubmissionId: input.formSubmissionId,
        formUrl: input.pageUrl,
        disclosureVersion: input.disclosureVersion,
        disclosureTextHash: createHash("sha256").update(input.renderedLanguage).digest("hex"),
        submittedAt: input.submittedAt,
        purposes: [...input.purposes],
        channels: [...input.channels],
      } satisfies WebFormConsentEvidence;
      const validated = validator(evidence);
      if (validated.kind !== "verified") {
        throw new Error(`WEB_FORM_CONSENT_EVIDENCE_INVALID:${validated.reason}`);
      }
      const { data, error } = await client.rpc("redeem_web_form_consent", {
        p_tenant_id: input.tenantId,
        p_artifact_id: input.artifactId,
        p_contact_identity_id: input.contactIdentityId,
        p_rendered_language: input.renderedLanguage,
        p_page_url: input.pageUrl,
        p_submitted_at: input.submittedAt,
        p_purposes: [...input.purposes],
        p_evidence: validated.evidence,
        p_form_submission_id: input.formSubmissionId,
        p_expected_tenant_id: input.tenantId,
      });
      if (error) throw rpcFailure("RECORD_WEB_FORM_CONSENT_FAILED", error);
      return {
        auditId: auditId(data, "RECORD_WEB_FORM_CONSENT_EMPTY"),
        actionKey: "consent.web_form_recorded",
        evidence: validated.evidence,
      };
    },
    confirmArtifact: async (input) => {
      const { data, error } = await client.rpc("confirm_onboarding_artifact", {
        p_expected_tenant: input.tenantId,
        p_artifact_id: input.artifactId,
        p_actor_id: input.actorId,
      });
      if (error) throw rpcFailure("CONFIRM_ONBOARDING_ARTIFACT_FAILED", error);
      return {
        auditId: auditId(data, "CONFIRM_ONBOARDING_ARTIFACT_EMPTY"),
        actionKey: "onboarding.artifact_confirmed",
      };
    },
    acknowledgeContentScreen: async (input) => {
      const { data, error } = await client.rpc("acknowledge_onboarding_content_screen", {
        p_expected_tenant: input.tenantId,
        p_screen_id: input.screenId,
        p_actor_id: input.actorId,
      });
      if (error) throw rpcFailure("ACKNOWLEDGE_ONBOARDING_CONTENT_SCREEN_FAILED", error);
      return {
        auditId: auditId(data, "ACKNOWLEDGE_ONBOARDING_CONTENT_SCREEN_EMPTY"),
        actionKey: "onboarding.content_acknowledged",
      };
    },
    confirmContentScreen: async (input) => {
      const { data, error } = await client.rpc("confirm_onboarding_content_screen", {
        p_expected_tenant: input.tenantId,
        p_screen_id: input.screenId,
        p_actor_id: input.actorId,
      });
      if (error) throw rpcFailure("CONFIRM_ONBOARDING_CONTENT_SCREEN_FAILED", error);
      return {
        auditId: auditId(data, "CONFIRM_ONBOARDING_CONTENT_SCREEN_EMPTY"),
        actionKey: "onboarding.a2p_filing_confirmed",
      };
    },
    recordA2pProbeReceipt: async (input) => {
      if (!/^[0-9a-f]{64}$/.test(input.targetHash)) {
        throw new Error("A2P_PROBE_TARGET_HASH_INVALID");
      }
      const { data, error } = await client.rpc("record_a2p_probe_receipt", {
        p_expected_tenant: input.tenantId,
        p_probe_key: input.probeKey,
        p_target_identifier_hash: input.targetHash,
        p_result: input.result,
        p_provider_reference: input.providerReference,
        p_provider_code: input.providerCode,
        p_observed_at: input.observedAt,
      });
      if (error) throw rpcFailure("RECORD_A2P_PROBE_RECEIPT_FAILED", error);
      return { receiptId: auditId(data, "RECORD_A2P_PROBE_RECEIPT_EMPTY") };
    },
  };
}
