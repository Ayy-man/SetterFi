import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { deriveAdminProvisioningView, loggedActionReceipt } from "@/components/onboarding/admin-view-models";
import {
  a2pDescriptor,
  provisioningStepDescriptor,
  readinessDescriptors,
} from "@/components/onboarding/view-models";
import { createMockGhlProvisioningDriver } from "@/lib/integrations/ghl";
import type { CalendarDriver } from "@/lib/integrations/types";
import {
  assertArtifactReadyForRealFiling,
  renderOptInArtifact,
} from "@/lib/onboarding/artifacts";
import { executeA2pProbe, registrationState } from "@/lib/onboarding/a2p-probe";
import { createMetaConnectExecutor } from "@/lib/onboarding/coach-lanes";
import { contentScreenFilingGate, screenA2pContent } from "@/lib/onboarding/content-screen";
import { PROVISIONING_STEPS, READINESS_KEYS, type ProvisioningTrackerRow, type StepAttempt } from "@/lib/onboarding/contracts";
import { createGhlLaneExecutors } from "@/lib/onboarding/ghl-lane";
import {
  commitGoLive,
  createDemoSubscriptionReadinessPort,
  evaluateReadiness,
  type ReadinessDependencies,
} from "@/lib/onboarding/readiness";
import { mapReferralOutcome } from "@/lib/onboarding/referrals";
import {
  orchestrateSignup,
  type SignupOrchestrationDependencies,
} from "@/lib/onboarding/signup";
import { WIZARD_CRITICAL_STEPS } from "@/lib/onboarding/steps";
import { createTestPassExecutor } from "@/lib/onboarding/test-pass";

const TENANT = "85000000-0000-4000-8000-000000000099";
const ACTOR = "85000000-0000-4000-8000-000000000098";
const NOW = new Date("2026-08-18T12:00:00.000Z");
const RECENT = new Date(NOW.getTime() - 60_000).toISOString();

const REQUIREMENTS = [
  "ONB-01",
  "ONB-02",
  "ONB-03",
  "ONB-04",
  "ONB-05",
  "ONB-06",
  "ONB-07",
  "ONB-08",
  "AFF-04",
  "AFF-06",
] as const;

function attempt(stepKey: StepAttempt["stepKey"]): StepAttempt {
  return {
    tenantId: TENANT,
    stepKey,
    attemptId: `${TENANT}:${stepKey}:attempt`,
    idempotencyKey: `${TENANT}:${stepKey}`,
    isDemo: true,
  };
}

function signupDependencies(options: { fail?: boolean; referral?: "none" | "self_referral" | "invalid_silent" } = {}) {
  const persisted = {
    id: "intent-1",
    authUserId: "auth-1",
    email: "coach@example.invalid",
    tenantId: null,
    tierId: "tier-1",
    timezone: "Asia/Kolkata",
    referralCode: null,
    state: "started" as const,
    errorCode: null,
  };
  const dependencies: SignupOrchestrationDependencies = {
    persistIntent: async () => persisted,
    completeSignup: async () => {
      if (options.fail) throw new Error("synthetic atomic refusal");
      const referralResult = options.referral ?? "none";
      return {
        tenantId: TENANT,
        referralResult,
        signupAuditId: 401,
        referralRejectionAuditId: ["self_referral", "invalid_silent"].includes(referralResult) ? 402 : null,
        replayed: false,
      };
    },
    recordFailure: async (_authUserId, errorCode) => ({
      ...persisted,
      state: "failed",
      errorCode,
    }),
    loadIntent: async () => persisted,
    refreshSession: async () => true,
  };
  return dependencies;
}

function readinessDependencies(overrides: Partial<{
  tenant: "onboarding" | "active" | "suspended";
  connections: ReadonlyArray<{ channel: "instagram" | "sms"; state: string; evidenceAt: string }>;
  calendarOk: boolean;
  offerName: string | null;
  brainAt: string | null;
  testState: string;
  subscriptionState: "trialing" | "incomplete";
}> = {}, events: string[] = []): ReadinessDependencies {
  return {
    repository: {
      loadTenant: async () => ({
        status: overrides.tenant ?? "onboarding",
        isDemo: true,
        evidenceAt: RECENT,
      }),
      loadMessagingConnections: async () => overrides.connections ?? [
        { channel: "instagram", state: "live", evidenceAt: RECENT },
        { channel: "sms", state: "ready", evidenceAt: RECENT },
      ],
      loadPrimaryCalendar: async () => ({
        state: "ready",
        lastSlotFetchOk: overrides.calendarOk ?? true,
        lastSlotFetchAt: RECENT,
      }),
      loadPublishedBrainEvidence: async () => overrides.brainAt === undefined ? RECENT : overrides.brainAt,
      loadTestPass: async () => ({
        state: overrides.testState ?? "done",
        completedAt: overrides.testState === "pending" ? null : RECENT,
      }),
      goLive: async (input) => {
        events.push("go-live");
        return { tenantId: input.tenantId, auditId: "audit-501", wentLiveAt: NOW.toISOString() };
      },
    },
    offerReadiness: async () => ({
      published: true,
      programName: overrides.offerName === undefined ? "Synthetic program" : overrides.offerName,
      bookingMode: "direct",
      reviewState: "clear",
      evidenceAt: RECENT,
    }),
    demoSubscriptionReadiness: overrides.subscriptionState
      ? async () => ({ state: overrides.subscriptionState!, evidenceAt: RECENT, isDemo: true })
      : createDemoSubscriptionReadinessPort(() => NOW),
    now: () => NOW,
  };
}

function trackerRow(overrides: Partial<ProvisioningTrackerRow> = {}): ProvisioningTrackerRow {
  return {
    signupIntentId: "intent-1",
    tenantId: TENANT,
    businessName: "Synthetic Demo Business",
    signupState: "completed",
    currentStep: "sms_live",
    state: "awaiting_provider",
    attempts: 1,
    errorCode: null,
    blockingParty: "provider",
    blockingProvider: "carrier",
    stalledSince: "2026-08-13T12:00:00.000Z",
    isDemo: true,
    contentScreenId: null,
    contentScreenState: null,
    ...overrides,
  };
}

describe("Phase 5 connected vertical slice", () => {
  it("moves from auth to audited go-live on independent mock lanes before the SMS probe", async () => {
    const events: string[] = [];
    const signup = await orchestrateSignup({
      user: { id: "auth-1", email: "coach@example.invalid" },
      session: { synthetic: true },
    }, {
      email: "coach@example.invalid",
      fullName: "Synthetic Coach",
      businessName: "Synthetic Demo Business",
      slug: "synthetic-demo-business",
      tierId: "tier-1",
      timezone: "Asia/Kolkata",
      referralCode: null,
      affiliateOptIn: false,
    }, signupDependencies());
    expect(signup).toMatchObject({ state: "ready", tenantId: TENANT, signupAuditId: 401 });

    let locationReference: Record<string, unknown> | null = null;
    const mockDriver = createMockGhlProvisioningDriver({ now: () => NOW.getTime() });
    const createLocation = vi.spyOn(mockDriver, "createOrFindLocation");
    const ghl = createGhlLaneExecutors({
      driverForAttempt: () => mockDriver,
      evidence: {
        loadExternalReference: async () => locationReference,
        loadLocationRequest: async () => ({ companyId: "SETTERFI_DEMO_PLACEHOLDER_COMPANY", name: "Synthetic workspace", timezone: "Asia/Kolkata", country: "US", address: { line1: "SETTERFI_DEMO_PLACEHOLDER_ADDRESS", city: "Example City", region: "EX", postalCode: "00000" }, snapshotId: "SETTERFI_DEMO_PLACEHOLDER_SNAPSHOT" }),
        loadSnapshotRequest: async () => ({ locationId: "unused", snapshotId: "unused", companyId: "unused" }),
        loadNumberRequest: async () => ({ locationId: "unused", poolId: "unused" }),
        loadApprovedBrandInput: async () => null,
        loadApprovedCampaignInput: async () => null,
      },
    });
    const firstLocation = await ghl.executeGhlLocation(attempt("ghl_location"));
    expect(firstLocation.kind).toBe("done");
    if (firstLocation.kind === "done") locationReference = firstLocation.externalRef ?? null;
    const replayLocation = await ghl.executeGhlLocation(attempt("ghl_location"));
    expect(replayLocation).toEqual(firstLocation);
    expect(createLocation).toHaveBeenCalledOnce();

    const resolveMeta = vi.fn(async () => ({
      senderId: "SETTERFI_DEMO_PLACEHOLDER_SENDER",
      accessToken: "SETTERFI_DEMO_PLACEHOLDER_TOKEN",
      host: "https://graph.instagram.com" as const,
    }));
    const meta = createMetaConnectExecutor({
      loadConnections: async () => [{ connectionId: "meta-1", channel: "instagram", state: "live" }],
      resolveMetaConnection: resolveMeta,
      whatsappCapability: async () => "disabled",
      loadPrimaryCalendar: async () => ({ connectionId: "calendar-1", state: "ready" }),
      offerReadiness: async () => ({ published: true, programName: "Synthetic program", bookingMode: "direct", reviewState: "clear", evidenceAt: RECENT }),
    });

    const createAppointment = vi.fn();
    const calendar: CalendarDriver = {
      fetchSlots: vi.fn(async () => [{ id: "slot-1", startAt: "2026-08-19T12:00:00.000Z", endAt: "2026-08-19T12:30:00.000Z", timezone: "Asia/Kolkata" }]),
      createAppointment,
      updateAppointment: vi.fn(),
      cancelAppointment: vi.fn(),
      listAppointments: vi.fn(),
    };
    const testPass = createTestPassExecutor({
      runGroundedTurn: async () => ({ grounded: true, outputChecksPassed: true, citationIds: ["brain-1"], outputCheckRuleIds: ["CLAIM"], unresolvedPlaceholders: [] }),
      calendar,
      repository: {
        loadPrimaryCalendar: async () => ({ id: "calendar-1", tenantId: TENANT, provider: "ghl", externalCalendarId: "calendar-demo", externalLocationId: "location-demo", timezone: "Asia/Kolkata", bookingUrl: null }),
        recordCalendarSlotFetch: async () => void events.push("slot-fetch-recorded"),
      },
      now: () => NOW,
    });

    const [metaOutcome, testOutcome] = await Promise.all([
      meta(attempt("meta_connect")),
      testPass(attempt("test_pass")),
    ]);
    expect(metaOutcome).toMatchObject({ kind: "done", externalRef: { connection_id: "meta-1" } });
    expect(testOutcome).toMatchObject({ kind: "done", externalRef: { test_receipt: { grounded: true, simulated_write: true } } });
    expect(resolveMeta).toHaveBeenCalledOnce();
    expect(createAppointment).not.toHaveBeenCalled();

    const live = await commitGoLive({ tenantId: TENANT, actorId: ACTOR }, readinessDependencies({}, events));
    expect(live).toMatchObject({ kind: "live", receipt: { auditId: "audit-501" } });
    if (live.kind !== "live") throw new Error("expected live result");
    expect(live.readiness.checks.map((check) => check.key)).toEqual(READINESS_KEYS);
    expect(live.readiness.checks).toHaveLength(7);

    const receiptWrite = vi.fn(async () => ({ receiptId: "probe-receipt-1" }));
    const targetHash = createHash("sha256").update("SETTERFI_DEMO_PLACEHOLDER_PROBE").digest("hex");
    const probe = await executeA2pProbe(attempt("sms_live"), {
      targetHash,
      probeKey: `${TENANT}:sms_live:2026-08-18`,
    }, {
      driver: mockDriver,
      evidence: { recordA2pProbeReceipt: receiptWrite },
    });
    events.push("probe");
    expect(probe).toMatchObject({ kind: "done", externalRef: { receiptId: "probe-receipt-1", result: "delivered" } });
    expect(events.indexOf("go-live")).toBeLessThan(events.indexOf("probe"));
    expect(receiptWrite).toHaveBeenCalledOnce();

    const coachA2p = a2pDescriptor({ submittedAt: "2026-08-13T12:00:00.000Z", now: NOW.getTime() });
    expect(coachA2p).toMatchObject({ kind: "registering", label: "Registering · day 6", detail: "Carrier review usually takes 2–3 weeks.", canRetry: false });
    expect(JSON.stringify(coachA2p)).not.toMatch(/%|predicted|all set|1–2 weeks/i);
    expect(WIZARD_CRITICAL_STEPS).not.toContain("sms_live");
    expect(PROVISIONING_STEPS).toHaveLength(17);
    expect(REQUIREMENTS).toEqual(["ONB-01", "ONB-02", "ONB-03", "ONB-04", "ONB-05", "ONB-06", "ONB-07", "ONB-08", "AFF-04", "AFF-06"]);
  });

  it("fails every boundary closed and keeps terminal/demo states honest", async () => {
    const failedSignup = await orchestrateSignup({
      user: { id: "auth-1", email: "coach@example.invalid" },
      session: { synthetic: true },
    }, {
      email: "coach@example.invalid",
      fullName: "Synthetic Coach",
      businessName: "Synthetic Demo Business",
      slug: "synthetic-demo-business",
      tierId: "tier-1",
      timezone: "Asia/Kolkata",
      referralCode: null,
      affiliateOptIn: false,
    }, signupDependencies({ fail: true }));
    expect(failedSignup).toMatchObject({ state: "still_setting_up", tenantId: null, errorCode: "SIGNUP_COMPLETION_FAILED" });

    const selfReferral = mapReferralOutcome({ tenantId: TENANT, referralResult: "self_referral", signupAuditId: 1, referralRejectionAuditId: 2, replayed: false }, { affiliateOptIn: false });
    const invalidReferral = mapReferralOutcome({ tenantId: TENANT, referralResult: "invalid_silent", signupAuditId: 1, referralRejectionAuditId: 2, replayed: false }, { affiliateOptIn: false });
    expect(selfReferral.status).toBe("self_referral");
    expect(invalidReferral).toMatchObject({ status: "none", coachCode: null, message: null, attributionLocked: true });

    const placeholder = renderOptInArtifact({
      templateVersion: "SETTERFI_DEMO_PLACEHOLDER_V1",
      approvalReference: "SETTERFI_DEMO_PLACEHOLDER_APPROVAL",
      marketingLanguage: "SETTERFI_DEMO_PLACEHOLDER_ {{business_name}} marketing",
      nonMarketingLanguage: "SETTERFI_DEMO_PLACEHOLDER_ {{business_name}} service",
      campaignDescription: "SETTERFI_DEMO_PLACEHOLDER_ {{business_name}} campaign",
      termsUrl: "https://example.invalid/terms",
      privacyUrl: "https://example.invalid/privacy",
      placeholder: true,
    }, { businessName: "Synthetic Demo", websiteUrl: "https://example.invalid" });
    expect(() => assertArtifactReadyForRealFiling(placeholder)).toThrow("A2P_COPY_NOT_APPROVED");

    const flagged = screenA2pContent([{ page: "https://example.invalid", text: "Guaranteed funding" }]);
    expect(contentScreenFilingGate({ screenId: "screen-1", ...flagged, coachAcknowledgedAt: null, adminConfirmedAt: null }, flagged.inputHash)).toEqual({ ready: false, code: "A2P_CONTENT_ACKNOWLEDGEMENT_REQUIRED" });
    expect(contentScreenFilingGate({ screenId: "screen-1", ...flagged, coachAcknowledgedAt: RECENT, adminConfirmedAt: null }, flagged.inputHash)).toEqual({ ready: false, code: "A2P_CONTENT_ADMIN_CONFIRMATION_REQUIRED" });
    expect(contentScreenFilingGate({ screenId: "screen-1", ...flagged, coachAcknowledgedAt: RECENT, adminConfirmedAt: RECENT }, "0".repeat(64))).toEqual({ ready: false, code: "A2P_CONTENT_SCREEN_STALE" });

    const filingLane = createGhlLaneExecutors({
      driverForAttempt: () => createMockGhlProvisioningDriver(),
      evidence: {
        loadExternalReference: async () => null,
        loadLocationRequest: async () => ({ companyId: "unused", name: "unused", timezone: "UTC", country: "US", address: { line1: "unused", city: "unused", region: "EX", postalCode: "00000" }, snapshotId: "unused" }),
        loadSnapshotRequest: async () => ({ locationId: "unused", snapshotId: "unused", companyId: "unused" }),
        loadNumberRequest: async () => ({ locationId: "unused", poolId: "unused" }),
        loadApprovedBrandInput: async () => null,
        loadApprovedCampaignInput: async () => null,
      },
    });
    expect(await filingLane.executeA2pBrand(attempt("a2p_brand"))).toEqual({ kind: "awaiting_coach", code: "A2P_EVIDENCE_REQUIRED" });
    expect(await filingLane.executeA2pCampaign(attempt("a2p_campaign"))).toEqual({ kind: "awaiting_coach", code: "A2P_EVIDENCE_REQUIRED" });

    const refusalCases = [
      [{ tenant: "suspended" as const }, "tenant_active", "tenant_not_eligible", "platform"],
      [{ connections: [] }, "messaging_channel_live", "messaging_channel_required", "coach"],
      [{ calendarOk: false }, "primary_calendar_healthy", "primary_calendar_unhealthy", "coach"],
      [{ offerName: null }, "published_offer_ready", "published_offer_incomplete", "coach"],
      [{ brainAt: null }, "platform_brain_published", "platform_brain_publish_pending", "platform"],
      [{ testState: "pending" }, "test_passed", "test_pass_required", "coach"],
      [{ subscriptionState: "incomplete" as const }, "subscription_ready", "subscription_incomplete", "coach"],
    ] as const;
    for (const [overrides, key, code, blamingParty] of refusalCases) {
      const readiness = await evaluateReadiness(TENANT, readinessDependencies(overrides));
      expect(readiness.ready).toBe(false);
      expect(readiness.checks.find((check) => check.key === key)).toMatchObject({ ready: false, code, blamingParty });
    }

    const terminal = registrationState({ submittedAt: "2026-07-01T00:00:00.000Z", now: NOW.getTime(), terminalRefusal: { safeMessage: "Carrier decision is permanent." } });
    expect(terminal).toMatchObject({ kind: "permanently_blocked", showTimer: false, canRetry: false });
    expect(JSON.stringify(terminal)).not.toMatch(/done|100%|all set/i);
    expect(provisioningStepDescriptor({ key: "sms_live", state: "blocked" })).toMatchObject({ state: "blocked", canRetry: false, actionTarget: null });

    const admin = deriveAdminProvisioningView({
      enabled: true,
      authorized: true,
      now: NOW,
      rows: [
        trackerRow({ signupIntentId: "real", isDemo: false }),
        trackerRow({ signupIntentId: "demo", isDemo: true }),
        trackerRow({ signupIntentId: "tenantless", tenantId: null, businessName: null, currentStep: null, state: "failed", blockingParty: "system", blockingProvider: null, isDemo: null }),
        trackerRow({ signupIntentId: "terminal", state: "blocked" }),
      ],
    });
    expect(admin).toMatchObject({ realRowCount: 1, demoRowCount: 2 });
    expect(admin.rows.find((row) => row.id === "demo")?.dataClassification).toBe("Demo");
    expect(admin.rows.find((row) => row.id === "tenantless")).toMatchObject({ tenantId: null, dataClassification: "Not available", actions: [] });
    expect(admin.rows.find((row) => row.id === "terminal")).toMatchObject({ stateLabel: "Permanently blocked", terminal: true, actions: [] });
    expect(JSON.stringify(admin.rows)).not.toMatch(/GoHighLevel/i);
    expect(loggedActionReceipt({ auditId: "audit-1", actionKey: "onboarding.step_retried" })).toMatchObject({ auditId: "audit-1", microcopy: "Retry logged" });
    expect(loggedActionReceipt({ actionKey: "onboarding.step_retried" })).toBeNull();

    const allReady = await evaluateReadiness(TENANT, readinessDependencies());
    expect(readinessDescriptors(allReady).map((descriptor) => descriptor.key)).toEqual(READINESS_KEYS);
    const provisioning = provisioningStepDescriptor({ key: "ghl_location", state: "running" });
    expect(`${provisioning.label} ${provisioning.detail} ${provisioning.state}`).not.toMatch(/done|100%|all set|GoHighLevel/i);
  });
});
