import "@testing-library/jest-dom/vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SkeletonRow } from "@/components/kit/skeleton";

/**
 * The row skeleton stands in for a table row that is about to arrive, so its tracks are the
 * approved `.skel-row` geometry: a 28px identity track, an 80px action track, and a 22px avatar.
 * It drew 24px, 56px and 24px, so the identity column and the action cell both moved sideways the
 * moment the real row replaced them.
 *
 * The numbers are read out of the tokens rather than restated here: the assertion is that the
 * expressions in the class list still evaluate to the approved geometry, which is what a raw px
 * literal would have made unfalsifiable.
 */
const SPACING = (() => {
  const css = readFileSync(resolve(process.cwd(), "src/app/tokens.css"), "utf8");
  const scale = new Map<string, number>();
  for (const [, name, value] of css.matchAll(/--(s-\d+):\s*(\d+)px/gu)) {
    scale.set(name, Number(value));
  }
  return scale;
})();

function token(name: string) {
  const value = SPACING.get(name);
  if (value === undefined) throw new Error(`tokens.css declares no --${name}`);
  return value;
}

describe("SkeletonRow geometry", () => {
  it("declares the approved 28px identity and 80px action tracks", () => {
    render(<SkeletonRow />);

    const row = screen.getByRole("status", { name: "Loading row" });
    const classes = row.className;

    expect(classes).toContain(
      "grid-cols-[calc(var(--s-6)+var(--s-1))_2fr_1fr_1fr_calc(var(--s-12)+var(--s-8))]",
    );
    expect(token("s-6") + token("s-1")).toBe(28);
    expect(token("s-12") + token("s-8")).toBe(80);
  });

  it("draws a 22px avatar inside the identity track", () => {
    render(<SkeletonRow />);

    const row = screen.getByRole("status", { name: "Loading row" });
    const avatar = row.firstElementChild;
    expect(avatar).not.toBeNull();
    expect(avatar?.className).toContain("size-[calc(var(--s-6)-var(--s-1)/2)]");
    expect(avatar?.className).toContain("rounded-[var(--r-full)]");
    expect(token("s-6") - token("s-1") / 2).toBe(22);
  });

  it("gives every bone in the row exactly one cell", () => {
    render(<SkeletonRow />);

    const row = screen.getByRole("status", { name: "Loading row" });
    expect(row.children).toHaveLength(5);
  });
});
