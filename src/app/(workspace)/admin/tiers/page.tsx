import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { renderTiersPage } from "@/app/(workspace)/admin/tiers/render-tiers-page";
import { foldedRouteRedirect, foldedRouteSearchParams, type PageSearchParams } from "@/lib/admin-route-fold";
import { navFoldLive } from "@/lib/env-contract";

export const metadata: Metadata = { title: "Plans and pricing" };
export const dynamic = "force-dynamic";

type PageProps = { searchParams: Promise<PageSearchParams> };

export default async function AdminTiersPage({ searchParams }: PageProps) {
  if (navFoldLive()) redirect(foldedRouteRedirect("/admin/tiers", foldedRouteSearchParams(await searchParams))!);
  return renderTiersPage();
}
