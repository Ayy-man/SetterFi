/**
 * Receipt-checked persistence for human billing operations and subscription readiness.
 *
 * Financial writes stay behind named RPCs. The service-role paths carry the already-authenticated
 * actor id into SQL, where the actor row and role are checked again before any mutation commits.
 */

import {
  createSupabaseServerClient,
  createSupabaseServiceClient,
} from "@/lib/supabase/server";
import type {
  CheckoutTenant,
  CheckoutTierPrice,
  PersistedCheckoutSession,
} from "@/lib/billing/subscriptions";
import { isCurrentBillingPeriod } from "@/lib/billing/current-period";
import type { SubscriptionCheckoutResult } from "@/lib/integrations/stripe/types";

export type BillingCorrectionProjection = {
  requestId: string;
  tenantId: string;
  /**
   * The coach the dispute is against. The admin queue cannot be acted on without it -- two
   * requests of the same shape are indistinguishable by request type alone -- so it is read from
   * the tenant row rather than left to the screen to invent. Null only where the embed is absent.
   */
  businessName: string | null;
  /**
   * "Demo" when the disputing coach is a seeded workspace, null when they are a real one.
   *
   * Every other Money row carries this and the correction queue did not, which made it the one
   * surface in the group that could not keep "test data is labelled as such on-screen" -- on the
   * surface where the consequence is a credit against a real ledger, since approving a dispute
   * moves money. It reads off the `tenants` embed the projection already joined for `businessName`.
   */
  dataLabel: string | null;
  /**
   * Null on a period-level request (`request_period_billing_correction`): a coach describing a
   * problem in words against the whole billing period, not one billable event. Exactly one of
   * (`billableEventId`, `quantityDelta`) or (`periodStart`, `periodEnd`) is populated, matching the
   * database's own `billing_correction_requests_shape_chk`.
   */
  billableEventId: string | null;
  quantityDelta: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  reason: string;
  requestedAt: string;
  requestAuditId: number;
  decision: "approved" | "rejected" | null;
  decisionId: string | null;
  /**
   * The deciding admin's own words, from `billing_correction_decisions.reason`. The column is
   * `not null` with a non-blank check, so a decided request always has one; the projection had
   * simply never selected it, which left the admin queue deriving "what did we decide" from the
   * enum alone while the reason sat one join away.
   */
  decisionReason: string | null;
  decisionAuditId: number | null;
  offsetEventId: string | null;
};

export type BillingSubscriptionReadback = {
  tenantId: string;
  status: string;
  evidenceAt: string;
  isDemo: boolean;
} | null;

export type CoachBillingRead = {
  tierName: string;
  priceCents: number;
  currency: "USD";
  periodStart: string;
  periodEnd: string;
  timezone: string;
  bookedCount: number;
  callAllowance: number;
  subscriptionState: string;
  invoiceState: string;
  accountState: "onboarding" | "active" | "paused" | "overdue" | "suspended" | "churned";
  pendingMovement: { tierName: string; priceCents: number; effectiveAt: string } | null;
  notices: readonly {
    id: string;
    kind: "warning" | "crossing";
    state: "queued" | "pending" | "sent";
    deliveryReceiptId: string | null;
    billingContactSource: string;
  }[];
  correctionCandidates: readonly { eventId: string; label: string }[];
  outcomePrompts: readonly { appointmentId: string; label: string; occurredAt: string }[];
  /**
   * Recent bookings in the current period whose attendance has already been answered
   * (`appointment.attendance_source is not null`), the opposite state from `outcomePrompts`. Round
   * 3 backend gap: the attendance panel could only show the unanswered queue, never a booking the
   * coach already settled.
   */
  settledAttendance: readonly {
    appointmentId: string;
    label: string;
    occurredAt: string;
    outcome: "completed" | "no_show";
  }[];
  isDemo: boolean;
};

export type SkippedAttendanceReceipt = {
  appointment: {
    id: string;
    attendanceState: "skipped";
  };
  auditId: number;
};

/**
 * `tier_reassignment` is permanent: `billing_subscriptions` holds one row per tenant
 * (`billing_subscriptions_tenant_key`, `phase6_money.sql:55`) and `record_subscription_mirror`
 * overwrites `stripe_price_id` in place (`phase6_money.sql:690`), so the Stripe Price a tenant
 * was on before a tier change is not persisted anywhere and can never be reconstructed.
 */
export type MrrMovementMissingSource =
  | "tier_reassignment"
  | "unpriced_tenant"
  | "unpriced_at_window_start";

export type MrrMovementRead = {
  asOf: string;
  windowStart: string;
  mrrCents: number | null;
  clientCount: number;
  newCents: number | null;
  upgradeCents: number | null;
  churnCents: number | null;
  downgradeCents: number | null;
  scheduledCancellations: number;
  missingSources: readonly MrrMovementMissingSource[];
};

export type MoneyMrrPeriod = {
  periodStart: string;
  periodEnd: string;
  mrrCents: number | null;
};

/**
 * The server-side billing read used by the Money page's MRR chart and client rows.
 *
 * `status` remains the provider's raw subscription state.  `countsAsLive` deliberately has a
 * narrower meaning: only a receipt whose status is exactly `active` counts as live MRR.
 */
export type MoneyBillingRead = {
  mrrByPeriod: readonly MoneyMrrPeriod[];
  rows: readonly {
    tenantId: string;
    businessName: string;
    accountStatus: string;
    subscriptionStatus: string;
    providerUpdatedAt: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    pendingTierId: string | null;
    pendingEffectiveAt: string | null;
    dataLabel: string | null;
    plan: string | null;
    monthlyAmountCents: number | null;
    status: string;
    countsAsLive: boolean;
  }[];
};

/**
 * One row of the Money page's Subscriptions table, in the shape the table's own normaliser reads.
 *
 * The table used to feed itself from `/api/exports/platform-billing` after hydration, which cost a
 * client round trip and two `export.*` audit writes on every page view, for a read no one had
 * asked to export. The projection moved here so the page can render the table in its first HTML;
 * the export route keeps its own copy of the same shape for the file a reader actually downloads.
 */
export type MoneySubscriptionRow = {
  tenantId: string;
  businessName: string;
  accountStatus: string;
  subscriptionStatus: string | null;
  providerUpdatedAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  pendingTierId: string | null;
  pendingEffectiveAt: string | null;
  dataLabel: string | null;
};

/**
 * One cost rollup, in the shape `normalizeCostRows` on the Costs surface already reads.
 *
 * Same reasoning as `MoneySubscriptionRow` one level down: the Costs table and the per-client Cost
 * tab both used to call `/api/exports/billing-cost-rollups` from an effect, which spent a client
 * round trip and filed a `start_platform_export` and a `finish_export` receipt for a download
 * nobody had asked for. The export route keeps its own copy of this projection for the file a
 * reader actually downloads; this one exists so the server can hand the rows to the page.
 */
export type MoneyCostRollupRow = {
  rollupId: string;
  tenantId: string;
  businessName: string;
  windowStart: string | null;
  windowEnd: string | null;
  revenueCents: number | null;
  modelCostCents: number | null;
  messagingCostCents: number | null;
  embeddingCostCents: number | null;
  complete: boolean;
  missingSources: string | null;
  sourceEvidenceAt: string | null;
  dataLabel: string | null;
};

export type BillingRepository = {
  updateTier(input: {
    actorId: string;
    tierId: string;
    priceCents: number;
    callAllowance: number;
    fairUseCap: number | null;
    fairUseNote: string | null;
    reason: string;
  }): Promise<{ priceVersionId: string; auditId: number }>;
  setTenantOverride(input: {
    actorId: string;
    tenantId: string;
    priceCents: number;
    effectiveAt: string;
    endsAt: string | null;
    reason: string;
  }): Promise<{ overrideId: string; auditId: number }>;
  requestCorrection(input: {
    tenantId: string;
    eventId: string;
    quantityDelta: number;
    reason: string;
  }): Promise<{ requestId: string; auditId: number }>;
  /**
   * A period-level correction: a coach describing the problem in words against the current
   * billing period, with no event and no quantity delta. `decide_billable_correction` refuses to
   * decide the resulting request (`BILLING_CORRECTION_PERIOD_LEVEL_DECISION_NOT_SUPPORTED`) --
   * deciding one needs its own round, see the migration's own comment.
   */
  requestPeriodCorrection(input: {
    tenantId: string;
    reason: string;
  }): Promise<{ requestId: string; auditId: number }>;
  decideCorrection(input: {
    actorId: string;
    tenantId: string;
    requestId: string;
    decision: "approved" | "rejected";
    reason: string;
  }): Promise<{
    decisionId: string;
    offsetEventId: string | null;
    requestAuditId: number;
    decisionAuditId: number;
  }>;
  setTenantStatus(input: {
    actorId: string;
    tenantId: string;
    status: "active" | "overdue" | "suspended";
    reason: string;
  }): Promise<{
    tenantId: string;
    previousStatus: "active" | "overdue" | "suspended";
    status: "active" | "overdue" | "suspended";
    auditId: number;
  }>;
  recordAttendance(input: {
    actorId: string;
    tenantId: string;
    appointmentId: string;
    status: "completed" | "no_show";
  }): Promise<{ auditId: number; billableQuantity: number }>;
  skipAttendance(input: {
    actorId: string;
    tenantId: string;
    appointmentId: string;
    idempotencyKey: string;
  }): Promise<SkippedAttendanceReceipt>;
  listCorrections(): Promise<readonly BillingCorrectionProjection[]>;
  loadOwnBilling(tenantId: string, asOf?: Date): Promise<CoachBillingRead | null>;
  loadMrrMovement(asOf: string): Promise<MrrMovementRead>;
  loadMoneyBilling(asOf: string): Promise<MoneyBillingRead>;
  loadSubscriptionRows(): Promise<readonly MoneySubscriptionRow[]>;
  loadCostRollupRows(): Promise<readonly MoneyCostRollupRow[]>;
  loadSubscription(tenantId: string): Promise<BillingSubscriptionReadback>;
  loadCheckoutTenant(tenantId: string): Promise<CheckoutTenant | null>;
  loadCheckoutTierPrices(tierId: string): Promise<readonly CheckoutTierPrice[]>;
  listAllowedPriceIds(): Promise<ReadonlySet<string>>;
  persistCheckout(input: {
    actorId: string;
    tenantId: string;
    tierId: string;
    priceId: string;
    idempotencyKey: string;
    provider: SubscriptionCheckoutResult;
  }): Promise<PersistedCheckoutSession | null>;
};

export type BillingRepositoryDependencies = {
  serviceRpc(name: string, args: Record<string, unknown>): Promise<unknown>;
  userRpc(name: string, args: Record<string, unknown>): Promise<unknown>;
  readTierVersion(id: string, auditId: number): Promise<Record<string, unknown> | null>;
  readOverride(id: string, auditId: number): Promise<Record<string, unknown> | null>;
  readCorrectionRequest(id: string, auditId?: number): Promise<Record<string, unknown> | null>;
  readCorrectionDecision(id: string, auditId: number): Promise<Record<string, unknown> | null>;
  readTenantStatus(tenantId: string): Promise<Record<string, unknown> | null>;
  readAttendance(input: {
    tenantId: string;
    appointmentId: string;
    auditId: number;
  }): Promise<Record<string, unknown> | null>;
  findSkippedAttendance?(input: {
    tenantId: string;
    appointmentId: string;
    idempotencyKey: string;
  }): Promise<Record<string, unknown> | null>;
  validateSkippedAttendance?(input: {
    tenantId: string;
    appointmentId: string;
  }): Promise<void>;
  releaseSkippedAttendanceClaim?(input: {
    tenantId: string;
    appointmentId: string;
    idempotencyKey: string;
  }): Promise<void>;
  writeSkippedAttendance?(input: {
    actorId: string;
    tenantId: string;
    appointmentId: string;
    idempotencyKey: string;
  }): Promise<Record<string, unknown>>;
  listSkippedAppointmentIds?(tenantId: string): Promise<readonly string[]>;
  projectCorrections(): Promise<unknown>;
  projectOwnBilling(tenantId: string): Promise<unknown>;
  readMovementSources(asOf: string): Promise<{
    subscriptions: unknown;
    tierPriceVersions: unknown;
    tenantPriceOverrides: unknown;
  }>;
  readMoneyBilling(asOf: string): Promise<unknown>;
  readSubscriptionRows(): Promise<unknown>;
  readCostRollupRows(): Promise<unknown>;
  readSubscription(tenantId: string): Promise<Record<string, unknown> | null>;
  readCheckoutTenant(tenantId: string): Promise<Record<string, unknown> | null>;
  readCheckoutTierPrices(tierId: string): Promise<unknown>;
  readAllowedPrices(): Promise<unknown>;
  readCheckoutSession(input: {
    checkoutSessionId: string;
    tenantId: string;
    tierId: string;
  }): Promise<Record<string, unknown> | null>;
};

export class BillingRepositoryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BillingRepositoryError";
  }
}

function row(value: unknown, code: string): Record<string, unknown> {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new BillingRepositoryError(code);
  }
  return candidate as Record<string, unknown>;
}

function integer(value: unknown, code: string) {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) {
    throw new BillingRepositoryError(code);
  }
  return parsed;
}

function string(value: unknown, code: string) {
  if (typeof value !== "string" || !value.trim()) throw new BillingRepositoryError(code);
  return value;
}

/**
 * The coach name off the embedded tenant row. PostgREST returns a to-one embed as an object, or as
 * a one-element array under some client versions, and null when the join found nothing. A missing
 * name is left null so the screen can say the name is not recorded rather than invent one.
 */
function correctionBusinessName(value: unknown): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || typeof candidate !== "object") return null;
  const name = (candidate as Record<string, unknown>).name;
  return typeof name === "string" && name.trim() ? name : null;
}

/**
 * Whether the coach this dispute is against is a seeded workspace.
 *
 * Reads `is_demo` off the same joined `tenants` row `correctionBusinessName` above reads `name`
 * from, which is the whole reason this was cheap: the join was always there. It was filed as
 * blocked for four audit rounds on a grep for `is_demo` that returned nothing, when what was
 * missing was one column on an existing select rather than a query nobody had written.
 *
 * "Demo" or null, matching `dataLabel()` in the export handler and the `dataLabel` field every
 * other Money row already carries. There is no "Test" arm because `tenants` has no `is_test` --
 * that column lives on contact rows -- and inventing a second word here would put two vocabularies
 * on one queue.
 *
 * Absent rather than false when the tenant row could not be read: an unlabelled row reads as real,
 * so if this ever cannot tell, the honest direction is the one that says nothing rather than the
 * one that asserts the dispute is genuine.
 */
function correctionSeedLabel(value: unknown): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || typeof candidate !== "object") return null;
  return (candidate as Record<string, unknown>).is_demo === true ? "Demo" : null;
}

function nullableString(value: unknown, code: string) {
  if (value === null) return null;
  return string(value, code);
}

function array(value: unknown, code: string) {
  if (!Array.isArray(value)) throw new BillingRepositoryError(code);
  return value;
}

function skippedAttendanceReceipt(
  value: unknown,
  expected: { tenantId: string; appointmentId: string; idempotencyKey: string },
): SkippedAttendanceReceipt {
  const persisted = row(value, "ATTENDANCE_SKIP_READBACK_INVALID");
  const payload = row(persisted.payload, "ATTENDANCE_SKIP_READBACK_INVALID");
  const auditId = integer(persisted.id, "ATTENDANCE_SKIP_READBACK_INVALID");
  if (
    persisted.tenant_id !== expected.tenantId
    || persisted.action !== "appointment.attendance_set"
    || persisted.target_type !== "appointment"
    || persisted.target_id !== expected.appointmentId
    || payload.attendance_state !== "skipped"
    || payload.value !== "skipped"
    || payload.idempotency_key !== expected.idempotencyKey
  ) throw new BillingRepositoryError("ATTENDANCE_SKIP_READBACK_MISMATCH");
  return {
    appointment: { id: expected.appointmentId, attendanceState: "skipped" },
    auditId,
  };
}

function skippedAttendanceClaimKey(input: {
  tenantId: string;
  appointmentId: string;
  idempotencyKey: string;
}) {
  return [
    "billing-attendance-skip",
    input.tenantId,
    input.appointmentId,
    input.idempotencyKey,
  ].map(encodeURIComponent).join(":");
}

async function waitForSkippedAttendance(
  find: NonNullable<BillingRepositoryDependencies["findSkippedAttendance"]>,
  expected: { tenantId: string; appointmentId: string; idempotencyKey: string },
) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const persisted = await find(expected);
    if (persisted) return persisted;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

async function claimSkippedAttendance(
  deps: BillingRepositoryDependencies,
  input: { tenantId: string; appointmentId: string; idempotencyKey: string },
) {
  // The existing database limiter owns a persisted row and locks it in one transaction. A
  // max-int window makes this namespaced key durable; a failed audit write releases the claim.
  const claim = row(await deps.serviceRpc("consume_rate_limit", {
    p_key: skippedAttendanceClaimKey(input),
    p_limit: 1,
    p_window_seconds: 2_147_483_647,
    p_now: new Date().toISOString(),
  }), "ATTENDANCE_SKIP_CLAIM_INVALID");
  if (typeof claim.allowed !== "boolean") {
    throw new BillingRepositoryError("ATTENDANCE_SKIP_CLAIM_INVALID");
  }
  return claim.allowed;
}

const COACH_BILLING_KEYS = [
  "account_state", "booked_count", "call_allowance", "correction_candidates",
  "invoice_state", "is_demo", "notices", "outcome_prompts", "pending_effective_at",
  "pending_price_cents", "pending_tier_name", "period_end", "period_start", "price_cents",
  "settled_attendance", "subscription_state", "tier_name", "timezone",
] as const;

function parseCoachBilling(value: unknown): CoachBillingRead | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate === undefined || candidate === null) return null;
  const projection = row(candidate, "COACH_BILLING_PROJECTION_INVALID");
  if (Object.keys(projection).sort().join(",") !== COACH_BILLING_KEYS.join(",")) {
    throw new BillingRepositoryError("COACH_BILLING_PROJECTION_INVALID");
  }
  const accountState = string(
    projection.account_state,
    "COACH_BILLING_PROJECTION_INVALID",
  ) as CoachBillingRead["accountState"];
  if (!["onboarding", "active", "paused", "overdue", "suspended", "churned"].includes(accountState)) {
    throw new BillingRepositoryError("COACH_BILLING_PROJECTION_INVALID");
  }
  const pendingTierName = nullableString(
    projection.pending_tier_name,
    "COACH_BILLING_PROJECTION_INVALID",
  );
  const pendingPriceCents = projection.pending_price_cents === null
    ? null
    : integer(projection.pending_price_cents, "COACH_BILLING_PROJECTION_INVALID");
  const pendingEffectiveAt = nullableString(
    projection.pending_effective_at,
    "COACH_BILLING_PROJECTION_INVALID",
  );
  if ([pendingTierName, pendingPriceCents, pendingEffectiveAt].filter((item) => item !== null).length
    % 3 !== 0) {
    throw new BillingRepositoryError("COACH_BILLING_PROJECTION_INVALID");
  }
  const notices = array(projection.notices, "COACH_BILLING_PROJECTION_INVALID").map((value) => {
    const notice = row(value, "COACH_BILLING_PROJECTION_INVALID");
    if (
      Object.keys(notice).sort().join(",")
        !== "billingContactSource,deliveryReceiptId,id,kind,state"
      || !["warning", "crossing"].includes(String(notice.kind))
      || !["queued", "pending", "sent"].includes(String(notice.state))
    ) throw new BillingRepositoryError("COACH_BILLING_PROJECTION_INVALID");
    return {
      id: string(notice.id, "COACH_BILLING_PROJECTION_INVALID"),
      kind: notice.kind as "warning" | "crossing",
      state: notice.state as "queued" | "pending" | "sent",
      deliveryReceiptId: nullableString(
        notice.deliveryReceiptId,
        "COACH_BILLING_PROJECTION_INVALID",
      ),
      billingContactSource: string(
        notice.billingContactSource,
        "COACH_BILLING_PROJECTION_INVALID",
      ),
    };
  });
  const correctionCandidates = array(
    projection.correction_candidates,
    "COACH_BILLING_PROJECTION_INVALID",
  ).map((value) => {
    const correction = row(value, "COACH_BILLING_PROJECTION_INVALID");
    if (Object.keys(correction).sort().join(",") !== "eventId,label") {
      throw new BillingRepositoryError("COACH_BILLING_PROJECTION_INVALID");
    }
    return {
      eventId: string(correction.eventId, "COACH_BILLING_PROJECTION_INVALID"),
      label: string(correction.label, "COACH_BILLING_PROJECTION_INVALID"),
    };
  });
  const outcomePrompts = array(
    projection.outcome_prompts,
    "COACH_BILLING_PROJECTION_INVALID",
  ).map((value) => {
    const prompt = row(value, "COACH_BILLING_PROJECTION_INVALID");
    if (Object.keys(prompt).sort().join(",") !== "appointmentId,label,occurredAt") {
      throw new BillingRepositoryError("COACH_BILLING_PROJECTION_INVALID");
    }
    return {
      appointmentId: string(prompt.appointmentId, "COACH_BILLING_PROJECTION_INVALID"),
      label: string(prompt.label, "COACH_BILLING_PROJECTION_INVALID"),
      occurredAt: string(prompt.occurredAt, "COACH_BILLING_PROJECTION_INVALID"),
    };
  });
  const settledAttendance = array(
    projection.settled_attendance,
    "COACH_BILLING_PROJECTION_INVALID",
  ).map((value) => {
    const settled = row(value, "COACH_BILLING_PROJECTION_INVALID");
    if (
      Object.keys(settled).sort().join(",") !== "appointmentId,label,occurredAt,outcome"
      || (settled.outcome !== "completed" && settled.outcome !== "no_show")
    ) {
      throw new BillingRepositoryError("COACH_BILLING_PROJECTION_INVALID");
    }
    return {
      appointmentId: string(settled.appointmentId, "COACH_BILLING_PROJECTION_INVALID"),
      label: string(settled.label, "COACH_BILLING_PROJECTION_INVALID"),
      occurredAt: string(settled.occurredAt, "COACH_BILLING_PROJECTION_INVALID"),
      outcome: settled.outcome as "completed" | "no_show",
    };
  });
  if (typeof projection.is_demo !== "boolean") {
    throw new BillingRepositoryError("COACH_BILLING_PROJECTION_INVALID");
  }
  return {
    tierName: string(projection.tier_name, "COACH_BILLING_PROJECTION_INVALID"),
    priceCents: integer(projection.price_cents, "COACH_BILLING_PROJECTION_INVALID"),
    currency: "USD",
    periodStart: string(projection.period_start, "COACH_BILLING_PROJECTION_INVALID"),
    periodEnd: string(projection.period_end, "COACH_BILLING_PROJECTION_INVALID"),
    timezone: string(projection.timezone, "COACH_BILLING_PROJECTION_INVALID"),
    bookedCount: integer(projection.booked_count, "COACH_BILLING_PROJECTION_INVALID"),
    callAllowance: integer(projection.call_allowance, "COACH_BILLING_PROJECTION_INVALID"),
    subscriptionState: string(
      projection.subscription_state,
      "COACH_BILLING_PROJECTION_INVALID",
    ),
    invoiceState: string(projection.invoice_state, "COACH_BILLING_PROJECTION_INVALID"),
    accountState,
    pendingMovement: pendingTierName && pendingPriceCents !== null && pendingEffectiveAt
      ? { tierName: pendingTierName, priceCents: pendingPriceCents, effectiveAt: pendingEffectiveAt }
      : null,
    notices,
    correctionCandidates,
    outcomePrompts,
    settledAttendance,
    isDemo: projection.is_demo,
  };
}

const MOVEMENT_INVALID = "BILLING_MOVEMENT_SOURCE_INVALID";
const MOVEMENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MOVEMENT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const MOVEMENT_SUBSCRIPTION_KEYS = [
  "cancel_at_period_end", "created_at", "current_period_end", "current_period_start",
  "provider_updated_at", "status", "stripe_price_id", "subscription_id", "tenant_id", "tier_id",
].join(",");
const MOVEMENT_VERSION_KEYS = ["effective_at", "price_cents", "price_version_id", "tier_id"].join(",");
const MOVEMENT_OVERRIDE_KEYS = [
  "effective_at", "ends_at", "override_id", "price_cents", "tenant_id",
].join(",");

type MovementSubscription = {
  tenantId: string;
  tierId: string | null;
  status: string;
  periodStart: number;
  periodEnd: number;
  cancelAtPeriodEnd: boolean;
  providerUpdatedAt: number;
  createdAt: number;
};

type MovementPriceVersion = { tierId: string; priceCents: number; effectiveAt: number };
type MovementOverride = {
  tenantId: string;
  priceCents: number;
  effectiveAt: number;
  endsAt: number | null;
};

function instant(value: unknown, code: string) {
  const parsed = Date.parse(string(value, code));
  if (!Number.isFinite(parsed)) throw new BillingRepositoryError(code);
  return parsed;
}

function exactly(candidate: Record<string, unknown>, keys: string, code = MOVEMENT_INVALID) {
  if (Object.keys(candidate).sort().join(",") !== keys) {
    throw new BillingRepositoryError(code);
  }
  return candidate;
}

function parseMovementSources(sources: {
  subscriptions: unknown;
  tierPriceVersions: unknown;
  tenantPriceOverrides: unknown;
}) {
  const subscriptions = array(sources.subscriptions, MOVEMENT_INVALID).map((value) => {
    const persisted = exactly(row(value, MOVEMENT_INVALID), MOVEMENT_SUBSCRIPTION_KEYS);
    if (typeof persisted.cancel_at_period_end !== "boolean") {
      throw new BillingRepositoryError(MOVEMENT_INVALID);
    }
    return {
      tenantId: string(persisted.tenant_id, MOVEMENT_INVALID),
      tierId: nullableString(persisted.tier_id, MOVEMENT_INVALID),
      status: string(persisted.status, MOVEMENT_INVALID),
      periodStart: instant(persisted.current_period_start, MOVEMENT_INVALID),
      periodEnd: instant(persisted.current_period_end, MOVEMENT_INVALID),
      cancelAtPeriodEnd: persisted.cancel_at_period_end,
      providerUpdatedAt: instant(persisted.provider_updated_at, MOVEMENT_INVALID),
      createdAt: instant(persisted.created_at, MOVEMENT_INVALID),
    } satisfies MovementSubscription;
  });
  const tierPriceVersions = array(sources.tierPriceVersions, MOVEMENT_INVALID).map((value) => {
    const persisted = exactly(row(value, MOVEMENT_INVALID), MOVEMENT_VERSION_KEYS);
    return {
      tierId: string(persisted.tier_id, MOVEMENT_INVALID),
      priceCents: integer(persisted.price_cents, MOVEMENT_INVALID),
      effectiveAt: instant(persisted.effective_at, MOVEMENT_INVALID),
    } satisfies MovementPriceVersion;
  });
  const tenantPriceOverrides = array(sources.tenantPriceOverrides, MOVEMENT_INVALID).map((value) => {
    const persisted = exactly(row(value, MOVEMENT_INVALID), MOVEMENT_OVERRIDE_KEYS);
    return {
      tenantId: string(persisted.tenant_id, MOVEMENT_INVALID),
      priceCents: integer(persisted.price_cents, MOVEMENT_INVALID),
      effectiveAt: instant(persisted.effective_at, MOVEMENT_INVALID),
      endsAt: persisted.ends_at === null ? null : instant(persisted.ends_at, MOVEMENT_INVALID),
    } satisfies MovementOverride;
  });
  return { subscriptions, tierPriceVersions, tenantPriceOverrides };
}

/**
 * A direct port of the `priced` CTE at `phase7_measurement.sql:283-305`: the latest live tenant
 * override wins, then the latest tier price version, then nothing. An unresolved price is `null`
 * and never zero, a tenant whose Stripe Price matches no tier carries `tierId === null`, and the
 * view's own comment says gross MRR is unavailable instead of guessed.
 */
function priceAt(
  versions: readonly MovementPriceVersion[],
  overrides: readonly MovementOverride[],
  tenantId: string,
  tierId: string | null,
  at: number,
): number | null {
  let override: MovementOverride | null = null;
  for (const candidate of overrides) {
    if (candidate.tenantId !== tenantId) continue;
    if (candidate.effectiveAt > at) continue;
    if (candidate.endsAt !== null && candidate.endsAt <= at) continue;
    if (!override || candidate.effectiveAt > override.effectiveAt) override = candidate;
  }
  if (override) return override.priceCents;
  if (tierId === null) return null;
  let version: MovementPriceVersion | null = null;
  for (const candidate of versions) {
    if (candidate.tierId !== tierId) continue;
    if (candidate.effectiveAt > at) continue;
    if (!version || candidate.effectiveAt > version.effectiveAt) version = candidate;
  }
  return version ? version.priceCents : null;
}

function projectMrrMovement(asOf: string, sources: {
  subscriptions: unknown;
  tierPriceVersions: unknown;
  tenantPriceOverrides: unknown;
}): MrrMovementRead {
  if (!MOVEMENT_ISO.test(asOf)) throw new BillingRepositoryError("BILLING_MOVEMENT_AS_OF_INVALID");
  const asOfMs = instant(asOf, "BILLING_MOVEMENT_AS_OF_INVALID");
  const windowStartMs = asOfMs - MOVEMENT_WINDOW_MS;
  const { subscriptions, tierPriceVersions, tenantPriceOverrides } = parseMovementSources(sources);
  // The gap is structural, so it is named on every call rather than computed.
  const missing = new Set<MrrMovementMissingSource>(["tier_reassignment"]);
  const price = (subscription: MovementSubscription, at: number) => priceAt(
    tierPriceVersions,
    tenantPriceOverrides,
    subscription.tenantId,
    subscription.tierId,
    at,
  );

  const live = subscriptions.filter((subscription) =>
    (subscription.status === "active" || subscription.status === "trialing")
    && subscription.periodStart <= asOfMs && subscription.periodEnd > asOfMs);

  let mrrCents: number | null = 0;
  for (const subscription of live) {
    const resolved = price(subscription, asOfMs);
    if (resolved === null) {
      missing.add("unpriced_tenant");
      mrrCents = null;
      continue;
    }
    if (mrrCents !== null) mrrCents += resolved;
  }

  let newCents: number | null = 0;
  let upgradeCents = 0;
  let downgradeCents = 0;
  for (const subscription of live) {
    // A cancellation that has not taken effect has not happened, so it moves none of the four.
    if (subscription.cancelAtPeriodEnd) continue;
    if (subscription.createdAt >= windowStartMs && subscription.createdAt < asOfMs) {
      const resolved = price(subscription, asOfMs);
      if (resolved === null) {
        missing.add("unpriced_tenant");
        newCents = null;
        continue;
      }
      if (newCents !== null) newCents += resolved;
      continue;
    }
    const now = price(subscription, asOfMs);
    const before = price(subscription, windowStartMs);
    if (now === null || before === null) {
      missing.add("unpriced_at_window_start");
      continue;
    }
    const delta = now - before;
    if (delta > 0) upgradeCents += delta;
    if (delta < 0) downgradeCents += delta;
  }

  let churnCents: number | null = 0;
  for (const subscription of subscriptions) {
    // `provider_updated_at` is the last provider snapshot of any kind rather than a cancel-specific
    // timestamp; for a canceled subscription no later snapshot arrives, so in practice it is the
    // cancellation instant. A `cancel_at_period_end` flag on a canceled row records how the
    // cancellation was requested, not that it is still pending, the row is gone either way.
    if (subscription.status !== "canceled") continue;
    if (subscription.providerUpdatedAt < windowStartMs) continue;
    if (subscription.providerUpdatedAt >= asOfMs) continue;
    const resolved = price(subscription, subscription.providerUpdatedAt);
    if (resolved === null) {
      missing.add("unpriced_tenant");
      churnCents = null;
      continue;
    }
    if (churnCents !== null) churnCents -= resolved;
  }

  return {
    asOf,
    windowStart: new Date(windowStartMs).toISOString(),
    mrrCents,
    clientCount: live.length,
    newCents,
    upgradeCents,
    churnCents,
    downgradeCents,
    scheduledCancellations: live.filter((subscription) => subscription.cancelAtPeriodEnd).length,
    missingSources: [...missing].sort(),
  };
}

const MONEY_BILLING_KEYS = ["mrrByPeriod", "rows"].join(",");
const MONEY_MRR_PERIOD_KEYS = ["mrrCents", "periodEnd", "periodStart"].join(",");
const MONEY_BILLING_ROW_KEYS = [
  "accountStatus", "businessName", "cancelAtPeriodEnd", "countsAsLive", "currentPeriodEnd",
  "dataLabel", "isDemo", "isTest", "monthlyAmountCents", "pendingEffectiveAt", "pendingTierId",
  "plan", "providerUpdatedAt", "status", "subscriptionStatus", "tenantId",
].join(",");

function nullableInteger(value: unknown, code: string) {
  return value === null ? null : integer(value, code);
}

function parseMoneyBilling(value: unknown): MoneyBillingRead {
  const result = exactly(row(value, "MONEY_BILLING_READ_INVALID"), MONEY_BILLING_KEYS, "MONEY_BILLING_READ_INVALID");
  const mrrByPeriod = array(result.mrrByPeriod, "MONEY_BILLING_READ_INVALID").map((value) => {
    const period = exactly(row(value, "MONEY_BILLING_READ_INVALID"), MONEY_MRR_PERIOD_KEYS, "MONEY_BILLING_READ_INVALID");
    const periodStart = string(period.periodStart, "MONEY_BILLING_READ_INVALID");
    const periodEnd = string(period.periodEnd, "MONEY_BILLING_READ_INVALID");
    const periodStartAt = Date.parse(periodStart);
    const periodEndAt = Date.parse(periodEnd);
    if (!Number.isFinite(periodStartAt) || !Number.isFinite(periodEndAt) || periodEndAt <= periodStartAt) {
      throw new BillingRepositoryError("MONEY_BILLING_READ_INVALID");
    }
    return {
      periodStart,
      periodEnd,
      mrrCents: nullableInteger(period.mrrCents, "MONEY_BILLING_READ_INVALID"),
    };
  });
  if (mrrByPeriod.length !== 12) throw new BillingRepositoryError("MONEY_BILLING_READ_INVALID");

  const rows = array(result.rows, "MONEY_BILLING_READ_INVALID").flatMap((value) => {
    const persisted = exactly(row(value, "MONEY_BILLING_READ_INVALID"), MONEY_BILLING_ROW_KEYS, "MONEY_BILLING_READ_INVALID");
    if (typeof persisted.isTest !== "boolean" || typeof persisted.isDemo !== "boolean") {
      throw new BillingRepositoryError("MONEY_BILLING_READ_INVALID");
    }
    // A test row inside a real tenant never reaches Money, whatever the projection returned. A
    // demo tenant's rows do reach it when the database's platform_demo_visible() switch admitted
    // them (20261011000002): that is the only way the RPC ever returns one, so the row is kept and
    // labelled rather than dropped, and the label is what the table shows beside the name.
    if (persisted.isTest && !persisted.isDemo) return [];
    if (typeof persisted.cancelAtPeriodEnd !== "boolean" || typeof persisted.countsAsLive !== "boolean") {
      throw new BillingRepositoryError("MONEY_BILLING_READ_INVALID");
    }
    const status = string(persisted.status, "MONEY_BILLING_READ_INVALID");
    if (persisted.countsAsLive !== (status === "active")) {
      throw new BillingRepositoryError("MONEY_BILLING_READ_INVALID");
    }
    return [{
      tenantId: string(persisted.tenantId, "MONEY_BILLING_READ_INVALID"),
      businessName: string(persisted.businessName, "MONEY_BILLING_READ_INVALID"),
      accountStatus: string(persisted.accountStatus, "MONEY_BILLING_READ_INVALID"),
      subscriptionStatus: string(persisted.subscriptionStatus, "MONEY_BILLING_READ_INVALID"),
      providerUpdatedAt: string(persisted.providerUpdatedAt, "MONEY_BILLING_READ_INVALID"),
      currentPeriodEnd: string(persisted.currentPeriodEnd, "MONEY_BILLING_READ_INVALID"),
      cancelAtPeriodEnd: persisted.cancelAtPeriodEnd,
      pendingTierId: nullableString(persisted.pendingTierId, "MONEY_BILLING_READ_INVALID"),
      pendingEffectiveAt: nullableString(persisted.pendingEffectiveAt, "MONEY_BILLING_READ_INVALID"),
      dataLabel: persisted.isDemo
        ? "Demo"
        : nullableString(persisted.dataLabel, "MONEY_BILLING_READ_INVALID"),
      plan: nullableString(persisted.plan, "MONEY_BILLING_READ_INVALID"),
      monthlyAmountCents: nullableInteger(persisted.monthlyAmountCents, "MONEY_BILLING_READ_INVALID"),
      status,
      countsAsLive: persisted.countsAsLive,
    }];
  });
  return { mrrByPeriod, rows };
}

/**
 * Every tenant the Subscriptions table draws, newest movement first.
 *
 * There is no page size because there is no pagination: the table shows the whole book at once and
 * sorts it by how much attention a row needs, so a page boundary would silently hide accounts. The
 * cap is a guard against a runaway read rather than a window, and a book that ever reaches it has
 * outgrown a single-table screen.
 */
const SUBSCRIPTION_ROW_CAP = 2_000;

const SUBSCRIPTION_ROW_SELECT = [
  "id,name,status,is_demo",
  "billing_subscriptions(status,provider_updated_at,current_period_end,cancel_at_period_end)",
  "allowance_actions(pending_tier_id,effective_at,state)",
].join(",");

/** A to-one embed, which PostgREST hands back as an object or as a one-element array. */
function embedded(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return embedded(value[0]);
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function embeddedRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((candidate): candidate is Record<string, unknown> =>
      Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate))
    : [];
}

function parseSubscriptionRows(value: unknown): MoneySubscriptionRow[] {
  const code = "BILLING_SUBSCRIPTION_ROWS_READ_INVALID";
  return array(value, code).map((candidate) => {
    const tenant = row(candidate, code);
    const subscription = embedded(tenant.billing_subscriptions);
    // The one pending tier change a reader is owed, on the same rule the export applies: a
    // scheduled or consent-blocked action is the change that has not landed yet, and anything
    // else has either landed or been abandoned.
    const pending = embeddedRows(tenant.allowance_actions)
      .find((action) => action.state === "scheduled" || action.state === "awaiting_consent") ?? null;
    return {
      tenantId: string(tenant.id, code),
      businessName: string(tenant.name, code),
      accountStatus: string(tenant.status, code),
      subscriptionStatus: nullableString(subscription?.status ?? null, code),
      providerUpdatedAt: nullableString(subscription?.provider_updated_at ?? null, code),
      currentPeriodEnd: nullableString(subscription?.current_period_end ?? null, code),
      cancelAtPeriodEnd: subscription?.cancel_at_period_end === true,
      pendingTierId: nullableString(pending?.pending_tier_id ?? null, code),
      pendingEffectiveAt: nullableString(pending?.effective_at ?? null, code),
      dataLabel: tenant.is_demo === true ? "Demo" : null,
    };
  });
}

/**
 * Every cost rollup the Costs surface draws, newest period first.
 *
 * The cap is the same guard `SUBSCRIPTION_ROW_CAP` is: the table paginates in the browser over the
 * whole set, so a page boundary in the query would hide periods rather than defer them.
 */
const COST_ROLLUP_ROW_CAP = 2_000;

const COST_ROLLUP_ROW_SELECT = [
  "id,tenant_id,window_start,window_end",
  "recognized_subscription_cents,model_cents,messaging_cents,embedding_cents",
  "complete,missing_sources,computed_at",
  "tenant:tenants(name,is_demo)",
].join(",");

function parseCostRollupRows(value: unknown): MoneyCostRollupRow[] {
  const code = "BILLING_COST_ROLLUP_ROWS_READ_INVALID";
  return array(value, code).map((candidate) => {
    const rollup = row(candidate, code);
    const tenant = embedded(rollup.tenant);
    // The screen joins the missing sources with "; " and prints the string, so the join happens
    // here rather than in the component, exactly as the export spec does it. A rollup that is
    // missing nothing carries no string at all, because "" would read on screen as a value.
    const missing = Array.isArray(rollup.missing_sources)
      ? rollup.missing_sources.filter((source): source is string => typeof source === "string")
      : [];
    return {
      rollupId: string(rollup.id, code),
      tenantId: string(rollup.tenant_id, code),
      businessName: string(tenant?.name, code),
      windowStart: nullableString(rollup.window_start ?? null, code),
      windowEnd: nullableString(rollup.window_end ?? null, code),
      revenueCents: nullableInteger(rollup.recognized_subscription_cents ?? null, code),
      modelCostCents: nullableInteger(rollup.model_cents ?? null, code),
      messagingCostCents: nullableInteger(rollup.messaging_cents ?? null, code),
      embeddingCostCents: nullableInteger(rollup.embedding_cents ?? null, code),
      complete: rollup.complete === true,
      missingSources: missing.length > 0 ? missing.join("; ") : null,
      sourceEvidenceAt: nullableString(rollup.computed_at ?? null, code),
      dataLabel: tenant?.is_demo === true ? "Demo" : null,
    };
  });
}

async function liveDependencies(): Promise<BillingRepositoryDependencies> {
  const service = createSupabaseServiceClient();
  const user = await createSupabaseServerClient();
  const serviceRpc = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await service.rpc(name, args);
    if (error) throw new BillingRepositoryError(`${name.toUpperCase()}_FAILED`);
    return data;
  };
  const userRpc = async (name: string, args: Record<string, unknown>) => {
    const { data, error } = await user.rpc(name, args);
    if (error) throw new BillingRepositoryError(`${name.toUpperCase()}_FAILED`);
    return data;
  };
  return {
    serviceRpc,
    userRpc,
    readTierVersion: async (id, auditId) => {
      const { data, error } = await service.from("tier_price_versions")
        .select("id,audit_id").eq("id", id).eq("audit_id", auditId).maybeSingle();
      if (error) throw new BillingRepositoryError("BILLING_TIER_READBACK_FAILED");
      return data;
    },
    readOverride: async (id, auditId) => {
      const { data, error } = await service.from("tenant_price_overrides")
        .select("id,audit_id").eq("id", id).eq("audit_id", auditId).maybeSingle();
      if (error) throw new BillingRepositoryError("BILLING_OVERRIDE_READBACK_FAILED");
      return data;
    },
    readCorrectionRequest: async (id, auditId) => {
      let query = service.from("billing_correction_requests")
        .select("id,tenant_id,billable_event_id,quantity_delta,reason,audit_id,created_at")
        .eq("id", id);
      if (auditId !== undefined) query = query.eq("audit_id", auditId);
      const { data, error } = await query.maybeSingle();
      if (error) throw new BillingRepositoryError("BILLING_CORRECTION_REQUEST_READBACK_FAILED");
      return data;
    },
    readCorrectionDecision: async (id, auditId) => {
      const { data, error } = await service.from("billing_correction_decisions")
        .select("id,request_id,decision,offset_event_id,audit_id")
        .eq("id", id).eq("audit_id", auditId).maybeSingle();
      if (error) throw new BillingRepositoryError("BILLING_CORRECTION_DECISION_READBACK_FAILED");
      return data;
    },
    readTenantStatus: async (tenantId) => {
      const { data, error } = await service.from("tenants")
        .select("id,status").eq("id", tenantId).maybeSingle();
      if (error) throw new BillingRepositoryError("TENANT_BILLING_STATUS_READBACK_FAILED");
      return data;
    },
    readAttendance: async ({ tenantId, appointmentId, auditId }) => {
      const [appointment, events, audit] = await Promise.all([
        service.from("appointments").select("id,tenant_id,status,attendance_source,attendance_set_by")
          .eq("id", appointmentId).eq("tenant_id", tenantId).maybeSingle(),
        service.from("billable_events").select("quantity").eq("tenant_id", tenantId)
          .eq("appointment_id", appointmentId),
        service.from("audit_log").select("id,action").eq("id", auditId).maybeSingle(),
      ]);
      if (appointment.error || events.error || audit.error) {
        throw new BillingRepositoryError("ATTENDANCE_READBACK_FAILED");
      }
      if (!appointment.data || !audit.data) return null;
      return {
        ...appointment.data,
        audit_id: audit.data.id,
        audit_action: audit.data.action,
        billable_quantity: (events.data ?? []).reduce(
          (sum, event) => sum + Number(event.quantity),
          0,
        ),
      };
    },
    findSkippedAttendance: async ({ tenantId, appointmentId, idempotencyKey }) => {
      const { data, error } = await service.from("audit_log")
        .select("id,tenant_id,action,target_type,target_id,payload")
        .eq("tenant_id", tenantId)
        .eq("action", "appointment.attendance_set")
        .eq("target_type", "appointment")
        .eq("target_id", appointmentId)
        .contains("payload", {
          attendance_state: "skipped",
          value: "skipped",
          idempotency_key: idempotencyKey,
        })
        .order("id", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw new BillingRepositoryError("ATTENDANCE_SKIP_READBACK_FAILED");
      return data;
    },
    validateSkippedAttendance: async (input) => {
      const { data: appointment, error: appointmentError } = await service
        .from("appointments")
        .select("id,tenant_id,status,end_at,attendance_source")
        .eq("id", input.appointmentId)
        .eq("tenant_id", input.tenantId)
        .maybeSingle();
      const endAt = appointment ? Date.parse(appointment.end_at) : Number.NaN;
      if (
        appointmentError || !appointment
        || (appointment.status !== "scheduled" && appointment.status !== "confirmed")
        || appointment.attendance_source !== null
        || !Number.isFinite(endAt) || endAt >= Date.now()
      ) throw new BillingRepositoryError("ATTENDANCE_SKIP_REFUSED");
    },
    releaseSkippedAttendanceClaim: async (input) => {
      const { error } = await service.from("request_rate_limits")
        .delete()
        .eq("key", skippedAttendanceClaimKey(input));
      if (error) throw new BillingRepositoryError("ATTENDANCE_SKIP_CLAIM_RELEASE_FAILED");
    },
    writeSkippedAttendance: async (input) => {
      const { data, error } = await service.from("audit_log").insert({
        actor_id: input.actorId,
        tenant_id: input.tenantId,
        action: "appointment.attendance_set",
        target_type: "appointment",
        target_id: input.appointmentId,
        reason: null,
        payload: {
          attendance_state: "skipped",
          value: "skipped",
          idempotency_key: input.idempotencyKey,
        },
        source: "api",
      }).select("id,tenant_id,action,target_type,target_id,payload").single();
      if (error || !data) throw new BillingRepositoryError("ATTENDANCE_SKIP_WRITE_FAILED");
      return data;
    },
    listSkippedAppointmentIds: async (tenantId) => {
      const { data, error } = await service.from("audit_log")
        .select("target_id")
        .eq("tenant_id", tenantId)
        .eq("action", "appointment.attendance_set")
        .eq("target_type", "appointment")
        .contains("payload", { attendance_state: "skipped", value: "skipped" });
      if (error) throw new BillingRepositoryError("ATTENDANCE_SKIP_LIST_FAILED");
      return (data ?? []).flatMap((item) => (
        typeof item.target_id === "string" ? [item.target_id] : []
      ));
    },
    projectCorrections: async () => {
      const { data, error } = await service.from("billing_correction_requests")
        .select("id,tenant_id,billable_event_id,quantity_delta,period_start,period_end,reason,audit_id,created_at,tenants(name,is_demo),billing_correction_decisions(id,decision,reason,offset_event_id,audit_id)")
        .order("created_at", { ascending: false });
      if (error) throw new BillingRepositoryError("BILLING_CORRECTIONS_READ_FAILED");
      return data ?? [];
    },
    projectOwnBilling: async (tenantId) => {
      const { data, error } = await user.rpc("coach_billing_projection", {
        p_expected_tenant: tenantId,
      });
      if (error) throw new BillingRepositoryError("COACH_BILLING_PROJECTION_FAILED");
      return data;
    },
    readMovementSources: async () => {
      // The two price tables are read unbounded on purpose: the latest row whose `effective_at`
      // is at or before an instant may predate the movement window by years.
      const [subscriptions, tierPriceVersions, tenantPriceOverrides] = await Promise.all([
        service.from("analytics_billing_subscriptions")
          .select("subscription_id,tenant_id,tier_id,stripe_price_id,status,current_period_start,current_period_end,cancel_at_period_end,provider_updated_at,created_at"),
        service.from("analytics_tier_price_versions")
          .select("price_version_id,tier_id,price_cents,effective_at"),
        service.from("analytics_tenant_price_overrides")
          .select("override_id,tenant_id,price_cents,effective_at,ends_at"),
      ]);
      if (subscriptions.error || tierPriceVersions.error || tenantPriceOverrides.error) {
        throw new BillingRepositoryError("BILLING_MOVEMENT_READ_FAILED");
      }
      return {
        subscriptions: subscriptions.data ?? [],
        tierPriceVersions: tierPriceVersions.data ?? [],
        tenantPriceOverrides: tenantPriceOverrides.data ?? [],
      };
    },
    readMoneyBilling: async (asOf) => {
      const { data, error } = await service.rpc("read_money_mrr_history", { p_as_of: asOf });
      if (error || data === null || data === undefined) {
        throw new BillingRepositoryError("MONEY_BILLING_READ_FAILED");
      }
      return data;
    },
    readSubscriptionRows: async () => {
      const { data, error } = await service.from("tenants")
        .select(SUBSCRIPTION_ROW_SELECT)
        .order("updated_at", { ascending: false })
        .limit(SUBSCRIPTION_ROW_CAP);
      if (error) throw new BillingRepositoryError("BILLING_SUBSCRIPTION_ROWS_READ_FAILED");
      return data ?? [];
    },
    readCostRollupRows: async () => {
      const { data, error } = await service.from("tenant_cost_rollups")
        .select(COST_ROLLUP_ROW_SELECT)
        .order("window_end", { ascending: false })
        .limit(COST_ROLLUP_ROW_CAP);
      if (error) throw new BillingRepositoryError("BILLING_COST_ROLLUP_ROWS_READ_FAILED");
      return data ?? [];
    },
    readSubscription: async (tenantId) => {
      const [subscription, tenant] = await Promise.all([
        service.from("billing_subscriptions").select("tenant_id,status,provider_updated_at")
          .eq("tenant_id", tenantId).maybeSingle(),
        service.from("tenants").select("id,is_demo").eq("id", tenantId).maybeSingle(),
      ]);
      if (subscription.error || tenant.error) {
        throw new BillingRepositoryError("BILLING_SUBSCRIPTION_READ_FAILED");
      }
      if (!subscription.data || !tenant.data) return null;
      return { ...subscription.data, is_demo: tenant.data.is_demo };
    },
    readCheckoutTenant: async (tenantId) => {
      const { data, error } = await service.from("tenants")
        .select("id,is_demo").eq("id", tenantId).maybeSingle();
      if (error) throw new BillingRepositoryError("BILLING_TENANT_READ_FAILED");
      return data;
    },
    readCheckoutTierPrices: async (tierId) => {
      const { data, error } = await service.from("tiers")
        .select("id,active,stripe_price_id").eq("id", tierId);
      if (error) throw new BillingRepositoryError("BILLING_TIER_READ_FAILED");
      return data ?? [];
    },
    readAllowedPrices: async () => {
      const { data, error } = await service.from("tiers")
        .select("stripe_price_id").eq("active", true).not("stripe_price_id", "is", null);
      if (error) throw new BillingRepositoryError("BILLING_PRICE_ALLOWLIST_READ_FAILED");
      return data ?? [];
    },
    readCheckoutSession: async ({ checkoutSessionId, tenantId, tierId }) => {
      const { data, error } = await service.from("stripe_checkout_sessions")
        .select("id,tenant_id,tier_id,idempotency_key,stripe_session_id,stripe_customer_id,stripe_subscription_id,state,expires_at")
        .eq("id", checkoutSessionId).eq("tenant_id", tenantId).eq("tier_id", tierId)
        .maybeSingle();
      if (error) throw new BillingRepositoryError("STRIPE_CHECKOUT_READBACK_FAILED");
      return data;
    },
  };
}

export function createBillingRepository(
  provided?: BillingRepositoryDependencies,
): BillingRepository {
  const dependencies = async () => provided ?? (await liveDependencies());
  return {
    updateTier: async (input) => {
      const deps = await dependencies();
      const receipt = row(await deps.serviceRpc("update_billing_tier", {
        p_actor_id: input.actorId,
        p_tier_id: input.tierId,
        p_price_cents: input.priceCents,
        p_call_allowance: input.callAllowance,
        p_fair_use_cap: input.fairUseCap,
        p_fair_use_note: input.fairUseNote,
        p_reason: input.reason,
      }), "BILLING_TIER_RECEIPT_INVALID");
      const priceVersionId = string(receipt.price_version_id, "BILLING_TIER_RECEIPT_INVALID");
      const auditId = integer(receipt.audit_id, "BILLING_TIER_RECEIPT_INVALID");
      const persisted = await deps.readTierVersion(priceVersionId, auditId);
      if (!persisted || persisted.id !== priceVersionId || integer(persisted.audit_id, "BILLING_TIER_READBACK_INVALID") !== auditId) {
        throw new BillingRepositoryError("BILLING_TIER_READBACK_MISMATCH");
      }
      return { priceVersionId, auditId };
    },
    setTenantOverride: async (input) => {
      const deps = await dependencies();
      const receipt = row(await deps.serviceRpc("set_tenant_price_override", {
        p_expected_tenant: input.tenantId,
        p_actor_id: input.actorId,
        p_price_cents: input.priceCents,
        p_effective_at: input.effectiveAt,
        p_ends_at: input.endsAt,
        p_reason: input.reason,
      }), "BILLING_OVERRIDE_RECEIPT_INVALID");
      const overrideId = string(receipt.override_id, "BILLING_OVERRIDE_RECEIPT_INVALID");
      const auditId = integer(receipt.audit_id, "BILLING_OVERRIDE_RECEIPT_INVALID");
      const persisted = await deps.readOverride(overrideId, auditId);
      if (!persisted || persisted.id !== overrideId || integer(persisted.audit_id, "BILLING_OVERRIDE_READBACK_INVALID") !== auditId) {
        throw new BillingRepositoryError("BILLING_OVERRIDE_READBACK_MISMATCH");
      }
      return { overrideId, auditId };
    },
    requestCorrection: async (input) => {
      const deps = await dependencies();
      const receipt = row(await deps.userRpc("request_billable_correction", {
        p_expected_tenant: input.tenantId,
        p_event_id: input.eventId,
        p_quantity_delta: input.quantityDelta,
        p_reason: input.reason,
      }), "BILLING_CORRECTION_REQUEST_RECEIPT_INVALID");
      const requestId = string(receipt.request_id, "BILLING_CORRECTION_REQUEST_RECEIPT_INVALID");
      const auditId = integer(receipt.audit_id, "BILLING_CORRECTION_REQUEST_RECEIPT_INVALID");
      const persisted = await deps.readCorrectionRequest(requestId, auditId);
      if (!persisted || persisted.id !== requestId || integer(persisted.audit_id, "BILLING_CORRECTION_REQUEST_READBACK_INVALID") !== auditId) {
        throw new BillingRepositoryError("BILLING_CORRECTION_REQUEST_READBACK_MISMATCH");
      }
      return { requestId, auditId };
    },
    requestPeriodCorrection: async (input) => {
      const deps = await dependencies();
      const receipt = row(await deps.userRpc("request_period_billing_correction", {
        p_expected_tenant: input.tenantId,
        p_reason: input.reason,
      }), "BILLING_CORRECTION_REQUEST_RECEIPT_INVALID");
      const requestId = string(receipt.request_id, "BILLING_CORRECTION_REQUEST_RECEIPT_INVALID");
      const auditId = integer(receipt.audit_id, "BILLING_CORRECTION_REQUEST_RECEIPT_INVALID");
      const persisted = await deps.readCorrectionRequest(requestId, auditId);
      if (!persisted || persisted.id !== requestId || integer(persisted.audit_id, "BILLING_CORRECTION_REQUEST_READBACK_INVALID") !== auditId) {
        throw new BillingRepositoryError("BILLING_CORRECTION_REQUEST_READBACK_MISMATCH");
      }
      return { requestId, auditId };
    },
    decideCorrection: async (input) => {
      const deps = await dependencies();
      const receipt = row(await deps.serviceRpc("decide_billable_correction", {
        p_expected_tenant: input.tenantId,
        p_actor_id: input.actorId,
        p_request_id: input.requestId,
        p_decision: input.decision,
        p_reason: input.reason,
      }), "BILLING_CORRECTION_DECISION_RECEIPT_INVALID");
      const decisionId = string(receipt.decision_id, "BILLING_CORRECTION_DECISION_RECEIPT_INVALID");
      const decisionAuditId = integer(receipt.audit_id, "BILLING_CORRECTION_DECISION_RECEIPT_INVALID");
      const [request, decision] = await Promise.all([
        deps.readCorrectionRequest(input.requestId),
        deps.readCorrectionDecision(decisionId, decisionAuditId),
      ]);
      const offsetEventId = receipt.offset_event_id === null
        ? null
        : string(receipt.offset_event_id, "BILLING_CORRECTION_DECISION_RECEIPT_INVALID");
      if (
        !request || !decision || decision.request_id !== input.requestId
        || decision.decision !== input.decision || decision.offset_event_id !== offsetEventId
      ) throw new BillingRepositoryError("BILLING_CORRECTION_DECISION_READBACK_MISMATCH");
      return {
        decisionId,
        offsetEventId,
        requestAuditId: integer(request.audit_id, "BILLING_CORRECTION_REQUEST_READBACK_INVALID"),
        decisionAuditId,
      };
    },
    setTenantStatus: async (input) => {
      const deps = await dependencies();
      const before = await deps.readTenantStatus(input.tenantId);
      const previousStatus = string(before?.status, "TENANT_BILLING_STATUS_READBACK_INVALID") as "active" | "overdue" | "suspended";
      const receipt = row(await deps.serviceRpc("set_tenant_billing_status", {
        p_expected_tenant: input.tenantId,
        p_actor_id: input.actorId,
        p_status: input.status,
        p_reason: input.reason,
      }), "TENANT_BILLING_STATUS_RECEIPT_INVALID");
      const auditId = integer(receipt.audit_id, "TENANT_BILLING_STATUS_RECEIPT_INVALID");
      const persisted = await deps.readTenantStatus(input.tenantId);
      if (!persisted || persisted.id !== input.tenantId || persisted.status !== input.status) {
        throw new BillingRepositoryError("TENANT_BILLING_STATUS_READBACK_MISMATCH");
      }
      return { tenantId: input.tenantId, previousStatus, status: input.status, auditId };
    },
    recordAttendance: async (input) => {
      const deps = await dependencies();
      const receipt = await deps.userRpc("record_appointment_attendance", {
        p_expected_tenant: input.tenantId,
        p_appointment_id: input.appointmentId,
        p_status: input.status,
        p_source: "coach",
        p_actor_id: input.actorId,
      });
      const auditId = integer(receipt, "ATTENDANCE_RECEIPT_INVALID");
      const persisted = await deps.readAttendance({ ...input, auditId });
      if (
        !persisted || persisted.id !== input.appointmentId || persisted.status !== input.status
        || persisted.attendance_source !== "coach" || persisted.attendance_set_by !== input.actorId
        || persisted.audit_action !== "appointment.attendance_set"
      ) throw new BillingRepositoryError("ATTENDANCE_READBACK_MISMATCH");
      return {
        auditId,
        billableQuantity: integer(persisted.billable_quantity, "ATTENDANCE_READBACK_INVALID"),
      };
    },
    skipAttendance: async (input) => {
      const deps = await dependencies();
      if (
        !deps.findSkippedAttendance
        || !deps.validateSkippedAttendance
        || !deps.writeSkippedAttendance
      ) {
        throw new BillingRepositoryError("ATTENDANCE_SKIP_NOT_CONFIGURED");
      }
      const idempotencyKey = input.idempotencyKey.trim();
      if (!idempotencyKey || idempotencyKey.length > 128) {
        throw new BillingRepositoryError("ATTENDANCE_SKIP_IDEMPOTENCY_INVALID");
      }
      const expected = { ...input, idempotencyKey };
      const replay = await deps.findSkippedAttendance(expected);
      if (replay) return skippedAttendanceReceipt(replay, expected);
      await deps.validateSkippedAttendance(expected);
      const claimed = await claimSkippedAttendance(deps, expected);
      if (!claimed) {
        const persisted = await waitForSkippedAttendance(deps.findSkippedAttendance, expected);
        if (!persisted) throw new BillingRepositoryError("ATTENDANCE_SKIP_READBACK_MISSING");
        return skippedAttendanceReceipt(persisted, expected);
      }

      try {
        await deps.writeSkippedAttendance(expected);
      } catch (error) {
        await deps.releaseSkippedAttendanceClaim?.(expected);
        throw error;
      }
      const persisted = await waitForSkippedAttendance(deps.findSkippedAttendance, expected);
      if (!persisted) throw new BillingRepositoryError("ATTENDANCE_SKIP_READBACK_MISSING");
      return skippedAttendanceReceipt(persisted, expected);
    },
    listCorrections: async () => {
      const deps = await dependencies();
      const value = await deps.projectCorrections();
      if (!Array.isArray(value)) throw new BillingRepositoryError("BILLING_CORRECTIONS_RECEIPT_INVALID");
      return value.map((candidate) => {
        const request = row(candidate, "BILLING_CORRECTIONS_RECEIPT_INVALID");
        const decisions = Array.isArray(request.billing_correction_decisions)
          ? request.billing_correction_decisions
          : [];
        const decision = decisions.length === 0 ? null : row(decisions[0], "BILLING_CORRECTIONS_RECEIPT_INVALID");
        return {
          requestId: string(request.id, "BILLING_CORRECTIONS_RECEIPT_INVALID"),
          tenantId: string(request.tenant_id, "BILLING_CORRECTIONS_RECEIPT_INVALID"),
          businessName: correctionBusinessName(request.tenants),
          dataLabel: correctionSeedLabel(request.tenants),
          billableEventId: request.billable_event_id === null
            ? null
            : string(request.billable_event_id, "BILLING_CORRECTIONS_RECEIPT_INVALID"),
          quantityDelta: request.quantity_delta === null
            ? null
            : integer(request.quantity_delta, "BILLING_CORRECTIONS_RECEIPT_INVALID"),
          periodStart: request.period_start === null
            ? null
            : string(request.period_start, "BILLING_CORRECTIONS_RECEIPT_INVALID"),
          periodEnd: request.period_end === null
            ? null
            : string(request.period_end, "BILLING_CORRECTIONS_RECEIPT_INVALID"),
          reason: string(request.reason, "BILLING_CORRECTIONS_RECEIPT_INVALID"),
          requestedAt: string(request.created_at, "BILLING_CORRECTIONS_RECEIPT_INVALID"),
          requestAuditId: integer(request.audit_id, "BILLING_CORRECTIONS_RECEIPT_INVALID"),
          decision: decision?.decision as BillingCorrectionProjection["decision"] ?? null,
          decisionId: decision ? string(decision.id, "BILLING_CORRECTIONS_RECEIPT_INVALID") : null,
          decisionReason: decision ? string(decision.reason, "BILLING_CORRECTIONS_RECEIPT_INVALID") : null,
          decisionAuditId: decision ? integer(decision.audit_id, "BILLING_CORRECTIONS_RECEIPT_INVALID") : null,
          offsetEventId: decision?.offset_event_id === null || !decision
            ? null
            : string(decision.offset_event_id, "BILLING_CORRECTIONS_RECEIPT_INVALID"),
        };
      });
    },
    loadOwnBilling: async (tenantId, asOf = new Date()) => {
      const deps = await dependencies();
      const billing = parseCoachBilling(await deps.projectOwnBilling(tenantId));
      /*
       * `coach_billing_projection` joins `billing_subscriptions` with no status filter and no
       * window, so it hands back whichever row the tenant has -- including one whose period ended
       * and was never replaced. Presenting that as the current period is what made /coach/billing
       * show a period and an allowance while /coach/home, reading the bounded lookup inside
       * `read_coach_measurement_for_actor`, correctly said there was no active period to count
       * against. The predicate lives in one place now; a row that fails it is not a period this
       * surface may render, and `coach-billing.tsx` already draws the absent state for a null.
       */
      if (billing && !isCurrentBillingPeriod({
        status: billing.subscriptionState,
        periodStart: billing.periodStart,
        periodEnd: billing.periodEnd,
      }, asOf)) {
        return null;
      }
      if (!billing || !deps.listSkippedAppointmentIds) return billing;
      const skipped = new Set(await deps.listSkippedAppointmentIds(tenantId));
      return {
        ...billing,
        outcomePrompts: billing.outcomePrompts.filter(
          (prompt) => !skipped.has(prompt.appointmentId),
        ),
      };
    },
    loadMrrMovement: async (asOf) => {
      const deps = await dependencies();
      return projectMrrMovement(asOf, await deps.readMovementSources(asOf));
    },
    loadMoneyBilling: async (asOf) => {
      if (!MOVEMENT_ISO.test(asOf)) throw new BillingRepositoryError("MONEY_BILLING_AS_OF_INVALID");
      return parseMoneyBilling(await (await dependencies()).readMoneyBilling(asOf));
    },
    loadSubscriptionRows: async () =>
      parseSubscriptionRows(await (await dependencies()).readSubscriptionRows()),
    loadCostRollupRows: async () =>
      parseCostRollupRows(await (await dependencies()).readCostRollupRows()),
    loadSubscription: async (tenantId) => {
      const deps = await dependencies();
      const persisted = await deps.readSubscription(tenantId);
      if (!persisted) return null;
      if (persisted.tenant_id !== tenantId || typeof persisted.is_demo !== "boolean") {
        throw new BillingRepositoryError("BILLING_SUBSCRIPTION_READBACK_INVALID");
      }
      return {
        tenantId,
        status: string(persisted.status, "BILLING_SUBSCRIPTION_READBACK_INVALID"),
        evidenceAt: string(persisted.provider_updated_at, "BILLING_SUBSCRIPTION_READBACK_INVALID"),
        isDemo: persisted.is_demo,
      };
    },
    loadCheckoutTenant: async (tenantId) => {
      const persisted = await (await dependencies()).readCheckoutTenant(tenantId);
      if (!persisted) return null;
      if (persisted.id !== tenantId || typeof persisted.is_demo !== "boolean") {
        throw new BillingRepositoryError("BILLING_TENANT_READBACK_INVALID");
      }
      return { id: tenantId, isDemo: persisted.is_demo };
    },
    loadCheckoutTierPrices: async (tierId) => {
      const value = await (await dependencies()).readCheckoutTierPrices(tierId);
      if (!Array.isArray(value)) throw new BillingRepositoryError("BILLING_TIER_RECEIPT_INVALID");
      return value.map((candidate) => {
        const persisted = row(candidate, "BILLING_TIER_RECEIPT_INVALID");
        return {
          tierId: string(persisted.id, "BILLING_TIER_RECEIPT_INVALID"),
          active: persisted.active === true,
          priceId: persisted.stripe_price_id === null
            ? null
            : string(persisted.stripe_price_id, "BILLING_TIER_RECEIPT_INVALID"),
        };
      });
    },
    listAllowedPriceIds: async () => {
      const value = await (await dependencies()).readAllowedPrices();
      if (!Array.isArray(value)) throw new BillingRepositoryError("BILLING_PRICE_ALLOWLIST_INVALID");
      return new Set(value.map((candidate) => string(
        row(candidate, "BILLING_PRICE_ALLOWLIST_INVALID").stripe_price_id,
        "BILLING_PRICE_ALLOWLIST_INVALID",
      )));
    },
    persistCheckout: async (input) => {
      const deps = await dependencies();
      const receipt = row(await deps.serviceRpc("record_stripe_checkout_session", {
        p_expected_tenant: input.tenantId,
        p_actor_id: input.actorId,
        p_tier_id: input.tierId,
        p_idempotency_key: input.idempotencyKey,
        p_stripe_session_id: input.provider.sessionId,
        p_stripe_customer_id: input.provider.customerId,
        p_stripe_subscription_id: input.provider.subscriptionId,
        p_state: input.provider.state,
        p_expires_at: input.provider.expiresAt,
        p_completed_at: input.provider.state === "completed" ? new Date().toISOString() : null,
      }), "STRIPE_CHECKOUT_RECEIPT_INVALID");
      const checkoutSessionId = string(receipt.checkout_session_id, "STRIPE_CHECKOUT_RECEIPT_INVALID");
      const persisted = await deps.readCheckoutSession({ checkoutSessionId, ...input });
      if (!persisted) return null;
      return {
        checkoutSessionId,
        tenantId: string(persisted.tenant_id, "STRIPE_CHECKOUT_READBACK_INVALID"),
        tierId: string(persisted.tier_id, "STRIPE_CHECKOUT_READBACK_INVALID"),
        priceId: input.priceId,
        idempotencyKey: string(persisted.idempotency_key, "STRIPE_CHECKOUT_READBACK_INVALID"),
        sessionId: string(persisted.stripe_session_id, "STRIPE_CHECKOUT_READBACK_INVALID"),
        customerId: string(persisted.stripe_customer_id, "STRIPE_CHECKOUT_READBACK_INVALID"),
        subscriptionId: persisted.stripe_subscription_id === null
          ? null
          : string(persisted.stripe_subscription_id, "STRIPE_CHECKOUT_READBACK_INVALID"),
        state: persisted.state as PersistedCheckoutSession["state"],
        expiresAt: string(persisted.expires_at, "STRIPE_CHECKOUT_READBACK_INVALID"),
      };
    },
  };
}
