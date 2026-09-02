import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { AdminAuditLog } from "@/components/workspace/live/admin-audit-log";
import { phase8Live } from "@/lib/env-contract";
import { loadSupportSession } from "@/lib/support/service";

import { PAGE_SIZE, loadAuditRows, requestedQuery } from "./load";

export const metadata: Metadata = { title: "Audit" };
export const dynamic = "force-dynamic";

// "Platform" is a nav group, not a page, so the crumb names it without linking anywhere. It used
// to point at the Overview, which lives in a different group entirely.
const crumbs = [
  { label: "Platform" },
  { label: "Audit" },
] as const;

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

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
        viewCounts={result.viewCounts}
        rows={result.rows}
        unavailableReason={result.unavailableReason}
      />
    </AuditShell>
  );
}
