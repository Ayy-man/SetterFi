/**
 * The owner console's `?tab=` identities, held apart from the screens that draw them.
 *
 * `owner-money.tsx` and `owner-brain.tsx` are `"use client"` modules, and the two server pages
 * routing into them need the same tab list before they render, to narrow `?tab=` into a value the
 * screen accepts. Reaching into the client module for it does not fail loudly: Next replaces every
 * export of a `"use client"` module with a client *reference* when the server imports it, so the
 * frozen array stops being an array and the resolver stops being callable. Both shipped that way
 * and both threw in production -- `OWNER_MONEY_TABS.find is not a function` on `/admin/billing`,
 * and "Attempted to call ownerBrainTab() from the server but ownerBrainTab is on the client" on
 * `/admin/brain`. Neither is visible to Vitest, which loads these modules in a plain jsdom graph
 * where the directive is an inert string, nor to `tsc`, which does not model the boundary at all.
 *
 * So the identities live here, in a module carrying no directive and no React import, and both
 * sides import them from the same place. `src/app/server-client-boundary.test.ts` holds the rule
 * that keeps them here.
 */

export const OWNER_MONEY_TABS = ["billing", "costs", "tiers", "affiliates", "corrections"] as const;

export type OwnerMoneyTab = (typeof OWNER_MONEY_TABS)[number];

/**
 * The Brain's sections, 2026-09-06 redesign.
 *
 * Five configuration sections share one editor with the test conversation beside it; the other
 * three are full-width working views reached from the header or from Knowledge. The old tab ids
 * are still accepted so a bookmarked `?tab=versions` or the route fold's `?tab=evals` lands on
 * the view that replaced it rather than on the first section.
 */
export const OWNER_BRAIN_TABS = [
  "behavior",
  "qualification",
  "knowledge",
  "safety",
  "models",
  "review",
  "suite",
  "prompt",
] as const;

export type OwnerBrainTab = (typeof OWNER_BRAIN_TABS)[number];

/** The five sections on the Configure rail, in rail order. */
export const OWNER_BRAIN_SECTIONS = OWNER_BRAIN_TABS.slice(0, 5) as readonly OwnerBrainTab[];

const LEGACY_BRAIN_TABS: Readonly<Record<string, OwnerBrainTab>> = {
  overview: "behavior",
  defaults: "behavior",
  versions: "behavior",
  evals: "suite",
  diagnostics: "suite",
};

export function ownerBrainTab(value: string | null | undefined): OwnerBrainTab {
  if (OWNER_BRAIN_TABS.includes(value as OwnerBrainTab)) return value as OwnerBrainTab;
  return (value && LEGACY_BRAIN_TABS[value]) || "behavior";
}

/**
 * The client pane's sections on `/admin/platform-clients`, which are not that page's tabs.
 *
 * The page's tab row and the pane's section row wrote the same `?tab=` value until this pass, so
 * opening a client's Performance section silently reordered the table behind the pane and the page
 * tab decided what the pane showed. They are two controls and now two params, and the two lists
 * differ: the page also has Team and Setup, neither of which is a thing one client has.
 *
 * It lives here rather than in `owner-clients.tsx` for the reason at the top of this file. That
 * screen carries `"use client"`, and the server page has to narrow `?section=` before it renders.
 */
export const OWNER_CLIENT_PANE_SECTIONS = ["status", "agent", "performance", "health"] as const;

export type OwnerClientPaneSection = (typeof OWNER_CLIENT_PANE_SECTIONS)[number];

/**
 * The pane section a `?section=` value names, or the first one.
 *
 * An unknown or out-of-range value falls back rather than rendering an empty pane: a link typed by
 * hand, or one pointing at a page tab like `team`, still opens the client on a real section.
 */
export function ownerClientPaneSection(
  value: string | null | undefined,
): OwnerClientPaneSection {
  return OWNER_CLIENT_PANE_SECTIONS.includes(value as OwnerClientPaneSection)
    ? (value as OwnerClientPaneSection)
    : OWNER_CLIENT_PANE_SECTIONS[0];
}
