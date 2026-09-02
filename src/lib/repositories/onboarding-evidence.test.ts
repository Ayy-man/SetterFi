import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { OnboardingEvidenceRpcClient } from "./onboarding-evidence";
import {
  createOnboardingEvidenceRepository,
  loadCoachA2pRegistration,
  loadHostedOnboardingArtifact,
} from "./onboarding-evidence";

function rpcClient() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: OnboardingEvidenceRpcClient = {
    async rpc(name, args) {
      calls.push({ name, args });
      return { data: calls.length, error: null };
    },
  };
  return { client, calls };
}

const consentInput = {
  tenantId: "tenant-synthetic",
  artifactId: "artifact-synthetic",
  contactIdentityId: "identity-synthetic",
  renderedLanguage: "Synthetic approved disclosure.",
  pageUrl: "https://example.test/opt-in",
  submittedAt: "2026-08-17T12:00:00.000Z",
  formSubmissionId: "submission-synthetic",
  disclosureVersion: "synthetic-approved-v1",
  purposes: ["follow_up"] as const,
  channels: ["sms"] as const,
};

describe("onboarding evidence repository", () => {
  it("maps the confirmed hosted artifact envelope without lead or economic fields", async () => {
    const result = await loadHostedOnboardingArtifact("synthetic", "terms", async (slug, page) => [{
      artifact_id: "artifact-synthetic",
      version: 2,
      template_version: "approved-v2",
      tenant_slug: slug,
      business_name: "Synthetic Business",
      is_demo: false,
      marketing_language: "Marketing disclosure",
      marketing_language_hash: "a".repeat(64),
      non_marketing_language: "Non-marketing disclosure",
      non_marketing_language_hash: "b".repeat(64),
      terms_body: page === "terms" ? "Persisted terms" : null,
      terms_body_hash: "c".repeat(64),
      privacy_body: "Persisted privacy",
      privacy_body_hash: "d".repeat(64),
      terms_url: "https://example.test/terms",
      privacy_url: "https://example.test/privacy",
      campaign_description_hash: "e".repeat(64),
      artifact_hash: "f".repeat(64),
      placeholder: false,
      confirmed_at: "2026-08-18T00:00:00.000Z",
    }]);
    expect(result).toMatchObject({
      artifactId: "artifact-synthetic",
      tenantSlug: "synthetic",
      termsBody: "Persisted terms",
      isDemo: false,
      placeholder: false,
    });
    expect(Object.keys(result ?? {})).not.toEqual(expect.arrayContaining([
      "priceCents", "leadId", "contactIdentityId",
    ]));
  });

  /**
   * The evidence read surfaces the judgement rather than acting on it.
   *
   * The rule itself lives in SQL, where it gates whether a lead is handed the link at all
   * (`app.disclosure_host_is_reachable`). This projection must never gate anything: two of its
   * consumers compare `content.privacy_url = artifact.privacy_url` to detect drift between
   * approved campaign content and the current artifact, so a value withheld on one side would
   * either read as drift that is not there or hide drift that is.
   */
  it("flags an unreachable privacy URL without altering the value it reports", async () => {
    const projection = async (privacyUrl: string) => await loadHostedOnboardingArtifact("synthetic", "consent", async () => [{
      artifact_id: "artifact-synthetic", version: 1, template_version: "synthetic-v1",
      tenant_slug: "synthetic", business_name: "Synthetic Coach", is_demo: false,
      marketing_language: "Marketing disclosure", marketing_language_hash: "a".repeat(64),
      non_marketing_language: "Non-marketing disclosure", non_marketing_language_hash: "b".repeat(64),
      terms_body: null, terms_body_hash: "c".repeat(64),
      privacy_body: "Persisted privacy", privacy_body_hash: "d".repeat(64),
      terms_url: "https://legacystrong.com/terms", privacy_url: privacyUrl,
      campaign_description_hash: "e".repeat(64), artifact_hash: "f".repeat(64),
      placeholder: false, confirmed_at: "2026-08-18T00:00:00.000Z",
    }]);

    // The placeholder that was actually sitting in the hosted database.
    const flagged = await projection("https://example.invalid/phase5-demo/privacy");
    expect(flagged?.privacyUrl).toBe("https://example.invalid/phase5-demo/privacy");
    expect(flagged?.privacyUrlReachable).toBe(false);

    const live = await projection("https://legacystrong.com/privacy");
    expect(live?.privacyUrl).toBe("https://legacystrong.com/privacy");
    expect(live?.privacyUrlReachable).toBe(true);
  });

  it("maps coach-safe A2P clock and terminal evidence with the expected tenant source", async () => {
    const calls: string[] = [];
    await expect(loadCoachA2pRegistration("tenant-synthetic", async (tenantId) => {
      calls.push(tenantId);
      return [{
        submitted_at: "2026-08-17T12:00:00.000Z",
        registration_state: "awaiting_provider",
        terminal_rejection: false,
        terminal_code: null,
      }];
    })).resolves.toEqual({
      submittedAt: "2026-08-17T12:00:00.000Z",
      registrationState: "awaiting_provider",
      terminalRejection: false,
      terminalCode: null,
    });
    expect(calls).toEqual(["tenant-synthetic"]);

    await expect(loadCoachA2pRegistration("tenant-synthetic", async () => [{
      submitted_at: "2026-08-17T12:00:00.000Z",
      registration_state: "blocked",
      terminal_rejection: true,
      terminal_code: "CARRIER_TERMINAL",
    }])).resolves.toMatchObject({
      terminalRejection: true,
      terminalCode: "CARRIER_TERMINAL",
    });
  });

  it("passes the exact Phase 3 validator payload into the one-use consent RPC", async () => {
    const { client, calls } = rpcClient();
    const repository = createOnboardingEvidenceRepository({ client });
    const receipt = await repository.recordWebFormConsent(consentInput);
    expect(receipt).toMatchObject({
      auditId: "1",
      actionKey: "consent.web_form_recorded",
      evidence: {
        schemaVersion: 1,
        formSubmissionId: "submission-synthetic",
        formUrl: "https://example.test/opt-in",
        disclosureVersion: "synthetic-approved-v1",
        purposes: ["follow_up"],
        channels: ["sms"],
      },
    });
    expect(receipt.evidence.disclosureTextHash).toMatch(/^[0-9a-f]{64}$/);
    expect(calls).toEqual([{
      name: "redeem_web_form_consent",
      args: {
        p_tenant_id: "tenant-synthetic",
        p_artifact_id: "artifact-synthetic",
        p_contact_identity_id: "identity-synthetic",
        p_rendered_language: "Synthetic approved disclosure.",
        p_page_url: "https://example.test/opt-in",
        p_submitted_at: "2026-08-17T12:00:00.000Z",
        p_purposes: ["follow_up"],
        p_evidence: receipt.evidence,
        p_form_submission_id: "submission-synthetic",
        p_expected_tenant_id: "tenant-synthetic",
      },
    }]);
    expect(Object.keys(receipt.evidence).sort()).toEqual([
      "channels",
      "disclosureTextHash",
      "disclosureVersion",
      "formSubmissionId",
      "formUrl",
      "purposes",
      "schemaVersion",
      "submittedAt",
    ]);
  });

  it("fails with the named Phase 3 seam error instead of reimplementing validation", async () => {
    const { client, calls } = rpcClient();
    const repository = createOnboardingEvidenceRepository({ client, validator: null });
    await expect(repository.recordWebFormConsent(consentInput))
      .rejects.toThrow("PHASE3_CONSENT_CONTRACT_MISSING");
    expect(calls).toEqual([]);
  });

  it("refuses invalid validator evidence before the consent RPC", async () => {
    const { client, calls } = rpcClient();
    const repository = createOnboardingEvidenceRepository({
      client,
      validator: () => ({ kind: "unverified", reason: "invalid" }),
    });
    await expect(repository.recordWebFormConsent(consentInput))
      .rejects.toThrow("WEB_FORM_CONSENT_EVIDENCE_INVALID:invalid");
    expect(calls).toEqual([]);
  });

  it("calls artifact and dual-confirmation RPCs with exact arguments and receipts", async () => {
    const { client, calls } = rpcClient();
    const repository = createOnboardingEvidenceRepository({ client });
    await expect(repository.confirmArtifact({
      tenantId: "tenant-synthetic",
      artifactId: "artifact-synthetic",
      actorId: "coach-synthetic",
    })).resolves.toEqual({ auditId: "1", actionKey: "onboarding.artifact_confirmed" });
    await expect(repository.acknowledgeContentScreen({
      tenantId: "tenant-synthetic",
      screenId: "screen-synthetic",
      actorId: "coach-synthetic",
    })).resolves.toEqual({ auditId: "2", actionKey: "onboarding.content_acknowledged" });
    await expect(repository.confirmContentScreen({
      tenantId: "tenant-synthetic",
      screenId: "screen-synthetic",
      actorId: "admin-synthetic",
    })).resolves.toEqual({ auditId: "3", actionKey: "onboarding.a2p_filing_confirmed" });
    expect(calls).toEqual([
      {
        name: "confirm_onboarding_artifact",
        args: {
          p_expected_tenant: "tenant-synthetic",
          p_artifact_id: "artifact-synthetic",
          p_actor_id: "coach-synthetic",
        },
      },
      {
        name: "acknowledge_onboarding_content_screen",
        args: {
          p_expected_tenant: "tenant-synthetic",
          p_screen_id: "screen-synthetic",
          p_actor_id: "coach-synthetic",
        },
      },
      {
        name: "confirm_onboarding_content_screen",
        args: {
          p_expected_tenant: "tenant-synthetic",
          p_screen_id: "screen-synthetic",
          p_actor_id: "admin-synthetic",
        },
      },
    ]);
  });

  it("makes the filing confirmation the writer the SMS day counter reads from", () => {
    const stamp = readFileSync(resolve(
      process.cwd(),
      "supabase/migrations/20260825000001_phase9_a2p_submitted_stamp.sql",
    ), "utf8");
    const projection = readFileSync(resolve(
      process.cwd(),
      "supabase/migrations/20260821000002_phase5_projection_gaps.sql",
    ), "utf8");

    // The writer and the reader have to agree on the same key on the same step, or the counter
    // renders with no source behind it — which is what shipped before this migration.
    expect(projection).toContain("campaign_row.external_ref ->> 'submittedAt'");
    expect(stamp).toContain("create or replace function public.confirm_onboarding_content_screen");
    expect(stamp).toContain("'submittedAt',");
    expect(stamp).toContain("and step.step_key = 'a2p_campaign'");

    // Idempotence is structural: the update only matches a step with no usable value yet, under
    // either key spelling the projection accepts, so a repeat confirmation cannot reset day 0.
    expect(stamp).toContain("nullif(btrim(coalesce(step.external_ref ->> 'submittedAt', '')), '')");
    expect(stamp).toContain("nullif(btrim(coalesce(step.external_ref ->> 'submitted_at', '')), '')");
    expect(stamp).toMatch(/\)\s*is null;/);

    // ISO8601 with the T the projection regex requires, and the audit trail is unchanged.
    expect(stamp).toContain(String.raw`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`);
    expect(stamp).toContain("'onboarding.content_admin_confirmed'");
    expect(stamp).toContain("'onboarding.a2p_filing_confirmed'");
    expect(stamp).toContain("set search_path = ''");
  });

  it("records hash-only probe evidence through the seven-argument replay-safe RPC", async () => {
    const { client, calls } = rpcClient();
    const repository = createOnboardingEvidenceRepository({ client });
    await expect(repository.recordA2pProbeReceipt({
      tenantId: "tenant-synthetic",
      probeKey: "tenant-synthetic:sms_live:2026-08-17",
      targetHash: "a".repeat(64),
      result: "delivered",
      providerReference: "provider-reference-synthetic",
      providerCode: "DELIVERED",
      observedAt: "2026-08-17T12:00:00.000Z",
    })).resolves.toEqual({ receiptId: "1" });
    expect(calls).toEqual([{
      name: "record_a2p_probe_receipt",
      args: {
        p_expected_tenant: "tenant-synthetic",
        p_probe_key: "tenant-synthetic:sms_live:2026-08-17",
        p_target_identifier_hash: "a".repeat(64),
        p_result: "delivered",
        p_provider_reference: "provider-reference-synthetic",
        p_provider_code: "DELIVERED",
        p_observed_at: "2026-08-17T12:00:00.000Z",
      },
    }]);
  });

  it("refuses a plaintext-like probe target before persistence", async () => {
    const { client, calls } = rpcClient();
    const repository = createOnboardingEvidenceRepository({ client });
    await expect(repository.recordA2pProbeReceipt({
      tenantId: "tenant-synthetic",
      probeKey: "probe-synthetic",
      targetHash: "plaintext-target-is-forbidden",
      result: "inconclusive",
      providerReference: null,
      providerCode: null,
      observedAt: "2026-08-17T12:00:00.000Z",
    })).rejects.toThrow("A2P_PROBE_TARGET_HASH_INVALID");
    expect(calls).toEqual([]);
  });
});
