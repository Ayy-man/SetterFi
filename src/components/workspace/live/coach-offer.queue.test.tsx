import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CoachOffer } from "@/components/workspace/live/coach-offer";
import type { PersistedOfferLayer } from "@/lib/offer/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

function offer(overrides: Partial<PersistedOfferLayer> = {}): PersistedOfferLayer {
  return {
    id: "offer-draft", tenantId: "t", status: "draft", version: 2, contentHash: "h",
    programName: "Funding program", programDescription: null,
    creditMin: 600, fundingGoalMinCents: 1, fundingGoalMaxCents: 2,
    monthlyRevenueMinCents: 3, businessRevenueRequired: true, creditRepair: null,
    products: [], bookingHorizonDays: 21, bookingMode: "direct", brandVoice: "friendly",
    resultsTimelineMinDays: null, resultsTimelineMaxDays: null, refundPosture: null,
    voiceStyleAnswer: "Warm.", voiceObjectionAnswer: null, voiceFollowupAnswer: null,
    offerPrices: [], proof: [], assets: [], cadencePurposes: [], ...overrides,
  };
}

describe("derived copy", () => {
  it("counts the header numeral and the managed strip from their lists, never a literal", () => {
    render(<CoachOffer initialState={{ draft: offer(), published: null }} />);
    expect(
      screen.getByText(
        /Four things are yours to set\. SetterFi handles everything else and keeps it current\./,
      ),
    ).toBeInTheDocument();
    // Nine, not seven: "When you take calls" and "Who gets hot leads" joined when screen 5c asked
    // for them as coach controls and neither turned out to have a column behind it, and then the
    // canvas pass added "The questions your agent asks" and "When it follows up, and when it
    // stops" -- both listed on `Agent.dc.html` as things SetterFi keeps current, both living in
    // the platform brain, which has no tenant column for a coach to write to.
    expect(screen.getByText(/Nine settings we run for you\./)).toBeInTheDocument();
    /*
     * The settings that DO have a coach writer are cards on this page, so they must not appear in
     * the managed section at all -- checked by text now rather than by button role, because the
     * redesign turned the managed entries from popover chips into statements. Asserting on the
     * button role would have started passing for the wrong reason the moment the chips went away,
     * which is the failure mode this line is here to prevent.
     */
    expect(screen.queryByText("Channel setup")).not.toBeInTheDocument();
    expect(screen.queryByText("Qualifying questions")).not.toBeInTheDocument();
    expect(screen.getByText("Reply timing")).toBeInTheDocument();
  });

  it("renders each threshold sentence from its number and marks the unset ones", () => {
    render(
      <CoachOffer
        initialState={{
          draft: offer({ monthlyRevenueMinCents: 1_000_000, creditMin: 640, creditRepair: null }),
          published: null,
        }}
      />,
    );
    expect(screen.getByText("Making under $10,000.00 a month")).toBeInTheDocument();
    expect(screen.getByText("Credit score below 640")).toBeInTheDocument();
    const unset = screen.getByText("Needs credit repair first").closest("li");
    expect(unset).toHaveAttribute("data-set", "false");
    expect(unset).toHaveTextContent("not set");
  });
});

describe("four open cards", () => {
  /*
   * The canvas's central move on this screen: `Agent.dc.html` draws four cards, all open, and no
   * tab rail. The old build was six `ChipTabs` and one open `TabsContent`, so this reads the four
   * card headings back and asserts there is no tablist left to hide five of them behind. The
   * in-page attention queue went with the rail: an unset card now says so on its own face, which
   * is `SIMPLIFICATION-SPEC.md` §2.4's MERGE ruling, and the escalation half of that queue became
   * the Inbox pill's count.
   */
  it("opens all four coach-owned cards at once with no tab rail", () => {
    render(<CoachOffer initialState={{ draft: offer(), published: null }} />);
    for (const title of [
      "What you charge",
      "Who is worth your time",
      "How your agent sounds",
      "Chasing a quiet lead",
    ]) {
      expect(screen.getByRole("region", { name: title })).toBeInTheDocument();
    }
    expect(screen.queryByRole("tablist", { name: "Agent sections" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
    // Both demoted sections are off the grid and behind the disclosure instead.
    expect(screen.queryByRole("region", { name: "Your program" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Marketing assets" })).not.toBeInTheDocument();
  });

  it("states on each card whether the coach has set it", () => {
    const { container } = render(
      <CoachOffer
        initialState={{
          draft: offer({
            offerPrices: [{ id: "p", label: "A", amountCents: 100, billingPeriod: "one_time" }],
          }),
          published: null,
        }}
      />,
    );
    const prices = screen.getByRole("region", { name: "What you charge" });
    expect(prices.querySelector('[data-slot="offer-card-state"]')).toHaveAttribute(
      "data-set",
      "true",
    );
    // Follow-up has no saved purpose on this draft, so its pill is the waiting one.
    const cadence = screen.getByRole("region", { name: "Chasing a quiet lead" });
    expect(cadence.querySelector('[data-slot="offer-card-state"]')).toHaveAttribute(
      "data-set",
      "false",
    );
    expect(container.querySelectorAll('[data-slot="offer-card-state"]')).toHaveLength(4);
  });
});

describe("what leads push back on", () => {
  const row = {
    objectionId: "o1",
    label: "It costs too much",
    conversationCount: 41,
    conversationHref: "/coach/conversations?objection=o1",
  };

  it("draws the meter and the percentage only where a rate exists", () => {
    const { container } = render(
      <CoachOffer
        initialState={{ draft: offer(), published: null }}
        objections={[
          { ...row, bookedRate: 0.62, absence: null },
          {
            objectionId: "o2",
            label: "My credit is not good enough",
            conversationCount: 33,
            bookedRate: null,
            absence: "Booked rate awaiting definition",
            conversationHref: "/coach/conversations?objection=o2",
          },
        ]}
      />,
    );
    const panel = screen.getByRole("region", { name: "What leads push back on" });
    expect(panel).toHaveTextContent("said 41 times");
    expect(panel).toHaveTextContent("62%");
    /*
     * The load-bearing half. `read_coach_top_objections_for_actor` returns a null rate for every
     * row while its attribution state reads `awaiting_definition`, so a second meter here would be
     * a bar drawn at zero for a number nobody has defined.
     */
    expect(panel).toHaveTextContent("Booked rate awaiting definition");
    expect(container.querySelectorAll('[data-slot="objection-meter"]')).toHaveLength(1);
  });

  it("renders nothing at all when the rollup is unavailable", () => {
    render(<CoachOffer initialState={{ draft: offer(), published: null }} />);
    expect(
      screen.queryByRole("region", { name: "What leads push back on" }),
    ).not.toBeInTheDocument();
  });
});
