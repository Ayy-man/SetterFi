import type { CoachOffer } from "@/lib/engine/types";
import { OFFER_RULE_OPS, ruleSentences, type OfferRuleOp } from "@/lib/offer/rules";
import { offerLayerEngineInputLive } from "@/lib/env-contract";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type QueryResult = {
  data: unknown;
  error: { message: string } | null;
};

export type OfferEngineInputQuery = PromiseLike<QueryResult> & {
  select(columns: string): OfferEngineInputQuery;
  eq(column: string, value: unknown): OfferEngineInputQuery;
  order(column: string, options?: { ascending?: boolean }): OfferEngineInputQuery;
  limit(count: number): OfferEngineInputQuery;
  maybeSingle(): Promise<QueryResult>;
};

export type OfferEngineInputClient = {
  from(table: "offer_layers" | "offer_prices" | "offer_proof_entries" | "offer_assets"): OfferEngineInputQuery;
};

const OFFER_LAYER_COLUMNS = [
  "id",
  "tenant_id",
  "version",
  "program_name",
  "products",
  "brand_voice",
  "voice_style_answer",
  "voice_objection_answer",
  "voice_followup_answer",
  "qualification_rules",
  "voice_guidelines",
  "credit_min",
  "funding_goal_min_cents",
  "booking_horizon_days",
].join(", ");

const OFFER_PRICE_COLUMNS = "id, label, amount_cents";
const OFFER_PROOF_COLUMNS = "id, title, detail";
const OFFER_ASSET_COLUMNS = "id, slug, label, url";

function record(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}

function rows(value: unknown, error: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(error);
  return value.map((row) => record(row, error));
}

function nullableString(value: unknown, error: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(error);
  return value;
}

function nullableNumber(value: unknown, error: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(error);
  return value;
}

function requiredString(value: unknown, error: string): string {
  if (typeof value !== "string") throw new Error(error);
  return value;
}

function requiredNumber(value: unknown, error: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(error);
  return value;
}

function stringList(value: unknown, error: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(error);
  return value;
}

/**
 * Loads the legacy (pre-runtime-bundle) engine offer from its normalized source tables.
 *
 * The engine has no FAQ input: `offer_layers.faq` was intentionally removed and no replacement
 * source exists, so this path deliberately supplies no FAQ context instead of treating a dropped
 * column as an empty FAQ. `credit_min_enforced` has the same absence problem, but deciding whether
 * `credit_min` should qualify or disqualify a lead belongs to the client; keep `creditMin` neutral
 * until that authority is defined.
 */
/**
 * The values the engine has actually been receiving since Phase 2 dropped the columns these were
 * read from: nothing. Kept as an explicit, named state rather than left implicit, so the gate-off
 * path is a decision someone can see rather than the accident it was until tonight.
 */
/** The stored jsonb rules as sentences; a row that is not a rule is a corrupted read. */
function storedRuleSentences(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("PUBLISHED_OFFER_RULES_INVALID");
  return ruleSentences(value.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("PUBLISHED_OFFER_RULES_INVALID");
    const rule = row as Record<string, unknown>;
    if (
      typeof rule.subject !== "string" ||
      typeof rule.op !== "string" ||
      !OFFER_RULE_OPS.includes(rule.op as OfferRuleOp) ||
      typeof rule.value !== "string"
    ) throw new Error("PUBLISHED_OFFER_RULES_INVALID");
    return { subject: rule.subject, op: rule.op as OfferRuleOp, value: rule.value };
  }));
}

const UNLOADED_OFFER_LAYER = {
  voiceAnswers: [] as string[],
  qualificationRules: [] as string[],
  voiceGuidelines: null as string | null,
  proof: [] as string[],
  assets: [] as { slug: string; url: string }[],
};

export async function loadLegacyOfferEngineInput(
  client: OfferEngineInputClient,
  tenantId: string,
  offerLayerLive: () => boolean = offerLayerEngineInputLive,
): Promise<CoachOffer> {
  const offerResult = await client
    .from("offer_layers")
    .select(OFFER_LAYER_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("status", "published")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (offerResult.error || !offerResult.data) {
    throw new Error(`PUBLISHED_OFFER_REQUIRED:${offerResult.error?.message ?? "empty"}`);
  }

  const offer = record(offerResult.data, "PUBLISHED_OFFER_INPUT_INVALID");
  const offerId = requiredString(offer.id, "PUBLISHED_OFFER_INPUT_INVALID");
  if (requiredString(offer.tenant_id, "PUBLISHED_OFFER_INPUT_INVALID") !== tenantId) {
    throw new Error("PUBLISHED_OFFER_TENANT_MISMATCH");
  }
  // Validate the surviving configured value so a renamed/dropped column cannot become an implicit
  // null. The engine remains neutral until the client defines the missing enforcement authority.
  nullableNumber(offer.credit_min, "PUBLISHED_OFFER_INPUT_INVALID");

  const [pricesResult, proofResult, assetsResult] = await Promise.all([
    client.from("offer_prices").select(OFFER_PRICE_COLUMNS).eq("offer_id", offerId).order("id"),
    client.from("offer_proof_entries").select(OFFER_PROOF_COLUMNS).eq("offer_id", offerId).order("id"),
    client.from("offer_assets").select(OFFER_ASSET_COLUMNS).eq("offer_id", offerId).order("id"),
  ]);
  for (const [table, result] of [
    ["offer_prices", pricesResult],
    ["offer_proof_entries", proofResult],
    ["offer_assets", assetsResult],
  ] as const) {
    if (result.error) throw new Error(`PUBLISHED_OFFER_CHILD_READ_FAILED:${table}:${result.error.message}`);
  }

  const voiceAnswers = [
    nullableString(offer.voice_style_answer, "PUBLISHED_OFFER_INPUT_INVALID"),
    nullableString(offer.voice_objection_answer, "PUBLISHED_OFFER_INPUT_INVALID"),
    nullableString(offer.voice_followup_answer, "PUBLISHED_OFFER_INPUT_INVALID"),
  ].filter((answer): answer is string => answer !== null);
  // The rows above are still read and still validated with the gate off, so a malformed offer
  // fails here either way. Only what reaches the engine is withheld.
  const loaded = offerLayerLive();

  return {
    tenantId,
    version: requiredNumber(offer.version, "PUBLISHED_OFFER_INPUT_INVALID"),
    programName: nullableString(offer.program_name, "PUBLISHED_OFFER_INPUT_INVALID") ?? "",
    products: stringList(offer.products, "PUBLISHED_OFFER_INPUT_INVALID"),
    brandVoice: nullableString(offer.brand_voice, "PUBLISHED_OFFER_INPUT_INVALID") ?? "",
    voiceAnswers: loaded ? voiceAnswers : UNLOADED_OFFER_LAYER.voiceAnswers,
    qualificationRules: loaded ? storedRuleSentences(offer.qualification_rules) : UNLOADED_OFFER_LAYER.qualificationRules,
    voiceGuidelines: loaded
      ? nullableString(offer.voice_guidelines ?? null, "PUBLISHED_OFFER_INPUT_INVALID")
      : UNLOADED_OFFER_LAYER.voiceGuidelines,
    proof: loaded
      ? rows(proofResult.data, "PUBLISHED_OFFER_PROOF_INVALID").map((entry) =>
        `${requiredString(entry.title, "PUBLISHED_OFFER_PROOF_INVALID")}: ${requiredString(entry.detail, "PUBLISHED_OFFER_PROOF_INVALID")}`,
      )
      : UNLOADED_OFFER_LAYER.proof,
    assets: loaded
      ? rows(assetsResult.data, "PUBLISHED_OFFER_ASSETS_INVALID").map((asset) => ({
        slug: requiredString(asset.slug, "PUBLISHED_OFFER_ASSETS_INVALID"),
        url: requiredString(asset.url, "PUBLISHED_OFFER_ASSETS_INVALID"),
      }))
      : UNLOADED_OFFER_LAYER.assets,
    offerPrices: rows(pricesResult.data, "PUBLISHED_OFFER_PRICES_INVALID").map((price) => ({
      id: requiredString(price.id, "PUBLISHED_OFFER_PRICES_INVALID"),
      label: requiredString(price.label, "PUBLISHED_OFFER_PRICES_INVALID"),
      amountCents: requiredNumber(price.amount_cents, "PUBLISHED_OFFER_PRICES_INVALID"),
    })),
    creditMin: null,
    fundingGoalMinCents: nullableNumber(offer.funding_goal_min_cents, "PUBLISHED_OFFER_INPUT_INVALID"),
    bookingHorizonDays: requiredNumber(offer.booking_horizon_days, "PUBLISHED_OFFER_INPUT_INVALID"),
  };
}

export async function loadLiveLegacyOfferEngineInput(tenantId: string) {
  const client = createSupabaseServiceClient() as unknown as OfferEngineInputClient;
  return loadLegacyOfferEngineInput(client, tenantId);
}
