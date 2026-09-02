// @vitest-environment node

/**
 * Every `var(--r-*)` and `var(--s-*)` a surface asks for is a token that exists.
 *
 * CSS fails silently here, which is the whole reason this is a test rather than a convention: a
 * reference to an undefined custom property with no fallback makes the browser throw the entire
 * declaration away. Not a warning, not a wrong value -- the line simply does not apply, and the
 * element renders as though it were never styled.
 *
 * Both live examples were found on 2026-09-01 by reading screens against the canvas, which is not
 * a repeatable way to find them:
 *
 *  - `--r-pill` does not exist. `provenance-chip.tsx` and `admin-overview.tsx` both asked for it,
 *    so the provenance chip rendered with square corners on all sixteen console surfaces -- the
 *    one element whose whole job is to be recognised at a glance as the same marker everywhere.
 *  - `--s-7` does not exist either; the spacing scale runs 6, 8, 10. `.consumer-closed-state__mark`
 *    set `width` and `height` from it, so both were dropped and the tile collapsed to its glyph,
 *    on the lead's own screen, in the state a lead reaches by asking to be left alone.
 *
 * ## Why only the radius and spacing families
 *
 * These two are closed, numeric scales declared in `tokens.css` and nowhere else, so a name that is
 * not in the scale is unambiguously a typo. The colour roles are not checked here because they are
 * legitimately redefined inside scoped subtrees -- `coach.css` re-authors `--well` and `--band`
 * within a drenched panel -- and a great many `--*` references are set at runtime through an inline
 * `style` (`--sidebar-width`, `--active-tab-left`, `--grid-table-columns-narrow`) or come from
 * Tailwind and `next/font`. A guard that flagged those would fail on correct code, and a guard that
 * fails on correct code gets switched off, which is worse than not having one.
 *
 * ## A null result is not a clean bill of health
 *
 * The portal assertion below scans for scoped tokens stranded outside their scope. Scanning for a
 * literal `var(` inside portal spans returns **zero** across the whole repo -- and zero here does
 * not mean no defects, it means the scan was reading something other than its subject and would
 * have gone on passing forever. Every reference to the coach scale reaches it through a class
 * constant in `coach-type.ts`, so `COACH_READING_CLASS` is the reference and the literal never
 * appears at the call site. Resolving those constants turns the same scan from zero into three real
 * stranded controls.
 *
 * That is why the carrier map is asserted before the scan consumes it. A green check whose input is
 * empty is indistinguishable from a green check whose subject is clean, and the empty one is the
 * more likely of the two -- so every scan in this file states what it must have found in order to
 * be measuring anything at all, and fails on that first.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CHECKED_FAMILIES = /^--(r|s)-/;

/** Names declared anywhere in the app's own stylesheets or components. */
function declaredNames(): Set<string> {
  const names = new Set<string>();
  for (const file of sourceFiles()) {
    for (const match of readFileSync(file, "utf8").matchAll(/(--[a-z0-9-]+)\s*:/gi)) {
      names.add(match[1]);
    }
  }
  // Set through an inline `style` prop rather than a stylesheet: `style={{ "--s-7": … }}`.
  for (const file of sourceFiles()) {
    for (const match of readFileSync(file, "utf8").matchAll(/["'](--[a-z0-9-]+)["']\s*:/gi)) {
      names.add(match[1]);
    }
  }
  return names;
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(path);
    }
  };
  walk(join(ROOT, "src/components"));
  walk(join(ROOT, "src/app"));
  return out;
}

/** Comments blanked out but line numbers kept, so a reported line is the line in the file. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/**
 * Where each custom property is declared: name -> the selectors that declare it. One resolver for
 * both questions below, because they are the same question -- which scope declares this variable,
 * and does that scope reach the element that reads it. Splitting them would mean writing this
 * twice and letting the second copy drift.
 */
function declaredScopes(): Map<string, Set<string>> {
  const scopes = new Map<string, Set<string>>();
  for (const file of sourceFiles().filter((path) => path.endsWith(".css"))) {
    const source = withoutComments(readFileSync(file, "utf8"));
    const stack: string[] = [];
    let buffer = "";
    for (const character of source) {
      if (character === "{") {
        stack.push(buffer.trim());
        buffer = "";
        continue;
      }
      if (character === "}") {
        stack.pop();
        buffer = "";
        continue;
      }
      if (character !== ";") {
        buffer += character;
        continue;
      }
      const declaration = buffer.trim();
      buffer = "";
      const named = declaration.match(/^(--[a-z0-9-]+)\s*:/i);
      if (!named) continue;
      const selector = stack.filter((head) => !head.startsWith("@")).join(" ") || ":root";
      if (!scopes.has(named[1])) scopes.set(named[1], new Set());
      scopes.get(named[1])!.add(`${relative(ROOT, file)} :: ${selector}`);
    }
  }
  return scopes;
}

/** Names ever set through an inline `style` prop, which are absent by design until one is set. */
function inlineNames(): Set<string> {
  const names = new Set<string>();
  for (const file of sourceFiles()) {
    for (const match of readFileSync(file, "utf8").matchAll(/["'](--[a-z0-9-]+)["']\s*:/gi)) {
      names.add(match[1]);
    }
  }
  return names;
}

/**
 * The balanced contents of every *outermost* `var(...)` in a line, as `[name, fallback]`. A nested
 * call is a link in its parent's chain, not a reference of its own: judging
 * `var(--console-target, auto)` on its own would report the last link of a chain that is correct
 * precisely because it consults the console before it gets there.
 */
function varCalls(line: string): { name: string; fallback: string; index: number }[] {
  const out: { name: string; fallback: string; index: number }[] = [];
  let consumedTo = -1;
  for (const opening of line.matchAll(/var\(/g)) {
    if (opening.index < consumedTo) continue;
    let depth = 0;
    let cursor = opening.index;
    for (; cursor < line.length; cursor += 1) {
      if (line[cursor] === "(") depth += 1;
      else if (line[cursor] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    // An unbalanced call is a line continuation this scan cannot read, so it says nothing.
    if (depth !== 0) continue;
    const inside = line.slice(opening.index + 4, cursor);
    const comma = inside.indexOf(",");
    if (comma === -1) continue;
    const name = inside.slice(0, comma).trim();
    if (!/^--[a-z0-9-]+$/i.test(name)) continue;
    consumedTo = cursor;
    out.push({ name, fallback: inside.slice(comma + 1).trim(), index: opening.index });
  }
  return out;
}

/**
 * Keywords that take their value from the surroundings rather than naming one: `inherit`, `unset`,
 * `revert` and `currentColor`. They are never a competing definition, because whatever another
 * shell declares on an ancestor still reaches them -- which is exactly how
 * `account-security-settings.tsx` hands the admin branch `console.css`'s own `--t-body` without
 * restating a number anywhere.
 */
const DEFERRALS = new Set(["inherit", "unset", "revert", "revert-layer", "currentcolor"]);

/**
 * Keywords that mean "nothing is decided here": the initial value, which decides *not* to have a
 * rule. That is a legitimate end to a chain, but only once every scope that might decide has been
 * consulted -- `var(--coach-target, auto)` hands the admin shell no pressable floor while
 * `console.css` is sitting there naming 32px, whereas `var(--coach-target, var(--console-target,
 * auto))` reaches `auto` only for the affiliate shell, where nothing genuinely has been decided.
 */
const NOTHING_DECIDED = new Set(["auto", "none"]);

/** Every token name a fallback chain consults, outermost link first. */
function chainTokens(fallback: string): string[] {
  return [...fallback.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map(([, name]) => name);
}

/**
 * Whether a chain ever reaches a scope that covers every shell the element can render under.
 *
 * An owner is a root-declared token (the palette lane corrects it and every caller moves), a token
 * a component sets through an inline `style` (absent by design, present when it matters), or a
 * deferral keyword (the surrounding cascade owns it). A chain of nothing but scoped-only tokens
 * reaches none of them: outside those scopes every link is undefined, and the chain renders as its
 * terminator -- `auto` if it has one, nothing at all if it does not.
 */
function reachesAnOwner(fallback: string): boolean {
  for (const name of chainTokens(fallback)) {
    if (isGlobal(name) || INLINE.has(name)) return true;
  }
  return residueOf(fallback).some((piece) => DEFERRALS.has(piece.toLowerCase()));
}

/** The chain with every nested `var()` peeled away, leaving the pieces it can terminate on. */
function residueOf(fallback: string): string[] {
  let residue = fallback;
  // Peel nested calls from the inside out, keeping their own fallbacks in play.
  for (let pass = 0; pass < 8 && /var\(/.test(residue); pass += 1) {
    residue = residue.replace(/var\(\s*--[a-z0-9-]+\s*(?:,([^()]*))?\)/gi, (_, nested) => nested ?? "");
  }
  return residue.split(",").map((piece) => piece.trim()).filter(Boolean);
}

/** The hand-picked values in a fallback chain, with every nested `var()` resolved away. */
function literalsIn(fallback: string): string[] {
  const consultsAnotherToken = /var\(/.test(fallback);
  return residueOf(fallback)
    .filter((piece) => !DEFERRALS.has(piece.toLowerCase()))
    .filter((piece) => !(consultsAnotherToken && NOTHING_DECIDED.has(piece.toLowerCase())));
}

const SCOPES = declaredScopes();
const INLINE = inlineNames();

/** Declared at `:root` (or on a root element) somewhere, so every element can resolve it. */
function isGlobal(name: string): boolean {
  return [...(SCOPES.get(name) ?? [])].some((where) => /^(?::root|html|\*|body)\b/.test(where.split(" :: ")[1] ?? ""));
}

/** Declared, never at the root, and not something a component sets on an element. */
function isScopedOnly(name: string): boolean {
  return SCOPES.has(name) && !isGlobal(name) && !INLINE.has(name);
}

describe("radius and spacing tokens resolve", () => {
  const declared = declaredNames();

  it("declares the scales this test polices", () => {
    // Without this, a rename of the scale would leave every reference "undefined" and the loop
    // below reporting the whole codebase, or -- worse -- a parser change would find nothing and
    // pass while reading no declarations at all.
    expect(declared).toContain("--r-full");
    expect(declared).toContain("--r-card");
    expect(declared).toContain("--s-4");
    expect(declared).toContain("--s-12");
  });

  it("asks for no radius or spacing token that is never declared", () => {
    const dangling: string[] = [];

    for (const file of sourceFiles()) {
      const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
      for (const match of source.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(\)|,)/gi)) {
        const [, name, close] = match;
        // A fallback makes an *undeclared* reference safe: `var(--r-pill, 8px)` renders 8px, which
        // is the only failure this assertion is about. It is not safe for a declared token read
        // outside its scope -- there the fallback is a competing definition, and the test below is
        // the one that says so.
        if (close === ",") continue;
        if (!CHECKED_FAMILIES.test(name) || declared.has(name)) continue;
        dangling.push(`${relative(ROOT, file)} asks for ${name}`);
      }
    }

    expect(
      [...new Set(dangling)],
      "An undefined custom property with no fallback makes the browser drop the whole declaration, so the element renders unstyled rather than wrong. Point it at a token that exists, or give it a fallback.",
    ).toEqual([]);
  });

  /**
   * A token declared only inside a scope must be referenced without a fallback.
   *
   * The skip above waves through every `var(--x, y)`, on the reasoning that a fallback is a safety
   * net. That is true of an undeclared token and false of a declared one read outside its scope,
   * where the fallback is a second definition of the same value with nothing keeping the two in
   * step. `account-security-settings.tsx` had fourteen of them -- `--coach-*` tokens, each with its
   * own hand-picked pixel value, on a route the admin and affiliate shells also render, so for two
   * of the three roles the fallback *was* the type scale and `coach.css` never got a vote.
   *
   * `coach-type.ts:36` states the correct shape and states why: no fallback, and every caller
   * walked to confirm it renders inside `[data-shell-role="coach"]`. Outside that root the property
   * is undefined, the browser drops the declaration, and the text falls back to an inherited size
   * -- visibly wrong, which is the point. A fallback converts that loud failure into a quiet one.
   *
   * Three exemptions, each for a reference that cannot be judged from a scope:
   *
   *   - a token declared at `:root` or on `html`, where the fallback is dead weight rather than a
   *     competing value;
   *   - a token that is undeclared, which is the case the skip above was written for;
   *   - a token ever set through an inline `style` prop, such as `--active-tab-left`, which is
   *     absent by design until a component sets it and whose fallback is the resting state.
   *
   * ## What "competes" means, which is narrower than "has a fallback"
   *
   * The harm above is stated precisely and it is worth holding the rule to it: the fallback is a
   * *second definition of the same value with nothing keeping the two in step*. That is a property
   * of a hand-picked number, not of a fallback. `var(--coach-body, var(--t-body))` has a fallback
   * and nothing to drift -- the second half is the root type scale, which the palette lane owns
   * and `console.css` restates, so both halves are managed and a correction to either lands.
   *
   * The distinction matters because on a genuinely bi-lingual surface the no-fallback shape is the
   * wrong fix rather than a strict one. `coach-type.ts:36`'s reasoning turns on every caller
   * rendering inside `[data-shell-role="coach"]`, so the loud failure it wants is reachable there.
   * `/account/security` renders under all three shells by design, so dropping the fallback there
   * fails at run time rather than at build time: the browser drops the declaration and the text
   * takes whatever size it inherits. That trades this file's drift for this file's other subject,
   * the silent fails-open. Naming a root token gets both.
   *
   * So the first predicate is a fallback that resolves to a literal value. Nested `var()`
   * references are stripped before the check, so `var(--s-2)` is not read as the number two, and a
   * keyword like `auto` or `inherit` passes -- neither is a competing size, they are the absence
   * of one.
   *
   * ## The second predicate, and why the first one needed it
   *
   * A chain has to *reach an owner*: a root-declared token, a token a component sets inline, or a
   * deferral keyword that hands the question to the surrounding cascade. Two shapes get past the
   * literal test without reaching one, and they fail in opposite directions:
   *
   *   - `var(--coach-a, var(--coach-b))` -- no literal anywhere, and outside the coach shell
   *     neither link resolves, so the browser drops the declaration and the element renders
   *     unstyled. That is this file's other subject, reintroduced through its newer assertion.
   *   - `var(--coach-target, var(--console-target, auto))` -- which is what shipped on
   *     `/account/security`, and it is the more instructive one. It consults two scopes, so the
   *     `auto` exemption above waved it through; but both are scoped-only, and the route renders
   *     under three shells, so an affiliate enabling MFA got `min-height: auto` -- no pressable
   *     floor at all, on the page where that matters most.
   *
   * The lesson in the second one outlives the line. The earlier rule permitted `auto` once every
   * scope naming the role had been consulted, which measures whether the author *looked* rather
   * than whether what renders is safe -- so it passed precisely the case where someone did the
   * work and the answer was still wrong. `tokens.css` now declares `--t-target: 44px` and
   * `console.css` re-authors it as its own 32px, so the chain is two links and there is no
   * terminal keyword left to reach.
   *
   * The `auto` exemption still stands, because a chain that reaches a root token and then names
   * `auto` behind it is carrying dead weight rather than a defect. It just no longer carries the
   * judgement on its own.
   */
  it("gives no scoped token a fallback that competes with it", () => {
    const competing: string[] = [];
    for (const file of sourceFiles()) {
      const source = withoutComments(readFileSync(file, "utf8"));
      source.split("\n").forEach((line, index) => {
        for (const { name, fallback } of varCalls(line)) {
          if (!isScopedOnly(name)) continue;
          const where = `${relative(ROOT, file)}:${index + 1} reads ${name} with a fallback of \`${fallback}\`, but ${name} is declared only under ${[...SCOPES.get(name)!].join(" and ")}.`;

          // A hand-picked value in the chain is the original defect: outside the scope it is what
          // renders, and nothing keeps it in step with the token.
          const literals = literalsIn(fallback);
          if (literals.length) {
            competing.push(`${where} \`${literals.join("`, `")}\` is a value decided here, so outside that scope it renders instead of the token and no test can see the two drift apart. Name a root --t-*/--r-*/--s-* token, which each shell re-authors for itself, or a deferral keyword.`);
            continue;
          }

          // Nothing hand-picked, and still nowhere to land: every link is scoped-only, so outside
          // those scopes the chain resolves to its terminator rather than to a value. Reported
          // separately from the case above because the consequence is the opposite one -- there a
          // stale value renders, here the right value never does.
          if (!reachesAnOwner(fallback)) {
            const consulted = chainTokens(fallback);
            const ending = residueOf(fallback).pop();
            competing.push(
              `${where} ${consulted.length ? `Its fallback consults ${consulted.join(" then ")}, and every one of those is declared only inside a scope of its own, so` : "It consults nothing further, so"} ` +
                `outside all of them the chain ${ending ? `renders \`${ending}\`, which is the initial value -- the absence of a rule, reached by a shell nobody wrote a rule for` : "resolves to nothing and the browser drops the whole declaration"}. ` +
                "Consult a root --t-*/--r-*/--s-* token so the chain ends somewhere every shell can read.",
            );
          }

        }
      });
    }

    // Two `--console-*` references read from admin-only surfaces, where the declaration does cover
    // the reference and the fallback is redundant rather than wrong. Listed so a third has to be
    // argued for rather than added, and held to the staleness check below.
    //
    // `admin-money-billing-revenue.tsx` was the third and has been dropped: its fallback is
    // `var(--line)`, so once the predicate above stopped counting token-valued fallbacks it was no
    // longer a finding, and an exemption for code the rule does not reach reads as coverage it
    // does not have. It is also the shape the other two should take.
    const KNOWN = [
      "src/components/kit/app-shell.tsx",
      "src/components/workspace/live/admin-money-shell.tsx",
    ];

    expect(
      competing.filter((row) => !KNOWN.some((file) => row.startsWith(`${file}:`))),
      "A scoped token's literal fallback is a second definition, not a safety net: outside the scope it renders instead of the token, and no test can see the two drift apart. Drop the fallback so a caller outside the scope fails loudly and give that caller its own scope -- or, on a surface that genuinely renders under more than one shell, name a root --t-*/--r-*/--s-* token so both halves are managed.",
    ).toEqual([]);

    expect(
      KNOWN.filter((file) => !competing.some((row) => row.startsWith(`${file}:`))),
      "A file listed here no longer has a scoped-token fallback, so the entry describes code that does not exist. Delete the line rather than leaving a list that reads as coverage.",
    ).toEqual([]);
  });

  /**
   * The same question with the fallback taken away: a portalled subtree cannot resolve a scoped
   * token at all.
   *
   * Radix and Base UI mount `DialogContent`, `AlertDialogContent`, `SheetContent` and the menu and
   * popover contents to `document.body`, so whatever `[data-shell-role]` an ancestor stamps, the
   * portal is not inside it. Custom properties inherit through the DOM tree, not through the React
   * tree, so `var(--coach-body)` in there is undefined, the browser drops the whole declaration,
   * and the control renders at whatever size it inherits from `body`. A stylesheet does not have
   * this problem -- a `<style>` is global wherever it sits, so unscoped *selectors* still reach the
   * portal even though *variables* do not, which is why this fails for the type scale and not for
   * the face around it. `app-shell.tsx:344` reasons the whole thing out for the fleet card and
   * spends a fallback deliberately; `coach-measurement.tsx:974` takes the other correct route and
   * mounts a `CoachScale` inside the portal.
   *
   * A reference does not have to be a literal `var()` at the call site. `coach-type.ts` exports the
   * scale as class constants -- `COACH_READING_CLASS` is `text-[length:var(--coach-body)]` -- so an
   * identifier is a reference too, and it is the shape that actually shipped: three controls in
   * `coach-contacts.tsx`'s merge dialog wear it inside an `AlertDialogContent` with no scale in the
   * portal, so their type is inherited rather than 16px.
   *
   * Only portals are judged here, and that is a deliberate limit rather than an oversight. Whether
   * a *non*-portalled component renders inside its scope depends on which routes reach it, which
   * needs an import graph and is a different guard; a portal escapes the scope structurally, from
   * evidence in one file, whatever its ancestors do.
   */
  it("asks for no scoped token inside a portal that cannot resolve it", () => {
    // The Radix and Base UI content components that mount outside the React tree's DOM position.
    const PORTALLED =
      /<(DialogContent|AlertDialogContent|SheetContent|DrawerContent|DropdownMenuContent|PopoverContent|TooltipContent|SelectContent|MenubarContent|HoverCardContent|CommandDialog)\b/g;

    // Constants whose value carries a scoped token, so an identifier counts as a reference.
    const carriers = new Map<string, string[]>();
    for (const file of sourceFiles()) {
      const source = withoutComments(readFileSync(file, "utf8"));
      for (const match of source.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*([\s\S]{0,600}?);\n/g)) {
        const carried = [...match[2].matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g)].map(([, name]) => name).filter(isScopedOnly);
        if (carried.length) carriers.set(match[1], [...new Set(carried)]);
      }
    }
    // Without this the scan below silently judges nothing: every reference in this codebase reaches
    // the scale through one of these names rather than through a literal `var()` in the JSX.
    // `toContain` on `undefined` throws about its arguments before it prints an explanation, and
    // `undefined` is exactly the case this assertion exists for -- so establish it exists first.
    expect(
      carriers.get("COACH_READING_CLASS"),
      "coach-type.ts's class constants are no longer parsed as carriers, so this scan judges nothing: every reference to the coach scale reaches it through one of those names rather than through a literal var() in JSX.",
    ).toBeDefined();
    expect(carriers.get("COACH_READING_CLASS")).toContain("--coach-body");

    const stranded: string[] = [];
    for (const file of sourceFiles().filter((path) => path.endsWith(".tsx"))) {
      const source = withoutComments(readFileSync(file, "utf8"));
      for (const opening of source.matchAll(PORTALLED)) {
        const tag = opening[1];
        const closing = source.indexOf(`</${tag}>`, opening.index);
        const span = source.slice(opening.index, closing === -1 ? source.length : closing);
        // A scale mounted inside the portal is the fix, not an exception to the rule.
        if (/CoachScale|data-shell-role=/.test(span)) continue;

        const report = (name: string, offset: number, how: string) => {
          const line = source.slice(0, opening.index + offset).split("\n").length;
          stranded.push(
            `${relative(ROOT, file)}:${line} reads ${name}${how} inside a <${tag}>, which mounts to document.body. ` +
              `${name} is declared only under ${[...SCOPES.get(name)!].join(" and ")}, so the property is undefined there ` +
              `and the browser drops the declaration. Mount a CoachScale inside the portal.`,
          );
        };

        for (const match of span.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/g)) {
          if (isScopedOnly(match[1])) report(match[1], match.index, "");
        }
        for (const match of span.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)) {
          for (const name of carriers.get(match[1]) ?? []) report(name, match.index, ` through ${match[1]}`);
        }
      }
    }

    // Empty, and it should stay that way. The merge dialog's three controls were the whole of this
    // defect in the tree and the fix landed with this line: `coach-contacts.tsx` now mounts a
    // `CoachScale` inside its `AlertDialogContent`. A new entry here is a regression being written
    // down rather than fixed, so add one only to stage a fix that is genuinely arriving.
    const KNOWN_STRANDED: string[] = [];

    expect(
      stranded.filter((row) => !KNOWN_STRANDED.some((file) => row.startsWith(`${file}:`))),
      "A custom property inherits down the DOM, and a portal is not under the element that stamps the scope. Wrap the portal's content in a CoachScale, or give the control a token that is declared at the root.",
    ).toEqual([]);

    expect(
      KNOWN_STRANDED.filter((file) => !stranded.some((row) => row.startsWith(`${file}:`))),
      "A file listed here no longer strands a scoped token in a portal. Delete the line with the fix rather than leaving a list that reads as coverage.",
    ).toEqual([]);
  });
});
