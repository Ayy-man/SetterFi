import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DriverConfigurationError,
  ENV_CONTRACT_NAMES,
  appointmentLifecycleLive,
  accountSecurityLive,
  accountMfaLive,
  accountEmailChangeLive,
  offerLayerEngineInputLive,
  bookingConfirmLive,
  capiLive,
  brainObjectionsLive,
  contactDeleteLive,
  contactManagementLive,
  demoLoginsEnabled,
  googleCalendarOAuthLive,
  driverSelection,
  inboxVerbsLive,
  phase1Live,
  phase2Live,
  platformConversationQueueLive,
  phase3Live,
  phase4Live,
  phase5Live,
  signupRepairLive,
  phase6AffiliatesLive,
  phase6Live,
  phase6StripeLive,
  phase7AnalyticsLive,
  phase7EvalsLive,
  phase7Live,
  phase7MeetAgentLive,
  platformPreviewDataEnabled,
  phase8AlertRuleEventsLive,
  phase8AlertsLive,
  phase8EngineEvalLive,
  phase8ExportsLive,
  phase8Live,
  phase8SupportLive,
  phase9GhlOAuthLive,
  phase9Live,
  pipelineWriteLive,
  realArmSkipReason,
  requireEnvironment,
  suppressionSyncLive,
  tenantMembershipLive,
  tenantOwnershipLive,
  accountTermsLive,
  tierOfferTermsLive,
  whatsappEmbeddedSignupEnabled,
} from "./env-contract";

describe("environment contract", () => {
  it("keeps Meta conversion delivery mock unless its flag is exactly true", () => {
    expect(capiLive({})).toBe(false);
    expect(capiLive({ SETTERFI_CAPI_LIVE: "TRUE" })).toBe(false);
    expect(capiLive({ SETTERFI_CAPI_LIVE: " true " })).toBe(true);
  });

  it("keeps the Google Calendar routes at 404 unless the flag is exactly true", () => {
    expect(googleCalendarOAuthLive({})).toBe(false);
    expect(googleCalendarOAuthLive({ SETTERFI_GOOGLE_CALENDAR_OAUTH_LIVE: "" })).toBe(false);
    expect(googleCalendarOAuthLive({ SETTERFI_GOOGLE_CALENDAR_OAUTH_LIVE: "1" })).toBe(false);
    expect(googleCalendarOAuthLive({ SETTERFI_GOOGLE_CALENDAR_OAUTH_LIVE: "TRUE" })).toBe(false);
    expect(googleCalendarOAuthLive({ SETTERFI_GOOGLE_CALENDAR_OAUTH_LIVE: " true " })).toBe(true);
  });

  it("keeps the Google connect names together and after the flag they belong to", () => {
    const start = ENV_CONTRACT_NAMES.indexOf("SETTERFI_GOOGLE_CALENDAR_OAUTH_LIVE");
    expect(start).toBeGreaterThan(-1);
    expect(ENV_CONTRACT_NAMES.slice(start, start + 3)).toEqual([
      "SETTERFI_GOOGLE_CALENDAR_OAUTH_LIVE",
      "GOOGLE_CALENDAR_CLIENT_ID",
      "GOOGLE_CALENDAR_CLIENT_SECRET",
    ]);
  });

  it("keeps every configured name exactly once and every example value blank", () => {
    const example = readFileSync(resolve(process.cwd(), ".env.example"), "utf8");
    const assignments = example
      .split("\n")
      .filter((line) => /^[A-Z0-9_]+=/.test(line))
      .map((line) => line.split("=", 2));

    expect(assignments.map(([name]) => name).sort()).toEqual([...ENV_CONTRACT_NAMES].sort());
    expect(new Set(assignments.map(([name]) => name)).size).toBe(assignments.length);
    expect(assignments.every(([, value]) => value === "")).toBe(true);
  });

  it("keeps the demo-login flag next to the auth mode it only means anything under", () => {
    const authMode = ENV_CONTRACT_NAMES.indexOf("SETTERFI_AUTH_MODE");
    expect(ENV_CONTRACT_NAMES[authMode + 1]).toBe("SETTERFI_DEMO_LOGINS");
  });

  it("keeps the demo logins off unless the flag is exactly true", () => {
    expect(demoLoginsEnabled({})).toBe(false);
    expect(demoLoginsEnabled({ SETTERFI_DEMO_LOGINS: "" })).toBe(false);
    expect(demoLoginsEnabled({ SETTERFI_DEMO_LOGINS: "TRUE" })).toBe(false);
    expect(demoLoginsEnabled({ SETTERFI_DEMO_LOGINS: "1" })).toBe(false);
    expect(demoLoginsEnabled({ SETTERFI_DEMO_LOGINS: " true " })).toBe(true);
  });

  // Feature flags read straight off process.env skip the trimming, the parent nesting and the
  // name inventory this module exists to enforce, which is exactly how the contact-management and
  // checkout-attempt gates each drifted from their parents. Shipping code asks this module.
  it("keeps every capability flag behind this contract instead of a raw environment read", () => {
    const files = execFileSync("git", ["ls-files", "src", "scripts"], { encoding: "utf8" })
      .split("\n")
      .filter((name) => /\.(ts|tsx|mjs)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name))
      .filter((name) => name !== "src/lib/env-contract.ts");
    const offenders = files.filter((name) => (
      /process\.env\.SETTERFI_[A-Z0-9_]*_LIVE\b/.test(readFileSync(resolve(process.cwd(), name), "utf8"))
    ));
    expect(offenders).toEqual([]);
  });

  // Phase 6
  it("keeps the ordered Phase 6 inventory before every Phase 7 name", () => {
    const start = ENV_CONTRACT_NAMES.indexOf("SETTERFI_PHASE6_LIVE");
    expect(ENV_CONTRACT_NAMES.slice(start, start + 9)).toEqual([
      "SETTERFI_PHASE6_LIVE",
      "SETTERFI_PHASE6_AFFILIATES_LIVE",
      "SETTERFI_PHASE6_STRIPE_LIVE",
      "SETTERFI_CHECKOUT_ATTEMPTS_LIVE",
      "SETTERFI_STRIPE_DRIVER",
      "SETTERFI_DEMO_PLACEHOLDER_TIER_PRICES",
      "SETTERFI_DEMO_PLACEHOLDER_ALLOWANCE_NOTICE",
      "SETTERFI_DEMO_PLACEHOLDER_DISPUTE_PATH",
      "SETTERFI_DEMO_PLACEHOLDER_AFFILIATE_TERMS",
    ]);
  });

  it("requires the Phase 6 parent before either child feature can become live", () => {
    const childrenOnly = {
      SETTERFI_PHASE6_AFFILIATES_LIVE: "true",
      SETTERFI_PHASE6_STRIPE_LIVE: "true",
    };
    expect(phase6Live(childrenOnly)).toBe(false);
    expect(phase6AffiliatesLive(childrenOnly)).toBe(false);
    expect(phase6StripeLive(childrenOnly)).toBe(false);

    expect(phase6AffiliatesLive({
      ...childrenOnly,
      SETTERFI_PHASE6_LIVE: "true",
    })).toBe(true);
    expect(phase6StripeLive({
      ...childrenOnly,
      SETTERFI_PHASE6_LIVE: "true",
    })).toBe(true);
  });

  it("never treats demo placeholder content as a Phase 6 rollout gate", () => {
    const placeholdersOnly = {
      SETTERFI_DEMO_PLACEHOLDER_TIER_PRICES: "synthetic-tier-copy",
      SETTERFI_DEMO_PLACEHOLDER_ALLOWANCE_NOTICE: "synthetic-notice",
      SETTERFI_DEMO_PLACEHOLDER_DISPUTE_PATH: "synthetic-path",
      SETTERFI_DEMO_PLACEHOLDER_AFFILIATE_TERMS: "synthetic-terms",
    };
    expect(phase6Live(placeholdersOnly)).toBe(false);
    expect(phase6AffiliatesLive(placeholdersOnly)).toBe(false);
    expect(phase6StripeLive(placeholdersOnly)).toBe(false);
  });

  it("reports a skipped Stripe real arm with both required names", () => {
    const report = execFileSync(
      process.execPath,
      [resolve(process.cwd(), "scripts/verify-env-contract.mjs")],
      {
        encoding: "utf8",
        env: {
          NODE_ENV: "test",
          SETTERFI_STRIPE_DRIVER: "real",
          STRIPE_SECRET_KEY: "",
          STRIPE_WEBHOOK_SECRET: "",
        },
      },
    );
    expect(report).toContain(
      "SETTERFI_STRIPE_DRIVER: SKIPPED (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET missing)",
    );
  });

  // Phase 7
  it("keeps the Phase 7 inventory ordered and contiguous after every earlier phase name", () => {
    // Anchored by index, not by a negative slice: every appended phase shifted the old
    // tail offsets and made this assert a different block than its name claims.
    const start = ENV_CONTRACT_NAMES.indexOf("SETTERFI_PHASE7_LIVE");
    expect(start).toBeGreaterThan(-1);
    expect(ENV_CONTRACT_NAMES.slice(start, start + 5)).toEqual([
      "SETTERFI_PHASE7_LIVE",
      "SETTERFI_PHASE7_ANALYTICS_LIVE",
      "SETTERFI_PHASE7_EVALS_LIVE",
      "SETTERFI_PHASE7_MEET_AGENT_LIVE",
      "SETTERFI_PLATFORM_PREVIEW_DATA",
    ]);
  });

  it("requires the exact Phase 7 parent and child flags before behavior becomes live", () => {
    const childrenOnly = {
      SETTERFI_PHASE7_ANALYTICS_LIVE: "true",
      SETTERFI_PHASE7_EVALS_LIVE: "true",
      SETTERFI_PHASE7_MEET_AGENT_LIVE: "true",
    };
    expect(phase7Live({})).toBe(false);
    expect(phase7Live({ SETTERFI_PHASE7_LIVE: "TRUE" })).toBe(false);
    expect(phase7AnalyticsLive(childrenOnly)).toBe(false);
    expect(phase7EvalsLive(childrenOnly)).toBe(false);
    expect(phase7MeetAgentLive(childrenOnly)).toBe(false);

    const enabled = { ...childrenOnly, SETTERFI_PHASE7_LIVE: " true " };
    expect(phase7Live(enabled)).toBe(true);
    expect(phase7AnalyticsLive(enabled)).toBe(true);
    expect(phase7EvalsLive(enabled)).toBe(true);
    expect(phase7MeetAgentLive(enabled)).toBe(true);
    expect(phase7AnalyticsLive({
      SETTERFI_PHASE7_LIVE: "true",
      SETTERFI_PHASE7_ANALYTICS_LIVE: "TRUE",
    })).toBe(false);
  });

  it("permits synthetic platform data only on the non-production analytics-enabled demo-login review build", () => {
    const enabled = {
      SETTERFI_PHASE7_LIVE: "true",
      SETTERFI_PHASE7_ANALYTICS_LIVE: "true",
      SETTERFI_DEMO_LOGINS: "true",
      SETTERFI_PLATFORM_PREVIEW_DATA: "true",
    };
    expect(platformPreviewDataEnabled(enabled)).toBe(true);
    expect(platformPreviewDataEnabled({ ...enabled, SETTERFI_DEMO_LOGINS: "" })).toBe(false);
    expect(platformPreviewDataEnabled({ ...enabled, SETTERFI_PHASE7_ANALYTICS_LIVE: "" })).toBe(false);
    expect(platformPreviewDataEnabled({ ...enabled, SETTERFI_PLATFORM_PREVIEW_DATA: "TRUE" })).toBe(false);
    expect(platformPreviewDataEnabled({ ...enabled, NODE_ENV: "production" })).toBe(false);
    expect(platformPreviewDataEnabled({ ...enabled, VERCEL_ENV: "production" })).toBe(false);
  });

  // Phase 8
  it("keeps the Phase 8 names-only block ordered and contiguous after Phase 7", () => {
    const start = ENV_CONTRACT_NAMES.indexOf("SETTERFI_PHASE8_LIVE");
    expect(start).toBeGreaterThan(-1);
    expect(ENV_CONTRACT_NAMES.slice(start, start + 12)).toEqual([
      "SETTERFI_PHASE8_LIVE",
      "SETTERFI_PHASE8_ALERTS_LIVE",
      "SETTERFI_PHASE8_ALERT_RULE_EVENTS_LIVE",
      "SETTERFI_PHASE8_SUPPORT_LIVE",
      "SETTERFI_PHASE8_EXPORTS_LIVE",
      "SETTERFI_PHASE8_ENGINE_EVAL_LIVE",
      "SETTERFI_EMAIL_DRIVER",
      "RESEND_API_KEY",
      "RESEND_WEBHOOK_SIGNING_SECRET",
      "SETTERFI_EMAIL_FROM",
      "SETTERFI_SLACK_DRIVER",
      "SLACK_WEBHOOK_URL",
    ]);
  });

  it("keeps every Phase 8 behavior off unless its parent and child are exactly true", () => {
    const children = {
      SETTERFI_PHASE8_ALERTS_LIVE: "true",
      SETTERFI_PHASE8_SUPPORT_LIVE: "true",
      SETTERFI_PHASE8_EXPORTS_LIVE: "true",
      SETTERFI_PHASE8_ENGINE_EVAL_LIVE: "true",
    };
    expect(phase8Live({})).toBe(false);
    expect(phase8AlertsLive(children)).toBe(false);
    expect(phase8SupportLive(children)).toBe(false);
    expect(phase8ExportsLive(children)).toBe(false);
    expect(phase8EngineEvalLive(children)).toBe(false);
    const enabled = { ...children, SETTERFI_PHASE8_LIVE: "true" };
    expect(phase8AlertsLive(enabled)).toBe(true);
    expect(phase8SupportLive(enabled)).toBe(true);
    expect(phase8ExportsLive(enabled)).toBe(true);
    expect(phase8EngineEvalLive(enabled)).toBe(true);
  });

  it("keeps newly connected alert-rule events off until the alert delivery and event arms are live", () => {
    const eventsOnly = { SETTERFI_PHASE8_ALERT_RULE_EVENTS_LIVE: "true" };
    expect(phase8AlertRuleEventsLive(eventsOnly)).toBe(false);
    expect(phase8AlertRuleEventsLive({
      ...eventsOnly,
      SETTERFI_PHASE8_LIVE: "true",
    })).toBe(false);
    expect(phase8AlertRuleEventsLive({
      ...eventsOnly,
      SETTERFI_PHASE8_LIVE: "true",
      SETTERFI_PHASE8_ALERTS_LIVE: "true",
    })).toBe(true);
  });

  it("requires explicit Phase 8 driver arms and reports named missing real configuration", () => {
    expect(() => driverSelection("email", "SETTERFI_EMAIL_DRIVER", {}))
      .toThrowError(DriverConfigurationError);
    expect(() => driverSelection("slack", "SETTERFI_SLACK_DRIVER", {}))
      .toThrowError(DriverConfigurationError);
    expect(realArmSkipReason(
      "email",
      "SETTERFI_EMAIL_DRIVER",
      ["RESEND_API_KEY", "SETTERFI_EMAIL_FROM"],
      { SETTERFI_EMAIL_DRIVER: "real" },
    )).toBe("RESEND_API_KEY is missing");
    expect(() => driverSelection("email", "SETTERFI_EMAIL_DRIVER", {
      SETTERFI_EMAIL_DRIVER: "synthetic-invalid",
    })).toThrowError(DriverConfigurationError);
  });

  it("reports credentialless Phase 8 real arms as named skips", () => {
    const report = execFileSync(
      process.execPath,
      [resolve(process.cwd(), "scripts/verify-env-contract.mjs")],
      {
        encoding: "utf8",
        env: {
          NODE_ENV: "test",
          SETTERFI_EMAIL_DRIVER: "real",
          SETTERFI_SLACK_DRIVER: "real",
        },
      },
    );
    expect(report).toContain(
      "SETTERFI_EMAIL_DRIVER: SKIPPED (RESEND_API_KEY, SETTERFI_EMAIL_FROM missing)",
    );
    expect(report).toContain("SETTERFI_SLACK_DRIVER: SKIPPED (SLACK_WEBHOOK_URL missing)");
  });

  it("leaves Phase 1 off unless the gate is exactly true", () => {
    expect(phase1Live({})).toBe(false);
    expect(phase1Live({ SETTERFI_PHASE1_LIVE: "TRUE" })).toBe(false);
    expect(phase1Live({ SETTERFI_PHASE1_LIVE: " true " })).toBe(true);
  });

  it("enables pipeline writes only when Phase 1 and the pipeline write flag are set", () => {
    expect(pipelineWriteLive({})).toBe(false);
    expect(pipelineWriteLive({ SETTERFI_PHASE1_LIVE: "true" })).toBe(false);
    expect(pipelineWriteLive({ SETTERFI_PIPELINE_WRITE_LIVE: "true" })).toBe(false);
    expect(pipelineWriteLive({
      SETTERFI_PHASE1_LIVE: "false",
      SETTERFI_PIPELINE_WRITE_LIVE: "true",
    })).toBe(false);
    expect(pipelineWriteLive({
      SETTERFI_PHASE1_LIVE: "true",
      SETTERFI_PIPELINE_WRITE_LIVE: "true",
    })).toBe(true);
  });

  it("keeps the cross-tenant human queue behind Phase 2 and its own gate", () => {
    expect(platformConversationQueueLive({
      SETTERFI_PLATFORM_CONVERSATION_QUEUE_LIVE: "true",
    })).toBe(false);
    expect(platformConversationQueueLive({ SETTERFI_PHASE2_LIVE: "true" })).toBe(false);
    expect(platformConversationQueueLive({
      SETTERFI_PHASE2_LIVE: "true",
      SETTERFI_PLATFORM_CONVERSATION_QUEUE_LIVE: " true ",
    })).toBe(true);
  });

  it("keeps the appointment lifecycle behind booking confirmation and its own gate", () => {
    expect(appointmentLifecycleLive({ SETTERFI_APPOINTMENT_LIFECYCLE_LIVE: "true" })).toBe(false);
    expect(appointmentLifecycleLive({
      SETTERFI_PHASE1_LIVE: "true",
      SETTERFI_BOOKING_CONFIRM_LIVE: "true",
    })).toBe(false);
    expect(appointmentLifecycleLive({
      SETTERFI_PHASE1_LIVE: "true",
      SETTERFI_BOOKING_CONFIRM_LIVE: "true",
      SETTERFI_APPOINTMENT_LIFECYCLE_LIVE: " true ",
    })).toBe(true);
  });

  it("enables booking confirmation only when Phase 1 and its flag are set", () => {
    expect(bookingConfirmLive({})).toBe(false);
    expect(bookingConfirmLive({ SETTERFI_PHASE1_LIVE: "true" })).toBe(false);
    expect(bookingConfirmLive({ SETTERFI_BOOKING_CONFIRM_LIVE: "true" })).toBe(false);
    expect(bookingConfirmLive({
      SETTERFI_PHASE1_LIVE: "false",
      SETTERFI_BOOKING_CONFIRM_LIVE: "true",
    })).toBe(false);
    expect(bookingConfirmLive({
      SETTERFI_PHASE1_LIVE: "true",
      SETTERFI_BOOKING_CONFIRM_LIVE: "true",
    })).toBe(true);
  });

  it("enables inbox verbs only when Phase 1 and the inbox verbs flag are set", () => {
    expect(inboxVerbsLive({})).toBe(false);
    expect(inboxVerbsLive({ SETTERFI_PHASE1_LIVE: "true" })).toBe(false);
    expect(inboxVerbsLive({ SETTERFI_INBOX_VERBS_LIVE: "true" })).toBe(false);
    expect(inboxVerbsLive({
      SETTERFI_PHASE1_LIVE: "false",
      SETTERFI_INBOX_VERBS_LIVE: "true",
    })).toBe(false);
    expect(inboxVerbsLive({
      SETTERFI_PHASE1_LIVE: "true",
      SETTERFI_INBOX_VERBS_LIVE: "true",
    })).toBe(true);
  });

  it("leaves Phase 2 off unless the gate is exactly true", () => {
    expect(phase2Live({})).toBe(false);
    expect(phase2Live({ SETTERFI_PHASE2_LIVE: "TRUE" })).toBe(false);
    expect(phase2Live({ SETTERFI_PHASE2_LIVE: " true " })).toBe(true);
  });

  it("leaves teammate membership off unless its dedicated gate is exactly true", () => {
    expect(tenantMembershipLive({})).toBe(false);
    expect(tenantMembershipLive({ SETTERFI_TENANT_MEMBERSHIP_LIVE: "TRUE" })).toBe(false);
    expect(tenantMembershipLive({ SETTERFI_TENANT_MEMBERSHIP_LIVE: " true " })).toBe(true);
  });

  it("keeps the second factor behind the account-security gate as well as its own", () => {
    expect(accountMfaLive({ SETTERFI_ACCOUNT_MFA_LIVE: "true" })).toBe(false);
    expect(accountMfaLive({
      SETTERFI_ACCOUNT_SECURITY_LIVE: "true",
      SETTERFI_ACCOUNT_MFA_LIVE: "TRUE",
    })).toBe(false);
    expect(accountMfaLive({
      SETTERFI_ACCOUNT_SECURITY_LIVE: "true",
      SETTERFI_ACCOUNT_MFA_LIVE: " true ",
    })).toBe(true);
  });

  it("leaves the repaired offer-layer read off unless its gate is exactly true", () => {
    expect(offerLayerEngineInputLive({})).toBe(false);
    expect(offerLayerEngineInputLive({ SETTERFI_OFFER_LAYER_ENGINE_INPUT_LIVE: "TRUE" })).toBe(false);
    expect(offerLayerEngineInputLive({ SETTERFI_OFFER_LAYER_ENGINE_INPUT_LIVE: " true " })).toBe(true);
  });

  it("keeps email change off even when the rest of account security is on", () => {
    expect(accountEmailChangeLive({ SETTERFI_ACCOUNT_SECURITY_LIVE: "true" })).toBe(false);
    expect(accountEmailChangeLive({ SETTERFI_ACCOUNT_EMAIL_CHANGE_LIVE: "true" })).toBe(false);
    expect(accountEmailChangeLive({
      SETTERFI_ACCOUNT_SECURITY_LIVE: "true",
      SETTERFI_ACCOUNT_EMAIL_CHANGE_LIVE: " true ",
    })).toBe(true);
  });

  it("keeps ownership transfer behind membership as well as its own gate", () => {
    expect(tenantOwnershipLive({ SETTERFI_TENANT_OWNERSHIP_LIVE: "true" })).toBe(false);
    expect(tenantOwnershipLive({
      SETTERFI_TENANT_MEMBERSHIP_LIVE: "true",
      SETTERFI_TENANT_OWNERSHIP_LIVE: "TRUE",
    })).toBe(false);
    expect(tenantOwnershipLive({
      SETTERFI_TENANT_MEMBERSHIP_LIVE: "true",
      SETTERFI_TENANT_OWNERSHIP_LIVE: " true ",
    })).toBe(true);
  });

  it("leaves terms acceptance and effective-dated tier terms off unless each gate is exactly true", () => {
    expect(accountTermsLive({})).toBe(false);
    expect(accountTermsLive({ SETTERFI_ACCOUNT_TERMS_LIVE: "TRUE" })).toBe(false);
    expect(accountTermsLive({ SETTERFI_ACCOUNT_TERMS_LIVE: " true " })).toBe(true);
    expect(tierOfferTermsLive({})).toBe(false);
    expect(tierOfferTermsLive({ SETTERFI_TIER_OFFER_TERMS_LIVE: "TRUE" })).toBe(false);
    expect(tierOfferTermsLive({ SETTERFI_TIER_OFFER_TERMS_LIVE: " true " })).toBe(true);
  });

  it("leaves Phase 4 off unless the gate is exactly true", () => {
    expect(phase4Live({})).toBe(false);
    expect(phase4Live({ SETTERFI_PHASE4_LIVE: "TRUE" })).toBe(false);
    expect(phase4Live({ SETTERFI_PHASE4_LIVE: " true " })).toBe(true);
  });

  it("enables coach contact writes only when both exact flags are true", () => {
    expect(contactManagementLive({})).toBe(false);
    expect(contactManagementLive({ SETTERFI_PHASE4_LIVE: "true" })).toBe(false);
    expect(contactManagementLive({ SETTERFI_CONTACT_MANAGEMENT_LIVE: "true" })).toBe(false);
    expect(contactManagementLive({
      SETTERFI_PHASE4_LIVE: "true", SETTERFI_CONTACT_MANAGEMENT_LIVE: "TRUE",
    })).toBe(false);
    expect(contactManagementLive({
      SETTERFI_PHASE4_LIVE: " true ", SETTERFI_CONTACT_MANAGEMENT_LIVE: " true ",
    })).toBe(true);
  });

  it("enables Embedded Signup only when both exact flags are true", () => {
    expect(whatsappEmbeddedSignupEnabled({})).toBe(false);
    expect(whatsappEmbeddedSignupEnabled({
      SETTERFI_PHASE4_LIVE: "true",
    })).toBe(false);
    expect(whatsappEmbeddedSignupEnabled({
      SETTERFI_WHATSAPP_EMBEDDED_SIGNUP: "true",
    })).toBe(false);
    expect(whatsappEmbeddedSignupEnabled({
      SETTERFI_PHASE4_LIVE: "true",
      SETTERFI_WHATSAPP_EMBEDDED_SIGNUP: "true",
    })).toBe(true);
  });

  // Phase 5
  it("leaves Phase 5 off unless the gate is exactly true", () => {
    expect(phase5Live({})).toBe(false);
    expect(phase5Live({ SETTERFI_PHASE5_LIVE: "TRUE" })).toBe(false);
    expect(phase5Live({ SETTERFI_PHASE5_LIVE: " true " })).toBe(true);
  });

  it("keeps signup repair behind Phase 5 and its own gate", () => {
    expect(signupRepairLive({ SETTERFI_SIGNUP_REPAIR_LIVE: "true" })).toBe(false);
    expect(signupRepairLive({ SETTERFI_PHASE5_LIVE: "true" })).toBe(false);
    expect(signupRepairLive({
      SETTERFI_PHASE5_LIVE: "true",
      SETTERFI_SIGNUP_REPAIR_LIVE: "TRUE",
    })).toBe(false);
    expect(signupRepairLive({
      SETTERFI_PHASE5_LIVE: "true",
      SETTERFI_SIGNUP_REPAIR_LIVE: " true ",
    })).toBe(true);
  });

  it("requires an explicit GHL provisioning arm and rejects an invalid selector by name", () => {
    expect(() => driverSelection("ghl_provisioning", "SETTERFI_GHL_PROVISIONING_DRIVER", {}))
      .toThrowError(DriverConfigurationError);
    try {
      driverSelection(
        "ghl_provisioning",
        "SETTERFI_GHL_PROVISIONING_DRIVER",
        { SETTERFI_GHL_PROVISIONING_DRIVER: "invalid-synthetic" },
      );
    } catch (error) {
      expect(error).toMatchObject({
        variableNames: ["SETTERFI_GHL_PROVISIONING_DRIVER"],
      });
      expect(String(error)).not.toContain("invalid-synthetic");
    }
  });

  it("refuses absent selectors and rejects unknown selector values by name", () => {
    expect(() => driverSelection("ghl", "SETTERFI_GHL_DRIVER", {}))
      .toThrowError(DriverConfigurationError);
    expect(driverSelection("ghl", "SETTERFI_GHL_DRIVER", { SETTERFI_GHL_DRIVER: "mock" })).toBe(
      "mock",
    );
    expect(() =>
      driverSelection("ghl", "SETTERFI_GHL_DRIVER", { SETTERFI_GHL_DRIVER: "other" }),
    ).toThrowError(DriverConfigurationError);

    try {
      driverSelection("ghl", "SETTERFI_GHL_DRIVER", { SETTERFI_GHL_DRIVER: "other" });
    } catch (error) {
      expect(error).toMatchObject({ variableNames: ["SETTERFI_GHL_DRIVER"] });
      expect(String(error)).not.toContain("other");
    }
  });

  it("refuses every global mock provider driver in production, including demo-login builds", () => {
    expect(() => driverSelection("ghl", "SETTERFI_GHL_DRIVER", {
      NODE_ENV: "production",
      SETTERFI_GHL_DRIVER: "mock",
    })).toThrowError(DriverConfigurationError);
    expect(() => driverSelection("ghl", "SETTERFI_GHL_DRIVER", {
      NODE_ENV: "production",
      SETTERFI_DEMO_LOGINS: "true",
      SETTERFI_GHL_DRIVER: "mock",
    })).toThrowError(DriverConfigurationError);
    expect(() => driverSelection("stripe", "SETTERFI_STRIPE_DRIVER", {
      NODE_ENV: "production",
      SETTERFI_DEMO_LOGINS: "true",
      SETTERFI_STRIPE_DRIVER: "mock",
    })).toThrowError(DriverConfigurationError);
  });

  it("types Notion and embeddings through the explicit driver contract", () => {
    expect(() => driverSelection("notion", "SETTERFI_NOTION_DRIVER", {}))
      .toThrowError(DriverConfigurationError);
    expect(driverSelection("embeddings", "SETTERFI_EMBEDDINGS_DRIVER", {
      SETTERFI_EMBEDDINGS_DRIVER: "real",
    })).toBe("real");
    expect(realArmSkipReason(
      "notion",
      "SETTERFI_NOTION_DRIVER",
      ["NOTION_API_KEY", "NOTION_KB_ROOT_ID"],
      { SETTERFI_NOTION_DRIVER: "real", NOTION_API_KEY: "configured" },
    )).toBe("NOTION_KB_ROOT_ID is missing");
  });

  it("names every missing real-driver variable without including configured values", () => {
    expect(() =>
      requireEnvironment("ghl", ["GHL_CLIENT_ID", "GHL_CLIENT_SECRET"], {
        GHL_CLIENT_ID: "configured-value",
      }),
    ).toThrow(/GHL_CLIENT_SECRET/);

    try {
      requireEnvironment("ghl", ["GHL_CLIENT_ID", "GHL_CLIENT_SECRET"], {
        GHL_CLIENT_ID: "configured-value",
      });
    } catch (error) {
      expect(String(error)).not.toContain("configured-value");
    }
  });

  it("reports a real-arm skip with the first missing variable name", () => {
    expect(
      realArmSkipReason("meta", "SETTERFI_META_DRIVER", ["META_APP_ID"], {}),
    ).toBe("SETTERFI_META_DRIVER=real is required");
    expect(
      realArmSkipReason(
        "meta",
        "SETTERFI_META_DRIVER",
        ["META_APP_ID"],
        { SETTERFI_META_DRIVER: "real" },
      ),
    ).toBe("META_APP_ID is missing");
  });

  // Phase 9
  it("keeps the Phase 9 names-only block ordered and contiguous", () => {
    // Anchored by index rather than by tail offset: Phase 10 appends after this block, and a
    // slice(-6) anchor would have silently started asserting the wrong six names.
    const start = ENV_CONTRACT_NAMES.indexOf("SETTERFI_PHASE9_LIVE");
    expect(start).toBeGreaterThan(-1);
    expect(ENV_CONTRACT_NAMES.slice(start, start + 6)).toEqual([
      "SETTERFI_PHASE9_LIVE",
      "SETTERFI_PHASE9_GHL_OAUTH_LIVE",
      "GHL_AGENCY_CLIENT_ID",
      "GHL_AGENCY_CLIENT_SECRET",
      "GHL_INSTALL_URL",
      "GHL_AGENCY_INSTALL_URL",
    ]);
  });

  it("keeps the Phase 9 install path off unless its parent and child are exactly true", () => {
    expect(phase9Live({})).toBe(false);
    expect(phase9Live({ SETTERFI_PHASE9_LIVE: "TRUE" })).toBe(false);
    expect(phase9GhlOAuthLive({ SETTERFI_PHASE9_GHL_OAUTH_LIVE: "true" })).toBe(false);
    expect(phase9GhlOAuthLive({
      SETTERFI_PHASE9_LIVE: "true",
      SETTERFI_PHASE9_GHL_OAUTH_LIVE: "TRUE",
    })).toBe(false);
    expect(phase9GhlOAuthLive({
      SETTERFI_PHASE9_LIVE: " true ",
      SETTERFI_PHASE9_GHL_OAUTH_LIVE: "true",
    })).toBe(true);
  });

  // Phase 10
  it("keeps the account-security flag immediately after the one-name Phase 10 block", () => {
    const phase10 = ENV_CONTRACT_NAMES.indexOf("SETTERFI_BRAIN_OBJECTIONS_LIVE");
    expect(phase10).toBeGreaterThan(-1);
    expect(ENV_CONTRACT_NAMES[phase10 + 1]).toBe("SETTERFI_ACCOUNT_SECURITY_LIVE");
  });

  it("keeps account security off unless its own exact flag is true", () => {
    expect(accountSecurityLive({})).toBe(false);
    expect(accountSecurityLive({ SETTERFI_ACCOUNT_SECURITY_LIVE: "TRUE" })).toBe(false);
    expect(accountSecurityLive({ SETTERFI_ACCOUNT_SECURITY_LIVE: " true " })).toBe(true);
  });

  it("keeps the objection runtime off unless Phase 2 and its own key are both true", () => {
    expect(brainObjectionsLive({})).toBe(false);
    expect(brainObjectionsLive({ SETTERFI_PHASE2_LIVE: "true" })).toBe(false);
    expect(brainObjectionsLive({ SETTERFI_BRAIN_OBJECTIONS_LIVE: "true" })).toBe(false);
    for (const value of ["TRUE", "1", "yes", "false", ""]) {
      expect(brainObjectionsLive({
        SETTERFI_PHASE2_LIVE: "true", SETTERFI_BRAIN_OBJECTIONS_LIVE: value,
      })).toBe(false);
      expect(brainObjectionsLive({
        SETTERFI_PHASE2_LIVE: value, SETTERFI_BRAIN_OBJECTIONS_LIVE: "true",
      })).toBe(false);
    }
    expect(brainObjectionsLive({
      SETTERFI_PHASE2_LIVE: "true", SETTERFI_BRAIN_OBJECTIONS_LIVE: "true",
    })).toBe(true);
    // Surrounding whitespace is trimmed for every other gate in this contract (see Phase 9
    // above); this key behaves identically so a stray space in .env cannot disable one flag
    // while leaving its siblings on.
    expect(brainObjectionsLive({
      SETTERFI_PHASE2_LIVE: " true ", SETTERFI_BRAIN_OBJECTIONS_LIVE: " true ",
    })).toBe(true);
  });

  // Phase 3
  it.each([
    ["phase3Live", phase3Live, "SETTERFI_PHASE3_LIVE"],
    ["suppressionSyncLive", suppressionSyncLive, "SETTERFI_SUPPRESSION_SYNC_LIVE"],
    ["contactDeleteLive", contactDeleteLive, "SETTERFI_CONTACT_DELETE_LIVE"],
  ] as const)("keeps %s off unless its gate is exactly true", (_name, helper, variableName) => {
    expect(helper({})).toBe(false);
    expect(helper({ [variableName]: "TRUE" })).toBe(false);
    expect(helper({ [variableName]: " true " })).toBe(true);
  });
});
