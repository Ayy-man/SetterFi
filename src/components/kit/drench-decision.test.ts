// @vitest-environment node

/**
 * Every colour inside a drench must be a colour somebody chose for a dark ground.
 *
 * A drenched panel paints its own dark gradient and it is dark in EVERY theme, so the page palette
 * behind it is the wrong palette. `tokens-contrast.test.ts` already holds the text roles to their
 * floors on that ground. This is the other half, and it deliberately asks a different question.
 *
 * NOT "is this visible enough". That is a contrast rule, and a contrast rule needs to know the
 * token's role before it can pick a floor -- a control edge or a mark must clear 1.4.11's 3:1
 * because you have to see it to use it, while a decorative hairline separating content that spacing
 * already separates is sub-threshold on purpose. `--line-soft` measures 1.090:1 on a plain card and
 * `tokens.css` says so in the token's own comment. A guard that failed on that would be failing on
 * correct code, and a guard that fails on correct code is the one somebody switches off.
 *
 * So the question is "did anyone decide what this should be on a dark ground". A token branched on
 * `drench` has an author who considered the dark case and wrote an answer. A token redeclared in
 * both drench blocks has one too -- the sheet answered for every caller at once. A token that is
 * neither has an author who considered only the light ground, and whatever it draws on the drench
 * is not a decision anybody made. **The defect is the absent decision, not the ratio**, and that is
 * answerable from the source with no judgement at all.
 *
 * WHY THE CORPUS IS THE RENDERERS AND NOT THE CALLERS. The obvious version of this guard scans the
 * `drench=` call sites, and it would be vacuous. There are six, and between them they contain zero
 * colour tokens; two are self-closing, so their contents arrive through props by construction and
 * no scan of the call site could ever see them. Enumerating that corpus before writing the guard is
 * what stopped it being written -- the elements that actually render inside a drench live in the
 * components that carry `data-drench`, where the subtree IS syntactically the children of that
 * element. That is the corpus below, and the count assertions keep it from silently emptying.
 *
 * WHAT THIS DOES NOT SEE, stated so nobody reads it as total. It matches the arbitrary-value form
 * only -- a utility naming a custom property. A stock palette utility, a raw colour written inline,
 * or a colour arriving through a variant these components do not use would all pass unexamined.
 * That is the right scope rather than a shortfall: a token is the thing a drench block can answer
 * for, so a token is the thing the two escapes are defined over. A raw colour has no decision to
 * look for, and `token-references.test.ts` is what keeps raw colours out in the first place.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/**
 * The known-unresolved rows, and this table is not an allowlist of things we accept.
 *
 * Each row is a colour drawn on a drench that nobody chose for a dark ground, kept here only
 * because the fix is not this lane's to make. A row that stops applying fails the staleness check
 * below rather than sitting on describing code that no longer exists.
 */
const KNOWN: Record<string, string> = {
  // `TitlePanel`'s divided header. Every text colour in the same class block is branched on
  // `drench` -- `drench ? "text-[color:var(--on-accent)]" : ...` a few lines below -- and this
  // border is not, so a drenched divided header draws the page palette's hairline. Measured
  // 2026-09-01 against all four gradient stops (`--console-drench-live` and `--console-drench-info`,
  // both stops of each): 1.01:1 to 1.11:1, which is invisible.
  //
  // Latent rather than live: `divided` is passed by no caller and no caller gives `TitlePanel` a
  // `drench`, so the combination does not render today. It ships silently the first time somebody
  // writes both. `deck-panel.tsx` is fenced for this wave, so it is held here rather than fixed.
  "src/components/kit/deck-panel.tsx  --line-soft": "fenced-file",
};

const COLOUR_UTILITY =
  /\b(?:bg|border|border-[trblxy]|ring|divide|from|via|to|text|shadow|outline|fill|stroke|accent|caret|decoration)-\[(?:color:)?var\((--[\w-]+)\)\]/g;

/** Every `.tsx` under `src/` that is not a test, so a new drenched component joins the corpus. */
function sourceFiles(): string[] {
  return readdirSync(resolve(ROOT, "src"), { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".tsx") && !entry.endsWith(".test.tsx"))
    .map((entry) => join("src", entry));
}

type Hit = { file: string; line: number; token: string; branched: boolean };

/**
 * The colour tokens written inside each `data-drench` element's own subtree, and whether the
 * author branched on `drench` when choosing them.
 *
 * Branching is read from the ancestors rather than from the string, because the decision is made
 * where the class is chosen: a ternary whose condition mentions `drench`, or an `&&` whose left
 * side does. That is exactly the shape `deck-panel.tsx` uses for the colours it did consider.
 */
function drenchHits(): Hit[] {
  const hits: Hit[] = [];

  for (const file of sourceFiles()) {
    const source = readFileSync(resolve(ROOT, file), "utf8");
    if (!source.includes("data-drench")) continue;
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    const roots: ts.Node[] = [];
    const findRoots = (node: ts.Node) => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        if (opening.attributes.properties.some((property) => property.name?.getText?.() === "data-drench")) {
          roots.push(node);
        }
      }
      node.forEachChild(findRoots);
    };
    findRoots(parsed);

    for (const root of roots) {
      const walk = (node: ts.Node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          for (const match of node.text.matchAll(COLOUR_UTILITY)) {
            let branched = false;
            let parent: ts.Node | undefined = node.parent;
            while (parent && parent !== root) {
              if (ts.isConditionalExpression(parent) && /\bdrench\b/.test(parent.condition.getText())) branched = true;
              if (ts.isBinaryExpression(parent) && /\bdrench\b/.test(parent.left.getText())) branched = true;
              parent = parent.parent;
            }
            hits.push({
              file,
              line: parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1,
              token: match[1],
              branched,
            });
          }
        }
        node.forEachChild(walk);
      };
      walk(root);
    }
  }

  return hits;
}

/** The custom properties a drench block redeclares, which is the sheet deciding for every caller. */
function redeclaredOnDrench(sheet: string): Set<string> {
  const css = readFileSync(resolve(ROOT, sheet), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const declared = new Set<string>();
  const marker = /\[data-shell-role="[a-z]+"\]\s+\.coach-panel\[data-drench\]\s*\{/g;

  for (const match of css.matchAll(marker)) {
    const start = (match.index ?? 0) + match[0].length;
    const end = css.indexOf("}", start);
    if (end === -1) continue;
    for (const declaration of css.slice(start, end).matchAll(/(--[\w-]+)\s*:/g)) declared.add(declaration[1]);
  }

  return declared;
}

const SHEETS = [
  "src/app/(workspace)/admin/console.css",
  "src/app/(workspace)/coach/coach.css",
] as const;

describe("a colour on a drench is a colour someone chose for a dark ground", () => {
  const hits = drenchHits();

  it("still has a corpus to judge", () => {
    // Every assertion below is over this set, so an empty or shrunken one passes vacuously. The
    // renderers are two files and three `data-drench` elements today; a rename that drops them
    // must fail here rather than turn the guard into a comment.
    const files = new Set(hits.map((hit) => hit.file));
    expect(files).toContain("src/components/kit/deck-panel.tsx");
    expect(hits.length).toBeGreaterThanOrEqual(5);
  });

  it("reads the drench blocks in both shells", () => {
    for (const sheet of SHEETS) {
      const declared = redeclaredOnDrench(sheet);
      // `--ink` is the anchor the block has always carried; if this stops matching, the selector
      // moved and every "redeclared" answer below silently became "no".
      expect(declared, `${relative(ROOT, sheet)} drench block did not parse`).toContain("--ink");
    }
  });

  it("leaves no colour on a drench that only the light ground was chosen for", () => {
    const redeclared = SHEETS.map(redeclaredOnDrench);
    const undecided = hits.filter(
      (hit) => !hit.branched && !redeclared.every((sheet) => sheet.has(hit.token)),
    );

    const offenders = undecided
      .map((hit) => ({ key: `${hit.file}  ${hit.token}`, hit }))
      .filter((entry) => !(entry.key in KNOWN))
      .map((entry) => `${entry.hit.file}:${entry.hit.line} draws ${entry.hit.token} inside a drench`);

    expect(
      offenders,
      [
        "A colour inside a drenched subtree is neither branched on `drench` nor redeclared in both",
        "drench blocks, so what it draws on the dark ground is not a decision anyone made.",
        "Branch it at the call site, or redeclare the token in console.css and coach.css.",
        ...offenders,
      ].join("\n  "),
    ).toEqual([]);
  });

  it("keeps no KNOWN row that no longer applies", () => {
    const undecided = new Set(
      hits
        .filter((hit) => !hit.branched)
        .map((hit) => `${hit.file}  ${hit.token}`),
    );
    const stale = Object.keys(KNOWN).filter((key) => !undecided.has(key));

    expect(
      stale,
      ["A KNOWN row describes a colour that is now decided. Delete the row with the fix.", ...stale].join("\n  "),
    ).toEqual([]);
  });
});
