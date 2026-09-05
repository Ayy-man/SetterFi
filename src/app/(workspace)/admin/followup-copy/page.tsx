import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";

import { AppShell } from "@/components/kit/app-shell";
import { FollowupCopyApprovals } from "@/components/workspace/rehaul/followup-copy-approvals";
import { phase3Live } from "@/lib/env-contract";
import { listPendingFollowupCopy } from "@/lib/repositories/followup-copy";
import { loadPlatformActor } from "@/lib/auth/actors";

export const metadata: Metadata = { title: "Follow-up copy" };
export const dynamic = "force-dynamic";

export default async function AdminFollowupCopyPage() {
  if (!phase3Live()) {
    return <AppShell activePath="/admin/followup-copy" crumbs={[{ label: "Platform" }, { label: "Follow-up copy" }]} role="admin"><FollowupCopyApprovals initialItems={[]} /></AppShell>;
  }
  const actor = await loadPlatformActor();
  if (!actor) redirect("/login?next=%2Fadmin%2Ffollowup-copy");
  if (actor.role !== "owner" && actor.role !== "admin") forbidden();
  const items = await listPendingFollowupCopy();
  return <AppShell activePath="/admin/followup-copy" crumbs={[{ label: "Platform" }, { label: "Follow-up copy" }]} role="admin"><FollowupCopyApprovals initialItems={items} /></AppShell>;
}
