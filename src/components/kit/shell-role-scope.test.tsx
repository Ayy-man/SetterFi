/**
 * A scoped block that matches nothing is the silent way a shell stylesheet fails.
 *
 * `console.css` and `coach.css` are written almost entirely under `[data-shell-role="admin"]` and
 * `[data-shell-role="coach"]`. Every token those sheets redeclare -- the whole text ramp, the drench
 * grounds, the density restatements -- exists only for elements inside that scope. Nothing today
 * checks that any element is.
 *
 * Compiling proves the other half and only the other half. Run through the project's own
 * PostCSS/Tailwind pipeline (2026-09-01) both sheets emit their `.coach-panel[data-drench]` block
 * with `--ink` redeclared inside it, zero warnings. That says the selector reaches real output. It
 * cannot say whether a single element matches it, and neither can a screenshot of a page that
 * happens to look right.
 *
 * The failure has no symptom to look for. There is no warning, no error, no wrong value -- a
 * subtree outside the scope simply resolves every scoped token to whatever the page palette holds,
 * which is a plausible colour, so it renders as a slightly-off panel rather than as a bug. On a
 * drench it is worse than slightly off: the ground is dark in every theme while the tokens stay
 * light-palette, and `drench-decision.test.ts` treats "redeclared in both drench blocks" as proof a
 * colour was decided for that ground. That proof is only worth anything if the element is inside
 * the scope carrying the redeclaration, which is the assumption this file exists to hold.
 *
 * The ordinary way it breaks is a portal. A dialog, popover, tooltip or toast mounts on
 * `document.body`, outside the shell root, and several components already carry comments saying so
 * -- `coach-measurement.tsx:974`, `app-topbar.tsx:545`, `impersonation-banner.tsx:39`. Comments are
 * where that rule has been living.
 *
 * THE ROLE NAMES ARE READ OUT OF THE STYLESHEETS, never spelled here. A test that restates
 * `"admin"` independently passes on exactly the change worth catching -- someone renaming the scope
 * in the sheet and not in the shell, or the other way round -- because both halves would still say
 * something, just not the same thing.
 */

import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AppShell, type NavGroup } from "@/components/kit/app-shell";
import { TitlePanel } from "@/components/kit/deck-panel";

const ROOT = process.cwd();

const SHEETS = {
  admin: "src/app/(workspace)/admin/console.css",
  coach: "src/app/(workspace)/coach/coach.css",
} as const;

/** Every role value a sheet scopes rules on, read from the sheet itself. */
function scopedRoles(sheet: string): string[] {
  const css = readFileSync(resolve(ROOT, sheet), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...new Set([...css.matchAll(/\[data-shell-role="([a-z]+)"\]/g)].map((match) => match[1]))].sort();
}

const nav: readonly NavGroup[] = [{ label: "Workspace", items: [{ label: "Home", href: "/home" }] }];

function renderShell(role: "admin" | "coach" | "affiliate", children: React.ReactNode) {
  return render(
    <AppShell activePath="/home" crumbs={[{ label: "Workspace" }]} nav={nav} role={role}>
      {children}
    </AppShell>,
  );
}

describe("the shell stamps the scope its stylesheet is written under", () => {
  it("reads exactly one role out of each sheet", () => {
    // Every assertion below is over these two values. If a sheet stopped matching -- renamed
    // attribute, restructured selector -- `scopedRoles` would return an empty array and the
    // comparisons would pass vacuously against a shell that stamps nothing.
    for (const [role, sheet] of Object.entries(SHEETS)) {
      const roles = scopedRoles(sheet);
      expect(roles, `${sheet} scopes no rules on a shell role`).not.toEqual([]);
      expect(roles, `${sheet} scopes rules on more than its own role`).toEqual([role]);
    }
  });

  it.each(Object.entries(SHEETS))("mounts an element carrying the role %s scopes on", (role, sheet) => {
    const [scoped] = scopedRoles(sheet);
    const { container } = renderShell(role as "admin" | "coach", <p>page</p>);

    const scopeRoot = container.querySelector(`[data-shell-role="${scoped}"]`);
    expect(
      scopeRoot,
      `nothing in the ${role} shell carries data-shell-role="${scoped}", so every rule in ${sheet} matches nothing`,
    ).not.toBeNull();
  });

  it("puts a drenched panel inside the scope that redeclares its tokens", () => {
    const [scoped] = scopedRoles(SHEETS.coach);
    const { container } = renderShell("coach", <TitlePanel drench="info" title="Panel" />);

    const drenched = container.querySelector("[data-drench]");
    expect(drenched, "no drenched element rendered, so this asserts nothing").not.toBeNull();
    // `closest` is the actual question: not "do both exist" but "is one inside the other". A
    // portalled panel would still be found by the query above and would still fail here, which is
    // the whole point -- it is the containment that the redeclaration depends on.
    expect(
      drenched?.closest(`[data-shell-role="${scoped}"]`),
      `the drenched panel is outside [data-shell-role="${scoped}"], so coach.css's drench block redeclares tokens for an element it does not match`,
    ).not.toBeNull();
  });
});
