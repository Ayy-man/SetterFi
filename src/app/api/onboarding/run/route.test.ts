import { describe, expect, it, vi } from "vitest";

import { accessToken } from "@/lib/access";

import { approvedCampaignInput, createProvisioningRunHandler } from "./handler";

const summary = { tenants: 2, succeeded: 1, failed: 1, steps: 4, committed: 3, stale: 1, missingExecutors: 0 };
function request(method: "GET" | "POST" = "POST", token = "synthetic-cron-secret") {
  return new Request("https://setterfi.test/api/onboarding/run", { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
}

describe("/api/onboarding/run", () => {
  it("uses only a current, explicitly approved campaign-content version for filing", () => {
    const artifact = {
      id: "artifact-1", version: 2, artifact_hash: "a".repeat(64),
      marketing_language_hash: "b".repeat(64), non_marketing_language_hash: "c".repeat(64),
      terms_url: "https://synthetic.test/terms", privacy_url: "https://synthetic.test/privacy",
      campaign_description_hash: "d".repeat(64), placeholder: false, confirmed_at: "2026-08-30T12:00:00.000Z",
    } as const;
    const screen = {
      id: "screen-1", input_hash: "e".repeat(64), result: "clean" as const,
      acknowledged_at: null, admin_confirmed_at: null,
    };
    const content = {
      artifact_id: artifact.id, artifact_version: artifact.version, artifact_hash: artifact.artifact_hash,
      marketing_language_hash: artifact.marketing_language_hash,
      non_marketing_language_hash: artifact.non_marketing_language_hash,
      terms_url: artifact.terms_url, privacy_url: artifact.privacy_url,
      campaign_description_hash: artifact.campaign_description_hash,
      content_screen_id: screen.id, content_screen_input_hash: screen.input_hash,
      sample_messages_hash: "f".repeat(64), approved_at: "2026-08-30T12:01:00.000Z", approved_by: "coach-1",
    };
    expect(approvedCampaignInput({ artifact, screen, content, isDemo: false })).toEqual({
      artifactId: "artifact-1", contentScreenId: "screen-1",
      campaignDescriptionHash: "d".repeat(64), sampleMessagesHash: "f".repeat(64),
    });
  });

  it("keeps campaign filing fail-closed when approval is absent, stale, or only a demo placeholder", () => {
    const artifact = {
      id: "artifact-1", version: 1, artifact_hash: "a".repeat(64),
      marketing_language_hash: "b".repeat(64), non_marketing_language_hash: "c".repeat(64),
      terms_url: "https://synthetic.test/terms", privacy_url: "https://synthetic.test/privacy",
      campaign_description_hash: "d".repeat(64), placeholder: true, confirmed_at: "2026-08-30T12:00:00.000Z",
    } as const;
    const screen = { id: "screen-1", input_hash: "e".repeat(64), result: "clean" as const, acknowledged_at: null, admin_confirmed_at: null };
    expect(approvedCampaignInput({ artifact, screen, content: null, isDemo: false })).toBeNull();
    expect(approvedCampaignInput({
      artifact,
      screen,
      isDemo: false,
      content: {
        artifact_id: artifact.id, artifact_version: artifact.version, artifact_hash: artifact.artifact_hash,
        marketing_language_hash: artifact.marketing_language_hash, non_marketing_language_hash: artifact.non_marketing_language_hash,
        terms_url: artifact.terms_url, privacy_url: artifact.privacy_url, campaign_description_hash: artifact.campaign_description_hash,
        content_screen_id: screen.id, content_screen_input_hash: screen.input_hash,
        sample_messages_hash: "f".repeat(64), approved_at: "2026-08-30T12:01:00.000Z", approved_by: "coach-1",
      },
    })).toBeNull();
  });

  it("does no work when Phase 5 is disabled", async () => {
    const run = vi.fn();
    const response = await createProvisioningRunHandler({ enabled: () => false, secret: "synthetic-cron-secret", run })(request());
    expect(response.status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", null, "synthetic-cron-secret"],
    ["GET", "synthetic-cron-secret", "wrong"],
    ["GET", "synthetic-cron-secret", ""],
    ["POST", null, "synthetic-cron-secret"],
    ["POST", "synthetic-cron-secret", "wrong"],
    ["POST", "synthetic-cron-secret", ""],
  ] as const)("fails closed before query for %s secret %s and token %s", async (method, secret, token) => {
    const run = vi.fn();
    const response = await createProvisioningRunHandler({ enabled: () => true, secret, run })(request(method, token));
    expect(response.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["GET", "POST"] as const)("lets authenticated %s run one bounded cycle and return only aggregate results", async (method) => {
    const run = vi.fn().mockResolvedValue(summary);
    const response = await createProvisioningRunHandler({ enabled: () => true, secret: "synthetic-cron-secret", run })(request(method));
    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledWith(25);
    await expect(response.json()).resolves.toEqual(summary);
    expect(JSON.stringify(summary)).not.toMatch(/tenant-|phone|provider/i);
  });

  it("writes a scheduled receipt without letting a manual run stand in for cron health", async () => {
    const run = vi.fn().mockResolvedValue(summary);
    const execute = vi.fn(async (jobKey, work) => {
      expect(jobKey).toBe("provisioning-run");
      return work();
    });
    const handler = createProvisioningRunHandler({
      enabled: () => true,
      secret: "synthetic-cron-secret",
      execute: execute as never,
      run,
    });

    expect((await handler(request("GET"))).status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await handler(request("POST"))).status).toBe(200);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("returns named missing Phase 4 seams without provider details", async () => {
    const run = vi.fn().mockRejectedValue(new Error("PHASE4_META_CONNECT_SEAM_MISSING"));
    const response = await createProvisioningRunHandler({ enabled: () => true, secret: "synthetic-cron-secret", run })(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "PHASE4_META_CONNECT_SEAM_MISSING" });
  });

  it("uses the same digest path as the existing cron convention", async () => {
    await expect(accessToken("synthetic-cron-secret")).resolves.toMatch(/^[0-9a-f]{64}$/);
  });
});
