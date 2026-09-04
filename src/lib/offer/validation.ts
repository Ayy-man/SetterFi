/**
 * Hand-narrowing for the coach offer boundary.
 *
 * The project has no schema-validation dependency. Unknown fields fail rather than being stripped,
 * because silently dropping a platform-owned field would hide a mass-assignment attempt.
 */

import {
  OFFER_BOUNDS,
  OFFER_PRODUCTS,
  type OfferProduct,
} from "@/lib/brain/contracts";
import {
  OFFER_CADENCE_CHANNELS,
  OFFER_CADENCE_PURPOSES,
  type CoachCadencePurposeInput,
  type CoachOfferAssetInput,
  type CoachOfferDraftInput,
  type CoachOfferPriceInput,
  type CoachOfferProofInput,
} from "@/lib/offer/types";
import {
  OFFER_RULE_BOUNDS,
  OFFER_RULE_OPS,
  ruleTakesValue,
  type OfferQualificationRule,
} from "@/lib/offer/rules";

const COACH_KEYS = [
  "programName",
  "programDescription",
  "creditMin",
  "fundingGoalMinCents",
  "fundingGoalMaxCents",
  "monthlyRevenueMinCents",
  "creditRepair",
  "products",
  "bookingHorizonDays",
  "bookingMode",
  "brandVoice",
  "resultsTimelineMinDays",
  "resultsTimelineMaxDays",
  "refundPosture",
  "voiceStyleAnswer",
  "voiceObjectionAnswer",
  "voiceFollowupAnswer",
  "qualificationRules",
  "voiceGuidelines",
  "prices",
  "proof",
  "assets",
  "cadencePurposes",
] as const;

const CREDIT_REPAIR_VALUES = [
  "yes_included",
  "yes_extra_fee",
  "no_refer_out",
  "no_good_credit_only",
] as const;
const BOOKING_MODES = ["direct", "link"] as const;
const BRAND_VOICES = ["friendly", "neutral", "professional"] as const;
const REFUND_POSTURES = ["none", "conditional", "published_policy"] as const;
const BILLING_PERIODS = ["one_time", "monthly", "annual", "weekly", "per_session"] as const;
const STABLE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type RecordValue = Record<string, unknown>;

export class OfferValidationError extends Error {
  constructor(readonly code: string, readonly field: string) {
    super(`${code}:${field}`);
    this.name = "OfferValidationError";
  }
}

function record(value: unknown, field: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OfferValidationError("OFFER_OBJECT_REQUIRED", field);
  }
  return value as RecordValue;
}

function exactKeys(value: RecordValue, keys: readonly string[], field: string) {
  const unknown = Object.keys(value).find((key) => !keys.includes(key));
  if (unknown) throw new OfferValidationError("OFFER_PLATFORM_FIELD_FORBIDDEN", `${field}.${unknown}`);
}

function requiredString(value: unknown, field: string, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new OfferValidationError("OFFER_STRING_INVALID", field);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string, max: number) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > max) {
    throw new OfferValidationError("OFFER_STRING_INVALID", field);
  }
  return value.trim() || null;
}

function integer(
  value: unknown,
  field: string,
  options: { nullable: false; positive?: boolean },
): number;
function integer(
  value: unknown,
  field: string,
  options?: { nullable?: true; positive?: boolean },
): number | null;
function integer(
  value: unknown,
  field: string,
  { nullable = true, positive = false }: { nullable?: boolean; positive?: boolean } = {},
) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || (positive ? Number(value) <= 0 : Number(value) < 0)) {
    throw new OfferValidationError("OFFER_INTEGER_INVALID", field);
  }
  return Number(value);
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  nullable: false,
): T;
function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  nullable?: true,
): T | null;
function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  nullable = true,
): T | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new OfferValidationError("OFFER_ENUM_INVALID", field);
  }
  return value as T;
}

function array(value: unknown, field: string, max: number) {
  if (!Array.isArray(value) || value.length > max) {
    throw new OfferValidationError("OFFER_ARRAY_INVALID", field);
  }
  return value;
}

function validatePrices(value: unknown): CoachOfferPriceInput[] {
  return array(value, "prices", OFFER_BOUNDS.price.maxRows).map((candidate, index) => {
    const price = record(candidate, `prices[${index}]`);
    exactKeys(price, ["label", "amountCents", "billingPeriod"], `prices[${index}]`);
    return {
      label: requiredString(price.label, `prices[${index}].label`, OFFER_BOUNDS.price.labelMax),
      amountCents: integer(price.amountCents, `prices[${index}].amountCents`, { nullable: false }),
      billingPeriod: enumValue(
        price.billingPeriod,
        BILLING_PERIODS,
        `prices[${index}].billingPeriod`,
      ),
    };
  });
}

function validateRules(value: unknown): OfferQualificationRule[] {
  return array(value, "qualificationRules", OFFER_RULE_BOUNDS.maxRows).map((candidate, index) => {
    const rule = record(candidate, `qualificationRules[${index}]`);
    exactKeys(rule, ["subject", "op", "value"], `qualificationRules[${index}]`);
    const op = enumValue(rule.op, OFFER_RULE_OPS, `qualificationRules[${index}].op`, false);
    const subject = requiredString(
      rule.subject,
      `qualificationRules[${index}].subject`,
      OFFER_RULE_BOUNDS.subjectMax,
    );
    if (typeof rule.value !== "string" || rule.value.length > OFFER_RULE_BOUNDS.valueMax) {
      throw new OfferValidationError("OFFER_STRING_INVALID", `qualificationRules[${index}].value`);
    }
    const trimmed = rule.value.trim();
    if (ruleTakesValue(op) && !trimmed) {
      throw new OfferValidationError("OFFER_RULE_VALUE_REQUIRED", `qualificationRules[${index}].value`);
    }
    return { subject, op, value: ruleTakesValue(op) ? trimmed : "" };
  });
}

function validateProof(value: unknown): CoachOfferProofInput[] {
  return array(value, "proof", OFFER_BOUNDS.proof.maxRows).map((candidate, index) => {
    const proof = record(candidate, `proof[${index}]`);
    exactKeys(proof, ["title", "detail"], `proof[${index}]`);
    return {
      title: requiredString(proof.title, `proof[${index}].title`, OFFER_BOUNDS.proof.titleMax),
      detail: requiredString(proof.detail, `proof[${index}].detail`, OFFER_BOUNDS.proof.detailMax),
    };
  });
}

function allowedAssetHost(url: URL, allowedHosts: readonly string[]) {
  const hostname = url.hostname.toLowerCase();
  return allowedHosts.some((allowed) => {
    const normalized = allowed.trim().toLowerCase();
    return normalized && (hostname === normalized || hostname.endsWith(`.${normalized}`));
  });
}

function validateAssets(value: unknown, allowedHosts: readonly string[]): CoachOfferAssetInput[] {
  return array(value, "assets", OFFER_BOUNDS.asset.maxRows).map((candidate, index) => {
    const asset = record(candidate, `assets[${index}]`);
    exactKeys(asset, ["slug", "label", "url"], `assets[${index}]`);
    const slug = requiredString(asset.slug, `assets[${index}].slug`, OFFER_BOUNDS.asset.slugMax);
    if (!STABLE_SLUG.test(slug)) {
      throw new OfferValidationError("OFFER_ASSET_SLUG_INVALID", `assets[${index}].slug`);
    }
    const urlValue = requiredString(asset.url, `assets[${index}].url`, OFFER_BOUNDS.asset.urlMax);
    let url: URL;
    try {
      url = new URL(urlValue);
    } catch {
      throw new OfferValidationError("OFFER_ASSET_URL_INVALID", `assets[${index}].url`);
    }
    if (url.protocol !== "https:" || !allowedAssetHost(url, allowedHosts)) {
      throw new OfferValidationError("OFFER_ASSET_HOST_NOT_WHITELISTED", `assets[${index}].url`);
    }
    return {
      slug,
      label: requiredString(asset.label, `assets[${index}].label`, OFFER_BOUNDS.asset.labelMax),
      url: url.toString(),
    };
  });
}

function validateCadence(value: unknown): CoachCadencePurposeInput[] {
  const seen = new Set<string>();
  return array(value, "cadencePurposes", Number.MAX_SAFE_INTEGER).map((candidate, index) => {
    const cadence = record(candidate, `cadencePurposes[${index}]`);
    exactKeys(
      cadence,
      ["channelClass", "touchNo", "purpose", "assetId"],
      `cadencePurposes[${index}]`,
    );
    const channelClass = enumValue(
      cadence.channelClass,
      OFFER_CADENCE_CHANNELS,
      `cadencePurposes[${index}].channelClass`,
      false,
    );
    const touchNo = integer(cadence.touchNo, `cadencePurposes[${index}].touchNo`, {
      nullable: false,
      positive: true,
    });
    const purpose = enumValue(
      cadence.purpose,
      OFFER_CADENCE_PURPOSES,
      `cadencePurposes[${index}].purpose`,
      false,
    );
    const assetId = optionalString(cadence.assetId, `cadencePurposes[${index}].assetId`, 64);
    const key = `${channelClass}:${touchNo}`;
    if (seen.has(key)) throw new OfferValidationError("OFFER_CADENCE_DUPLICATE", key);
    seen.add(key);
    return { channelClass, touchNo, purpose, assetId };
  });
}

/** Returns the exact coach-owned payload accepted by save_offer_draft. */
export function validateCoachOfferDraft(
  value: unknown,
  allowedHosts: readonly string[],
): CoachOfferDraftInput {
  const offer = record(value, "offer");
  exactKeys(offer, COACH_KEYS, "offer");
  const products = array(offer.products, "products", OFFER_BOUNDS.productsMax).map((product) => {
    if (typeof product !== "string" || !OFFER_PRODUCTS.includes(product as OfferProduct)) {
      throw new OfferValidationError("OFFER_PRODUCT_INVALID", "products");
    }
    return product as OfferProduct;
  });
  const fundingGoalMinCents = integer(offer.fundingGoalMinCents, "fundingGoalMinCents");
  const fundingGoalMaxCents = integer(offer.fundingGoalMaxCents, "fundingGoalMaxCents");
  const resultsTimelineMinDays = integer(offer.resultsTimelineMinDays, "resultsTimelineMinDays");
  const resultsTimelineMaxDays = integer(offer.resultsTimelineMaxDays, "resultsTimelineMaxDays");
  if (
    fundingGoalMinCents !== null &&
    fundingGoalMaxCents !== null &&
    fundingGoalMinCents > fundingGoalMaxCents
  ) {
    throw new OfferValidationError("OFFER_RANGE_INVALID", "fundingGoal");
  }
  if (
    resultsTimelineMinDays !== null &&
    resultsTimelineMaxDays !== null &&
    resultsTimelineMinDays > resultsTimelineMaxDays
  ) {
    throw new OfferValidationError("OFFER_RANGE_INVALID", "resultsTimeline");
  }
  return {
    programName: requiredString(offer.programName, "programName", OFFER_BOUNDS.programNameMax),
    programDescription: optionalString(
      offer.programDescription,
      "programDescription",
      OFFER_BOUNDS.programDescriptionMax,
    ),
    creditMin: integer(offer.creditMin, "creditMin"),
    fundingGoalMinCents,
    fundingGoalMaxCents,
    monthlyRevenueMinCents: integer(offer.monthlyRevenueMinCents, "monthlyRevenueMinCents"),
    creditRepair: enumValue(offer.creditRepair, CREDIT_REPAIR_VALUES, "creditRepair"),
    products,
    bookingHorizonDays: integer(offer.bookingHorizonDays, "bookingHorizonDays", {
      nullable: false,
      positive: true,
    }),
    bookingMode: enumValue(offer.bookingMode, BOOKING_MODES, "bookingMode", false),
    brandVoice: enumValue(offer.brandVoice, BRAND_VOICES, "brandVoice"),
    resultsTimelineMinDays,
    resultsTimelineMaxDays,
    refundPosture: enumValue(offer.refundPosture, REFUND_POSTURES, "refundPosture"),
    voiceStyleAnswer: optionalString(
      offer.voiceStyleAnswer,
      "voiceStyleAnswer",
      OFFER_BOUNDS.voiceAnswerMax,
    ),
    voiceObjectionAnswer: optionalString(
      offer.voiceObjectionAnswer,
      "voiceObjectionAnswer",
      OFFER_BOUNDS.voiceAnswerMax,
    ),
    voiceFollowupAnswer: optionalString(
      offer.voiceFollowupAnswer,
      "voiceFollowupAnswer",
      OFFER_BOUNDS.voiceAnswerMax,
    ),
    qualificationRules: validateRules(offer.qualificationRules),
    voiceGuidelines: optionalString(
      offer.voiceGuidelines,
      "voiceGuidelines",
      OFFER_BOUNDS.voiceGuidelinesMax,
    ),
    prices: validatePrices(offer.prices),
    proof: validateProof(offer.proof),
    assets: validateAssets(offer.assets, allowedHosts),
    cadencePurposes: validateCadence(offer.cadencePurposes),
  };
}
