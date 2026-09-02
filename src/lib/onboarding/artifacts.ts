/**
 * Deterministic rendering for the hosted opt-in artifact and its filing evidence.
 *
 * The module accepts approved template text rather than authoring legal or campaign copy. Every
 * rendered body and the campaign description share one template version so they cannot drift.
 */

import { createHash } from "node:crypto";

export type ApprovedArtifactTemplate = {
  templateVersion: string;
  approvalReference: string;
  marketingLanguage: string;
  nonMarketingLanguage: string;
  campaignDescription: string;
  termsUrl: string;
  privacyUrl: string;
  placeholder: boolean;
};

export type ArtifactBusinessIdentity = {
  businessName: string;
  websiteUrl: string;
};

export type ArtifactCheckboxDescriptor = {
  key: "marketing" | "non_marketing";
  checked: false;
  required: false;
  renderedLanguage: string;
  renderedLanguageHash: string;
};

export type RenderedOptInArtifact = {
  templateVersion: string;
  approvalReference: string;
  controls: readonly [ArtifactCheckboxDescriptor, ArtifactCheckboxDescriptor];
  termsUrl: string;
  privacyUrl: string;
  campaignDescription: string;
  campaignDescriptionHash: string;
  artifactHash: string;
  placeholder: boolean;
};

export type ArtifactSubmission = {
  marketing: boolean;
  nonMarketing: boolean;
};

/**
 * Exact carrier-facing examples supplied by the client for a recorded approval. This module
 * validates their shape only; it never supplies or rewrites legal or campaign language.
 */
export type ApprovedCampaignContentDraft = {
  sampleMessages: readonly string[];
};

const PLACEHOLDER_MARKER = "SETTERFI_DEMO_PLACEHOLDER_";

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function required(value: string, code: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

function httpsUrl(value: string, code: string) {
  const normalized = required(value, code);
  try {
    if (new URL(normalized).protocol !== "https:") throw new Error(code);
  } catch {
    throw new Error(code);
  }
  return normalized;
}

function renderTemplate(template: string, identity: ArtifactBusinessIdentity) {
  const rendered = required(template, "A2P_TEMPLATE_BODY_REQUIRED")
    .replaceAll("{{business_name}}", required(identity.businessName, "A2P_BUSINESS_NAME_REQUIRED"))
    .replaceAll("{{website_url}}", httpsUrl(identity.websiteUrl, "A2P_WEBSITE_URL_INVALID"));
  if (/{{[^{}]+}}/.test(rendered)) throw new Error("A2P_TEMPLATE_TOKEN_UNRESOLVED");
  return rendered;
}

function descriptor(
  key: ArtifactCheckboxDescriptor["key"],
  renderedLanguage: string,
): ArtifactCheckboxDescriptor {
  return {
    key,
    checked: false,
    required: false,
    renderedLanguage,
    renderedLanguageHash: hash(renderedLanguage),
  };
}

export function renderOptInArtifact(
  template: ApprovedArtifactTemplate,
  identity: ArtifactBusinessIdentity,
): RenderedOptInArtifact {
  const templateVersion = required(template.templateVersion, "A2P_TEMPLATE_VERSION_REQUIRED");
  const approvalReference = required(template.approvalReference, "A2P_TEMPLATE_APPROVAL_REQUIRED");
  const marketing = descriptor("marketing", renderTemplate(template.marketingLanguage, identity));
  const nonMarketing = descriptor(
    "non_marketing",
    renderTemplate(template.nonMarketingLanguage, identity),
  );
  const campaignDescription = renderTemplate(template.campaignDescription, identity);
  const campaignDescriptionHash = hash(campaignDescription);
  const termsUrl = httpsUrl(template.termsUrl, "A2P_TERMS_URL_INVALID");
  const privacyUrl = httpsUrl(template.privacyUrl, "A2P_PRIVACY_URL_INVALID");
  const artifactHash = hash(JSON.stringify({
    templateVersion,
    approvalReference,
    marketingLanguageHash: marketing.renderedLanguageHash,
    nonMarketingLanguageHash: nonMarketing.renderedLanguageHash,
    termsUrl,
    privacyUrl,
    campaignDescriptionHash,
  }));
  return {
    templateVersion,
    approvalReference,
    controls: [marketing, nonMarketing],
    termsUrl,
    privacyUrl,
    campaignDescription,
    campaignDescriptionHash,
    artifactHash,
    placeholder: template.placeholder,
  };
}

/** Both unchecked controls remain a valid form submission; they grant no messaging purpose. */
export function acceptArtifactSubmission(submission: ArtifactSubmission) {
  return {
    accepted: true as const,
    selectedControls: [
      submission.marketing ? "marketing" : null,
      submission.nonMarketing ? "non_marketing" : null,
    ].filter((value): value is ArtifactCheckboxDescriptor["key"] => value !== null),
  };
}

export function normalizeApprovedCampaignContent(
  draft: ApprovedCampaignContentDraft,
): { sampleMessages: readonly string[] } {
  if (!Array.isArray(draft.sampleMessages) || draft.sampleMessages.length === 0) {
    throw new Error("A2P_SAMPLE_MESSAGES_REQUIRED");
  }
  const sampleMessages = draft.sampleMessages.map((message) => {
    if (typeof message !== "string" || !message.trim()) {
      throw new Error("A2P_SAMPLE_MESSAGE_REQUIRED");
    }
    return message.trim();
  });
  return { sampleMessages };
}

export function assertArtifactReadyForRealFiling(artifact: RenderedOptInArtifact) {
  if (artifact.placeholder) throw new Error("A2P_COPY_NOT_APPROVED");
  const bodies = [
    artifact.controls[0].renderedLanguage,
    artifact.controls[1].renderedLanguage,
    artifact.campaignDescription,
    artifact.templateVersion,
  ];
  if (bodies.some((body) => body.includes(PLACEHOLDER_MARKER))) {
    throw new Error("A2P_DEMO_PLACEHOLDER_FORBIDDEN");
  }
  return artifact;
}

/**
 * Whether a stored opt-in artifact is one a lead-facing surface may act on.
 *
 * `placeholder` is `not null default true` on `onboarding_optin_artifacts`, so an artifact is a
 * placeholder until something says otherwise, and `is_current` with a `confirmed_at` says nothing
 * about it. A placeholder is legitimate on a demo tenant -- that is the seeded path the demos run
 * on -- and on nobody else's, which is why the tenant's own flag is an argument rather than an
 * assumption.
 *
 * It exists as one function because the rule was written out three times: twice in
 * `api/onboarding/run/handler.ts` (`:99`, `:219`) before a tenant may go live, and a third time in
 * the consent-link issuer, where it was *missing* -- so a coach could mint a link to a page that
 * then refuses to collect the consent the link was issued for, with a redemption already spent
 * against it. Two copies of a condition drift quietly; three is how one of them ends up absent.
 *
 * The hosted-artifact reader in SQL holds the same rule as `(not artifact.placeholder or
 * tenant.is_demo)` (`20260821000002_phase5_projection_gaps.sql:126`) and cannot import this. That
 * copy is unavoidable and is the one to check first if these ever disagree.
 */
export function optInArtifactIsPublished(
  artifact: { placeholder: boolean },
  tenant: { isDemo: boolean },
) {
  return !artifact.placeholder || tenant.isDemo;
}
