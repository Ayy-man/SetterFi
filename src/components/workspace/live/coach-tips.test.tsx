import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CoachTips, type CoachTraining } from "@/components/workspace/live/coach-tips";

const TRAININGS: readonly CoachTraining[] = [
  {
    id: "prices",
    category: "Start here",
    title: "Writing prices your agent can quote",
    duration: "8:14",
    sentence: "Your agent will only say a number you have written down yourself.",
    href: "/coach/tips/prices",
  },
  {
    id: "guarantee",
    category: "Objections",
    title: "When a lead asks for a guarantee",
    duration: "5:02",
    sentence: "Why your agent refuses to promise an approval.",
    href: "/coach/tips/guarantee",
  },
  {
    id: "carrier",
    category: "Setup",
    title: "What happens during carrier review",
    duration: "6:35",
    sentence: "Who the carriers are and what they are checking.",
    href: null,
  },
];

describe("CoachTips", () => {
  /**
   * The state that actually ships. There is no trainings repository, so the surface renders with
   * no data on day one, and the thing to catch is a page that looks populated anyway -- a
   * placeholder catalogue left in the prop default, or a search box implying content the reader
   * has simply failed to find.
   */
  it("renders the real page head and states the absence with no data", () => {
    render(<CoachTips />);

    expect(screen.getByRole("heading", { level: 1, name: "Tips and trainings" })).toBeVisible();
    expect(screen.getByText(/None of them runs longer than nine minutes/u)).toBeVisible();
    expect(screen.getByText("No trainings have been published yet.")).toBeVisible();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Watch/u })).not.toBeInTheDocument();
  });

  /**
   * The absence is a sentence at the coach's own scale, not a dashed box at the scale of a form
   * field. The audit measured the old one at 13px with 450px of grey under it, on a page whose
   * only content was that sentence.
   */
  it("states the absence at the coach scale rather than at the console's", () => {
    render(<CoachTips />);

    const absence = screen.getByText("No trainings have been published yet.");
    expect(absence.className).toContain("text-[20px]");
    expect(absence.className).toContain("var(--muted)");
    // Inside a real panel, so the absence fills the slot the content would have filled.
    expect(absence.closest(".coach-panel")).not.toBeNull();
  });

  /*
   * Tips is reached from the account menu and the support bubble, neither of which is a place on
   * a page, so a coach who opens it has no route out except the browser's back button. That is
   * the same class of hole as the route having had no way in at all.
   */
  it("offers a way back to a page, since neither route in is one", () => {
    render(<CoachTips />);

    expect(screen.getByRole("link", { name: /Back to Home/u }))
      .toHaveAttribute("href", "/coach/home");
  });

  /**
   * Catches the card shape being welded to a hard-coded array. The whole point of shipping this
   * ahead of its content is that the day the catalogue lands the work is passing a prop.
   */
  it("draws the artboard's card shape from the trainings prop", () => {
    const { container } = render(<CoachTips trainings={TRAININGS} />);

    expect(container.querySelectorAll(".coach-panel")).toHaveLength(TRAININGS.length);
    // Every card carries its category eyebrow, its title, its duration and its sentence.
    expect(screen.getByText("Objections")).toBeVisible();
    expect(screen.getByRole("heading", { name: "When a lead asks for a guarantee" })).toBeVisible();
    expect(screen.getByText("5:02")).toBeVisible();
    expect(screen.getByText("Why your agent refuses to promise an approval.")).toBeVisible();
  });

  /**
   * The duration rides the header band's `meta` slot rather than the card body. Three cards in a
   * row then show three lengths on one line, instead of at three different heights, because the
   * sentences under them are not the same length.
   */
  it("puts each duration in the band beside the name, not in the body", () => {
    render(<CoachTips trainings={TRAININGS} />);

    const duration = screen.getByText("5:02");
    expect(duration.closest(".coach-panel__header")).not.toBeNull();
    expect(duration.className).toContain("font-mono");
  });

  /**
   * A listed-but-not-playable training must not offer a control that goes nowhere: "nothing
   * happened when I pressed it" is the one outcome a coach cannot tell apart from a broken
   * product. The positive control is the sibling card that does have a link.
   */
  it("offers no watch link for a training that is not playable yet", () => {
    render(<CoachTips trainings={TRAININGS} />);

    const carrier = screen
      .getByRole("heading", { name: "What happens during carrier review" })
      .closest("section") as HTMLElement;
    expect(carrier.querySelector('[data-slot="training-watch"]')).toBeNull();
    expect(carrier).toHaveTextContent("This one is not published yet.");
    expect(screen.getAllByRole("link", { name: /Watch now/u })).toHaveLength(2);
  });

  /**
   * Catches the page title reverting to `PageHeader`'s 20px console title, which is the single
   * most common way a coach port is announced as done while still reading as the owner console.
   */
  it("titles the page at the coach scale, not the console's", () => {
    render(<CoachTips trainings={TRAININGS} />);

    const title = screen.getByRole("heading", { level: 1, name: "Tips and trainings" });
    expect(title.className).toContain("coach-page-title");
    expect(title.className).not.toContain("t-page-title");
  });

  /**
   * One filled control in view, and it goes to the first playable training rather than to a card
   * chosen for it. The previous build led with a wide drenched card carrying the fill, which was a
   * hero asserting an editorial ranking nobody had made; the current artboard draws six equal
   * cards and nothing saturated at all.
   */
  it("spends one accent fill, on the first playable card, and drenches nothing", () => {
    const { container } = render(<CoachTips trainings={TRAININGS} />);

    expect(container.querySelectorAll(".coach-panel[data-drench]")).toHaveLength(0);
    expect(container.querySelectorAll('[class*="coach-drench"]')).toHaveLength(0);

    const fills = container.querySelectorAll('[class*="--accent-fill"]');
    expect(fills, "one accent fill on the page, never two and never zero").toHaveLength(1);
    expect(fills[0]!.closest("section")).toHaveTextContent("Writing prices your agent can quote");
  });
});
