/**
 * Coherent Phase 2 runtime authority loaded at the start of every turn.
 *
 * Immutable Brain snapshots and the sole published offer are read together on every call. Mutable
 * authoring rows and caller-supplied qualification data have no entry point in this module.
 */

import {
  type BrainSnapshot,
  type PublishedCoachOffer,
  type PublishedKnowledgeEntry,
  type PublishedRuntimeBundle,
  type QualificationRule,
} from "@/lib/brain/contracts";
import { knowledgeNumberBindings } from "@/lib/brain/provenance";
import { FUNDING_GOALS, FUNDING_TIMELINES } from "@/lib/domain/qualification";
import { phase2Live } from "@/lib/env-contract";
import { createOfferLayerRepository } from "@/lib/repositories/offer-layer";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type TenantRuntimeRow = { id: string; isDemo: boolean };
type CalendarRuntimeRow = { bookingUrl: string | null };
type QualificationStorageRow = {
  ruleKey: string;
  label: string;
  outcome: string;
  minScore: number | null;
  maxScore: number | null;
  businessStage: string | null;
  minAnnualRevenueCents: number | null;
  fundingGoals: unknown;
  timelines: unknown;
};

export type BrainRuntimeDependencies = {
  phase2Enabled(): boolean;
  loadTenant(tenantId: string): Promise<TenantRuntimeRow | null>;
  loadCurrentSnapshot(): Promise<unknown | null>;
  loadPublishedOffer(tenantId: string): Promise<unknown | null>;
  loadPrimaryCalendar(tenantId: string): Promise<CalendarRuntimeRow | null>;
  loadDemoQualification(): Promise<readonly QualificationStorageRow[]>;
  /**
   * Every entry of one immutable snapshot. Read only when the snapshot is in `inline` mode, where
   * the whole published Brain goes into the prompt; a retrieved-mode turn never calls it. Optional
   * so an inline snapshot behind a loader without it degrades to retrieval rather than failing.
   */
  loadSnapshotEntries?(snapshotId: string): Promise<readonly unknown[]>;
};

type RuntimeRecord = Record<string, unknown>;

export class BrainRuntimeReadinessError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BrainRuntimeReadinessError";
  }
}

function record(value: unknown, code: string): RuntimeRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrainRuntimeReadinessError(code);
  }
  return value as RuntimeRecord;
}

function requiredString(value: unknown, code: string) {
  if (typeof value !== "string" || !value.trim()) throw new BrainRuntimeReadinessError(code);
  return value;
}

function positiveVersion(value: unknown, code: string) {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new BrainRuntimeReadinessError(code);
  return Number(value);
}

function hash(value: unknown, code: string) {
  const candidate = requiredString(value, code);
  if (!/^[0-9a-f]{64}$/.test(candidate)) throw new BrainRuntimeReadinessError(code);
  return candidate;
}

function ruleId(value: unknown): QualificationRule["id"] {
  switch (value) {
    case "strong-credit":
    case "low-credit":
    case "startup-nurture":
    case "revenue-qualified":
      return value;
    default:
      throw new BrainRuntimeReadinessError("RUNTIME_QUALIFICATION_RULE_INVALID");
  }
}

function outcome(value: unknown): QualificationRule["outcome"] {
  if (value !== "BOOK" && value !== "SOFT_DQ" && value !== "HARD_DQ") {
    throw new BrainRuntimeReadinessError("RUNTIME_QUALIFICATION_OUTCOME_INVALID");
  }
  return value;
}

function businessStage(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (value !== "startup" && value !== "operating" && value !== "unknown") {
    throw new BrainRuntimeReadinessError("RUNTIME_QUALIFICATION_STAGE_INVALID");
  }
  return value;
}

function optionalNumber(value: unknown, code: string) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new BrainRuntimeReadinessError(code);
  }
  return value;
}

function stringArray(value: unknown, code: string) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new BrainRuntimeReadinessError(code);
  }
  return value as string[];
}

function fundingGoals(value: unknown) {
  const values = stringArray(value, "RUNTIME_QUALIFICATION_GOALS_INVALID");
  if (values?.some((entry) => !FUNDING_GOALS.includes(entry as (typeof FUNDING_GOALS)[number]))) {
    throw new BrainRuntimeReadinessError("RUNTIME_QUALIFICATION_GOALS_INVALID");
  }
  return values as QualificationRule["conditions"]["fundingGoals"];
}

function fundingTimelines(value: unknown) {
  const values = stringArray(value, "RUNTIME_QUALIFICATION_TIMELINES_INVALID");
  if (
    values?.some((entry) => !FUNDING_TIMELINES.includes(entry as (typeof FUNDING_TIMELINES)[number]))
  ) {
    throw new BrainRuntimeReadinessError("RUNTIME_QUALIFICATION_TIMELINES_INVALID");
  }
  return values as QualificationRule["conditions"]["timelines"];
}

function snapshotQualification(value: unknown): QualificationRule[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0) {
    throw new BrainRuntimeReadinessError("RUNTIME_QUALIFICATION_SNAPSHOT_INVALID");
  }
  return value.map((candidate) => {
    const row = record(candidate, "RUNTIME_QUALIFICATION_SNAPSHOT_INVALID");
    const conditions = record(row.conditions ?? {}, "RUNTIME_QUALIFICATION_CONDITIONS_INVALID");
    return {
      id: ruleId(row.id),
      label: requiredString(row.label, "RUNTIME_QUALIFICATION_LABEL_INVALID"),
      outcome: outcome(row.outcome),
      conditions: {
        minScore: optionalNumber(conditions.minScore, "RUNTIME_QUALIFICATION_SCORE_INVALID"),
        maxScore: optionalNumber(conditions.maxScore, "RUNTIME_QUALIFICATION_SCORE_INVALID"),
        businessStage: businessStage(conditions.businessStage),
        minAnnualRevenue: optionalNumber(
          conditions.minAnnualRevenue,
          "RUNTIME_QUALIFICATION_REVENUE_INVALID",
        ),
        fundingGoals: fundingGoals(conditions.fundingGoals),
        timelines: fundingTimelines(conditions.timelines),
      },
    };
  });
}

function demoQualification(rows: readonly QualificationStorageRow[]): QualificationRule[] {
  if (rows.length === 0) throw new BrainRuntimeReadinessError("RUNTIME_DEMO_QUALIFICATION_REQUIRED");
  return rows.map((row) => ({
    id: ruleId(row.ruleKey),
    label: requiredString(row.label, "RUNTIME_QUALIFICATION_LABEL_INVALID"),
    outcome: outcome(row.outcome),
    conditions: {
      minScore: optionalNumber(row.minScore, "RUNTIME_QUALIFICATION_SCORE_INVALID"),
      maxScore: optionalNumber(row.maxScore, "RUNTIME_QUALIFICATION_SCORE_INVALID"),
      businessStage: businessStage(row.businessStage),
      minAnnualRevenue: row.minAnnualRevenueCents === null
        ? undefined
        : optionalNumber(
            row.minAnnualRevenueCents / 100,
            "RUNTIME_QUALIFICATION_REVENUE_INVALID",
          ),
      fundingGoals: fundingGoals(row.fundingGoals),
      timelines: fundingTimelines(row.timelines),
    },
  }));
}

function retrievalFloor(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new BrainRuntimeReadinessError("RUNTIME_BRAIN_RETRIEVAL_FLOOR_INVALID");
  }
  return value;
}

function nullableString(value: unknown, code: string) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new BrainRuntimeReadinessError(code);
  return value;
}

/** One `brain_snapshot_entries` row. Fails closed on any malformed column, like every other read here. */
function knowledgeEntry(value: unknown): PublishedKnowledgeEntry {
  const row = record(value, "RUNTIME_BRAIN_ENTRY_INVALID");
  let numberBindings: PublishedKnowledgeEntry["numberBindings"];
  try {
    numberBindings = knowledgeNumberBindings(row.number_bindings);
  } catch {
    throw new BrainRuntimeReadinessError("RUNTIME_BRAIN_ENTRY_INVALID");
  }
  return {
    entryId: requiredString(row.entry_id, "RUNTIME_BRAIN_ENTRY_INVALID"),
    category: requiredString(row.category, "RUNTIME_BRAIN_ENTRY_INVALID"),
    question: requiredString(row.inbound_message, "RUNTIME_BRAIN_ENTRY_INVALID"),
    responseTemplate: requiredString(row.response_template, "RUNTIME_BRAIN_ENTRY_INVALID"),
    numberBindings,
    rewriteHash: nullableString(row.rewrite_hash, "RUNTIME_BRAIN_ENTRY_INVALID"),
    sourceRef: nullableString(row.source_ref, "RUNTIME_BRAIN_ENTRY_INVALID"),
  };
}

function parseSnapshot(value: unknown) {
  const row = record(value, "RUNTIME_BRAIN_SNAPSHOT_INVALID");
  const payload = record(row.payload, "RUNTIME_BRAIN_PAYLOAD_INVALID");
  const knowledgeMode = row.knowledge_mode;
  if (knowledgeMode !== "inline" && knowledgeMode !== "retrieved") {
    throw new BrainRuntimeReadinessError("RUNTIME_BRAIN_KNOWLEDGE_MODE_INVALID");
  }
  const floor = retrievalFloor(payload.retrievalFloor);
  const brain: BrainSnapshot = {
    id: requiredString(row.id, "RUNTIME_BRAIN_SNAPSHOT_ID_INVALID"),
    version: positiveVersion(row.version, "RUNTIME_BRAIN_VERSION_INVALID"),
    contentHash: hash(row.content_hash, "RUNTIME_BRAIN_HASH_INVALID"),
    sourceHash: hash(row.source_hash, "RUNTIME_BRAIN_SOURCE_HASH_INVALID"),
    payload,
    compiledPlatform: requiredString(
      row.compiled_platform,
      "RUNTIME_BRAIN_COMPILED_PLATFORM_INVALID",
    ),
    platformTokens: Number(row.platform_tokens),
    knowledgeMode,
    ...(floor === undefined ? {} : { retrievalFloor: floor }),
  };
  if (!Number.isInteger(brain.platformTokens) || brain.platformTokens < 0) {
    throw new BrainRuntimeReadinessError("RUNTIME_BRAIN_TOKEN_COUNT_INVALID");
  }
  return { brain, qualification: snapshotQualification(payload.qualification) };
}

function parsePublishedOffer(value: unknown, tenantId: string): PublishedCoachOffer {
  const offer = record(value, "RUNTIME_PUBLISHED_OFFER_INVALID") as unknown as PublishedCoachOffer;
  if (
    offer.status !== "published" ||
    offer.tenantId !== tenantId ||
    !offer.id ||
    !Number.isInteger(offer.version) ||
    offer.version <= 0 ||
    !/^[0-9a-f]{64}$/.test(offer.contentHash)
  ) throw new BrainRuntimeReadinessError("RUNTIME_PUBLISHED_OFFER_INVALID");
  return offer;
}

function qualificationSources(qualification: readonly QualificationRule[]) {
  const inputs = new Set<string>();
  for (const rule of qualification) {
    if (rule.conditions.minScore !== undefined || rule.conditions.maxScore !== undefined) {
      inputs.add("credit score");
    }
    if (rule.conditions.businessStage !== undefined) inputs.add("business stage");
    if (rule.conditions.minAnnualRevenue !== undefined) inputs.add("annual revenue");
    if (rule.conditions.fundingGoals !== undefined) inputs.add("funding goal");
    if (rule.conditions.timelines !== undefined) inputs.add("funding timeline");
  }
  return {
    qualificationSummary: qualification.map((rule) => `${rule.label}: ${rule.outcome}`).join("; "),
    qualificationInputs: [...inputs],
  };
}

/**
 * The service-role readers `loadPublishedRuntimeBundle` uses by default, for a caller that needs
 * to substitute exactly one of them. The admin test turn swaps `loadCurrentSnapshot` for the
 * current draft so a bundle can be assembled from unpublished Brain content while every other
 * read (tenant, offer, calendar, demo qualification) stays the production one.
 */
export function liveBrainRuntimeDependencies(): BrainRuntimeDependencies {
  return liveDependencies();
}

function liveDependencies(): BrainRuntimeDependencies {
  const client = createSupabaseServiceClient();
  const offers = createOfferLayerRepository();
  return {
    phase2Enabled: () => phase2Live(),
    loadTenant: async (tenantId) => {
      const { data, error } = await client
        .from("tenants")
        .select("id, is_demo")
        .eq("id", tenantId)
        .maybeSingle();
      if (error) throw new Error(`RUNTIME_TENANT_READ_FAILED:${error.message}`);
      return data ? { id: data.id, isDemo: data.is_demo } : null;
    },
    loadCurrentSnapshot: async () => {
      const { data, error } = await client
        .from("brain_snapshots")
        .select("id, version, content_hash, source_hash, payload, compiled_platform, platform_tokens, knowledge_mode")
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`RUNTIME_BRAIN_READ_FAILED:${error.message}`);
      return data;
    },
    loadPublishedOffer: (tenantId) => offers.loadOffer({ tenantId, status: "published" }),
    loadSnapshotEntries: async (snapshotId) => {
      const { data, error } = await client
        .from("brain_snapshot_entries")
        .select("entry_id, category, inbound_message, response_template, number_bindings, rewrite_hash, source_ref")
        .eq("snapshot_id", snapshotId)
        .order("entry_id", { ascending: true });
      if (error) throw new Error(`RUNTIME_BRAIN_ENTRIES_READ_FAILED:${error.message}`);
      return data ?? [];
    },
    loadPrimaryCalendar: async (tenantId) => {
      const { data, error } = await client
        .from("calendar_connections")
        .select("tenant_id, booking_url")
        .eq("tenant_id", tenantId)
        .eq("is_primary", true)
        .maybeSingle();
      if (error) throw new Error(`RUNTIME_CALENDAR_READ_FAILED:${error.message}`);
      if (!data) return null;
      if (data.tenant_id !== tenantId) throw new Error("RUNTIME_CALENDAR_TENANT_MISMATCH");
      return { bookingUrl: data.booking_url };
    },
    loadDemoQualification: async () => {
      const { data, error } = await client
        .from("qualification_rules")
        .select(
          "rule_key, label, outcome, min_score, max_score, business_stage, min_annual_revenue_cents, funding_goals, timelines",
        )
        .eq("status", "draft")
        .order("position", { ascending: true });
      if (error) throw new Error(`RUNTIME_DEMO_QUALIFICATION_READ_FAILED:${error.message}`);
      return (data ?? []).map((row) => ({
        ruleKey: row.rule_key,
        label: row.label,
        outcome: row.outcome,
        minScore: row.min_score,
        maxScore: row.max_score,
        businessStage: row.business_stage,
        minAnnualRevenueCents: row.min_annual_revenue_cents === null
          ? null
          : Number(row.min_annual_revenue_cents),
        fundingGoals: row.funding_goals,
        timelines: row.timelines,
      }));
    },
  };
}

/** Reloads exact Brain and offer versions for one tenant at the start of one turn. */
export async function loadPublishedRuntimeBundle(
  tenantId: string,
  dependencies: BrainRuntimeDependencies = liveDependencies(),
): Promise<PublishedRuntimeBundle> {
  const expectedTenant = tenantId.trim();
  if (!expectedTenant) throw new BrainRuntimeReadinessError("RUNTIME_TENANT_REQUIRED");
  if (!dependencies.phase2Enabled()) {
    throw new BrainRuntimeReadinessError("PHASE2_RUNTIME_DISABLED");
  }
  const [tenant, snapshotValue, offerValue, calendar] = await Promise.all([
    dependencies.loadTenant(expectedTenant),
    dependencies.loadCurrentSnapshot(),
    dependencies.loadPublishedOffer(expectedTenant),
    dependencies.loadPrimaryCalendar(expectedTenant),
  ]);
  if (!tenant || tenant.id !== expectedTenant) {
    throw new BrainRuntimeReadinessError("RUNTIME_TENANT_NOT_READY");
  }
  if (!snapshotValue) throw new BrainRuntimeReadinessError("RUNTIME_BRAIN_NOT_PUBLISHED");
  if (!offerValue) throw new BrainRuntimeReadinessError("RUNTIME_OFFER_NOT_PUBLISHED");
  const { brain, qualification: publishedQualification } = parseSnapshot(snapshotValue);
  const offer = parsePublishedOffer(offerValue, expectedTenant);
  const qualification = publishedQualification ?? (
    tenant.isDemo ? demoQualification(await dependencies.loadDemoQualification()) : null
  );
  if (!qualification) {
    throw new BrainRuntimeReadinessError("RUNTIME_QUALIFICATION_NOT_PUBLISHED");
  }
  const qualificationSource = publishedQualification ? "platform" : "demo_seed";
  const qualificationApproved = Boolean(publishedQualification);
  const derived = qualificationSources(qualification);
  const assetUrlsBySlug = Object.fromEntries(offer.assets.map((asset) => [asset.slug, asset.url]));
  // Inline mode needs the whole published section in hand; retrieved mode reads nothing here and
  // lets the ranking RPC pick at turn time. The rows come from the same immutable snapshot the
  // ranking would read, keyed by the id the turn will be traced against.
  const knowledgeEntries = brain.knowledgeMode === "inline" && dependencies.loadSnapshotEntries
    ? (await dependencies.loadSnapshotEntries(brain.id)).map(knowledgeEntry)
    : undefined;
  return {
    brain,
    offer,
    qualification,
    qualificationApproved,
    qualificationSource,
    renderSources: {
      bookingUrl: calendar?.bookingUrl ?? null,
      ...derived,
      assetUrlsBySlug,
    },
    snapshotId: brain.id,
    brainVersion: brain.version,
    offerVersion: offer.version,
    contentHash: brain.contentHash,
    ...(knowledgeEntries ? { knowledgeEntries } : {}),
  };
}
