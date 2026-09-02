import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CoachCadenceChannel } from "@/components/workspace/live/coach-agent";
import { CoachOffer } from "@/components/workspace/live/coach-offer";
import type { PersistedOfferLayer } from "@/lib/offer/types";

const CADENCE_CHANNELS: CoachCadenceChannel[] = [
  {
    channel: "sms",
    channelLabel: "Text messages (SMS)",
    capability: { postWindow: "freeform", templateSend: false },
  },
  {
    channel: "instagram",
    channelLabel: "Instagram",
    capability: { postWindow: "human_agent_only", templateSend: false },
  },
];

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

function offer(
  prices: PersistedOfferLayer["offerPrices"] = [],
  status: PersistedOfferLayer["status"] = "draft",
): PersistedOfferLayer {
  return {
    id: `offer-${status}`,
    tenantId: "tenant-test",
    status,
    version: 2,
    contentHash: "content-hash",
    programName: "Funding program",
    programDescription: "A test program.",
    creditMin: 600,
    fundingGoalMinCents: 2_500_000,
    fundingGoalMaxCents: 10_000_000,
    monthlyRevenueMinCents: 1_000_000,
    businessRevenueRequired: true,
    creditRepair: null,
    products: ["biz CC"],
    bookingHorizonDays: 21,
    bookingMode: "direct",
    brandVoice: "friendly",
    resultsTimelineMinDays: null,
    resultsTimelineMaxDays: null,
    refundPosture: null,
    voiceStyleAnswer: "Warm and direct.",
    voiceObjectionAnswer: "Answer the concern plainly.",
    voiceFollowupAnswer: "Offer one useful next step.",
    offerPrices: prices,
    proof: [],
    assets: [],
    cadencePurposes: [],
  };
}

function price(id: string, label: string, amountCents: number) {
  return { id, label, amountCents, billingPeriod: "one_time" as const };
}

/** The live route answers with one buffered JSON trace receipt; see /api/agent. */
function eventStream(payload: unknown) {
  return Response.json(payload);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  refresh.mockReset();
});

describe("what SetterFi handles for you", () => {
  // The two rows screen 5c drew as "yours to set" that turned out to have no writable storage.
  // They are stated here rather than dropped: a coach who was shown the mockup will look for
  // them, and the answer is that we run them, with the reason under each. The owned-sections
  // guard forbids them on the other side of the line, so together the pair pins the placement.
  it("states the two settings the coach cannot set, rather than dropping them", () => {
    render(<CoachOffer initialState={{ draft: offer(), published: null }} />);

    expect(screen.getByText("When you take calls")).toBeTruthy();
    expect(screen.getByText("Who gets hot leads")).toBeTruthy();
  });

  /*
   * The drift this catches, and why the assertion moved off `getByRole("button")`.
   *
   * These rows used to be popover-trigger chips. A chip is pressable, it hides its content, and
   * on a done-for-you product it reads as something the coach might be able to change -- which is
   * the opposite of what every row in this section means. The redesign turned them into
   * statements: the reason is on the page instead of behind a press, and the section offers
   * nothing to press except the one genuinely actionable thing, asking a person to change one.
   *
   * So the old assertion could not survive, and replacing it with a plain `getByText` would have
   * let the chips come back without failing. This asserts the property that actually matters: a
   * managed setting is not a control. If someone reintroduces a trigger here the section is back
   * to offering the coach an interaction it cannot honour, and this goes red.
   */
  it("offers no control on a setting the coach does not own", () => {
    render(<CoachOffer initialState={{ draft: offer(), published: null }} />);

    const section = screen.getByRole("region", { name: "What SetterFi handles for you" });
    expect(section.querySelectorAll("button, input, select, textarea")).toHaveLength(0);
    // The one thing that is actionable: asking a person. It is a link out, not a control here.
    expect(
      within(section).getByRole("link", { name: "Ask us to change something" }),
    ).toHaveAttribute("href", "/coach/help");
    // And the reason each setting is ours is on the page rather than behind a press.
    expect(
      within(section).getByText(/Your bookable hours come from the calendar you connected/),
    ).toBeVisible();
  });
});

describe("CoachOffer", () => {
  it("posts a formatted major-unit price as the correct integer amount", async () => {
    const user = userEvent.setup();
    const draft = offer([price("price-a", "Funding Accelerator", 149_700)]);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          offer: { prices: Array<{ amountCents: number }> };
        };
        return Response.json({
          state: "draft",
          draft: {
            ...draft,
            version: 3,
            contentHash: "saved-hash",
            offerPrices: draft.offerPrices.map((row, index) => ({
              ...row,
              amountCents: request.offer.prices[index].amountCents,
            })),
          },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<CoachOffer initialState={{ draft, published: null }} />);
    const amount = screen.getByLabelText("Price");
    await user.clear(amount);
    await user.type(amount, "25,000");
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    ) as { offer: { prices: Array<{ amountCents: number }> } };
    expect(body.offer.prices[0]?.amountCents).toBe(2_500_000);
  });

  it("renders a reason for every disabled Save or Publish state", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <CoachOffer
        initialState={{ draft: null, published: null }}
        testEnabled
      />,
    );


    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Publish/ })).toBeDisabled();
    expect(
      container.querySelector('[data-disabled-reason="save"]'),
    ).toHaveTextContent("Nothing to save.");
    expect(
      container.querySelector('[data-disabled-reason="publish"]'),
    ).toHaveTextContent("Nothing to publish yet");
    expect(screen.getByText("Runtime unavailable")).toBeInTheDocument();
    expect(
      screen.getByText("Publish an offer before testing it as a lead."),
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText("Program name"), "New program");
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Publish/ })).toBeDisabled();
    expect(
      container.querySelector('[data-disabled-reason="publish"]'),
    ).toHaveTextContent("Save your changes first");

    expect(
      screen.getByText("Unsaved draft changes: Your program"),
    ).toBeInTheDocument();
  });

  it("maps stored product values and renders publication state once without revision numbers", () => {
    render(
      <CoachOffer
        initialState={{ draft: null, published: offer([], "published") }}
        publishedDateLabel="Aug 12, 2026"
      />,
    );

    expect(screen.getByText("Business credit cards")).toBeInTheDocument();
    expect(screen.queryByText("biz CC")).not.toBeInTheDocument();
    expect(screen.getByText("Published v2")).toBeInTheDocument();
    expect(
      screen.getByText("live, published Aug 12, 2026"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Draft, unpublished")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/revision|live version/i),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Runtime unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Published runtime")).not.toBeInTheDocument();
  });

  it("removes the middle price without replacing the surrounding row nodes", async () => {
    const user = userEvent.setup();
    const draft = offer([
      price("price-a", "Alpha", 10_000),
      price("price-b", "Beta", 20_000),
      price("price-c", "Gamma", 30_000),
    ]);

    render(<CoachOffer initialState={{ draft, published: null }} />);
    const productInputs = screen.getAllByLabelText("Product name");
    const alphaInput = productInputs[0];
    const gammaInput = productInputs[2];

    await user.click(screen.getByRole("button", { name: "Remove Beta" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));

    const remaining = screen.getAllByLabelText("Product name");
    expect(remaining).toHaveLength(2);
    expect(remaining[0]).toBe(alphaInput);
    expect(remaining[1]).toBe(gammaInput);
    expect(remaining[0]).toHaveValue("Alpha");
    expect(remaining[1]).toHaveValue("Gamma");
  });

  it("switches to Trace without rerunning the conversation and explains an ungrounded turn", async () => {
    const user = userEvent.setup();
    const streamState: {
      controller?: ReadableStreamDefaultController<Uint8Array>;
    } = {};
    const encoder = new TextEncoder();
    const receipt = {
      state: "persisted",
      sessionId: "session-test",
      tenantId: "tenant-test",
      contactId: "contact-test",
      conversationId: "conversation-test",
      leadMessageId: "lead-test",
      agentMessageId: "agent-test",
      isTest: true,
      resolvedDriverArm: "mock",
      history: [],
      turn: {
        reply: "I will confirm that with you on the call.",
        state: "agent",
        booking: null,
        decision: "NONE",
        stage: "qualify",
        grounded: false,
        ruleFired: null,
        model: "test/model",
        tokenCount: 12,
      },
      trace: {
        promptHash: "prompt-test",
        ruleFired: null,
        moderator: "allowed",
        sourceIds: [],
        checks: [{ class: "pricing", passed: true, ruleIds: [] }],
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ sessionId: "session-test" }))
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamState.controller = controller;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <CoachOffer
        initialState={{ draft: null, published: offer([], "published") }}
        publishedDateLabel="Aug 12, 2026"
        testEnabled
      />,
    );

    const message = await screen.findByLabelText("Message as the test lead");
    expect(screen.getByText("Published runtime")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await user.type(message, "Can you guarantee an outcome?");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(streamState.controller).toBeDefined());
    streamState.controller?.enqueue(
      encoder.encode(`event: trace\ndata: ${JSON.stringify(receipt)}\n\n`),
    );
    await screen.findByText("I will confirm that with you on the call.");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole("tab", { name: "Trace" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      screen.getByText("No brain entry grounded this answer"),
    ).toBeInTheDocument();
    expect(screen.getByText("Gate decision 1: Passed")).toBeInTheDocument();
    streamState.controller?.close();
  });

  it("starts over with a new server session before accepting another message", async () => {
    const user = userEvent.setup();
    const turn = (sessionId: string, messageId: string) => ({
      state: "persisted",
      sessionId,
      tenantId: "tenant-test",
      contactId: `contact-${messageId}`,
      conversationId: `conversation-${messageId}`,
      leadMessageId: `lead-${messageId}`,
      agentMessageId: `agent-${messageId}`,
      isTest: true,
      resolvedDriverArm: "mock",
      history: [],
      turn: {
        reply: `Reply ${messageId}`,
        state: "agent",
        booking: null,
        decision: "NONE",
        stage: "qualify",
        grounded: false,
        ruleFired: null,
        model: "test/model",
        tokenCount: 12,
      },
      trace: {
        promptHash: `prompt-${messageId}`,
        ruleFired: null,
        moderator: "allowed",
        sourceIds: [],
        checks: [],
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ sessionId: "session-one" }))
      .mockResolvedValueOnce(eventStream(turn("session-one", "one")))
      .mockResolvedValueOnce(Response.json({ sessionId: "session-two" }))
      .mockResolvedValueOnce(eventStream(turn("session-two", "two")));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <CoachOffer
        initialState={{ draft: null, published: offer([], "published") }}
        publishedDateLabel="Aug 12, 2026"
        testEnabled
      />,
    );

    const message = await screen.findByLabelText("Message as the test lead");
    await user.type(message, "First question");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Reply one");

    await user.click(screen.getByRole("button", { name: "Start over" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(message).toBeEnabled();

    await user.type(message, "Second question");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("Reply two");

    const secondTurnBody = JSON.parse(
      String((fetchMock.mock.calls[3]?.[1] as RequestInit | undefined)?.body),
    ) as { sessionId: string };
    expect(secondTurnBody.sessionId).toBe("session-two");
  });
  it("shows one follow-up schedule with platform timing read-only beside an editable purpose", async () => {
    const user = userEvent.setup();
    const draft = offer();

    render(
      <CoachOffer
        cadence={{ enabled: true, channels: CADENCE_CHANNELS }}
        initialState={{ draft, published: null }}
      />,
    );

    // The schedule reflowed from a four-column table into stacked rows so it fits the card it
    // opens in, so it is addressed as a labelled region rather than by table role. The two
    // attributions the column headers used to carry did not go away with the headers: they are
    // now stated on every touch, which is what these assertions check instead.
    const schedule = screen.getByRole("region", { name: "Follow-up schedule" });
    expect(within(schedule).getAllByText("set by platform")).toHaveLength(7);
    expect(within(schedule).getAllByText("yours")).toHaveLength(7);

    // Both classes appear once, grouped, with the connected channel named on each group.
    expect(within(schedule).getByText("Instagram")).toBeInTheDocument();
    expect(
      within(schedule).getByText("Text messages (SMS)"),
    ).toBeInTheDocument();
    expect(
      within(schedule).getByText(
        "Follow-up after the reply window stays human-only.",
      ),
    ).toBeInTheDocument();

    // 2 window-bound touches + 5 durable touches, each with exactly one purpose control.
    expect(within(schedule).getAllByRole("combobox")).toHaveLength(7);
    expect(
      within(schedule).getByText("22 hours before the reply window closes"),
    ).toBeInTheDocument();
    expect(
      within(schedule).getByText("14 days after the lead goes quiet"),
    ).toBeInTheDocument();

    // Timing is read-only: no control renders inside the block that states when a touch fires.
    const whenBlocks = Array.from(
      schedule.querySelectorAll<HTMLElement>('[data-timing="platform"]'),
    );
    expect(whenBlocks).toHaveLength(7);
    for (const block of whenBlocks) {
      expect(
        /before the reply window closes|after the lead goes quiet/.test(
          block.textContent ?? "",
        ),
      ).toBe(true);
      expect(block.querySelector("input, select, button")).toBeNull();
    }

    // No channel-class picker survives the merge; the platform owns that column.
    expect(screen.queryByText("Channel class")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add purpose" }),
    ).not.toBeInTheDocument();
  });

  it("exports the follow-up schedule the section renders", async () => {
    const draft = offer();

    render(
      <CoachOffer
        cadence={{ enabled: true, channels: CADENCE_CHANNELS }}
        initialState={{ draft, published: null }}
      />,
    );

    // The schedule is hand-rolled rather than a DataTable, so it carries its own local export
    // instead of inheriting one; the control has to be named because the page carries several.
    const trigger = screen.getByRole("button", { name: "Export schedule" });
    expect(trigger).toBeEnabled();
  });

  it("saves a purpose against the platform touch the coach edited", async () => {
    const user = userEvent.setup();
    const draft = offer();
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async () =>
      Response.json({
        state: "draft",
        draft: { ...draft, version: 3, contentHash: "saved-hash" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <CoachOffer
        cadence={{ enabled: true, channels: CADENCE_CHANNELS }}
        initialState={{ draft, published: null }}
      />,
    );

    await user.click(
      screen.getByRole("combobox", { name: "Instagram touch 2 purpose" }),
    );
    // The listbox is a Base UI popup: it mounts into a portal on an effect after the click, so it
    // is not in the document the instant the click resolves. A synchronous getByRole here passed
    // only because the machine was fast enough, and reported "Unable to find an accessible element
    // with the role option" under load -- which reads as a missing option rather than as a wait.
    await user.click(
      await screen.findByRole("option", { name: "Free training" }),
    );
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    ) as {
      offer: {
        cadencePurposes: Array<{
          channelClass: string;
          touchNo: number;
          purpose: string;
        }>;
      };
    };
    expect(body.offer.cadencePurposes).toEqual([
      {
        channelClass: "window_bound",
        touchNo: 2,
        purpose: "training",
        assetId: null,
      },
    ]);
  });

  it("keeps the schedule editable and makes no send claim when follow-up is off", async () => {
    const user = userEvent.setup();

    render(
      <CoachOffer
        cadence={{ enabled: false, channels: [] }}
        initialState={{ draft: offer(), published: null }}
      />,
    );

    expect(
      screen.getByText(/Live follow-up is not switched on yet/),
    ).toBeInTheDocument();
    expect(screen.getByText("Reply-window channels")).toBeInTheDocument();
    expect(screen.getAllByText(/no channel connected yet/).length).toBe(2);
    expect(
      within(
        screen.getByRole("region", { name: "Follow-up schedule" }),
      ).getAllByRole("combobox"),
    ).toHaveLength(7);
  });

  it("badges the draft alongside the published version", () => {
    render(
      <CoachOffer
        initialState={{ draft: offer(), published: offer([], "published") }}
        publishedDateLabel="Aug 12, 2026"
      />,
    );

    expect(screen.getByText("Published v2")).toBeInTheDocument();
    expect(screen.getByText("Draft, unpublished")).toBeInTheDocument();
  });

  /**
   * The follow-up card's face is prose, so it takes a prose ink role.
   *
   * `--dim` measures 3.8:1 and the ramp at the top of `src/app/tokens.css` names what it is for:
   * the weekend letters in a calendar strip, a glyph you scan rather than a sentence you read. It
   * is below AA at any size, and the coach surface is the one built for the reader who told us in
   * round-1 demo feedback that the product was hard to read. The purpose a coach has not chosen
   * yet is secondary, which is `--muted` at 10.6:1 on the card, and the set-versus-unset
   * distinction rides on `data-set` besides -- the contrast was never what carried it.
   *
   * Pinned on the class rather than on a computed colour because jsdom resolves no stylesheet: a
   * `getComputedStyle` assertion here would read the literal `var(--muted)` back and pass against
   * any token at all, which is the vacuous shape this tree has been caught in before.
   */
  it("sets an unchosen follow-up purpose in a readable ink role, never the weekend-letter --dim", () => {
    const { container } = render(
      <CoachOffer
        cadence={{ enabled: true, channels: CADENCE_CHANNELS }}
        initialState={{ draft: offer(), published: null }}
      />,
    );

    const unset = Array.from(container.querySelectorAll<HTMLElement>('li[data-set="false"]'));
    // The positive control: no saved purposes in this draft, so every row the face shows is unset,
    // and an empty list would let the loop below pass without reading a single class.
    expect(unset).not.toHaveLength(0);

    for (const row of unset) {
      const purpose = row.querySelectorAll<HTMLElement>("span")[1];
      expect(purpose?.className).toContain("text-[color:var(--muted)]");
      expect(purpose?.className).not.toContain("--dim");
    }
  });
});

/*
 * The four cards a coach owns, after the shape moved to `TitlePanel`.
 *
 * Two things had to survive the collapse and neither is visible in the swap itself. The first is
 * the container name: four editor grids inside these cards lay themselves out with `@md/card:`
 * variants, and a container query with no named container to resolve against does not error --
 * every one of those grids silently becomes a single column at every width, which nothing else in
 * this file would notice. The second is that the pill sits level with the title, which is what
 * `Agent.dc.html:107` draws and what `TitlePanel`'s default alignment now is.
 */
describe("CoachOffer card shape", () => {
  it("keeps the container the editor grids inside these cards query", () => {
    // A saved price, because the grid that queries the container is a price row: with none the
    // editor renders its empty state and the container has nothing asking for it.
    const draft = offer([price("p1", "Funding Accelerator", 450_000)]);
    const { container } = render(<CoachOffer initialState={{ draft, published: null }} />);

    const card = screen.getByRole("region", { name: "What you charge" });
    // Positive control: the card is here and holds its editor, so what is asserted next is a
    // property of a rendered card rather than of nothing.
    expect(card).toHaveTextContent("Your agent quotes these exactly");
    expect(card).toHaveClass("@container/card");

    // And the grids that query it are inside it, so the container is the one they resolve against.
    const queried = card.querySelectorAll('[class*="@md/card:"]');
    expect(queried.length).toBeGreaterThan(0);
    for (const element of queried) expect(card.contains(element)).toBe(true);
    /*
      And nothing anywhere on the page queries that container from outside one.
      A container query with no named container to resolve against does not error, it simply never
      matches, so an orphan is invisible until someone widens a window and nothing moves. Two lived
      here: "Program name" and "Program description" kept their `@md/card:` layout when they were
      demoted into the program drawer, which is not a card, and had been single-column at every
      width ever since.
    */
    const orphans = [...container.querySelectorAll('[class*="@md/card:"]')]
      .filter((element) => element.closest('[class*="@container/card"]') === null)
      .map((element) => `${String(element.className)} :: ${(element.textContent ?? "").slice(0, 40)}`);
    expect(orphans).toEqual([]);
  });

  it("sets the state pill level with the title, not centred against the whole head", () => {
    render(<CoachOffer initialState={{ draft: offer(), published: null }} />);

    const heading = screen.getByRole("heading", { name: "What you charge" });
    const head = heading.parentElement!.parentElement!;
    expect(head).toHaveClass("items-start");
    expect(head).not.toHaveClass("items-center");
  });
});
