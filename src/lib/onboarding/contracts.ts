/**
 * Closed onboarding contracts shared by the runner, lane executors, readiness service, and UI.
 *
 * Provider payloads and database rows are deliberately absent: every boundary returns normalized
 * evidence so only the runner can mutate provisioning state and the UI cannot infer readiness.
 */

export const PROVISIONING_STEPS = [
  "account",
  "billing",
  "ghl_location",
  "ghl_snapshot",
  "phone_number",
  "sms_eligibility_screen",
  "business_profile",
  "optin_artifact",
  "a2p_brand",
  "a2p_campaign",
  "sms_live",
  "meta_connect",
  "whatsapp_connect",
  "calendar_connect",
  "offer_layer",
  "test_pass",
  "go_live",
] as const;

export type ProvisioningStep = (typeof PROVISIONING_STEPS)[number];

export const PROVISIONING_STATES = [
  "pending",
  "running",
  "awaiting_coach",
  "awaiting_platform",
  "awaiting_provider",
  "done",
  "failed",
  "blocked",
] as const;

export type ProvisioningState = (typeof PROVISIONING_STATES)[number];

export const AWAITING_PARTIES = ["carrier", "meta", "google", "ghl", "stripe"] as const;
export type AwaitingParty = (typeof AWAITING_PARTIES)[number];

export type StepAttempt = {
  tenantId: string;
  stepKey: ProvisioningStep;
  attemptId: string;
  idempotencyKey: string;
  isDemo: boolean;
};

export type StepOutcome =
  | { kind: "done"; externalRef?: Record<string, unknown> }
  | { kind: "awaiting_coach" | "awaiting_platform"; code: string }
  | {
      kind: "awaiting_provider";
      party: AwaitingParty;
      externalRef?: Record<string, unknown>;
    }
  | { kind: "retryable_failure"; code: string; safeMessage: string }
  | { kind: "blocked"; code: string; safeMessage: string };

export type StepExecutor = (attempt: StepAttempt) => Promise<StepOutcome>;

export const READINESS_KEYS = [
  "tenant_active",
  "messaging_channel_live",
  "primary_calendar_healthy",
  "published_offer_ready",
  "platform_brain_published",
  "test_passed",
  "subscription_ready",
] as const;

export type ReadinessKey = (typeof READINESS_KEYS)[number];

/**
 * The carrier's own clock for A2P 10DLC vetting, in days, as a range rather than a promise.
 *
 * It lives here rather than beside a single screen because the number is a fact about the carriers
 * and not about any one surface: `CLAUDE.md` states the wait as two to three weeks per coach, and a
 * coach reading the onboarding journey and an operator reading provisioning must not be able to
 * read different numbers for the same registration. `coach-integrations.tsx`,
 * `admin-channel-health.tsx` and `admin-provisioning.tsx` each still declare their own copy of the
 * same pair; those three are owned by other surfaces this pass and should converge here.
 *
 * It is a range on purpose. `DayCounter` renders it as "typical 14 to 21 days" beside a real
 * elapsed count, never as a predicted completion date, because carriers supply no decision
 * schedule and a date we invented would be the exact completion theatre the honest-states rule in
 * `CLAUDE.md` forbids.
 */
export const CARRIER_TYPICAL_DAYS = [14, 21] as const;
export type ReadinessBlamingParty = "coach" | "platform" | "provider";

export type ReadinessCheck = {
  key: ReadinessKey;
  ready: boolean;
  code: string;
  evidenceAt: string | null;
  blamingParty: ReadinessBlamingParty;
};

export type ReadinessResult = {
  ready: boolean;
  checks: readonly ReadinessCheck[];
};

export type ProvisioningTrackerRow = {
  signupIntentId: string;
  tenantId: string | null;
  businessName: string | null;
  signupState: "started" | "completed" | "failed";
  currentStep: ProvisioningStep | null;
  state: ProvisioningState;
  attempts: number;
  errorCode: string | null;
  blockingParty: "coach" | "platform" | "provider" | "system";
  blockingProvider: AwaitingParty | null;
  stalledSince: string | null;
  isDemo: boolean | null;
  contentScreenId: string | null;
  contentScreenState: "clean" | "flagged" | "awaiting_admin" | "confirmed" | null;
};

export type OptInArtifactResult = {
  artifactId: string;
  templateVersion: string;
  contentHash: string;
  campaignDescriptionHash: string;
  placeholder: boolean;
  confirmedAt: string | null;
};

export type ContentScreenMatch = {
  phrase: string;
  page: string;
};

export type ContentScreenResult = {
  screenId: string;
  inputHash: string;
  state: "clean" | "flagged" | "confirmed";
  matches: readonly ContentScreenMatch[];
  coachAcknowledgedAt: string | null;
  adminConfirmedAt: string | null;
};

export type A2pProbeResult =
  | {
      kind: "delivered";
      probedAt: string;
      providerReference: string;
      targetHash: string;
    }
  | {
      kind: "inconclusive" | "retryable_failure";
      probedAt: string;
      code: string;
      targetHash: string;
    }
  | {
      kind: "terminal_refusal";
      probedAt: string;
      code: string;
      safeMessage: string;
      targetHash: string;
    };

export type SubscriptionReadinessState =
  | "active"
  | "trialing"
  | "past_due"
  | "incomplete"
  | "absent"
  | "unavailable";

export type SubscriptionReadinessResult = {
  state: SubscriptionReadinessState;
  evidenceAt: string | null;
  isDemo: boolean;
};

export type SubscriptionReadinessPort = (
  tenantId: string,
) => Promise<SubscriptionReadinessResult>;

export type OfferReadinessResult = {
  published: boolean;
  programName: string | null;
  bookingMode: string | null;
  /**
   * `held` is the compatibility state consumed by the provisioning lane. The offer-review
   * authority keeps the more precise unreviewed/rejected distinction in its own records; neither
   * is allowed to satisfy this gate.
   */
  reviewState: "clear" | "held" | "unavailable";
  evidenceAt: string | null;
};

export type OfferReadinessPort = (tenantId: string) => Promise<OfferReadinessResult>;
