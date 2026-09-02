import { describe, expect, it, vi } from "vitest";

import { createHostedArtifactHandler } from "./handler";

const artifact = {
  artifactId: "artifact-1",
  version: 1,
  templateVersion: "approved-v1",
  tenantSlug: "synthetic-coach",
  businessName: "Synthetic Coach",
  isDemo: false,
  marketingLanguage: "Marketing disclosure",
  marketingLanguageHash: "a".repeat(64),
  nonMarketingLanguage: "Non-marketing disclosure",
  nonMarketingLanguageHash: "b".repeat(64),
  termsBody: "Persisted terms",
  termsBodyHash: "c".repeat(64),
  privacyBody: "Persisted privacy",
  privacyBodyHash: "d".repeat(64),
  termsUrl: "https://example.test/terms",
  privacyUrl: "https://example.test/privacy",
  // `.test` is RFC 2606 reserved, so this fixture's own URL is unreachable -- which is the
  // honest value here, not an inconvenience to paper over.
  privacyUrlReachable: false,
  campaignDescriptionHash: "e".repeat(64),
  artifactHash: "f".repeat(64),
  placeholder: false,
  confirmedAt: "2026-08-18T00:00:00.000Z",
};

function request(page = "consent") {
  return new Request(`https://setterfi.test/api/opt-in/synthetic-coach/artifact?page=${page}`);
}

function context(slug = "synthetic-coach") {
  return { params: Promise.resolve({ tenantSlug: slug }) };
}

describe("GET /api/opt-in/[tenantSlug]/artifact", () => {
  it("returns the confirmed page envelope without lead or economic data", async () => {
    const load = vi.fn().mockResolvedValue(artifact);
    const response = await createHostedArtifactHandler({ enabled: () => true, load })(
      request("terms"),
      context(),
    );
    expect(response.status).toBe(200);
    expect(load).toHaveBeenCalledWith("synthetic-coach", "terms");
    const payload = await response.json();
    expect(payload.artifact).toMatchObject({
      businessName: "Synthetic Coach",
      termsBody: "Persisted terms",
      termsBodyHash: "c".repeat(64),
    });
    expect(JSON.stringify(payload)).not.toMatch(/price_cents|lead|contact_identity/i);
  });

  it("preserves an honest unavailable state for unknown or non-live slugs", async () => {
    const response = await createHostedArtifactHandler({
      enabled: () => true,
      load: async () => null,
    })(request(), context("unknown"));
    await expect(response.json()).resolves.toEqual({ artifact: null });
  });

  it("returns no artifact for an invalid page before querying", async () => {
    const load = vi.fn().mockResolvedValue(artifact);
    const response = await createHostedArtifactHandler({ enabled: () => true, load })(
      request("draft"),
      context(),
    );
    await expect(response.json()).resolves.toEqual({ artifact: null });
    expect(load).not.toHaveBeenCalled();
  });

  it("preserves demo placeholder classification in the envelope", async () => {
    const response = await createHostedArtifactHandler({
      enabled: () => true,
      load: async () => ({ ...artifact, isDemo: true, placeholder: true }),
    })(request(), context());
    await expect(response.json()).resolves.toMatchObject({
      artifact: { isDemo: true, placeholder: true },
    });
  });
});
