import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Curly quotes belong in copy as the characters themselves.
 *
 * On 2026-09-02 the Audit page's subtitle read the literal text `&ldquo;why did the agent say
 * that&rdquo;`, and a second sentence on Channel health did the same. Both had the entity inside a
 * quoted prop value (`body="... &ldquo;connected&rdquo; ..."`). JSX decodes an entity only in JSX
 * text; inside a string prop it is a string, and React prints it letter for letter. The Unicode
 * escape has the mirror-image trap: `“` works in a JavaScript string but a JSX attribute
 * string is raw text, so `description="“why”"` prints the backslash.
 *
 * The typed character is right in both places, which is why the rule is "write the character"
 * rather than "pick the right escape for the context". `src/app/em-dash.test.ts` polices the one
 * typographic character copy may not use; this file polices the two spellings that can never
 * render, wherever a string sits behind a quote.
 *
 * The scan is a grep, not a parse, and is honest about its shape: an entity counts when a quote
 * opens before it on the same line with no tag boundary (`<`, `>`) between them, so `&rsquo;` in
 * JSX text after a `className="..."` attribute does not fire. The escape counts only when it sits
 * directly inside an attribute value (`name="..."`, no space around the `=`), which is the one
 * place it cannot work; `note: "“..."` in an object literal renders correctly and is left
 * alone.
 */

const SRC = new URL("../", import.meta.url).pathname;

const ENTITY_IN_STRING = /["'][^"'<>]*&(?:ldquo|rdquo|lsquo|rsquo);/u;
const ESCAPE_IN_ATTRIBUTE = /[\w-]="[^"]*\\u\{?201[89cd]\}?/u;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/u.test(name) && !/\.test\.tsx?$/u.test(name)) out.push(path);
  }
  return out;
}

function hits(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line, index) =>
      ENTITY_IN_STRING.test(line) || ESCAPE_IN_ATTRIBUTE.test(line)
        ? [`${path.slice(SRC.length)}:${index + 1}: ${line.trim()}`]
        : [],
    );
}

describe("curly quotes in string props", () => {
  it("are written as the character, never as an entity or an escape that cannot render", () => {
    const offenders = [...sourceFiles(join(SRC, "components")), ...sourceFiles(join(SRC, "app"))]
      .flatMap(hits);

    expect(offenders).toEqual([]);
  });

  it("fires on the two shapes that shipped and stays quiet on the ones that render", () => {
    expect(ENTITY_IN_STRING.test(`body="because &ldquo;connected&rdquo; for one"`)).toBe(true);
    expect(ENTITY_IN_STRING.test(`const copy = "a coach&rsquo;s card";`)).toBe(true);
    expect(ESCAPE_IN_ATTRIBUTE.test(`description="because \\u201cwhy\\u201d always"`)).toBe(true);

    expect(ENTITY_IN_STRING.test(`<span className="min-w-0">a lead said &ldquo;{label}&rdquo;.</span>`)).toBe(false);
    expect(ENTITY_IN_STRING.test(`Never paste a coach&rsquo;s card details`)).toBe(false);
    expect(ESCAPE_IN_ATTRIBUTE.test(`note: "The block keeps the promise \\u201cnever\\u201d after",`)).toBe(false);
    expect(ESCAPE_IN_ATTRIBUTE.test(`const copy = "\\u201cwhy\\u201d";`)).toBe(false);
  });
});
