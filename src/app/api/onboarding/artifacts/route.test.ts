import { describe, expect, it, vi } from "vitest";

import type { RouteActor } from "@/app/api/conversations/[id]/claim/handler";

import { createArtifactHandlers, type ArtifactView } from "./handler";

const actor: RouteActor = {
  userId: "coach-1",
  tenantId: "tenant-from-claims",
  role: "coach",
  impersonatingTenant: null,
  impersonationSessionId: null,
};
const artifact: ArtifactView = {
  artifactId: "artifact-1",
  version: 1,
  templateVersion: "approved-v1",
  controls: [
    { key: "marketing", checked: false, required: false, renderedLanguage: "Synthetic marketing disclosure.", renderedLanguageHash: "a".repeat(64) },
    { key: "non_marketing", checked: false, required: false, renderedLanguage: "Synthetic service disclosure.", renderedLanguageHash: "b".repeat(64) },
  ],
  termsUrl: "https://synthetic.test/terms",
  privacyUrl: "https://synthetic.test/privacy",
  campaignDescriptionHash: "c".repeat(64),
  placeholder: false,
  confirmedAt: null,
  campaignContent: null,
};

function dependencies() {
  return {
    enabled: () => true,
    session: vi.fn().mockResolvedValue(actor),
    load: vi.fn().mockResolvedValue(artifact),
    confirm: vi.fn().mockResolvedValue({ auditId: "41", actionKey: "onboarding.artifact_confirmed" as const }),
    approveCampaignContent: vi.fn().mockResolvedValue({
      contentId: "campaign-content-1",
      version: 1,
      approvedAt: "2026-08-30T12:00:00.000Z",
      auditId: "42",
      actionKey: "onboarding.campaign_content_approved" as const,
    }),
  };
}

describe("onboarding artifact routes", () => {
  it("loads only the tenant from verified claims", async () => {
    const deps = dependencies();
    const response = await createArtifactHandlers(deps).GET();
    expect(response.status).toBe(200);
    expect(deps.load).toHaveBeenCalledWith("tenant-from-claims");
    await expect(response.json()).resolves.toEqual({ artifact });
  });

  it.each([
    [null, 401],
    [{ ...actor, impersonatingTenant: "tenant-other" }, 403],
  ])("refuses an invalid actor before reads", async (candidate, status) => {
    const deps = dependencies();
    deps.session.mockResolvedValue(candidate);
    const response = await createArtifactHandlers(deps).GET();
    expect(response.status).toBe(status);
    expect(deps.load).not.toHaveBeenCalled();
  });

  it("confirms through the repository and renders Logged only from its receipt", async () => {
    const deps = dependencies();
    const response = await createArtifactHandlers(deps).POST(new Request("https://setterfi.test/api/onboarding/artifacts", {
      method: "POST",
      body: JSON.stringify({ artifactId: "artifact-1" }),
    }));
    expect(deps.confirm).toHaveBeenCalledWith({ tenantId: actor.tenantId, artifactId: "artifact-1", actorId: actor.userId });
    await expect(response.json()).resolves.toMatchObject({ receipt: { auditId: "41" } });
  });

  it("records client-supplied sample messages through the approval RPC", async () => {
    const deps = dependencies();
    const response = await createArtifactHandlers(deps).POST(new Request("https://setterfi.test/api/onboarding/artifacts", {
      method: "POST",
      body: JSON.stringify({ sampleMessages: ["Client-approved campaign example."] }),
    }));
    expect(deps.approveCampaignContent).toHaveBeenCalledWith({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      sampleMessages: ["Client-approved campaign example."],
    });
    await expect(response.json()).resolves.toMatchObject({
      campaignContentId: "campaign-content-1",
      receipt: { auditId: "42", version: 1 },
    });
  });

  it("refuses coach-member mutation and an absent audit receipt", async () => {
    const deps = dependencies();
    deps.session.mockResolvedValueOnce({ ...actor, role: "coach_member" });
    expect((await createArtifactHandlers(deps).POST(new Request("https://setterfi.test", { method: "POST", body: "{}" }))).status).toBe(403);
    deps.confirm.mockResolvedValue({ auditId: "", actionKey: "onboarding.artifact_confirmed" });
    const response = await createArtifactHandlers(deps).POST(new Request("https://setterfi.test", { method: "POST", body: JSON.stringify({ artifactId: "artifact-1" }) }));
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toMatch(/sql|provider|audit_required/i);
  });

  it("refuses empty or invented campaign-content payload shapes before the approval RPC", async () => {
    const deps = dependencies();
    const response = await createArtifactHandlers(deps).POST(new Request("https://setterfi.test", {
      method: "POST",
      body: JSON.stringify({ sampleMessages: ["  "] }),
    }));
    expect(response.status).toBe(409);
    expect(deps.approveCampaignContent).not.toHaveBeenCalled();
  });
});
