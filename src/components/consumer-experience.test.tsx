import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConsumerExperience,
  type ConsumerMessage,
  type HumanReplyWindow,
} from "@/components/consumer-experience";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ConsumerExperience", () => {
  const replyWindow: HumanReplyWindow = {
    closesAt: "6pm",
    opensAt: "9am",
    replyWithinHours: 2,
    timeZoneLabel: "CT",
  };

  it("removes the stepper and keeps the brand panel after the chat with a person icon", () => {
    const { container } = render(<ConsumerExperience />);
    const chat = container.querySelector<HTMLElement>(".consumer-frame");
    const brand = container.querySelector<HTMLElement>(".consumer-context");
    const ribbon = container.querySelector<HTMLElement>(".consumer-preview-ribbon");

    expect(screen.queryByRole("list", { name: /conversation progress/i })).not.toBeInTheDocument();
    expect(chat).not.toBeNull();
    expect(brand).not.toBeNull();
    expect(ribbon).not.toBeNull();
    expect(chat).toContainElement(ribbon);
    expect(
      Boolean(
        chat &&
        brand &&
        (chat.compareDocumentPosition(brand) & Node.DOCUMENT_POSITION_FOLLOWING),
      ),
    ).toBe(true);
    // The icons come from the kit's Phosphor wrapper now, which fixes weight and colour and so
    // emits no per-glyph class to select on. The call sites carry data-slot instead, which is the
    // convention this file already uses for consumer-message. The old headset assertion is gone
    // with it: no headset glyph exists anywhere in the codebase, so it could no longer fail, and
    // the point it protected -- this panel offers a person, not a support desk -- is carried by
    // the assertion above it.
    expect(brand?.querySelector('[data-slot="person-icon"]')).toBeInTheDocument();
  });

  /**
   * The disclosure used to link a bare `/privacy`, and no such route exists anywhere in
   * `src/app` -- the only privacy document in the product is `/opt-in/[tenantSlug]/privacy`. So
   * the single link on the most externally visible page in the product was a 404, on the sentence
   * that tells a lead how their conversation is handled. The href is now the caller's to supply,
   * and a caller with no tenant renders no link rather than a link to nothing.
   */
  it("links a privacy policy only when it is given one", () => {
    const absent = render(<ConsumerExperience />);
    expect(screen.queryByRole("link", { name: /privacy policy/i })).not.toBeInTheDocument();
    expect(absent.container.querySelector('a[href="/privacy"]')).toBeNull();
    absent.unmount();

    render(<ConsumerExperience privacyHref="/opt-in/synthetic-coach/privacy" />);
    expect(screen.getByRole("link", { name: "Privacy policy" })).toHaveAttribute(
      "href",
      "/opt-in/synthetic-coach/privacy",
    );
  });

  /**
   * The transcript declares itself a list, so everything in it has to be an item of that list.
   * Four things were not -- the typing indicator, the two inline failure states and the booking
   * card -- which means a screen reader announces a list of N and then reads out more than N
   * things, with the booking card among the ones it does not count.
   */
  it("puts nothing in the transcript list that is not an item of it", async () => {
    const user = userEvent.setup();
    let resolveTurn!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      resolveTurn = resolve;
    })));

    const { container } = render(
      <ConsumerExperience
        initialMessages={[
          { id: "one", author: "agent", text: "First assistant turn", at: "10:04 AM" },
          { id: "two", author: "system", text: "Handed off", at: "10:05 AM" },
          {
            id: "three",
            author: "human",
            authorName: "Marcus Whitfield",
            text: "Marcus here.",
            at: "10:09 AM",
          },
        ]}
      />,
    );

    const strays = () => {
      const list = container.querySelector<HTMLElement>('[role="list"].consumer-message-list');
      expect(list, "the transcript list is gone").not.toBeNull();
      return [...list!.children]
        .filter((child) => child.getAttribute("role") !== "listitem")
        .map((child) => child.className);
    };

    expect(strays()).toEqual([]);

    // The four things that were not list items were the four the initial fixture cannot show:
    // the typing indicator, the two inline failure states and the booking card. A version of this
    // test that rendered only messages passed while three of them were still stray, which is why
    // it now drives the surface through the states that produce them.
    await user.type(screen.getByRole("textbox", { name: "Message" }), "I would like a call");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByLabelText("Assistant is typing")).toBeVisible());
    expect(strays()).toEqual([]);

    await act(async () => resolveTurn({
      ok: true,
      json: async () => ({
        reply: "A conversation with Marcus makes sense.",
        state: "booked",
        booking: { slot: "Thu 28 Aug at 4:30 PM CT", label: "Call with Marcus" },
      }),
    } as Response));

    expect(await screen.findByRole("button", { name: "Confirm time" })).toBeVisible();
    expect(strays()).toEqual([]);
  });

  it("keeps a failed send inside the transcript list too", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const { container } = render(<ConsumerExperience />);

    await user.type(screen.getByRole("textbox", { name: "Message" }), "I have a question");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const retry = await screen.findByRole("button", { name: /retry/i });
    expect(retry).toBeVisible();
    const list = container.querySelector<HTMLElement>('[role="list"].consumer-message-list');
    const strays = [...list!.children].filter((child) => child.getAttribute("role") !== "listitem");
    expect(strays.map((child) => child.className)).toEqual([]);
  });

  it("shows the STOP instruction for SMS only", () => {
    const web = render(<ConsumerExperience channel="web" />);
    expect(screen.queryByText(/reply STOP to opt out/i)).not.toBeInTheDocument();
    web.unmount();

    render(<ConsumerExperience channel="sms" />);
    expect(screen.getByText(/reply STOP to opt out/i)).toBeVisible();
  });

  /**
   * The drift this catches: an opt-out confirmation that stops naming who stopped, what stopped,
   * or how to undo it.
   *
   * It read "You're opted out. You won't receive any further messages" -- three sentences' worth
   * of compliance compressed into a state label. A revocation confirmation owes the reader the
   * business, the scope of the stop, and the keyword that reverses it, and START is only a keyword
   * on a phone-bearing channel (`PHONE_CONTROL_CHANNELS` in `suppression/keywords.ts` is sms and
   * whatsapp). So the web arm must NOT offer it: an instruction that reads as compliant and does
   * nothing is worse than no instruction, and it is the half a copy edit is most likely to
   * flatten back into one sentence for both channels.
   */
  it("names the business, the scope and the way back when a lead opts out", async () => {
    const optedOut = {
      booking: null,
      reply: "You are unsubscribed.",
      state: "opted_out",
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(optedOut), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    })));

    const user = userEvent.setup();
    const sms = render(<ConsumerExperience channel="sms" />);
    await user.type(screen.getByRole("textbox", { name: "Message" }), "STOP");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("You’re unsubscribed from Reid Funding Group")).toBeVisible();
    const smsBanner = sms.container.querySelector<HTMLElement>(".consumer-closed-state");
    expect(smsBanner).toHaveTextContent("any more messages from this number");
    expect(smsBanner).toHaveTextContent("Reply START if you ever want to hear from us again");
    // The one arm that earns the drench is the booked one, so a stop stays a plain card.
    expect(smsBanner).toHaveAttribute("data-state", "opted_out");
    sms.unmount();

    const web = render(<ConsumerExperience channel="web" />);
    await user.type(screen.getByRole("textbox", { name: "Message" }), "STOP");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("You’re unsubscribed from Reid Funding Group")).toBeVisible();
    const webBanner = web.container.querySelector<HTMLElement>(".consumer-closed-state");
    expect(webBanner).toHaveTextContent("any more messages in this conversation");
    // No number and no keyword on web, because neither exists there.
    expect(webBanner).not.toHaveTextContent("START");
  });

  /**
   * The absent arm used to read "Marcus's reply hours aren't configured yet" -- a person the
   * product cannot name, telling a lead that their coach's settings are unfinished. What a lead
   * gets now is what the request actually does, and no timing promise the schema cannot keep.
   */
  it("uses configured hours and, absent them, says what the request does", () => {
    const configured = render(
      <ConsumerExperience businessName="Northgate Funding" humanReplyWindow={replyWindow} />,
    );
    expect(
      screen.getByText("Northgate Funding usually replies within 2 hours, 9am to 6pm CT"),
    ).toBeVisible();
    configured.unmount();

    render(<ConsumerExperience businessName="Northgate Funding" humanReplyWindow={null} />);
    expect(screen.getByText("Someone at Northgate Funding will see your request")).toBeVisible();
    expect(screen.queryByText(/configured/iu)).not.toBeInTheDocument();
  });

  it("labels every assistant turn and marks the turn handed to a person", () => {
    const messages: ConsumerMessage[] = [
      { id: "one", author: "agent", text: "First assistant turn", at: "10:04 AM" },
      { id: "two", author: "agent", text: "Second assistant turn", at: "10:05 AM" },
      { id: "three", author: "agent", text: "Third assistant turn", at: "10:06 AM" },
      {
        id: "four",
        author: "human",
        authorName: "Marcus Whitfield",
        text: "Marcus here. I can help with that.",
        at: "10:09 AM",
      },
    ];

    const { container } = render(<ConsumerExperience initialMessages={messages} />);
    const log = screen.getByRole("log");

    expect(within(log).getAllByText("Answered by the assistant")).toHaveLength(3);
    expect(within(log).getByText("Marcus Whitfield")).toBeVisible();
    expect(within(log).getByText("Handed to a person")).toBeVisible();
    expect(container.querySelectorAll('.consumer-handoff-divider[data-derived-author="human"]')).toHaveLength(1);
  });

  it("gives every turn an avatar, including the lead's", () => {
    const messages: ConsumerMessage[] = [
      { id: "one", author: "agent", text: "First assistant turn", at: "10:04 AM" },
      { id: "two", author: "lead", text: "My credit is around 680", at: "10:05 AM" },
      {
        id: "three",
        author: "human",
        authorName: "Marcus Whitfield",
        text: "Marcus here.",
        at: "10:09 AM",
      },
    ];

    const { container } = render(<ConsumerExperience initialMessages={messages} />);
    const rows = container.querySelectorAll<HTMLElement>("article.consumer-message");

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.querySelector(".consumer-message__avatar")).not.toBeNull();
    }

    // The lead's own avatar is the neutral glyph chip, not initials.
    const lead = container.querySelector<HTMLElement>('.consumer-message[data-author="lead"]');
    expect(lead?.querySelector('.consumer-message__avatar [data-slot="person-icon"]')).not.toBeNull();
    expect(lead?.querySelector(".consumer-message__avatar")?.textContent).toBe("");
  });

  it("routes handoff and later messages through consumer-agent read-backs", async () => {
    const user = userEvent.setup();
    let resolveHandoff!: (response: Response) => void;
    let resolveMessage!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
      resolveHandoff = resolve;
      }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveMessage = resolve;
      }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(
      <ConsumerExperience humanReplyWindow={replyWindow} />,
    );

    await user.click(screen.getByRole("button", { name: "Request a human" }));

    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
    expect(screen.queryByText("Handed to a person")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/consumer-agent",
      expect.objectContaining({
        body: expect.stringContaining('"message":"Talk to a human"'),
        method: "POST",
      }),
    );

    await act(async () => resolveHandoff({
      ok: true,
      json: async () => ({
        reply: "Marcus’s team has the request.",
        state: "handoff",
        booking: null,
      }),
    } as Response));

    expect(await screen.findByText("Marcus’s team has the request.")).toBeVisible();
    expect(container.querySelector('[data-author="system"]')).toHaveTextContent("Marcus’s team has the request.");
    expect(screen.queryByText("Handed to a person")).not.toBeInTheDocument();
    expect(container.querySelector('[data-author="lead"]')).not.toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Message" }), "It is a $200k equipment loan, call me after 5");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(screen.queryByText("It is a $200k equipment loan, call me after 5")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/consumer-agent",
      expect.objectContaining({
        body: expect.stringContaining("It is a $200k equipment loan, call me after 5"),
        method: "POST",
      }),
    );

    await act(async () => resolveMessage({
      ok: true,
      json: async () => ({
        reply: "Your note is in the conversation for Marcus.",
        state: "handoff",
        booking: null,
      }),
    } as Response));

    expect((await screen.findByText("It is a $200k equipment loan, call me after 5")).closest("article")).toHaveAttribute(
      "data-author",
      "lead",
    );
  });

  it("holds Request a human while a lead message is in flight so the turn is not discarded", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    render(<ConsumerExperience />);

    await user.type(screen.getByRole("textbox", { name: "Message" }), "I have a question");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByLabelText("Assistant is typing")).toBeVisible());
    // Escalating mid-request would abort the pending turn and silently discard it; the
    // composer stays live, the escalation control waits for the read-back.
    expect(screen.getByRole("button", { name: "Request a human" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeEnabled();
  });

  it("shows an honest preview outcome until the route returns a booking receipt", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        reply: "A conversation with Marcus makes sense.",
        state: "booked",
        booking: {
          slot: "Thu 28 Aug at 4:30 PM CT",
          label: "Call with Marcus",
        },
      }),
    })));
    const { container } = render(<ConsumerExperience />);

    await user.type(screen.getByRole("textbox", { name: "Message" }), "I would like a call");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: "Confirm time" }));

    expect(screen.getByRole("heading", { name: "No appointment was booked" })).toBeVisible();
    expect(container).not.toHaveTextContent(/confirmed|you’re set|we’ll send/i);
  });

  it("confirms an offered slot through the receipt-backed booking action", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          reply: "A conversation with Marcus makes sense.",
          state: "active",
          booking: {
            id: "slot-1",
            slot: "2030-01-01T10:00:00.000Z",
            label: "UTC",
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          appointment: {
            appointmentId: "appointment-1",
            startAt: "2030-01-01T10:00:00.000Z",
            timezone: "UTC",
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ConsumerExperience
        bookingConfirmEnabled
        sessionReference="server-issued"
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Message" }), "I would like a call");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: "Confirm time" }));

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      action: "turn",
      message: "I would like a call",
      sessionReference: "server-issued",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      action: "confirm-booking",
      selectedSlotId: "slot-1",
      sessionReference: "server-issued",
    });
    expect((await screen.findAllByText(/your appointment is confirmed for/i))[0]).toBeVisible();
    // The panel names the business and states the confirmed time as a figure. A lead reopens this
    // screen for the time, and it used to survive only as a clause inside a system message.
    expect(screen.getByText("Booked with Reid Funding Group")).toBeVisible();
    expect(screen.getByText("10:00 AM")).toBeVisible();
    expect(screen.getByText("Tuesday, January 1")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start over" })).not.toBeInTheDocument();
  });

  /**
   * The subject panel states the coach's published programme and nothing else, and it is absent
   * rather than empty when no offer is published. Both arms matter: the artboard fills this card
   * with a call length, a direction and an agenda that no column in the schema holds, so a panel
   * that renders on a blank programme is one edit away from being filled with invented copy.
   */
  it("names the booked call's subject only from the coach's published programme", async () => {
    const user = userEvent.setup();
    const responses = () => vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          reply: "Here is a time.",
          state: "active",
          booking: { id: "slot-1", slot: "2030-01-01T10:00:00.000Z", label: "UTC" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          appointment: {
            appointmentId: "appointment-1",
            startAt: "2030-01-01T10:00:00.000Z",
            timezone: "UTC",
          },
        }),
      });

    async function bookIt() {
      await user.type(screen.getByRole("textbox", { name: "Message" }), "I would like a call");
      await user.click(screen.getByRole("button", { name: "Send" }));
      await user.click(await screen.findByRole("button", { name: "Confirm time" }));
      await screen.findByText("Booked with Reid Funding Group");
    }

    vi.stubGlobal("fetch", responses());
    const published = render(
      <ConsumerExperience
        bookingConfirmEnabled
        programName="The 90-Day Funding Runway"
        sessionReference="server-issued"
      />,
    );
    await bookIt();
    expect(screen.getByText("What the call is about")).toBeVisible();
    expect(screen.getByText("The 90-Day Funding Runway")).toBeVisible();
    // The one fact that is stored, and no sentence around it describing a call nobody wrote down.
    const subject = published.container.querySelector(".consumer-booked-subject")!;
    expect(subject.textContent).not.toMatch(/minute|hour|calls you|he will|she will|they will/i);
    published.unmount();

    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", responses());
    const unpublished = render(
      <ConsumerExperience bookingConfirmEnabled programName="   " sessionReference="server-issued" />,
    );
    await bookIt();
    expect(screen.queryByText("What the call is about")).not.toBeInTheDocument();
    expect(unpublished.container.querySelector(".consumer-booked-subject")).toBeNull();
  });

  /**
   * The calendar file, built from confirmed values or not offered at all.
   *
   * The second arm is the one that matters. `appointments.end_at` is not null under an
   * `end_at > start_at` check, so a real end instant always exists -- but if one ever fails to
   * reach this screen, the answer has to be no download rather than an assumed half hour. A
   * wrong-length block in a lead's calendar is worse than no block: they read it once, put it in
   * their day, and plan the hour after it around a number nobody told them.
   */
  it("offers a calendar file built from the confirmed end instant, and none without one", async () => {
    const user = userEvent.setup();
    const withEnd = (endAt: string | undefined) => vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          reply: "Here is a time.",
          state: "active",
          booking: { id: "slot-1", slot: "2030-01-01T10:00:00.000Z", label: "UTC" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          appointment: {
            appointmentId: "appointment-1",
            startAt: "2030-01-01T10:00:00.000Z",
            ...(endAt === undefined ? {} : { endAt }),
            timezone: "UTC",
          },
        }),
      });

    async function bookIt() {
      await user.type(screen.getByRole("textbox", { name: "Message" }), "I would like a call");
      await user.click(screen.getByRole("button", { name: "Send" }));
      await user.click(await screen.findByRole("button", { name: "Confirm time" }));
      await screen.findByText("Booked with Reid Funding Group");
    }

    vi.stubGlobal("fetch", withEnd("2030-01-01T10:45:00.000Z"));
    const offered = render(
      <ConsumerExperience
        bookingConfirmEnabled
        programName="The 90-Day Funding Runway"
        sessionReference="server-issued"
      />,
    );
    await bookIt();

    const link = screen.getByRole("link", { name: /add to my calendar/i });
    expect(link).toBeVisible();
    expect(link.getAttribute("download")).toBe("call.ics");
    const ics = decodeURIComponent(link.getAttribute("href")!.replace(/^data:text\/calendar;charset=utf-8,/u, ""));
    // The provider's own instants, both of them, and a 45-minute event rather than a default 30.
    expect(ics).toContain("DTSTART:20300101T100000Z");
    expect(ics).toContain("DTEND:20300101T104500Z");
    expect(ics).toContain("SUMMARY:Reid Funding Group: The 90-Day Funding Runway");
    expect(ics).toMatch(/^BEGIN:VCALENDAR/u);
    expect(ics).toContain("END:VEVENT");
    offered.unmount();

    vi.unstubAllGlobals();
    vi.stubGlobal("fetch", withEnd(undefined));
    render(<ConsumerExperience bookingConfirmEnabled sessionReference="server-issued" />);
    await bookIt();

    // No end instant, so no file -- and no disabled control standing in for one either.
    expect(screen.queryByRole("link", { name: /add to my calendar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add to my calendar/i })).not.toBeInTheDocument();
  });

  it("promises no message the product does not send once a call is booked", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          reply: "Here is a time.",
          state: "active",
          booking: { id: "slot-1", slot: "2030-01-01T10:00:00.000Z", label: "UTC" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          appointment: {
            appointmentId: "appointment-1",
            startAt: "2030-01-01T10:00:00.000Z",
            timezone: "UTC",
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    render(<ConsumerExperience bookingConfirmEnabled sessionReference="server-issued" />);

    await user.type(screen.getByRole("textbox", { name: "Message" }), "I would like a call");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: "Confirm time" }));
    await screen.findByText("Booked with Reid Funding Group");

    /*
     * The artboard's booked panel promises a reminder the morning of the call, a calendar invite,
     * and a RESCHEDULE keyword. The product sends no reminder and no invite, and
     * `suppression/keywords.ts` honours STOP and START only, so all three would be the product
     * advertising something it does not do to the person least able to check.
     *
     * "Add to my calendar" is checked here too, and its presence outside this panel is the point:
     * the screen does now offer a calendar *file* the lead saves themselves, built from the
     * confirmed instants. What it must never do is say inside this panel that an invite is coming,
     * because nothing sends one. Offering a download and promising a delivery are different
     * claims, and only the first one is true.
     */
    const panel = document.querySelector(".consumer-closed-state")!;
    expect(panel.textContent).not.toMatch(/RESCHEDULE/i);
    expect(panel.textContent).not.toMatch(/reminder/i);
    expect(panel.textContent).not.toMatch(/calendar invite|add to (my )?calendar/i);
    // And the panel still says how the details actually reach them.
    expect(panel.textContent).toContain("The business will send the appointment details separately.");
  });

  /**
   * The three endings must not read alike, and this checks all three.
   *
   * It was called "marks the opt-out stop, and only the opt-out" and asserted the first clause
   * only: it drove one state, found one mark, and never rendered either of the other two endings
   * -- so "only" was in the title and in no assertion, and the test would have passed just the
   * same with a glyph on every arm. That is the shape this round was sent to find, and it is why
   * the missing tick on the booked panel survived four audits: the guard's name said the question
   * had been asked.
   *
   * The rule is that a lead can tell which of three things happened without reading, and the arms
   * are not symmetric. Booked and opted-out are outcomes and carry a mark each; a conversation
   * that merely closed is not an outcome, and a glyph would dress it as one. Every mark is
   * decorative -- the sentence beside it carries the whole statement.
   */
  it("marks the two endings that are outcomes, and not the third", async () => {
    const user = userEvent.setup();

    async function endingFor(turn: Record<string, unknown>, send: string) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => turn }));
      const view = render(<ConsumerExperience sessionReference="server-issued" />);
      await user.type(screen.getByRole("textbox", { name: "Message" }), send);
      await user.click(screen.getByRole("button", { name: "Send" }));
      const strip = await waitFor(() => {
        const found = view.container.querySelector<HTMLElement>(".consumer-closed-state");
        expect(found, "the conversation never closed").not.toBeNull();
        return found!;
      });
      return { strip, view };
    }

    const stopped = await endingFor(
      { reply: "You are unsubscribed.", state: "opted_out", booking: null },
      "STOP",
    );
    const stopMark = stopped.strip.querySelector(".consumer-closed-state__mark");
    expect(stopMark, "the compliance stop lost its mark").not.toBeNull();
    expect(stopMark).toHaveAttribute("aria-hidden", "true");
    // The padlock's tile, not the tick's circle.
    expect(stopMark).not.toHaveAttribute("data-state", "booked");
    expect(stopped.strip).toHaveAttribute("data-state", "opted_out");
    stopped.view.unmount();
    vi.unstubAllGlobals();

    const booked = await endingFor(
      { reply: "You are booked.", state: "booked", booking: null },
      "Book me in",
    );
    const bookedMark = booked.strip.querySelector(".consumer-closed-state__mark");
    expect(bookedMark, "the confirmation lost its tick").not.toBeNull();
    expect(bookedMark).toHaveAttribute("aria-hidden", "true");
    // Its own face, because the booked strip is a drench and the shared tile would vanish on it.
    expect(bookedMark).toHaveAttribute("data-state", "booked");
    expect(booked.strip).toHaveAttribute("data-state", "booked");
    booked.view.unmount();
    vi.unstubAllGlobals();

    const closed = await endingFor(
      { reply: "Closing this off.", state: "closed", booking: null },
      "That is all",
    );
    expect(
      closed.strip.querySelector(".consumer-closed-state__mark"),
      "a conversation that merely ended is not an outcome and must not wear one",
    ).toBeNull();
    closed.view.unmount();
  });

  /**
   * The header's second line, which the canvas spends on the state rather than on a constant.
   *
   * `ConsumerBooked.dc.html:68` puts "Your call is confirmed" here. The other two readouts the
   * canvas draws in this slot stay refused and are checked as absent: there are no stored reply
   * hours behind "Usually replies right away", and a web session has no phone number.
   */
  it("tells the header's second line what happened, once something has", async () => {
    const user = userEvent.setup();
    const view = render(<ConsumerExperience businessName="Northgate Funding" sessionReference="server-issued" />);
    const header = view.container.querySelector<HTMLElement>(".consumer-identity")!;

    expect(header).toHaveTextContent("Appointment assistant");
    expect(header).not.toHaveTextContent("Your call is confirmed");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ reply: "You are booked.", state: "booked", booking: null }),
    }));
    await user.type(screen.getByRole("textbox", { name: "Message" }), "Book me in");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(header).toHaveTextContent("Your call is confirmed"));
    expect(header).not.toHaveTextContent("Appointment assistant");
    // Neither refused readout appears in either state.
    expect(view.container.textContent).not.toMatch(/replies right away/i);
  });
});

/**
 * The identity guard.
 *
 * This screen is the only one an end consumer ever sees, and it used to introduce itself as
 * "Marcus Whitfield · funding coach" -- a person no column in the schema holds, stamped over
 * every tenant's conversation, with "MW" and "RF" as monograms standing for nobody. A lead of
 * Northgate Funding met a man who does not work there. `start_consumer_conversation_session`
 * returns a business name, a published programme name and a privacy URL and nothing else, so the
 * business is the only identity this surface can honestly state.
 *
 * The three things that must never reach a lead again: a person the component named, initials
 * the component chose, and the "Draft copy" artboard marker. Every render path a live session can
 * reach is exercised here, because the marker was set unconditionally on handoff turns and
 * printed in the live header.
 */
describe("the lead-facing identity", () => {
  const TENANT = "Northgate Funding";

  function everyRenderedString(container: HTMLElement): string {
    // Attributes too: the marker and the name also lived in aria-label and title text.
    return `${container.textContent ?? ""} ${container.innerHTML}`;
  }

  it("names the business the session supplied and no person of its own", () => {
    const { container } = render(<ConsumerExperience businessName={TENANT} />);

    expect(screen.getByRole("heading", { level: 1, name: TENANT })).toBeVisible();
    expect(screen.getByText("Appointment assistant")).toBeVisible();
    expect(within(screen.getByRole("log")).getByText(new RegExp(`I’m ${TENANT}’s appointment assistant`, "u"))).toBeVisible();
    expect(everyRenderedString(container)).not.toMatch(/Marcus|Whitfield|Reid Funding/u);
  });

  it("gives the business a mark derived from its own name, and the turns none at all", () => {
    const messages: ConsumerMessage[] = [
      { id: "one", author: "agent", text: "First assistant turn", at: "10:04 AM" },
      { id: "two", author: "lead", text: "My credit is around 680", at: "10:05 AM" },
      { id: "three", author: "human", text: "Taking this one over.", at: "10:09 AM" },
    ];
    const { container } = render(
      <ConsumerExperience businessName={TENANT} initialMessages={messages} />,
    );

    // The header mark is a rounded square standing for the company, and its letters come from
    // the name printed beside it.
    expect(container.querySelector(".consumer-avatar")?.textContent).toBe("NF");

    // The per-turn avatars are circles, which read as people. No initials in any of them.
    for (const avatar of container.querySelectorAll(".consumer-message__avatar")) {
      expect(avatar.textContent).toBe("");
      expect(avatar.querySelector("svg")).not.toBeNull();
    }

    // A human turn the server did not name is attributed to the business, never to a person the
    // component picked.
    const human = container.querySelector<HTMLElement>('.consumer-message[data-author="human"]');
    expect(human?.querySelector(".consumer-message__human-author")).toHaveTextContent(TENANT);
  });

  it("keeps a named human turn's own name", () => {
    render(
      <ConsumerExperience
        businessName={TENANT}
        initialMessages={[{
          id: "one",
          author: "human",
          authorName: "Dana Okoye",
          text: "Dana here, taking over.",
          at: "10:09 AM",
        }]}
      />,
    );

    expect(screen.getByText("Dana Okoye")).toBeVisible();
  });

  it("never shows a lead the Draft copy marker, in the header or on any turn", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ reply: "The request is with the team.", state: "handoff", booking: null }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          reply: "There is a time open.",
          state: "booked",
          booking: { slot: "Thu 28 Aug at 4:30 PM CT", label: "Central" },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<ConsumerExperience businessName={TENANT} />);

    expect(everyRenderedString(container)).not.toMatch(/Draft copy/u);

    // The handoff read-back: the marker used to be set on every system turn it wrote.
    await user.click(screen.getByRole("button", { name: "Request a human" }));
    await screen.findByText("The request is with the team.");
    expect(everyRenderedString(container)).not.toMatch(/Draft copy/u);

    // The preview outcome, which a live lead reaches whenever booking confirmation is off.
    await user.type(screen.getByRole("textbox", { name: "Message" }), "I would like a call");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: "Confirm time" }));

    expect(screen.getByRole("heading", { name: "No appointment was booked" })).toBeVisible();
    expect(everyRenderedString(container)).not.toMatch(/Draft copy/u);
  });
});

/**
 * The clock this screen prints, which is the lead's own and never a value out of the artboard.
 *
 * Two fixture values of the same class as "Marcus Whitfield" survived that fix and reached a live
 * lead. The opening turn was stamped `at: "10:04 AM"` as a string literal, so every real
 * conversation began at 10:04 whatever the hour actually was; and `messageTime()` formatted against
 * `America/Chicago`, so a lead in New York sent a message at 3:00 PM and watched their own message
 * appear as 2:00 PM. Nothing on the screen names the zone, so it does not read as a zone
 * difference -- it reads as the product being wrong about the last minute of the reader's life.
 *
 * The two tests below read the rendered DOM against the host's own clock rather than reading the
 * source for a constant. That is deliberate: the defect is a printed string, so what a guard has to
 * fail on is a printed string. The second one moves the host zone fourteen hours off Chicago, which
 * is why the assertion is not vacuous whatever zone the runner is set to.
 */
describe("the lead's own clock", () => {
  it("opens a live conversation with no time at all rather than a fixture one", () => {
    // No `initialMessages`, which is what `ConsumerEntry` passes on a live session -- so the
    // greeting under test here is the one a stranger actually meets.
    const { container } = render(<ConsumerExperience businessName="Northgate Funding" />);
    const opening = container.querySelector<HTMLElement>('.consumer-message[data-author="agent"]');

    expect(opening).not.toBeNull();
    expect(opening!.querySelector("time")).toBeNull();
    // No clock face anywhere in the first paint, attribute values included. The greeting carries
    // no digits of its own, so any `h:mm` in here came from a stamp.
    const log = screen.getByRole("log");
    expect(`${log.textContent ?? ""} ${log.innerHTML}`).not.toMatch(/\d{1,2}:\d{2}/u);
  });

  it("stamps a sent turn on the lead's clock and not the coach's", async () => {
    const originalTimeZone = process.env.TZ;
    // Fourteen hours off Chicago: the minute reads the same either way, the hour never can.
    process.env.TZ = "Asia/Tokyo";
    const at = (date: Date, timeZone?: string) =>
      new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(date);

    try {
      const user = userEvent.setup();
      vi.stubGlobal("fetch", vi.fn(async () => ({
        ok: true,
        json: async () => ({ reply: "Happy to help with that.", state: "active", booking: null }),
      })));
      const { container } = render(<ConsumerExperience businessName="Northgate Funding" />);

      // Real timers, so the stamp can land either side of a minute boundary; both readings of the
      // host clock are accepted and both readings of the coach's are rejected.
      const before = new Date();
      await user.type(screen.getByRole("textbox", { name: "Message" }), "I need funding");
      await user.click(screen.getByRole("button", { name: "Send" }));
      // Scoped to the transcript: the reply is also mirrored into the live region.
      await within(screen.getByRole("log")).findByText("Happy to help with that.");
      const after = new Date();

      const stamps = [...container.querySelectorAll("time")].map((node) => node.textContent);
      const hostClock = [at(before), at(after)];
      const coachClock = [at(before, "America/Chicago"), at(after, "America/Chicago")];

      // The lead's own message and the assistant's reply, and nothing untimed slipped a stamp in.
      expect(stamps).toHaveLength(2);
      for (const stamp of stamps) {
        expect(hostClock).toContain(stamp);
        expect(coachClock).not.toContain(stamp);
      }
    } finally {
      if (originalTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimeZone;
    }
  });
});
