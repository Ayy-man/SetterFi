import { redirect } from "next/navigation";

import { foldedRouteRedirect, foldedRouteSearchParams, type PageSearchParams } from "@/lib/admin-route-fold";

/**
 * Folded into /admin/billing?tab=tiers#client-overrides. The route is kept so a saved link, a bookmark or an old deep link lands on
 * the rows it was saved for rather than a 404; `foldedRouteFor` owns the destination.
 */
type PageProps = { searchParams: Promise<PageSearchParams> };

export default async function AdminTierOverridesPage({ searchParams }: PageProps): Promise<never> {
  redirect(foldedRouteRedirect("/admin/tiers/overrides", foldedRouteSearchParams(await searchParams))!);
}
