import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { DataState } from "@/components/kit/data-state";
import { PageHeader } from "@/components/kit/page-header";
import { AdminHelp, type HandoverPackage } from "@/components/workspace/admin-help";
import { foldedRouteRedirect, foldedRouteSearchParams, type PageSearchParams } from "@/lib/admin-route-fold";
import { navFoldLive, phase8Live } from "@/lib/env-contract";
import { HANDOVER_CONTENT_FILES } from "@/lib/handover/generator";
import { loadSupportSession } from "@/lib/support/service";

export const metadata: Metadata = { title: "Help" };
export const dynamic = "force-dynamic";

const CRUMBS = [{ label: "Platform" }, { label: "Help" }] as const;

type PageProps = { searchParams: Promise<PageSearchParams> };

function AdminHelpShell({ children }: { children: ReactNode }) {
  return (
    <AppShell
      activePath="/admin/help"
      crumbs={CRUMBS}
      role="admin"
    >
      {children}
    </AppShell>
  );
}

async function loadHandoverPackage(): Promise<HandoverPackage> {
  const directory = path.join(process.cwd(), "docs/operations");
  const manifest = await readFile(path.join(directory, "MANIFEST.md"), "utf8");
  const generatedAt = manifest.match(/^Generated at: `([^`]+)`$/mu)?.[1];
  const guideCount = Number(manifest.match(/^Operator guides: (\d+)$/mu)?.[1]);
  if (!generatedAt || !Number.isInteger(guideCount)) throw new Error("HANDOVER_MANIFEST_INVALID");
  const names = [...HANDOVER_CONTENT_FILES, "MANIFEST.md"] as const;
  const downloads = await Promise.all(names.map(async (fileName) => ({
    fileName,
    content: fileName === "MANIFEST.md" ? manifest : await readFile(path.join(directory, fileName), "utf8"),
  })));
  return { generatedAt, guideCount, downloads };
}

export default async function AdminHelpPage({ searchParams }: PageProps) {
  if (navFoldLive()) redirect(foldedRouteRedirect("/admin/help", foldedRouteSearchParams(await searchParams))!);
  if (!phase8Live()) {
    return (
      <AdminHelpShell>
        <PageHeader
          crumbs={CRUMBS}
          description="Task-based runbooks for platform operations and incident checks."
          title="Help"
        />
        <DataState
          body="Turn on platform operations to read the operator runbooks and handover package."
          kind="empty"
          title="Operator help is not enabled"
        />
      </AdminHelpShell>
    );
  }
  const session = await loadSupportSession();
  if (!session) redirect("/login?next=%2Fadmin%2Fhelp");
  if (session.impersonatingTenant || !["owner", "admin", "success"].includes(session.role)) forbidden();
  const handover = await loadHandoverPackage();
  return <AdminHelpShell><AdminHelp handover={handover} /></AdminHelpShell>;
}
