import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { coachOnlyModules, entryFiles } from "@/lib/testing/coach-density";

/*
 * The coach surface's type floor, read off the stylesheet that sets it.
 *
 * `docs/SIMPLIFICATION-SPEC.md` §5: "Body text 16px minimum. Secondary and helper text 14px
 * minimum -- nothing below it, ever." The floor is not a preference. This surface exists because
 * coaches over 55 told the client the Phase 11 console was hard to read, and every drift under it
 * so far has been a small one taken for density on a screen that is not short of room.
 *
 * `--coach-eyebrow` shipped at 12px for the whole redesign pass, which put every panel label on
 * the coach side two pixels under a floor the spec states twice. This file reads the real
 * stylesheet rather than trusting a comment in it, because a rule written where only its author
 * looks is how the 12px survived being read.
 */
const ROOT = process.cwd();

/*
 * The walk that decides what "a coach surface" means now lives in `@/lib/testing/coach-density`,
 * unchanged, because a second guard needs the same subject and a directory-scoped copy of it would
 * be the proxy this walk was written to replace. Nothing else here moved: every assertion below
 * reads exactly as it did, and the docblock above still states the rule they enforce.
 */

/** Sub-14px `text-[Npx]` and `font-size:` literals per coach-only module, comments stripped. */
function coachOnlyTypeOffenders(): Record<string, number[]> {
  const found: Record<string, number[]> = {};

  for (const file of coachOnlyModules()) {
    const source = readFileSync(resolve(ROOT, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(?<!:)\/\/[^\n]*/g, " ");
    const sizes = [...source.matchAll(/text-\[(\d+(?:\.\d+)?)px\]|font-size:\s*(\d+(?:\.\d+)?)px/g)]
      .map((match) => Number(match[1] ?? match[2]))
      .filter((size) => size < 14);
    if (sizes.length > 0) found[file] = sizes;
  }

  return found;
}

const COACH_CSS = readFileSync(
  resolve(process.cwd(), "src/app/(workspace)/coach/coach.css"),
  "utf8",
);

/** Every `--coach-*: <n>px` custom property the sheet declares, as a name-to-number map. */
function pxTokens(): Map<string, number> {
  const found = new Map<string, number>();
  for (const match of COACH_CSS.matchAll(/(--coach-[a-z-]+):\s*([0-9.]+)px\s*;/g)) {
    found.set(match[1], Number(match[2]));
  }
  return found;
}

describe("coach type floor", () => {
  it("declares the sizes this test claims to police", () => {
    // The positive control: without it, a rename of every token would leave the loop below
    // iterating over nothing and passing.
    const tokens = pxTokens();
    expect([...tokens.keys()]).toEqual(
      expect.arrayContaining(["--coach-body", "--coach-eyebrow", "--coach-panel-name"]),
    );
  });

  it("keeps every literal px type token at or above the spec's 14px floor", () => {
    // Named the other way round on purpose. This listed the four type tokens and skipped everything
    // else, so `--coach-row-name` -- added later, and a type size -- was never judged by the test
    // whose name says it judges them: a hand-maintained list of what to check omits silently, and
    // the omission looks exactly like a pass. Control heights and radii are named instead, so a new
    // type token is judged by default and a new non-type one has to be declared as such.
    const NOT_TYPE = ["--coach-target", "--coach-target-primary", "--coach-panel-radius",
      "--coach-panel-radius-hero"];

    const judged = [...pxTokens()].filter(([name]) => !NOT_TYPE.includes(name));
    expect(judged.map(([name]) => name), "the sheet declares no type tokens, so this checked nothing")
      .toEqual(expect.arrayContaining(["--coach-body", "--coach-eyebrow", "--coach-row-name"]));

    for (const [name, size] of judged) {
      expect(size, name).toBeGreaterThanOrEqual(14);
    }
  });

  it("keeps the body at 16px, which is the one line the surface was rebuilt for", () => {
    expect(pxTokens().get("--coach-body")).toBe(16);
  });

  it("sets no font-size literal under 14px anywhere in the sheet", () => {
    const literals = [...COACH_CSS.matchAll(/font-size:\s*([0-9.]+)px/g)].map((m) => Number(m[1]));
    for (const size of literals) {
      expect(size).toBeGreaterThanOrEqual(14);
    }
  });
});

/*
 * A drenched panel brings its own dark ground, so every role used inside it has to be authored
 * against that ground rather than against the page's.
 *
 * The override block got the text roles and none of the grounds, which is how a near-white chevron
 * ended up on a near-white square inside the drenched panel on Home: `.coach-panel__action` paints
 * `var(--well)` and colours itself `var(--body)`, `--body` was overridden and `--well` was not, and
 * under the light palette `--well` is near-white. About 1.02:1, on a control.
 *
 * So this does not pin the one property that broke. It reads every role the panel's own rules
 * actually reach for and requires the drench block to have re-declared each one -- which is a
 * guard that still holds when somebody adds a rule this file has never seen.
 */
describe("drenched panel grounds", () => {
  /** Roles whose value is a face or a hairline, i.e. meaningless when the ground changes. */
  const GROUND_ROLES = [
    "--well",
    "--quiet",
    "--band",
    "--row-hover",
    "--control-fill",
    "--line",
    "--line-soft",
  ];

  /** The `[data-drench]` override block, from its selector to its closing brace. */
  function drenchBlock(): string {
    const start = COACH_CSS.indexOf('[data-shell-role="coach"] .coach-panel[data-drench] {');
    expect(start, "the drench override block was not found, so nothing below was checked")
      .toBeGreaterThan(-1);
    return COACH_CSS.slice(start, COACH_CSS.indexOf("}", start));
  }

  /** Every role a `.coach-panel` rule paints with, whatever the property. */
  function rolesUsedInsideAPanel(): Set<string> {
    const used = new Set<string>();
    for (const match of COACH_CSS.matchAll(/\.coach-panel[^{]*\{([^}]*)\}/g)) {
      for (const role of match[1].matchAll(/var\((--[a-z-]+)/g)) used.add(role[1]);
    }
    return used;
  }

  it("still declares the four text roles the block was written for", () => {
    const block = drenchBlock();
    for (const role of ["--ink", "--body", "--muted", "--faint"]) {
      expect(block, role).toContain(`${role}:`);
    }
  });

  it("re-declares every ground and hairline role the panel's own rules paint with", () => {
    const block = drenchBlock();
    const used = rolesUsedInsideAPanel();
    // The positive control: --well is reached for by `.coach-panel__action`, so an empty or
    // mis-parsed set would fail here rather than passing the loop vacuously.
    expect(used).toContain("--well");

    for (const role of GROUND_ROLES.filter((candidate) => used.has(candidate))) {
      expect(block, `${role} is painted inside a drenched panel and not re-declared for it`)
        .toContain(`${role}:`);
    }
  });

  it("gives the drenched action an outline rather than a face it cannot afford", () => {
    // A white-alpha fill costs the glyph more contrast than the lighter drench stop has to give:
    // 4.35:1 at 10% white against 5.96:1 with no face at all.
    const start = COACH_CSS.indexOf(
      '[data-shell-role="coach"] .coach-panel[data-drench] .coach-panel__action {',
    );
    expect(start).toBeGreaterThan(-1);
    const rule = COACH_CSS.slice(start, COACH_CSS.indexOf("}", start));

    expect(rule).toContain("background: transparent");
    expect(rule).toContain("color: var(--ink)");
  });
});

/**
 * The page title, which is the one type size on this surface that is too big rather than too small.
 *
 * 46px is drawn on a 1440px artboard. The canvas also has a phone artboard --
 * `CoachHomeMobile.dc.html`, coach Home at 390px -- and it draws the same greeting at 30px, because
 * 46px is wider than the phone's whole text column and either wraps mid-greeting or runs past the
 * gutter. The step-down is a media query rather than a `clamp()` so the tracking and the leading
 * can move with it: -0.026em on 1.05 is what a 46px title can afford and a 30px one cannot.
 */
describe("the coach page title on a phone", () => {
  /** The phone media query block, selector text included. */
  function phoneBlock(): string {
    const start = COACH_CSS.search(/@media\s*\(max-width:\s*639px\)/u);
    expect(start, "no phone media query in coach.css, so nothing below was checked")
      .toBeGreaterThan(-1);
    // Far enough to cover the rules nested inside the query, and no further.
    return COACH_CSS.slice(start, COACH_CSS.indexOf("\n}\n", start));
  }

  it("steps the title down below the 640px line the pill bar already turns on", () => {
    const stepped = /--coach-page-title:\s*([0-9.]+)px/u.exec(phoneBlock());

    expect(stepped, "the phone block declares no --coach-page-title").not.toBeNull();
    expect(Number(stepped![1]), "the phone artboard draws the greeting at 30px").toBe(30);
  });

  it("keeps the desktop title at the size the wide artboards draw", () => {
    // Both declarations live in the same sheet, so a step-down that quietly replaced the base
    // value rather than overriding it under the query would read as a fix and be a regression.
    const base = /\[data-shell-role="coach"\] \{[\s\S]*?--coach-page-title:\s*([0-9.]+)px/u.exec(
      COACH_CSS,
    );
    expect(base, "the base --coach-page-title declaration is gone").not.toBeNull();
    expect(Number(base![1])).toBe(46);
  });
});

/**
 * The other half of the floor: the literals in the components, which the stylesheet cannot see.
 *
 * Everything above reads `coach.css`, and the rule it quotes is not about a stylesheet -- §5 says
 * "nothing below it, ever" about the coach surface. Fifty-six `text-[Npx]` literals under 14px live
 * in the coach's own components, none of them in reach of the block above, so the guard passed
 * while the rule it cites was half-broken. Two audit lanes found that independently on 2026-09-01,
 * and it is the fourth guard this project has caught measuring a copy of the thing it names.
 *
 * ## Why the walk subtracts admin
 *
 * The two densities are deliberate: the console is 13.5px body with 30-34px targets, the coach side
 * is 16px with a 44px minimum. A shared kit atomic rendering 11.5px is therefore correct for the
 * console and says nothing about the coach, and a naive walk out of the coach routes reports 114
 * violations of which most are the console being itself. Subtracting every module an admin route
 * also reaches leaves the files that exist only for the coach, which is where a coach-only floor
 * can be enforced at all. Same subtraction `coach-economics-wall.test.ts` makes, same reason.
 *
 * A shared atomic that renders too small ON a coach page is a real defect this cannot see. That
 * needs the rendered DOM, and `coach.smoke.spec.ts` is where it belongs.
 *
 * DEBT holds the counts that existed when this landed. Delete a row when the file is clean, lower
 * it as you fix; it may never rise. Each row is asserted to still be a violation, so paying one
 * down without editing the row fails -- a stale allow-list is how the 12px eyebrow survived.
 */
const COACH_ONLY_TYPE_DEBT: Record<string, number> = {
  "src/components/workspace/live/coach-offer.tsx": 18,
  "src/components/workspace/live/offer-editor-availability.tsx": 18,
  "src/components/workspace/live/coach-measurement.tsx": 8,
  "src/components/workspace/live/coach-contacts.tsx": 2,
  "src/components/workspace/live/coach-conversations.tsx": 1,
  "src/components/workspace/live/leads-surface.tsx": 1,
};

describe("the coach's components hold the same floor as the coach's stylesheet", () => {
  const offenders = coachOnlyTypeOffenders();

  it("walks a real coach-only module set", () => {
    // Without this, a resolver change returning nothing would pass every assertion below while
    // reading no code at all -- which is exactly how the contrast suite went blind.
    const modules = coachOnlyModules();
    expect(modules.length).toBeGreaterThan(40);
    expect(modules).toContain("src/components/workspace/live/coach-offer.tsx");
    // The subtraction has to actually subtract, or this is the naive walk wearing a docstring.
    expect(modules).not.toContain("src/components/kit/atomics/grid-table.tsx");
  });

  it("adds no new sub-14px literal to a coach-only component", () => {
    const unexpected = Object.entries(offenders)
      .filter(([file]) => !(file in COACH_ONLY_TYPE_DEBT))
      .map(([file, sizes]) => `${file}: ${[...new Set(sizes)].sort((a, b) => a - b).join("px, ")}px`);

    expect(
      unexpected,
      "SIMPLIFICATION-SPEC §5: secondary and helper text is 14px minimum on the coach side, nothing below it, ever. Use --coach-body, --coach-eyebrow or --coach-panel-name.",
    ).toEqual([]);
  });

  /**
   * The blind spot this file's own docstring named, closed for the one atomic that cannot be
   * rendered legibly at all.
   *
   * The scan above matches `text-[Npx]` literals *in coach-only modules*, so a shared atomic whose
   * small number lives in `kit/` is invisible to it: the page mounts `<Overline>`, the 9.5px sits
   * in `kit/atomics/type.tsx`, and both this guard and `overline-size.test.ts` stay green -- the
   * second one because it pins 9.5px as *correct*, which it is, for the console. Round 4 found
   * seven of them still live on coach Home, and four rounds had walked past them.
   *
   * `Overline` is singled out by name rather than derived, and that is the honest scope: it is the
   * one atomic whose EVERY rendering is under the floor -- no size variant, one literal -- and the
   * one `docs/DESIGN.md` scopes to "the owner console, and only the owner console". `Figure` also
   * has a sub-14px arm, but `Figure size="lg"` is 27px, so banning the component would be banning
   * the wrong thing.
   *
   * The premise is read rather than assumed, so this rule cannot outlive its reason: if somebody
   * raises the atomic to the floor, the first assertion fails and says to delete the second.
   */
  it("mounts no console overline on a coach-only page, whatever its size lives in", () => {
    const kit = readFileSync(
      resolve(ROOT, "src/components/kit/atomics/type.tsx"),
      "utf8",
    );
    const start = kit.indexOf("export function Overline(");
    expect(start, "Overline is gone from the kit's type atomics -- delete this test").toBeGreaterThan(-1);
    const after = kit.slice(start + 10);
    const next = after.indexOf("\nexport ");
    const recipe = kit.slice(start, next === -1 ? kit.length : start + 10 + next);

    // The premise, read off the kit: every size this atomic can render is under the coach floor.
    // If that stops being true the ban below is pointless and this line says so first.
    const sizes = [...recipe.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)].map((m) => Number(m[1]));
    expect(sizes, "Overline's recipe sets no px size -- this test is reading the wrong slice")
      .not.toEqual([]);
    for (const size of sizes) {
      expect(size, "Overline is at or above the coach floor now; drop the ban below").toBeLessThan(14);
    }

    const mounts = coachOnlyModules().filter((file) => {
      const source = readFileSync(resolve(ROOT, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(?<!:)\/\/[^\n]*/g, " ");
      return /<Overline[\s/>]/.test(source);
    });

    expect(
      mounts,
      `Overline is ${Math.min(...sizes)}px uppercase mono in --overline (4.8:1), and docs/DESIGN.md `
        + "scopes it to the owner console. On the coach side the label above a name is "
        + "`.coach-eyebrow` -- 14px, sentence case, proportional, --muted -- which is what "
        + "Main.dc.html draws.",
    ).toEqual([]);
  });

  /**
   * Every type class in `coach-type.ts` is either bound to a token or deliberately not, and the
   * file cannot grow a third possibility quietly.
   *
   * This replaces a version that pinned two named constants. Two was the symptom count, not the
   * rule: three of these have now been found holding a number a token already held -- the eyebrow
   * at 12 against 14, the row name at 17 against 17, the reading class at 16 against 16 -- and
   * only the first was ever caught, by luck about which side of the 14px floor the stale number
   * fell on. Nothing else covers the middle: the ratchet above sees literals *under* 14 and
   * `token-references.test.ts` checks that a referenced token exists, not that a class references
   * one.
   *
   * **Bound on role, never on value**, which is why the second register exists rather than a rule
   * saying "any literal equal to a token's value must be bound". `COACH_LEAD_CLASS` is 17px and so
   * is `--coach-row-name`; a page's lead sentence and the name a lead row is about are two roles
   * that agree today, and tying them means resizing a table's row names silently resizes the
   * sentence under every page title. The same is true of the button-label constants scattered
   * through the coach lane -- `ACCENT_FILL_CLASS`, `SECONDARY_BUTTON_CLASS` and their siblings sit
   * at 16 and 17 inside fixed-height controls on `leading-none`, and they are control labels, not
   * body copy. A value-matching sweep would have bound about twenty of them and made every one of
   * those roles impossible to move independently.
   */
  const TOKEN_BOUND: Record<string, string> = {
    COACH_EYEBROW_CLASS: "--coach-eyebrow",
    COACH_PANEL_NAME_CLASS: "--coach-panel-name",
    COACH_READING_CLASS: "--coach-body",
    COACH_ROW_NAME_CLASS: "--coach-row-name",
  }

  /** Constants whose size is a literal on purpose, with the reason each one is not a token. */
  const DELIBERATELY_UNBOUND: Record<string, string> = {
    COACH_LEAD_CLASS:
      "17px coincides with --coach-row-name and is a different role; it gets --coach-lead the day "
        + "the scale names that role",
    COACH_FOOTNOTE_CLASS: "15px, and the coach scale declares no token at that size",
    COACH_SURFACE_TITLE_CLASS:
      "20px coincides with --coach-panel-name and is a third role the canvas attests; and one "
        + "of its two callers mounts outside [data-shell-role=\"coach\"], where a --coach-* token "
        + "resolves to nothing",
  }

  /** Every exported `COACH_*_CLASS` in the file, with comments blanked. */
  function typeClasses() {
    const source = readFileSync(
      resolve(ROOT, "src/components/workspace/live/coach-type.ts"),
      "utf8",
    ).replace(/\/\*\*?[\s\S]*?\*\//gu, "\n")

    // Terminated on the next top-level statement rather than on a semicolon. The first version of
    // this ended at `;`, and a constant written without one -- legal, and what a formatter change
    // would produce across the file -- parsed as no constant at all, so it slipped past the
    // register silently. The end of a statement is where the next one starts; the semicolon is
    // optional punctuation, and a guard must not depend on it.
    const found: Record<string, string> = {}
    for (const match of source.matchAll(
      /export const (COACH_[A-Z_]*CLASS)\s*=\s*([\s\S]*?)\s*;?\s*(?=\nexport |$)/gu,
    )) {
      found[match[1]] = match[2]
    }
    return found
  }

  it("accounts for every coach type class, as bound or as deliberately not", () => {
    const classes = typeClasses()

    // The positive control. A rename, or a regex that stopped matching, would otherwise leave every
    // loop below iterating over nothing -- which is the failure mode that let a scoping guard in
    // this tree pass twice against a rule it was written to reject.
    expect(Object.keys(classes).length).toBeGreaterThanOrEqual(5)
    for (const [name, declaration] of Object.entries(classes)) {
      expect(declaration, `${name} parsed as something that is not a class string`)
        .toMatch(/^"[^"]*text-\[/u)
    }

    const registered = new Set([...Object.keys(TOKEN_BOUND), ...Object.keys(DELIBERATELY_UNBOUND)])
    const unaccounted = Object.keys(classes).filter((name) => !registered.has(name))
    expect(
      unaccounted,
      "a new coach type class must be added to TOKEN_BOUND, or to DELIBERATELY_UNBOUND with the "
        + "reason its size is a literal. Binding is decided by role, not by matching a value.",
    ).toEqual([])

  })

  // Its own test rather than a fourth assertion above, because the positive control there fires on
  // a deleted constant first and would hide this one behind it -- a break-proof that goes red on a
  // sibling assertion has proven nothing about the assertion it was aimed at.
  /*
   * Where the banded panel name is still retyped instead of read.
   *
   * The recipe is four parts and all four matter: `--coach-panel-name` at 20px, weight **500**,
   * `1.25` and `-0.015em`. The first version of this checked only the last two, which are the two
   * the canvas's *other* card shape shares -- `TITLE_PANEL_TITLE_CLASS` is 22px at 600 with no
   * band, established over all 55 artboards -- so every title-led heading matched and got reported
   * as an unbound copy of a role it is not. Size and weight are the discriminators, and dropping
   * them left the check enforcing half the rule its own comment stated correctly one line above.
   * A comment is not an assertion.
   */
  const PANEL_NAME_LITERAL_DEBT: Record<string, string> = {
    "src/components/onboarding/coach-onboarding.tsx": "two headings still at text-[20px]",
    "src/components/workspace/live/leads-surface.tsx": "one heading still at text-[20px]",
  }

  /*
   * The third heading role the canvas attests, and the only two surfaces that carry it.
   *
   * 20px at 600 is not a banded panel name with the wrong weight. It is drawn deliberately in
   * exactly two places -- `CoachSupportBubble.dc.html:203`, the header of a 380px floating
   * popover, and `Agent.dc.html:211`, the first line of a bandless well -- and neither has the
   * eyebrow or the 78px header floor that make a banded card. This register held the opposite
   * verdict for one commit, which is what reading the code without the artboard costs.
   *
   * The rows are callers now rather than literal sites, because the recipe itself has moved to
   * `COACH_SURFACE_TITLE_CLASS`. Each must still read it: a surface that stops is either dropping
   * the role or respelling it, and both are worth a failure.
   */
  const ATTESTED_SURFACE_TITLES: Record<string, string> = {
    "src/components/workspace/live/coach-offer.tsx":
      "Agent.dc.html:211 -- the well's first line, 20px/600 over a 16px paragraph, no band",
    "src/components/workspace/live/coach-support-bubble.tsx":
      "CoachSupportBubble.dc.html:203 -- the popover's header line, 20px/600 with -0.015em",
    "src/components/workspace/live/escalation-panel.tsx":
      "an instance of CoachSupportBubble.dc.html:203's shape -- SurfaceHeader's band with no "
        + "overline passed, a title and a --muted sub-line -- rather than an artboard of its own",
  }

  /** The one file allowed to spell the 20px/600 recipe: the constant's own definition. */
  const SURFACE_TITLE_HOME = "src/components/workspace/live/coach-type.ts"

  /** Every heading carrying `1.25` + `-0.015em`, bucketed by the two parts that discriminate. */
  function panelNameRecipes() {
    const bound: string[] = []
    const literal: string[] = []
    const titleLed: string[] = []
    const neither: string[] = []
    const mistracked: string[] = []

    for (const file of entryFiles("src").map((path) => relative(ROOT, path))) {
      if (/\.test\.tsx?$/u.test(file)) continue
      const source = readFileSync(resolve(ROOT, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//gu, " ")
        .replace(/(?<!:)\/\/[^\n]*/gu, " ")

      for (const match of source.matchAll(/"[^"]*"/gu)) {
        const value = match[0]

        // The candidate filter must be looser than the rule. Requiring `tracking-[-0.015em]` to
        // enter the scan is what let two headings at `-0.012em` through every bucket and left the
        // message about an uncited third surface green while two surfaces claimed the role: a scan
        // that only considers strings with the right tracking cannot report a tracking defect, and
        // three thousandths off is exactly what the defect looks like. Selection is on size,
        // weight and leading; tracking is judged below and reported by name.
        if (!value.includes("leading-[1.25]")) continue

        const token = value.includes("text-[length:var(--coach-panel-name)]")
        const px = value.match(/text-\[(\d+)px\]/u)?.[1]
        const weight = value.includes("font-[500]")
          ? "500"
          : value.includes("font-semibold")
            ? "600"
            : null
        if ((!token && px !== "20" && px !== "22") || weight === null) continue

        const tracking = value.match(/tracking-\[([^\]]+)\]/u)?.[1] ?? "none"
        if (tracking !== "-0.015em") mistracked.push(`${file} (${tracking})`)

        // The title-led card, by both of its own parts rather than by its size alone.
        if (px === "22" && weight === "600") titleLed.push(file)
        else if ((token || px === "20") && weight === "500") (token ? bound : literal).push(file)
        else if (token || px === "20") neither.push(file)
      }
    }

    return {
      bound: [...new Set(bound)],
      literal: [...new Set(literal)],
      mistracked: [...new Set(mistracked)],
      neither: [...new Set(neither)],
      titleLed: [...new Set(titleLed)],
    }
  }

  it("reads the banded name from one place, and does not mistake the title-led card for it", () => {
    const { bound, literal, titleLed } = panelNameRecipes()

    // Both controls, because this check has already been wrong in both directions. The first says
    // the scan finds the role at all; the second says it does not swallow the other shape -- which
    // is the case that actually misled us, so it is pinned by name rather than left implied.
    expect(bound, "no file reads --coach-panel-name, so the scan found nothing at all")
      .not.toHaveLength(0)
    expect(
      titleLed,
      "TITLE_PANEL_TITLE_CLASS is 22px/600 and must be found as the title-led card, not missed",
    ).toContain("src/components/kit/deck-panel.tsx")
    for (const bucket of [bound, literal]) {
      expect(
        bucket,
        "deck-panel.tsx is the title-led card, a different role -- counting it here is the defect "
          + "that made 22px/600 look like a second panel name two pixels from the first",
      ).not.toContain("src/components/kit/deck-panel.tsx")
    }

    expect(
      literal.filter((file) => !(file in PANEL_NAME_LITERAL_DEBT)),
      "this is --coach-panel-name's recipe -- 20px, weight 500, 1.25, -0.015em -- written out by "
        + "hand. Read COACH_PANEL_NAME_CLASS from coach-type.ts instead.",
    ).toEqual([])

    // The debt may only shrink: a row for a file that no longer owes anything is an exemption
    // nobody can trace, which is how an allowlist outlives the thing it was excusing.
    for (const file of Object.keys(PANEL_NAME_LITERAL_DEBT)) {
      expect(literal, `${file} no longer spells the recipe -- delete its PANEL_NAME_LITERAL_DEBT row`)
        .toContain(file)
    }
  })

  it("reports a heading that is this recipe three thousandths off, rather than skipping it", () => {
    const { mistracked } = panelNameRecipes()

    expect(
      mistracked,
      "this heading is one of the three card recipes at the wrong letter-spacing -- -0.015em is "
        + "what all three carry. Read the constant from coach-type.ts rather than respelling it, "
        + "and if the near miss is deliberate it needs a reason here.",
    ).toEqual([])
  })

  it("keeps the third heading role in one place, and lets no surface claim it uncited", () => {
    const { neither } = panelNameRecipes()

    // Positive control: the definition itself must be found, or the scan is reading nothing and
    // every assertion below passes on an empty list.
    expect(neither, "the 20px/600 recipe was not found at all, not even where it is defined")
      .toContain(SURFACE_TITLE_HOME)

    expect(
      neither.filter((file) => file !== SURFACE_TITLE_HOME),
      "this heading is 20px at weight 600, a role the canvas draws in exactly two places -- the "
        + "support popover's header and the offer well's first line. Read "
        + "COACH_SURFACE_TITLE_CLASS from coach-type.ts. A third surface claiming it needs an "
        + "artboard line of its own; without one, it belongs to a card shape instead.",
    ).toEqual([])
  })

  it.each(Object.entries(ATTESTED_SURFACE_TITLES))(
    "keeps %s reading the attested surface title (%s)",
    (file) => {
      const source = readFileSync(resolve(ROOT, file), "utf8")
      expect(
        source,
        `${file} no longer reads COACH_SURFACE_TITLE_CLASS -- either the role left this surface, `
          + "in which case delete its ATTESTED_SURFACE_TITLES row, or it was respelled by hand",
      ).toContain("COACH_SURFACE_TITLE_CLASS")
    },
  )

  it("names no constant coach-type.ts no longer exports", () => {
    const classes = typeClasses()

    // Neither register may describe code that is gone, which is how an allowlist rots into a list
    // of exemptions nobody can trace to anything.
    for (const name of [...Object.keys(TOKEN_BOUND), ...Object.keys(DELIBERATELY_UNBOUND)]) {
      expect(classes[name], `${name} is registered here but not exported from coach-type.ts`)
        .toBeDefined()
    }
  })

  it("keeps every bound class reading its token, with no px literal beside it", () => {
    const classes = typeClasses()

    for (const [name, token] of Object.entries(TOKEN_BOUND)) {
      const declaration = classes[name] ?? ""
      expect(declaration, `${name} must read ${token} rather than respell its value`)
        .toContain(`text-[length:var(${token})]`)
      expect(
        [...declaration.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/gu)].map((match) => match[1]),
        `${name} sets a px literal beside a token that already holds that number`,
      ).toEqual([])
    }
  })

  it("declares every token the bound classes reference", () => {
    const tokens = pxTokens()
    for (const [name, token] of Object.entries(TOKEN_BOUND)) {
      // Defined first, and with the message on this line rather than the next: a numeric matcher
      // handed `undefined` throws a TypeError before it ever reads the message, so the one case
      // this test exists for -- the token is gone -- reported as a type error about the matcher.
      expect(
        tokens.get(token),
        `${name} reads ${token}, which coach.css does not declare -- the browser would drop the `
          + "whole declaration and the text would fall back to inherited size",
      ).toBeDefined()
      expect(tokens.get(token), `${name} reads ${token}, which is below the 14px floor`)
        .toBeGreaterThanOrEqual(14)
    }
  })

  /**
   * The unbound register has to keep describing real code. A constant listed here that has quietly
   * been bound is a stale exemption, and stale exemptions are how the 12px eyebrow survived four
   * audits inside a debt row nobody re-read.
   */
  it("keeps the deliberately-unbound classes actually unbound", () => {
    const classes = typeClasses()

    for (const [name, reason] of Object.entries(DELIBERATELY_UNBOUND)) {
      expect(reason.length, `${name} needs a reason, not an empty string`).toBeGreaterThan(20)
      expect(
        classes[name] ?? "",
        `${name} now reads a token -- move it to TOKEN_BOUND and delete its exemption`,
      ).not.toContain("text-[length:var(--coach-")
    }
  })

  it.each(Object.entries(COACH_ONLY_TYPE_DEBT))("still owes %s its %i literals", (file, count) => {
    const found = offenders[file]?.length ?? 0;
    expect(
      found,
      found === 0
        ? `${file} is clean -- delete its row from COACH_ONLY_TYPE_DEBT.`
        : `${file} now has ${found} sub-14px literals against ${count} recorded. Lower the row as you fix them; it may never rise.`,
    ).toBe(count);
  });
});

/*
 * The other floor on the same surface, judged over the same reachable set.
 *
 * `SIMPLIFICATION-SPEC` §5 gives the coach side a 44px minimum interactive target, "no
 * exceptions", and `coach.css` states it once in the right place: every `button, [role="button"],
 * a[href], input, select, [role="tab"]` under the coach root gets `min-height:
 * var(--coach-target)`. Nothing checked it, and the way it fails is quiet -- a fixed height on an
 * ancestor does not override the child's `min-height`, it just leaves the child rendering taller
 * than the box drawn around it. Same fails-open family as an undefined custom property or a
 * container query with no named container: the rule is stated correctly and never consulted.
 *
 * **The subject is the combination, not a literal.** `h-[34px]` is right in the console and right
 * in the kit; it is wrong only as an ancestor of a control under the coach root. A guard that
 * flagged every fixed height in a coach-reachable file would condemn correct code -- most of these
 * are icon tiles, bars and rails that hold nothing interactive -- and a guard that condemns correct
 * code gets weakened until it says nothing. So this reads mounts of the shells that pin a
 * sub-target height, and asks whether each mount overrode it.
 */
describe("the coach target floor", () => {
  /** Shells whose own recipe pins a height under the coach target, with the file that sets it. */
  const CONSOLE_HEIGHT_SHELLS: Record<string, string> = {
    FieldShell: "src/components/kit/atomics/field.tsx",
  };

  /** Mounts that hold no control, so nothing raises them and there is no box to overflow. */
  const HOLDS_NO_CONTROL: Record<string, string> = {
    "src/components/workspace/live/offer-editor-availability.tsx":
      "FooterFact puts a plain string in the shell -- no button, input, select or link, so "
        + "coach.css raises nothing and the 34px frame is the whole control",
  };

  const TARGET = Number(/--coach-target:\s*(\d+)px/u.exec(COACH_CSS)![1]);

  it("states the floor and the shells' heights, rather than assuming either", () => {
    expect(TARGET, "coach.css no longer declares --coach-target in px").toBeGreaterThanOrEqual(44);

    // The premise: each registered shell really does pin a height under the floor. If one is
    // fixed at source, this fails and the row comes out -- a registry that outlives its reason is
    // an exemption nobody can trace.
    for (const [shell, file] of Object.entries(CONSOLE_HEIGHT_SHELLS)) {
      const heights = [...readFileSync(resolve(ROOT, file), "utf8").matchAll(/h-\[(\d+)px\]/gu)]
        .map((match) => Number(match[1]));
      expect(heights, `${file} sets no fixed height, so ${shell} does not belong in this register`)
        .not.toEqual([]);
      expect(
        Math.min(...heights),
        `${shell} no longer pins a height under ${TARGET}px -- delete its row`,
      ).toBeLessThan(TARGET);
    }

    // And coach.css must still be the thing that raises controls, or the conflict this guard
    // describes does not exist and the whole block is measuring nothing.
    expect(COACH_CSS, "coach.css no longer raises controls to --coach-target")
      .toContain("min-height: var(--coach-target)");
  });

  /*
   * Every fixed height the shell's file pins, as a set rather than a number.
   *
   * The first version reported the minimum as "keeps its Npx", which named a height the mount did
   * not have -- `field.tsx` sets 23, 33 and 34 for different variants, and the base is 34. A guard
   * that states a specific wrong value in its own failure message teaches the reader something
   * false at the moment they are trusting it most, so it names the set the file pins and lets them
   * look.
   */
  function pinnedHeights(shell: string) {
    const source = readFileSync(resolve(ROOT, CONSOLE_HEIGHT_SHELLS[shell]), "utf8");
    return [...new Set([...source.matchAll(/h-\[(\d+)px\]/gu)].map((match) => Number(match[1])))]
      .filter((height) => height < TARGET)
      .sort((first, second) => first - second);
  }

  it("makes every coach-side mount of a console-height shell override the height", () => {
    const offenders: string[] = [];
    let mounts = 0;

    for (const file of coachOnlyModules()) {
      const source = readFileSync(resolve(ROOT, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//gu, " ")
        .replace(/(?<!:)\/\/[^\n]*/gu, " ");

      for (const shell of Object.keys(CONSOLE_HEIGHT_SHELLS)) {
        for (const match of source.matchAll(new RegExp(`<${shell}(\\s[^>]*)?>`, "gu"))) {
          mounts += 1;
          if (file in HOLDS_NO_CONTROL) continue;
          if (!/\bh-\[/u.test(match[1] ?? "")) offenders.push(
              `${file}: <${shell}> takes a height from ${CONSOLE_HEIGHT_SHELLS[shell]}, which pins ${pinnedHeights(shell).join("/")}px`,
            );
        }
      }
    }

    // Positive control. No mounts means the scan read nothing and every check above was vacuous.
    expect(mounts, "no mount of a console-height shell was found on any coach surface")
      .toBeGreaterThan(0);

    expect(
      offenders,
      `SIMPLIFICATION-SPEC §5: ${TARGET}px minimum target on the coach side, no exceptions. This `
        + "shell pins a console height while coach.css raises the control inside it to "
        + "--coach-target, so the control renders taller than its own frame. Pass "
        + "h-[var(--coach-target)] at the callsite, the way offer-editor-disqualifiers.tsx does -- "
        + "not in the atomic, which admin mounts correctly.",
    ).toEqual([]);
  });

  it.each(Object.entries(HOLDS_NO_CONTROL))("still mounts a bare shell in %s (%s)", (file) => {
    const source = readFileSync(resolve(ROOT, file), "utf8");
    expect(source, `${file} no longer mounts a console-height shell -- delete its exemption`)
      .toMatch(/<FieldShell/u);
  });
});
