import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoachAgentPreview } from "@/components/workspace/live/coach-agent-preview";

/*
 * The screen a coach sees at /meet-agent.
 *
 * Two things are worth guarding here and the rest is layout. The first is that the page says three
 * separate times that the conversation is written, because a demonstration a reader takes for
 * their own agent's work is a lie however carefully the markup is arranged -- and the artboard's
 * own footnote ("Logged. This run is kept on your account so you can show anyone what your agent
 * said") is exactly that lie, so its absence is asserted rather than left to whoever reads the
 * file next. The second is that the two numbers the explanation cites are the coach's own or are
 * not printed at all.
 */
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

const RULES = { creditFloor: 640, minimumRaiseCents: 2_500_000 };

describe("CoachAgentPreview provenance", () => {
  it("says the lead is made up before the conversation, not after it", () => {
    const { container } = render(<CoachAgentPreview rules={RULES} />);

    const chip = container.querySelector('[data-slot="preview-provenance"]')!;
    expect(chip).toHaveTextContent("SAMPLE LEAD · NOT A REAL CONVERSATION");
    // Before the title, so it is read on the way to the conversation rather than under it.
    expect(chip.compareDocumentPosition(screen.getByRole("heading", { level: 1 })))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("never claims the run is kept on the coach's account", () => {
    const { container } = render(<CoachAgentPreview rules={RULES} />);

    expect(container.textContent).not.toContain("Logged.");
    expect(container.textContent).not.toContain("kept on your account");
    expect(screen.getByText(/A written demonstration, not a recording of your own agent/u))
      .toBeInTheDocument();
  });

  it("keeps the lead sentence's promise that none of it counts", () => {
    render(<CoachAgentPreview rules={RULES} />);
    expect(screen.getByText(/none of it counts in your numbers/u)).toBeInTheDocument();
  });

  /*
   * The artboard's sentence, "This is your real setup answering a made-up lead", is the one line
   * on this screen that claims more than the screen has: the replies are constants. These three
   * pin the replacement in both directions -- the false claim is gone, and what is left names the
   * written part and the real part separately rather than hedging with "partly".
   */
  it("never claims the replies came from the coach's setup", () => {
    const { container } = render(<CoachAgentPreview rules={RULES} />);
    expect(container.textContent).not.toContain("your real setup answering");
  });

  it("names the written part and the one real part when rules are published", () => {
    const { container } = render(<CoachAgentPreview rules={RULES} />);
    const lead = container.querySelector('[data-slot="preview-lead"]')!;

    expect(lead).toHaveTextContent("Both sides of this conversation are written");
    expect(lead).toHaveTextContent("the lead and the replies");
    // The real part is named, and named as the step the reader can go and check.
    expect(lead).toHaveTextContent("the rules it checks in step 3");
    expect(lead).toHaveTextContent("your score floor and your smallest raise");
  });

  it("says there is no real part at all when nothing is published", () => {
    const { container } = render(
      <CoachAgentPreview rules={{ creditFloor: null, minimumRaiseCents: null }} />,
    );
    const lead = container.querySelector('[data-slot="preview-lead"]')!;

    expect(lead).toHaveTextContent("Both sides of this conversation are written");
    expect(lead).toHaveTextContent("none of it is reading your own setup");
    expect(lead).not.toHaveTextContent("step 3");
  });
});

describe("CoachAgentPreview explanation", () => {
  it("cites the coach's own published rules when there are some", () => {
    const { container } = render(<CoachAgentPreview rules={RULES} />);
    const steps = container.querySelector('[data-slot="preview-steps"]')!;

    expect(steps).toHaveTextContent("a 640 score floor and a $25,000 smallest raise");
    expect(within(steps as HTMLElement).getByText("Decided she qualifies")).toBeInTheDocument();
  });

  it("prints no floor at all rather than the artboard's, when nothing is published", () => {
    const { container } = render(
      <CoachAgentPreview rules={{ creditFloor: null, minimumRaiseCents: null }} />,
    );
    const steps = container.querySelector('[data-slot="preview-steps"]')!;

    expect(steps).not.toHaveTextContent("640");
    expect(steps).not.toHaveTextContent("$25,000");
    expect(steps).toHaveTextContent("You have not published any yet");
  });

  it("counts the steps from the list rather than from a written number", () => {
    const { container } = render(<CoachAgentPreview rules={RULES} />);
    const steps = container.querySelector('[data-slot="preview-steps"]')!;

    expect(steps.querySelectorAll("li")).toHaveLength(6);
    expect(steps).toHaveTextContent("6 steps");
  });

  it("names the coach in the one script line about them, and nobody when it cannot", () => {
    const named = render(<CoachAgentPreview coachName="Marcus" rules={RULES} />);
    expect(named.container).toHaveTextContent("What Marcus does is get your file");
    named.unmount();

    const anonymous = render(<CoachAgentPreview rules={RULES} />);
    expect(anonymous.container).toHaveTextContent("What your coach does is get your file");
    expect(anonymous.container).not.toHaveTextContent("{coach}");
  });
});

describe("CoachAgentPreview playback", () => {
  it("arrives complete, so nothing has to be waited for to be read", () => {
    const { container } = render(<CoachAgentPreview rules={RULES} />);
    const conversation = container.querySelector('[data-slot="preview-conversation"]')!;

    expect(conversation.querySelectorAll("li")).toHaveLength(5);
    expect(conversation).not.toHaveTextContent("Playing");
  });

  it("replays on request and ends back at the whole conversation", () => {
    const { container } = render(<CoachAgentPreview rules={RULES} />);

    fireEvent.click(screen.getByRole("button", { name: "Play it again" }));
    const conversation = container.querySelector('[data-slot="preview-conversation"]')!;
    expect(conversation.querySelectorAll("li")).toHaveLength(1);
    expect(conversation).toHaveTextContent("Playing");

    act(() => {
      vi.advanceTimersByTime(5_000);
    });

    expect(conversation.querySelectorAll("li")).toHaveLength(5);
    expect(conversation).not.toHaveTextContent("Playing");
  });

  it("gives a reader who asked for less motion the whole thing at once", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      addEventListener: () => {},
      removeEventListener: () => {},
    }));

    const { container } = render(<CoachAgentPreview rules={RULES} />);
    fireEvent.click(screen.getByRole("button", { name: "Play it again" }));

    expect(container.querySelector('[data-slot="preview-conversation"]')!.querySelectorAll("li"))
      .toHaveLength(5);
    vi.unstubAllGlobals();
  });
});

describe("CoachAgentPreview go-live band", () => {
  it("links to the step that owns going live rather than firing it from a preview", () => {
    const { container } = render(<CoachAgentPreview rules={RULES} />);
    const band = container.querySelector('[data-slot="preview-go-live"]')!;

    expect(within(band as HTMLElement).getAllByRole("link").map((link) => link.getAttribute("href")))
      .toEqual(["/coach/agent", "/coach/get-started"]);
    expect(within(band as HTMLElement).queryByRole("button")).toBeNull();
  });

  it("does not promise texting before the carriers have answered", () => {
    const { container } = render(<CoachAgentPreview rules={RULES} />);
    const band = container.querySelector('[data-slot="preview-go-live"]')!;

    expect(band).toHaveTextContent("Text messaging joins on its own once carrier review finishes");
  });
});

/*
 * The go-live band, which is the worst site of the two-card-shapes finding.
 *
 * `MeetYourAgent.dc.html:213` draws it as a flat drenched row at `22px 26px` with
 * `align-items: center`: the title and its sentence on the left, the two choices hard right
 * against them. It shipped through `DeckPanel`, so it took a 78px eyebrow band across the top and
 * the two choices dropped a block below their own title -- on the one panel in the product where
 * the title and the decision are the same sentence.
 *
 * This reads the anatomy rather than the padding. A band that came back would be caught by the
 * first assertion whatever it was padded with, and choices that fell out of the head row would be
 * caught by the second even if the band stayed gone.
 */
describe("CoachAgentPreview go-live band", () => {
  it("puts the decision beside its own title, on a panel with no header band", () => {
    const { container } = render(<CoachAgentPreview rules={RULES} />);

    const panel = container.querySelector('[data-slot="preview-go-live"]') as HTMLElement;
    // Positive control: the panel is rendered and is the one this test means, so the absence
    // asserted next is an absence inside it.
    expect(panel).toHaveTextContent("Ready when you are");
    expect(panel.querySelector(".coach-panel__header")).toBeNull();

    const heading = within(panel).getByRole("heading", { name: "Ready when you are" });
    const head = heading.parentElement!.parentElement!;
    expect(head.contains(within(panel).getByRole("link", { name: /go live/u }))).toBe(true);
    expect(head.contains(within(panel).getByRole("link", { name: "Change something first" })))
      .toBe(true);
  });
});
