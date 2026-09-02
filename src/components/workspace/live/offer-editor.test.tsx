import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AvailabilityPanel,
  weeklySlotCount,
  type DayAvailability,
} from "@/components/workspace/live/offer-editor-availability";
import {
  DisqualifiersPanel,
  type DisqualifierLine,
} from "@/components/workspace/live/offer-editor-disqualifiers";
import {
  HandoffPanel,
  type HandoffCandidate,
} from "@/components/workspace/live/offer-editor-handoff";
import {
  PricesPanel,
  priceSampleReply,
} from "@/components/workspace/live/offer-editor-prices";
import { VoicePanel } from "@/components/workspace/live/offer-editor-voice";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const PRICES = [
  { label: "Setup", amountCents: 400_000, billingPeriod: "one_time" as const },
  { label: "Retainer", amountCents: 150_000, billingPeriod: "monthly" as const },
];

const LINES: DisqualifierLine[] = [
  { key: "creditMin", text: "Credit score below 600", set: true },
  { key: "monthlyRevenueMinCents", text: "Making under your monthly minimum", set: false },
];

const WEEK: DayAvailability[] = [
  { label: "Mon", open: true, startMinutes: 9 * 60, endMinutes: 16 * 60 },
  { label: "Tue", open: true, startMinutes: 9 * 60, endMinutes: 16 * 60 },
  { label: "Wed", open: false, startMinutes: null, endMinutes: null },
];

const TEAM: HandoffCandidate[] = [
  { id: "dana", name: "Dana Whitfield", role: "You", replyEta: "replies in about 12 minutes" },
  { id: "marcus", name: "Marcus Reyes", role: "Sales", replyEta: null },
];

describe("the prices preview quotes the saved figures and never invents one", () => {
  it("builds the sentence out of the exact stored cents", () => {
    const sample = priceSampleReply(PRICES);
    expect(sample).toContain("$4,000.00 to get set up");
    expect(sample).toContain("$1,500.00 a month");
  });

  it("states no number at all when nothing is saved", () => {
    // The pricing gate refuses an invented figure, so an empty editor's preview has to refuse one
    // too. A placeholder price here would be the exact hallucination the gate exists to stop.
    expect(priceSampleReply([])).not.toMatch(/\$\s?\d/u);
    expect(priceSampleReply([])).toContain("exact number");
  });

  it("regenerates the preview from the rows above it", () => {
    const { rerender } = render(
      <PricesPanel prices={PRICES}>
        <p>row editor</p>
      </PricesPanel>,
    );

    const sample = screen.getByRole("region", { name: "What it will say" });
    expect(within(sample).getByText(/\$4,000\.00 to get set up/u)).toBeInTheDocument();

    rerender(
      <PricesPanel
        prices={[{ ...PRICES[0], amountCents: 500_000 }, PRICES[1]]}
      >
        <p>row editor</p>
      </PricesPanel>,
    );
    expect(within(sample).getByText(/\$5,000\.00 to get set up/u)).toBeInTheDocument();
  });

  it("prints the platform's pricing answers rather than switches that save nothing", () => {
    render(
      <PricesPanel prices={PRICES}>
        <p>row editor</p>
      </PricesPanel>,
    );

    expect(screen.getByText("May quote a range")).toBeInTheDocument();
    expect(screen.getByText("May invent a figure")).toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: "May quote a range" }),
      "a switch here would claim a coach-writable column that does not exist",
    ).toBeNull();
  });

  it("keeps the page's own row controls", () => {
    render(
      <PricesPanel prices={PRICES}>
        <button type="button">Add price</button>
      </PricesPanel>,
    );
    expect(screen.getByRole("button", { name: "Add price" })).toBeInTheDocument();
  });
});

describe("the disqualifier readout suggests what a rule looks like", () => {
  it("rotates through the examples on its own clock", () => {
    vi.useFakeTimers();
    render(
      <DisqualifiersPanel lines={LINES}>
        <p>fields</p>
      </DisqualifiersPanel>,
    );

    const first = screen.getByText(/^e\.g\./u).textContent;
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByText(/^e\.g\./u).textContent).not.toBe(first);
  });

  it("marks the unset lines and counts the set ones", () => {
    render(
      <DisqualifiersPanel lines={LINES}>
        <p>fields</p>
      </DisqualifiersPanel>,
    );

    expect(screen.getByText("Credit score below 600")).toBeInTheDocument();
    expect(screen.getByText("not set")).toBeInTheDocument();
    expect(screen.getByText("1 of 2 set")).toBeInTheDocument();
  });

  it("offers no field for a rule nothing can store", () => {
    render(
      <DisqualifiersPanel lines={LINES}>
        <p>fields</p>
      </DisqualifiersPanel>,
    );
    expect(
      screen.queryByRole("textbox", { name: /rule/iu }),
      "a free-text rule box would take a sentence no column holds",
    ).toBeNull();
    expect(screen.getByText(/goes to your success owner/u)).toBeInTheDocument();
  });
});

describe("reduced motion stops the rotating suggestion", () => {
  it("holds the first example however long the clock runs", async () => {
    vi.resetModules();
    vi.doMock("motion/react", () => ({ useReducedMotion: () => true }));
    const { DisqualifiersPanel: Reduced } = await import(
      "@/components/workspace/live/offer-editor-disqualifiers"
    );

    vi.useFakeTimers();
    render(
      <Reduced lines={LINES}>
        <p>fields</p>
      </Reduced>,
    );
    const first = screen.getByText(/^e\.g\./u).textContent;

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(screen.getByText(/^e\.g\./u).textContent).toBe(first);
    vi.doUnmock("motion/react");
    vi.resetModules();
  });
});

describe("the voice panel reads back the coach's own words", () => {
  it("shows the saved sentence and never composes an agent reply", () => {
    render(
      <VoicePanel
        brandVoice="neutral"
        onBrandVoiceChange={() => {}}
        styleAnswer="Warm and direct."
        writtenCount={1}
      >
        <p>answers</p>
      </VoicePanel>,
    );

    const sample = screen.getByRole("region", { name: "Live sample" });
    expect(within(sample).getByText("Warm and direct.")).toBeInTheDocument();
    expect(within(sample).getByText("balanced")).toBeInTheDocument();
    expect(within(sample).queryByText(/payment plans/iu)).toBeNull();
  });

  it("moves the register along one track and says what each stop means", () => {
    const onBrandVoiceChange = vi.fn();
    render(
      <VoicePanel
        brandVoice="neutral"
        onBrandVoiceChange={onBrandVoiceChange}
        styleAnswer={null}
        writtenCount={0}
      >
        <p>answers</p>
      </VoicePanel>,
    );

    expect(screen.getByText(/Warm enough to answer/u)).toBeInTheDocument();
    const track = screen.getByLabelText("Brand voice");
    fireEvent.change(track, { target: { value: "2" } });
    expect(onBrandVoiceChange).toHaveBeenCalledWith("friendly");
  });

  it("advises against the friendliest register without removing it", () => {
    render(
      <VoicePanel
        brandVoice="friendly"
        onBrandVoiceChange={() => {}}
        styleAnswer="Warm."
        writtenCount={1}
      >
        <p>answers</p>
      </VoicePanel>,
    );

    expect(screen.getByText(/lower booking rates/u)).toBeInTheDocument();
    expect(screen.getByLabelText("Brand voice")).toBeEnabled();
  });
});

describe("the availability readout reports the calendar rather than owning it", () => {
  it("marks the bookable cells and states the calendar's own settings", () => {
    render(
      <AvailabilityPanel
        calendar={{
          calendarName: "Discovery calls",
          minNoticeMinutes: 240,
          slotDurationMinutes: 30,
          timezone: "America/Chicago",
        }}
        calendarHref="/coach/integrations"
        exceptions={[]}
        week={WEEK}
      />,
    );

    expect(screen.getByText("Mon 9am bookable")).toBeInTheDocument();
    expect(screen.getByText("Wed 9am closed")).toBeInTheDocument();
    expect(screen.getByText("America/Chicago")).toBeInTheDocument();
    expect(screen.getByText("30 minutes")).toBeInTheDocument();
    expect(screen.getByText("4 hours")).toBeInTheDocument();
    expect(screen.getByText("28 slots")).toBeInTheDocument();
  });

  it("counts a week of slots from the hours and the slot length", () => {
    expect(weeklySlotCount(WEEK, 30)).toBe(28);
    expect(weeklySlotCount(WEEK, 60)).toBe(14);
  });

  it("offers no control for hours SetterFi does not store", () => {
    render(
      <AvailabilityPanel
        calendar={{
          calendarName: "Discovery calls",
          minNoticeMinutes: 240,
          slotDurationMinutes: 30,
          timezone: "America/Chicago",
        }}
        calendarHref="/coach/integrations"
        exceptions={[]}
        week={WEEK}
      />,
    );

    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText(/not a second copy we keep/u)).toBeInTheDocument();
  });

  it("says why there is nothing to draw when no calendar is connected", () => {
    render(
      <AvailabilityPanel calendar={null} calendarHref={null} exceptions={[]} week={[]} />,
    );

    expect(screen.getByText("No calendar is connected yet")).toBeInTheDocument();
    expect(screen.getAllByText("not connected").length).toBeGreaterThan(0);
  });
});

describe("the handoff roster only picks when something can store the pick", () => {
  it("reads as a roster, with the truth stated, when no owner can be saved", () => {
    render(
      <HandoffPanel
        candidates={TEAM}
        escalationCount={3}
        notify="sms"
        ownerId={null}
      />,
    );

    expect(screen.getByText(/Right now 3 threads are waiting/u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /as owner/u })).toBeNull();
    expect(screen.getByText(/no standing owner to set/u)).toBeInTheDocument();
  });

  it("commits the chosen teammate when a writer is supplied", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <HandoffPanel
        candidates={TEAM}
        escalationCount={1}
        notify="sms"
        onConfirm={onConfirm}
        ownerId={null}
      />,
    );

    expect(screen.getByText(/Right now 1 thread is waiting/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Marcus Reyes/u }));
    await user.click(screen.getByRole("button", { name: "Set Marcus as owner" }));
    expect(onConfirm).toHaveBeenCalledWith("marcus");
  });
});
