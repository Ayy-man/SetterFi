import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "@/components/kit/app-shell";
import {
  AdminAuditLog,
  type AdminAuditRow,
  type AuditPagination,
} from "@/components/workspace/live/admin-audit-log";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";
import { phase8Live } from "@/lib/env-contract";
import { loadSupportSession } from "@/lib/support/service";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Audit" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
const BASE_AUDIT_COLUMNS = "id,tenant_id,action,actor_id,target_type,target_id,reason,created_at";
const AUDIT_COLUMNS_WITH_ORIGIN = `${BASE_AUDIT_COLUMNS},source,actor_ip`;
// "Platform" is a nav group, not a page, so the crumb names it without linking anywhere. It used
// to point at the Overview, which lives in a different group entirely.
const crumbs = [
  { label: "Platform" },
  { label: "Audit" },
] as const;

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

type AuditCursor = { at: string; id: string };

type AuditDatabaseRow = {
  id: string | number;
  tenant_id: string | null;
  action: string;
  actor_id: string | null;
  target_type: string | null;
  target_id: string | null;
  reason: string | null;
  created_at: string;
  source?: string | null;
  actor_ip?: string | null;
};

/**
 * How far back the log is being read.
 *
 * Server-side on purpose. The outcome, actor-role and client facets filter the rows already on the
 * page, which is correct for a facet whose options come from those rows; a date range cannot work
 * that way -- "7 days" over one loaded page would show the last 50 events that happen to be recent
 * rather than the last 7 days, and the count beside it would be a different question's answer.
 */
export const AUDIT_RANGES = ["7d", "30d", "all"] as const;
export type AuditRange = (typeof AUDIT_RANGES)[number];
const RANGE_DAYS: Record<AuditRange, number | null> = { "7d": 7, "30d": 30, all: null };

type AuditQuery = {
  range: AuditRange;
  rangeStart: string | null;
  cursor: AuditCursor | null;
  direction: "next" | "previous";
  pageIndex: number;
  search: string;
  action: string | null;
  ascending: boolean;
};

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function parseCursor(value: string | undefined): AuditCursor | null {
  if (!value) return null;
  const separator = value.lastIndexOf("~");
  if (separator < 1) return null;

  const at = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (Number.isNaN(Date.parse(at)) || !/^\d+$/.test(id)) return null;
  return { at, id };
}

function requestedQuery(params: Record<string, string | string[] | undefined>): AuditQuery {
  const cursor = parseCursor(firstParam(params.cursor));
  const rawPage = Number.parseInt(firstParam(params.page) ?? "0", 10);
  const rawAction = firstParam(params.action);
  const action = rawAction && Object.prototype.hasOwnProperty.call(AUDIT_ACTIONS, rawAction)
    ? rawAction
    : null;

  const rawRange = firstParam(params.range);
  const range: AuditRange = AUDIT_RANGES.includes(rawRange as AuditRange)
    ? rawRange as AuditRange
    : "all";
  const days = RANGE_DAYS[range];

  return {
    range,
    // Computed once per request so the count query and the row query cannot land either side of a
    // midnight and disagree about how many events are in the window.
    rangeStart: days === null
      ? null
      : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(),
    action,
    ascending: firstParam(params.sort) === "oldest",
    cursor,
    direction: firstParam(params.direction) === "previous" ? "previous" : "next",
    pageIndex: cursor && Number.isFinite(rawPage) ? Math.max(0, rawPage) : 0,
    search: (firstParam(params.q) ?? "").trim().slice(0, 120),
  };
}

function safeSearchTerm(value: string) {
  return value.replaceAll(/[,%()]/g, " ").replaceAll(/\s+/g, " ").trim();
}

function missingAuditOriginColumns(error: { code?: string; message?: string } | null) {
  if (!error) return false;
  const message = error.message?.toLocaleLowerCase() ?? "";
  return (error.code === "42703" || error.code === "PGRST204")
    && (message.includes("actor_ip")
      || (message.includes("source") && message.includes("audit_log")));
}

/**
 * One extra keyed read so the feed can say who acted instead of printing a UUID. An actor we
 * cannot resolve stays unresolved: the row falls back to the neutral "Operator" wording rather
 * than inventing a name, and a failed read simply leaves every actor unresolved.
 */
async function loadActorNames(
  client: ReturnType<typeof createSupabaseServiceClient>,
  rows: readonly AuditDatabaseRow[],
): Promise<Map<string, string>> {
  const actorIds = [...new Set(rows.map((row) => row.actor_id).filter((id): id is string => Boolean(id)))];
  const resolved = new Map<string, string>();
  if (actorIds.length === 0) return resolved;

  const { data, error } = await client.from("users")
    .select("id,full_name,email")
    .in("id", actorIds);
  if (error || !data) return resolved;

  for (const user of data as { id: string; full_name: string | null; email: string | null }[]) {
    const name = user.full_name?.trim() || user.email?.trim();
    if (name) resolved.set(user.id, name);
  }
  return resolved;
}

/**
 * One keyed read so a row can name the workspace it landed on instead of printing a uuid, which is
 * the 180px scope column screen 1h puts on every row. An unresolved id stays unresolved and the
 * row says "One workspace"; it never guesses at a name.
 */
async function loadTenantNames(
  client: ReturnType<typeof createSupabaseServiceClient>,
  rows: readonly AuditDatabaseRow[],
): Promise<Map<string, string>> {
  const tenantIds = [...new Set(rows.map((row) => row.tenant_id).filter((id): id is string => Boolean(id)))];
  const resolved = new Map<string, string>();
  if (tenantIds.length === 0) return resolved;

  const { data, error } = await client.from("tenants").select("id,name").in("id", tenantIds);
  if (error || !data) return resolved;

  for (const tenant of data as { id: string; name: string | null }[]) {
    const name = tenant.name?.trim();
    if (name) resolved.set(tenant.id, name);
  }
  return resolved;
}

async function loadAuditRows(input: AuditQuery): Promise<{
  rows: AdminAuditRow[];
  pagination: AuditPagination;
  unavailableReason: string | null;
  liveWorkspaceCount: number | null;
}> {
  const emptyPagination: AuditPagination = {
    hasNextPage: false,
    hasPreviousPage: input.pageIndex > 0,
    pageIndex: input.pageIndex,
    pageSize: PAGE_SIZE,
    totalRows: 0,
  };
  const client = createSupabaseServiceClient();
  const { data: tenants, error: tenantError } = await client.from("analytics_tenants")
    .select("tenant_id,status")
    .order("tenant_id");
  if (tenantError) {
    return {
      rows: [],
      pagination: emptyPagination,
      unavailableReason: "This log could not confirm which workspaces are real, so no rows are shown.",
      liveWorkspaceCount: null,
    };
  }

  /*
   * How many workspaces answer from the central Brain *right now*. This is not the reach a past
   * publish had -- the log records no per-event reach and this page will not invent one -- so the
   * drawer labels it "live now" wherever it prints it.
   */
  const liveWorkspaceCount = (tenants ?? []).filter((row) => row.status === "active").length;

  const realTenantIds = (tenants ?? []).map((row) => String(row.tenant_id));
  const tenantFilter = realTenantIds.map((id) => `"${id}"`).join(",");

  function withVisibleAuditFilters<T extends {
    eq: (column: string, value: string) => T;
    gte: (column: string, value: string) => T;
    or: (filters: string) => T;
  }>(initialQuery: T) {
    let query = initialQuery;
    // Applied to the count query and the row query alike, so the footer's total is the total for
    // the window the reader chose rather than for the whole log.
    if (input.rangeStart) query = query.gte("created_at", input.rangeStart);
    query = query.or(tenantFilter
      ? `tenant_id.is.null,tenant_id.in.(${tenantFilter})`
      : "tenant_id.is.null");
    if (input.action) query = query.eq("action", input.action);
    const search = safeSearchTerm(input.search);
    if (search) {
      query = query.or(
        `action.ilike.%${search}%,target_type.ilike.%${search}%,reason.ilike.%${search}%`,
      );
    }
    return query;
  }

  let countQuery = client.from("audit_log").select("id", { count: "exact", head: true });
  countQuery = withVisibleAuditFilters(countQuery);
  const { count, error: countError } = await countQuery;
  if (countError) {
    return {
      rows: [],
      pagination: emptyPagination,
      unavailableReason: "Audit events are temporarily unavailable.",
      liveWorkspaceCount,
    };
  }

  async function executeRowsQuery(includeOrigin: boolean) {
    let query = client.from("audit_log")
      .select(includeOrigin ? AUDIT_COLUMNS_WITH_ORIGIN : BASE_AUDIT_COLUMNS);
    query = withVisibleAuditFilters(query);

    if (input.cursor) {
      const movingEarlier = input.direction === "previous";
      const comparator = input.ascending === movingEarlier ? "lt" : "gt";
      query = query.or(
        `created_at.${comparator}.${input.cursor.at},and(created_at.eq.${input.cursor.at},id.${comparator}.${input.cursor.id})`,
      );
    }

    const queryAscending = input.direction === "previous" ? !input.ascending : input.ascending;
    return query
      .order("created_at", { ascending: queryAscending })
      .order("id", { ascending: queryAscending })
      .limit(PAGE_SIZE + 1);
  }

  let result = await executeRowsQuery(true);
  let originColumnsAvailable = true;
  if (missingAuditOriginColumns(result.error)) {
    originColumnsAvailable = false;
    result = await executeRowsQuery(false);
  }
  if (result.error) {
    return {
      rows: [],
      pagination: { ...emptyPagination, totalRows: count ?? 0 },
      unavailableReason: "Audit events are temporarily unavailable.",
      liveWorkspaceCount,
    };
  }

  const selectedRows = ((result.data ?? []) as unknown as AuditDatabaseRow[]).slice(0, PAGE_SIZE);
  if (input.direction === "previous") selectedRows.reverse();
  const totalRows = count ?? 0;
  const [actorNames, tenantNames] = await Promise.all([
    loadActorNames(client, selectedRows),
    loadTenantNames(client, selectedRows),
  ]);

  return {
    liveWorkspaceCount,
    unavailableReason: null,
    pagination: {
      hasNextPage: (input.pageIndex + 1) * PAGE_SIZE < totalRows,
      hasPreviousPage: input.pageIndex > 0,
      pageIndex: input.pageIndex,
      pageSize: PAGE_SIZE,
      totalRows,
    },
    rows: selectedRows.map((row) => ({
      id: String(row.id),
      action: row.action,
      actor: row.actor_id ?? "Actor unavailable",
      target: [row.target_type, row.target_id].filter(Boolean).join(": ") || "Target unavailable",
      reason: row.reason,
      at: row.created_at,
      actorName: row.actor_id ? actorNames.get(row.actor_id) ?? null : null,
      testData: row.tenant_id === null ? null : false,
      source: originColumnsAvailable ? row.source ?? null : null,
      actorIp: originColumnsAvailable ? row.actor_ip ?? null : null,
      tenantId: row.tenant_id,
      tenantName: row.tenant_id ? tenantNames.get(row.tenant_id) ?? null : null,
    })),
  };
}

function AuditShell({ children }: { children: ReactNode }) {
  return (
    <AppShell
      activePath="/admin/audit"
      crumbs={crumbs}
      role="admin"
    >
      {children}
    </AppShell>
  );
}

export default async function AuditPage({ searchParams }: PageProps) {
  if (!phase8Live()) {
    return (
      <AuditShell>
        <AdminAuditLog enabled={false} rows={[]} pagination={{
          hasNextPage: false,
          hasPreviousPage: false,
          pageIndex: 0,
          pageSize: PAGE_SIZE,
          totalRows: 0,
        }} />
      </AuditShell>
    );
  }

  const session = await loadSupportSession();
  if (!session) redirect("/login?next=%2Fadmin%2Faudit");
  if (session.impersonatingTenant
    || (session.role !== "owner" && session.role !== "admin" && session.role !== "success")) forbidden();

  const query = requestedQuery(await searchParams);
  const result = await loadAuditRows(query);
  return (
    <AuditShell>
      <AdminAuditLog
        enabled
        liveWorkspaceCount={result.liveWorkspaceCount}
        // The server's clock, so "Today" on a day divider means the server's today and not the
        // browser's. Computed here rather than in the client component to keep the first render
        // and the hydrated one saying the same word.
        nowIso={new Date().toISOString()}
        pagination={result.pagination}
        rangeStart={query.rangeStart}
        rows={result.rows}
        unavailableReason={result.unavailableReason}
      />
    </AuditShell>
  );
}
