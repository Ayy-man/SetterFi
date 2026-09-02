import { describe, expect, it } from "vitest";

import {
  acceptArtifactSubmission,
  assertArtifactReadyForRealFiling,
  normalizeApprovedCampaignContent,
  optInArtifactIsPublished,
  renderOptInArtifact,
  type ApprovedArtifactTemplate,
} from "./artifacts";

const template: ApprovedArtifactTemplate = {
  templateVersion: "synthetic-approved-v1",
  approvalReference: "approval-synthetic",
  marketingLanguage: "{{business_name}} marketing messages from {{website_url}}.",
  nonMarketingLanguage: "{{business_name}} service messages from {{website_url}}.",
  campaignDescription: "{{business_name}} uses the same approved disclosure at {{website_url}}.",
  termsUrl: "https://example.test/terms",
  privacyUrl: "https://example.test/privacy",
  placeholder: false,
};

const identity = {
  businessName: "Synthetic Coaching",
  websiteUrl: "https://example.test",
};

describe("onboarding opt-in artifact", () => {
  it("renders two optional unchecked controls from one approved template version", () => {
    const artifact = renderOptInArtifact(template, identity);
    expect(artifact.controls.map(({ key, checked, required }) => ({ key, checked, required })))
      .toEqual([
        { key: "marketing", checked: false, required: false },
        { key: "non_marketing", checked: false, required: false },
      ]);
    expect(artifact.templateVersion).toBe(template.templateVersion);
    expect(artifact.campaignDescription).toContain(identity.businessName);
    expect(artifact.artifactHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts submission with both optional controls false without inventing consent", () => {
    expect(acceptArtifactSubmission({ marketing: false, nonMarketing: false })).toEqual({
      accepted: true,
      selectedControls: [],
    });
  });

  it("preserves only client-supplied, non-empty sample messages for an approval", () => {
    expect(normalizeApprovedCampaignContent({
      sampleMessages: ["  Client-approved example one.  ", "Client-approved example two."],
    })).toEqual({ sampleMessages: ["Client-approved example one.", "Client-approved example two."] });
    expect(() => normalizeApprovedCampaignContent({ sampleMessages: [] })).toThrow("A2P_SAMPLE_MESSAGES_REQUIRED");
    expect(() => normalizeApprovedCampaignContent({ sampleMessages: ["   "] })).toThrow("A2P_SAMPLE_MESSAGE_REQUIRED");
  });

  it("links template, rendered language, and campaign description hashes deterministically", () => {
    const first = renderOptInArtifact(template, identity);
    const replay = renderOptInArtifact(template, identity);
    expect(replay).toEqual(first);
    expect(renderOptInArtifact({ ...template, templateVersion: "synthetic-approved-v2" }, identity)
      .artifactHash).not.toBe(first.artifactHash);
    expect(renderOptInArtifact({
      ...template,
      marketingLanguage: `${template.marketingLanguage} Updated.`,
    }, identity).campaignDescriptionHash).toBe(first.campaignDescriptionHash);
  });

  it("rejects unapproved or marked demo copy from real filing", () => {
    const placeholder = renderOptInArtifact({ ...template, placeholder: true }, identity);
    expect(() => assertArtifactReadyForRealFiling(placeholder)).toThrow("A2P_COPY_NOT_APPROVED");
    const marked = renderOptInArtifact({
      ...template,
      marketingLanguage: "SETTERFI_DEMO_PLACEHOLDER_CONSENT_VERSION {{business_name}}",
    }, identity);
    expect(() => assertArtifactReadyForRealFiling(marked))
      .toThrow("A2P_DEMO_PLACEHOLDER_FORBIDDEN");
  });

  it("refuses unresolved template tokens instead of silently filing partial copy", () => {
    expect(() => renderOptInArtifact({
      ...template,
      campaignDescription: "{{business_name}} {{missing_approved_field}}",
    }, identity)).toThrow("A2P_TEMPLATE_TOKEN_UNRESOLVED");
  });

  /*
   * The four combinations, stated rather than implied, because the rule is the one that was
   * missing from the consent-link issuer -- and the case it exists for is the third one: a
   * placeholder on a real tenant, which reads as a confirmed current artifact everywhere that
   * only checks `is_current` and `confirmed_at`.
   */
  it("publishes a real artifact anywhere, and a placeholder only on a demo tenant", () => {
    expect(optInArtifactIsPublished({ placeholder: false }, { isDemo: false })).toBe(true);
    expect(optInArtifactIsPublished({ placeholder: false }, { isDemo: true })).toBe(true);
    expect(optInArtifactIsPublished({ placeholder: true }, { isDemo: false })).toBe(false);
    expect(optInArtifactIsPublished({ placeholder: true }, { isDemo: true })).toBe(true);
  });
});
