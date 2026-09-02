import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CoachTips, type CoachTraining } from "@/components/workspace/live/coach-tips";

// `DataState` calls `useRouter` for its retry affordance, which jsdom has no app router for.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const TRAININGS: readonly CoachTraining[] = [
  {
    id: "prices",
    category: "Start here",
    title: "Writing prices your agent can quote",
    duration: "8:14",
    sentence: "Your agent will only say a number you have written down yourself.",
    href: "/coach/tips/prices",
    addedAt: "2026-08-26T00:00:00.000Z",
    featured: true,
    related: { label: "Open my offer sheet", href: "/coach/agent" },
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
  it("renders the real page head and an honest empty state with no data", () => {
    render(<CoachTips />);

    expect(screen.getByRole("heading", { level: 1, name: "Tips and trainings" })).toBeVisible();
    expect(screen.getByText(/none of them assumes you know what an API is/u)).toBeVisible();
    expect(screen.getByRole("heading", { name: "No trainings have been published yet" }))
      .toBeVisible();
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Watch/u })).not.toBeInTheDocument();
  });

  /*
   * Tips is reached from the account menu and the support bubble, neither of which is a place on
   * a page, so a coach who opens it has no route out except the browser's back button. That is
   * the same class of hole as the route having had no way in at all.
   */
  it("offers a way back to a page, since neither route in is one", () => {
    render(<CoachTips />);

    const back = screen.getByRole("link", { name: /Back to Home/u });
    expect(back).toHaveAttribute("href", "/coach/home");
  });

  /**
   * Catches the card shape being welded to a hard-coded array. The whole point of shipping this
   * ahead of its content is that the day the catalogue lands the work is passing a prop.
   */
  it("draws the artboard's card shape from the trainings prop", () => {
    render(<CoachTips trainings={TRAININGS} />);

    const featured = screen.getByRole("heading", { name: "Writing prices your agent can quote" });
    expect(featured).toBeVisible();
    expect(screen.getByText(/Start here · added/u)).toBeVisible();
    expect(screen.getByRole("link", { name: /Watch now/u }))
      .toHaveAttribute("href", "/coach/tips/prices");
    expect(screen.getByRole("link", { name: "Open my offer sheet" }))
      .toHaveAttribute("href", "/coach/agent");

    // Every card carries its category eyebrow, its title, its duration and its sentence.
    expect(screen.getByText("Objections")).toBeVisible();
    expect(screen.getByRole("heading", { name: "When a lead asks for a guarantee" })).toBeVisible();
    expect(screen.getByText("5:02")).toBeVisible();
    expect(screen.getByText("Why your agent refuses to promise an approval.")).toBeVisible();
  });

  /**
   * A listed-but-not-playable training must not offer a control that goes nowhere: "nothing
   * happened when I pressed it" is the one outcome a coach cannot tell apart from a broken
   * product. The positive control is the sibling card that does have a link.
   */
  it("offers no watch link for a training that is not playable yet", () => {
    render(<CoachTips trainings={TRAININGS} />);

    expect(screen.getByRole("link", { name: "Watch When a lead asks for a guarantee" }))
      .toBeVisible();
    expect(screen.queryByRole("link", { name: "Watch What happens during carrier review" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "What happens during carrier review" }))
      .toBeVisible();
  });

  it("filters the grid from the search field and says so when nothing matches", async () => {
    const user = userEvent.setup();
    render(<CoachTips trainings={TRAININGS} />);

    const search = screen.getByRole("searchbox", { name: "Search the trainings" });
    await user.type(search, "guarantee");

    expect(screen.getByRole("heading", { name: "When a lead asks for a guarantee" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "What happens during carrier review" }))
      .not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "zzzz");

    expect(screen.getByRole("heading", { name: "Nothing matches that search" })).toBeVisible();
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
   * The drench budget: `docs/REDESIGN-CANVAS.md` allows at most two drenched panels and nothing
   * else filling. The artboard's saturated thumbnail is a block inside the featured card, not the
   * card itself, so no panel spends the budget and the screen's only accent fill is Watch now.
   */
  it("saturates the featured thumbnail without drenching a panel", () => {
    const { container } = render(<CoachTips trainings={TRAININGS} />);

    expect(container.querySelectorAll(".coach-panel")).toHaveLength(3);
    expect(container.querySelectorAll(".coach-panel[data-drench]")).toHaveLength(0);
    expect(container.querySelectorAll('[class*="coach-drench-info"]')).toHaveLength(1);

    const fills = container.querySelectorAll('[class*="--accent-fill"]');
    expect(fills, "one accent fill on the page, never two and never zero").toHaveLength(1);
    expect(fills[0].textContent).toContain("Watch now");
  });
});

/*
 * The featured training's card, which is the canvas's one banded-and-large panel.
 *
 * `CoachTips.dc.html:123` sets its name at 26px/500/-0.018em inside a real eyebrow+name band at
 * `padding: 17px 26px`, and draws the card itself at `24px 24px 17px 17px` -- the same radius as
 * the six cards under it. The code had exactly the opposite pair: `hero`, which only moves the
 * radius to 30px, and the ordinary 20px name. So both halves are asserted here, because fixing
 * either one alone leaves the card wrong in the other direction.
 */
describe("CoachTips featured card", () => {
  it("names the featured training at the artboard's hero size without enlarging its radius", () => {
    render(<CoachTips trainings={TRAININGS} />);

    const heading = screen.getByRole("heading", { name: "Writing prices your agent can quote" });
    // Positive control: this is the featured card and not one of the six in the grid below it,
    // which is what the eyebrow's "Start here" category and the card's own section identify.
    const card = heading.closest("section") as HTMLElement;
    expect(card).toHaveTextContent("Start here");

    // The band is still there -- this is the banded shape at a hero size, not the title-led one.
    expect(card.querySelector(".coach-panel__header")).not.toBeNull();
    expect(heading.className).toContain("text-[26px]!");
    expect(card).not.toHaveAttribute("data-hero");
  });
});
