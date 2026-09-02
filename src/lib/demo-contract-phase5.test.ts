import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { renderOptInArtifact, assertArtifactReadyForRealFiling } from "@/lib/onboarding/artifacts";
import { resolveStepExecutor } from "@/lib/onboarding/runner";
import type { StepAttempt } from "@/lib/onboarding/contracts";

const ROOT = process.cwd();
const SEED = readFileSync(join(ROOT, "scripts/seed-phase5-demo.mjs"), "utf8");
const RESET = readFileSync(join(ROOT, "scripts/reset-phase5-demo.mjs"), "utf8");
const CONTRACT = readFileSync(join(ROOT, "scripts/phase5-demo-contract.mjs"), "utf8");

const ATTEMPT: StepAttempt = {
  tenantId: "85000000-0000-4000-8000-000000000099",
  stepKey: "ghl_location",
  attemptId: "85000000-0000-4000-8000-000000000098",
  idempotencyKey: "85000000-0000-4000-8000-000000000099:ghl_location",
  isDemo: true,
};

describe("Phase 5 demo fixture contract", () => {
  it("forces mockArm before a real driver selector can run", async () => {
    const mockArm = vi.fn(async () => ({
      kind: "done" as const,
      externalRef: { arm: "mock", demoOnly: true },
    }));
    const realArm = vi.fn(async () => ({ kind: "done" as const }));
    const driverSelection = vi.fn(() => realArm);
    const prior = process.env.SETTERFI_GHL_PROVISIONING_DRIVER;
    process.env.SETTERFI_GHL_PROVISIONING_DRIVER = "real";
    try {
      const outcome = await resolveStepExecutor(ATTEMPT, { mockArm, driverSelection })(ATTEMPT);
      expect(outcome).toMatchObject({ kind: "done", externalRef: { arm: "mock", demoOnly: true } });
    } finally {
      if (prior === undefined) delete process.env.SETTERFI_GHL_PROVISIONING_DRIVER;
      else process.env.SETTERFI_GHL_PROVISIONING_DRIVER = prior;
    }
    expect(mockArm).toHaveBeenCalledOnce();
    expect(driverSelection).not.toHaveBeenCalled();
    expect(realArm).not.toHaveBeenCalled();
  });

  it("keeps the confirmed demo artifact unusable for a real filing", () => {
    const artifact = renderOptInArtifact({
      templateVersion: "SETTERFI_DEMO_PLACEHOLDER_PHASE5_TEMPLATE_V1",
      approvalReference: "SETTERFI_DEMO_PLACEHOLDER_PHASE5_APPROVAL",
      marketingLanguage: "SETTERFI_DEMO_PLACEHOLDER_ {{business_name}} marketing",
      nonMarketingLanguage: "SETTERFI_DEMO_PLACEHOLDER_ {{business_name}} service",
      campaignDescription: "SETTERFI_DEMO_PLACEHOLDER_ {{business_name}} campaign",
      termsUrl: "https://example.invalid/terms",
      privacyUrl: "https://example.invalid/privacy",
      placeholder: true,
    }, {
      businessName: "Synthetic Demo Business",
      websiteUrl: "https://example.invalid",
    });
    expect(artifact.placeholder).toBe(true);
    expect(() => assertArtifactReadyForRealFiling(artifact)).toThrowError("A2P_COPY_NOT_APPROVED");
  });

  it("uses exact demo ancestry, replay-safe writes, exact reset ids, and synthetic markers", () => {
    expect(SEED).toContain("PHASE5_DEMO_TENANT_ANCESTRY_REFUSED");
    expect(SEED).toContain("on conflict (tenant_id, step_key) do update");
    expect(SEED).toContain("on conflict (id) do update");
    expect(SEED).toContain("provider_proof=mock-only");
    expect(SEED).toContain("SETTERFI_DEMO_PLACEHOLDER_");
    expect(SEED).not.toMatch(/\+1\d{10}/);
    expect(RESET).toContain("PHASE5_RESET_REFUSED_NOT_KNOWN_DEMO");
    expect(RESET).toContain("PHASE5_DEMO_IDS.failedIntent");
    expect(RESET).toContain("PHASE5_DEMO_VALUES.probeKeys");
    expect(CONTRACT).toContain("snapshot.steps.length === 17");
    expect(CONTRACT).toContain("snapshot.steps.length === 8");
    expect(CONTRACT).toContain("PHASE5_CONTRACT_PROVIDER_PROOF_NOT_MOCK");
  });
});
