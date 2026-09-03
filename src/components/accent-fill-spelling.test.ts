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

  it("paints the Help page's live action and the help launcher with a spelling that renders", () => {
    for (const rel of [
      "components/workspace/live/coach-support.tsx",
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
