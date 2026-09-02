import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DeckPanel, TitlePanel } from "@/components/kit/deck-panel";

/*
 * The header band's two static slots.
 *
 * The band could hold exactly one thing that was not the eyebrow or the name, and that one thing
 * was `action` -- a link. So two artboard details had nowhere to live: the amber warning tile
 * `CoachError.dc.html` opens its panel with, and the mono duration `CoachTips.dc.html` sets hard
 * right against each training's name. Neither is pressable, and building either as an `action`
 * would have put a link in the accessibility tree that goes nowhere.
 *
 * The ordering assertions are the point of the pair. `lead` before the name and `meta` after it is
 * the whole reason there are two, so a change that renders them in one place would be a change
 * this file has to notice.
 */
describe("DeckPanel header band", () => {
  it("renders the lead before the panel's name", () => {
    render(
      <DeckPanel eyebrow="This page" lead={<span data-testid="tile">!</span>} name="Something broke" />,
    );

    const band = screen.getByRole("heading", { name: "Something broke" }).closest("header")!;
    const tile = within(band).getByTestId("tile");
    expect(tile.compareDocumentPosition(band.querySelector("h2")!))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  /*
   * The name's level is a caller's choice and its default is not.
   *
   * `h2` has to stay the default because a deck is several panels under a page title that owns the
   * `h1`; a component that defaulted to `h1` would put four of them on coach Home. `h1` exists for
   * the inverse shape, where the panel is the whole page and there is no title above it -- the
   * coach error boundary, which `CoachError.dc.html` draws with an `<h1>`. Both render the same
   * class, so the level moves and the size does not, and this pins that pair: a "simplification"
   * that dropped the prop fails the second assertion, and one that flipped the default fails the
   * first.
   */
  it("names itself at level two by default and at level one only when asked", () => {
    const { rerender } = render(<DeckPanel name="Start here" />);
    expect(screen.getByRole("heading", { level: 2, name: "Start here" }))
      .toHaveClass("coach-panel__name");

    rerender(<DeckPanel name="Start here" nameAs="h1" />);
    expect(screen.getByRole("heading", { level: 1, name: "Start here" }))
      .toHaveClass("coach-panel__name");
  });

  it("renders the meta after it", () => {
    render(<DeckPanel meta={<span data-testid="duration">8:14</span>} name="Start here" />);

    const band = screen.getByRole("heading", { name: "Start here" }).closest("header")!;
    const duration = within(band).getByTestId("duration");
    expect(duration.compareDocumentPosition(band.querySelector("h2")!))
      .toBe(Node.DOCUMENT_POSITION_PRECEDING);
  });

  /*
   * The pin the two-slot header was granted on: a two-slot band with no guard is a one-slot band
   * waiting for somebody to collapse it, and collapsing it is the cheap-looking refactor -- one
   * `extra` prop, one box, callers arrange their own flex row. What that costs is not visible in
   * the component; it is visible in the call sites, where every one of them re-derives the same
   * layout and they drift. So this asserts the shape rather than the props: two distinct boxes,
   * on opposite sides of the name, both present at once.
   */
  it("keeps the two slots in separate boxes on opposite sides of the name", () => {
    render(
      <DeckPanel
        eyebrow="Start here"
        lead={<span data-testid="tile">!</span>}
        meta={<span data-testid="duration">8:14</span>}
        name="Your first week"
      />,
    );

    const band = screen.getByRole("heading", { name: "Your first week" }).closest("header")!;
    const tile = within(band).getByTestId("tile");
    const duration = within(band).getByTestId("duration");

    // Neither silently dropped when the other is present.
    expect(tile).toBeInTheDocument();
    expect(duration).toBeInTheDocument();

    // Two boxes, not one: a single slot holding both would put them in the same parent, which is
    // the collapse this test exists to catch.
    expect(tile.parentElement).not.toBe(duration.parentElement);
    expect(band.contains(tile.parentElement)).toBe(true);
    expect(band.contains(duration.parentElement)).toBe(true);

    // And on opposite sides of the name, which is the whole reason there are two.
    const heading = band.querySelector("h2")!;
    expect(tile.compareDocumentPosition(heading)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(duration.compareDocumentPosition(heading)).toBe(Node.DOCUMENT_POSITION_PRECEDING);
  });

  it("leaves the band empty of either when neither is passed", () => {
    render(<DeckPanel name="Plain" />);

    const band = screen.getByRole("heading", { name: "Plain" }).closest("header")!;
    expect(band.children).toHaveLength(1);
  });

  it("keeps the band's one control the action, so neither slot is pressable", () => {
    render(
      <DeckPanel
        action={{ href: "/coach/tips", label: "Open" }}
        lead={<span>!</span>}
        meta={<span>8:14</span>}
        name="Start here"
      />,
    );

    const band = screen.getByRole("heading", { name: "Start here" }).closest("header")!;
    expect(within(band).getAllByRole("link")).toHaveLength(1);
    expect(within(band).getByRole("link")).toHaveAccessibleName("Open");
  });
});

/*
 * The band's geometry, read off the stylesheet that sets it.
 *
 * `DeckPanel` deliberately carries no sizes of its own -- the anatomy is shared between the coach
 * surface and the console and only the scale differs -- so the one place this can be checked is
 * `coach.css`. It shipped at `15px 18px` with no height floor against the artboards' `19px 20px`
 * on 78px, and the floor is the half that matters: without it a panel whose band holds a bare name
 * is shorter than the one beside it, and a row of three cards puts its three names at three
 * different heights.
 *
 * `docs/REDESIGN-CANVAS.md` states the same two numbers in its anatomy list. The pair moved
 * together on purpose: the document described the old value for the whole redesign pass, which is
 * how a reader coming to this rule next would have "fixed" it back.
 */
describe("the deck panel's header band, in coach.css", () => {
  const COACH_CSS = readFileSync(
    resolve(process.cwd(), "src/app/(workspace)/coach/coach.css"),
    "utf8",
  );

  function headerRule(): string {
    const start = COACH_CSS.indexOf('[data-shell-role="coach"] .coach-panel__header {');
    // The positive control: a moved or renamed selector must fail here rather than leave the
    // assertions below reading an empty string and passing.
    expect(start, "the .coach-panel__header rule was not found, so nothing below was checked")
      .toBeGreaterThan(-1);
    return COACH_CSS.slice(start, COACH_CSS.indexOf("}", start));
  }

  it("pads the band at the artboards' 19px 20px", () => {
    expect(headerRule()).toContain("padding: 19px 20px");
  });

  it("floors it at 78px, so a row of panels keeps its names on one line", () => {
    expect(headerRule()).toMatch(/min-height:\s*78px/u);
  });

  it("keeps the canvas document telling the same story as the rule", () => {
    const canvasDoc = readFileSync(resolve(process.cwd(), "docs/REDESIGN-CANVAS.md"), "utf8");
    expect(canvasDoc).toContain("`padding: 19px 20px`");
    expect(canvasDoc).toContain("`min-height: 78px`");
    expect(canvasDoc).not.toContain("`padding: 15px 18px`");
  });
});

/*
 * The second card shape, and what "second shape" has to mean for the guard to be worth anything.
 *
 * The finding these pin is not a size. The round-4 audit of the coach secondary surfaces settled
 * it over all 55 artboards: every 20px/500 name in the canvas sits inside a hairline-closed
 * header band, and every 22px/600 title sits on a card with no band at all -- ten of ten, none of
 * them on the 78px floor. So a test that only read the font size would pass on a `DeckPanel` with
 * a bigger name, which is the exact wrong fix the audit's first cut proposed. These read the
 * anatomy: no `header`, no eyebrow, and the banded name's class specifically absent, because that
 * class is where the 20px comes from and a title that carried it would draw at 20px no matter what
 * utility sat beside it.
 */
describe("TitlePanel: the canvas's second card shape", () => {
  it("renders no header band, no eyebrow, and a title that is not the banded name", () => {
    const { container } = render(<TitlePanel sentence="One line." title="Your plan" />);

    const panel = container.querySelector(".coach-panel")!;
    // Positive control: the card face is there, so the three absences below are absences within a
    // rendered panel rather than the silence of a component that rendered nothing.
    expect(panel).toHaveTextContent("Your plan");

    expect(panel.querySelector(".coach-panel__header")).toBeNull();
    expect(panel.querySelector(".coach-panel__eyebrow")).toBeNull();

    const title = screen.getByRole("heading", { name: "Your plan" });
    expect(title).not.toHaveClass("coach-panel__name");
    expect(title).toHaveClass("text-[22px]", "font-semibold");
  });

  /*
   * `MeetYourAgent.dc.html:213` is the site this exists for: a flat drenched row whose two choices
   * sit beside the sentence, centred against it. Through the banded shape they dropped a block
   * below their own title, which on the one panel in the product where the title and the decision
   * are the same sentence is the whole defect. So this asserts containment and order, not padding:
   * an aside that came back out of the head row fails here.
   */
  it("holds the aside inside the head row, after the title rather than under it", () => {
    render(
      <TitlePanel
        aside={<button data-testid="go-live" type="button">Go live</button>}
        asideAlign="center"
        sentence="Going live turns your agent on today."
        title="Ready when you are"
      />,
    );

    const title = screen.getByRole("heading", { name: "Ready when you are" });
    const head = title.parentElement!.parentElement!;
    const aside = screen.getByTestId("go-live");

    expect(head.contains(aside)).toBe(true);
    expect(aside.compareDocumentPosition(title)).toBe(Node.DOCUMENT_POSITION_PRECEDING);
    expect(head).toHaveClass("items-center");
  });

  /*
   * And `start` is the default, because the canvas draws it five times to `center`'s one: the four
   * `Agent.dc.html` cards set a state pill level with the title rather than with the whole head
   * block. A default of `center` -- which is what one commit shipped, inferred from the go-live
   * artboard before the other five were read -- drops that pill half a line down the card.
   */
  it("aligns an aside to the top of the title unless the row asks to be centred", () => {
    render(
      <TitlePanel
        aside={<span data-testid="pill">Set</span>}
        sentence="Your agent quotes these exactly."
        title="What you charge"
      />,
    );

    const head = screen.getByRole("heading", { name: "What you charge" }).parentElement!.parentElement!;
    expect(head.contains(screen.getByTestId("pill"))).toBe(true);
    expect(head).toHaveClass("items-start");
    expect(head).not.toHaveClass("items-center");
  });

  /*
   * `divided` is `Billing.dc.html:151`, and the reading it encodes is that a rule under the title
   * does not make the head a band. What changes is where the padding lives: the card gives it up so
   * a list of rows can carry it and their hairlines can reach both edges. A `divided` panel that
   * kept the card's own padding would inset every row by 30px twice.
   */
  it("closes the head with a hairline and hands the card's padding to the body when divided", () => {
    const { container, rerender } = render(<TitlePanel title="Did they show up?" />);
    expect(container.querySelector(".coach-panel")).toHaveClass("px-[30px]");

    rerender(<TitlePanel divided title="Did they show up?" />);
    const panel = container.querySelector(".coach-panel")!;
    expect(panel).not.toHaveClass("px-[30px]");

    const head = screen.getByRole("heading", { name: "Did they show up?" }).parentElement!.parentElement!;
    expect(head).toHaveClass("border-b", "px-[30px]");
  });
});

/*
 * The two enlarged name sizes, each read off the artboard that draws it.
 *
 * There are two, and the prop's own comment used to say there was one. `CoachTips.dc.html:123`
 * bands a featured card with a 26px/500/-0.018em name; `CoachError.dc.html:102` opens the error
 * panel with an h1 at 26px, weight 600, -0.02em. Same size, one weight and one hundredth of an
 * em apart -- and because the prop documented itself as the canvas's only hero name, the error
 * page passed no `nameSize` at all and rendered that h1 at the ordinary 20px for four rounds.
 *
 * So the recipes are not typed into this test. Each one is parsed out of the artboard line it cites,
 * which is the only version of this assertion that could have caught the defect: a hand-copied
 * expectation agrees with whatever the component does at the moment somebody writes it down.
 *
 * Every panel name that is neither of these is 20px, so the default has to stay 20px -- a change
 * making `nameSize` default to anything fails the first assertion rather than quietly enlarging
 * the name on all of `hero`'s existing callers.
 *
 * The `!` is load-bearing and is therefore read: `[data-shell-role="coach"] .coach-panel__name`
 * sets size, weight and tracking at two-class specificity, so a plain `text-[26px]` would lose to
 * it and this test would be measuring a class that changes nothing on screen.
 */
/**
 * The two cited heading lines, recorded verbatim from the artboards on 2026-09-02. The artboards
 * are not part of this repository, so the recipes are parsed out of these recorded lines rather
 * than typed as three numbers each: the parse below is the same one the drawing was read with.
 */
const DRAWN_LINES: Record<string, string> = {
  "CoachError.dc.html:102":
    '<h1 style="margin: 0; font-size: 26px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.15; color: var(--ink);">Something on our side broke</h1>',
  "CoachTips.dc.html:123":
    '<h2 style="margin: 0; font-size: 26px; font-weight: 500; letter-spacing: -0.018em; color: var(--ink);">Writing prices your agent can quote</h2>',
};

/** The `font-size` / `font-weight` / `letter-spacing` of one numbered line of one artboard. */
function drawnHeading(artboard: string, line: number) {
  const source = DRAWN_LINES[`${artboard}:${line}`] ?? "";
  const read = (property: string) => new RegExp(`${property}:\\s*([^;]+);`).exec(source)?.[1].trim();
  return {
    size: read("font-size"),
    tracking: read("letter-spacing"),
    weight: read("font-weight"),
  };
}

describe("DeckPanel name size", () => {
  it("names a panel at the banded 20px unless a larger name is asked for", () => {
    const { rerender } = render(<DeckPanel name="Start here" />);
    const plain = screen.getByRole("heading", { name: "Start here" });
    expect(plain).toHaveClass("coach-panel__name");
    expect(plain.className).not.toContain("text-[26px]");

    rerender(<DeckPanel name="Start here" nameSize="hero" />);
    expect(screen.getByRole("heading", { name: "Start here" })).toHaveClass("coach-panel__name");
  });

  it.each([
    { artboard: "CoachTips.dc.html", line: 123, nameSize: "hero" as const },
    { artboard: "CoachError.dc.html", line: 102, nameSize: "page" as const },
  ])("draws nameSize=\"$nameSize\" as $artboard:$line draws it", ({ artboard, line, nameSize }) => {
    const drawn = drawnHeading(artboard, line);
    // The premise, read first: if the cited line stops being a heading with all three properties
    // the expectations below would silently compare against `undefined`.
    expect(drawn.size, `${artboard}:${line} sets no font-size -- the citation has moved`).toBeDefined();
    expect(drawn.weight, `${artboard}:${line} sets no font-weight`).toBeDefined();
    expect(drawn.tracking, `${artboard}:${line} sets no letter-spacing`).toBeDefined();

    render(<DeckPanel name={artboard} nameSize={nameSize} />);
    const heading = screen.getByRole("heading", { name: artboard });

    expect(heading.className, `size drawn at ${drawn.size}`).toContain(`text-[${drawn.size}]!`);
    expect(heading.className, `weight drawn at ${drawn.weight}`).toContain(`font-[${drawn.weight}]!`);
    expect(heading.className, `tracking drawn at ${drawn.tracking}`)
      .toContain(`tracking-[${drawn.tracking}]!`);
  });

  /*
   * And the two are actually different, which every assertion above would still pass if `page`
   * were a second name for `hero`. The whole defect was a screen taking the wrong one of the two,
   * so a suite that cannot tell them apart has not covered it.
   */
  it("keeps the page heading heavier than the card name, which is the difference", () => {
    const { rerender } = render(<DeckPanel name="Both" nameSize="hero" />);
    const card = screen.getByRole("heading", { name: "Both" }).className;
    rerender(<DeckPanel name="Both" nameSize="page" />);
    const page = screen.getByRole("heading", { name: "Both" }).className;

    expect(page).not.toEqual(card);
    expect(card).toContain("font-[500]!");
    expect(page).toContain("font-[600]!");
  });

  /*
   * And it does not touch the radius. `hero` moves the card to `30px 30px 17px 17px`, which is a
   * real canvas shape -- `Login.dc.html:70`, `Landing.dc.html:93`, every card on
   * `CoachLoading.dc.html` -- but the Tips featured card is drawn at 24px like the six under it.
   * The two were one prop and the card got the wrong half of the treatment in both directions.
   */
  it("leaves the card's radius alone, which is what the drawing does not change", () => {
    const { container } = render(<DeckPanel name="Start here" nameSize="hero" />);
    expect(container.querySelector(".coach-panel")).not.toHaveAttribute("data-hero");
  });
});

/*
 * The shape must not fork a third time.
 *
 * It had already forked twice before anyone noticed: `deck-panel.tsx` could only draw the banded
 * card, so `coach-offer.tsx` hand-rolled the title-led one as a private `OfferCard` with its own
 * `text-[22px] leading-[1.25] font-semibold tracking-[-0.015em]` -- the same recipe to the
 * hundredth of an em, invisible to every other caller, and drifting from the moment either copy
 * was touched. Both are `TitlePanel` now, and this sweeps the tree so the next person who needs a
 * 22px/600 title imports the constant instead of retyping it.
 *
 * What it reads is the declaration itself, not a list of files that are allowed to have one: it
 * normalises each source file's whitespace, finds every `text-[22px]`, and looks in the window
 * around it for the 600-weight utility in either spelling. A class string wrapped across three
 * lines by the formatter is still caught, which the obvious line-at-a-time version would miss.
 *
 * The positive control is the half that makes it worth anything. If Tailwind's arbitrary-value
 * syntax changes, or the constant is renamed, or the detector is broken in any other way, the
 * sweep below finds nothing and reads as coverage -- so the control asserts the detector finds the
 * one declaration that is supposed to exist before the sweep is allowed to conclude anything.
 */
describe("the title-led title exists once", () => {
  const REPOSITORY_ROOT = process.cwd();
  const OWNER = "src/components/kit/deck-panel.tsx";

  function declarations(source: string): readonly string[] {
    const flat = source.replace(/\s+/gu, " ");
    const found: string[] = [];
    for (const match of flat.matchAll(/text-\[22px\]/gu)) {
      const window = flat.slice(Math.max(0, match.index - 100), match.index + 100);
      if (/font-semibold|font-\[600\]/u.test(window)) found.push(window.trim());
    }
    return found;
  }

  it("finds the one declaration it is looking for, so a blind sweep cannot read as coverage", () => {
    const owner = declarations(readFileSync(resolve(REPOSITORY_ROOT, OWNER), "utf8"));
    expect(owner, `no 22px/600 title found in ${OWNER}; the detector below is blind`)
      .toHaveLength(1);
    expect(owner[0]).toContain("tracking-[-0.015em]");
  });

  it("is declared nowhere else in the tree", () => {
    const files = execFileSync("git", ["ls-files", "src"], { cwd: REPOSITORY_ROOT, encoding: "utf8" })
      .split("\n")
      .filter((path) => /\.tsx?$/u.test(path) && !/\.test\.tsx?$/u.test(path) && path !== OWNER);

    // The sweep saw a tree, not an empty list.
    expect(files.length).toBeGreaterThan(100);

    const forks = files.flatMap((path) => {
      const found = declarations(readFileSync(resolve(REPOSITORY_ROOT, path), "utf8"));
      return found.map((declaration) => `${path}: ${declaration}`);
    });

    expect(
      forks,
      "import TITLE_PANEL_TITLE_CLASS from @/components/kit/deck-panel rather than retyping it",
    ).toEqual([]);
  });
});
