import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/kit/app-shell";
import { DataState } from "@/components/kit/data-state";
import { AdminBrainTesting } from "@/components/workspace/live/admin-testing";
import type { EvalComparisonConfigOption, EvalComparisonDraftOption } from "@/components/workspace/live/eval-comparison-view-models";
import { deriveTestingView, type MessageTraceRead, type TestingArmInput } from "@/components/workspace/live/view-models";
import { foldedRouteRedirect, foldedRouteSearchParams, type PageSearchParams } from "@/lib/admin-route-fold";
import { canAccessWorkspace, parseAppClaims, workspaceForRole } from "@/lib/auth/claims";
import { driverSelection, environmentValue, navFoldLive, phase1Live, phase7EvalsLive } from "@/lib/env-contract";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Evals" };
export const dynamic = "force-dynamic";

const CRUMBS = [
  { label: "Brain", href: "/admin/brain" },
  { label: "Evals" },
] as const;

type PageProps = { searchParams: Promise<PageSearchParams> };

function TestingShell({ children }: { children: React.ReactNode }) {
  return (
    <AppShell
      activePath="/admin/brain/testing"
      crumbs={CRUMBS}
      role="admin"
    >
      {children}
    </AppShell>
  );
}

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

export default async function AdminTestingPage({ searchParams }: PageProps) {
  if (navFoldLive()) redirect(foldedRouteRedirect("/admin/brain/testing", foldedRouteSearchParams(await searchParams))!);
  if (!phase1Live()) {
    return (
      <TestingShell>
        <DataState
          body="Turn on Brain evals to inspect test-only configuration evidence."
          kind="empty"
          title="Brain evals are not enabled"
        />
      </TestingShell>
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data: claimData, error: claimError } = await supabase.auth.getClaims();
  if (claimError || !claimData?.claims) redirect("/login?next=%2Fadmin%2Fbrain%2Ftesting");
  const claims = parseAppClaims(claimData.claims);
  if (!canAccessWorkspace(claims.role, "admin", { affiliateAccess: claims.affiliateAccess })) {
    const home = workspaceForRole(claims.role);
    redirect(home ? `/${home}` : "/login");
  }

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
    <TestingShell>
      <AdminBrainTesting
        comparison={{ enabled: comparisonsEnabled, configs: comparisonConfigs, draft: comparisonDraft }}
        tenant={{ id: tenantId, name: tenantName, isDemo }}
        testing={testing}
      />
    </TestingShell>
  );
}
