// @vitest-environment node

import { readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Raised from 2,500 for the pass-2 token expansion (brand palette, data + type-role
// + density tokens). Decided 2026-08-30.
const APP_CSS_BUDGET = 3_000;
const APP_DIRECTORY = resolve(process.cwd(), "src/app");
/*
 * `onboarding/onboarding.css` was removed from this list on 2026-09-01, and from the tree with it.
 *
 * It was 2,620 lines defining a complete second palette -- `--ob-bg: #0b1020`, `--ob-blue:
 * #2c64f0`, its own ink and line ramps -- and it was imported by nothing: `grep` for a `.css`
 * import across `src/app` and `src/components` did not name it, so every `.onboarding-*` class
 * that referenced it had been rendering unstyled. Its only consumer in markup was
 * `components/onboarding/assembly-canvas.tsx`, itself imported by nothing, and that file's only
 * consumer was `check-pop.tsx`. All three went together when onboarding was ported onto the coach
 * language, which is where those screens' faces come from now.
 */
const DEFERRED_STYLESHEETS = [
  resolve(APP_DIRECTORY, "consumer/consumer.css"),
  // The coach surface language, scoped to [data-shell-role="coach"] and loaded only by the coach
  // route group's layout. Deferred for the same reason as the two above: it is one surface's
  // language rather than the app's, so it is counted and printed but not charged to the app
  // budget the shared stylesheets share.
  resolve(APP_DIRECTORY, "(workspace)/coach/coach.css"),
  // The owner console's language, scoped to [data-shell-role="admin"] and loaded only by the
  // admin route group's layout. It is the other half of the density split coach.css opens: same
  // deck-panel anatomy, 13.5px body against 16px, 30px titles against 46px. Deferred for the same
  // reason -- one surface's language rather than the app's.
  resolve(APP_DIRECTORY, "(workspace)/admin/console.css"),
] as const;

function lineCount(source: string) {
  if (source.length === 0) return 0;
  const lines = source.split(/\r?\n/u).length;
  return source.endsWith("\n") ? lines - 1 : lines;
}

describe("app CSS budget", () => {
  it("keeps the top-level app stylesheets below 3,000 lines", () => {
    const stylesheets = readdirSync(APP_DIRECTORY, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
      .map((entry) => ({
        file: entry.name,
        lines: lineCount(readFileSync(resolve(APP_DIRECTORY, entry.name), "utf8")),
      }));

    const totalLines = stylesheets.reduce((total, stylesheet) => total + stylesheet.lines, 0);

    expect(totalLines, JSON.stringify(stylesheets)).toBeLessThan(APP_CSS_BUDGET);
  });

  it("prints the deferred route stylesheet counts without applying the app budget", () => {
    const diagnostics = DEFERRED_STYLESHEETS.map((stylesheet) => ({
      file: basename(stylesheet),
      lines: lineCount(readFileSync(stylesheet, "utf8")),
    }));

    console.info(`Deferred CSS diagnostics: ${diagnostics
      .map(({ file, lines }) => `${file}=${lines} lines`)
      .join(", ")}`);
  });
});
