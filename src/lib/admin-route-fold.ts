export type FoldedRoute = {
  pathname: string;
  param: "section" | "tab";
  value: string;
  hash?: string;
};

/** The destination and selected section for every admin route removed from the folded rail. */
export const foldedRouteFor: Readonly<Record<string, FoldedRoute>> = {
  "/admin/tiers": { pathname: "/admin/billing", param: "tab", value: "tiers" },
  "/admin/tiers/overrides": { pathname: "/admin/billing", param: "tab", value: "tiers", hash: "client-overrides" },
  "/admin/affiliates": { pathname: "/admin/billing", param: "tab", value: "affiliates" },
  "/admin/corrections": { pathname: "/admin/billing", param: "tab", value: "corrections" },
  "/admin/billing/costs": { pathname: "/admin/billing", param: "tab", value: "costs" },
  "/admin/agents": { pathname: "/admin/platform-clients", param: "tab", value: "agent" },
  "/admin/agent-performance": { pathname: "/admin/platform-clients", param: "tab", value: "performance" },
  "/admin/channel-health": { pathname: "/admin/platform-clients", param: "tab", value: "health" },
  "/admin/provisioning": { pathname: "/admin/platform-clients", param: "tab", value: "health" },
  "/admin/support-team": { pathname: "/admin/platform-clients", param: "tab", value: "team" },
  "/admin/brain/testing": { pathname: "/admin/brain", param: "tab", value: "evals" },
  "/admin/account-terms": { pathname: "/account", param: "section", value: "terms" },
  "/admin/help": { pathname: "/account", param: "section", value: "help" },
};

export type PageSearchParams = Record<string, string | string[] | undefined>;

/** Preserves repeated query keys from an App Router page's serialised search params. */
export function foldedRouteSearchParams(searchParams: PageSearchParams): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) value.forEach((entry) => search.append(key, entry));
    else if (typeof value === "string") search.append(key, value);
  }
  return search;
}

/** Returns a folded route's canonical destination, carrying its query string and fragment. */
export function foldedRouteRedirect(pathname: string, search: URLSearchParams): string | null {
  const route = foldedRouteFor[pathname];
  if (!route) return null;

  const params = new URLSearchParams(search);
  params.set(route.param, route.value);
  const query = params.toString();
  return `${route.pathname}${query ? `?${query}` : ""}${route.hash ? `#${route.hash}` : ""}`;
}
