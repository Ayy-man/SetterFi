/**
 * Persistence boundary for versioned coach offers.
 *
 * All mutations use the audited Phase 2 RPCs. Read-backs load the parent and bounded children so
 * callers never treat an RPC response alone as proof that a complete offer committed.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { assetHostsFor } from "@/lib/offer/asset-hosts";
import { OFFER_RULE_OPS, type OfferQualificationRule, type OfferRuleOp } from "@/lib/offer/rules";
import {
  parseOfferChangeTrail,
  type OfferChangeTrailEntry,
} from "@/lib/offer/change-trail";
import type {
  CoachOfferDraftInput,
  OfferPublishReceipt,
  PersistedOfferLayer,
} from "@/lib/offer/types";

type OfferStatus = PersistedOfferLayer["status"];

export type OfferLayerRepository = {
  loadAllowedHosts(tenantId: string): Promise<readonly string[]>;
  saveDraft(input: {
    tenantId: string;
    actorId: string;
    draftId: string | null;
    expectedContentHash: string | null;
    offer: CoachOfferDraftInput;
    contentHash: string;
  }): Promise<string>;
  loadOffer(input: {
    tenantId: string;
    status: OfferStatus;
    offerId?: string;
  }): Promise<PersistedOfferLayer | null>;
  publishDraft(input: {
    tenantId: string;
    actorId: string;
    draftId: string;
    expectedContentHash: string;
  }): Promise<{ offerId: string; offerVersion: number; auditId: string }>;
  loadPublishReceipt(input: {
    tenantId: string;
    offerId: string;
    auditId: string;
  }): Promise<Pick<OfferPublishReceipt, "auditId" | "actionKey" | "offerId"> | null>;
};

type SupabaseResult = { data: unknown; error: { message: string } | null };
type SupabaseQuery = PromiseLike<SupabaseResult> & {
  select(columns: string): SupabaseQuery;
  eq(column: string, value: unknown): SupabaseQuery;
  order(column: string, options?: { ascending?: boolean }): SupabaseQuery;
  single(): Promise<SupabaseResult>;
  maybeSingle(): Promise<SupabaseResult>;
  update(values: Record<string, unknown>): SupabaseQuery;
};
export type OfferPostgrestClient = {
  from(table: string): SupabaseQuery;
};

type LiveClient = ReturnType<typeof createSupabaseServiceClient>;

const OFFER_LAYER_SELECT = [
  "id",
  "tenant_id",
  "status",
  "version",
  "content_hash",
  "program_name",
  "program_description",
  "credit_min",
  "funding_goal_min_cents",
  "funding_goal_max_cents",
  "monthly_revenue_min_cents",
  "business_revenue_required",
  "credit_repair",
  "products",
  "booking_horizon_days",
  "booking_mode",
  "brand_voice",
  "results_timeline_min_days",
  "results_timeline_max_days",
  "refund_posture",
  "voice_style_answer",
  "voice_objection_answer",
  "voice_followup_answer",
  "qualification_rules",
  "voice_guidelines",
].join(",");

function asRecord(value: unknown, error: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}

function asRows(value: unknown, error: string) {
  if (!Array.isArray(value)) throw new Error(error);
  return value.map((row) => asRecord(row, error));
}

/**
 * The rules column is jsonb the database only shapes as "an array of at most twelve"; the row
 * content was validated on the way in, so a malformed row here is a corrupted read, not input.
 */
function parseStoredRules(value: unknown): OfferQualificationRule[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("OFFER_RULES_READBACK_INVALID");
  return value.map((row) => {
    const rule = asRecord(row, "OFFER_RULES_READBACK_INVALID");
    if (
      typeof rule.subject !== "string" ||
      typeof rule.op !== "string" ||
      !OFFER_RULE_OPS.includes(rule.op as OfferRuleOp) ||
      typeof rule.value !== "string"
    ) throw new Error("OFFER_RULES_READBACK_INVALID");
    return { subject: rule.subject, op: rule.op as OfferRuleOp, value: rule.value };
  });
}

function nullableNumber(value: unknown) {
  return value === null ? null : Number(value);
}

async function loadOfferWithChildren(
  client: LiveClient,
  input: { tenantId: string; status: OfferStatus; offerId?: string },
): Promise<PersistedOfferLayer | null> {
  let offerQuery = client
    .from("offer_layers")
    .select(OFFER_LAYER_SELECT)
    .eq("tenant_id", input.tenantId)
    .eq("status", input.status);
  if (input.offerId) offerQuery = offerQuery.eq("id", input.offerId);
  const { data: offerValue, error: offerError } = await offerQuery.maybeSingle();
  if (offerError) throw new Error(`OFFER_READ_FAILED:${offerError.message}`);
  if (!offerValue) return null;
  const offer = asRecord(offerValue, "OFFER_READBACK_INVALID");
  const offerId = String(offer.id);
  const [priceResult, proofResult, assetResult, cadenceResult] = await Promise.all([
    client.from("offer_prices").select("id, label, amount_cents, billing_period").eq("offer_id", offerId).order("id"),
    client.from("offer_proof_entries").select("id, title, detail").eq("offer_id", offerId).order("id"),
    client.from("offer_assets").select("id, slug, label, url").eq("offer_id", offerId).order("id"),
    client
      .from("offer_cadence_purposes")
      .select("channel_class, touch_no, purpose, asset_id")
      .eq("offer_id", offerId)
      .order("channel_class")
      .order("touch_no"),
  ]);
  for (const result of [priceResult, proofResult, assetResult, cadenceResult]) {
    if (result.error) throw new Error(`OFFER_CHILD_READ_FAILED:${result.error.message}`);
  }
  return {
    id: offerId,
    tenantId: String(offer.tenant_id),
    status: String(offer.status) as OfferStatus,
    version: Number(offer.version),
    contentHash: String(offer.content_hash ?? ""),
    programName: String(offer.program_name ?? ""),
    programDescription: offer.program_description === null ? null : String(offer.program_description),
    creditMin: nullableNumber(offer.credit_min),
    fundingGoalMinCents: nullableNumber(offer.funding_goal_min_cents),
    fundingGoalMaxCents: nullableNumber(offer.funding_goal_max_cents),
    monthlyRevenueMinCents: nullableNumber(offer.monthly_revenue_min_cents),
    businessRevenueRequired: Boolean(offer.business_revenue_required),
    creditRepair: offer.credit_repair as PersistedOfferLayer["creditRepair"],
    products: Array.isArray(offer.products) ? offer.products as PersistedOfferLayer["products"] : [],
    bookingHorizonDays: Number(offer.booking_horizon_days),
    bookingMode: offer.booking_mode as PersistedOfferLayer["bookingMode"],
    brandVoice: offer.brand_voice as PersistedOfferLayer["brandVoice"],
    resultsTimelineMinDays: nullableNumber(offer.results_timeline_min_days),
    resultsTimelineMaxDays: nullableNumber(offer.results_timeline_max_days),
    refundPosture: offer.refund_posture as PersistedOfferLayer["refundPosture"],
    voiceStyleAnswer: offer.voice_style_answer === null ? null : String(offer.voice_style_answer),
    voiceObjectionAnswer: offer.voice_objection_answer === null ? null : String(offer.voice_objection_answer),
    voiceFollowupAnswer: offer.voice_followup_answer === null ? null : String(offer.voice_followup_answer),
    qualificationRules: parseStoredRules(offer.qualification_rules),
    voiceGuidelines: offer.voice_guidelines === null || offer.voice_guidelines === undefined ? null : String(offer.voice_guidelines),
    offerPrices: asRows(priceResult.data, "OFFER_PRICE_READBACK_INVALID").map((row) => ({
      id: String(row.id),
      label: String(row.label),
      amountCents: Number(row.amount_cents),
      billingPeriod: row.billing_period as PersistedOfferLayer["offerPrices"][number]["billingPeriod"],
    })),
    proof: asRows(proofResult.data, "OFFER_PROOF_READBACK_INVALID").map((row) => ({
      id: String(row.id),
      title: String(row.title),
      detail: String(row.detail),
    })),
    assets: asRows(assetResult.data, "OFFER_ASSET_READBACK_INVALID").map((row) => ({
      id: String(row.id),
      slug: String(row.slug),
      label: String(row.label),
      url: String(row.url),
    })),
    cadencePurposes: asRows(cadenceResult.data, "OFFER_CADENCE_READBACK_INVALID").map((row) => ({
      channelClass: row.channel_class as PersistedOfferLayer["cadencePurposes"][number]["channelClass"],
      touchNo: Number(row.touch_no),
      purpose: row.purpose as PersistedOfferLayer["cadencePurposes"][number]["purpose"],
      assetId: row.asset_id === null ? null : String(row.asset_id),
    })),
  };
}

/** Creates the production repository over the service-role client. */
export function createOfferLayerRepository(): OfferLayerRepository {
  const client = createSupabaseServiceClient();
  return {
    loadAllowedHosts: async (tenantId) => {
      const [settings, profile] = await Promise.all([
        client.from("tenant_settings").select("tenant_id, link_whitelist").eq("tenant_id", tenantId).maybeSingle(),
        client.from("business_profiles").select("website_url").eq("tenant_id", tenantId).maybeSingle(),
      ]);
      if (settings.error) throw new Error(`OFFER_SETTINGS_READ_FAILED:${settings.error.message}`);
      const whitelist = Array.isArray(settings.data?.link_whitelist)
        ? settings.data.link_whitelist.filter((value): value is string => typeof value === "string")
        : [];
      // A missing profile is not a failure: the platform list still applies.
      const website = profile.error ? null : (profile.data?.website_url as string | null | undefined) ?? null;
      return assetHostsFor(whitelist, website);
    },
    saveDraft: async (input) => {
      const { data, error } = await client.rpc("save_offer_draft", {
        p_expected_tenant: input.tenantId,
        p_actor_id: input.actorId,
        p_draft_id: input.draftId,
        p_expected_content_hash: input.expectedContentHash,
        p_offer: {
          ...input.offer,
          prices: input.offer.prices,
          contentHash: input.contentHash,
        },
      });
      if (error) throw new Error(`SAVE_OFFER_DRAFT_FAILED:${error.message}`);
      if (typeof data !== "string") throw new Error("SAVE_OFFER_DRAFT_EMPTY");
      return data;
    },
    loadOffer: (input) => loadOfferWithChildren(client, input),
    publishDraft: async (input) => {
      const { data, error } = await client.rpc("publish_offer_draft", {
        p_expected_tenant: input.tenantId,
        p_actor_id: input.actorId,
        p_draft_id: input.draftId,
        p_expected_content_hash: input.expectedContentHash,
      });
      if (error) throw new Error(`PUBLISH_OFFER_DRAFT_FAILED:${error.message}`);
      const row = asRows(data, "PUBLISH_OFFER_DRAFT_EMPTY")[0];
      if (!row) throw new Error("PUBLISH_OFFER_DRAFT_EMPTY");
      return {
        offerId: String(row.offer_id),
        offerVersion: Number(row.offer_version),
        auditId: String(row.audit_id),
      };
    },
    loadPublishReceipt: async (input) => {
      const { data, error } = await client
        .from("audit_log")
        .select("id, tenant_id, action, target_type, target_id")
        .eq("id", input.auditId)
        .maybeSingle();
      if (
        error ||
        !data ||
        data.tenant_id !== input.tenantId ||
        data.action !== "offer.published" ||
        data.target_type !== "offer_layer" ||
        data.target_id !== input.offerId
      ) return null;
      return {
        auditId: String(data.id),
        actionKey: "offer.published",
        offerId: input.offerId,
      };
    },
  };
}

/**
 * Reads through the security-definer RPC rather than the trail table. The RPC checks actor and
 * offer tenancy together, so a route cannot turn a supplied id into a cross-tenant history read.
 */
export async function loadOfferChangeTrail(input: {
  tenantId: string;
  actorId: string;
  offerId: string;
}): Promise<OfferChangeTrailEntry[]> {
  const { data, error } = await createSupabaseServiceClient().rpc("list_offer_change_trail", {
    p_expected_tenant: input.tenantId,
    p_actor_id: input.actorId,
    p_offer_id: input.offerId,
  });
  if (error) throw new Error("OFFER_CHANGE_TRAIL_REFUSED");
  return parseOfferChangeTrail(data);
}

/**
 * Live custody probe for an authenticated coach client.
 *
 * This deliberately performs direct PostgREST writes so RLS/grant regressions cannot be hidden by
 * testing only the service-role RPC path. Success is a security failure.
 */
export async function assertCoachPostgrestWritesRefused(
  client: OfferPostgrestClient,
  tenantId: string,
) {
  const offerAttempt = await client
    .from("offer_layers")
    .update({ status: "published" })
    .eq("tenant_id", tenantId);
  if (!offerAttempt.error) throw new Error("COACH_PLATFORM_OFFER_WRITE_WAS_ALLOWED");
  const whitelistAttempt = await client
    .from("tenant_settings")
    .update({ link_whitelist: ["invalid.example"] })
    .eq("tenant_id", tenantId);
  if (!whitelistAttempt.error) throw new Error("COACH_LINK_WHITELIST_WRITE_WAS_ALLOWED");
  return {
    offer: offerAttempt.error.message,
    linkWhitelist: whitelistAttempt.error.message,
  };
}
