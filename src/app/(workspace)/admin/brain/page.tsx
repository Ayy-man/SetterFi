import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AdminBrain } from "@/components/workspace/live/admin-brain";
import { AdminBrainTesting } from "@/components/workspace/live/admin-testing";
import { AppShell } from "@/components/kit/app-shell";
import { DataState } from "@/components/kit/data-state";
import type {
  EvalComparisonConfigOption,
  EvalComparisonDraftOption,
} from "@/components/workspace/live/eval-comparison-view-models";
import {
  deriveTestingView,
  type MessageTraceRead,
  type TestingArmInput,
} from "@/components/workspace/live/view-models";
import { OwnerBrain, ownerBrainTab } from "@/components/workspace/rehaul/owner-brain";
import type {
  AdminBrainInitialState,
  BrainEvalView,
  BrainImportFlagView,
  ObjectionCategory,
} from "@/components/workspace/live/brain-view-models";
import type { PageSearchParams } from "@/lib/admin-route-fold";
import { canAccessWorkspace, parseAppClaims, workspaceForRole, type AppClaims } from "@/lib/auth/claims";
import { figuresInResponse } from "@/lib/brain/import/flags";
import {
  driverSelection,
  environmentValue,
  phase1Live,
  phase2Live,
  phase7EvalsLive,
  uiRehaulLive,
} from "@/lib/env-contract";
import { loadSafetyCorpus } from "@/lib/evals/corpus";
import { evaluatePublishGate } from "@/lib/evals/publish-gate";
import { loadEvalRun } from "@/lib/repositories/eval-runs";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "The Brain" };
export const dynamic = "force-dynamic";

const CRUMBS = [{ label: "Brain" }, { label: "The Brain" }] as const;

function BrainShell({ children }: { children: React.ReactNode }) {
  return (
    <AppShell
      activePath="/admin/brain"
      crumbs={CRUMBS}
      role="admin"
    >
      {children}
    </AppShell>
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

type PageProps = { searchParams?: Promise<PageSearchParams> };

async function requireBrainAdmin() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) redirect("/login?next=%2Fadmin%2Fbrain");
  const claims = parseAppClaims(data.claims);
  if (!canAccessWorkspace(claims.role, "admin", { affiliateAccess: claims.affiliateAccess })) {
    const home = workspaceForRole(claims.role);
    redirect(home ? `/${home}` : "/login");
  }
  if (claims.role !== "owner" && claims.role !== "admin") redirect("/admin");
  return claims;
}

async function loadAdminBrainStateValue(): Promise<AdminBrainInitialState> {
  const client = createSupabaseServiceClient();
  const [
    batchResult,
    missionResult,
    qualificationResult,
    complianceResult,
    knowledgeResult,
    objectionsResult,
    snapshotsResult,
    draftResult,
    traceResult,
  ] = await Promise.all([
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
  const failed = [batchResult, missionResult, qualificationResult, complianceResult, knowledgeResult, objectionsResult, snapshotsResult, draftResult, traceResult]
    .find((result) => result.error);
  if (failed?.error) throw new Error(`ADMIN_BRAIN_READ_FAILED:${failed.error.message}`);

  const batchRow = batchResult.data;
  const itemsResult = batchRow
    ? await client.from("brain_import_items").select("id,batch_id,source_ref,operation,after_payload,flags,disposition,decision").eq("batch_id", batchRow.id).order("created_at", { ascending: true })
    : { data: [], error: null };
  if (itemsResult.error) throw new Error(`ADMIN_BRAIN_ITEMS_READ_FAILED:${itemsResult.error.message}`);
  const itemRows = itemsResult.data ?? [];

  const draftRow = draftResult.data;
  const evalRunResult = draftRow
    ? await client.from("eval_runs").select("id").eq("brain_draft_version_id", draftRow.id).eq("content_hash", draftRow.content_hash).order("created_at", { ascending: false }).limit(1).maybeSingle()
    : { data: null, error: null };
  if (evalRunResult.error) throw new Error(`ADMIN_BRAIN_EVAL_READ_FAILED:${evalRunResult.error.message}`);
  let evalView: BrainEvalView = {
    state: "not_run_for_this_version",
    runId: null,
    blockers: [],
    warnings: [],
  };
  if (draftRow && evalRunResult.data?.id) {
    const receipt = await loadEvalRun(evalRunResult.data.id);
    const gate = evaluatePublishGate({
      expectedDraftId: draftRow.id,
      expectedContentHash: draftRow.content_hash,
      expectedCorpusRevision: loadSafetyCorpus().revision,
      run: receipt,
    });
    if (gate.status !== "not_run_for_this_version") {
      evalView = {
        state: gate.canPublish ? "ready" : "blocked",
        runId: evalRunResult.data.id,
        blockers: gate.blockers,
        warnings: gate.warnings,
      };
    }
  }

  const mission = missionResult.data;
  const missionFields = ["identity", "goal", "tone", "criteria", "guardrails", "dq"] as const;
  const qualificationRows = qualificationResult.data ?? [];
  const qualificationApproved = qualificationRows.length > 0
    && qualificationRows.every((row) => row.status === "published");
  const trace = traceResult.data;
  const candidates = Array.isArray(trace?.retrieval_candidates) ? trace.retrieval_candidates : [];

  return {
    batch: batchRow ? {
      id: batchRow.id,
      source: batchRow.source as "mock" | "notion" | "offline",
      status: batchRow.status as "open" | "applied" | "discarded" | "failed",
      receivedCount: batchRow.received_count,
      normalizedCount: batchRow.normalized_count,
      flaggedCount: batchRow.flagged_count,
      persistedItemCount: itemRows.length,
      completedAt: batchRow.completed_at,
    } : null,
    importRows: itemRows.map((row) => {
      const payload = record(row.after_payload);
      const responseTemplate = stringValue(payload.responseTemplate);
      const figures = figuresInResponse(responseTemplate);
      const flags = Array.isArray(row.flags) ? row.flags : [];
      return {
        id: row.id,
        batchId: row.batch_id,
        sourceRef: row.source_ref,
        operation: row.operation as "new" | "changed" | "unchanged" | "removed",
        category: stringValue(payload.category),
        inboundMessage: stringValue(payload.inboundMessage),
        responseTemplate,
        disposition: row.disposition,
        decision: row.decision as "pending" | "accepted" | "rejected",
        flags: flags.map((value) => {
          const flag = record(value);
          const offset = typeof flag.offset === "number" ? flag.offset : 0;
          const figure = figures.find((candidate) => candidate.offset === offset);
          return {
            id: stringValue(flag.id),
            code: stringValue(flag.code),
            severity: "blocking",
            field: stringValue(flag.field),
            offset,
            resolved: flag.resolved === true,
            figureKind: figure?.kind,
            figureValue: figure?.value,
          } satisfies BrainImportFlagView;
        }),
      };
    }),
    mission: missionFields.map((field) => ({ id: mission?.id ? `${mission.id}:${field}` : field, label: field, text: stringValue(mission?.[field]) })),
    qualification: qualificationRows.map((row) => ({ id: row.id, label: row.label, outcome: row.outcome, position: row.position })),
    qualificationApproved,
    qualificationSource: qualificationApproved ? "platform" : "demo_seed",
    compliance: (complianceResult.data ?? []).map((row) => ({ id: row.id, slug: row.slug, phrase: row.phrase, severity: row.severity })),
    knowledge: (knowledgeResult.data ?? []).map((row) => ({ id: row.id, category: row.category, inboundMessage: row.question, responseTemplate: row.response_template, status: row.status, updatedAt: row.updated_at, publishedAt: row.published_at })),
    // The cast is sound because `brain_objections_category_check` refuses anything outside the
    // five, so no row can reach here carrying a category the filter cannot render.
    objections: (objectionsResult.data ?? []).map((row) => ({
      id: row.id,
      label: row.label,
      category: row.category as ObjectionCategory,
      hardGate: row.hard_gate,
      matchKeywords: row.match_keywords ?? [],
      response: row.response,
      status: row.status,
      updatedAt: row.updated_at,
      publishedAt: row.published_at,
    })),
    snapshots: (snapshotsResult.data ?? []).map((row) => ({
      id: row.id,
      version: row.version,
      contentHash: row.content_hash,
      sourceHash: row.source_hash,
      knowledgeMode: row.knowledge_mode,
      platformTokens: row.platform_tokens,
      rollbackOfSnapshotId: row.rollback_of_snapshot_id,
      publishedAt: row.published_at,
    })),
    draft: draftRow ? { id: draftRow.id, contentHash: draftRow.content_hash, payload: record(draftRow.payload), createdAt: draftRow.created_at } : null,
    eval: evalView,
    citation: trace ? {
      traceId: trace.message_id,
      declaredEntryId: trace.declared_entry_id,
      verifiedInPrompt: trace.citation_verified,
      candidateEntryIds: candidates.flatMap((value) => {
        const candidate = record(value);
        return typeof candidate.entryId === "string" ? [candidate.entryId] : [];
      }),
      createdAt: trace.created_at,
    } : null,
    currentSnapshotPayload: snapshotsResult.data?.[0] ? record(snapshotsResult.data[0].payload) : null,
  };
}

type AdminBrainStateResult =
  | { ok: true; value: AdminBrainInitialState }
  | { ok: false; code: "ADMIN_BRAIN_READ_FAILED"; reason: string };

async function loadAdminBrainState(): Promise<AdminBrainStateResult> {
  try {
    return { ok: true, value: await loadAdminBrainStateValue() };
  } catch {
    return {
      ok: false,
      code: "ADMIN_BRAIN_READ_FAILED",
      reason: "The Brain could not load its saved state.",
    };
  }
}

/* --------------------------------------------------------------------------------------------
 * The Evals tab, folded in from /admin/brain/testing.
 *
 * `foldedRouteFor` sends `/admin/brain/testing` to `/admin/brain?tab=evals`, so the reads that
 * page performs have to happen here for that tab to have anything in it. Nothing below is a new
 * query: it is the same pair of selects `admin/brain/testing/page.tsx` runs, in the same order,
 * and it only runs when the reader is actually on that tab.
 * ------------------------------------------------------------------------------------------ */

function normalizeChecks(value: unknown): Record<string, boolean> {
  if (!Array.isArray(value)) return {};
  return Object.fromEntries(value.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return [[`check-${index + 1}`, false] as const];
    const row = entry as Record<string, unknown>;
    const key = typeof row.class === "string" ? row.class : `check-${index + 1}`;
    return [[key, typeof row.passed === "boolean" ? row.passed : false] as const];
  }));
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function violationLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return value == null ? [] : ["Recorded violation"];
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") {
      const row = item as Record<string, unknown>;
      if (typeof row.class === "string") return row.class;
      if (typeof row.code === "string") return row.code;
    }
    return "Recorded violation";
  });
}

function persistedCounter(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return 0;
}

async function renderEvalsTab(claims: AppClaims) {
  if (!phase1Live()) {
    return (
      <DataState
        body="Turn on Brain evals to inspect test-only configuration evidence."
        kind="empty"
        title="Brain evals are not enabled"
      />
    );
  }

  const supabase = await createSupabaseServerClient();
  const [{ data: traceRow, error: traceError }, { data: configRows, error: configError }] = await Promise.all([
    supabase.from("message_traces").select("message_id, tenant_id, rule_fired, retrieved_entry_ids, checks, violations, model, moderator_state, created_at, tenant:tenants!inner(name,is_demo)").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("model_configs").select("id, label, openrouter_model, role, moderator_unavailable_count").eq("active", true).order("role", { ascending: true }),
  ]);
  if (traceError) throw new Error(`TESTING_TRACE_READ_FAILED:${traceError.message}`);
  if (configError) throw new Error(`TESTING_CONFIG_READ_FAILED:${configError.message}`);

  const persistedTrace: MessageTraceRead | null = traceRow ? {
    id: traceRow.message_id,
    tenantId: traceRow.tenant_id,
    model: traceRow.model ?? "Model not recorded",
    ruleFired: traceRow.rule_fired,
    retrievedEntryIds: stringArray(traceRow.retrieved_entry_ids),
    checks: normalizeChecks(traceRow.checks),
    violations: violationLabels(traceRow.violations),
    moderatorState: traceRow.moderator_state === "allowed" || traceRow.moderator_state === "blocked" || traceRow.moderator_state === "unavailable" ? traceRow.moderator_state : "not_recorded",
    createdAt: traceRow.created_at,
  } : null;
  const selector = driverSelection("openrouter", "SETTERFI_OPENROUTER_DRIVER");
  const hasUsableKey = Boolean(environmentValue("OPENROUTER_API_KEY"));
  const moderatorUnavailableCount = (configRows ?? []).reduce((total, row) => total + persistedCounter(row.moderator_unavailable_count), 0);
  const arms: TestingArmInput[] = (configRows ?? []).map((row, index) => ({
    id: index === 0 ? "A" : String.fromCharCode(65 + index),
    label: row.label,
    role: row.role === "generator" ? "Generator" : row.role === "moderator" ? "Moderator" : "Configuration",
    selector,
    hasUsableKey,
    persistedTrace: persistedTrace?.model === row.openrouter_model ? persistedTrace : null,
  }));
  if (arms.length === 0) arms.push({ id: "A", label: "No active model configuration", role: null, selector, hasUsableKey, persistedTrace: null });
  const testing = deriveTestingView({ arms, moderatorUnavailableCount });
  const joinedTenant = traceRow?.tenant as unknown as { name?: string; is_demo?: boolean } | Array<{ name?: string; is_demo?: boolean }> | null;
  const tenantRow = Array.isArray(joinedTenant) ? joinedTenant[0] : joinedTenant;
  const isDemo = Array.isArray(joinedTenant) ? Boolean(joinedTenant[0]?.is_demo) : Boolean(joinedTenant?.is_demo);
  const tenantId = persistedTrace?.tenantId ?? claims.impersonatingTenant ?? claims.tenantId ?? "No persisted tenant trace";
  const tenantName = typeof tenantRow?.name === "string" && tenantRow.name.trim()
    ? tenantRow.name.trim()
    : "No business trace yet";

  const comparisonsEnabled = phase7EvalsLive();
  let comparisonConfigs: EvalComparisonConfigOption[] = [];
  let comparisonDraft: EvalComparisonDraftOption | null = null;
  if (comparisonsEnabled) {
    const [{ data: comparisonConfigRows, error: comparisonConfigError }, { data: draftRow, error: draftError }] = await Promise.all([
      supabase.from("model_configs").select("id, label, openrouter_model, active").eq("role", "generator").order("active", { ascending: false }).order("created_at", { ascending: false }),
      supabase.from("brain_draft_versions").select("id, content_hash").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (comparisonConfigError) throw new Error(`EVAL_COMPARISON_CONFIG_READ_FAILED:${comparisonConfigError.message}`);
    if (draftError) throw new Error(`EVAL_COMPARISON_DRAFT_READ_FAILED:${draftError.message}`);
    comparisonConfigs = (comparisonConfigRows ?? []).map((row) => ({
      id: row.id,
      label: row.label,
      model: row.openrouter_model,
      active: row.active,
    }));
    comparisonDraft = draftRow ? { id: draftRow.id, contentHash: draftRow.content_hash } : null;
  }

  return (
    <AdminBrainTesting
      comparison={{ enabled: comparisonsEnabled, configs: comparisonConfigs, draft: comparisonDraft }}
      tenant={{ id: tenantId, name: tenantName, isDemo }}
      testing={testing}
    />
  );
}

export default async function AdminBrainPage({ searchParams }: PageProps) {
  if (!phase2Live()) {
    return (
      <BrainShell>
        <DataState
          body="Turn on The Brain to review and publish its shared configuration."
          kind="empty"
          title="The Brain is not enabled"
        />
      </BrainShell>
    );
  }

  const claims = await requireBrainAdmin();
  const initialStateResult = await loadAdminBrainState();
  if (!initialStateResult.ok) {
    return (
      <BrainShell>
        <DataState
          body={initialStateResult.reason}
          kind="unavailable"
          title="The Brain could not load"
        />
        <details className="t-faint mt-[var(--s-2)] max-w-[var(--measure-prose)]">
          <summary className="w-fit cursor-pointer select-none">Technical detail</summary>
          <code className="t-id mt-[var(--s-1)] block break-all">{initialStateResult.code}</code>
        </details>
      </BrainShell>
    );
  }
  if (!uiRehaulLive()) {
    return <BrainShell><AdminBrain initialState={initialStateResult.value} /></BrainShell>;
  }

  const params = (await searchParams) ?? {};
  const requested = params.tab;
  const tab = ownerBrainTab(Array.isArray(requested) ? requested[0] : requested);
  return (
    <BrainShell>
      <OwnerBrain
        evals={tab === "evals" ? await renderEvalsTab(claims) : undefined}
        initialState={initialStateResult.value}
        tab={tab}
      />
    </BrainShell>
  );
}
