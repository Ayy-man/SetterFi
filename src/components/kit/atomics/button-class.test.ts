import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { ACCENT_FILL_SHADOW_CLASS } from "@/components/kit/atomics/button-class";

import { describe, expect, it } from "vitest";

/**
 * `kitButtonClass` is called as a plain function by server components (`/login`'s signed-in
 * branch, `/auth/reset-password`), and a function value exported from a `"use client"` module
 * cannot be invoked on the server: React throws "Attempted to call kitButtonClass() from the
 * server" at request time, so `tsc`, vitest, and `next build` all stay green while the page
 * itself is broken for exactly the visitor who reaches that branch. That is how it fired in
 * production on 2026-08-31, only for a signed-in user opening /login.
 *
 * The builder therefore lives in `button-class.ts` with no directive, and the barrel must export
 * it from there rather than through the client `button.tsx` re-export, because a re-export from a
 * client module is still a client reference.
 */
describe("kitButtonClass server safety", () => {
  it("keeps the class builder in a module a server component can call", () => {
    const source = readFileSync("src/components/kit/atomics/button-class.ts", "utf8");
    expect(source).not.toContain("use client");
    expect(source).toContain("export function kitButtonClass");
  });

  it("routes the barrel export around the client module", () => {
    const barrel = readFileSync("src/components/kit/atomics/index.ts", "utf8");
    expect(barrel).toContain(
      'export { kitButtonClass } from "@/components/kit/atomics/button-class";',
    );
    expect(barrel).not.toMatch(/export \{[^}]*kitButtonClass[^}]*\} from "@\/components\/kit\/atomics\/button"/);
  });
});

/*
 * The accent fill's shadow, in one place.
 *
 * Every primary button in the product carried `0_8px_20px_-8px_var(--accent)` -- a blur of the
 * accent itself under a button filled with the accent. Over the near-black pane the product used
 * to have, that read as the button lifting off the page. The light palette landed in `39f0cae`,
 * and on a near-white ground a blue shadow under a blue button reads as a halo, or as a print
 * registration error. It was authored for one ground and has no equivalent on the other, so the
 * colour is dropped rather than re-tuned.
 *
 * The recipe had also been retyped into seven component files, which is why the fix is a shared
 * constant rather than eight edits: the next palette move should be one line, not a grep.
 */
describe("the accent fill's shadow", () => {
  const SRC = new URL("../../../", import.meta.url).pathname;

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
      else if (/\.tsx?$/u.test(name) && !name.includes(".test.")) out.push(path);
    }
    return out;
  }

  /*
   * The sites this lane does not own, and there are none left.
   *
   * `coach-offer.tsx` and `coach-measurement.tsx` went when the rehaul took their routes, and
   * `coach-integrations.tsx` went on 2026-09-04 when `/coach/get-started` and `/coach/integrations`
   * both moved to `rehaul/coach-setup.tsx`. None of the three adopted the constant; all three were
   * deleted, which is the other way a holdout stops being one.
   *
   * The list stays declared rather than being removed with its last row, because it is where the
   * next unowned site gets written down, and the two controls under it are what keep an empty list
   * from meaning "the scan found nothing".
   */
  const NOT_YET_ADOPTED: string[] = [];

  /**
   * The surface that replaced the last holdout, asserted to have adopted rather than retyped.
   *
   * This is the half an exception list cannot carry once it is empty. `coach-setup.tsx` is the
   * coach's one remaining accent fill outside the kit, so it is exactly the file that would have
   * become the next holdout, and naming it here means a future hand-retyped shadow on it fails as
   * a broken expectation rather than as a silently-passing empty list.
   */
  const ADOPTED_COACH_FILL = "components/workspace/rehaul/coach-setup.tsx";

  const hasAccentShadow = (path: string) =>
    /shadow[^"'`]*var\(--accent\)/u.test(readFileSync(path, "utf8"));

  it("is the inset highlight alone, with no colour taken from the accent", () => {
    expect(ACCENT_FILL_SHADOW_CLASS).toContain("inset");
    expect(ACCENT_FILL_SHADOW_CLASS).not.toContain("var(--accent)");
  });

  it("is what the kit's own primary variant paints, so the kit and the coach agree", () => {
    const primary = readFileSync("src/components/kit/atomics/button-class.ts", "utf8");
    expect(primary).toContain("[box-shadow:0_1px_0_rgba(255,255,255,.25)_inset]");
    expect(primary).not.toContain("0_8px_20px_-8px_var(--accent)");
  });

  it("is not hand-retyped with the accent colour anywhere this lane owns", () => {
    const offenders = sourceFiles(SRC)
      .filter(hasAccentShadow)
      .map((path) => path.slice(SRC.length))
      .filter((path) => !NOT_YET_ADOPTED.includes(path));

    expect(offenders).toEqual([]);
  });

  it("still finds every holdout, so the exception list cannot go stale", () => {
    expect(NOT_YET_ADOPTED.filter((path) => hasAccentShadow(join(SRC, path))))
      .toEqual(NOT_YET_ADOPTED);
  });

  it("proves the detector still works, on a real file with a real accent fill", () => {
    // The positive control the empty list needs. The coach's one accent fill outside the kit
    // paints from the shared constant, so the detector must not see a hand-retyped shadow on it
    // -- and the file has to be there for that to mean anything.
    const adopted = readFileSync(join(SRC, ADOPTED_COACH_FILL), "utf8");
    expect(adopted).toContain("ACCENT_FILL_SHADOW_CLASS");
    expect(adopted).toContain("var(--accent-fill)");
    expect(hasAccentShadow(join(SRC, ADOPTED_COACH_FILL))).toBe(false);

    // And the detector is not simply always false: the pattern it looks for is the one the kit's
    // own docblock says was retyped, so a string carrying it must match.
    const retyped = "shadow-[0_1px_0_rgba(255,255,255,.25)_inset,0_8px_20px_-8px_var(--accent)]";
    expect(/shadow[^"'`]*var\(--accent\)/u.test(retyped)).toBe(true);
  });
});
