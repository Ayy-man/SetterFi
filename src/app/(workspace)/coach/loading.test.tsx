import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import CoachHomeLoading from "@/app/(workspace)/coach/home/loading";
import CoachLoading from "@/app/(workspace)/coach/loading";

/**
 * Read off the repo, from `process.cwd()` rather than `import.meta.url`: this file runs in the
 * `ui` project, where the module URL is the transformed module's and not a path on disk.
 */
const read = (relative: string) => readFileSync(resolve(process.cwd(), "src", relative), "utf8");

/*
 * The loading boundary's one job is to hold the page's shape, which it can only do if the bones
 * are visible against what they are drawn on.
 *
 * Every bone here was `--well`, a value chosen when the pane behind it was near-black. The light
 * palette landed in `39f0cae` and `--well` on `--pane` fell to 1.02:1 -- two per cent, which is
 * nothing. The panel bones sit on a card face and still separate; the header bones sit straight on
 * the pane and did not. This reads the rendered markup rather than the source, because the point
 * is which ground each bone is actually on.
 */
describe("coach loading boundary", () => {
  it("draws the header bones on a face that separates from the pane", () => {
    const { container } = render(<CoachLoading />);
    const header = container.querySelector("header.flex.min-w-0.flex-col");

    expect(header).not.toBeNull();
    const bones = [...header!.querySelectorAll("[aria-hidden]")];
    // The positive control: a header that stopped rendering bones would otherwise pass the loop.
    expect(bones.length).toBeGreaterThanOrEqual(4);
    for (const bone of bones) {
      expect(bone.className).toContain("bg-[var(--band)]");
      expect(bone.className).not.toContain("bg-[var(--well)]");
    }
  });

  it("leaves the panel bones on --well, which still separates inside a card", () => {
    const { container } = render(<CoachLoading />);
    const panels = [...container.querySelectorAll("section.coach-panel")];

    expect(panels).toHaveLength(3);
    for (const bone of panels.flatMap((panel) => [...panel.querySelectorAll("[aria-hidden]")])) {
      expect(bone.className).toContain("bg-[var(--well)]");
    }
  });

  /*
   * The bones' frame, read off the deck rather than restated here.
   *
   * `loading.tsx` used to draw a `gap-[10px]` grid of `repeat(auto-fit, minmax(min(100%,210px),
   * 1fr))` under a comment saying the grid was copied from `CoachDeck` -- and `CoachDeck`'s own
   * comment argues against that exact grid by name, because it is the layout `CoachDeck` replaced.
   * So the screen whose entire job is that nothing moves held the wrong gaps, the wrong column
   * widths and, with no `--coach-panel-radius` override, 24px corners against panels that arrive
   * at 30px.
   *
   * This asserts the boundary against `coach-deck.tsx` itself, not against numbers typed twice: a
   * guard that hardcodes 14px is a second copy of the thing that drifted. The deck's wrapper line
   * is the authority for both values, and if someone retunes the deck this fails until the bones
   * follow.
   */
  it("draws the deck's own gap and corner radius, read from CoachDeck", () => {
    const deckSource = read("components/workspace/live/coach-deck.tsx");
    const wrapper = /<div className="flex flex-col items-start ([^"]+)"/u.exec(deckSource);
    expect(wrapper).not.toBeNull();
    const deckGap = /gap-\[(\d+px)\]/u.exec(wrapper![1])![1];
    const deckRadius = /\[--coach-panel-radius:([^\]]+)\]/u.exec(wrapper![1])![1];
    // The positive control: if the regex above ever matches an empty or renamed wrapper, these
    // two reads would be the string "undefined" rather than a measurement.
    expect(deckGap).toMatch(/^\d+px$/u);
    expect(deckRadius).toMatch(/^30px_30px/u);

    const { container } = render(<CoachLoading />);
    const columns = [...container.querySelectorAll<HTMLElement>("[data-deck-column]")];
    expect(columns.map((column) => column.dataset.deckColumn)).toEqual(["0", "1", "2"]);

    const deck = columns[0].parentElement!;
    expect(deck.className).toContain(`gap-[${deckGap}]`);
    expect(deck.className).toContain(`[--coach-panel-radius:${deckRadius}]`);
    for (const column of columns) {
      expect(column.className).toContain(`gap-[${deckGap}]`);
    }

    // And none of the grid it replaced: `auto-fit` sized every panel off a 210px floor.
    expect(deck.className).not.toContain("grid");
    expect(deck.getAttribute("style") ?? "").not.toContain("auto-fit");
  });

  it("gives the three columns one top line, in the skeleton and in the deck", () => {
    /*
     * Inverted on 2026-09-01. This asserted the bones copied `COLUMN_OFFSET`'s staggered tops --
     * 34px on the first column, 14px on the third, from `Main.dc.html`. Ayman read that stagger as
     * broken alignment in two separate screenshots and asked for it removed, so the rule is now
     * that there is no stagger, and it is held on both files rather than one: a skeleton that
     * agrees with a deck is worth nothing if the thing they agree on is the offset coming back.
     */
    const deckSource = read("components/workspace/live/coach-deck.tsx");
    expect(deckSource).not.toMatch(/COLUMN_OFFSET/u);
    expect(deckSource).not.toMatch(/md:pt-\[\d+px\]/u);

    const { container } = render(<CoachLoading />);
    const columns = [...container.querySelectorAll<HTMLElement>("[data-deck-column]")];
    expect(columns).toHaveLength(3);
    columns.forEach((column) => {
      expect(column.className).not.toMatch(/pt-\[\d+px\]/u);
      // One per column rather than three in a row, which is what the three-column flex buys.
      expect(column.querySelectorAll("section.coach-panel")).toHaveLength(1);
    });
  });

  it("announces itself once, not once per bone", () => {
    const { container } = render(<CoachLoading />);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
  });
});

/*
 * The window picker's bones, and the reason they are on Home's boundary rather than the segment's.
 *
 * `WindowPills` is declared in `coach-dashboard.tsx` and referenced nowhere else, so the
 * control exists on Home and on none of the other seven `/coach/*` routes. Drawing it in the
 * shared boundary would hold Home's shape by inserting a block that never arrives on Inbox, Leads,
 * Billing or Setup -- moving the layout jump onto seven pages to remove it from one.
 */
describe("coach Home's own loading boundary", () => {
  it("reserves the window picker's space, which the shared boundary must not", () => {
    const home = render(<CoachHomeLoading />);
    const bones = home.container.querySelector('[data-slot="home-window-bones"]');
    expect(bones).not.toBeNull();
    // Five stops: 1D, 1W, 1M, 3M, All. `custom` has no pill; it stays a URL the page reads. A
    // picker drawn as one block would hold the wrong width, which is the whole thing this
    // boundary exists to hold.
    expect(bones!.querySelectorAll('[class*="rounded-[10px]"]')).toHaveLength(5);
    home.unmount();

    const segment = render(<CoachLoading />);
    expect(segment.container.querySelector('[data-slot="home-window-bones"]')).toBeNull();
  });

  it("draws the picker as bones, never as a control that could navigate a half-loaded page", () => {
    const { container } = render(<CoachHomeLoading />);
    const bones = container.querySelector('[data-slot="home-window-bones"]')!;

    expect(bones.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll("form")).toHaveLength(0);
    // And no stop is pre-selected: `window` comes from the URL, and picking one here would show a
    // window the coach has not chosen.
    expect(container.querySelector('[aria-pressed="true"]')).toBeNull();
  });

  it("still announces the page once, not once more for Home's extra bones", () => {
    const { container } = render(<CoachHomeLoading />);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  // The rehaul picker draws `1D / 1W / 1M / 3M / All` in 14px mono inside `min-w-14 px-3.5`, and
  // no label is long enough to push a pill past that floor, so every stop is the same 56px. The
  // widths are still listed one by one in the boundary, because the next label added there is
  // likelier to be a word than another abbreviation -- which is a fact about the labels and not a
  // rule: the keys are positional either way, and the console-warning test at the bottom of this
  // file is what actually guards that.
  it("draws one bone per window stop, each at the width its own pill will be", () => {
    const { container } = render(<CoachHomeLoading />);
    const bones = container.querySelector('[data-slot="home-window-bones"]')!;
    const stops = [...bones.querySelectorAll<HTMLElement>('[style*="width"]')];

    expect(stops).toHaveLength(5);
    // The pill's `min-w-14` floor, which is what every stop comes out at today.
    expect(stops.map((stop) => stop.style.width)).toEqual(Array(5).fill("56px"));
  });

  /*
   * The one number a picker skeleton has to get right is its height.
   *
   * `Segmented` sizes its buttons `py-[5px]` on a 12.5px line, about 24px, and these bones were
   * 24px to match it -- but every control on a coach surface is then raised to `--coach-target` by
   * `coach.css`, so the real picker arrives at 44px and the bones held room for a control twenty
   * pixels shorter. The floor is read out of the stylesheet rather than typed here, because typing
   * 44 twice is how the two drift apart.
   */
  it("holds the picker at the coach target height, read from the stylesheet", () => {
    const css = read("app/(workspace)/coach/coach.css");
    const target = /--coach-target:\s*(\d+px)/u.exec(css)![1];
    expect(target).toMatch(/^\d+px$/u);
    // The floor has to actually apply to the picker's buttons, or matching it proves nothing.
    const floor = /\[data-shell-role="coach"\] :where\(([^)]*)\)/u.exec(css)![1];
    expect(floor).toContain("button");

    const { container } = render(<CoachHomeLoading />);
    const bones = container.querySelector('[data-slot="home-window-bones"]')!;
    const stops = [...bones.querySelectorAll<HTMLElement>('[style*="width"]')];

    expect(stops).toHaveLength(5);
    for (const stop of stops) {
      expect(stop.className).toContain(`h-[${target}]`);
    }
  });

  /*
   * The stops are keyed by position, and counting the bones cannot tell you that.
   *
   * All five widths are 56px, so keying the list by its width gives every child the key `56px`.
   * React is then free to omit or duplicate one, which would draw a four-segment picker that the
   * real control replaces with five — the flicker a loading state exists to prevent. The obvious
   * guard is to count the bones, and it does not work: reinstating `key={width}` leaves all five
   * on the first mount, so the count stays at five and the test stays green while React prints the
   * warning. Verified by breaking it, which is the only reason this test is written against the
   * console instead.
   *
   * Reading `console.error` is reading React's own detection rather than re-deriving it here, and
   * it fails on any duplicate key this page grows later, not only on the equal-width stops.
   */
  it("gives every window stop its own key, which React says out loud when it does not", () => {
    const warnings: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });

    try {
      render(<CoachHomeLoading />);
    } finally {
      spy.mockRestore();
    }

    expect(warnings.filter((line) => /same key/u.test(line))).toEqual([]);
  });
});
