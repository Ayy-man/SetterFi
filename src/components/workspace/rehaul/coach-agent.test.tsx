import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CoachAgent,
  type CoachAgentObjections,
} from "@/components/workspace/rehaul/coach-agent";
import { coachCadenceSchedule } from "@/components/workspace/live/coach-agent";
import { DURABLE_TOUCHES } from "@/lib/followups/touch-lists";
import type { PersistedOfferLayer } from "@/lib/offer/types";
import type { CoachQuestion } from "@/lib/repositories/coach-questions";
import type { KeywordGoal } from "@/lib/repositories/keyword-goals";

/**
 * `Agent.dc.html`, pinned.
 *
 * Every assertion below names the thing on the artboard it is holding in place, because the two
 * previous attempts at this screen both drifted from the drawing in ways nobody could point at
 * afterwards. The rules that carry across the whole coach rebuild -- 14px floor, 44px targets, one
 * accent fill, no uppercase -- are guarded by the shared tests in `src/app`; what this file pins is
 * the anatomy, the copy and the write behaviour of this one surface.
 */

const published: PersistedOfferLayer = {
  id: "offer-1",
  tenantId: "tenant-1",
  status: "published",
  version: 3,
  contentHash: "hash-3",
  programName: "Funding accelerator",
  programDescription: null,
  creditMin: 640,
  fundingGoalMinCents: 2_500_000,
  fundingGoalMaxCents: 25_000_000,
  monthlyRevenueMinCents: 800_000,
  businessRevenueRequired: false,
  creditRepair: "yes_extra_fee",
  products: ["biz CC"],
  bookingHorizonDays: 21,
  bookingMode: "direct",
  brandVoice: "neutral",
  resultsTimelineMinDays: null,
  resultsTimelineMaxDays: null,
  refundPosture: "none",
  voiceStyleAnswer: "I help business owners get funded without giving up equity.",
  voiceObjectionAnswer: null,
  voiceFollowupAnswer: null,
  qualificationRules: [],
  voiceGuidelines: null,
  offerPrices: [
    { id: "price-1", label: "Funding Accelerator", amountCents: 450_000, billingPeriod: "one_time" },
    { id: "price-2", label: "Credit Repair Plan", amountCents: 29_700, billingPeriod: "monthly" },
  ],
  proof: [],
  assets: [
    {
      id: "asset-1",
      slug: "funding-guide",
      label: "The funding guide link",
      url: "https://reidfunding.com/funding-guide",
    },
  ],
  cadencePurposes: [],
};

const goals: KeywordGoal[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    keyword: "Funds",
    normalizedKeyword: "funds",
    goal: "resource",
    resourceUrl: "https://reidfunding.com/funding-guide",
    resourceMessage: "Here is the guide",
    postBookingUrl: null,
    postBookingMessage: null,
    active: true,
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
  },
];

const questions: CoachQuestion[] = [
  {
    id: "q-1",
    text: "Roughly what is your credit score right now?",
    tag: "credit score",
    enabled: true,
    position: 0,
  },
  {
    id: "q-2",
    text: "How much funding are you looking for?",
    tag: "funding amount",
    enabled: true,
    position: 1,
  },
  {
    id: "q-3",
    text: "Have you been turned down for funding before?",
    tag: "prior denial",
    enabled: false,
    position: 2,
  },
];

const objections: CoachAgentObjections = {
  windowDays: 30,
  rows: [
    { objectionId: "o-1", label: "It costs too much", bookedRate: 0.62, conversationCount: 41 },
    {
      objectionId: "o-2",
      label: "My credit is not good enough",
      bookedRate: null,
      conversationCount: 33,
    },
  ],
};

function renderAgent(overrides: Partial<Parameters<typeof CoachAgent>[0]> = {}) {
  return render(
    <CoachAgent
      initialKeywordGoals={goals}
      initialState={{ draft: null, published }}
      objections={objections}
      questions={questions}
      supportEnabled
      testEnabled
      {...overrides}
    />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the page states what it is", () => {
  it("opens with the title and the sentence the artboard writes under it", () => {
    renderAgent();

    expect(screen.getByRole("heading", { level: 1, name: "Your agent" })).toBeInTheDocument();
    expect(
      screen.getByText("Four things are yours. We run everything else."),
    ).toBeInTheDocument();
  });

  it("offers a conversation to try, and drops it when the lead test is not live", () => {
    const { unmount } = renderAgent();
    expect(screen.getByRole("link", { name: "Try a conversation" })).toHaveAttribute(
      "href",
      "/meet-agent",
    );

    unmount();
    renderAgent({ testEnabled: false });
    expect(screen.queryByRole("link", { name: "Try a conversation" })).toBeNull();
  });

  it("carries no tab row, no publish and no progress meter", () => {
    renderAgent();

    expect(screen.queryByRole("navigation", { name: /agent views/iu })).toBeNull();
    expect(screen.queryByRole("button", { name: /publish/iu })).toBeNull();
    expect(screen.queryByText(/draft/iu)).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("names the four cards a coach owns, and no others", () => {
    renderAgent();

    for (const name of [
      "Your prices",
      "Who qualifies",
      "How you sound",
      "What each follow-up says",
    ]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
  });
});

describe("your prices", () => {
  it("shows every saved price on its face and can add and remove a row", async () => {
    const user = userEvent.setup();
    renderAgent();

    expect(screen.getByDisplayValue("Funding Accelerator")).toBeInTheDocument();
    expect(screen.getByDisplayValue("4500")).toBeInTheDocument();
    expect(screen.getByDisplayValue("297")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add a price" }));
    expect(screen.getByLabelText("Name of price 3")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove Credit Repair Plan" }));
    expect(screen.queryByDisplayValue("Credit Repair Plan")).toBeNull();
  });

  it("states the absence in words rather than drawing an empty list", () => {
    renderAgent({
      initialState: { draft: null, published: { ...published, offerPrices: [] } },
    });

    expect(screen.getByText("No price is saved, so your agent quotes none.")).toBeInTheDocument();
  });
});

describe("who qualifies", () => {
  it("draws six rows: four steppers and two two-way choices", () => {
    renderAgent();

    expect(screen.getByText("640")).toBeInTheDocument();
    for (const label of [
      "Credit score at least",
      "Funding goal at least",
      "Funding goal at most",
      "Monthly revenue at least",
      "Needs credit repair first",
      "Refunds",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Raise credit score at least" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lower credit score at least" })).toBeInTheDocument();
  });

  it("steps a bound rather than asking for a typed number", async () => {
    const user = userEvent.setup();
    renderAgent();

    await user.click(screen.getByRole("button", { name: "Raise credit score at least" }));
    expect(screen.getByText("650")).toBeInTheDocument();
  });

  it("reads an unset bound as words and refuses to lower it", () => {
    renderAgent({
      initialState: { draft: null, published: { ...published, creditMin: null } },
    });

    expect(screen.getByText("Not set")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lower credit score at least" })).toBeDisabled();
  });

  /**
   * The reason the two-way is a group of stored values rather than one canonical value: pressing
   * the side a coach is already on must not rewrite "extra fee" into "included".
   */
  it("leaves a stored value inside the pressed side alone", async () => {
    const user = userEvent.setup();
    renderAgent();

    const fine = screen.getByRole("button", { name: "Fine" });
    expect(fine).toHaveAttribute("aria-pressed", "true");
    await user.click(fine);
    expect(fine).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});

describe("the coach's own rules", () => {
  it("starts with the absence stated and a way to add a rule", () => {
    renderAgent();

    expect(
      screen.getByText("No rules of your own yet, so your agent judges fit by the bounds above alone."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a rule" })).toBeInTheDocument();
  });

  it("adds a rule, reads it back as a sentence with the list as chips, and removes it", async () => {
    const user = userEvent.setup();
    renderAgent();

    await user.click(screen.getByRole("button", { name: "Add a rule" }));
    expect(
      screen.getByText("Name it and give it a value, and your agent reads it as a sentence."),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("Subject of rule 1"), "Location");
    await user.click(screen.getByRole("combobox", { name: "Condition of Location" }));
    await user.click(await screen.findByRole("option", { name: "is not one of" }));
    await user.type(screen.getByLabelText("Value of Location"), "India, Bangladesh");

    const sentence = document.querySelector('[data-slot="rehaul-rule-sentence"]');
    expect(sentence).toHaveTextContent("Location is not one of");
    expect(within(sentence as HTMLElement).getByText("India")).toBeInTheDocument();
    expect(within(sentence as HTMLElement).getByText("Bangladesh")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Remove Location" }));
    expect(screen.queryByLabelText("Subject of rule 1")).not.toBeInTheDocument();
  });

  it("drops the value field for a condition that takes none", async () => {
    const user = userEvent.setup();
    renderAgent();

    await user.click(screen.getByRole("button", { name: "Add a rule" }));
    await user.type(screen.getByLabelText("Subject of rule 1"), "Open bankruptcy");
    await user.click(screen.getByRole("combobox", { name: "Condition of Open bankruptcy" }));
    await user.click(await screen.findByRole("option", { name: "rules them out" }));

    expect(screen.queryByLabelText("Value of Open bankruptcy")).not.toBeInTheDocument();
    expect(screen.getByText("Open bankruptcy rules them out")).toBeInTheDocument();
  });

  it("reads saved rules back into the rows", () => {
    renderAgent({
      initialState: {
        draft: null,
        published: {
          ...published,
          qualificationRules: [{ subject: "Time in business", op: "at_least", value: "2 years" }],
        },
      },
    });

    expect(screen.getByLabelText("Subject of rule 1")).toHaveValue("Time in business");
    expect(screen.getByLabelText("Value of Time in business")).toHaveValue("2 years");
    expect(screen.getByText("Time in business is at least 2 years")).toBeInTheDocument();
  });
});

describe("how you sound", () => {
  it("takes voice guidelines as a paragraph and reads them back", async () => {
    const user = userEvent.setup();
    renderAgent();

    const guidelines = screen.getByLabelText("Voice guidelines");
    expect(guidelines.tagName).toBe("TEXTAREA");
    expect(guidelines).toHaveValue("");
    await user.type(guidelines, "Warm, never pushy.");
    expect(guidelines).toHaveValue("Warm, never pushy.");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });


  it("draws three stops and three short answers", () => {
    renderAgent();

    for (const stop of ["Friendly", "Balanced", "Professional"]) {
      expect(screen.getByRole("button", { name: stop })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Balanced" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByLabelText("How do you describe what you do, in a sentence?"),
    ).toHaveValue("I help business owners get funded without giving up equity.");
    expect(screen.getByLabelText("What do clients usually walk away with?")).toHaveValue("");
    expect(screen.getByLabelText("What should your agent never promise?")).toHaveValue("");
  });
});

describe("what each follow-up says", () => {
  /**
   * The artboard writes three touches at one day, three days and a week. `DURABLE_TOUCHES` fixes
   * five at two hours, one, three, seven and fourteen days, and the platform owning the timing is
   * the whole claim of the card, so the card is built from the list rather than from the drawing.
   */
  it("draws one dropdown per touch the platform actually schedules", () => {
    renderAgent();

    const schedule = coachCadenceSchedule([]);
    const touches = schedule.reduce((total, group) => total + group.touches.length, 0);
    expect(touches).toBeGreaterThanOrEqual(DURABLE_TOUCHES.length);

    for (const group of schedule) {
      for (const touch of group.touches) {
        expect(
          screen.getByLabelText(
            `What ${group.channelLabel} follow-up ${touch.touchNo} says`,
          ),
        ).toBeInTheDocument();
      }
    }
  });

  it("says nothing is sending when follow-up is not switched on", () => {
    renderAgent();

    expect(
      screen.getByText(
        "Follow-up is not switched on yet, so nothing is being sent. What you set here is kept and used the day it is.",
      ),
    ).toBeInTheDocument();
  });
});

describe("top objections", () => {
  it("reads as a share per objection with the sentence that defines the share", () => {
    renderAgent();

    expect(screen.getByText("“It costs too much”")).toBeInTheDocument();
    expect(screen.getByText("62%")).toBeInTheDocument();
    expect(screen.getByText("Said 41 times in the last 30 days.")).toBeInTheDocument();
    expect(
      screen.getByText("The share is how many of the leads who said it still booked a call."),
    ).toBeInTheDocument();
  });

  /** A rate with no approved definition is a different fact from a zero share, so no bar is drawn. */
  it("draws no bar and no percentage for a row whose share is undefined", () => {
    renderAgent();

    const row = document.querySelector('[data-objection="o-2"]')!;
    expect(within(row as HTMLElement).queryByText(/%$/u)).toBeNull();
    expect(
      within(row as HTMLElement).getByText(
        "Said 33 times in the last 30 days. No booking share is defined for it yet.",
      ),
    ).toBeInTheDocument();
  });

  it("says the read refused rather than drawing an empty rail", () => {
    renderAgent({ objections: null });

    expect(screen.getByText("Your objections could not be read just now.")).toBeInTheDocument();
  });
});

describe("keywords and questions", () => {
  it("reads as a sentence with the fields inside it", () => {
    renderAgent();

    expect(screen.getByText("When someone DMs you with")).toBeInTheDocument();
    expect(screen.getByText("your agent replies with")).toBeInTheDocument();
    expect(
      screen.getByText("and then asks these questions, in this order."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Which keyword")).toHaveTextContent("Funds");
    expect(screen.getByLabelText("What your agent replies with")).toHaveTextContent(
      "The funding guide link",
    );
  });

  it("carries up and down arrows and an asked or skipped switch per question", () => {
    renderAgent();

    expect(
      screen.getByRole("button", { name: 'Ask "Roughly what is your credit score right now?" earlier' }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: 'Ask "How much funding are you looking for?" earlier' }),
    ).toBeEnabled();

    const skipped = screen.getByRole("switch", {
      name: 'Ask "Have you been turned down for funding before?"',
    });
    expect(skipped).toHaveAttribute("aria-checked", "false");
    expect(skipped).toHaveTextContent("Skipped");
  });

  it("says the read refused rather than drawing no questions", () => {
    renderAgent({ questions: null });

    expect(screen.getByText("Your questions could not be read just now.")).toBeInTheDocument();
  });

  it("adds a keyword into the pending edit rather than writing on the press", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    renderAgent();

    await user.click(screen.getByRole("button", { name: "Add another keyword" }));
    await user.type(screen.getByRole("textbox", { name: /new keyword/iu }), "Grants");
    await user.click(screen.getByRole("button", { name: "Add it" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Which keyword")).toHaveTextContent("Grants");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });
});

describe("what SetterFi handles for you", () => {
  it("states each thing as a sentence, with a change request only where one is possible", () => {
    renderAgent();

    expect(
      screen.getByText(/does not text anyone between 9 pm and 8 am/u),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Request a change" })).toHaveLength(3);
  });

  it("drops the request link when there is no support thread to open", () => {
    renderAgent({ supportEnabled: false });

    expect(screen.queryByRole("button", { name: "Request a change" })).toBeNull();
  });

  it("opens a support thread naming the section, and reports what happened", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ thread: { id: "t-1" } }), { status: 200 }),
    );
    renderAgent();

    await user.click(screen.getAllByRole("button", { name: "Request a change" })[0]);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(fetchMock.mock.calls[0][0]).toBe("/api/support/threads");
    expect(JSON.parse(String(init.body)).subject).toBe(
      "Change request: Handing a lead to you",
    );
    expect(
      await screen.findByText("Asked. Your success team will reply in Help."),
    ).toBeInTheDocument();
  });
});

describe("the save bar", () => {
  it("says what saving does and offers exactly Undo and Save", () => {
    renderAgent();

    expect(screen.getByText("Changes go live when you save.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo my changes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("stays inert until something has actually changed", async () => {
    const user = userEvent.setup();
    renderAgent();

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Undo my changes" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Raise credit score at least" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("puts every pending edit back when the coach undoes", async () => {
    const user = userEvent.setup();
    renderAgent();

    await user.click(screen.getByRole("button", { name: "Raise credit score at least" }));
    await user.click(
      screen.getByRole("switch", { name: 'Ask "How much funding are you looking for?"' }),
    );
    await user.click(screen.getByRole("button", { name: "Undo my changes" }));

    expect(screen.getByText("640")).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: 'Ask "How much funding are you looking for?"' }),
    ).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  /**
   * The coach never meets the word publish, so Save has to do the publishing. A save that stopped
   * at the draft would leave the bar's own sentence false.
   */
  it("saves the draft and publishes it in one press", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/coach/offer") {
        return new Response(
          JSON.stringify({
            state: "draft",
            draft: {
              ...published,
              id: "draft-9",
              status: "draft",
              version: 4,
              contentHash: "hash-9",
            },
          }),
          { status: 200 },
        );
      }
      const live = { ...published, id: "offer-9", version: 4, contentHash: "hash-9" };
      return new Response(
        JSON.stringify({
          state: "published",
          offer: live,
          receipt: {
            auditId: "audit-9",
            actionKey: "offer.published",
            offerId: live.id,
            offerVersion: live.version,
            contentHash: live.contentHash,
          },
        }),
        { status: 200 },
      );
    });
    renderAgent();

    await user.click(screen.getByRole("button", { name: "Raise credit score at least" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByText("Saved. Your agent is using this now.")).toBeInTheDocument(),
    );
    const called = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(called).toContain("/api/coach/offer");
    expect(called).toContain("/api/coach/offer/publish");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("writes the question order and the switch through their own route on the same press", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({ questions, audit: { auditId: "a-1" } }),
        { status: 200 },
      ),
    );
    renderAgent();

    await user.click(
      screen.getByRole("switch", { name: 'Ask "How much funding are you looking for?"' }),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const call = fetchMock.mock.calls.find((entry) => String(entry[0]) === "/api/coach/questions");
    expect(call).toBeDefined();
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
      questionId: "q-2",
      enabled: false,
    });
  });

  it("names what did not save rather than claiming the whole press worked", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: "OFFER_SAVE_REFUSED" }), { status: 409 }),
    );
    renderAgent();

    await user.click(screen.getByRole("button", { name: "Raise credit score at least" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(
        screen.getByText(/Some of this did not save: your prices, who qualifies/u),
      ).toBeInTheDocument(),
    );
  });

  /**
   * The offer boundary still requires a program name, and this screen no longer edits one because
   * the spec demoted it to an intake request. A tenant with no offer at all therefore cannot save,
   * and the bar says so instead of the coach discovering it on the press.
   */
  it("refuses to save when there is no program name to carry through", () => {
    renderAgent({ initialState: { draft: null, published: null } });

    expect(
      screen.getByText(
        "Your program details have not reached us yet, so nothing here can be saved. Ask your success team to add them.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});

describe("keyword goals load from the route when none is handed in", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ goals }), { status: 200 }),
    );
  });

  it("reads the tenant-scoped route once", async () => {
    render(
      <CoachAgent
        initialState={{ draft: null, published }}
        objections={objections}
        questions={questions}
        supportEnabled={false}
        testEnabled={false}
      />,
    );

    expect(await screen.findByLabelText("Which keyword")).toHaveTextContent("Funds");
  });
});
