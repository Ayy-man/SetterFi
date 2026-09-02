import { describe, expect, it } from "vitest";

import type { SignupOrchestrationResult } from "@/lib/onboarding/signup";
import type { ReferralClientResult } from "@/lib/onboarding/referrals";

import {
  a2pDescriptor,
  a2pProjectionDescriptor,
  artifactDescriptor,
  isDemoPlaceholderToken,
  templateVersionLabel,
  contentScreenDescriptor,
  hostedConsentSubmission,
  loginAccessDescriptor,
  provisioningStepDescriptor,
  readinessDescriptors,
  referralNotice,
  signupDescriptor,
  signupIntentDestination,
  signupResultDescriptor,
  TEST_PASS_DETAIL,
  WIZARD_STEPS,
} from "./view-models";

const TIER = { id: "11111111-1111-4111-8111-111111111111", label: "Selected plan" };

function signupResult(
  state: Exclude<SignupOrchestrationResult["state"], "still_setting_up">,
): SignupOrchestrationResult {
  const referral: ReferralClientResult = {
    status: "none",
    coachCode: null,
    message: null,
    affiliateEnrollment: "not_requested",
    attributionLocked: true,
  };
  const shared = {
    intentId: "intent-1",
    tenantId: "tenant-1",
    signupAuditId: 12,
    replayed: false,
    referral,
  };
  if (state === "confirmation_required") {
    return { ...shared, state, callbackDestination: "/auth/confirm?next=/onboarding" };
  }
  if (state === "session_refresh_required") return { ...shared, state };
  return { ...shared, state: "ready" };
}

describe("signup descriptors", () => {
  it("requires an explicit tier instead of selecting one by default", () => {
    expect(signupDescriptor({ enabled: true, tiers: [TIER], timezone: "Asia/Kolkata" })).toEqual({
      enabled: true,
      tierChoices: [TIER],
      selectedTierId: null,
      timezone: "Asia/Kolkata",
      timezoneEditable: true,
      timezoneRequired: true,
      billingEmailSource: "login_email",
      canSubmit: true,
      unavailableCode: null,
    });
  });

  it("keeps signup disabled when the route has no tier catalog instead of inventing pricing", () => {
    expect(signupDescriptor({ enabled: true, tiers: [], timezone: "Asia/Kolkata" })).toMatchObject({
      selectedTierId: null,
      canSubmit: false,
      unavailableCode: "tier_catalog_unavailable",
    });
  });

  it("requires the editable reporting timezone instead of silently defaulting it", () => {
    expect(signupDescriptor({ enabled: true, tiers: [TIER], timezone: "" })).toMatchObject({
      timezone: "",
      timezoneEditable: true,
      timezoneRequired: true,
      canSubmit: false,
    });
  });

  it("shows only the self-referral outcome instead of enumerating invalid codes", () => {
    expect(referralNotice({
      status: "self_referral",
      coachCode: "SELF_REFERRAL_NOT_APPLIED",
      message: "This referral code belongs to your own account, so it can't be applied",
      affiliateEnrollment: "not_requested",
      attributionLocked: true,
    })).toMatchObject({ visible: true });
    expect(referralNotice({
      status: "none", coachCode: null, message: null,
      affiliateEnrollment: "not_requested", attributionLocked: true,
    })).toEqual({ visible: false, message: null });
    expect(referralNotice({
      status: "attributed", coachCode: null, message: null,
      affiliateEnrollment: "not_requested", attributionLocked: true,
    })).toEqual({ visible: false, message: null });
  });

  it("keeps email confirmation distinct from an active session", () => {
    expect(signupResultDescriptor(signupResult("confirmation_required"))).toMatchObject({
      kind: "confirmation_required",
      title: "Confirm your email",
      nextHref: "/login",
    });
  });

  it("keeps a tenantless failed intent visible instead of opening an empty workspace", () => {
    expect(signupResultDescriptor({
      state: "still_setting_up",
      intentId: "intent-1",
      tenantId: null,
      errorCode: "SIGNUP_COMPLETION_FAILED",
    })).toMatchObject({
      kind: "still_setting_up",
      title: "We’re still setting up your account",
      nextHref: "/login?error=still-setting-up",
    });
  });
});

describe("login access descriptors", () => {
  it("sends a signed-in intent with a born tenant to the wizard and keeps tenantless work visible", () => {
    expect(signupIntentDestination({
      intentId: "intent-1",
      state: "completed",
      tenantId: "tenant-1",
      errorCode: null,
    })).toBe("/onboarding");
    expect(signupIntentDestination({
      intentId: "intent-2",
      state: "failed",
      tenantId: null,
      errorCode: "SIGNUP_COMPLETION_FAILED",
    })).toBe("/login?error=still-setting-up");
    expect(signupIntentDestination(null)).toBeNull();
    expect(signupIntentDestination({ intentId: "intent-3", state: "invented", tenantId: "tenant-3" }))
      .toBeNull();
  });

  it("renders retry and support for a persisted incomplete intent", () => {
    expect(loginAccessDescriptor({
      state: "still_setting_up",
      intentId: "intent-1",
      errorCode: "SIGNUP_COMPLETION_FAILED",
    })).toEqual({
      kind: "still_setting_up",
      message: "We’re still setting up your account. Your signup is saved.",
      retryHref: "/login",
      supportHref: "mailto:support@setterfi.com",
    });
  });

  it("retains the unattached-account fallback when no intent exists", () => {
    expect(loginAccessDescriptor({ state: "not_onboarding" })).toEqual({
      kind: "not_onboarding",
      message: "Your account isn’t attached to a workspace yet. Contact your success manager.",
      retryHref: null,
      supportHref: null,
    });
  });
});

describe("coach onboarding descriptors", () => {
  it("keeps every lane-B step out of the critical wizard", () => {
    expect(WIZARD_STEPS).toEqual([
      "account", "meta_connect", "whatsapp_connect", "calendar_connect",
      "offer_layer", "test_pass", "go_live",
    ]);
    expect(WIZARD_STEPS).not.toContain("sms_live");
    expect(WIZARD_STEPS).not.toContain("business_profile");
  });

  it("offers Try again only for coach-owned non-blocked steps", () => {
    expect(provisioningStepDescriptor({ key: "meta_connect", state: "failed" })).toMatchObject({
      owner: "coach", canRetry: true, actionTarget: "/api/onboarding/steps/meta_connect",
    });
    expect(provisioningStepDescriptor({ key: "meta_connect", state: "blocked" })).toMatchObject({
      canRetry: false, actionTarget: null,
    });
    expect(provisioningStepDescriptor({ key: "sms_live", state: "failed" })).toMatchObject({
      label: "Text messages (SMS)", owner: "provider", canRetry: false,
    });
  });

  it("covers every persisted provisioning state without inferring a ninth UI state", () => {
    const states = [
      "pending", "running", "awaiting_coach", "awaiting_platform",
      "awaiting_provider", "done", "failed", "blocked",
    ] as const;
    expect(states.map((state) => provisioningStepDescriptor({ key: "calendar_connect", state }).state)).toEqual(states);
    expect(states.map((state) => provisioningStepDescriptor({ key: "calendar_connect", state }).canRetry)).toEqual([
      false, false, true, false, false, false, true, false,
    ]);
  });

  it("renders registration from elapsed time with the exact carrier clock", () => {
    const descriptor = a2pDescriptor({ submittedAt: "2026-08-01T12:00:00.000Z", now: Date.parse("2026-08-12T12:00:00.000Z") });
    expect(descriptor).toEqual({
      kind: "registering",
      label: "Registering · day 12",
      detail: "Carrier review usually takes 2–3 weeks.",
      extra: null,
      showTimer: true,
      canRetry: false,
    });
    expect(JSON.stringify(descriptor)).not.toMatch(/%|predicted|all set/i);
  });

  it("adds the day-21 review line without changing registration state", () => {
    expect(a2pDescriptor({ submittedAt: "2026-08-01T00:00:00.000Z", now: Date.parse("2026-08-21T00:00:00.000Z") })).toMatchObject({
      kind: "registering",
      label: "Registering · day 21",
      extra: "This is running longer than usual and we’ve flagged it for review.",
    });
  });

  it("makes a terminal refusal permanently blocked with no timer or retry affordance", () => {
    const descriptor = a2pDescriptor({ submittedAt: "2026-08-01T00:00:00.000Z", now: Date.now(), terminalMessage: "The carrier decision is permanent." });
    expect(descriptor).toEqual({
      kind: "blocked",
      label: "Text messages aren’t available for this account.",
      detail: "The carrier decision is permanent.",
      extra: "Contact the operator to review what happened.",
      showTimer: false,
      canRetry: false,
    });
    expect(JSON.stringify(descriptor)).not.toMatch(/pending|done|day \d|all set/i);
  });

  it("feeds the persisted coach projection into the elapsed and terminal descriptors", () => {
    expect(a2pProjectionDescriptor({
      submittedAt: "2026-08-01T00:00:00.000Z",
      registrationState: "awaiting_provider",
      terminalRejection: false,
      terminalCode: null,
    }, Date.parse("2026-08-12T00:00:00.000Z"))).toMatchObject({
      kind: "registering",
      label: "Registering · day 12",
    });
    const terminal = a2pProjectionDescriptor({
      submittedAt: "2026-08-01T00:00:00.000Z",
      registrationState: "blocked",
      terminalRejection: true,
      terminalCode: "CARRIER_TERMINAL",
    }, Date.parse("2026-08-12T00:00:00.000Z"));
    expect(terminal).toMatchObject({
      kind: "blocked",
      showTimer: false,
      canRetry: false,
      detail: "The carrier registration was permanently declined (CARRIER_TERMINAL).",
    });
  });

  it("retains all seven named refusals and keeps offer review platform-owned", () => {
    const checks = readinessDescriptors({
      ready: false,
      checks: [
        { key: "tenant_active", ready: false, code: "tenant_not_active", evidenceAt: null, blamingParty: "coach" },
        { key: "messaging_channel_live", ready: false, code: "messaging_channel_missing", evidenceAt: null, blamingParty: "coach" },
        { key: "primary_calendar_healthy", ready: false, code: "primary_calendar_stale", evidenceAt: null, blamingParty: "coach" },
        { key: "published_offer_ready", ready: false, code: "offer_held", evidenceAt: null, blamingParty: "platform" },
        { key: "platform_brain_published", ready: false, code: "platform_brain_publish_pending", evidenceAt: null, blamingParty: "platform" },
        { key: "test_passed", ready: false, code: "test_not_passed", evidenceAt: null, blamingParty: "coach" },
        { key: "subscription_ready", ready: false, code: "subscription_contract_unavailable", evidenceAt: null, blamingParty: "platform" },
      ],
    });
    expect(checks.map((check) => check.key)).toEqual([
      "tenant_active", "messaging_channel_live", "primary_calendar_healthy",
      "published_offer_ready", "platform_brain_published", "test_passed", "subscription_ready",
    ]);
    expect(checks.find((check) => check.key === "published_offer_ready")).toMatchObject({
      detail: "Your offer is with our team for review. We’ll email you when it clears.",
      blamingParty: "platform",
    });
  });

  it("keeps carrier registration outside readiness when a Meta channel is live", () => {
    const readiness = readinessDescriptors({
      ready: true,
      checks: [
        { key: "tenant_active", ready: true, code: "ready", evidenceAt: "2026-08-18T00:00:00Z", blamingParty: "coach" },
        { key: "messaging_channel_live", ready: true, code: "ready", evidenceAt: "2026-08-18T00:00:00Z", blamingParty: "coach" },
        { key: "primary_calendar_healthy", ready: true, code: "ready", evidenceAt: "2026-08-18T00:00:00Z", blamingParty: "coach" },
        { key: "published_offer_ready", ready: true, code: "ready", evidenceAt: "2026-08-18T00:00:00Z", blamingParty: "coach" },
        { key: "platform_brain_published", ready: true, code: "ready", evidenceAt: "2026-08-18T00:00:00Z", blamingParty: "platform" },
        { key: "test_passed", ready: true, code: "ready", evidenceAt: "2026-08-18T00:00:00Z", blamingParty: "coach" },
        { key: "subscription_ready", ready: true, code: "ready", evidenceAt: "2026-08-18T00:00:00Z", blamingParty: "platform" },
      ],
    });
    const sms = a2pDescriptor({ submittedAt: "2026-08-17T00:00:00Z", now: Date.parse("2026-08-18T00:00:00Z") });
    expect(readiness.every((check) => check.ready)).toBe(true);
    expect(sms.kind).toBe("registering");
  });

  it("labels the safe test as a real slot fetch and simulated write", () => {
    expect(TEST_PASS_DETAIL).toBe("Runs a real primary-calendar slot fetch and a simulated booking write. No appointment is created.");
  });

  it("marks placeholder artifacts demo-only instead of mixing them with production evidence", () => {
    const descriptor = artifactDescriptor({
      artifactId: "artifact-1", version: 1, templateVersion: "SETTERFI_DEMO_PLACEHOLDER_CONSENT_VERSION",
      controls: [
        { key: "marketing", checked: false, required: false, renderedLanguage: "demo", renderedLanguageHash: "a".repeat(64) },
        { key: "non_marketing", checked: false, required: false, renderedLanguage: "demo", renderedLanguageHash: "b".repeat(64) },
      ],
      termsUrl: "https://example.test/terms", privacyUrl: "https://example.test/privacy",
      campaignDescriptionHash: "c".repeat(64), placeholder: true, confirmedAt: null,
    });
    expect(descriptor).toMatchObject({ demoOnly: true, confirmed: false });
  });

  it("never hands a screen the raw demo sentinel to print", () => {
    expect(templateVersionLabel("SETTERFI_DEMO_PLACEHOLDER_PHASE5_TEMPLATE_V1")).toBe(
      "Demo placeholder, replaced when your real opt-in copy is filed",
    );
    expect(isDemoPlaceholderToken("SETTERFI_DEMO_PLACEHOLDER_PHASE5_TEMPLATE_V1")).toBe(true);
  });

  it("passes a real filed template version through untouched", () => {
    expect(templateVersionLabel("approved-v3")).toBe("approved-v3");
    expect(isDemoPlaceholderToken("approved-v3")).toBe(false);
  });
});

describe("hosted artifact descriptors", () => {
  const artifact = {
    artifactId: "artifact-1", version: 3, templateVersion: "approved-v3",
    controls: [
      { key: "marketing" as const, checked: false as const, required: false as const, renderedLanguage: "Persisted marketing disclosure", renderedLanguageHash: "a".repeat(64) },
      { key: "non_marketing" as const, checked: false as const, required: false as const, renderedLanguage: "Persisted non-marketing disclosure", renderedLanguageHash: "b".repeat(64) },
    ] as const,
    termsUrl: "https://example.test/terms", privacyUrl: "https://example.test/privacy",
    campaignDescriptionHash: "c".repeat(64), placeholder: false, confirmedAt: "2026-08-18T00:00:00Z",
  };

  it("renders exactly two separate unchecked optional controls from persisted copy", () => {
    const descriptor = artifactDescriptor(artifact);
    expect(descriptor.controls).toEqual([
      { key: "marketing", checked: false, required: false, renderedLanguage: "Persisted marketing disclosure", renderedLanguageHash: "a".repeat(64) },
      { key: "non_marketing", checked: false, required: false, renderedLanguage: "Persisted non-marketing disclosure", renderedLanguageHash: "b".repeat(64) },
    ]);
  });

  it("accepts an all-unchecked submission without fabricating identity evidence", () => {
    expect(hostedConsentSubmission({ artifactId: "artifact-1", marketing: false, nonMarketing: false })).toEqual({
      artifactId: "artifact-1", consentToken: null,
      marketing: false, nonMarketing: false,
    });
  });

  it("keeps the persisted URLs, version, and campaign hash linked", () => {
    expect(artifactDescriptor(artifact)).toMatchObject({
      templateVersion: "approved-v3", version: 3,
      termsUrl: "https://example.test/terms", privacyUrl: "https://example.test/privacy",
      campaignDescriptionHash: "c".repeat(64), demoOnly: false,
    });
  });

  it("distinguishes clean, flagged, waiting-admin, and confirmed filing gates", () => {
    const base = {
      screenId: "screen-1", inputHash: "hash-1",
      matches: [{ phrase: "matched phrase", page: "https://example.test" }],
      coachAcknowledgedAt: null, adminConfirmedAt: null,
    } as const;
    expect(contentScreenDescriptor({ ...base, state: "clean", matches: [] }, "hash-1")).toMatchObject({ kind: "clean", filingAvailable: true });
    expect(contentScreenDescriptor({ ...base, state: "flagged" }, "hash-1")).toMatchObject({ kind: "coach_action", filingAvailable: false });
    expect(contentScreenDescriptor({ ...base, state: "flagged", coachAcknowledgedAt: "2026-08-18T00:00:00Z" }, "hash-1")).toMatchObject({ kind: "waiting_admin", filingAvailable: false });
    expect(contentScreenDescriptor({ ...base, state: "confirmed", coachAcknowledgedAt: "2026-08-18T00:00:00Z", adminConfirmedAt: "2026-08-18T01:00:00Z" }, "hash-1")).toMatchObject({ kind: "confirmed", filingAvailable: true });
  });

  it("invalidates prior confirmations when the input hash changes", () => {
    expect(contentScreenDescriptor({
      screenId: "screen-1", inputHash: "old", state: "confirmed", matches: [],
      coachAcknowledgedAt: "2026-08-18T00:00:00Z", adminConfirmedAt: "2026-08-18T01:00:00Z",
    }, "new")).toEqual({ kind: "coach_action", matches: [], filingAvailable: false, stale: true });
  });
});
