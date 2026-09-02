import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The no-em-dash rule for UI copy, as a test rather than a round-3 note.
 *
 * `docs/DESIGN.md` ends its Don't list with "Don't write an em dash in UI copy. Commas, colons,
 * semicolons, periods, or parentheses." Nothing enforced it, and by 2026-08-31 there were about
 * fifty-five of them across `src/components`, several of them in strings a coach reads.
 *
 * **The scan covers comments as well as copy, and that is on purpose.** A guard that had to tell a
 * string literal from a JSDoc block would need to parse TypeScript, and the version that tried
 * would be the version somebody quietly widens the day it is inconvenient. Banning the character
 * outright in this directory is a rule that can be checked by reading one line, and a comment
 * written with a colon instead is not worse.
 *
 * ## The one thing it does not ban, and why
 *
 * The **em-rule** is a different object from the em dash, and this system spends it deliberately:
 * `docs/DESIGN.md` (Tables, absence rule) says that outside a data-table cell a value with
 * nothing to report "renders an em-rule in `--faint` with an honest label beside it", and
 * `kit/atomics/status.tsx` implements exactly that in `StatusAbsent`; inside a cell the same
 * absence is a quiet phrase through `CellQuiet`, which throws on the glyph. Three further sites keep the character for the same reason in reverse: the
 * `FORBIDDEN_ABSENT_LABELS` set in `columns.ts` lists it as a label a column may not use, two
 * copy-sanitisers strip it out of generated operator text, and four tests assert it is absent from
 * a rendered table.
 *
 * A blanket ban on U+2014 would have deleted a documented design token and the three guards that
 * police it, which is why this test permits the glyph standing alone -- quoted, backticked, or as
 * the whole of a JSX text node -- and bans it everywhere else. The distinction is exactly the one
 * the rule is about: `"—"` is a mark meaning "nothing here", while `a — b` is punctuation.
 */

const SRC = new URL("../", import.meta.url).pathname;
const EM_DASH = "—";

/**
 * The em-rule standing alone: `"—"`, `'—'`, `` `—` ``, or `>—<` in JSX. Anything else the
 * character can appear in is punctuation inside a sentence, which is what the rule forbids.
 */
const EM_RULE_GLYPH = new RegExp(`(["'\`]${EM_DASH}["'\`]|>${EM_DASH}<)`, "gu");

/**
 * Every other way to spell the same character.
 *
 * A grep for the literal is only as good as the assumption that nobody writes the escape, and that
 * assumption has no backing: `\u2014` in a string renders an em dash exactly like the literal does,
 * and so do the two HTML entities in JSX. Scanning for the literal alone would have left a hole
 * wide enough to reintroduce the whole sweep one file at a time.
 *
 * Decoding first rather than banning the escapes outright is deliberate. Three tests legitimately
 * name the character in order to assert it is *absent* from rendered copy, and they reach it
 * through an escape because a bare `—` inside a regex alternation is hard to see. Decoding holds
 * every spelling to one rule -- standing alone in a quoted value is the absent mark, spliced into
 * a sentence is punctuation -- instead of giving the escape a different answer from the literal.
 */
const ESCAPED_FORMS = /\\u\{?2014\}?|&mdash;|&#8212;|&#x2014;/giu;

function decodeEmDashes(source: string): string {
  return source.replace(ESCAPED_FORMS, EM_DASH);
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/u.test(name)) out.push(path);
  }
  return out;
}

/** File and line, so a failure names the sentence to rewrite rather than only the file. */
function punctuationHits(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line, index) =>
      decodeEmDashes(line).replace(EM_RULE_GLYPH, "").includes(EM_DASH)
        ? [`${path.slice(SRC.length)}:${index + 1}: ${line.trim()}`]
        : [],
    );
}

describe("the no-em-dash rule", () => {
  it("is kept in every component: copy, JSX and comments alike", () => {
    const offenders = sourceFiles(join(SRC, "components")).flatMap(punctuationHits);

    expect(offenders).toEqual([]);
  });

  /**
   * The carve-out has to stay narrow or it is not a carve-out. `StatusAbsent` is the one component
   * that renders the em-rule, and it is the reason the rule above is written as "standing alone"
   * rather than "not at all" -- so if it ever stops rendering one, this test says so and the
   * exemption can go with it.
   */
  it("permits the em-rule only as the whole of a value, which is the absent mark", () => {
    const status = readFileSync(join(SRC, "components/kit/atomics/status.tsx"), "utf8");
    expect(status).toContain(`<span aria-hidden="true">${EM_DASH}</span>`);
    expect(punctuationHits(join(SRC, "components/kit/atomics/status.tsx"))).toEqual([]);

    // And the rule really is about the neighbouring characters, not about the file.
    expect(`value: "${EM_DASH}",`.replace(EM_RULE_GLYPH, "")).not.toContain(EM_DASH);
    expect(`a ${EM_DASH} b`.replace(EM_RULE_GLYPH, "")).toContain(EM_DASH);
  });

  /**
   * Every spelling gets the same answer. Without this the sweep could be undone one escape at a
   * time while the guard stayed green, which is the failure mode a grep-shaped rule invites.
   */
  it("reads an escaped or entity-encoded dash exactly as it reads the literal", () => {
    const punctuation = (line: string) => decodeEmDashes(line).replace(EM_RULE_GLYPH, "").includes(EM_DASH);

    for (const spelling of ["\\u2014", "\\u{2014}", "&mdash;", "&#8212;", "&#x2014;", EM_DASH]) {
      expect(punctuation(`const copy = "Replied STOP ${spelling} nothing sends";`), spelling).toBe(true);
      expect(punctuation(`const absent = "${spelling}";`), spelling).toBe(false);
    }
  });
});

/**
 * The same rule, spelled in ASCII.
 *
 * The block above bans U+2014 in every spelling a browser renders as an em dash, and on
 * 2026-09-01 it was green while four rendered sentences shipped ` -- ` to coaches: the identical
 * punctuation typed on a keyboard that has no em-dash key. `docs/DESIGN.md` names five
 * replacements for the mark -- commas, colons, semicolons, periods, parentheses -- and a doubled
 * hyphen is not among them, so a guard that reads only the Unicode codepoint is enforcing the
 * encoding rather than the rule.
 *
 * **This half cannot scan comments, and that is the whole reason it is a separate test.** The
 * sentence you are reading uses a doubled hyphen legitimately, as do the notes explaining why the
 * artboard's footnote is not printed in `coach-agent-preview.tsx` and why the back-chip is not
 * labelled Settings in `alert-settings.tsx`. Comments are prose for engineers, not copy for
 * coaches, and holding them to a copy rule would either fail on its own docstring or push the
 * exemption into a list nobody maintains. So comments are blanked first -- to spaces, preserving
 * line numbers so a failure still names the line -- and only what is left is read.
 *
 * Tests are excluded for the same reason a comment is: `${rel} is clean -- delete its row` is a
 * message an engineer reads in a terminal. That exclusion is the one hole here, and it is narrow
 * enough to state plainly rather than pretend away.
 *
 * The pattern is the doubled hyphen with a space on both sides, which is the punctuation shape and
 * nothing else. `var(--line)`, a `--token:` declaration, and a `--noEmit` flag all fail to match
 * because none of them puts a space after the second hyphen, so the rule needs no allowlist to
 * avoid the thousands of custom properties this codebase is built on.
 */
const ASCII_EM_DASH = / -- /u;

/** Comments to spaces, line numbers intact, so the surviving text is copy and code only. */
function blankComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, (block) => block.replace(/[^\n]/gu, " "));
}

function asciiHits(path: string): string[] {
  return blankComments(readFileSync(path, "utf8"))
    .split("\n")
    .flatMap((line, index) =>
      ASCII_EM_DASH.test(line) ? [`${path.slice(SRC.length)}:${index + 1}: ${line.trim()}`] : [],
    );
}

describe("the no-em-dash rule, typed as two hyphens", () => {
  it("is kept in every component that ships copy", () => {
    const offenders = sourceFiles(join(SRC, "components"))
      .filter((path) => !/\.test\.tsx?$/u.test(path))
      .flatMap(asciiHits);

    expect(offenders).toEqual([]);
  });

  /**
   * A positive control, because the pattern above is permissive by design and a guard that cannot
   * be shown to fire is indistinguishable from one reading an empty string. It also pins the two
   * shapes that must never fire: the custom properties every stylesheet in this project is made of.
   */
  it("fires on the punctuation and not on a custom property", () => {
    expect(ASCII_EM_DASH.test(`const copy = "Replied STOP -- nothing sends";`)).toBe(true);
    expect(ASCII_EM_DASH.test(`  border: 1px solid var(--line);`)).toBe(false);
    expect(ASCII_EM_DASH.test(`  --line-soft: rgba(60, 90, 150, 0.06);`)).toBe(false);
    expect(ASCII_EM_DASH.test(`npx tsc --noEmit`)).toBe(false);
  });

  /**
   * The exemption, stated as an assertion rather than as a paragraph. If someone deletes the
   * comment-blanking, this fails on the file that documents why the blanking exists.
   */
  it("reads copy and leaves the notes that explain the rule alone", () => {
    const withComment = `/* a receipt -- the same class of claim */\nconst copy = "kept on your account";`;

    expect(blankComments(withComment).split("\n")[0]).not.toMatch(ASCII_EM_DASH);
    expect(blankComments(withComment).split("\n")).toHaveLength(2);
  });
});
