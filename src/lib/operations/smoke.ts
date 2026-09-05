/**
 * The platform smoke: every server-side loader behind an admin page and the coach inbox, run in
 * sequence against real data, each one caught on its own.
 *
 * The Overview page failed in production because one provisioning row carried a `completed_at`
 * before its `started_at`; the measurement loader treats the snapshot as fail-closed evidence,
 * the page catches everything as "Overview could not load", and nobody knew until the owner
 * opened it. This module exercises the same loaders the pages call, with the same arguments, so
 * the hourly job and the seeders see a broken page before a person does.
 *
 * A check's `error` is the thrown error's name and message, never a payload, so a receipt or a
 * seeder log never carries a row.
 */

import { AUDIT_VIEWS } from "@/lib/audit/views";
import { figuresInResponse } from "@/lib/brain/import/flags";
import { loadSafetyCorpus } from "@/lib/evals/corpus";
import { evaluatePublishGate } from "@/lib/evals/publish-gate";
import { loadAgentRoster } from "@/lib/operations/agent-roster";
import { loadAttentionQueue } from "@/lib/operations/attention-queue";
import { loadSystemHealth } from "@/lib/operations/system-health";
import { createBillingRepository, type BillingRepositoryDependencies } from "@/lib/repositories/billing";
import { listConversationSet } from "@/lib/repositories/conversations";
import { loadEvalRun } from "@/lib/repositories/eval-runs";
import { loadPlatformMeasurement } from "@/lib/repositories/platform-analytics";
import { createSupportRepository } from "@/lib/repositories/support";
import { createSupportService, type SupportSession } from "@/lib/support/service";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { UserRole } from "@/lib/auth/claims";

import { loadAuditRows, requestedQuery } from "@/app/(workspace)/admin/audit/load";

export const PLATFORM_SMOKE_CHECK_KEYS = [
  "platform-measurement",
  "system-health",
  "attention-queue",
  "money-billing",
  "brain-admin",
  "audit-log",
  "clients-book",
  "agent-roster",
  "coach-inbox",
] as const;

export type PlatformSmokeCheckKey = typeof PLATFORM_SMOKE_CHECK_KEYS[number];

export type PlatformSmokeCheck = {
  key: PlatformSmokeCheckKey;
  ok: boolean;
  ms: number;
  error?: string;
};

export type PlatformSmokeResult = {
  ok: boolean;
  checks: readonly PlatformSmokeCheck[];
};

export type PlatformSmokeActor = { actorId: string; role: UserRole };

export type PlatformSmokeInput = {
  actorId: string;
  nowIso: string;
  /** Defaults to `owner`; only the client-book read looks at it. */
  actorRole?: UserRole;
  /** The seeded demo coach tenant the inbox read runs against; resolved from the database when absent. */
  demoTenantId?: string | null;
  /** Test seam: one loader per check, replacing the live ones. */
  loaders?: Partial<PlatformSmokeLoaders>;
  now?: () => number;
};

export type PlatformSmokeLoaders = Record<PlatformSmokeCheckKey, () => Promise<unknown>>;

const ERROR_LIMIT = 300;

/** Name and message only. A payload-bearing error is a writer bug, and this is where it is cut. */
export function smokeErrorText(cause: unknown): string {
  if (cause instanceof Error) {
    const name = cause.name && cause.name !== "Error" ? `${cause.name}: ` : "";
    return `${name}${cause.message || "no message"}`.slice(0, ERROR_LIMIT);
  }
  if (typeof cause === "string") return cause.slice(0, ERROR_LIMIT);
  return "non-error thrown";
}

export class PlatformSmokeCheckError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "PlatformSmokeCheckError";
  }
}

export const DEMO_COACH_TENANT_SLUG = "setterfi-phase1-demo";

/**
 * The seeded demo coach tenant: the phase 1 seed's slug first, then the earliest `is_demo`
 * tenant, so a renamed seed still resolves to a coach workspace rather than to nothing.
 */
export async function resolveDemoCoachTenant(): Promise<{ id: string; slug: string } | null> {
  const client = createSupabaseServiceClient();
  const bySlug = await client.from("tenants").select("id,slug").eq("slug", DEMO_COACH_TENANT_SLUG).maybeSingle();
  if (bySlug.error) throw new PlatformSmokeCheckError("SMOKE_DEMO_TENANT_READ_FAILED");
  if (bySlug.data) return bySlug.data;
  const earliest = await client.from("tenants").select("id,slug").eq("is_demo", true)
    .order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (earliest.error) throw new PlatformSmokeCheckError("SMOKE_DEMO_TENANT_READ_FAILED");
  return earliest.data ?? null;
}

/** The earliest platform owner or admin, which is the actor every admin page reads as. */
export async function resolvePlatformOwnerActor(): Promise<PlatformSmokeActor | null> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.from("users").select("id,role")
    .in("role", ["owner", "admin"])
    .order("role", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new PlatformSmokeCheckError("SMOKE_OWNER_READ_FAILED");
  if (!data) return null;
  return { actorId: data.id, role: data.role as UserRole };
}

/**
 * The Brain page's read, mirrored query for query from `admin/brain/page.tsx`. The page keeps its
 * loader private, so the same tables, columns, and follow-up reads are issued here; a column the
 * page selects that the database no longer has fails here the same way it fails there.
 */
async function readAdminBrainState() {
  const client = createSupabaseServiceClient();
  const results = await Promise.all([
    client.from("brain_import_batches").select("id,source,status,received_count,normalized_count,flagged_count,completed_at").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    client.from("brain_mission").select("id,identity,goal,tone,criteria,guardrails,dq,status,version").order("updated_at", { ascending: false }).limit(1).maybeSingle(),
    client.from("qualification_rules").select("id,rule_key,label,position,outcome,status").order("position", { ascending: true }),
    client.from("compliance_rules").select("id,slug,phrase,severity,status").order("id", { ascending: true }),
    client.from("brain_knowledge_entries").select("id,category,question,response_template,status,source,source_ref,disposition,updated_at,published_at").order("created_at", { ascending: false }),
    client.from("brain_objections").select("id,label,category,hard_gate,match_keywords,response,status,updated_at,published_at").order("created_at", { ascending: false }),
    client.from("brain_snapshots").select("id,version,content_hash,source_hash,payload,knowledge_mode,platform_tokens,rollback_of_snapshot_id,published_at").order("version", { ascending: false }),
    client.from("brain_draft_versions").select("id,content_hash,payload,created_at").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    client.from("message_traces").select("message_id,declared_entry_id,citation_verified,retrieval_candidates,created_at").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const failed = results.find((result) => result.error);
  if (failed?.error) throw new PlatformSmokeCheckError(`ADMIN_BRAIN_READ_FAILED:${failed.error.message}`);
  const [batchResult, , , , knowledgeResult, , , draftResult] = results;

  const batchRow = batchResult.data;
  if (batchRow) {
    const items = await client.from("brain_import_items").select("id,batch_id,source_ref,operation,after_payload,flags,disposition,decision").eq("batch_id", batchRow.id).order("created_at", { ascending: true });
    if (items.error) throw new PlatformSmokeCheckError(`ADMIN_BRAIN_ITEMS_READ_FAILED:${items.error.message}`);
    for (const row of items.data ?? []) {
      const payload = row.after_payload && typeof row.after_payload === "object" ? row.after_payload as Record<string, unknown> : {};
      figuresInResponse(typeof payload.responseTemplate === "string" ? payload.responseTemplate : "");
    }
  }

  const draftRow = draftResult.data;
  if (draftRow) {
    const evalRun = await client.from("eval_runs").select("id").eq("brain_draft_version_id", draftRow.id).eq("content_hash", draftRow.content_hash).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (evalRun.error) throw new PlatformSmokeCheckError(`ADMIN_BRAIN_EVAL_READ_FAILED:${evalRun.error.message}`);
    if (evalRun.data?.id) {
      const receipt = await loadEvalRun(evalRun.data.id);
      evaluatePublishGate({
        expectedDraftId: draftRow.id,
        expectedContentHash: draftRow.content_hash,
        expectedCorpusRevision: loadSafetyCorpus().revision,
        run: receipt,
      });
    }
  }
  return { knowledge: knowledgeResult.data?.length ?? 0 };
}

/**
 * The Money page's four reads, on a service-backed dependency set.
 *
 * `createBillingRepository()` with no arguments builds its live dependencies eagerly, and that
 * factory opens the cookie-backed user client for the coach-side reads even though none of the
 * four platform reads touch it. Outside a request scope (the hosted smoke script) that throws
 * before any query runs, so the four service reads are mirrored here, query for query from
 * `repositories/billing.ts`, and the repository's own parsers still validate every row. Any other
 * dependency the repository reaches for is a smoke bug and throws by name.
 */
function smokeBillingDependencies(): BillingRepositoryDependencies {
  const service = createSupabaseServiceClient();
  const failed = (code: string) => new PlatformSmokeCheckError(code);
  const provided: Partial<BillingRepositoryDependencies> = {
    readMovementSources: async () => {
      const [subscriptions, tierPriceVersions, tenantPriceOverrides] = await Promise.all([
        service.from("analytics_billing_subscriptions")
          .select("subscription_id,tenant_id,tier_id,stripe_price_id,status,current_period_start,current_period_end,cancel_at_period_end,provider_updated_at,created_at"),
        service.from("analytics_tier_price_versions")
          .select("price_version_id,tier_id,price_cents,effective_at"),
        service.from("analytics_tenant_price_overrides")
          .select("override_id,tenant_id,price_cents,effective_at,ends_at"),
      ]);
      if (subscriptions.error || tierPriceVersions.error || tenantPriceOverrides.error) {
        throw failed("BILLING_MOVEMENT_READ_FAILED");
      }
      return {
        subscriptions: subscriptions.data ?? [],
        tierPriceVersions: tierPriceVersions.data ?? [],
        tenantPriceOverrides: tenantPriceOverrides.data ?? [],
      };
    },
    readMoneyBilling: async (asOf) => {
      const { data, error } = await service.rpc("read_money_mrr_history", { p_as_of: asOf });
      if (error || data === null || data === undefined) throw failed("MONEY_BILLING_READ_FAILED");
      return data;
    },
    readSubscriptionRows: async () => {
      const { data, error } = await service.from("tenants")
        .select("id,name,status,is_demo,billing_subscriptions(status,provider_updated_at,current_period_end,cancel_at_period_end),allowance_actions(pending_tier_id,effective_at,state)")
        .order("updated_at", { ascending: false })
        .limit(2_000);
      if (error) throw failed("BILLING_SUBSCRIPTION_ROWS_READ_FAILED");
      return data ?? [];
    },
    readCostRollupRows: async () => {
      const { data, error } = await service.from("tenant_cost_rollups")
        .select("id,tenant_id,window_start,window_end,recognized_subscription_cents,model_cents,messaging_cents,embedding_cents,complete,missing_sources,computed_at,tenant:tenants(name,is_demo)")
        .order("window_end", { ascending: false })
        .limit(2_000);
      if (error) throw failed("BILLING_COST_ROLLUP_ROWS_READ_FAILED");
      return data ?? [];
    },
  };
  return new Proxy(provided, {
    get(target, property) {
      if (property in target) return target[property as keyof BillingRepositoryDependencies];
      // `await provided` probes for a thenable, and symbol lookups are inspection, not use.
      if (property === "then" || typeof property === "symbol") return undefined;
      throw failed(`SMOKE_BILLING_DEPENDENCY_UNSUPPORTED:${String(property)}`);
    },
  }) as BillingRepositoryDependencies;
}

function liveLoaders(input: {
  actorId: string;
  nowIso: string;
  actorRole: UserRole;
  demoTenantId: string | null | undefined;
}): PlatformSmokeLoaders {
  const session: SupportSession = {
    userId: input.actorId,
    role: input.actorRole,
    tenantId: null,
    impersonatingTenant: null,
    impersonationSessionId: null,
  };
  return {
    "platform-measurement": () => loadPlatformMeasurement(input.actorId, input.nowIso),
    "system-health": async () => {
      const health = await loadSystemHealth({ now: new Date(input.nowIso) });
      // The page renders these as unavailable rather than crashing, which is exactly the silent
      // failure this smoke exists to surface.
      if (health.queue.state === "unavailable") throw new PlatformSmokeCheckError("SYSTEM_HEALTH_QUEUE_UNAVAILABLE");
      if (health.jobs.some((job) => job.state === "unavailable")) throw new PlatformSmokeCheckError("SYSTEM_HEALTH_RECEIPTS_UNAVAILABLE");
      return health;
    },
    "attention-queue": () => loadAttentionQueue({ actorId: input.actorId, nowIso: input.nowIso }),
    "money-billing": async () => {
      // The page reads these with `allSettled` and blanks whichever card failed; here any one of
      // the four failing is the finding.
      const repository = createBillingRepository(smokeBillingDependencies());
      return Promise.all([
        repository.loadMrrMovement(input.nowIso),
        repository.loadMoneyBilling(input.nowIso),
        repository.loadSubscriptionRows(),
        repository.loadCostRollupRows(),
      ]);
    },
    "brain-admin": readAdminBrainState,
    "audit-log": async () => {
      const result = await loadAuditRows(requestedQuery({}));
      if (result.unavailableReason) throw new PlatformSmokeCheckError(`AUDIT_LOG_UNAVAILABLE: ${result.unavailableReason}`);
      if (result.viewCounts === null || AUDIT_VIEWS.some((view) => typeof result.viewCounts?.[view.key] !== "number")) {
        throw new PlatformSmokeCheckError("AUDIT_LOG_VIEW_COUNTS_MISSING");
      }
      return result;
    },
    "clients-book": () => createSupportService(createSupportRepository()).listClientBook(session, "all"),
    "agent-roster": () => loadAgentRoster(),
    "coach-inbox": async () => {
      const tenantId = input.demoTenantId ?? (await resolveDemoCoachTenant())?.id ?? null;
      if (!tenantId) throw new PlatformSmokeCheckError("SMOKE_DEMO_TENANT_MISSING");
      return listConversationSet(tenantId, { objectionId: null });
    },
  };
}

export async function runPlatformSmoke(input: PlatformSmokeInput): Promise<PlatformSmokeResult> {
  const now = input.now ?? (() => Date.now());
  const loaders: PlatformSmokeLoaders = {
    ...liveLoaders({
      actorId: input.actorId,
      nowIso: input.nowIso,
      actorRole: input.actorRole ?? "owner",
      demoTenantId: input.demoTenantId,
    }),
    ...input.loaders,
  };
  const checks: PlatformSmokeCheck[] = [];
  for (const key of PLATFORM_SMOKE_CHECK_KEYS) {
    const startedAt = now();
    try {
      await loaders[key]();
      checks.push({ key, ok: true, ms: Math.max(0, now() - startedAt) });
    } catch (cause) {
      checks.push({ key, ok: false, ms: Math.max(0, now() - startedAt), error: smokeErrorText(cause) });
    }
  }
  return { ok: checks.every((check) => check.ok), checks };
}

/** What the scheduled job writes on its receipt: counts, plus the failing keys as their own field. */
export function platformSmokeCounters(result: PlatformSmokeResult) {
  const failedKeys = result.checks.filter((check) => !check.ok).map((check) => check.key);
  return {
    checks: result.checks.length,
    failed: failedKeys.length,
    ...(failedKeys.length > 0 ? { failed_keys: failedKeys } : {}),
  };
}

/** One line for the receipt's `error_detail`: the failing keys and their errors. */
export function platformSmokeErrorDetail(result: PlatformSmokeResult): string | null {
  const failed = result.checks.filter((check) => !check.ok);
  if (failed.length === 0) return null;
  return failed.map((check) => `${check.key}: ${check.error ?? "failed"}`).join(" | ");
}
