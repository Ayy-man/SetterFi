import { describe, expect, it } from "vitest";
import { phaseProviderReadiness } from "./phase-provider-readiness";

describe("phase/provider consistency", () => {
  it("inventories all nine independent phases without activating them", () => {
    const env = { SETTERFI_META_DRIVER: "real", META_APP_ID: "staged-secret" };
    const before = { ...env };
    const result = phaseProviderReadiness(env);
    expect(result.map((row) => row.phase)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(result.every((row) => !row.enabled && !row.issues.length)).toBe(true);
    expect(env).toEqual(before);
    expect(JSON.stringify(result)).not.toContain("staged-secret");
  });

  it("reports every missing provisioning setting, not only the first selector failure", () => {
    const phase = phaseProviderReadiness({ SETTERFI_PHASE5_LIVE: "true", GHL_AGENCY_COMPANY_ID: "private" })[4];
    expect(phase.issues).toEqual([{
      label: "Automatic workspace provisioning", reason: "not_selected",
      missingNames: ["SETTERFI_GHL_PROVISIONING_DRIVER", "GHL_SNAPSHOT_ID", "GHL_NUMBER_POOL_ID"],
    }]);
  });

  it.each(["mock", "unexpected", "real"])("keeps enabled Meta honest with selection %s", (selection) => {
    const phase = phaseProviderReadiness({ SETTERFI_PHASE4_LIVE: "true", SETTERFI_META_DRIVER: selection })[3];
    expect(phase.enabled).toBe(true);
    expect(phase.issues[0].reason).toBe(selection === "real" ? "missing_configuration" : selection === "mock" ? "mock" : "invalid");
    expect(phase.issues[0].missingNames).toContain("META_APP_SECRET");
  });

  it("does not call Stripe live just because credentials are staged", () => {
    const phase = phaseProviderReadiness({
      SETTERFI_PHASE6_LIVE: "true", SETTERFI_PHASE6_STRIPE_LIVE: "true",
      STRIPE_SECRET_KEY: "staged-secret", STRIPE_WEBHOOK_SECRET: "staged-webhook",
    })[5];
    expect(phase.issues[0].missingNames).toEqual(["SETTERFI_STRIPE_DRIVER"]);
    expect(JSON.stringify(phase)).not.toContain("staged-secret");
  });

  it("does not demand a provider for a child capability that is switched off", () => {
    expect(phaseProviderReadiness({ SETTERFI_PHASE6_LIVE: "true" })[5].issues).toEqual([]);
    expect(phaseProviderReadiness({ SETTERFI_PHASE8_LIVE: "true" })[7].issues).toEqual([]);
  });

  it("accepts explicitly configured offline Notion without promising live provider delivery", () => {
    const env = { SETTERFI_PHASE2_LIVE: "true", SETTERFI_NOTION_DRIVER: "offline",
      NOTION_EXPORT_PATH: "/private/export", SETTERFI_EMBEDDINGS_DRIVER: "real", OPENROUTER_API_KEY: "private" };
    expect(phaseProviderReadiness(env)[1].issues).toEqual([]);
    expect(phaseProviderReadiness({ ...env, NOTION_EXPORT_PATH: "" })[1].issues[0].missingNames).toEqual(["NOTION_EXPORT_PATH"]);
  });

  it("checks email and evaluation providers independently under phase 8", () => {
    const phase = phaseProviderReadiness({ SETTERFI_PHASE8_LIVE: "true", SETTERFI_PHASE8_ALERTS_LIVE: "true", SETTERFI_PHASE8_ENGINE_EVAL_LIVE: "true" })[7];
    expect(phase.issues).toHaveLength(2);
  });
});
