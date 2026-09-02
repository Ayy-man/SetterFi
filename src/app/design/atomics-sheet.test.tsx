import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AtomicsSheet } from "@/app/design/atomics-sheet";
import { NoteStrip, QueueItem } from "@/components/kit/atomics/queue-item";
import { TONES } from "@/components/kit/atomics/tone";

function slot(name: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  if (!element) throw new Error(`No ${name} rendered`);
  return element;
}

describe("QueueItem", () => {
  it("leads with a tone-tinted tile and states the clock in mono", () => {
    render(
      <QueueItem
        clock="41m over"
        context="Reid Funding Group · Closer agent"
        title="Agent stopped replying"
        tone="failure"
      />,
    );
    expect(slot("queue-item")).toHaveAttribute("data-tone", "failure");
    expect(slot("icon-tile")).toHaveAttribute("data-tone", "failure");
    expect(slot("queue-item-clock")).toHaveTextContent("41m over");
  });

  it("keeps a cleared item in the list, struck through and un-glowed, rather than vanishing it", () => {
    render(<QueueItem cleared clock="cleared" context="resolved by Dana" title="Escalation unanswered" tone="warning" />);
    const item = slot("queue-item");
    expect(item).toHaveAttribute("data-cleared", "true");
    expect(item.className).toContain("opacity-55");
    expect(slot("queue-item-title").className).toContain("line-through");
    expect(slot("status-dot").style.boxShadow).toBe("");
  });

  it("renders no action row on an item nobody can act on", () => {
    render(<QueueItem context="4 docs older than 90 days" title="Knowledge base stale" tone="waiting" />);
    expect(document.querySelector('[data-slot="queue-item-actions"]')).toBeNull();
  });
});

describe("NoteStrip", () => {
  it.each(TONES)("frames a %s note with a full border and no shadow", (tone) => {
    const { unmount } = render(<NoteStrip tone={tone}>Something is true.</NoteStrip>);
    const strip = slot("note-strip");
    expect(strip).toHaveAttribute("data-tone", tone);
    expect(strip.style.borderColor).toBeTruthy();
    expect(strip.className).not.toContain("shadow");
    unmount();
  });
});

/**
 * The sheet is the audit surface, so its completeness is the thing worth pinning: a tone that
 * exists in the contract but is never drawn on `/design` is a state the eight admin lanes will
 * meet for the first time in production.
 */
describe("the atomics sheet", () => {
  it("draws every tone of the status pill, the failure and waiting states included", () => {
    render(<AtomicsSheet />);
    const drawn = new Set(
      [...document.querySelectorAll('[data-slot="status"][data-treatment="pill"]')].map((node) =>
        node.getAttribute("data-tone"),
      ),
    );
    for (const tone of TONES) expect(drawn).toContain(tone);
  });

  it("draws both status treatments, so neither can be the only one a screen has seen", () => {
    render(<AtomicsSheet />);
    const treatments = new Set(
      [...document.querySelectorAll('[data-slot="status"]')].map((node) =>
        node.getAttribute("data-treatment"),
      ),
    );
    expect([...treatments].sort()).toEqual(["bare", "pill"]);
  });

  it("draws every surface variant and every icon-tile size", () => {
    render(<AtomicsSheet />);
    const variants = new Set(
      [...document.querySelectorAll('[data-slot="surface"]')].map((node) =>
        node.getAttribute("data-variant"),
      ),
    );
    expect([...variants].sort()).toEqual(["card", "panel", "strip", "well"]);

    const sizes = new Set(
      [...document.querySelectorAll('[data-slot="icon-tile"]')].map((node) =>
        node.getAttribute("data-size"),
      ),
    );
    for (const size of ["xs", "sm", "md", "lg"]) expect(sizes).toContain(size);
  });

  it("draws every button variant, the disabled state included", () => {
    render(<AtomicsSheet />);
    const variants = new Set(
      [...document.querySelectorAll('[data-slot="kit-button"]')].map((node) =>
        node.getAttribute("data-variant"),
      ),
    );
    for (const variant of ["primary", "secondary", "ghost", "destructive", "soft"]) {
      expect(variants).toContain(variant);
    }
    expect(document.querySelector('[data-slot="kit-button"][disabled]')).not.toBeNull();
  });

  it("draws the failure and waiting settings rows, which no happy path ever renders", () => {
    render(<AtomicsSheet />);
    const tones = new Set(
      [...document.querySelectorAll('[data-slot="setting-row"]')].map((node) =>
        node.getAttribute("data-tone"),
      ),
    );
    expect(tones).toContain("failure");
    expect(tones).toContain("waiting");
    expect(screen.getByText("Blocks publish until it is set.")).toBeInTheDocument();
  });

  it("shows the row that states a decision instead of offering a control", () => {
    render(<AtomicsSheet />);
    expect(screen.getByText("Stated value, no control")).toBeInTheDocument();
    expect(
      document.querySelector('[data-slot="kit-toggle"][disabled]'),
    ).toBeNull();
  });

  /**
   * Both of these are regressions the sheet exists to make visible. Neither showed up on a happy
   * path: the day count only looks wrong beside the mono figures it shares a well with, and the
   * journey's accent only lands on the wrong step when current-ness and actionability come apart.
   */
  it("sets the day count on the mono face, because a day count is a figure", () => {
    render(<AtomicsSheet />);
    const count = screen.getAllByText(/^Day \d+$/)[0]!;
    expect(count.className).toContain("mono");
  });

  it("draws the day counter with no percentage and no predicted completion date", () => {
    render(<AtomicsSheet />);
    const counters = [...document.querySelectorAll(".daycount")];
    expect(counters.length).toBeGreaterThanOrEqual(3);
    for (const counter of counters) {
      expect(counter.textContent).not.toContain("%");
      expect(counter.textContent).not.toMatch(/\bby [A-Z][a-z]{2} \d/);
      expect(counter.querySelector('[role="progressbar"]')).toBeNull();
    }
    // Day 0 is drawn on purpose: the wait started today, and it is still a count, not an absence.
    expect(screen.getByText("Day 0")).toBeInTheDocument();
    // And an unreadable start renders as an absence rather than as a confident zero.
    expect(screen.getByText("Still waiting")).toBeInTheDocument();
  });

  it("draws a journey whose current step is not the actionable one", () => {
    render(<AtomicsSheet />);
    const current = document.querySelector('[data-state="current"]')!;
    expect(current.textContent).toContain("Carrier vetting");
    expect(current.querySelector("button, a[href]")).toBeNull();
  });

  it("spends the journey's fill on the coach's action rather than on the carrier's step", () => {
    render(<AtomicsSheet />);
    const journey = document.querySelector('[aria-label="Setup journey"]')!;
    const filled = [...journey.querySelectorAll<HTMLElement>("button, a[href]")].filter(
      (node) => !node.className.includes("border-border"),
    );
    expect(filled).toHaveLength(1);
    expect(filled[0]).toHaveTextContent("Confirm consent page");
    // And the step that holds it is the coach's, not the one the timeline has reached.
    expect(filled[0]!.closest("li")).toHaveAttribute("data-state", "waiting");
  });

  it("shows a series too short to draw as nothing, not as a flat line", () => {
    render(<AtomicsSheet />);
    const sparklines = [...document.querySelectorAll('[data-slot="bar-sparkline"]')];
    expect(sparklines.length).toBeGreaterThan(0);
    // The sheet specifies a one-point series on purpose. Nothing it draws may have fewer than two
    // bars, because a single bar is a value drawn as if it were a direction.
    for (const sparkline of sparklines) {
      expect(sparkline.querySelectorAll('[data-slot="bar-sparkline-bar"]').length).toBeGreaterThanOrEqual(2);
    }
  });
});
