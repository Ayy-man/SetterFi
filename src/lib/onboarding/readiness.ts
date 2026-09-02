/**
 * Seven-condition onboarding readiness and the sole application call to transactional go-live.
 *
 * Reads are assembled into named evidence for the preflight display. Success still requires the
 * Plan 05-01 RPC to lock current rows, activate the tenant, recheck database-owned conditions, and
 * return the persisted tenant.went_live audit receipt.
 */

import {
  READINESS_KEYS,
  type OfferReadinessPort,
  type OfferReadinessResult,
  type ReadinessCheck,
  type ReadinessResult,
  type SubscriptionReadinessPort,
  type SubscriptionReadinessResult,
} from "@/lib/onboarding/contracts";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const MAX_READINESS_EVIDENCE_AGE_MS = 15 * 60_000;

export type TenantReadinessEvidence = {
  status: "onboarding" | "active" | "suspended" | "canceled";
  isDemo: boolean;
  evidenceAt: string;
};

export type MessagingReadinessEvidence = {
  channel: "instagram" | "messenger" | "sms" | "whatsapp" | "webchat";
  state: string;
  evidenceAt: string;
};

export type CalendarReadinessEvidence = {
  state: string;
  lastSlotFetchOk: boolean | null;
  lastSlotFetchAt: string | null;
};

export type TestPassReadinessEvidence = {
  state: string;
  completedAt: string | null;
};

export type GoLiveReceipt = {
  tenantId: string;
  auditId: string;
  wentLiveAt: string;
};

export type ReadinessRepository = {
  loadTenant(tenantId: string): Promise<TenantReadinessEvidence | null>;
  loadMessagingConnections(tenantId: string): Promise<readonly MessagingReadinessEvidence[]>;
  loadPrimaryCalendar(tenantId: string): Promise<CalendarReadinessEvidence | null>;
  loadPublishedBrainEvidence(tenantId: string): Promise<string | null>;
  loadTestPass(tenantId: string): Promise<TestPassReadinessEvidence | null>;
  goLive(input: {
    tenantId: string;
    actorId: string;
    offerReviewClear: boolean;
    offerReviewEvidenceAt: string;
    subscriptionState: string;
    subscriptionEvidenceAt: string;
  }): Promise<GoLiveReceipt>;
};

export type ReadinessDependencies = {
  repository: ReadinessRepository;
  offerReadiness: OfferReadinessPort;
  subscriptionReadiness?: SubscriptionReadinessPort;
  demoSubscriptionReadiness?: SubscriptionReadinessPort;
  now?: () => Date;
};

type ReadinessSnapshot = {
  tenant: TenantReadinessEvidence | null;
  tenantReadFailed: boolean;
  connections: readonly MessagingReadinessEvidence[];
  connectionsReadFailed: boolean;
  calendar: CalendarReadinessEvidence | null;
  calendarReadFailed: boolean;
  offer: OfferReadinessResult;
  offerReadFailed: boolean;
  brainEvidenceAt: string | null;
  brainReadFailed: boolean;
  testPass: TestPassReadinessEvidence | null;
  testPassReadFailed: boolean;
  subscription: SubscriptionReadinessResult;
  subscriptionReadFailed: boolean;
};

function unavailableOffer(): OfferReadinessResult {
  return {
    published: false,
    programName: null,
    bookingMode: null,
    reviewState: "unavailable",
    evidenceAt: null,
  };
}

function unavailableSubscription(isDemo: boolean): SubscriptionReadinessResult {
  return { state: "unavailable", evidenceAt: null, isDemo };
}

async function settled<T>(promise: Promise<T>, fallback: T) {
  try {
    return { value: await promise, failed: false };
  } catch {
    return { value: fallback, failed: true };
  }
}

async function loadSnapshot(
  tenantId: string,
  dependencies: ReadinessDependencies,
): Promise<ReadinessSnapshot> {
  const tenantResult = await settled(dependencies.repository.loadTenant(tenantId), null);
  const subscriptionPort = tenantResult.value?.isDemo
    ? dependencies.demoSubscriptionReadiness
    : dependencies.subscriptionReadiness;
  const [connections, calendar, offer, brain, testPass, subscription] = await Promise.all([
    settled(dependencies.repository.loadMessagingConnections(tenantId), []),
    settled(dependencies.repository.loadPrimaryCalendar(tenantId), null),
    settled(dependencies.offerReadiness(tenantId), unavailableOffer()),
    settled(dependencies.repository.loadPublishedBrainEvidence(tenantId), null),
    settled(dependencies.repository.loadTestPass(tenantId), null),
    subscriptionPort
      ? settled(subscriptionPort(tenantId), unavailableSubscription(Boolean(tenantResult.value?.isDemo)))
      : Promise.resolve({
          value: unavailableSubscription(Boolean(tenantResult.value?.isDemo)),
          failed: false,
        }),
  ]);
  return {
    tenant: tenantResult.value,
    tenantReadFailed: tenantResult.failed,
    connections: connections.value,
    connectionsReadFailed: connections.failed,
    calendar: calendar.value,
    calendarReadFailed: calendar.failed,
    offer: offer.value,
    offerReadFailed: offer.failed,
    brainEvidenceAt: brain.value,
    brainReadFailed: brain.failed,
    testPass: testPass.value,
    testPassReadFailed: testPass.failed,
    subscription: subscription.value,
    subscriptionReadFailed: subscription.failed,
  };
}

function recent(value: string | null, now: Date) {
  if (!value) return false;
  const age = now.getTime() - Date.parse(value);
  return Number.isFinite(age) && age >= 0 && age <= MAX_READINESS_EVIDENCE_AGE_MS;
}

function check(
  input: Omit<ReadinessCheck, "evidenceAt"> & { evidenceAt?: string | null },
): ReadinessCheck {
  return { ...input, evidenceAt: input.evidenceAt ?? null };
}

function readinessChecks(snapshot: ReadinessSnapshot, now: Date): ReadinessCheck[] {
  const tenantEligible = snapshot.tenant?.status === "onboarding" || snapshot.tenant?.status === "active";
  const tenant = check({
    key: "tenant_active",
    ready: !snapshot.tenantReadFailed && tenantEligible,
    code: snapshot.tenantReadFailed
      ? "tenant_readiness_unavailable"
      : snapshot.tenant?.status === "active"
        ? "tenant_active"
        : tenantEligible
          ? "tenant_activation_eligible"
          : "tenant_not_eligible",
    evidenceAt: snapshot.tenant?.evidenceAt,
    blamingParty: "platform",
  });

  const liveConnection = snapshot.connections.find((connection) => connection.state === "live");
  const messaging = check({
    key: "messaging_channel_live",
    ready: !snapshot.connectionsReadFailed && Boolean(liveConnection),
    code: snapshot.connectionsReadFailed
      ? "messaging_readiness_unavailable"
      : liveConnection
        ? "messaging_channel_live"
        : "messaging_channel_required",
    evidenceAt: liveConnection?.evidenceAt,
    blamingParty: snapshot.connectionsReadFailed ? "platform" : "coach",
  });

  const calendarHealthy = snapshot.calendar?.state === "ready"
    && snapshot.calendar.lastSlotFetchOk === true;
  const calendarFresh = recent(snapshot.calendar?.lastSlotFetchAt ?? null, now);
  const calendar = check({
    key: "primary_calendar_healthy",
    ready: !snapshot.calendarReadFailed && calendarHealthy && calendarFresh,
    code: snapshot.calendarReadFailed
      ? "calendar_readiness_unavailable"
      : !calendarHealthy
        ? "primary_calendar_unhealthy"
        : !calendarFresh
          ? "primary_calendar_stale"
          : "primary_calendar_healthy",
    evidenceAt: snapshot.calendar?.lastSlotFetchAt,
    blamingParty: snapshot.calendarReadFailed ? "platform" : "coach",
  });

  const offerFieldsReady = snapshot.offer.published
    && Boolean(snapshot.offer.programName?.trim())
    && Boolean(snapshot.offer.bookingMode?.trim());
  const offerReady = !snapshot.offerReadFailed
    && offerFieldsReady
    && snapshot.offer.reviewState === "clear";
  const offer = check({
    key: "published_offer_ready",
    ready: offerReady,
    code: snapshot.offerReadFailed || snapshot.offer.reviewState === "unavailable"
      ? "offer_review_contract_unavailable"
      : snapshot.offer.reviewState === "held"
        ? "offer_held"
      : !offerFieldsReady
        ? "published_offer_incomplete"
        : "published_offer_ready",
    evidenceAt: snapshot.offer.evidenceAt,
    blamingParty: snapshot.offer.reviewState === "held"
      || snapshot.offer.reviewState === "unavailable"
      || snapshot.offerReadFailed
      ? "platform"
      : "coach",
  });

  const brain = check({
    key: "platform_brain_published",
    ready: !snapshot.brainReadFailed && Boolean(snapshot.brainEvidenceAt),
    code: snapshot.brainReadFailed
      ? "brain_readiness_unavailable"
      : snapshot.brainEvidenceAt
        ? "platform_brain_published"
        : "platform_brain_publish_pending",
    evidenceAt: snapshot.brainEvidenceAt,
    blamingParty: "platform",
  });

  const testPassed = snapshot.testPass?.state === "done" && Boolean(snapshot.testPass.completedAt);
  const testPass = check({
    key: "test_passed",
    ready: !snapshot.testPassReadFailed && testPassed,
    code: snapshot.testPassReadFailed
      ? "test_readiness_unavailable"
      : testPassed
        ? "test_passed"
        : "test_pass_required",
    evidenceAt: snapshot.testPass?.completedAt,
    blamingParty: snapshot.testPassReadFailed ? "platform" : "coach",
  });

  const subscriptionModeMatches = snapshot.tenant?.isDemo
    ? snapshot.subscription.isDemo
    : !snapshot.subscription.isDemo;
  const subscriptionQualifies = ["active", "trialing", "past_due"].includes(
    snapshot.subscription.state,
  );
  const subscriptionFresh = recent(snapshot.subscription.evidenceAt, now);
  const subscriptionReady = !snapshot.subscriptionReadFailed
    && subscriptionModeMatches
    && subscriptionQualifies
    && subscriptionFresh;
  const subscription = check({
    key: "subscription_ready",
    ready: subscriptionReady,
    code: snapshot.subscriptionReadFailed || snapshot.subscription.state === "unavailable"
      ? "subscription_contract_unavailable"
      : !subscriptionModeMatches
        ? "subscription_evidence_mode_mismatch"
        : snapshot.subscription.state === "incomplete"
          ? "subscription_incomplete"
          : snapshot.subscription.state === "absent"
            ? "subscription_absent"
            : !subscriptionFresh
              ? "subscription_evidence_stale"
              : "subscription_ready",
    evidenceAt: snapshot.subscription.evidenceAt,
    blamingParty: snapshot.subscriptionReadFailed || snapshot.subscription.state === "unavailable"
      ? "platform"
      : "coach",
  });

  return [tenant, messaging, calendar, offer, brain, testPass, subscription];
}

function resultFrom(snapshot: ReadinessSnapshot, now: Date): ReadinessResult {
  const checks = readinessChecks(snapshot, now);
  if (checks.map((candidate) => candidate.key).join(",") !== READINESS_KEYS.join(",")) {
    throw new Error("READINESS_CHECK_SET_DRIFT");
  }
  return { ready: checks.every((candidate) => candidate.ready), checks };
}

export async function evaluateReadiness(
  tenantId: string,
  dependencies: ReadinessDependencies,
): Promise<ReadinessResult> {
  // `now` is read after the snapshot loads: the demo subscription port stamps its evidence
  // during the load, and a clock captured first would sit microseconds behind that stamp,
  // tripping the future-evidence guard in `recent` and reporting the demo as forever stale.
  const snapshot = await loadSnapshot(tenantId, dependencies);
  return resultFrom(snapshot, dependencies.now?.() ?? new Date());
}

function refusalCode(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.match(/(?:READINESS_[A-Z0-9_]+|subscription_contract_unavailable)/)?.[0] ?? null;
}

export async function commitGoLive(
  input: { tenantId: string; actorId: string },
  dependencies: ReadinessDependencies,
): Promise<
  | { kind: "live"; readiness: ReadinessResult; receipt: GoLiveReceipt }
  | { kind: "refused"; readiness: ReadinessResult; code: string }
> {
  // Same ordering as evaluateReadiness: the clock must postdate the snapshot's evidence stamps.
  const snapshot = await loadSnapshot(input.tenantId, dependencies);
  const now = dependencies.now?.() ?? new Date();
  const readiness = resultFrom(snapshot, now);
  if (!readiness.ready) {
    return {
      kind: "refused",
      readiness,
      code: readiness.checks.find((candidate) => !candidate.ready)!.code,
    };
  }
  try {
    const receipt = await dependencies.repository.goLive({
      tenantId: input.tenantId,
      actorId: input.actorId,
      offerReviewClear: snapshot.offer.reviewState === "clear",
      offerReviewEvidenceAt: snapshot.offer.evidenceAt!,
      subscriptionState: snapshot.subscription.state,
      subscriptionEvidenceAt: snapshot.subscription.evidenceAt!,
    });
    if (
      receipt.tenantId !== input.tenantId
      || !receipt.auditId.trim()
      || !receipt.wentLiveAt.trim()
    ) throw new Error("GO_LIVE_AUDIT_RECEIPT_REQUIRED");
    return { kind: "live", readiness, receipt };
  } catch (error) {
    const code = refusalCode(error);
    if (!code) throw error;
    return { kind: "refused", readiness, code };
  }
}

export function createDemoSubscriptionReadinessPort(
  now: () => Date = () => new Date(),
): SubscriptionReadinessPort {
  return async () => ({ state: "trialing", evidenceAt: now().toISOString(), isDemo: true });
}

function firstRow(value: unknown, code: string) {
  if (!Array.isArray(value) || !value[0] || typeof value[0] !== "object") throw new Error(code);
  return value[0] as Record<string, unknown>;
}

/** Production reads plus the exact six-argument Plan 05-01 go-live RPC. */
export function createLiveReadinessRepository(): ReadinessRepository {
  const client = createSupabaseServiceClient();
  return {
    loadTenant: async (tenantId) => {
      const { data, error } = await client
        .from("tenants")
        .select("status, is_demo, updated_at")
        .eq("id", tenantId)
        .maybeSingle();
      if (error) throw new Error(`READINESS_TENANT_READ_FAILED:${error.message}`);
      if (!data) return null;
      return {
        status: data.status,
        isDemo: data.is_demo,
        evidenceAt: data.updated_at,
      } as TenantReadinessEvidence;
    },
    loadMessagingConnections: async (tenantId) => {
      const { data, error } = await client
        .from("channel_connections")
        .select("channel, state, updated_at")
        .eq("tenant_id", tenantId)
        .in("channel", ["instagram", "messenger", "sms", "whatsapp", "webchat"]);
      if (error) throw new Error(`READINESS_CONNECTION_READ_FAILED:${error.message}`);
      return (data ?? []).map((row) => ({
        channel: row.channel,
        state: row.state,
        evidenceAt: row.updated_at,
      })) as MessagingReadinessEvidence[];
    },
    loadPrimaryCalendar: async (tenantId) => {
      const { data, error } = await client
        .from("calendar_connections")
        .select("state, last_slot_fetch_ok, last_slot_fetch_at")
        .eq("tenant_id", tenantId)
        .eq("is_primary", true)
        .maybeSingle();
      if (error) throw new Error(`READINESS_CALENDAR_READ_FAILED:${error.message}`);
      if (!data) return null;
      return {
        state: data.state,
        lastSlotFetchOk: data.last_slot_fetch_ok,
        lastSlotFetchAt: data.last_slot_fetch_at,
      };
    },
    loadPublishedBrainEvidence: async () => {
      // `brain_snapshots` stamps `published_at`; it has never had a `created_at` column
      // (20260818000001_phase2_brain.sql). Selecting the wrong name made PostgREST error, and
      // because the caller wraps this read in `settled()` the failure was swallowed into a
      // permanent `brain_readiness_unavailable` for every tenant, seeded or not.
      const { data, error } = await client
        .from("brain_snapshots")
        .select("published_at")
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`READINESS_BRAIN_READ_FAILED:${error.message}`);
      return data?.published_at ?? null;
    },
    loadTestPass: async (tenantId) => {
      const { data, error } = await client
        .from("provisioning_steps")
        .select("state, completed_at")
        .eq("tenant_id", tenantId)
        .eq("step_key", "test_pass")
        .maybeSingle();
      if (error) throw new Error(`READINESS_TEST_PASS_READ_FAILED:${error.message}`);
      if (!data) return null;
      return { state: data.state, completedAt: data.completed_at };
    },
    goLive: async (input) => {
      const { data, error } = await client.rpc("go_live_onboarding", {
        p_expected_tenant: input.tenantId,
        p_actor_id: input.actorId,
        p_offer_review_clear: input.offerReviewClear,
        p_offer_review_evidence_at: input.offerReviewEvidenceAt,
        p_subscription_state: input.subscriptionState,
        p_subscription_evidence_at: input.subscriptionEvidenceAt,
      });
      if (error) throw new Error(error.message);
      const row = firstRow(data, "GO_LIVE_AUDIT_RECEIPT_REQUIRED");
      return {
        tenantId: String(row.tenant_id ?? ""),
        auditId: String(row.audit_id ?? ""),
        wentLiveAt: String(row.went_live_at ?? ""),
      };
    },
  };
}
