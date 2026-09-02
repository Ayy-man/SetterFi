/**
 * Service-role custody for durable signup intents and the one tenant-birth transaction.
 *
 * Referral writes deliberately have no repository method: complete_onboarding_signup is the only
 * database contract allowed to create attribution, and committed audit rows are the receipt.
 */

import {
  resolveTierOffer,
  type TierOfferInterval,
  type TierOfferTerms,
} from "@/lib/billing/tier-offers";
import { tierOfferTermsLive } from "@/lib/env-contract";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

export const SIGNUP_INTENT_STATES = ["started", "completed", "failed"] as const;
export type SignupIntentState = (typeof SIGNUP_INTENT_STATES)[number];

export const REFERRAL_RESULTS = [
  "attributed",
  "self_referral",
  "invalid_silent",
  "none",
] as const;
export type ReferralResult = (typeof REFERRAL_RESULTS)[number];

export type SignupIntentRecord = {
  id: string;
  authUserId: string;
  email: string;
  tenantId: string | null;
  tierId: string | null;
  timezone: string | null;
  referralCode: string | null;
  state: SignupIntentState;
  errorCode: string | null;
};

export type SignupTierCatalogChoice = {
  id: string;
  label: string;
  /**
   * Booked calls included in the tier, from `tiers.call_allowance`. This is what the plans
   * actually differ on, so a catalogue that returns a price and not this one describes the
   * product by the number that varies least.
   */
  callAllowance: number;
  commercialTerms?: {
    currency: string;
    amountCents: number;
    interval: TierOfferInterval;
    stripePriceId: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  };
};

export type SelfSignupIntentStatus = {
  intentId: string;
  state: SignupIntentState;
  tenantId: string | null;
  errorCode: string | null;
};

export type SignupAuditReceipt = {
  id: number;
  tenantId: string;
  action: "onboarding.signup_completed" | "referral.code_rejected";
};

export type CompleteSignupReceipt = {
  tenantId: string;
  referralResult: ReferralResult;
  signupAuditId: number;
  referralRejectionAuditId: number | null;
  replayed: boolean;
};

export type SignupRepairState = "resumed" | "already_healthy" | "cannot_resume";

/**
 * A platform-only, audited outcome. `cannot_resume` deliberately leaves the signup unhealthy:
 * callers must show its code instead of treating a recorded command as a completed repair.
 */
export type SignupRepairReceipt = {
  commandId: string;
  intentId: string | null;
  tenantId: string | null;
  state: SignupRepairState;
  code: string | null;
  auditId: number;
};

type CompleteSignupRpcRow = {
  tenant_id: string;
  referral_result: ReferralResult;
  audit_id: number | null;
  replayed: boolean;
};

type SignupIntentRow = {
  id: string;
  auth_user_id: string;
  email: string;
  tenant_id: string | null;
  tier_id: string | null;
  timezone: string | null;
  referral_code: string | null;
  state: SignupIntentState;
  error: string | null;
};

type SignupTierCatalogRow = { id: unknown; label: unknown; call_allowance: unknown };
type SignupTierOfferCatalogRow = {
  id: unknown;
  label: unknown;
  call_allowance: unknown;
  offer_id: unknown;
  currency: unknown;
  amount_cents: unknown;
  billing_interval: unknown;
  stripe_price_id: unknown;
  effective_from: unknown;
  effective_to: unknown;
};
type SelfSignupIntentRow = {
  intent_id: unknown;
  state: unknown;
  tenant_id: unknown;
  error_code: unknown;
};

type SignupRepairRpcRow = {
  command_id: unknown;
  intent_id: unknown;
  tenant_id: unknown;
  state: unknown;
  outcome_code: unknown;
  audit_id: unknown;
};

export type OnboardingSignupRepositoryDependencies = {
  insertIntent: (input: {
    authUserId: string;
    email: string;
    tierId: string;
    timezone: string;
    referralCode: string | null;
  }) => Promise<void>;
  loadIntent: (authUserId: string) => Promise<SignupIntentRecord | null>;
  completeSignup: (args: Record<string, unknown>) => Promise<CompleteSignupRpcRow>;
  recordIntentFailure: (authUserId: string, errorCode: string) => Promise<SignupIntentRecord | null>;
  loadSignupAudit: (tenantId: string, auditId: number | null) => Promise<SignupAuditReceipt | null>;
  loadReferralRejectionAudit: (tenantId: string) => Promise<SignupAuditReceipt | null>;
};

export type SignupRepairRepositoryDependencies = {
  repairSignup: (args: Record<string, unknown>) => Promise<unknown>;
};

export type SignupTierCatalogOptions = {
  /** Injected only for the rollout gate and deterministic repository tests. */
  tierOfferTermsLive?: () => boolean;
  /** The server clock is passed through to the offer RPC and resolver as an explicit instant. */
  asOf?: Date;
  offerSource?: (asOf: Date) => Promise<readonly SignupTierOfferCatalogRow[]>;
};

export class SignupRepositoryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SignupRepositoryError";
  }
}

const INTENT_SELECT = "id,auth_user_id,email,tenant_id,tier_id,timezone,referral_code,state,error";

function required(value: string, code: string) {
  const normalized = value.trim();
  if (!normalized) throw new SignupRepositoryError(code);
  return normalized;
}

export function isIanaTimezone(value: string) {
  const normalized = value.trim();
  if (!normalized) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format();
    return true;
  } catch {
    return false;
  }
}

function mapIntent(row: SignupIntentRow): SignupIntentRecord {
  if (!SIGNUP_INTENT_STATES.includes(row.state)) {
    throw new SignupRepositoryError("SIGNUP_INTENT_STATE_INVALID");
  }
  return {
    id: row.id,
    authUserId: row.auth_user_id,
    email: row.email,
    tenantId: row.tenant_id,
    tierId: row.tier_id,
    timezone: row.timezone,
    referralCode: row.referral_code,
    state: row.state,
    errorCode: row.error,
  };
}

function nullableString(value: unknown, code: string) {
  if (value === null) return null;
  if (typeof value !== "string") throw new SignupRepositoryError(code);
  return value;
}

function requiredAuditId(value: unknown, code: string) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new SignupRepositoryError(code);
  return parsed;
}

function mapTierChoice(row: SignupTierCatalogRow): SignupTierCatalogChoice {
  if (
    typeof row.id !== "string" || !row.id.trim()
    || typeof row.label !== "string" || !row.label.trim()
    // `tiers_allowance_chk` holds this at >= 0 in the database, so a negative or fractional value
    // arriving here means the projection is wrong rather than the tier being unusual. A catalogue
    // that cannot say what a plan includes must fail rather than sell it as including nothing.
    || typeof row.call_allowance !== "number"
    || !Number.isSafeInteger(row.call_allowance)
    || row.call_allowance < 0
  ) {
    throw new SignupRepositoryError("SIGNUP_TIER_CATALOG_ROW_INVALID");
  }
  return { id: row.id, label: row.label, callAllowance: row.call_allowance };
}

/**
 * A public catalogue must identify one offerable thing per id and per human label. Two rows that
 * both say "Growth" are commercially ambiguous even when their UUIDs differ; choosing either one
 * would let database order decide what a prospect buys. Refuse the whole catalogue so the public
 * page becomes unavailable until an operator fixes the authoritative records.
 */
function uniqueSignupTierChoices(
  choices: readonly SignupTierCatalogChoice[],
): SignupTierCatalogChoice[] {
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const choice of choices) {
    const id = choice.id.trim();
    const label = choice.label.trim().toLocaleLowerCase();
    if (ids.has(id) || labels.has(label)) {
      throw new SignupRepositoryError("SIGNUP_TIER_CATALOG_AMBIGUOUS");
    }
    ids.add(id);
    labels.add(label);
  }
  return [...choices];
}

function instant(value: unknown): Date {
  if (typeof value !== "string" || !value.trim()) {
    throw new SignupRepositoryError("SIGNUP_TIER_OFFER_ROW_INVALID");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new SignupRepositoryError("SIGNUP_TIER_OFFER_ROW_INVALID");
  return parsed;
}

function nullableInstant(value: unknown): Date | null {
  if (value === null) return null;
  return instant(value);
}

function tierOfferFromCatalogRow(row: SignupTierOfferCatalogRow): {
  choice: { id: string; label: string; callAllowance: number };
  offer: TierOfferTerms;
} {
  const choice = mapTierChoice(row);
  if (
    typeof row.offer_id !== "string"
    || !row.offer_id.trim()
    || typeof row.currency !== "string"
    || typeof row.amount_cents !== "number"
    || typeof row.billing_interval !== "string"
    || typeof row.stripe_price_id !== "string"
  ) {
    throw new SignupRepositoryError("SIGNUP_TIER_OFFER_ROW_INVALID");
  }
  return {
    choice,
    offer: {
      id: row.offer_id,
      tierId: choice.id,
      currency: row.currency,
      amountCents: row.amount_cents,
      interval: row.billing_interval as TierOfferInterval,
      stripePriceId: row.stripe_price_id,
      effectiveFrom: instant(row.effective_from),
      effectiveTo: nullableInstant(row.effective_to),
    },
  };
}

function mapTierOfferChoices(
  rows: readonly SignupTierOfferCatalogRow[],
  asOf: Date,
): SignupTierCatalogChoice[] {
  const mapped = rows.map(tierOfferFromCatalogRow);
  const offers = mapped.map(({ offer }) => offer);
  const labels = new Map(mapped.map(({ choice }) => [choice.id, choice.label]));
  const allowances = new Map(mapped.map(({ choice }) => [choice.id, choice.callAllowance]));
  return uniqueSignupTierChoices([...labels.entries()].map(([tierId, label]) => {
    const resolution = resolveTierOffer(offers, tierId, asOf);
    // A source row that is not in force is a projection defect, never a reason to return a stale
    // tier to a prospective customer.
    if (resolution.state !== "offered") {
      throw new SignupRepositoryError(resolution.code);
    }
    const offer = resolution.offer;
    return {
      id: tierId,
      label,
      callAllowance: allowances.get(tierId)!,
      commercialTerms: {
        currency: offer.currency,
        amountCents: offer.amountCents,
        interval: offer.interval,
        stripePriceId: offer.stripePriceId,
        effectiveFrom: offer.effectiveFrom.toISOString(),
        effectiveTo: offer.effectiveTo?.toISOString() ?? null,
      },
    };
  }));
}

function mapSelfIntent(row: SelfSignupIntentRow): SelfSignupIntentStatus {
  if (
    typeof row.intent_id !== "string"
    || !row.intent_id.trim()
    || typeof row.state !== "string"
    || !SIGNUP_INTENT_STATES.includes(row.state as SignupIntentState)
  ) {
    throw new SignupRepositoryError("SIGNUP_SELF_INTENT_ROW_INVALID");
  }
  return {
    intentId: row.intent_id,
    state: row.state as SignupIntentState,
    tenantId: nullableString(row.tenant_id, "SIGNUP_SELF_INTENT_ROW_INVALID"),
    errorCode: nullableString(row.error_code, "SIGNUP_SELF_INTENT_ROW_INVALID"),
  };
}

function repairReceipt(data: unknown): SignupRepairReceipt {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") throw new SignupRepositoryError("SIGNUP_REPAIR_RECEIPT_INVALID");
  const value = row as SignupRepairRpcRow;
  const commandId = nullableString(value.command_id, "SIGNUP_REPAIR_RECEIPT_INVALID");
  const state = value.state;
  if (!commandId || (state !== "resumed" && state !== "already_healthy" && state !== "cannot_resume")) {
    throw new SignupRepositoryError("SIGNUP_REPAIR_RECEIPT_INVALID");
  }
  const intentId = nullableString(value.intent_id, "SIGNUP_REPAIR_RECEIPT_INVALID");
  const tenantId = nullableString(value.tenant_id, "SIGNUP_REPAIR_RECEIPT_INVALID");
  const code = nullableString(value.outcome_code, "SIGNUP_REPAIR_RECEIPT_INVALID");
  if (state === "cannot_resume" ? !code : code !== null) {
    throw new SignupRepositoryError("SIGNUP_REPAIR_RECEIPT_INVALID");
  }
  return {
    commandId,
    intentId,
    tenantId,
    state,
    code,
    auditId: requiredAuditId(value.audit_id, "SIGNUP_REPAIR_RECEIPT_INVALID"),
  };
}

async function loadTierCatalogRows(): Promise<readonly SignupTierCatalogRow[]> {
  const client = await createSupabaseServerClient();
  const { data, error } = await client.rpc("list_signup_tier_catalog");
  if (error) throw new SignupRepositoryError("SIGNUP_TIER_CATALOG_READ_FAILED");
  return (data ?? []) as SignupTierCatalogRow[];
}

async function loadTierOfferCatalogRows(asOf: Date): Promise<readonly SignupTierOfferCatalogRow[]> {
  const client = await createSupabaseServerClient();
  const { data, error } = await client.rpc("list_signup_tier_offer_catalog", {
    p_as_of: asOf.toISOString(),
  });
  if (error) throw new SignupRepositoryError("SIGNUP_TIER_OFFER_CATALOG_READ_FAILED");
  return (data ?? []) as SignupTierOfferCatalogRow[];
}

type TierOfferResolutionRow = { state: unknown };

/**
 * Whether a tier can actually be sold at a given instant. The catalogue read answers "what may a
 * prospect see"; this answers "may this specific POST proceed", which is the question a direct
 * request bypassing the catalogue is really asking.
 */
export async function tierOfferInForce(
  tierId: string,
  asOf: Date,
  source: (tierId: string, asOf: Date) => Promise<readonly TierOfferResolutionRow[]> =
    async (expectedTierId, instantValue) => {
      const client = createSupabaseServiceClient();
      const { data, error } = await client.rpc("resolve_tier_offer", {
        p_tier_id: expectedTierId,
        p_as_of: instantValue.toISOString(),
      });
      if (error) throw new SignupRepositoryError("SIGNUP_TIER_OFFER_LOOKUP_FAILED");
      return (data ?? []) as TierOfferResolutionRow[];
    },
): Promise<boolean> {
  const rows = await source(tierId, asOf);
  // An ambiguous result is a refusal rather than a pick, matching resolveTierOffer and the
  // BILLING_TIER_PRICE_AMBIGUOUS refusal checkout already makes.
  if (rows.length !== 1) return false;
  return rows[0].state === "offered";
}

export type AccountTermsAcceptanceReceipt = {
  versionKey: string;
  contentHash: string;
  acceptedAt: string;
};

/**
 * Stamps the accepted version onto the durable signup intent. The receipt row and its audit entry
 * are materialized by a trigger when the tenant is attached, so an acceptance cannot survive a
 * signup that never produced a tenant, and a retry cannot rewrite which version was accepted.
 */
export async function recordSignupAccountTermsAcceptance(
  input: {
    authUserId: string;
    versionKey: string;
    contentHash: string;
    requestContext: Record<string, string>;
  },
  source: (args: Record<string, unknown>) => Promise<unknown> = async (args) => {
    const client = createSupabaseServiceClient();
    const { data, error } = await client.rpc("record_signup_account_terms_acceptance", args);
    if (error) throw new SignupRepositoryError("ACCOUNT_TERMS_ACCEPTANCE_FAILED");
    return data;
  },
): Promise<AccountTermsAcceptanceReceipt> {
  const data = await source({
    p_auth_user_id: input.authUserId,
    p_version_key: input.versionKey,
    p_content_hash: input.contentHash,
    p_request_context: input.requestContext,
  });
  const row = Array.isArray(data) ? data[0] : null;
  if (!row || typeof row !== "object") {
    throw new SignupRepositoryError("ACCOUNT_TERMS_ACCEPTANCE_RECEIPT_INVALID");
  }
  const receipt = row as Record<string, unknown>;
  if (
    receipt.version_key !== input.versionKey
    || receipt.content_hash !== input.contentHash
    || typeof receipt.accepted_at !== "string"
    || !receipt.accepted_at.trim()
  ) {
    throw new SignupRepositoryError("ACCOUNT_TERMS_ACCEPTANCE_RECEIPT_INVALID");
  }
  return {
    versionKey: input.versionKey,
    contentHash: input.contentHash,
    acceptedAt: receipt.accepted_at,
  };
}

async function loadSelfIntentRows(): Promise<readonly SelfSignupIntentRow[]> {
  const client = await createSupabaseServerClient();
  const { data, error } = await client.rpc("read_self_signup_intent");
  if (error) throw new SignupRepositoryError("SIGNUP_SELF_INTENT_READ_FAILED");
  return (data ?? []) as SelfSignupIntentRow[];
}

export async function listSignupTierCatalog(
  source: () => Promise<readonly SignupTierCatalogRow[]> = loadTierCatalogRows,
  options: SignupTierCatalogOptions = {},
): Promise<SignupTierCatalogChoice[]> {
  try {
    if ((options.tierOfferTermsLive ?? tierOfferTermsLive)()) {
      // This is the repository boundary where the server clock becomes an explicit quote instant.
      // The resolver itself never samples time, so a test or replay can use the exact same instant.
      const asOf = options.asOf ?? new Date();
      return mapTierOfferChoices(
        await (options.offerSource ?? loadTierOfferCatalogRows)(asOf),
        asOf,
      );
    }
    return uniqueSignupTierChoices((await source()).map(mapTierChoice));
  } catch (cause) {
    throw safeRepositoryError(cause, "SIGNUP_TIER_CATALOG_READ_FAILED");
  }
}

export async function loadSelfSignupIntentStatus(
  source: () => Promise<readonly SelfSignupIntentRow[]> = loadSelfIntentRows,
): Promise<SelfSignupIntentStatus | null> {
  try {
    const rows = await source();
    if (rows.length > 1) throw new SignupRepositoryError("SIGNUP_SELF_INTENT_ROW_INVALID");
    return rows[0] ? mapSelfIntent(rows[0]) : null;
  } catch (cause) {
    throw safeRepositoryError(cause, "SIGNUP_SELF_INTENT_READ_FAILED");
  }
}

function singleCompletion(data: unknown): CompleteSignupRpcRow {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") {
    throw new SignupRepositoryError("SIGNUP_COMPLETION_RECEIPT_INVALID");
  }
  const value = row as Record<string, unknown>;
  if (
    typeof value.tenant_id !== "string"
    || !REFERRAL_RESULTS.includes(value.referral_result as ReferralResult)
    || typeof value.replayed !== "boolean"
    || (value.audit_id !== null && typeof value.audit_id !== "number")
  ) {
    throw new SignupRepositoryError("SIGNUP_COMPLETION_RECEIPT_INVALID");
  }
  return {
    tenant_id: value.tenant_id,
    referral_result: value.referral_result as ReferralResult,
    audit_id: value.audit_id as number | null,
    replayed: value.replayed,
  };
}

async function liveDependencies(): Promise<OnboardingSignupRepositoryDependencies> {
  const client = createSupabaseServiceClient();
  const loadIntent = async (authUserId: string) => {
    const { data, error } = await client
      .from("signup_intents")
      .select(INTENT_SELECT)
      .eq("auth_user_id", authUserId)
      .maybeSingle();
    if (error) throw new SignupRepositoryError("SIGNUP_INTENT_READ_FAILED");
    return data ? mapIntent(data as SignupIntentRow) : null;
  };
  const loadAudit = async (
    tenantId: string,
    action: SignupAuditReceipt["action"],
    auditId: number | null = null,
  ) => {
    let query = client
      .from("audit_log")
      .select("id,tenant_id,action")
      .eq("tenant_id", tenantId)
      .eq("action", action);
    if (auditId !== null) query = query.eq("id", auditId);
    const { data, error } = await query.order("id", { ascending: false }).limit(1).maybeSingle();
    if (error || !data) return null;
    return {
      id: Number(data.id),
      tenantId: String(data.tenant_id),
      action: data.action as SignupAuditReceipt["action"],
    };
  };
  return {
    insertIntent: async (input) => {
      // Ignore a duplicate rather than rewriting a completed intent; the transactional RPC updates
      // captured fields while it holds the intent lock and keeps replay state immutable.
      const { error } = await client.from("signup_intents").upsert({
        auth_user_id: input.authUserId,
        email: input.email,
        tier_id: input.tierId,
        timezone: input.timezone,
        referral_code: input.referralCode,
        state: "started",
        error: null,
      }, { onConflict: "auth_user_id", ignoreDuplicates: true });
      if (error) throw new SignupRepositoryError("SIGNUP_INTENT_PERSIST_FAILED");
    },
    loadIntent,
    completeSignup: async (args) => {
      const { data, error } = await client.rpc("complete_onboarding_signup", args);
      if (error) throw new SignupRepositoryError("SIGNUP_COMPLETION_FAILED");
      return singleCompletion(data);
    },
    recordIntentFailure: async (authUserId, errorCode) => {
      const { data, error } = await client
        .from("signup_intents")
        .update({ state: "failed", error: errorCode })
        .eq("auth_user_id", authUserId)
        .is("tenant_id", null)
        .neq("state", "completed")
        .select(INTENT_SELECT)
        .maybeSingle();
      if (error) throw new SignupRepositoryError("SIGNUP_INTENT_FAILURE_RECORD_FAILED");
      return data ? mapIntent(data as SignupIntentRow) : null;
    },
    loadSignupAudit: (tenantId, auditId) => (
      loadAudit(tenantId, "onboarding.signup_completed", auditId)
    ),
    loadReferralRejectionAudit: (tenantId) => (
      loadAudit(tenantId, "referral.code_rejected")
    ),
  };
}

function safeRepositoryError(cause: unknown, fallback: string) {
  return cause instanceof SignupRepositoryError ? cause : new SignupRepositoryError(fallback);
}

export async function persistSignupIntent(
  input: {
    authUserId: string;
    email: string;
    tierId: string;
    timezone: string;
    referralCode?: string | null;
  },
  dependencies?: OnboardingSignupRepositoryDependencies,
) {
  const authUserId = required(input.authUserId, "SIGNUP_AUTH_USER_REQUIRED");
  const email = required(input.email, "SIGNUP_EMAIL_REQUIRED").toLowerCase();
  const tierId = required(input.tierId, "SIGNUP_TIER_REQUIRED");
  const timezone = required(input.timezone, "SIGNUP_TIMEZONE_REQUIRED");
  if (!isIanaTimezone(timezone)) throw new SignupRepositoryError("SIGNUP_TIMEZONE_INVALID");
  const referralCode = input.referralCode?.trim() || null;
  const deps = dependencies ?? (await liveDependencies());
  try {
    await deps.insertIntent({ authUserId, email, tierId, timezone, referralCode });
    const persisted = await deps.loadIntent(authUserId);
    if (!persisted || persisted.authUserId !== authUserId) {
      throw new SignupRepositoryError("SIGNUP_INTENT_READBACK_MISMATCH");
    }
    return persisted;
  } catch (cause) {
    throw safeRepositoryError(cause, "SIGNUP_INTENT_PERSIST_FAILED");
  }
}

export async function completeOnboardingSignup(
  input: {
    authUserId: string;
    email: string;
    fullName: string;
    businessName: string;
    slug: string;
    tierId: string;
    timezone: string;
    referralCode?: string | null;
    affiliateOptIn: boolean;
  },
  dependencies?: OnboardingSignupRepositoryDependencies,
): Promise<CompleteSignupReceipt> {
  const authUserId = required(input.authUserId, "SIGNUP_AUTH_USER_REQUIRED");
  const email = required(input.email, "SIGNUP_EMAIL_REQUIRED").toLowerCase();
  const businessName = required(input.businessName, "SIGNUP_BUSINESS_NAME_REQUIRED");
  const slug = required(input.slug, "SIGNUP_SLUG_REQUIRED").toLowerCase();
  const tierId = required(input.tierId, "SIGNUP_TIER_REQUIRED");
  const timezone = required(input.timezone, "SIGNUP_TIMEZONE_REQUIRED");
  if (!isIanaTimezone(timezone)) throw new SignupRepositoryError("SIGNUP_TIMEZONE_INVALID");
  const deps = dependencies ?? (await liveDependencies());
  let rpcReceipt: CompleteSignupRpcRow;
  try {
    rpcReceipt = await deps.completeSignup({
      p_expected_auth_user_id: authUserId,
      p_auth_user_id: authUserId,
      p_email: email,
      p_full_name: input.fullName.trim(),
      p_business_name: businessName,
      p_slug: slug,
      p_tier_id: tierId,
      p_timezone: timezone,
      p_referral_code: input.referralCode?.trim() || null,
      p_affiliate_opt_in: input.affiliateOptIn,
    });
  } catch (cause) {
    throw safeRepositoryError(cause, "SIGNUP_COMPLETION_FAILED");
  }
  if (!REFERRAL_RESULTS.includes(rpcReceipt.referral_result)) {
    throw new SignupRepositoryError("SIGNUP_COMPLETION_RECEIPT_INVALID");
  }
  const signupAudit = await deps.loadSignupAudit(rpcReceipt.tenant_id, rpcReceipt.audit_id);
  if (
    !signupAudit
    || signupAudit.tenantId !== rpcReceipt.tenant_id
    || signupAudit.action !== "onboarding.signup_completed"
    || (rpcReceipt.audit_id !== null && signupAudit.id !== rpcReceipt.audit_id)
  ) {
    throw new SignupRepositoryError("SIGNUP_COMPLETION_AUDIT_REQUIRED");
  }
  let referralRejectionAuditId: number | null = null;
  if (
    rpcReceipt.referral_result === "self_referral"
    || rpcReceipt.referral_result === "invalid_silent"
  ) {
    const rejectionAudit = await deps.loadReferralRejectionAudit(rpcReceipt.tenant_id);
    if (
      !rejectionAudit
      || rejectionAudit.tenantId !== rpcReceipt.tenant_id
      || rejectionAudit.action !== "referral.code_rejected"
    ) {
      throw new SignupRepositoryError("SIGNUP_REFERRAL_AUDIT_REQUIRED");
    }
    referralRejectionAuditId = rejectionAudit.id;
  }
  return {
    tenantId: rpcReceipt.tenant_id,
    referralResult: rpcReceipt.referral_result,
    signupAuditId: signupAudit.id,
    referralRejectionAuditId,
    replayed: rpcReceipt.replayed,
  };
}

export async function recordSignupIntentFailure(
  authUserId: string,
  errorCode: string,
  dependencies?: OnboardingSignupRepositoryDependencies,
) {
  const expectedAuthUserId = required(authUserId, "SIGNUP_AUTH_USER_REQUIRED");
  const safeCode = required(errorCode, "SIGNUP_FAILURE_CODE_REQUIRED");
  const deps = dependencies ?? (await liveDependencies());
  try {
    const persisted = await deps.recordIntentFailure(expectedAuthUserId, safeCode);
    if (
      !persisted
      || persisted.authUserId !== expectedAuthUserId
      || persisted.tenantId !== null
      || persisted.state !== "failed"
      || persisted.errorCode !== safeCode
    ) {
      throw new SignupRepositoryError("SIGNUP_INTENT_FAILURE_READBACK_MISMATCH");
    }
    return persisted;
  } catch (cause) {
    throw safeRepositoryError(cause, "SIGNUP_INTENT_FAILURE_RECORD_FAILED");
  }
}

export async function loadSignupIntentByAuthUser(
  authUserId: string,
  dependencies?: OnboardingSignupRepositoryDependencies,
) {
  const expectedAuthUserId = required(authUserId, "SIGNUP_AUTH_USER_REQUIRED");
  const deps = dependencies ?? (await liveDependencies());
  try {
    const intent = await deps.loadIntent(expectedAuthUserId);
    if (intent && intent.authUserId !== expectedAuthUserId) {
      throw new SignupRepositoryError("SIGNUP_INTENT_AUTH_USER_MISMATCH");
    }
    return intent;
  } catch (cause) {
    throw safeRepositoryError(cause, "SIGNUP_INTENT_READ_FAILED");
  }
}

export async function repairOnboardingSignup(input: {
  expectedAuthUserId: string;
  expectedTenantId: string | null;
  email: string;
  fullName: string;
  businessName: string;
  slug: string;
  tierId: string;
  timezone: string;
  actorId: string;
  reason: string;
}, dependencies?: SignupRepairRepositoryDependencies): Promise<SignupRepairReceipt> {
  const expectedAuthUserId = required(input.expectedAuthUserId, "SIGNUP_AUTH_USER_REQUIRED");
  const expectedTenantId = input.expectedTenantId?.trim() || null;
  const email = required(input.email, "SIGNUP_EMAIL_REQUIRED").toLowerCase();
  const fullName = required(input.fullName, "SIGNUP_FULL_NAME_REQUIRED");
  const businessName = required(input.businessName, "SIGNUP_BUSINESS_NAME_REQUIRED");
  const slug = required(input.slug, "SIGNUP_SLUG_REQUIRED").toLowerCase();
  const tierId = required(input.tierId, "SIGNUP_TIER_REQUIRED");
  const timezone = required(input.timezone, "SIGNUP_TIMEZONE_REQUIRED");
  const actorId = required(input.actorId, "SIGNUP_REPAIR_ACTOR_REQUIRED");
  const reason = required(input.reason, "SIGNUP_REPAIR_REASON_REQUIRED");
  if (!isIanaTimezone(timezone)) throw new SignupRepositoryError("SIGNUP_TIMEZONE_INVALID");

  const deps = dependencies ?? {
    repairSignup: async (args: Record<string, unknown>) => {
      const client = createSupabaseServiceClient();
      const { data, error } = await client.rpc("repair_onboarding_signup", args);
      if (error) throw new SignupRepositoryError("SIGNUP_REPAIR_REFUSED");
      return data;
    },
  } satisfies SignupRepairRepositoryDependencies;
  try {
    const data = await deps.repairSignup({
      p_expected_auth_user_id: expectedAuthUserId,
      p_expected_tenant: expectedTenantId,
      p_email: email,
      p_full_name: fullName,
      p_business_name: businessName,
      p_slug: slug,
      p_tier_id: tierId,
      p_timezone: timezone,
      p_actor_id: actorId,
      p_reason: reason,
    });
    const receipt = repairReceipt(data);
    if (receipt.state !== "cannot_resume" && !receipt.tenantId) {
      throw new SignupRepositoryError("SIGNUP_REPAIR_RECEIPT_INVALID");
    }
    if (expectedTenantId && receipt.tenantId !== expectedTenantId) {
      throw new SignupRepositoryError("SIGNUP_REPAIR_EXPECTED_TENANT_MISMATCH");
    }
    return receipt;
  } catch (cause) {
    throw safeRepositoryError(cause, "SIGNUP_REPAIR_REFUSED");
  }
}
