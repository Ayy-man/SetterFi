/** Shared Phase 2 contracts. Later plans import these shapes instead of restating them. */

import type { QualificationRule as DomainQualificationRule } from "@/lib/domain/qualification";
import type { OfferQualificationRule } from "@/lib/offer/rules";

export const OFFER_PRODUCTS = [
  "personal CC",
  "personal loans",
  "biz CC",
  "biz line of credit",
  "biz term loans",
] as const;

export const OFFER_BOUNDS = {
  programNameMax: 120,
  programDescriptionMax: 500,
  price: { maxRows: 8, labelMax: 60 },
  proof: { maxRows: 12, titleMax: 90, detailMax: 280 },
  asset: { maxRows: 12, slugMax: 64, labelMax: 90, urlMax: 500 },
  voiceAnswerMax: 180,
  voiceGuidelinesMax: 1200,
  productsMax: 12,
} as const;

export const COMPLIANCE_RULE_IDS = [
  "CLAIM-001",
  "ECHO-001",
  "LEN-001",
  "LINK-001",
  "NUM-001",
  "SCOPE-001",
] as const;

export type OfferProduct = (typeof OFFER_PRODUCTS)[number];
export type ComplianceRuleId = (typeof COMPLIANCE_RULE_IDS)[number];
export type ImportFlagCode =
  | "source_shape"
  | "first_person_pii"
  | "unbound_figure"
  | "unknown_placeholder"
  | "bare_x"
  | "multi_category"
  | "prose_shape"
  | "social_handle"
  | "brand_name"
  | "proof_claim"
  | "operator_note";
export type ImportDisposition = "shared" | "tenant_specific" | "needs_rewrite";
/**
 * A disposition and where it routes. `tenant_specific` is a route, not a quarantine label, so it
 * carries the tenant the knowledge entry is scoped to; the other two never carry one.
 */
export type ImportDispositionPayload = {
  disposition: ImportDisposition;
  tenantId: string | null;
};

export type PublishedOfferPrice = {
  id: string;
  label: string;
  amountCents: number;
  billingPeriod: "one_time" | "monthly" | "annual" | "weekly" | "per_session" | null;
};

export type PublishedOfferProof = {
  id: string;
  title: string;
  detail: string;
};

export type PublishedOfferAsset = {
  id: string;
  slug: string;
  label: string;
  url: string;
};

export type PublishedCoachOffer = {
  id: string;
  tenantId: string;
  status: "published";
  version: number;
  contentHash: string;
  programName: string;
  programDescription: string | null;
  creditMin: number | null;
  fundingGoalMinCents: number | null;
  fundingGoalMaxCents: number | null;
  monthlyRevenueMinCents: number | null;
  businessRevenueRequired: boolean;
  creditRepair: "yes_included" | "yes_extra_fee" | "no_refer_out" | "no_good_credit_only" | null;
  products: readonly OfferProduct[];
  bookingHorizonDays: number;
  bookingMode: "direct" | "link";
  brandVoice: "friendly" | "neutral" | "professional" | null;
  resultsTimelineMinDays: number | null;
  resultsTimelineMaxDays: number | null;
  refundPosture: "none" | "conditional" | "published_policy" | null;
  voiceStyleAnswer: string | null;
  voiceObjectionAnswer: string | null;
  voiceFollowupAnswer: string | null;
  /** The coach's own rules past the stored bounds; see `@/lib/offer/rules`. */
  qualificationRules: readonly OfferQualificationRule[];
  /** Free paragraph on how the agent should sound; ingested into the prompt as tone guidance. */
  voiceGuidelines: string | null;
  offerPrices: readonly PublishedOfferPrice[];
  proof: readonly PublishedOfferProof[];
  assets: readonly PublishedOfferAsset[];
};

export type BrainSnapshot = {
  id: string;
  version: number;
  contentHash: string;
  sourceHash: string;
  payload: Readonly<Record<string, unknown>>;
  compiledPlatform: string;
  platformTokens: number;
  knowledgeMode: "inline" | "retrieved";
  /**
   * Cosine-similarity floor below which a ranked entry is not a grounded answer. Absent means the
   * code default applies; a snapshot payload may lower or raise it under `retrievalFloor`.
   */
  retrievalFloor?: number;
};

export type QualificationRule = DomainQualificationRule;

/**
 * One reviewed figure inside a response template and what supplies it. `offset` is where the
 * import detector found it; the runtime matches on kind and value only, because the rendered
 * answer has moved every offset by the time a lead reads it.
 */
export type KnowledgeNumberBinding = {
  kind: "currency" | "percentage" | "score";
  value: number;
  binding:
    | "credit_min"
    | "funding_goal_min_cents"
    | "funding_goal_max_cents"
    | "monthly_revenue_min_cents"
    | "results_timeline_min_days"
    | "results_timeline_max_days"
    | "offer_prices"
    | "booking_horizon_days"
    | "platform_constant";
  offset?: number;
};

/** A published knowledge entry as the runtime reads it from the immutable snapshot. */
export type PublishedKnowledgeEntry = {
  entryId: string;
  category: string;
  question: string;
  responseTemplate: string;
  numberBindings: readonly KnowledgeNumberBinding[];
  rewriteHash: string | null;
  sourceRef: string | null;
};

export type PublishedRuntimeBundle = {
  brain: BrainSnapshot;
  offer: PublishedCoachOffer;
  qualification: readonly QualificationRule[];
  qualificationApproved: boolean;
  qualificationSource: "platform" | "demo_seed";
  renderSources: {
    bookingUrl: string | null;
    qualificationSummary: string;
    qualificationInputs: readonly string[];
    assetUrlsBySlug: Readonly<Record<string, string>>;
  };
  snapshotId: string;
  brainVersion: number;
  offerVersion: number;
  contentHash: string;
  /**
   * Every published entry of the snapshot, present only when the snapshot's `knowledgeMode` is
   * `inline`. The engine renders them into the prompt whole and still ranks for the trace.
   */
  knowledgeEntries?: readonly PublishedKnowledgeEntry[];
};

export type RetrievalCandidate = {
  entryId: string;
  category: string;
  responseTemplate: string;
  numberBindings: readonly KnowledgeNumberBinding[];
  rewriteHash: string | null;
  /** The variant phrasing that won the ranking for this entry, or null when its own question did. */
  matchedVariant: string | null;
  similarity: number;
  categoryBoost: number;
  score: number;
};

export type RenderedCandidate = RetrievalCandidate & { content: string; dropped: false };
export type DroppedCandidate = { entryId: string; dropped: true; reason: string };

export type RenderCandidates = (input: {
  candidates: readonly RetrievalCandidate[];
  offer: PublishedCoachOffer;
  registry: unknown;
  renderSources: PublishedRuntimeBundle["renderSources"];
}) => { included: RenderedCandidate[]; dropped: DroppedCandidate[] };
// Phase 10: the objection draft-payload contract.
//
// Objections ride in the canonical payload's `entities` array as type `brain_objection` rather
// than as a sibling top-level key, because `diffBrainPayloads` only walks `payload.entities`. A
// sibling key would still change the content hash but would render as "changed" with an empty
// change list, telling an admin something moved without saying what. Riding in `entities` earns
// per-objection added/changed/removed rows from the existing diff engine.
//
// This module is the single statement of these key names. `publish_brain_draft` reads exactly
// these keys out of the locked draft payload, and the live-Postgres suite builds its payloads
// through `brainObjectionDraftEntity`, so a rename on either side fails a test instead of
// silently publishing an objection with empty fields.

export const BRAIN_OBJECTION_ENTITY_TYPE = "brain_objection" as const;

/** The same five values the CHECK on `public.brain_objections.category` enforces. */
export const BRAIN_OBJECTION_CATEGORIES = [
  "timing",
  "clarity",
  "pricing",
  "compliance",
  "partner",
] as const;

export const BRAIN_OBJECTION_PAYLOAD_KEYS = [
  "label",
  "pattern",
  "matchKeywords",
  "response",
  "category",
  "hardGate",
] as const;

export type BrainObjectionCategory = (typeof BRAIN_OBJECTION_CATEGORIES)[number];
export type BrainObjectionPayloadKey = (typeof BRAIN_OBJECTION_PAYLOAD_KEYS)[number];

/** The named TS counterpart of the SQL columns, so the mapping is written down rather than assumed. */
export const BRAIN_OBJECTION_SQL_COLUMN_BY_KEY: Record<BrainObjectionPayloadKey, string> = {
  label: "label",
  pattern: "pattern",
  matchKeywords: "match_keywords",
  response: "response",
  category: "category",
  hardGate: "hard_gate",
};

export type BrainObjectionDraftValue = {
  label: string;
  pattern: string | null;
  matchKeywords: readonly string[];
  response: string;
  category: BrainObjectionCategory;
  hardGate: boolean;
};

export type BrainObjectionDraftInput = {
  id: string;
  label: string;
  pattern?: string | null;
  matchKeywords?: readonly string[];
  response: string;
  category: string;
  hardGate?: boolean;
};

/**
 * Keywords are lowercased, trimmed, de-duplicated and sorted before hashing. The consequence is
 * deliberate: reordering keyword chips in the admin UI does not mint a Brain version or force a
 * re-eval, while adding or removing a keyword does. It also means the array that lands in the
 * snapshot is already in the normalized form the runtime matcher wants, so matching never has to
 * normalize at query time.
 */
export function normalizeObjectionKeywords(keywords: readonly string[] = []) {
  return [...new Set(keywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean))]
    .sort();
}

export function brainObjectionDraftEntity(input: BrainObjectionDraftInput): {
  type: typeof BRAIN_OBJECTION_ENTITY_TYPE;
  id: string;
  value: BrainObjectionDraftValue;
} {
  const id = input.id.trim();
  if (!id) throw new Error("BRAIN_OBJECTION_ID_REQUIRED");
  const label = input.label.trim();
  if (!label) throw new Error(`BRAIN_OBJECTION_LABEL_REQUIRED:${id}`);
  const response = input.response.trim();
  if (!response) throw new Error(`BRAIN_OBJECTION_RESPONSE_REQUIRED:${id}`);
  const category = input.category.trim() as BrainObjectionCategory;
  if (!BRAIN_OBJECTION_CATEGORIES.includes(category)) {
    throw new Error(`BRAIN_OBJECTION_CATEGORY_INVALID:${id}`);
  }
  return {
    type: BRAIN_OBJECTION_ENTITY_TYPE,
    id,
    value: {
      label,
      pattern: input.pattern?.trim() || null,
      matchKeywords: normalizeObjectionKeywords(input.matchKeywords),
      response,
      category,
      hardGate: input.hardGate === true,
    },
  };
}

/**
 * One objection matched out of the published snapshot for one inbound turn.
 *
 * The absence of `entryId`, `content` and `similarity` is the point: without them this type is not
 * structurally assignable to `RetrievalCandidate`, so an objection cannot be handed to
 * `renderCandidates`, the number allowlist or the citation path without a compile error. Knowledge
 * identity and objection identity are kept apart by the type system rather than by convention,
 * because a convention is exactly what fails quietly when someone spreads one into the other.
 */
export type ObjectionCandidate = {
  objectionId: string;
  snapshotId: string;
  label: string;
  response: string;
  category: BrainObjectionCategory;
  hardGate: boolean;
  matchedKeywords: readonly string[];
  keywordHits: number;
};
