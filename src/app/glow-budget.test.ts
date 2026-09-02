import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The No-Glow Rule, as a budget rather than a default.
 *
 * `docs/DESIGN.md:377` reads: "One glow on the page, and it belongs to the attention dot. A glow
 * anywhere else -- on a status dot, a card edge, a button at rest -- is a defect."
 * A design ruling on 2026-08-30 settled that glow must therefore be opt-in rather than keyed to
 * tone, and gave the reason: a tone-keyed default had shipped five glowing dots on one screen and
 * destroyed the signal it implements.
 *
 * The budget is **per page**, not per product. An earlier version of this file asserted a single
 * spender across the whole tree and said in its own docstring that `DESIGN.md` "allows exactly one
 * glow in the product". It does not, and that misreading had a cost worth recording: a page whose
 * attention dot legitimately deserved the halo could not ask for it, so the halo got hand-rolled
 * as a `shadow-[0_0_8px_...]` beside a `StatusDot` -- which satisfied the guard while breaking the
 * rule the guard exists to keep. A budget nobody can spend legally gets spent illegally.
 *
 * Hence the second test. Counting the `glow` prop only catches callers who declare themselves; the
 * defect this rule is actually about is a halo, however it is painted.
 */

const SRC = new URL("../", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/u.test(name) && !name.includes(".test.")) out.push(path);
  }
  return out;
}

/** `/design` renders every variant of every atomic side by side, so it is not a page. */
function pages() {
  return sourceFiles(SRC)
    .filter((path) => !path.includes("/kit/atomics/"))
    .filter((path) => !path.includes("/app/design/"));
}

describe("the glow budget", () => {
  it("is at most one glow per page, on that page's attention dot", () => {
    const overspent = pages()
      .map((path) => {
        const asks = readFileSync(path, "utf8").match(/<Status(?:Dot)?[^>]*\sglow(?:\s|>|=\{true\})/gu);
        return { count: asks?.length ?? 0, page: path.slice(SRC.length) };
      })
      .filter((entry) => entry.count > 1);

    expect(overspent).toEqual([]);
  });

  /**
   * The halo, not the prop. A blur radius is what makes a shadow a glow, so `0_0_8px_...` is one
   * and the `0_0_0_1px` hairline ring several controls use is not. Only the kit may paint one, and
   * `status.tsx` reaches it through `toneGlow` so the colour cannot drift from the tone.
   */
  it("cannot be spent by hand-rolling a halo beside the atomic", () => {
    const handRolled = pages()
      .filter((path) => /shadow-\[0_0_[1-9]\d*px/u.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(SRC.length));

    expect(handRolled).toEqual([]);
  });

  /**
   * The other half of the ruling. Opt-out is what let the budget be overspent without anyone
   * writing the word `glow`, so a dot that is not asked to glow must not glow.
   */
  it("is opt-in: a dot that does not ask for a halo does not get one", () => {
    const status = readFileSync(join(SRC, "components/kit/atomics/status.tsx"), "utf8");
    expect(status).toContain("glow === true ? toneGlow(tone) : undefined");
    expect(status).not.toContain("glow === false");
  });
});
