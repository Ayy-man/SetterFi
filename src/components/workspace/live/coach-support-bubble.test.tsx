import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  COACH_SUPPORT_DEFAULT_QUESTIONS,
  CoachSupportBubble,
} from "@/components/workspace/live/coach-support-bubble";

/**
 * The bubble is a floating, non-modal helper, which is the hardest thing on the coach surface to
 * get right by eye: it is off-screen in every screenshot, it is the only thing on the page that a
 * keyboard user can be locked out of, and its three questions are the one place the product is
 * tempted to answer "when will texting work?" with a sentence instead of a link.
 */
describe("CoachSupportBubble", () => {
  it("starts closed and opens the panel from the launcher", async () => {
    const user = userEvent.setup();
    render(<CoachSupportBubble coachName="Marcus" />);

    // The positive control. Without it, every "is not in the document" below would pass against a
    // component stubbed to return null.
    const launcher = screen.getByRole("button", { name: "Get help" });
    expect(launcher).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(launcher);

    expect(screen.getByRole("dialog", { name: "Need a hand, Marcus?" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Close help" }))
      .toHaveAttribute("aria-expanded", "true");
  });

  /**
   * Catches the name being hard-coded back to one coach's, which is what the artboard does and
   * what a fast port copies. A workspace opened by a team member has no first name on this render,
   * and greeting them as Marcus is worse than greeting nobody.
   */
  it("greets nobody rather than a placeholder when no name is passed", async () => {
    const user = userEvent.setup();
    render(<CoachSupportBubble />);

    await user.click(screen.getByRole("button", { name: "Get help" }));

    expect(screen.getByRole("dialog", { name: "Need a hand?" })).toBeVisible();
    expect(screen.queryByText(/Marcus/u)).not.toBeInTheDocument();
  });

  /**
   * Catches the panel drifting from links to inline answers. The texting question in particular
   * must hand the coach to the screen that owns the real A2P day counter: any answer written here
   * would be either a number this component cannot see or the predicted date the product forbids.
   */
  it("sends every default question to a screen rather than answering it in the panel", async () => {
    const user = userEvent.setup();
    render(<CoachSupportBubble defaultOpen />);

    for (const question of COACH_SUPPORT_DEFAULT_QUESTIONS) {
      const link = screen.getByRole("link", { name: question.question });
      expect(link).toHaveAttribute("href", question.href);
    }
    const texting = screen.getByRole("link", { name: "When will texting start working?" });
    expect(texting).toHaveAttribute("href", "/coach/get-started");

    // Nothing in the panel predicts a date or claims a share of the wait is done.
    expect(screen.queryByText(/%/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/week|day|all set/iu)).not.toBeInTheDocument();

    await user.click(texting);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("takes its questions from props so the list is not baked into the component", () => {
    render(
      <CoachSupportBubble
        defaultOpen
        questions={[{ id: "one", question: "Can I pause my agent?", href: "/coach/agent" }]}
      />,
    );

    expect(screen.getByRole("link", { name: "Can I pause my agent?" }))
      .toHaveAttribute("href", "/coach/agent");
    expect(screen.queryByRole("link", { name: "Why did my agent turn a lead away?" }))
      .not.toBeInTheDocument();
  });

  /**
   * Catches a support-response promise being reintroduced. The artboard prints "Someone replies
   * within the hour" and nothing in the codebase or the copy files records an SLA, a first-response
   * target, or staffed hours -- so the sentence would be the product committing a support team that
   * has never agreed to it. If a real number is ever written down, this test is what has to change
   * with it.
   */
  it("makes no promise about how fast support replies", () => {
    render(<CoachSupportBubble defaultOpen />);

    expect(screen.getByRole("link", { name: /Message a person/u })).toBeVisible();
    expect(screen.queryByText(/within the hour/iu)).not.toBeInTheDocument();
    expect(screen.queryByText(/replies? within/iu)).not.toBeInTheDocument();
  });

  it("links out to the trainings surface and to the support threads", () => {
    render(<CoachSupportBubble defaultOpen />);

    expect(screen.getByRole("link", { name: "Tips and trainings" }))
      .toHaveAttribute("href", "/coach/tips");
    expect(screen.getByRole("link", { name: /Message a person/u }))
      .toHaveAttribute("href", "/coach/help");
  });

  /**
   * Catches the panel becoming keyboard-unreachable or keyboard-inescapable, which is the failure
   * a floating overlay reaches first. Escape is bound to the document rather than to the panel
   * precisely because the panel is not a focus trap, so this also catches someone "tidying" that
   * listener onto the panel element.
   */
  it("closes on Escape and hands focus back to the launcher", async () => {
    const user = userEvent.setup();
    render(<CoachSupportBubble coachName="Marcus" />);

    const launcher = screen.getByRole("button", { name: "Get help" });
    await user.click(launcher);
    expect(screen.getByRole("dialog")).toBeVisible();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Get help" })).toHaveFocus();
  });

  /**
   * Catches the One Fill Rule being spent twice. The artboard fills both the launcher and "Message
   * a person" while the panel is open, which splits the emphasis between the action and the thing
   * that dismisses it; the launcher gives the fill up on open instead.
   */
  it("spends exactly one accent fill in each state", async () => {
    const user = userEvent.setup();
    const { container } = render(<CoachSupportBubble />);

    const closedFills = container.querySelectorAll('[class*="--accent-fill"]');
    expect(closedFills, "the launcher carries the fill while the panel is shut").toHaveLength(1);
    expect(closedFills[0]).toHaveAttribute("data-slot", "coach-support-launcher");

    await user.click(screen.getByRole("button", { name: "Get help" }));

    const openFills = container.querySelectorAll('[class*="--accent-fill"]');
    expect(openFills, "the fill moves to the action, it does not multiply").toHaveLength(1);
    expect(openFills[0].textContent).toContain("Message a person");
  });

  /**
   * Catches the entry animation being made unconditional. `motion-safe:` is the only reason a
   * reader who asked their system for less motion gets a panel that is simply there; an
   * `animate-in` written without the prefix would animate for everyone.
   */
  it("only animates the panel in under motion-safe", () => {
    render(<CoachSupportBubble defaultOpen />);

    const panel = screen.getByRole("dialog");
    const animating = Array.from(panel.classList).filter((name) =>
      name.includes("animate-in") || name.includes("fade-in") || name.includes("slide-in"));
    expect(animating.length, "the panel does animate in").toBeGreaterThan(0);
    for (const name of animating) {
      expect(name, `${name} is not gated on motion-safe`).toMatch(/^motion-safe:/u);
    }
  });
});
