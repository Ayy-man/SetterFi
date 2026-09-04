import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `--accent-fill` is a gradient, and a gradient is an image, not a colour.
 *
 * Tailwind v4 compiles `bg-[var(--accent-fill)]` to `background-color: var(--accent-fill)`, and a
 * `background-color` whose value resolves to `linear-gradient(...)` is invalid at computed-value
 * time, so the browser drops it and the element paints no background at all. On the dark palette
 * that went unnoticed: `--on-accent` is near-white and the card behind it is near-black, so the
 * label was still readable, just unfilled. On the light palette the same near-white label sits on
 * a near-white card, and on production on 2026-09-02 the Help page's "Send reply" and the floating
 * "Get help" launcher measured `lab(98.8)` text on a transparent ground -- invisible.
 *
 * The spellings that work are `[background:var(--accent-fill)]`, which is what `button-class.ts`
 * writes for the kit's primary, and `bg-[image:var(--accent-fill)]`, which is what `field.tsx`
 * writes for the toggle. This test forbids the colour spelling everywhere under `src/`; the last
 * eight carriers were swept on 2026-09-03, so there is no debt list left to work down.
 *
 * `coach.css` is not scanned here: its drench rule matches the literal class text
 * `[background:var(--accent-fill)]` in an attribute selector, and `coach-drench-controls.test.ts`
 * pins that selector to the class `coach-agent-preview.tsx` actually writes, so renaming the
 * spelling on either side fails there rather than silently un-styling the button.
 */
const COLOUR_SPELLING = /bg-\[var\(--accent-fill\)\]/;

function blankComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match) => match.replace(/[^\n]/g, " "));
}

function sourceFiles() {
  const out: { rel: string; path: string }[] = [];
  const root = join(process.cwd(), "src");
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push({ rel: path.slice(root.length + 1), path });
      }
    }
  };
  walk(root);
  return out;
}

describe("the accent fill is painted as a background, never as a background-color", () => {
  const offenders = sourceFiles()
    .filter(({ path }) => COLOUR_SPELLING.test(blankComments(readFileSync(path, "utf8"))))
    .map(({ rel }) => rel);

  /*
   * The two carriers this test was written for were the Help page's "Send reply" and the support
   * launcher, because those are the two that measured invisible on production on 2026-09-02.
   *
   * The Help page no longer carries one. The 2026-09-04 rebuild reduced it to the guides list and
   * a read-only record, so the page has no verb left to spend a fill on, and re-adding one to keep
   * a positive control would be the guard editing the product. The row moves to the coach's
   * Settings Save instead, which is the fill that surface does spend, and the launcher's row stays
   * where it is: the bubble now spends its fill on Send rather than on the launcher, which is the
   * same file and the same spelling.
   */
  it("paints the coach's live actions with a spelling that renders", () => {
    for (const rel of [
      "components/workspace/rehaul/coach-settings-notifications.tsx",
      "components/workspace/live/coach-support-bubble.tsx",
    ]) {
      const source = blankComments(readFileSync(join(process.cwd(), "src", rel), "utf8"));
      expect(source, `${rel} still paints the fill as a background-color`).not.toMatch(COLOUR_SPELLING);
      expect(source, `${rel} lost its accent fill altogether`).toContain("[background:var(--accent-fill)]");
    }
  });

  it("has no background-color spelling of the accent fill anywhere", () => {
    expect(
      offenders,
      "Write [background:var(--accent-fill)] (or bg-[image:var(--accent-fill)]): --accent-fill is a gradient and background-color cannot take one, so this element paints no ground and its --on-accent label vanishes on the light palette.",
    ).toEqual([]);
  });
});
