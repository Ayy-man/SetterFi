/**
 * Service-role custody for the commercial-terms ledger.
 *
 * `tier_offer_terms` is deny-all under row security, so this module talks to it only through the
 * three security-definer functions in `20261003000002_tier_offer_term_writer.sql`. Two of the
 * table's guarantees can only be discovered by attempting the write -- the unique Stripe price id
 * and the per-tier no-overlap exclusion -- so the database raises them by name and this module
 * carries that name out to the route rather than flattening every refusal into one message.
 *
 * Nothing here contacts Stripe. A term's `stripePriceId` is a fact an operator recorded; it stays
 * unverified until Stripe is connected and something reads it back.
 */

import { TIER_OFFER_INTERVALS, type TierOfferInterval } from "@/lib/billing/tier-offers";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type TierOfferTermRecord = {
  id: string;
  tierId: string;
  tierName: string;
  currency: string;
  amountCents: number;
  interval: TierOfferInterval;
  stripePriceId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  reason: string | null;
  auditId: number | null;
};

export type RecordTierOfferTermInput = {
  actorId: string;
  tierId: string;
  currency: string;
  amountCents: number;
  interval: TierOfferInterval;
  stripePriceId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  reason: string;
};

export type CloseTierOfferTermInput = {
  actorId: string;
  termId: string;
  effectiveTo: string;
  reason: string;
};

export type TierOfferTermReceipt = { termId: string; auditId: number };

export type TierOfferTermsRepositoryDependencies = {
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>;
};

export class TierOfferTermsRepositoryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TierOfferTermsRepositoryError";
  }
}

/**
 * The refusals the surface is allowed to name. Anything outside this set becomes the generic
 * failure, because a message this screen prints verbatim must never be raw database text.
 */
export const TIER_OFFER_TERM_ERROR_CODES = [
  "BILLING_TIER_NOT_FOUND",
  "PHASE6_ACTOR_REQUIRED",
  "PHASE6_OWNER_ADMIN_REQUIRED",
  "TIER_OFFER_TERM_ALREADY_CLOSED",
  "TIER_OFFER_TERM_AMOUNT_INVALID",
  "TIER_OFFER_TERM_CURRENCY_INVALID",
  "TIER_OFFER_TERM_INTERVAL_INVALID",
  "TIER_OFFER_TERM_NOT_FOUND",
  "TIER_OFFER_TERM_REASON_REQUIRED",
  "TIER_OFFER_TERM_STRIPE_PRICE_DUPLICATE",
  "TIER_OFFER_TERM_STRIPE_PRICE_REQUIRED",
  "TIER_OFFER_TERM_WINDOW_INVALID",
  "TIER_OFFER_TERM_WINDOW_OVERLAP",
] as const;

export type TierOfferTermErrorCode = (typeof TIER_OFFER_TERM_ERROR_CODES)[number];

export function namedTierOfferTermError(message: string, fallback: string) {
  const match = TIER_OFFER_TERM_ERROR_CODES.find((code) => message.includes(code));
  return new TierOfferTermsRepositoryError(match ?? fallback);
}

function rows(value: unknown, code: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new TierOfferTermsRepositoryError(code);
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TierOfferTermsRepositoryError(code);
    }
    return entry as Record<string, unknown>;
  });
}

function receipt(value: unknown, code: string): TierOfferTermReceipt {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TierOfferTermsRepositoryError(code);
  }
  const record = candidate as Record<string, unknown>;
  const termId = record.term_id;
  const auditId = typeof record.audit_id === "string" ? Number(record.audit_id) : record.audit_id;
  if (typeof termId !== "string" || !termId.trim()) {
    throw new TierOfferTermsRepositoryError(code);
  }
  if (typeof auditId !== "number" || !Number.isSafeInteger(auditId)) {
    throw new TierOfferTermsRepositoryError(code);
  }
  return { termId, auditId };
}

function text(value: unknown, code: string) {
  if (typeof value !== "string" || !value.trim()) throw new TierOfferTermsRepositoryError(code);
  return value;
}

function timestamp(value: unknown, code: string) {
  const candidate = text(value, code);
  if (!Number.isFinite(Date.parse(candidate))) throw new TierOfferTermsRepositoryError(code);
  return candidate;
}

function mapTerm(row: Record<string, unknown>): TierOfferTermRecord {
  const code = "TIER_OFFER_TERM_ROW_INVALID";
  const amountCents = typeof row.amount_cents === "string"
    ? Number(row.amount_cents)
    : row.amount_cents;
  if (typeof amountCents !== "number" || !Number.isSafeInteger(amountCents) || amountCents < 0) {
    throw new TierOfferTermsRepositoryError(code);
  }
  const interval = row.billing_interval;
  if (!TIER_OFFER_INTERVALS.includes(interval as TierOfferInterval)) {
    throw new TierOfferTermsRepositoryError(code);
  }
  const auditId = typeof row.audit_id === "string" ? Number(row.audit_id) : row.audit_id;
  return {
    id: text(row.id, code),
    tierId: text(row.tier_id, code),
    tierName: text(row.tier_name, code),
    currency: text(row.currency, code),
    amountCents,
    interval: interval as TierOfferInterval,
    stripePriceId: text(row.stripe_price_id, code),
    effectiveFrom: timestamp(row.effective_from, code),
    effectiveTo: row.effective_to === null || row.effective_to === undefined
      ? null
      : timestamp(row.effective_to, code),
    reason: typeof row.reason === "string" && row.reason.trim() ? row.reason : null,
    auditId: typeof auditId === "number" && Number.isSafeInteger(auditId) ? auditId : null,
  };
}

export function createTierOfferTermsRepository(
  provided?: TierOfferTermsRepositoryDependencies,
) {
  const dependencies = () => provided ?? liveDependencies();
  return {
    list: async (actorId: string): Promise<TierOfferTermRecord[]> => {
      const data = await dependencies().rpc("list_tier_offer_terms", { p_actor_id: actorId });
      return rows(data, "TIER_OFFER_TERM_LIST_INVALID").map(mapTerm);
    },
    record: async (input: RecordTierOfferTermInput): Promise<TierOfferTermReceipt> => {
      const data = await dependencies().rpc("record_tier_offer_term", {
        p_actor_id: input.actorId,
        p_tier_id: input.tierId,
        p_currency: input.currency,
        p_amount_cents: input.amountCents,
        p_billing_interval: input.interval,
        p_stripe_price_id: input.stripePriceId,
        p_effective_from: input.effectiveFrom,
        p_effective_to: input.effectiveTo,
        p_reason: input.reason,
      });
      return receipt(data, "TIER_OFFER_TERM_RECEIPT_INVALID");
    },
    close: async (input: CloseTierOfferTermInput): Promise<TierOfferTermReceipt> => {
      const data = await dependencies().rpc("close_tier_offer_term", {
        p_actor_id: input.actorId,
        p_term_id: input.termId,
        p_effective_to: input.effectiveTo,
        p_reason: input.reason,
      });
      return receipt(data, "TIER_OFFER_TERM_RECEIPT_INVALID");
    },
  };
}

export type TierOfferTermsRepository = ReturnType<typeof createTierOfferTermsRepository>;

function liveDependencies(): TierOfferTermsRepositoryDependencies {
  const service = createSupabaseServiceClient();
  return {
    rpc: async (name, args) => {
      const { data, error } = await service.rpc(name, args);
      // The database names its own refusals; keeping that name is the whole point of raising them.
      if (error) throw namedTierOfferTermError(error.message ?? "", `${name.toUpperCase()}_FAILED`);
      return data;
    },
  };
}
