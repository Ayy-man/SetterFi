// @vitest-environment node

/**
 * A Tailwind utility cannot override a property an unlayered author stylesheet already declares on
 * the same element, whatever the specificities look like.
 *
 * `globals.css` opens with `@import "tailwindcss"`, and v4 emits every utility inside
 * `@layer utilities`. The app's own sheets -- `globals.css`'s own rules, `tokens.css`'s recipes,
 * `coach.css`, `consumer.css`, `console.css`, `meet-your-agent.css` -- are plain imports that
 * declare nothing inside a layer. **Unlayered author CSS beats any cascade layer at any
 * specificity**, so `class="surface-card p-0"` renders the card's `padding: 16px 17px` and the
 * `p-0` is simply not there. Nothing warns: the dead declaration reads exactly like a live one, in
 * the class string, in review, and in the file the author was editing.
 *
 * It cost a whole audit round on 2026-09-01, and it failed in *both* directions on one element.
 * `AuthPanel` in `auth-shell.tsx` carried five overrides on `coach-panel__header`/`__body`/`__name`
 * that never applied, which is why the sign-in title drew at `coach.css`'s 20px/500 against the
 * artboard's 28px/600 -- and the same blindness manufactured a phantom finding out of a `px-[30px]`
 * that was equally dead, so a round-5 row claimed a 10px misalignment that no screen ever showed. A
 * reader cannot tell which way the error runs without walking the cascade every time, which is how
 * it survived four audits.
 *
 * **The obvious rule -- "no Tailwind utilities on an element that carries an author class" -- is
 * wrong and would fail on correct code.** Most of the 86 sites that mix the two are fine, because
 * the utility names a property the sheet says nothing about: `coach-panel__body gap-[var(--s-5)]`
 * works precisely because `coach.css` sets `display`, `flex-direction` and `padding` on that
 * selector and never `gap`. The rule is about the *intersection of properties*, so this file
 * resolves both sides rather than pattern-matching either:
 *
 *   - the CSS side by walking each sheet's brace structure, skipping anything inside `@layer`, and
 *     attributing declarations only to the classes in the rule's rightmost compound (`.composer
 *     input` styles the input, not the composer) and only when the rule needs no other element as
 *     an ancestor (`.agent-shell .system-message > .mono` does not describe every `.mono`);
 *   - the utility side by compiling the candidate tokens through the project's own Tailwind and
 *     reading the properties it emits, so `border-[var(--line-strong)]` is known to set
 *     `border-color` rather than guessed at, and a token Tailwind does not recognise contributes
 *     nothing instead of a false alarm.
 *
 * Both premises are asserted rather than assumed. If `coach.css` is ever wrapped in
 * `@layer components` -- the systemic fix, held for its own ruling because it moves the cascade
 * under every coach and consumer surface at once -- or if Tailwind stops emitting into
 * `@layer utilities`, the premise test fails loudly instead of this file passing while measuring
 * nothing.
 *
 * **Four false-positive classes, all found by reading the output rather than trusting it.** Comment
 * prose inside a `className` expression, where an apostrophe in "the artboard's chip" reads as a
 * quote pair and names a class in passing. String literals that are comparison operands, where
 * `column.align === "right"` is a value and `.right` is a real recipe. A `max-sm:` utility against a
 * `@media (min-width: 640px)` block, which is the other half of one breakpoint. And a `className`
 * expression treated as one element when it describes a *set* of possible elements: a ternary's two
 * arms were unioned, so `tone === "before" ? "t-muted line-through" : "text-[color:var(--ink)]"`
 * reported a live colour as dead -- and a `debt` row is an instruction to delete, so that direction
 * of error breaks working code. All four are the same mistake, that a source scan reads
 * *alternatives* as *co-occurrence*.
 *
 * **Two legitimate escapes, and a debt list.** A `!` utility outranks unlayered CSS and is how
 * `coach-pillbar.tsx` deliberately wins its contests; an inline `style` outranks everything and is
 * how `AuthPanel` was fixed. Anything else that collides is listed in `KNOWN` below with what it
 * is: `deliberate` where the utility is a real fallback for a shell whose sheet does not match, and
 * `debt` where the utility is dead and the element is drawing something its author did not write.
 * The debt rows are not accepted -- they are the enumerated backlog this guard was written to stop
 * growing, each one owned by the lane that owns its file.
 *
 * **Naming a token family here: prose is safe, a `KNOWN` key is not.** Writing `--t-*` in a
 * sentence like this one is fine. Writing a wildcard into a `KNOWN` key -- or into any string in
 * this file that Tailwind's scanner can read as a class candidate -- is not, because the scanner
 * does not know a test file from a component and will happily generate a utility from it. The
 * distinction is load-bearing and invisible: both spellings look like documentation, and only one
 * of them changes the CSS the app ships. Describe the family in prose and enumerate the actual
 * members in the keys.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function filesUnder(dir: string, match: RegExp): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (match.test(entry.name)) out.push(path);
    }
  };
  walk(dir);
  return out;
}

/** The sheets that are imported plainly, so everything they declare outside a layer is unlayered. */
const SHEETS = [
  "src/app/globals.css",
  "src/app/tokens.css",
  "src/app/consumer/consumer.css",
  "src/app/(workspace)/coach/coach.css",
  "src/app/(workspace)/admin/console.css",
  "src/components/meet-your-agent.css",
];

/**
 * The classes a rule styles *on the element that carries them*. Only the rightmost compound counts,
 * and only when every ancestor compound is an attribute or a root element -- `[data-shell-role]`
 * scopes a whole shell and is worth reporting under, while a class ancestor means the rule
 * describes some elements with that class and not others.
 */
function keyClasses(selector: string): string[] {
  const compounds = selector.trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean);
  const key = compounds.pop();
  if (!key) return [];
  for (const ancestor of compounds) {
    if (!/^(?:\[[^\]]*\]|:root|html|body|\*)+$/.test(ancestor)) return [];
  }
  return Array.from(key.matchAll(/\.([a-zA-Z][\w-]*)/g), (match) => match[1]);
}

type Source = { file: string; selector: string; condition: string };

/** The `@media`/`@container` heads a rule sits under, collapsed to one comparable string. */
function conditionOf(stack: { head: string }[]): string {
  return stack
    .map((frame) => frame.head)
    .filter((head) => /^@(?:media|container|supports)\b/.test(head))
    .join(" and ")
    .replace(/\s+/g, " ")
    .trim();
}

/** class -> property -> where it is declared, for every unlayered rule in the app's own sheets. */
function unlayeredDeclarations(): Map<string, Map<string, Source>> {
  const byClass = new Map<string, Map<string, Source>>();

  for (const sheet of SHEETS) {
    const source = readFileSync(join(ROOT, sheet), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const stack: { head: string; layered: boolean }[] = [];
    let buffer = "";

    for (const character of source) {
      if (character === "{") {
        const head = buffer.trim();
        buffer = "";
        stack.push({ head, layered: /^@layer\b/.test(head) || stack.some((frame) => frame.layered) });
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
      const frame = stack[stack.length - 1];
      // A declaration only belongs to a selector; `@media`/`@container` heads carry none of their
      // own, and their contents were already visited as their own frames.
      if (!frame || frame.layered || frame.head.startsWith("@")) continue;

      const named = declaration.match(/^(-?[a-zA-Z-]+)\s*:/);
      if (!named || named[1].startsWith("--")) continue;
      const property = named[1].toLowerCase();

      for (const selector of frame.head.split(",")) {
        for (const className of keyClasses(selector)) {
          if (!byClass.has(className)) byClass.set(className, new Map());
          const properties = byClass.get(className)!;
          if (!properties.has(property)) {
            properties.set(property, { file: sheet, selector: selector.trim(), condition: conditionOf(stack.slice(0, -1)) });
          }
        }
      }
    }
  }

  return byClass;
}

/**
 * Every longhand a property actually writes, so a `padding-inline` utility is compared against a
 * `padding` shorthand rather than filed under a different name and missed.
 */
function longhands(property: string): string[] {
  const sides = ["top", "right", "bottom", "left"];
  const box = (prefix: string, which: string[]) => which.map((side) => `${prefix}-${side}`);

  if (property === "padding" || property === "margin") return box(property, sides);
  if (property === "padding-inline" || property === "margin-inline") {
    return box(property.split("-")[0], ["left", "right"]);
  }
  if (property === "padding-block" || property === "margin-block") {
    return box(property.split("-")[0], ["top", "bottom"]);
  }
  if (/^(padding|margin)-inline-(start|end)$/.test(property)) {
    const [prefix, , edge] = property.split("-");
    return [`${prefix}-${edge === "start" ? "left" : "right"}`];
  }
  if (/^(padding|margin)-block-(start|end)$/.test(property)) {
    const [prefix, , edge] = property.split("-");
    return [`${prefix}-${edge === "start" ? "top" : "bottom"}`];
  }

  const parts = ["width", "style", "color"];
  if (property === "border") return sides.flatMap((side) => box(`border-${side}`, parts));
  if (/^border-(width|style|color)$/.test(property)) {
    const part = property.split("-")[1];
    return sides.map((side) => `border-${side}-${part}`);
  }
  if (/^border-(top|right|bottom|left)$/.test(property)) return box(property, parts);
  if (/^border-(inline|block)$/.test(property)) {
    const which = property.endsWith("inline") ? ["left", "right"] : ["top", "bottom"];
    return which.flatMap((side) => box(`border-${side}`, parts));
  }
  if (property === "border-radius") {
    return ["top-left", "top-right", "bottom-right", "bottom-left"].map((corner) => `border-${corner}-radius`);
  }
  if (property === "gap") return ["row-gap", "column-gap"];
  if (property === "background") {
    return ["background-color", "background-image", "background-position", "background-size", "background-repeat"];
  }
  if (property === "flex") return ["flex-grow", "flex-shrink", "flex-basis"];
  if (property === "place-items") return ["align-items", "justify-items"];
  if (property === "inset") return sides;
  if (property === "overflow") return ["overflow-x", "overflow-y"];

  return [property];
}

/**
 * Every `className=` value in a file, as the token sets that can land on **one** element.
 *
 * A `className` expression describes a set of possible elements, not one element. `tone === "before"
 * ? "t-muted line-through" : "text-[color:var(--ink)]"` renders one arm or the other and never both,
 * so unioning them invents an element that does not exist -- and a collision reported against an
 * invented element says a live declaration is dead, which is the dangerous direction: acting on it
 * deletes a utility that was drawing. So each conditional argument contributes its literals as
 * *alternatives*, and the sets are (unconditional literals) plus one alternative at a time. Two
 * independent flags that genuinely both apply are under-reported by this, which is the direction to
 * be wrong in.
 */
function classSets(source: string): { tokens: string[]; index: number }[] {
  const out: { tokens: string[]; index: number }[] = [];

  for (const match of source.matchAll(/className=/g)) {
    const start = match.index + match[0].length;
    let raw = "";

    if (source[start] === '"' || source[start] === "'") {
      const quote = source[start];
      const end = source.indexOf(quote, start + 1);
      if (end === -1) continue;
      raw = source.slice(start + 1, end);
    } else if (source[start] === "{") {
      let depth = 0;
      let cursor = start;
      for (; cursor < source.length; cursor += 1) {
        if (source[cursor] === "{") depth += 1;
        else if (source[cursor] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      // Only the literal strings inside the expression; a value computed elsewhere is out of reach
      // of a source scan and this guard says nothing about it. Comments go first: these class
      // strings carry long explanations, and an apostrophe in "the artboard's chip" reads as a
      // quote pair, which handed one element 32 phantom collisions against a class named in prose.
      // A comparison operand is not a class: `column.align === "right"` is a value, and `.right`
      // happens to be a real recipe in `tokens.css`, which put four phantom rows on `grid-table`.
      //
      // All three exclusions, and the ternary handling below, are one mistake: a `className`
      // expression describes a *set of possible elements*, and reading it as one element unions
      // classes that never render together. The next instance of it is a class arriving through a
      // prop or a lookup table -- `cn(base, TONE[tone])` unions every value in the table onto one
      // imaginary element -- and it will not look like these, because unlike a ternary there is no
      // local syntax saying "these are alternatives". A lookup is out of reach of a source scan
      // rather than mis-parsed by it, so the fix there is to skip the expression, not to split it.
      const expression = source
        .slice(start, cursor)
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/^\s*\/\/.*$/gm, " ")
        .replace(/[=!]==?\s*["'][^"']*["']/g, " ");

      // Split on the commas of a `cn(...)`-style call, at brace/paren depth zero, so each argument
      // is judged on its own. An argument carrying `?`, `&&` or `||` is a condition: whichever of
      // its literals renders, the others do not.
      const base: string[] = [];
      const alternatives: string[][] = [];
      let nesting = 0;
      // The depth of the outer call's or array's arguments: `{cn(` and `{[` both put them two
      // brackets in, and splitting at the wrong depth files an unconditional class as an
      // alternative, which silently drops every real collision on it.
      let splitDepth = -1;
      let argument = "";
      const flush = () => {
        const literals = Array.from(argument.matchAll(/["'`]([^"'`]*)["'`]/g), (m) => m[1]);
        const conditional = /\?|&&|\|\|/.test(argument);
        for (const literal of literals) {
          const tokens = literal.split(/\s+/).filter(Boolean);
          if (!tokens.length) continue;
          if (conditional) alternatives.push(tokens);
          else base.push(...tokens);
        }
        argument = "";
      };
      for (const character of expression) {
        if ("{([".includes(character)) {
          nesting += 1;
          if (splitDepth === -1 && nesting === 2) splitDepth = 2;
        } else if ("})]".includes(character)) nesting -= 1;
        if (character === "," && nesting === (splitDepth === -1 ? 1 : splitDepth)) {
          flush();
          continue;
        }
        argument += character;
      }
      flush();

      if (base.length) out.push({ tokens: base, index: start });
      for (const arm of alternatives) out.push({ tokens: [...base, ...arm], index: start });
      continue;
    } else {
      continue;
    }

    const tokens = raw.split(/\s+/).filter(Boolean);
    if (tokens.length) out.push({ tokens, index: start });
  }

  return out;
}

type Collision = { file: string; line: number; utility: string; className: string; property: string; source: Source };

const declarations = unlayeredDeclarations();

const components = [...filesUnder(join(ROOT, "src"), /\.tsx$/)].filter((file) => !/\.test\.tsx$/.test(file));
const candidates: { file: string; line: number; tokens: string[]; styled: string[] }[] = [];

for (const file of components) {
  const source = readFileSync(file, "utf8");
  for (const { tokens, index } of classSets(source)) {
    const styled = tokens.filter((token) => declarations.has(token));
    if (!styled.length) continue;
    // A `!` utility outranks unlayered CSS, and so does anything the sheets never mention.
    const utilities = tokens.filter((token) => !declarations.has(token) && !token.includes("!"));
    if (!utilities.length) continue;
    candidates.push({
      file: relative(ROOT, file),
      line: source.slice(0, index).split("\n").length,
      tokens: utilities,
      styled,
    });
  }
}

type Emitted = { property: string; condition: string };

/**
 * What each candidate utility actually sets, according to the project's own Tailwind, and under
 * which query it sets it -- `max-sm:border-t` writes `border-top-width` only below the breakpoint.
 */
async function compileUtilities(tokens: string[]): Promise<Map<string, Emitted[]>> {
  const { compile } = await import("@tailwindcss/node");
  const compiled = await compile('@import "tailwindcss";', { base: ROOT, onDependency() {} });
  const css = compiled.build(tokens);

  const emitted = new Map<string, Emitted[]>();
  const utilities = css.slice(css.indexOf("@layer utilities"));
  const stack: { head: string }[] = [];
  let buffer = "";

  for (const character of utilities) {
    if (character === "{") {
      stack.push({ head: buffer.trim() });
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
    const frame = stack[stack.length - 1];
    if (!frame || frame.head.startsWith("@")) continue;
    const named = declaration.match(/^(-?[a-zA-Z-]+)\s*:/);
    if (!named || named[1].startsWith("--")) continue;

    const condition = conditionOf(stack.slice(0, -1));
    for (const selector of frame.head.split(",")) {
      const name = selector.trim().match(/^\.((?:\\.|[^\\:\s>+~])+)/);
      if (!name) continue;
      const token = name[1].replace(/\\/g, "");
      emitted.set(token, [...(emitted.get(token) ?? []), { property: named[1].toLowerCase(), condition }]);
    }
  }

  return emitted;
}

/**
 * Whether a rule under `left` and a rule under `right` can ever apply to the same element at the
 * same moment. One side unconditional means yes; two different queries mean this guard cannot tell,
 * and says nothing -- `max-sm:border-t` against `coach.css`'s `@media (min-width: 640px)` frame is
 * two halves of one breakpoint, and reporting it would be a red guard over correct code.
 */
function conditionsOverlap(left: string, right: string): boolean {
  if (!left || !right) return true;
  return left === right;
}

/**
 * Every collision that exists today. `deliberate` rows are correct as written -- the utility is the
 * value for a shell whose sheet does not match the element. `debt` rows are dead declarations: the
 * element draws the sheet's value and the utility does nothing, and each belongs to the lane that
 * owns its file.
 *
 * **A row is not a site, and the row count is the one number here that does not mean what it looks
 * like.** The key is file + class + property + utility, so every element sharing all four collapses
 * into one line, and a row can stand for one place or a dozen. On the 2026-09-01 audit the nineteen
 * `debt` rows were thirty places across thirteen files, with `admin-channel-health.tsx` alone
 * holding seven sites behind a single row -- so a lane budgeting from the row count budgeted a
 * seventh of its work. Count the sites before planning against this table; `docs/GAPS.md` carries
 * the site-by-site list.
 */
const KNOWN: Record<string, "deliberate" | "debt"> = {
  // The account menu is portalled to `document.body` and stamps `data-shell-role` on itself so
  // `coach.css` can reach it (see `app-topbar.tsx`). Under the admin shell that selector does not
  // match and these three utilities are the values that draw.
  "src/components/kit/app-topbar.tsx  coach-account-menu  width  w-[calc(var(--s-12)*4)]": "deliberate",
  "src/components/kit/app-topbar.tsx  coach-account-menu  border-radius  rounded-[var(--r-card)]": "deliberate",
  "src/components/kit/app-topbar.tsx  coach-account-menu  background  bg-[var(--raised)]": "deliberate",

  // The surface recipes in `globals.css` declare their own padding and border, so a caller naming
  // either gets the recipe. Both shared decisions the callers were trying to make are now stated in
  // the sheet instead: `.surface-card.is-flush` for the panels that give their padding up, and
  // `.surface-card.is-actionable:hover` for the cards that are themselves the control. Splitting the
  // `border` shorthand into longhands was tried and does not work -- it moves the collision from
  // `border` to `border-color` and the utility still loses to the unlayered sheet. What is left here
  // is one padding override that has no ruling yet.
  "src/components/workspace/live/admin-agents.tsx  surface-card  padding  p-[13px_16px]": "debt",

  // `tokens.css` states a colour on every type recipe and a size on every one of them, so a caller
  // that names a different colour or size beside the recipe gets the recipe. `.t-faint` keeps the
  // exception tile's note faint where it was written to go accent, `.t-id` and `.t-body` keep
  // key-value's value muted where it was written as ink. The two channel-health colours that name `--body` on
  // `.t-body`, and record-sheet's `--t-body` on `.t-id`, are the same value twice over -- dead, but
  // drawing what the author meant.
  "src/components/kit/exception-tile.tsx  t-body  color  text-[var(--ink)]": "debt",
  "src/components/workspace/live/admin-channel-health.tsx  t-body  color  text-[color:var(--body)]": "debt",
  "src/components/workspace/live/admin-channel-health.tsx  t-body  color  text-[var(--body)]": "debt",
  "src/components/workspace/live/admin-channel-health.tsx  t-body  color  text-[var(--muted)]": "debt",

  // Two duplicates rather than two overrides: `.mono` already declares `font-variant-numeric:
  // tabular-nums` and console.css already declares `min-width: 0` on an admin panel, so the utility
  // is dead and the element draws the value its author asked for anyway. Filed by rule rather than
  // by file, because a twenty-sixth `mono tabular-nums` is not a new defect.
  "*  mono  font-variant-numeric  tabular-nums": "deliberate",
  "src/components/kit/deck-panel.tsx  coach-panel  min-width  min-w-0": "deliberate",

  // `tokens.css` states a weight on every type recipe, so the tile draws `.t-body`'s 400 rather
  // than the 500 written beside it.
  "src/components/kit/exception-tile.tsx  t-body  font-weight  font-medium": "debt",

  // `coach.css` zeroes the eyebrow's margin under the coach shell, which is where the offer editor
  // renders, so all three of these spacings collapse to 0.
};

describe("the unlayered sheets and the utility layer", () => {
  it("still has the cascade this file was written for", async () => {
    expect(readFileSync(join(ROOT, "src/app/globals.css"), "utf8")).toMatch(/^@import "tailwindcss";/);

    const { compile } = await import("@tailwindcss/node");
    const compiled = await compile('@import "tailwindcss";\n.probe-recipe { padding: 16px 17px; }\n', {
      base: ROOT,
      onDependency() {},
    });
    const css = compiled.build(["p-0"]);

    // Tailwind still layers its utilities, and an author rule beside them still is not layered.
    const utilities = css.indexOf("@layer utilities");
    const recipe = css.indexOf(".probe-recipe");
    expect(utilities).toBeGreaterThan(-1);
    expect(css.slice(utilities)).toMatch(/@layer utilities \{[\s\S]*\.p-0 \{/);
    expect(recipe).toBeGreaterThan(utilities);
    expect(css.slice(utilities, recipe).split("{").length - 1).toEqual(css.slice(utilities, recipe).split("}").length - 1);
  });

  it("still reads every sheet as unlayered", () => {
    // If a sheet is ever wrapped in `@layer components`, its classes stop appearing here and this
    // guard would go on passing while measuring nothing. It fails instead.
    for (const sheet of SHEETS) {
      const fromSheet = [...declarations.values()].some((properties) =>
        [...properties.values()].some((source) => source.file === sheet),
      );
      expect(fromSheet, `${sheet} contributed no unlayered class rule`).toBe(true);
    }
    expect(declarations.get("surface-card")?.has("padding")).toBe(true);
    expect(declarations.get("coach-panel__name")?.has("font-size")).toBe(true);
  });

  /**
   * The header's "prose is safe, a `KNOWN` key is not" rule, asserted instead of described.
   *
   * Tailwind's scanner reads this file the same way it reads a component, so a token family
   * abbreviated as `--t-*` inside a key is a class candidate and compiles to real CSS in the
   * shipped bundle. That is the failure that took every route to a 500 earlier in this pass, and a
   * rule that lives only in a header comment is the shape of rule that keeps not being followed.
   *
   * **What is forbidden is narrower than "an asterisk", and getting that boundary wrong is how the
   * first version of this guard passed the exact hazard it was written for.** Two asterisks in this
   * table are correct: the file field is `*` for a collision that holds under every shell, which
   * `keysFor` generates and the table already uses, and `w-[calc(var(--s-12)*4)]` multiplies inside
   * an arbitrary value. The tempting shortcut is to exempt the brackets -- and it is wrong, because
   * `--t-*` is a *token* family and a token reference lives inside brackets, so exempting them
   * exempts the failure. Probed rather than reasoned about: with the brackets skipped, a planted
   * key whose colour utility referenced the `--t-` family by wildcard went green, which is the one
   * spelling the header comment above was written to forbid. The utility is not reproduced here,
   * because writing it whole would be the hazard itself.
   *
   * So the boundary is what the asterisk is attached to, not where it sits. Multiplication follows
   * a closing paren or a digit; a wildcard follows the name characters it is truncating, and that
   * is what this refuses -- anywhere in the key, brackets included.
   */
  it("enumerates every KNOWN key rather than abbreviating one with a wildcard", () => {
    /** An asterisk that is not arithmetic: anything but a closing paren or a digit in front of it. */
    const WILDCARD = /(?<![)\d])\*/u;

    const offenders = Object.keys(KNOWN).flatMap((key) => {
      const [file, ...rest] = key.split("  ");
      // `*` alone is the documented every-file wildcard; a path that merely contains one is not.
      const fields = file === "*" ? rest : [file, ...rest];
      return fields.some((field) => WILDCARD.test(field)) ? [key] : [];
    });

    expect(
      offenders,
      "a KNOWN key abbreviates a family with a wildcard; Tailwind reads it as a class candidate and generates CSS from it. Enumerate the members.",
    ).toEqual([]);
  });

  it("lets no utility fight a property an unlayered sheet already declares", async () => {
    const emitted = await compileUtilities([...new Set(candidates.flatMap((candidate) => candidate.tokens))]);

    const collisions: Collision[] = [];
    for (const candidate of candidates) {
      for (const utility of candidate.tokens) {
        const written = emitted.get(utility) ?? [];
        if (!written.length) continue;
        for (const className of candidate.styled) {
          for (const [property, source] of declarations.get(className)!) {
            const declared = longhands(property);
            const fought = written.some(
              (one) => conditionsOverlap(one.condition, source.condition) && longhands(one.property).some((long) => declared.includes(long)),
            );
            // One row per element and utility. `.surface-card` declares `border` and
            // `.surface-card.is-open` declares `border-color`, and one dead `hover:border-` is one
            // finding whichever of the two the reader is shown.
            if (!fought) continue;
            const already = collisions.some(
              (seen) => seen.file === candidate.file && seen.line === candidate.line && seen.className === className && seen.utility === utility,
            );
            if (!already) collisions.push({ ...candidate, utility, className, property, source });
          }
        }
      }
    }

    const keysFor = (collision: Collision) => [
      `${collision.file}  ${collision.className}  ${collision.property}  ${collision.utility}`,
      `*  ${collision.className}  ${collision.property}  ${collision.utility}`,
    ];
    const unexpected = collisions.filter((collision) => !keysFor(collision).some((key) => key in KNOWN));

    // Printed as well as asserted: the assertion diff truncates, and a half-shown list of dead
    // declarations is how somebody fixes six of them and believes they are finished.
    if (unexpected.length) {
      console.error(`${unexpected.length} unlayered-cascade collisions:`);
      for (const collision of unexpected) {
        console.error(`  ${collision.file}:${collision.line}  ${collision.utility}  vs  .${collision.className} { ${collision.property} }  (${collision.source.file} :: ${collision.source.selector})`);
      }
    }

    expect(
      unexpected.map(
        (collision) =>
          `${collision.file}:${collision.line} "${collision.utility}" sets ${collision.property}, which ` +
          `${collision.source.file} already declares on ${collision.source.selector} -- the utility is in ` +
          `@layer utilities and loses. Use an inline style, a \`!\` utility, or change the sheet.`,
      ),
    ).toEqual([]);

    // The known list is a backlog, not a config: an entry that stops colliding is deleted rather
    // than left to describe code that no longer exists.
    const seen = new Set(collisions.flatMap(keysFor));
    expect(Object.keys(KNOWN).filter((key) => !seen.has(key))).toEqual([]);
  });
});
