import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";

import { AdminSupportTeam } from "@/components/workspace/live/admin-support-team";
import { foldedRouteRedirect, foldedRouteSearchParams, type PageSearchParams } from "@/lib/admin-route-fold";
import { navFoldLive, phase8SupportLive } from "@/lib/env-contract";
import { loadSupportSession } from "@/lib/support/service";

export const metadata: Metadata = { title: "Success team" };
export const dynamic = "force-dynamic";

type PageProps = { searchParams: Promise<PageSearchParams> };

/**
 * The same gate the client book carries, for the same reason: this page groups that read.
 *
 * It reads `/api/platform/clients?book=all`, which is already refused to anyone but owner, admin
 * and success, and refused outright inside an impersonated session. Guarding here as well means a
 * reader who cannot see the book meets a refusal on the page rather than an empty roster that
 * looks like a platform with no success team on it.
 */
export default async function SupportTeamPage({ searchParams }: PageProps) {
  if (navFoldLive()) redirect(foldedRouteRedirect("/admin/support-team", foldedRouteSearchParams(await searchParams))!);
  if (!phase8SupportLive()) return <AdminSupportTeam actorId="" enabled={false} />;

  const session = await loadSupportSession();
  if (!session) redirect("/login?next=%2Fadmin%2Fsupport-team");
  if (
    session.impersonatingTenant
    || (session.role !== "owner" && session.role !== "admin" && session.role !== "success")
  ) forbidden();

  return <AdminSupportTeam actorId={session.userId} enabled />;
}
