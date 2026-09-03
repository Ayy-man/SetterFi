import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CoachAgent,
  type RehaulConnectionSurface,
} from "@/components/workspace/rehaul/coach-agent";
import { rehaulConnectionSurface } from "@/components/workspace/rehaul/coach-agent-connection-view";
import {
  coachCadenceExportRows,
  coachCadenceSchedule,
  type CoachCadenceChannel,
} from "@/components/workspace/live/coach-agent";
import { DURABLE_TOUCHES, WINDOW_BOUND_TOUCHES } from "@/lib/followups/touch-lists";
import type { PersistedOfferLayer } from "@/lib/offer/types";
import type { CoachQuestion } from "@/lib/repositories/coach-questions";
import type { KeywordGoal } from "@/lib/repositories/keyword-goals";

/** A published offer with every rung's storage actually filled, so the ladder has facts to draw. */
const published: PersistedOfferLayer = {
  id: "offer-1",
  tenantId: "tenant-1",
  status: "published",
  version: 3,
  contentHash: "hash-3",
  programName: "Funding accelerator",
  programDescription: null,
  creditMin: 700,
  fundingGoalMinCents: 2_500_000,
  fundingGoalMaxCents: 15_000_000,
  monthlyRevenueMinCents: 1_000_000,
  businessRevenueRequired: false,
  creditRepair: "yes_included",
  products: ["biz CC"],
  bookingHorizonDays: 3,
  bookingMode: "direct",
  brandVoice: "neutral",
  resultsTimelineMinDays: null,
  resultsTimelineMaxDays: null,
  refundPosture: "conditional",
  voiceStyleAnswer: null,
  voiceObjectionAnswer: null,
  voiceFollowupAnswer: null,
  offerPrices: [
    { id: "price-1", label: "Funding accelerator", amountCents: 250_000, billingPeriod: "one_time" },
    { id: "price-2", label: "Credit rebuild", amountCents: 49_700, billingPeriod: "monthly" },
  ],
  proof: [],
  assets: [],
  cadencePurposes: [],
};

const goals: KeywordGoal[] = [
  {
    id: "goal-1",
    keyword: "CCA",
    normalizedKeyword: "cca",
    goal: "resource",
    resourceUrl: "https://reidfunding.com/funding-guide",
    resourceMessage: "Here is the guide I mentioned",
    postBookingUrl: "https://reidfunding.com/thank-you",
    postBookingMessage: "Locked in.",
    active: true,
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
  },
  {
    id: "goal-2",
    keyword: "COACH",
    normalizedKeyword: "coach",
    goal: "book",
    resourceUrl: null,
    resourceMessage: null,
    postBookingUrl: null,
    postBookingMessage: null,
    active: true,
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
  },
];

/** The merged read step 3 draws: platform wording, this tenant's order and on/off overrides. */
const questions: CoachQuestion[] = [
  { id: "q-1", text: "What's the funding for?", tag: "funding purpose", enabled: true, position: 0 },
  { id: "q-2", text: "Roughly how much?", tag: "funding amount", enabled: true, position: 1 },
  { id: "q-3", text: "Are you running a business today?", tag: "business stage", enabled: false, position: 2 },
];

const surface: RehaulConnectionSurface = rehaulConnectionSurface({
  calendar: {
    name: "Consults",
    provider: "google",
    state: "ready",
    lastSlotFetchAt: "2026-09-02T12:04:00.000Z",
    lastSlotFetchOk: true,
  },
  connections: [
    {
      id: "conn-1",
      channel: "instagram",
      channelLabel: "Instagram",
      state: "live",
      externalAccountLabel: "@reidfunding",
      capabilities: {} as never,
      receipts: {
        oauthCompletedAt: "2026-08-30T09:00:00.000Z",
        assetVerifiedAt: "2026-08-30T09:05:00.000Z",
        webhookSubscribedAt: "2026-08-30T09:06:00.000Z",
        signedRoundTripAt: "2026-09-01T09:07:00.000Z",
      },
      error: null,
      tokenExpiresAt: null,
      createdAt: "2026-08-30T09:00:00.000Z",
      updatedAt: "2026-09-01T09:07:00.000Z",
    },
  ],
  datasets: [],
  registration: {
    submittedAt: "2026-08-25T13:41:00.000Z",
    registrationState: "awaiting_provider",
    terminalRejection: false,
    terminalCode: null,
  },
});

/** Sentences the old `/coach/agent` printed as help text. None of them may reach the new body. */
const OLD_EXPLAINERS = [
  "Your agent quotes these exactly. It will never invent a price or offer a discount.",
  "Anyone under these numbers is turned away politely, before it reaches you.",
  "SetterFi decides when to follow up. You decide what each message is for.",
  "The agent can qualify only against these saved facts.",
];

describe("rehaul coach agent", () => {
  it("draws the ladder with the offer layer's own figures", () => {
    render(
      <CoachAgent
        connections={surface}
        initialKeywordGoals={goals}
        initialState={{ draft: null, published }}
        publishedDateLabel="Mon 1 Sept"
        questions={questions}
        tab="ladder"
        testEnabled
      />,
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Your agent" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Live, published Mon 1 Sept")).toBeInTheDocument();

    // A figure that came from storage, not from the artboard's demo coach.
    expect(screen.getByText("$2,500.00 once")).toBeInTheDocument();
    // Rows are named for the fact they store. The question's wording lives in the platform brain,
    // so nothing here puts words in the agent's mouth that no payload supplies.
    expect(screen.getByLabelText("Credit score")).toHaveValue("700");
    expect(screen.queryByText("Do you know your credit score roughly?")).not.toBeInTheDocument();

    // Both keywords, each with its own goal segment.
    expect(screen.getByRole("button", { name: "CCA" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "COACH" })).toBeInTheDocument();

    // The five follow-up touches come off DURABLE_TOUCHES, which runs fourteen days.
    expect(screen.getByText("5 times over 14 days")).toBeInTheDocument();

    // The keyword segments write on click, so the row carries its own accountability line.
    expect(screen.getAllByLabelText("Keyword goal change recorded in the audit log").length)
      .toBeGreaterThan(0);

    for (const sentence of OLD_EXPLAINERS) {
      expect(screen.queryByText(sentence)).not.toBeInTheDocument();
    }
  });

  it("states texting registration as a day counter, never a percentage or a date", () => {
    render(
      <CoachAgent
        connections={surface}
        initialKeywordGoals={goals}
        initialState={{ draft: null, published }}
        publishedDateLabel="Mon 1 Sept"
        questions={questions}
        tab="connections"
        testEnabled
      />,
    );

    expect(screen.getByRole("heading", { level: 2, name: "Instagram" })).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("Awaiting carrier")).toBeInTheDocument();
    expect(document.querySelector(".daycount")).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/registration[^.]*\d+%/i);
    // The explainer moved to the eye; the day counter above it already states the wait.
    expect(
      screen.queryByText("The carrier owns this review, so there is nothing here to test or press yet."),
    ).not.toBeInTheDocument();
    // The channel name is indexed, never munged out of the raw key.
    expect(screen.queryByText("Whatsapp")).not.toBeInTheDocument();
  });

  it("drops the pending palette once the carrier has answered", () => {
    const registered = rehaulConnectionSurface({
      calendar: null,
      connections: [],
      datasets: null,
      registration: {
        submittedAt: "2026-08-25T13:41:00.000Z",
        registrationState: "done",
        terminalRejection: false,
        terminalCode: null,
      },
    });
    const { unmount } = render(
      <CoachAgent
        connections={registered}
        initialKeywordGoals={goals}
        initialState={{ draft: null, published }}
        publishedDateLabel={null}
        questions={questions}
        tab="connections"
        testEnabled={false}
      />,
    );
    // A state the carrier confirmed back is the only thing allowed out of amber.
    expect(screen.getByText("Registered").className).toContain("--good-wash");
    unmount();

    const refused = rehaulConnectionSurface({
      calendar: null,
      connections: [],
      datasets: null,
      registration: {
        submittedAt: "2026-08-25T13:41:00.000Z",
        registrationState: "awaiting_provider",
        terminalRejection: true,
        terminalCode: "REJECTED",
      },
    });
    render(
      <CoachAgent
        connections={refused}
        initialKeywordGoals={goals}
        initialState={{ draft: null, published }}
        publishedDateLabel={null}
        questions={questions}
        tab="connections"
        testEnabled={false}
      />,
    );
    // A refusal is not a wait, so it does not wear the pending colour either.
    expect(screen.getByText("Registration refused").className).not.toContain("--warning-wash");
  });

  it("says a connection read did not answer instead of claiming nothing is connected", () => {
    render(
      <CoachAgent
        connections={rehaulConnectionSurface({
          calendar: null,
          connections: null,
          datasets: null,
          registration: null,
        })}
        initialKeywordGoals={goals}
        initialState={{ draft: null, published }}
        publishedDateLabel={null}
        questions={questions}
        tab="connections"
        testEnabled={false}
      />,
    );

    expect(
      screen.getByText("Your connections could not be read just now."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
  });

  /*
   * The four offer-layer exports `coach-offer.tsx` carried and the rehaul dropped.
   *
   * Each is asserted by opening its own menu, because the thing that regressed was a control
   * going missing, and a test that only counted triggers would pass with four copies of one
   * export. The distinct labels are load-bearing for the same reason: four controls all reading
   * "Export" is the same as none of them being named.
   */
  function offerColumn() {
    return (
      <CoachAgent
        connections={surface}
        initialKeywordGoals={goals}
        initialState={{
          draft: null,
          published: {
            ...published,
            assets: [{ id: "asset-1", slug: "guide", label: "Funding guide", url: "https://reidfunding.com/guide" }],
            proof: [{ id: "proof-1", title: "42 clients funded", detail: "Since January" }],
          },
        }}
        publishedDateLabel={null}
        questions={questions}
        tab="ladder"
        testEnabled={false}
      />
    );
  }

  it.each([
    ["Export prices", "Prices your agent can quote"],
    ["Export proof", "Proof your agent can cite"],
    ["Export links", "Links your agent can send"],
    ["Export objections", "Objections, last 30 days"],
  ])("carries %s as a server export beside %s", async (label, panel) => {
    render(offerColumn());

    expect(screen.getByRole("heading", { level: 2, name: panel })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: label }));

    // Server mode: the whole set the route can see, and the download is recorded.
    expect(screen.getByText("All matching rows")).toBeInTheDocument();
    expect(screen.getAllByText("Export start logged")).toHaveLength(2);
  });

  it("draws the saved proof and links the exports beside them describe", () => {
    render(offerColumn());

    expect(screen.getByText("42 clients funded")).toBeInTheDocument();
    expect(screen.getByText("Funding guide")).toBeInTheDocument();
    expect(screen.getByText("https://reidfunding.com/guide")).toBeInTheDocument();
  });

  it("says what the objection file holds rather than drawing a rollup it never read", () => {
    render(offerColumn());

    expect(screen.getByText(/One row per objection a lead raised/u)).toBeInTheDocument();
  });
});

describe("CoachAgent step 3", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function ladder(rows: readonly CoachQuestion[] | null) {
    return (
      <CoachAgent
        connections={surface}
        initialKeywordGoals={goals}
        initialState={{ draft: null, published }}
        publishedDateLabel={null}
        questions={rows}
        tab="ladder"
        testEnabled={false}
      />
    );
  }

  it("draws the stored questions in their stored order with a switch and move controls", () => {
    render(ladder(questions));

    const asked = screen.getAllByRole("switch").map((control) => control.getAttribute("aria-label"));
    expect(asked).toEqual([
      'Ask "What\'s the funding for?"',
      'Ask "Roughly how much?"',
      'Ask "Are you running a business today?"',
    ]);
    // The disabled row is drawn off, not hidden, and the enabled ones are not drawn off.
    expect(screen.getAllByRole("switch").map((control) => control.getAttribute("aria-checked")))
      .toEqual(["true", "true", "false"]);
    expect(screen.getByText("funding purpose")).toBeInTheDocument();

    // The ends of the list cannot move past themselves.
    expect(screen.getByRole("button", { name: 'Move "What\'s the funding for?" earlier' }))
      .toBeDisabled();
    expect(screen.getByRole("button", { name: 'Move "Are you running a business today?" later' }))
      .toBeDisabled();
    /*
     * Two notes, not one joined string: the arrows write `coach.question_order.saved` and the
     * switch writes `coach.question.enabled.changed`, and both labels come from the registry
     * entries mirroring `20261009000004_tenant_question_settings.sql`, so a caption that drifted
     * from the row it describes fails here.
     */
    expect(screen.getByLabelText(
      "Qualification-question order recorded in the audit log",
    )).toHaveTextContent("Question order logged");
    expect(screen.getByLabelText(
      "Qualification-question setting recorded in the audit log",
    )).toHaveTextContent("Question setting logged");
  });

  it("says the question read did not answer instead of drawing an empty library", () => {
    render(ladder(null));
    expect(screen.getByText("Your agent's questions could not be read just now."))
      .toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("sends the full order to the route and redraws from the list it reads back", async () => {
    const reordered = [
      { ...questions[1], position: 0 },
      { ...questions[0], position: 1 },
      questions[2],
    ];
    const fetchMock = vi.fn(async () =>
      Response.json({
        questions: reordered,
        audit: { auditId: "91", actionKey: "coach.question_order.saved" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    render(ladder(questions));

    await userEvent.click(
      screen.getByRole("button", { name: 'Move "Roughly how much?" earlier' }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/coach/questions");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ questionIds: ["q-2", "q-1", "q-3"] });
    await waitFor(() =>
      expect(screen.getAllByRole("switch")[0]).toHaveAttribute(
        "aria-label",
        'Ask "Roughly how much?"',
      ));
    expect(screen.getByText("Saved and logged.")).toBeInTheDocument();
  });

  it("toggles through the route and leaves the row alone when the write is refused", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ code: "COACH_QUESTION_TOGGLE_REFUSED" }, { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    render(ladder(questions));

    await userEvent.click(screen.getByRole("switch", { name: 'Ask "Roughly how much?"' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/coach/questions");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ questionId: "q-2", enabled: false });
    await waitFor(() =>
      expect(screen.getByText("This question was not changed. Try again.")).toBeInTheDocument());
    expect(screen.getByRole("switch", { name: 'Ask "Roughly how much?"' }))
      .toHaveAttribute("aria-checked", "true");
  });
});

/*
 * Step 7 is the cadence editor `coach-offer.tsx` carried before the rehaul deleted that file.
 * The claim it has to keep making is a split one: SetterFi owns when a touch fires, the coach owns
 * what it is for, and a purpose the coach never chose is drawn as ours rather than as theirs.
 */
describe("CoachAgent step 7", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const channels: readonly CoachCadenceChannel[] = [
    {
      channel: "sms",
      channelLabel: "SMS",
      capability: { postWindow: "freeform", templateSend: false },
    },
    {
      channel: "instagram",
      channelLabel: "Instagram",
      capability: { postWindow: "human_agent_only", templateSend: false },
    },
  ];

  function ladder(
    offer: PersistedOfferLayer,
    cadence: { enabled: boolean; channels: readonly CoachCadenceChannel[] },
  ) {
    render(
      <CoachAgent
        cadence={cadence}
        connections={surface}
        initialKeywordGoals={goals}
        initialState={{ draft: null, published: offer }}
        publishedDateLabel={null}
        questions={questions}
        tab="ladder"
        testEnabled={false}
      />,
    );
    /*
     * Step 4 prints "set by you" against its own saved facts, so every assertion about who chose a
     * purpose is scoped to this panel. A page-wide count would pass on the wrong rows.
     */
    const panel = screen.getByRole("heading", { name: "If they go quiet" }).closest("section");
    if (!panel) throw new Error("step 7 panel did not render");
    return within(panel);
  }

  /**
   * The shared `Select` opens a portalled listbox rather than answering `selectOptions`, and it
   * mounts on an effect, so the option is awaited rather than read straight after the click.
   */
  async function choose(
    user: ReturnType<typeof userEvent.setup>,
    trigger: HTMLElement,
    option: string,
  ) {
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: option }));
  }

  it("draws every platform touch with its timing and the purpose that owns it", () => {
    const panel = ladder(published, { enabled: true, channels });

    expect(panel.getAllByRole("combobox")).toHaveLength(
      WINDOW_BOUND_TOUCHES.length + DURABLE_TOUCHES.length,
    );

    // Timing is the platform's, read off the touch lists rather than typed into the panel.
    expect(panel.getByText("2 hours after the lead goes quiet")).toBeInTheDocument();
    expect(panel.getByText("14 days after the lead goes quiet")).toBeInTheDocument();
    expect(panel.getByText("22 hours before the reply window closes")).toBeInTheDocument();

    // Nothing is saved on this offer, so every touch says the purpose is still ours.
    expect(panel.getAllByText("our default")).toHaveLength(
      WINDOW_BOUND_TOUCHES.length + DURABLE_TOUCHES.length,
    );
    expect(panel.queryByText("set by you")).not.toBeInTheDocument();

    // A channel whose capability ends at the reply window says so rather than implying we go on.
    expect(
      panel.getByText("After the reply window, follow-up stays human-only."),
    ).toBeInTheDocument();
  });

  it("marks only a saved purpose as the coach's and leaves the rest ours", () => {
    const panel = ladder(
      {
        ...published,
        cadencePurposes: [
          { channelClass: "durable", touchNo: 2, purpose: "training", assetId: null },
        ],
      },
      { enabled: true, channels },
    );

    expect(panel.getByLabelText("SMS touch 2 purpose")).toHaveTextContent("Free training");
    expect(panel.getAllByText("set by you")).toHaveLength(1);
  });

  it("saves a purpose through the same draft write as the rest of the offer", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        saved: true,
        draft: { ...published, id: "draft-1", status: "draft", contentHash: "hash-4" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const panel = ladder(published, { enabled: true, channels });

    await choose(user, panel.getByRole("combobox", { name: "SMS touch 1 purpose" }), "Approved proof point");
    expect(panel.getAllByText("set by you")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/coach/offer");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body)).offer.cadencePurposes).toEqual([
      { channelClass: "durable", touchNo: 1, purpose: "proof_point", assetId: null },
    ]);
  });

  it("keeps one row per slot when the same touch is edited twice", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        saved: true,
        draft: { ...published, id: "draft-1", status: "draft", contentHash: "hash-4" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    const panel = ladder(published, { enabled: true, channels });

    await choose(user, panel.getByRole("combobox", { name: "SMS touch 1 purpose" }), "Approved proof point");
    await choose(user, panel.getByRole("combobox", { name: "SMS touch 1 purpose" }), "A new angle");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).offer.cadencePurposes).toEqual([
      { channelClass: "durable", touchNo: 1, purpose: "new_angle", assetId: null },
    ]);
  });

  it("says nothing is sending yet without dropping the editor", () => {
    const panel = ladder(published, { enabled: false, channels });

    expect(panel.getByText("Not sending yet")).toBeInTheDocument();
    expect(panel.getByLabelText("SMS touch 1 purpose")).toBeInTheDocument();
  });

  it("lists a purpose saved outside the schedule and removes it on confirmation", async () => {
    const panel = ladder(
      {
        ...published,
        cadencePurposes: [
          { channelClass: "none", touchNo: 9, purpose: "training", assetId: null },
        ],
      },
      { enabled: true, channels },
    );

    expect(panel.getByText("Saved outside this schedule")).toBeInTheDocument();
    expect(panel.getByText(/None, touch 9, Free training/)).toBeInTheDocument();

    fireEvent.click(panel.getByRole("button", { name: "Remove None touch 9" }));
    fireEvent.click(panel.getByRole("button", { name: "Keep" }));
    expect(panel.getByText(/None, touch 9, Free training/)).toBeInTheDocument();

    fireEvent.click(panel.getByRole("button", { name: "Remove None touch 9" }));
    fireEvent.click(panel.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(panel.queryByText(/None, touch 9, Free training/)).not.toBeInTheDocument());
  });

  it("carries an export of the rows it drew, naming who chose each purpose", () => {
    const panel = ladder(
      {
        ...published,
        cadencePurposes: [
          { channelClass: "durable", touchNo: 2, purpose: "training", assetId: null },
        ],
      },
      { enabled: true, channels },
    );

    expect(panel.getByRole("button", { name: /Export schedule/ })).toBeInTheDocument();

    const rows = coachCadenceExportRows(coachCadenceSchedule(channels), [
      { channelClass: "durable", touchNo: 2, purpose: "training" },
    ]);
    expect(rows).toHaveLength(WINDOW_BOUND_TOUCHES.length + DURABLE_TOUCHES.length);
    expect(rows.filter((row) => row.purposeSource === "coach")).toHaveLength(1);
  });
});
