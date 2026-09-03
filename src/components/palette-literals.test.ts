// @vitest-environment node

/**
 * Colours written into a component instead of taken from the palette.
 *
 * `tokens.css` carries four palette blocks and every one of them can be re-solved in a single
 * commit -- which is worth nothing to a component that transcribed a value by hand. On 2026-09-01
 * `eb3bd1f` re-solved every light hairline and wash, and `impersonation-banner.tsx` did not move,
 * because it had `rgba(184, 137, 78, ...)` in its class strings: the dark `--warning-wash` hue,
 * copied in while the product was dark-only. Harmless until the banner was mounted, at which point
 * it put dark-solved amber on the light palette a viewer with no stored theme gets, and measured
 * 3.62:1 on the one control that gets an operator out of a tenant's workspace.
 *
 * The pattern generalises. `--control-fill` is `rgba(255, 255, 255, 0.04)` in the dark blocks and
 * `rgba(28, 42, 82, 0.035)` in the light ones, so a component that hard-codes the white version
 * draws a white film on a near-white card -- a control that simply is not there in the default
 * theme. Twelve components had done exactly that.
 *
 * ## What is legitimately a literal
 *
 * Two things, and both are about a ground that does not follow the theme:
 *
 *  - **Drenched panels.** `--coach-drench-live` and `--coach-drench-info` are dark in every theme,
 *    so white at a low alpha over one of them is correct in both and a token would be wrong.
 *  - **The specular highlight on a filled accent button.** `0 1px 0 rgba(255,255,255,.25) inset` is
 *    a lighting effect on a saturated fill, not a surface colour.
 *
 * Everything else is a bug waiting for a theme to change. New violations fail here. The ones that
 * already existed are listed in DEBT with the token each should take, so this lands green and each
 * lane deletes its own rows as it fixes them -- a list that only shrinks.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** Dark-era literals: white films, the periwinkle hairline, and the dark warning family. */
const DARK_ERA =
  /rgba\(\s*255,\s*255,\s*255\s*,|rgba\(\s*120,\s*150,\s*200\s*,|rgba\(\s*143,\s*170,\s*220\s*,|rgba\(\s*184,\s*137,\s*78\s*,/;

/** A specular highlight on a filled button reads as light, not as a surface. */
const SPECULAR = /\[?box-shadow|shadow-\[/;

/**
 * Files whose literals sit on a drenched panel, which is dark under every theme.
 *
 * The three stylesheets are here for a stronger reason than the components: each declares a block
 * of scoped overrides *inside* a drenched subtree -- `--well`, `--band`, `--control-fill` and the
 * rest re-authored as white alphas because the subtree brings its own dark ground in both
 * palettes. Those are the one place a white alpha is the correct value for a token, and
 * `coach.css` says so above the block.
 */
const OVER_DRENCH = new Set([
  // Both literals sit inside PANEL_DARK_CLASS, the dashboard's drenched panel: the same
  // oklch(0.30 0.07 262) -> oklch(0.19 0.045 262) gradient the drench tokens carry, dark under
  // every theme, so a white alpha is the correct value and a page-palette token would be wrong.
  "workspace/rehaul/coach-dashboard.tsx",
  // The `overview-pulse` section is the one drenched surface that screen is allowed, and the
  // hairline at :554 divides two columns inside it -- dark ground in both palettes.
  "workspace/rehaul/owner-overview.tsx",
  "marketing/landing-page.tsx",
  "workspace/live/coach-tips.tsx",
  "onboarding/coach-onboarding.tsx",
  "onboarding/setup-steps.tsx",
  "(workspace)/coach/coach.css",
  "(workspace)/admin/console.css",
  "consumer/consumer.css",
]);

/**
 * Known violations, each with the token it should take. Delete a row when you fix it; never add
 * one. Every entry here renders a dark-palette colour on the light palette a browser shows by
 * default, so each is a real defect and not a style preference.
 */
const DEBT: Record<string, string> = {
  "workspace/live/coach-integrations.tsx": "--control-fill",
  "workspace/live/account-security-settings.tsx": "--control-fill",
  "kit/meter.tsx": "--line",
};

/**
 * Comments blanked, line count preserved.
 *
 * A comment naming the problem is how a fix gets explained, not an instance of it, and the first
 * cut of this filter skipped only lines *starting* with `*` or `//`. It then flagged
 * `get-started-checklist.tsx:490` -- a continuation line inside a block comment, saying that
 * `.surface-strip` is written in dark literals and that is why the panel takes the token-driven
 * variant instead. A guard that fails on the note explaining the bug teaches people to delete the
 * note.
 */
function blankComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match) =>
    match.replace(/[^\n]/g, " "),
  );
}

/**
 * Every component, plus the stylesheets under `src/app`.
 *
 * The stylesheets matter as much as the components and were missed by the first cut: `globals.css`
 * defines `.surface-strip` in dark literals, which is a shared class every surface can reach, and
 * no amount of re-solving `tokens.css` touches it. `tokens.css` itself is the palette and is
 * excluded -- it is where these values are supposed to live.
 */
function sourceFiles() {
  const out: { rel: string; path: string }[] = [];

  const walk = (dir: string, root: string, keep: RegExp) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, root, keep);
      else if (keep.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push({ rel: path.slice(root.length + 1), path });
      }
    }
  };

  const components = join(process.cwd(), "src/components");
  walk(components, components, /\.(tsx?|css)$/);

  const app = join(process.cwd(), "src/app");
  walk(app, app, /\.css$/);

  return out.filter(({ rel }) => rel !== "tokens.css");
}

describe("components take their colours from the palette", () => {
  const offenders = sourceFiles()
    .map(({ rel, path }) => ({
      rel,
      lines: blankComments(readFileSync(path, "utf8"))
        .split("\n")
        .map((text, index) => ({ text, line: index + 1 }))
        .filter(({ text }) => DARK_ERA.test(text))
        .filter(({ text }) => !SPECULAR.test(text)),
    }))
    .filter(({ lines }) => lines.length > 0)
    .filter(({ rel }) => !OVER_DRENCH.has(rel));

  it("adds no new hard-coded palette colour", () => {
    const unexpected = offenders
      .filter(({ rel }) => !(rel in DEBT))
      .map(({ rel, lines }) => `${rel}:${lines.map(({ line }) => line).join(",")}`);

    expect(
      unexpected,
      `These render a dark-palette colour that the light palette cannot reach, so re-solving tokens.css leaves them behind. Take the value from a token instead -- --control-fill for a secondary control's face, --line for a hairline. If it sits on a drenched panel, add the file to OVER_DRENCH and say so.`,
    ).toEqual([]);
  });

  it.each(Object.entries(DEBT))("still has %s to move onto %s", (rel) => {
    // Fails when the debt is paid, which is the signal to delete the row rather than leave a
    // list that describes a repo nobody has any more. A stale allow-list is how the last three
    // of these survived being read.
    expect(
      offenders.map((offender) => offender.rel),
      `${rel} no longer hard-codes a palette colour -- delete its row from DEBT.`,
    ).toContain(rel);
  });
});
