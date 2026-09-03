import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  findPlatformEconomics,
  formatPlatformEconomicsHits,
} from "@/test/platform-economics";

/**
 * The coach and affiliate surfaces may never carry the platform's own cost or margin.
 *
 * CLAUDE.md: "No client-visible margin/cost economics. Cost-vs-revenue is admin-only."
 * Until this file existed nothing tested it. `workspace-navigation.test.ts` keeps "Revenue and
 * subscriptions" out of the coach nav, and `money-portals.test.ts` keeps `AdminMoney` out of the
 * coach page files and rejects a `marginCents` field at the billing parse seam -- but a margin
 * tile hand-written into `coach-agent.tsx` would have passed every one of those.
 *
 * WHY THE IMPORT GRAPH AND NOT A RENDER. The e2e sweep (`assertNoPlatformEconomics`, called from
 * `coach.smoke.spec.ts`) is the rendered-DOM half of this guard, and it is the stronger of the
 * two for anything a browser actually paints. What it cannot see is a branch behind a phase flag
 * that is off in the e2e environment, or a tab the sweep never clicks -- and a redesign lands
 * that code long before the flag flips. Walking every module a coach route can reach catches the
 * copy the moment it is written, flag or no flag, which is what makes this the guard that has to
 * exist BEFORE the page is restructured rather than after.
 *
 * The line between our economics and the coach's own bill lives in `src/test/platform-economics.ts`.
 */

const ROOT = process.cwd();
const SOURCE_EXTENSIONS = [".ts", ".tsx"];

/**
 * Which route trees are client-reachable, derived from the routes rather than listed by hand.
 *
 * This used to name `coach/` and `affiliate/` and nothing else, which is a mechanism standing in
 * for a meaning: the rule is about surfaces a client can reach, and those two directories are only
 * where most of them happen to live. `/account/security` is the case that showed the difference --
 * it sits in a third workspace group, renders under the coach shell through an explicit
 * `role === "coach"` branch, and `app-topbar.tsx` links it from the account menu for every signed-in
 * user regardless of role. A coach reaches it daily and nothing scanned it. `onboarding/`,
 * `consumer/`, `meet-agent/`, `opt-in/`, `signup/` and `access/` sat outside the wall for the same
 * reason.
 *
 * So the question asked here is the one the rule asks: can somebody who is not an admin reach this
 * page. Every route file under `src/app` belongs to a route, its URL is its path with the route
 * groups removed, and anything not under `/admin` is client-reachable. A new client route is inside
 * the wall the moment it exists, which a hand-maintained array cannot promise -- it fell behind
 * once already and would have fallen behind again.
 *
 * The entries are the route's own files rather than its directory, and that distinction is not
 * pedantic: `src/app/page.tsx` is the root route, so its directory is `src/app`, and walking a
 * directory recursively would have made "client-reachable" mean the entire application -- `api/`
 * handlers and every admin screen included. That is the same substitution this fix is about, one
 * level down, so the entry is what a route actually renders: its page, and the layout, loading,
 * error and not-found files Next renders around it.
 */
const ROUTE_FILE = /^(?:page|layout|loading|error|not-found|template|default)\.tsx?$/;

function routeEntryFiles(): { client: string[]; admin: string[] } {
  const client: string[] = [];
  const admin: string[] = [];

  for (const entry of readdirSync(resolve(ROOT, "src/app"), { recursive: true, encoding: "utf8" })) {
    const segments = entry.split(/[\\/]/);
    const name = segments.pop();
    if (!name || !ROUTE_FILE.test(name)) continue;
    const routePath = `/${segments.filter((segment) => !/^\(.*\)$/.test(segment)).join("/")}`;
    const absolute = resolve(ROOT, "src/app", entry);
    (routePath === "/admin" || routePath.startsWith("/admin/") ? admin : client).push(absolute);
  }

  return { client: client.sort(), admin: admin.sort() };
}

const { admin: ADMIN_ENTRY_FILES, client: CLIENT_ENTRY_FILES } = routeEntryFiles();

/** `@/x` and `./x` resolve to project files; a bare specifier is a package and stops the walk. */
function resolveSpecifier(specifier: string, fromFile: string): string | null {
  const base = specifier.startsWith("@/")
    ? resolve(ROOT, "src", specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(fromFile), specifier)
      : null;
  if (!base) return null;

  for (const candidate of [
    ...SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
    // An explicit-extension import, but only of a source module. The bare `base` used to be
    // taken whatever it pointed at, so `import "./coach.css"` walked the graph into a
    // stylesheet -- where `margin: 0` is the box model rather than our margin, and ten CSS
    // declarations read as ten client-visible economics figures. A stylesheet is scanned by
    // `stylesheetCopy` below instead, on the only vocabulary it can actually put on screen.
    SOURCE_EXTENSIONS.some((ext) => base.endsWith(ext)) ? base : null,
  ]) {
    if (candidate && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * The stylesheets a client route loads, and the only text in one that reaches a reader.
 *
 * Dropping stylesheets from the module graph would be a hole rather than a fix: a rule can put
 * words on screen through `content:`, so a stylesheet is a place a forbidden phrase could hide
 * even though it is not a place a figure is normally shown. So they are still collected and still
 * scanned -- just on their `content:` strings rather than on every declaration, because the box
 * model is not economics and a guard that cannot tell the difference gets switched off.
 */
function clientStylesheets(entries: ReadonlyArray<string>): string[] {
  const sheets = new Set<string>();
  for (const file of reachableModules(entries)) {
    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      if (!specifier.endsWith(".css")) continue;
      const base = specifier.startsWith("@/")
        ? resolve(ROOT, "src", specifier.slice(2))
        : specifier.startsWith(".")
          ? resolve(dirname(file), specifier)
          : null;
      if (base && existsSync(base) && statSync(base).isFile()) sheets.add(base);
    }
  }
  return [...sheets].sort();
}

/** Every string a `content:` declaration would render, joined so one scan covers the sheet. */
function stylesheetCopy(source: string): string {
  return [...source.matchAll(/\bcontent\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g)]
    .map((match) => match[1].slice(1, -1))
    .join("\n");
}

function importSpecifiers(source: string): string[] {
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

/**
 * Comments are engineering notes, not client-visible copy -- a note explaining WHY margin is
 * absent must not read as margin being present. Test files are excluded for the same reason:
 * this very file names the vocabulary it forbids.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(?<!:)\/\/[^\n]*/g, " ");
}

function reachableModules(entries: ReadonlyArray<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || /\.test\.tsx?$/.test(file)) continue;
    seen.add(file);

    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      const resolved = resolveSpecifier(specifier, file);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }

  return seen;
}

/**
 * Modules only a client route can reach.
 *
 * Shared modules are subtracted, and that is the point rather than a concession. Definition and
 * contract modules an admin screen also imports -- `metric-definitions.ts` with its `audience:
 * "admin_only"` margin metric, `billing/contracts.ts` with its `marginCents` -- are exactly where
 * platform economics is supposed to live, so scanning them would fail on correct code and teach
 * the next person to reach for the allowlist. What cannot hide there is the decision to SHOW a
 * figure: a label, a tile, a column header, a prop threaded into a coach component. That lands in
 * a coach-only file, which is what this set holds.
 */
function clientOnlyModules(): string[] {
  const adminReachable = reachableModules(ADMIN_ENTRY_FILES);
  return [...reachableModules(CLIENT_ENTRY_FILES)]
    .filter((file) => !adminReachable.has(file))
    .sort();
}

describe("client surfaces carry none of the platform's economics", () => {
  const modules = clientOnlyModules();

  it("reaches the coach surfaces it is meant to police", () => {
    const relatives = modules.map((file) => relative(ROOT, file));

    // If a rename ever drops these from the graph the sweep below would pass vacuously.
    expect(relatives).toContain("src/app/(workspace)/coach/agent/page.tsx");
    expect(relatives).toContain("src/components/workspace/rehaul/coach-agent.tsx");
    expect(relatives).toContain("src/components/workspace/live/coach-billing.tsx");
    // Home's surface, `coach-measurement.tsx` until the rehaul took the route.
    expect(relatives).toContain("src/components/workspace/rehaul/coach-dashboard.tsx");
    expect(modules.length).toBeGreaterThan(20);

    // The route that showed the entry list was narrower than the rule. It is not under `coach/`,
    // so it went unscanned while a coach reached it from the account menu every day. Pinned by
    // name: if a refactor moves it back outside the wall, that has to fail here rather than show
    // up as a silently smaller sweep.
    expect(relatives).toContain("src/components/workspace/live/account-security-settings.tsx");

    // And the derivation must keep excluding what the admin graph legitimately carries. `/admin`
    // routes are where margin belongs, so if one ever lands in the client set this guard starts
    // failing on correct code, which is the failure that gets a guard switched off.
    expect(relatives.filter((file) => file.startsWith("src/app/(workspace)/admin/"))).toEqual([]);
  });

  it("shows no margin, unit cost, or cost-vs-revenue figure on any coach or affiliate route", () => {
    const offenders = modules.flatMap((file) => {
      const hits = findPlatformEconomics(withoutComments(readFileSync(file, "utf8")));
      return formatPlatformEconomicsHits(hits).map(
        (hit) => `${relative(ROOT, file)}: ${hit}`,
      );
    });

    expect(
      offenders,
      [
        "A coach or affiliate surface reached platform cost economics, which are admin-only.",
        "Move the figure to an /admin surface, or if it is the coach's own bill (plan price,",
        "invoice, allowance) reword it so it does not read as our cost or margin.",
        ...offenders,
      ].join("\n  "),
    ).toEqual([]);
  });

  /*
   * The stylesheet half of the same wall. `coach.css` and `consumer.css` are loaded by client
   * routes and carry no figures, but `content:` is a real way to put a word on a screen, so the
   * sheets are scanned rather than trusted -- on that vocabulary alone.
   */
  it("puts no economics vocabulary in a client stylesheet's rendered content", () => {
    const sheets = clientStylesheets(CLIENT_ENTRY_FILES);

    // A rename that drops the sheets from the graph must fail here rather than pass vacuously.
    expect(sheets.map((file) => relative(ROOT, file))).toContain(
      "src/app/(workspace)/coach/coach.css",
    );

    const offenders = sheets.flatMap((file) =>
      formatPlatformEconomicsHits(
        findPlatformEconomics(stylesheetCopy(readFileSync(file, "utf8"))),
      ).map((hit) => `${relative(ROOT, file)}: ${hit}`),
    );

    expect(offenders, offenders.join("\n  ")).toEqual([]);
  });
});

describe("the economics vocabulary separates our margin from the coach's own bill", () => {
  const forbidden = [
    "Blended margin 62%",
    "Gross margin",
    "Margin: $412.00",
    "COGS this period",
    "Cost per booking $2.15",
    "Cost per message",
    "Unit cost",
    "unit economics",
    "cost vs revenue",
    "Revenue vs cost",
    "Model cost",
    "carrier cost",
    "cost to serve",
    "spend per booking",
    "gross profit",
    "profitability",
    "$0.012 per message",
    "marginCents",
    "blendedMarginPct",
    "costPerBooking",
  ];

  const allowed = [
    // The coach's own bill. Every one of these is copy a coach is entitled to see.
    "Your plan is $300 per month",
    "Growth costs $300/mo",
    "Invoice: open",
    "Booked-call allowance: 18 of 25",
    "$12 per booked call",
    "Payment method on file",
    "This billing period ends 21 Sep",
    "18/25 booked calls",
    // Words that only look like economics.
    "margin-top: 4px",
    "marginTop",
    "Costa Rica",
    "The setup cost you nothing",
  ];

  it.each(forbidden)("catches %s", (phrase) => {
    expect(findPlatformEconomics(phrase)).not.toEqual([]);
  });

  it.each(allowed)("allows %s", (phrase) => {
    expect(formatPlatformEconomicsHits(findPlatformEconomics(phrase))).toEqual([]);
  });
});
