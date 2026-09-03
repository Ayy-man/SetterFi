import { redirect } from "next/navigation";

import { foldedRouteRedirect, foldedRouteSearchParams, type PageSearchParams } from "@/lib/admin-route-fold";
import { navFoldLive } from "@/lib/env-contract";

/**
 * The saved link, pointed at the rows it was saved for.
 *
 * This was a page of its own with the document title "Client overrides", rendering
 * `renderTiersPage("overrides")` -- which returns exactly what `/admin/tiers` returns, because the
 * plans and the client book stopped being two tabs and became two bands of one page. So the tab
 * title named a view that no longer exists while the heading underneath said "Plans and pricing",
 * and the deep link landed at the top of the page rather than on the overrides.
 *
 * A redirect rather than a re-titled duplicate: two URLs rendering one screen is how the two names
 * got here, and the `#client-overrides` band is what somebody following this link came for.
 */
type PageProps = { searchParams: Promise<PageSearchParams> };

export default async function AdminTierOverridesPage({ searchParams }: PageProps): Promise<never> {
  if (navFoldLive()) redirect(foldedRouteRedirect("/admin/tiers/overrides", foldedRouteSearchParams(await searchParams))!);
  redirect("/admin/tiers#client-overrides");
}
