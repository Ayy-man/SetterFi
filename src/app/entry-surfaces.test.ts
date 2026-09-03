// @vitest-environment node

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The five surfaces anyone sees before they are signed in, held to the product's own vocabulary.
 *
 * These were the last screens off the redesign, and `/` had drifted furthest: `src/app/landing.css`
 * carried a complete second palette in hardcoded hex -- `#0b1020` ground, `#2f6bff` accent,
 * `#edf1f8` ink, the pre-redesign Electric Blue ramp -- so the first page a visitor loaded was the
 * only page in the product not made of `tokens.css`. It had also outlived its own tokens: two of
 * its radii read `--sf-radius-card-raised` and `--sf-radius-chip`, names that were deleted with the
 * old design language, so every destination card had been rendering square-cornered against a
 * 14px system nobody could see it violating.
 *
 * A palette that lives in one route's stylesheet cannot be moved by a token change, which is what
 * makes this a guard rather than a note.
 */

const SRC = new URL("../", import.meta.url).pathname;

/** Every file that draws an unauthenticated surface, grouped by the page it renders. */
const ENTRY_PAGES = {
  "/": ["app/page.tsx"],
  "/access": ["app/access/page.tsx"],
  "/auth/forgot-password": [
    "app/auth/forgot-password/page.tsx",
    "app/auth/forgot-password/forgot-password-form.tsx",
  ],
  "/auth/reset-password": ["app/auth/reset-password/page.tsx"],
  "/login": ["app/login/page.tsx"],
  "/signup": ["app/signup/page.tsx", "app/signup/signup-form.tsx"],
  shell: ["components/auth/auth-shell.tsx"],
} as const;

const ENTRY_FILES = Object.values(ENTRY_PAGES).flat();

/**
 * The two shared stages, either of which satisfies the rule. `AuthStage` is `auth-shell.tsx`'s;
 * `AuthCard` is the rehaul's replacement for it, and it mounts `CoachScale` itself rather than
 * stacking a column of its own. What the guard is against is a page drawing its own stage inline,
 * which neither of these is.
 */
const STAGES = [
  /["']@\/components\/auth\/auth-shell["']/u,
  /["']@\/components\/workspace\/rehaul\/auth-card["']/u,
] as const;

/**
 * Where a route's stage is actually reached from, when that is not its own `page.tsx`. `/login`
 * and `/signup` are server components that read claims, terms and the signup catalogue and hand
 * the result to one client component; the stage belongs to that component, and pointing the guard
 * at it keeps the check on the file that would lose the stage.
 */
const STAGE_OWNER: Readonly<Record<string, string>> = {
  "/login": "components/workspace/rehaul/login-form.tsx",
  "/signup": "components/workspace/rehaul/signup-form.tsx",
};

function read(file: string) {
  return readFileSync(join(SRC, file), "utf8");
}

describe("the entry surfaces", () => {
  it("name no colour of their own: every value comes from the token contract", () => {
    const offenders = ENTRY_FILES
      .map((file) => ({ file, hits: read(file).match(/#[0-9a-fA-F]{3,8}\b/gu) }))
      .filter((entry) => entry.hits !== null)
      .map((entry) => `${entry.file}: ${entry.hits!.join(", ")}`);

    expect(offenders).toEqual([]);
  });

  /**
   * The other half of the same rule. A hex literal is the obvious form of a second palette; a
   * route-local stylesheet is the form that actually shipped, because it hides 213 lines of them
   * behind one import line.
   */
  it("load no stylesheet of their own", () => {
    const importers = ENTRY_FILES.filter((file) => /import\s+["'][^"']+\.css["']/u.test(read(file)));

    expect(importers).toEqual([]);
    expect(existsSync(join(SRC, "app/landing.css"))).toBe(false);
  });

  /**
   * The positive half, and the one that earns its place: the three tests above all pass against
   * the *pre-redesign* pages, because stock shadcn on shadcn's own variables names no hex and
   * imports no stylesheet. A `git checkout` that reverted `/access` mid-session sailed through
   * them, so a guard that only bans the old defects would have called that page finished.
   *
   * Standing on the shared stage is what actually says a surface is on the design language, and it
   * is the thing a revert takes away first.
   */
  it("all stand on the shared stage rather than each drawing their own", () => {
    const off = Object.entries(ENTRY_PAGES)
      .filter(([page]) => page !== "shell")
      // The route's own `page.tsx`, not any file in its group: `/signup` renders its stage from
      // `page.tsx` and its notices from `signup-form.tsx`, so asking whether *some* file in the
      // group reaches the shell lets the page drop the stage while the form keeps the import.
      // And the specifier is matched delimited, because a substring match accepts `auth-shellx`
      // -- the same "green while asserting nothing" shape the ledger records for the test-data
      // label guard. Both near-misses were confirmed red before this line was written this way.
      .filter(([page, files]) => {
        const entry = files.find((file) => file.endsWith("/page.tsx"));
        expect(entry, `${files[0]} has no page.tsx`).toBeDefined();
        const owner = STAGE_OWNER[page] ?? entry!;
        return !STAGES.some((stage) => stage.test(read(owner)));
      })
      .map(([page]) => page);

    expect(off).toEqual([]);
  });

  /**
   * The One Fill Rule reaches these pages through the kit or not at all. Hand-rolling
   * `--accent-fill` is how a page ends up with two fills without anyone writing `variant="primary"`
   * twice, which is the drift the 2026-08-30 craft audit found across the coach surfaces.
   */
  it("reach the accent fill through the kit rather than painting one", () => {
    const painters = ENTRY_FILES.filter((file) => read(file).includes("--accent-fill"));

    expect(painters).toEqual([]);
  });

  /**
   * The coach type floor -- `docs/SIMPLIFICATION-SPEC.md` §5, "nothing below 14px, ever" -- reaches
   * these pages too, and nothing was checking it here.
   *
   * `AuthStage` mounts `CoachScale`, so an entry surface renders under `[data-shell-role="coach"]`
   * and is held to the coach scale by construction; a coach signing in sees this type before they
   * see anything the console draws. But `coach-type-floor.test.ts` walks the modules a route under
   * `src/app/(workspace)/coach` imports, and no entry page lives there, so `auth-shell.tsx` sat
   * outside every directory that ratchet enumerates -- which is how it went back to a hardcoded
   * `text-[12px]` eyebrow, the exact literal `COACH_EYEBROW_CLASS` exists to retire, four lines
   * under a docblock asserting the size was correct.
   *
   * This scans the whole entry set rather than the one file that drifted, because the blind spot
   * is the directory boundary and every file in `ENTRY_PAGES` is on the wrong side of it -- and
   * scanning the set is what showed the eyebrow was the sixth instance, not the only one. Nine
   * more literals sat under the floor across the five other entry pages, all inside `CoachScale`,
   * all of them helper text a coach reads on the way in.
   *
   * **`FLOOR_DEBT` is empty, and the machinery stays.** The nine were recorded here rather than
   * excluded, so the assertion is an equality against a named register: paying one off failed this
   * test until its row was struck, which is what walked the register down to nothing. All nine are
   * now bound to a role constant from `coach-type.ts` -- the value each carries is that role's
   * token, never a number retyped to clear 14. Keeping the empty register rather than collapsing
   * to `toEqual([])` keeps the shape that made the debt visible, so the next drift is written down
   * in one place instead of argued about.
   */
  const FLOOR_DEBT: Record<string, number[]> = {
    // Nine rows, found 2026-09-01 alongside the `auth-shell.tsx` eyebrow, all paid off the same
    // day: app/page.tsx (13, 12, 12.5, 12), access (12), forgot-password-form (12.5, 12.5),
    // reset-password (12.5), login (12). Nothing is owed. A row here is a live defect, not a
    // permanent exemption -- if one ever needs to be, it needs a reason on the row and a name.
  };

  it("hold every entry surface to the 14px coach type floor", () => {
    const measured = ENTRY_FILES.map((file) => ({
      file,
      // Comments carry sizes as prose ("It was a 9.5px uppercase mono `Overline`"), and a docblock
      // is not something the browser renders.
      sizes: [
        ...read(file)
          .replace(/\/\*[\s\S]*?\*\//gu, " ")
          .replace(/(?<!:)\/\/[^\n]*/gu, " ")
          .matchAll(/text-\[(\d+(?:\.\d+)?)px\]|font-size:\s*(\d+(?:\.\d+)?)px/gu),
      ].map((match) => Number(match[1] ?? match[2])),
    }));

    // The positive control, and the reason this is not a filter on the property being judged: the
    // scan has to be shown finding type sizes at all, or a regex that matches nothing reports a
    // clean floor on every file and reads as coverage. Bucketing happens after the count.
    expect(
      measured.filter((entry) => entry.sizes.length > 0).map((entry) => entry.file).length,
      "the type-size scan matched nothing, so the floor below was never tested",
    ).toBeGreaterThan(0);

    const under = Object.fromEntries(
      measured
        .map((entry) => [entry.file, entry.sizes.filter((size) => size < 14)] as const)
        .filter(([, sizes]) => sizes.length > 0),
    );

    expect(
      under,
      "an entry surface's type moved under the 14px floor, or a FLOOR_DEBT row was paid off "
        + "without being struck from the register",
    ).toEqual(FLOOR_DEBT);
  });

  /**
   * `/` is a chooser, and three equal destinations mean no single action is live. `docs/DESIGN.md`
   * calls a page that spends zero the correct resting state rather than an unfinished one, and the
   * role picker is the clearest case of it in the product: filling one of the three cards would be
   * the page claiming a preference it does not have.
   */
  it("leave the role picker's fill unspent, because nothing on it is the live action", () => {
    const landing = read("app/page.tsx");

    expect(landing).not.toContain('variant="primary"');
    expect(landing).not.toContain("kitButtonClass");
  });
});
