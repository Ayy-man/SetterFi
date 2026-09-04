// @vitest-environment node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * Mono is for figures. It is not a label face.
 *
 * `docs/SIMPLIFICATION-SPEC.md` puts the monospace face on numbers in tables and nowhere else,
 * and the 2026-09-04 coach visual audit found the rule honoured nowhere in particular: "0 of 3
 * done", "of 4", "our default" seven times, "No activity yet" five times, channel codes,
 * "Decided by / The carriers", "Stage changes: Logged". Mono at 11 to 12px on prose is the worst
 * legibility case in the product, on the surface built for the readers who told us the console
 * was hard to read.
 *
 * The rule this encodes is narrow on purpose: **a mono element whose whole content is words with
 * no digit in them**. That is the shape of the defect. A unit beside a number ("day 12", "3
 * agents"), a keyboard cap, a currency code and a template that interpolates a figure are all
 * mono doing its job, and each is allowed below by name rather than by a fuzzy heuristic -- a
 * filter that guessed would either miss the defect or bury it in noise.
 *
 * Elements with element children are skipped. A mono wrapper around a figure and its unit is a
 * composition rather than a label, and the leaves inside it are judged on their own.
 */

const ROOT = process.cwd();
const SOURCE_EXTENSIONS = [".ts", ".tsx"];

/** The mono faces this product has: two Tailwind spellings, three global classes, the constants. */
const MONO = /(?:font-mono|(?:^|[\s"'`])mono(?:[\s"'`]|$)|t-mono-meta|t-mono-crumb|\bt-id\b|MONO_CLASS|MONO_VALUE_CLASS|MONO_META_CLASS)/u;

function entryFiles(directory: string): string[] {
  const absolute = resolve(ROOT, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { recursive: true, encoding: "utf8" })
    .map((entry) => resolve(absolute, entry))
    .filter((path) => statSync(path).isFile() && SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext)));
}

function resolveSpecifier(specifier: string, fromFile: string): string | null {
  const base = specifier.startsWith("@/")
    ? resolve(ROOT, "src", specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(fromFile), specifier)
      : null;
  if (!base) return null;

  for (const candidate of [
    ...SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
    SOURCE_EXTENSIONS.some((ext) => base.endsWith(ext)) ? base : null,
  ]) {
    if (candidate && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every module a route group transitively mounts, shared kit included. */
function reachable(directory: string): Set<string> {
  const seen = new Set<string>();
  const queue = entryFiles(directory);

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || /\.test\.tsx?$/u.test(file)) continue;
    seen.add(file);

    for (const match of readFileSync(file, "utf8").matchAll(/\bfrom\s+["']([^"']+)["']/gu)) {
      const resolved = resolveSpecifier(match[1], file);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }

  return seen;
}

/** The children of the JSX element opening at `start`, or null when it is self-closing. */
function children(source: string, start: number): string | null {
  const name = /^<([A-Za-z][\w.]*)/u.exec(source.slice(start))?.[1];
  if (!name) return null;

  let index = start;
  let depth = 0;
  for (; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
    else if (character === ">" && depth === 0) break;
  }
  if (source[index - 1] === "/") return null;

  const open = new RegExp(`<${name}[\\s/>]`, "gu");
  const close = new RegExp(`</${name}>`, "gu");
  let level = 1;
  let cursor = index + 1;

  while (cursor < source.length) {
    open.lastIndex = cursor;
    close.lastIndex = cursor;
    const nextOpen = open.exec(source);
    const nextClose = close.exec(source);
    if (!nextClose) return source.slice(index + 1);
    if (nextOpen && nextOpen.index < nextClose.index) {
      level += 1;
      cursor = nextOpen.index + 1;
    } else {
      level -= 1;
      if (level === 0) return source.slice(index + 1, nextClose.index);
      cursor = nextClose.index + 1;
    }
  }
  return source.slice(index + 1);
}

/**
 * Mono doing its job. Each entry is a word that only ever appears beside a figure, so a rule that
 * flagged it would be reporting the unit rather than the misuse.
 */
const FIGURE_WORDS = new Set([
  "Day",          // `DayCounter`, "Day 12"
  "Promoted ·",   // a stamp before a version figure
  "USD",          // a currency code beside an amount
  "agent",        // a rail count's unit, "3 agent"
  "agents",
  "count",
  "day",          // `Callout`, "day 4"
  "esc",          // a keyboard cap
  "in",           // "in 3 of 4"
  "⌘K",           // a keyboard cap
]);

type Finding = { file: string; text: string };

function findings(): Finding[] {
  const modules = new Set([
    ...reachable("src/app/(workspace)/coach"),
    ...reachable("src/app/onboarding"),
  ]);
  const found: Finding[] = [];

  for (const file of modules) {
    const source = readFileSync(file, "utf8")
      .replaceAll(/\/\*[\s\S]*?\*\//gu, " ")
      .replaceAll(/\{\/\*[\s\S]*?\*\/\}/gu, " ");

    for (const match of source.matchAll(
      /<[A-Za-z][\w.]*\s[^>]*?className=(\{(?:[^{}]|\{[^{}]*\})*\}|"[^"]*")/gu,
    )) {
      if (!MONO.test(match[1])) continue;

      const inner = children(source, match.index);
      // An element with element children is a composition, not a label; its leaves are judged on
      // their own pass.
      if (inner == null || /<[A-Za-z]/u.test(inner)) continue;

      const texts = [
        ...inner.split(/\{[^{}]*\}/u).map((part) => part.trim()),
        ...[...inner.matchAll(/["']([^"'\n]{2,60})["']/gu)].map((literal) => literal[1].trim()),
      ];

      for (const text of texts) {
        if (!text || !/[A-Za-z]/u.test(text)) continue;
        // A digit anywhere means the mono is carrying a figure, which is what mono is for. A
        // template hole (`of ${total}`) reads as a digit-free fragment, so those are skipped too.
        if (/\d/u.test(text) || text.includes("$") || /[<>{}=]/u.test(text)) continue;
        if (FIGURE_WORDS.has(text)) continue;
        found.push({ file: relative(ROOT, file), text });
      }
    }
  }

  return found;
}

/**
 * Mono labels that were already on a coach surface when this guard landed, by the file that owns
 * them. Every row is asserted to still be a violation, so a fix that leaves its row behind fails.
 *
 * These are screen-level: each is a word chosen by a screen, in a file belonging to that screen's
 * rebuild lane, and the fix is a face change the rebuild will make anyway. The kit-level instances
 * this guard caught were fixed rather than recorded -- `context-eye.tsx` was printing "review
 * only" in 11px mono and now prints it as a sentence.
 */
const SCREEN_DEBT: Record<string, string> = {
  "src/components/meet-your-agent.tsx":
    "Agent trace, brain, rule, source, checking the brain, and the no-availability note",
  "src/components/workspace/live/leads-surface.tsx": "contact.pipeline_stage.set",
  "src/components/workspace/rehaul/coach-agent.tsx": "our default, set by you, unknown",
  "src/components/workspace/rehaul/coach-billing.tsx": "Logged",
  "src/components/workspace/rehaul/coach-inbox.tsx": "not asked yet, not readable, not yet",
  "src/components/workspace/rehaul/onboarding-calendar.tsx": "Time zone set in Google",
  "src/components/workspace/rehaul/onboarding-sms.tsx": "carriers may refuse",
};

describe("mono carries figures on the coach surface, never labels", () => {
  it("reads the coach surface at all", () => {
    // The positive control every guard in this repo needs: a resolver change returning nothing
    // would leave the assertions below iterating an empty set and passing green.
    const modules = new Set([
      ...reachable("src/app/(workspace)/coach"),
      ...reachable("src/app/onboarding"),
    ]);

    expect(modules.size).toBeGreaterThan(80);
    expect([...modules].some((file) => file.endsWith("src/components/kit/data-table.tsx"))).toBe(true);
  });

  it("still finds mono elements to judge", () => {
    // And the second control: a scanner that matched no mono element at all would also pass.
    expect(findings().length + Object.keys(SCREEN_DEBT).length).toBeGreaterThan(5);
  });

  it("has no mono label outside the recorded screen debt", () => {
    const unexpected = [
      ...new Set(
        findings()
          .filter((finding) => !(finding.file in SCREEN_DEBT))
          .map((finding) => `${finding.file}: "${finding.text}"`),
      ),
    ].sort();

    expect(
      unexpected,
      "SIMPLIFICATION-SPEC puts mono on numbers in tables and nowhere else. These are words with "
        + "no figure in them, set in a monospace face on a coach surface. Use the sentence face, or "
        + "add the word to FIGURE_WORDS if it is genuinely a unit beside a number.",
    ).toEqual([]);
  });

  it("keeps no debt row for a file that is already clean", () => {
    const stillOffending = new Set(findings().map((finding) => finding.file));

    expect(
      Object.keys(SCREEN_DEBT).filter((file) => !stillOffending.has(file)),
      "these rows name files with no mono label left -- delete them",
    ).toEqual([]);
  });
});
