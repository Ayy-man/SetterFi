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
   * The sites this lane does not own. They are listed rather than silently excluded, and the test
   * below fails if one of them is fixed -- an exception list nobody has to maintain is one that
   * quietly grows. docs/GAPS.md names the constant they should adopt.
   */
  const NOT_YET_ADOPTED = [
    "components/workspace/live/coach-offer.tsx",
    "components/workspace/live/coach-integrations.tsx",
    "components/workspace/live/coach-measurement.tsx",
  ];

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

  it("still finds the three holdouts, so the exception list cannot go stale", () => {
    expect(NOT_YET_ADOPTED.filter((path) => hasAccentShadow(join(SRC, path))))
      .toEqual(NOT_YET_ADOPTED);
  });
});
