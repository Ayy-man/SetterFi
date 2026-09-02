// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { coachOnlyModules } from "@/lib/testing/coach-density";

/**
 * No coach-density surface mounts the console's page head.
 *
 * `PageHeader` sets its title with `.t-page-title`, and that token is redeclared to 30px only under
 * `[data-shell-role="admin"]`, so on any other shell it resolves to 20px. The canvas draws every
 * coach page at `--coach-page-title`, 46px, and that size is not decoration: it is the first thing
 * a reader over 55 sees, and it is why coach Home stopped reading as a spreadsheet. A coach page
 * that keeps the console's head is not ported however faithful the rest of it is.
 *
 * The rule was already written down twice -- in `CoachPageHead`'s docblock and in
 * `coach-support.tsx`'s local `HelpHead` -- and `/coach/integrations` wore `PageHeader` anyway for
 * the whole redesign pass, because it has no artboard and the redesign reached as far as the
 * drawings did. Two components documenting a rule is not the same as anything enforcing it.
 *
 * **What this cannot see, stated so nobody trusts it further than its evidence.** It catches one
 * thing: a coach-density module importing `PageHeader`. It does not check that a page renders any
 * head at all, that the head it renders is the right one for its surface, or that a hand-rolled
 * `<h1>` carries `coach-page-title` -- `coach-support.tsx` legitimately hand-rolls its own head and
 * would pass this file whatever size it used. A head that is wrong for some other reason is outside
 * this guard, and the type-floor guard next door is what holds the sizes themselves.
 *
 * The subject is coach *density*, not the coach directory, and the walk that decides it is shared
 * with `coach-type-floor.test.ts` rather than reimplemented. A directory would have missed
 * `/account/security`, which renders under the coach shell from a fourth workspace group, and every
 * onboarding page, which stands on `OnboardingStage`. Modules the admin routes also reach are
 * excluded by that walk, because a shared module cannot be held to a coach-only rule.
 */

const CONSOLE_HEAD = "@/components/kit/page-header";

/**
 * Coach-density modules that import the console head.
 *
 * A specifier match rather than an import-graph walk on purpose: the question is which file writes
 * the import, because that file is the one a fix edits.
 */
function consoleHeadImporters() {
  return coachOnlyModules().filter((file) => {
    const source = readFileSync(resolve(process.cwd(), file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//gu, " ")
      .replace(/(?<!:)\/\/[^\n]*/gu, " ");
    return source.includes(CONSOLE_HEAD);
  });
}

describe("the coach's page head", () => {
  /*
   * The controls, and they are the point of this file rather than politeness.
   *
   * A census guard's likeliest failure is not the tree changing -- it is the walk breaking and
   * reporting an empty set as agreement. So: the walk has to find a real population, it has to
   * contain a file everyone agrees is a coach surface, and the detector has to be able to see the
   * import at all, proved against a file that really does write it. Without the third, a typo in
   * the specifier would make this file pass forever while checking nothing.
   */
  it("walks a real coach surface set and can see the import it is looking for", () => {
    const modules = coachOnlyModules();

    expect(modules.length, "the coach-density walk found nothing, so the rule below is vacuous")
      .toBeGreaterThan(20);
    expect(modules).toContain("src/components/workspace/live/coach-integrations.tsx");
    expect(modules).toContain("src/app/onboarding/sms-eligibility/page.tsx");

    // The detector, proved on a file that does import the console head. `page-header.tsx` is
    // reached by the admin routes, so it is not in the coach-only set and cannot be the control.
    const consoleSurface = readFileSync(
      resolve(process.cwd(), "src/components/workspace/live/admin-agents.tsx"),
      "utf8",
    );
    expect(consoleSurface, "the console surface no longer imports PageHeader by this specifier")
      .toContain(CONSOLE_HEAD);
  });

  it("is never the console's, on any surface the coach shell renders", () => {
    expect(
      consoleHeadImporters(),
      "PageHeader's title is 20px off the admin shell; use CoachPageHead from @/components/workspace/live/coach-page-head",
    ).toEqual([]);
  });
});
