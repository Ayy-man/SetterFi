import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LEAD_FACT_LABELS } from "@/components/workspace/live/coach-type";
import { CoachConversations } from "@/components/workspace/live/coach-conversations";
import type { ConversationRead } from "@/lib/repositories/conversations";

const navigation = vi.hoisted(() => ({
  search: "",
  listeners: new Set<() => void>(),
}));

vi.mock("next/navigation", async () => {
  const React = await import("react");

  function publish(href: string) {
    navigation.search = href.split("?", 2)[1] ?? "";
    for (const listener of navigation.listeners) listener();
  }

  return {
    usePathname: () => "/coach/conversations",
    useRouter: () => ({
      refresh: vi.fn(),
      replace: (href: string) => publish(href),
    }),
    useSearchParams: () => {
      const source = React.useSyncExternalStore(
        (listener) => {
          navigation.listeners.add(listener);
          return () => navigation.listeners.delete(listener);
        },
        () => navigation.search,
        () => navigation.search,
      );
      return React.useMemo(() => new URLSearchParams(source), [source]);
    },
  };
});

function conversation(
  id: string,
  contactName: string,
  channel: ConversationRead["channel"],
): ConversationRead {
  return {
    id,
    contactId: `contact-${id}`,
    contactName,
    channel,
    status: "agent",
    statusReason: null,
    takenOverBy: null,
    unreadByCoach: false,
    disclosurePending: false,
    currentStepAsks: 2,
    isDemo: false,
    isTest: false,
    lastActivityAt: "2026-08-24T10:00:00.000Z",
    qualification: {
      credit: "680 to 719",
      goal: "$50,000",
      timeline: "This month",
      outcome: null,
    },
    appointment: null,
    messages: [{
      id: `message-${id}`,
      direction: "in",
      author: "lead",
      body: `Message from ${contactName}`,
      createdAt: "2026-08-24T10:00:00.000Z",
      delivered: true,
    }],
  };
}

const conversations = [
  conversation("one", "Aisha Bello", "instagram"),
  conversation("two", "Jordan Pike", "sms"),
];

function bookedConversation(): ConversationRead {
  return {
    ...conversation("booked", "Sam Rivera", "sms"),
    appointment: {
      id: "appointment-1",
      startAt: "2026-09-22T14:00:00.000Z",
      endAt: "2026-09-22T14:30:00.000Z",
      timezone: "America/New_York",
      attributedToAgent: true,
      status: "confirmed",
      provider: "ghl",
      externalId: "ghl-appointment-1",
      updatedAt: "2026-09-21T12:00:00.000Z",
    },
  };
}

beforeEach(() => {
  navigation.search = "";
  navigation.listeners.clear();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("IntersectionObserver", class {
    readonly root = null;
    readonly rootMargin = "";
    readonly thresholds: number[] = [];
    disconnect() {}
    observe() {}
    takeRecords(): IntersectionObserverEntry[] { return []; }
    unobserve() {}
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("CoachConversations", () => {
  it("opens the conversation selected by a registered notification destination", () => {
    navigation.search = "conversationId=two";
    render(<CoachConversations fixtureMode initialConversations={conversations} />);

    const detail = screen.getByRole("region", { name: "Conversation detail" });
    expect(within(detail).getByRole("heading", { name: "Jordan Pike" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open conversation with Jordan Pike" }))
      .toHaveAttribute("aria-current", "true");
  });

  it("labels test data on screen and keeps it out of real analytics", () => {
    // The hard rule is that seeded rows are labelled where a coach can see them. This asserts
    // the rendered label, not that a source file mentions a component name - the previous
    // source-string guard was satisfied by a commented-out line.
    const seeded: ConversationRead = {
      ...conversation("seeded", "Test Lead", "instagram"),
      isTest: true,
    };
    const { container, unmount } = render(
      <CoachConversations fixtureMode initialConversations={[seeded]} />,
    );

    expect(container.querySelector('[data-provenance="test"]')).not.toBeNull();
    expect(
      screen.getByText("Test data, excluded from real analytics"),
    ).toBeVisible();

    unmount();

    render(<CoachConversations fixtureMode initialConversations={conversations} />);
    expect(
      screen.queryByText("Test data, excluded from real analytics"),
    ).not.toBeInTheDocument();
  });

  it("states who holds the thread as a badge in the header, not a tinted band", () => {
    const held: ConversationRead = {
      ...conversation("three", "Priya Raghunathan", "instagram"),
      status: "human",
      takenOverBy: "fixture-coach",
    };
    render(<CoachConversations fixtureMode initialConversations={[held]} />);

    const detail = screen.getByRole("region", { name: "Conversation detail" });
    const header = within(detail).getByRole("heading", { name: "Priya Raghunathan" }).parentElement;

    /*
     * The channel and the thread's age share one line under the name, which is how
     * `Inbox.dc.html` sets them, so this reads the phrase rather than the word. An exact
     * `getByText("Instagram")` went red the moment the age joined it -- and would have gone red
     * again in the other direction if the age were ever dropped, which is the drift worth
     * catching: the header must keep saying which channel this thread came in on.
     */
    expect(within(header!).getByText(/^Instagram/)).toBeVisible();
    expect(within(header!).getByText("Human handling")).toBeVisible();
    /*
     * Who holds the thread reads off the switch now rather than off a dot and a sentence beside
     * the status pill. `Inbox.dc.html` draws one control here and `SIMPLIFICATION-SPEC.md` §2.2
     * calls it the most important coach action, so the state and the thing that changes it are the
     * same object: the label still says it in words, and `aria-checked` says it to a screen reader.
     */
    const agentSwitch = screen.getByRole("switch", { name: "Your agent replies to this lead" });
    expect(agentSwitch).toHaveTextContent("You have this thread");
    expect(agentSwitch).toHaveAttribute("aria-checked", "false");
    expect(
      screen.queryByText(/A person has this conversation/),
    ).not.toBeInTheDocument();
  });

  it("turns the agent back on through the switch, and refuses it on another person's thread", async () => {
    const user = userEvent.setup();
    const held: ConversationRead = {
      ...conversation("three", "Priya Raghunathan", "instagram"),
      status: "human",
      takenOverBy: "fixture-coach",
    };
    const { unmount } = render(
      <CoachConversations fixtureMode inboxVerbsEnabled initialConversations={[held]} />,
    );
    await user.click(screen.getByRole("switch", { name: "Your agent replies to this lead" }));
    // On is the agent replying, which is `release`; the switch writes through the mutation that
    // already exists rather than through a second path of its own, so the thread comes back
    // reading as the agent's.
    await waitFor(() => {
      expect(screen.getByRole("switch", { name: "Your agent replies to this lead" }))
        .toHaveAttribute("aria-checked", "true");
    });
    expect(screen.getByRole("switch", { name: "Your agent replies to this lead" }))
      .toHaveTextContent("Your agent is replying");
    unmount();

    const someoneElse: ConversationRead = { ...held, takenOverBy: "another-coach" };
    render(
      <CoachConversations fixtureMode inboxVerbsEnabled initialConversations={[someoneElse]} />,
    );
    const foreign = screen.getByRole("switch", { name: "Your agent replies to this lead" });
    expect(foreign).toHaveTextContent("Another person holds it");
    expect(foreign).toBeDisabled();
  });

  it("renders takeover inside the composer footprint and hides unbacked verbs while the flag is off", () => {
    render(<CoachConversations fixtureMode initialConversations={conversations} />);

    const composerGate = screen
      .getByText("The agent is holding this thread")
      .closest<HTMLElement>('[data-slot="composer-gate"]');

    expect(composerGate).not.toBeNull();
    expect(
      within(composerGate!).getByText(/Take over this conversation to reply as yourself/),
    ).toBeVisible();
    expect(within(composerGate!).getByRole("button", { name: /Take over/i })).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Snooze" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Assign" })).not.toBeInTheDocument();
  });

  /*
   * Bulk select is gone. `Inbox.dc.html` draws no checkbox anywhere and `SIMPLIFICATION-SPEC.md`
   * §2.2 KILLs it, so the three tests that read the per-row checkbox, the select-all header and
   * the selected-actions toolbar went with the markup. What they were really guarding -- that no
   * unbacked verb appears on this surface -- is kept here, asserted against the thread a coach
   * actually opens rather than against a selection there is no longer a way to make.
   */
  it("keeps inbox verbs hidden when the flag is on but no backed mutation exists", () => {
    render(<CoachConversations fixtureMode inboxVerbsEnabled initialConversations={conversations} />);

    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("toolbar", { name: "Selected conversation actions" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Close/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Snooze/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Assign/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Tag/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More conversation actions" })).not.toBeInTheDocument();
  });

  it("reselects the first matching conversation when query identity changes", async () => {
    const user = userEvent.setup();
    render(<CoachConversations fixtureMode initialConversations={conversations} />);
    const detail = screen.getByRole("region", { name: "Conversation detail" });

    await user.click(screen.getByRole("button", { name: "Open conversation with Jordan Pike" }));
    expect(within(detail).getByRole("heading", { name: "Jordan Pike" })).toBeVisible();

    await user.type(screen.getByRole("searchbox", { name: "Search a name or a message" }), "Aisha");

    await waitFor(() => {
      expect(within(detail).getByRole("heading", { name: "Aisha Bello" })).toBeVisible();
    });
  });

  /*
   * The rail is gone -- `Inbox.dc.html` draws three panes and three view pills, so the fourth pane
   * that held six views plus an unbounded objection group went with them. The claim this test made
   * is unchanged: switching the cohort really re-filters the list, and an emptied unfiltered cohort
   * collapses to the calm statement. It is now read off the filter bar's own segmented control,
   * which is where the three views live.
   */
  it("switches the cohort from the three views on the filter bar", async () => {
    const user = userEvent.setup();
    render(<CoachConversations fixtureMode initialConversations={conversations} />);

    expect(screen.queryByRole("complementary", { name: "Views" })).toBeNull();
    const views = screen.getByRole("group", { name: "Views" });
    expect(within(views).getAllByRole("button")).toHaveLength(3);

    await user.click(within(views).getByRole("button", { name: /^Waiting on you/ }));

    await waitFor(() => {
      expect(screen.getByText("Nothing needs you right now")).toBeVisible();
    });
    expect(screen.queryByRole("region", { name: "Conversation list" })).toBeNull();
  });

  it("names the channel a reply is sent on once the coach has taken over", async () => {
    const user = userEvent.setup();
    render(<CoachConversations fixtureMode initialConversations={conversations} />);

    await user.click(screen.getByRole("button", { name: /Take over/i }));

    expect(await screen.findByRole("textbox", { name: "Message" })).toBeVisible();
    expect(screen.getByText("Sends as you on Instagram")).toBeVisible();
  });

  it("shows lead-local quiet hours and sends only after the coach confirms", async () => {
    const held: ConversationRead = {
      ...conversation("quiet", "Jordan Pike", "sms"),
      status: "human",
      takenOverBy: "coach-1",
    };
    const requests: Record<string, unknown>[] = [];
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(requestBody);
      if (requestBody.quietHoursOverride !== true) {
        return Response.json({
          code: "HUMAN_REPLY_QUIET_HOURS_CONFIRMATION_REQUIRED",
          message: "This is outside the lead's allowed messaging hours. Confirm to send now.",
          scheduledAt: "2026-08-25T12:00:00.000Z",
          timezoneSource: "contact",
          leadLocalTimes: ["America/New_York: 7:00 AM"],
          allowedWindow: "8:00 AM–8:00 PM",
        }, { status: 409 });
      }
      return Response.json({
        message: {
          id: "message-sent", direction: "out", author: "human:coach-1",
          body: requestBody.body, createdAt: "2026-08-25T11:00:00.000Z", delivered: true,
        },
        conversation: {
          ...held,
          messages: [...held.messages, {
            id: "message-sent", direction: "out", author: "human:coach-1",
            body: String(requestBody.body), createdAt: "2026-08-25T11:00:00.000Z", delivered: true,
          }],
        },
        audit: null,
      });
    }));
    const user = userEvent.setup();
    render(
      <CoachConversations
        inboxVerbsEnabled
        initialConversations={[held]}
        viewerId="coach-1"
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Message" }), "Sending this now");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("America/New_York: 7:00 AM");
    expect(dialog).toHaveTextContent("8:00 AM–8:00 PM");
    expect(requests).toHaveLength(1);

    await user.click(within(dialog).getByRole("button", { name: "Send now anyway" }));
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1]).toMatchObject({
      kind: "reply",
      body: "Sending this now",
      quietHoursOverride: true,
    });
    vi.stubGlobal("fetch", originalFetch);
  });

  /*
   * This used to assert that the facts sat behind a disclosure which defaulted open. They are flat
   * now -- `Inbox.dc.html:240-263` draws five label-over-value pairs with nothing to open, and a
   * disclosure whose only reachable state is "shut" offers a coach nothing but the ability to hide
   * the numbers the rail exists to show.
   *
   * The assertion order matters. The visible fact comes first and is the substantive check: an
   * absence assertion alone is satisfied by a rail that renders nothing at all, which is exactly
   * the failure this test would be least able to see. Only once the value is on screen does the
   * missing trigger mean what it says.
   */
  it("shows the captured facts flat and keeps the machinery sections collapsed", () => {
    render(<CoachConversations fixtureMode initialConversations={conversations} />);

    const leadRail = screen.getByRole("complementary", { name: "Lead details" });

    expect(within(leadRail).getByText("680 to 719")).toBeVisible();
    expect(within(leadRail).getByText(LEAD_FACT_LABELS.credit)).toBeVisible();
    expect(
      within(leadRail).queryByRole("button", { name: /What the agent learned/ }),
      "the facts are flat, so nothing should offer to collapse them",
    ).toBeNull();

    /*
     * The two that stay folded, and why they are named individually rather than counted: the rule
     * is not "two disclosures", it is that a section holding machinery the artboard draws no row
     * for may fold, and a section holding a drawn fact may not. A count would pass if the wrong
     * two survived.
     */
    expect(within(leadRail).getByRole("button", { name: /Call booked/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(within(leadRail).getByRole("button", { name: /Conversation state/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("reschedules only after reason, review, provider confirmation, and saved read-back", async () => {
    const user = userEvent.setup();
    const original = bookedConversation();
    const updated: ConversationRead = {
      ...original,
      appointment: {
        ...original.appointment!,
        startAt: "2026-09-22T15:00:00.000Z",
        endAt: "2026-09-22T15:30:00.000Z",
        updatedAt: "2026-09-21T12:01:00.000Z",
      },
    };
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === "POST"
        ? new Response(JSON.stringify({
          command: { id: "command-1", action: "reschedule", state: "confirmed" },
          effect: { status: "confirmed", providerConfirmation: "confirmed" },
          audit: { id: 42 },
        }), { headers: { "Content-Type": "application/json" }, status: 200 })
        : new Response(JSON.stringify({ conversation: updated }), {
          headers: { "Content-Type": "application/json" }, status: 200,
        })
    ));
    vi.stubGlobal("fetch", fetch);
    render(<CoachConversations initialConversations={[original]} />);

    const leadRail = screen.getByRole("complementary", { name: "Lead details" });
    await user.click(within(leadRail).getByRole("button", { name: /Call booked/ }));
    const review = within(leadRail).getByRole("button", { name: "Review reschedule" });
    expect(review).toBeDisabled();
    await user.type(within(leadRail).getByLabelText("Reason for the change"), "Lead requested a later time.");
    fireEvent.change(within(leadRail).getByLabelText(/New start/), {
      target: { value: "2026-09-22T11:00" },
    });
    await user.click(review);

    const confirmation = await screen.findByRole("dialog");
    expect(confirmation).toHaveAccessibleName("Reschedule this appointment?");
    expect(within(confirmation).getByText("Lead requested a later time.")).toBeVisible();
    await user.click(within(confirmation).getByRole("button", { name: "Reschedule appointment" }));

    await waitFor(() => expect(confirmation.querySelector('[data-slot="logged-receipt"]'))
      .toHaveTextContent("Reschedule logged. Audit receipt #42."));
    const post = fetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post?.[0]).toBe("/api/appointments/appointment-1/lifecycle");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      action: "reschedule",
      reason: "Lead requested a later time.",
      expectedVersion: "2026-09-21T12:00:00.000Z",
      idempotencyKey: "coach-lifecycle:appointment-1:reschedule:2026-09-21T12:00:00.000Z:2026-09-22T15:00:00.000Z",
      startAt: "2026-09-22T15:00:00.000Z",
      endAt: "2026-09-22T15:30:00.000Z",
    });
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/conversations/booked");
  });

  it("cancels only after explicit confirmation and removes the appointment after read-back", async () => {
    const user = userEvent.setup();
    const original = bookedConversation();
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === "POST"
        ? new Response(JSON.stringify({
          command: { id: "command-2", action: "cancel", state: "confirmed" },
          effect: { status: "confirmed", providerConfirmation: "confirmed" },
          audit: { id: 43 },
        }), { headers: { "Content-Type": "application/json" }, status: 200 })
        : new Response(JSON.stringify({ conversation: { ...original, appointment: null } }), {
          headers: { "Content-Type": "application/json" }, status: 200,
        })
    ));
    vi.stubGlobal("fetch", fetch);
    render(<CoachConversations initialConversations={[original]} />);

    const leadRail = screen.getByRole("complementary", { name: "Lead details" });
    await user.click(within(leadRail).getByRole("button", { name: /Call booked/ }));
    await user.type(within(leadRail).getByLabelText("Reason for the change"), "Lead asked to cancel.");
    await user.click(within(leadRail).getByRole("button", { name: "Review cancellation" }));
    const confirmation = await screen.findByRole("alertdialog");
    await user.click(within(confirmation).getByRole("button", { name: "Cancel appointment" }));

    await waitFor(() => expect(confirmation.querySelector('[data-slot="logged-receipt"]'))
      .toHaveTextContent("Cancellation logged. Audit receipt #43."));
    const post = fetch.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      action: "cancel",
      reason: "Lead asked to cancel.",
      expectedVersion: "2026-09-21T12:00:00.000Z",
      idempotencyKey: "coach-lifecycle:appointment-1:cancel:2026-09-21T12:00:00.000Z:current",
    });
  });

  it("does not call a pending provider response complete", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "The request is pending provider confirmation. Refresh before retrying.",
    }), { headers: { "Content-Type": "application/json" }, status: 503 })));
    render(<CoachConversations initialConversations={[bookedConversation()]} />);

    const leadRail = screen.getByRole("complementary", { name: "Lead details" });
    await user.click(within(leadRail).getByRole("button", { name: /Call booked/ }));
    await user.type(within(leadRail).getByLabelText("Reason for the change"), "Lead asked to cancel.");
    await user.click(within(leadRail).getByRole("button", { name: "Review cancellation" }));
    const confirmation = await screen.findByRole("alertdialog");
    await user.click(within(confirmation).getByRole("button", { name: "Cancel appointment" }));

    expect(await within(confirmation).findByText(/pending provider confirmation/i)).toBeVisible();
    expect(confirmation.querySelector('[data-slot="logged-receipt"]')).not.toBeInTheDocument();
  });

  it("names the unreleased verb on a 404 instead of echoing \"Not found.\"", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "Not found.",
    }), { headers: { "Content-Type": "application/json" }, status: 404 })));
    render(<CoachConversations initialConversations={[bookedConversation()]} />);

    const leadRail = screen.getByRole("complementary", { name: "Lead details" });
    await user.click(within(leadRail).getByRole("button", { name: /Call booked/ }));
    await user.type(within(leadRail).getByLabelText("Reason for the change"), "Lead asked to cancel.");
    await user.click(within(leadRail).getByRole("button", { name: "Review cancellation" }));
    const confirmation = await screen.findByRole("alertdialog");
    await user.click(within(confirmation).getByRole("button", { name: "Cancel appointment" }));

    // The confirm flow appends "Nothing changed." to whatever the handler returns, so the
    // assertion reads the sentence out of the alert rather than matching the paragraph exactly.
    const alert = await within(confirmation).findByRole("alert");
    expect(alert).toHaveTextContent(
      "Appointment changes are not enabled in this environment. Nothing was sent to the calendar, and the lead was not messaged.",
    );
    expect(alert).not.toHaveTextContent("Not found.");
    expect(confirmation.querySelector('[data-slot="logged-receipt"]')).not.toBeInTheDocument();
  });

  it("hides lifecycle controls for impersonation and incomplete provider evidence", async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <CoachConversations
        impersonation={{ sessionId: "impersonation", tenantId: "tenant" }}
        initialConversations={[bookedConversation()]}
      />,
    );
    let leadRail = screen.getByRole("complementary", { name: "Lead details" });
    await user.click(within(leadRail).getByRole("button", { name: /Call booked/ }));
    expect(within(leadRail).getByText(/blocked in this read-only impersonated view/i)).toBeVisible();
    expect(within(leadRail).queryByRole("button", { name: "Review cancellation" })).not.toBeInTheDocument();

    unmount();
    render(<CoachConversations initialConversations={[{
      ...bookedConversation(),
      appointment: { ...bookedConversation().appointment!, externalId: null },
    }]} />);
    leadRail = screen.getByRole("complementary", { name: "Lead details" });
    await user.click(within(leadRail).getByRole("button", { name: /Call booked/ }));
    expect(within(leadRail).getByText(/provider or saved version is incomplete/i)).toBeVisible();
    expect(within(leadRail).queryByLabelText("Reason for the change")).not.toBeInTheDocument();
  });
});

describe("CoachConversations escalation view", () => {
  const NOW = "2026-08-30T12:00:00.000Z";

  function escalated(
    id: string,
    contactName: string,
    needsHumanAt: string | null,
    statusReason: string | null = "lead_requested_human",
  ): ConversationRead {
    return {
      ...conversation(id, contactName, "instagram"),
      status: "needs_human",
      statusReason,
      needsHumanAt,
    };
  }

  // The queue has no promise to rank against, so the order is the wait and the page has to say
  // so. A page that ranked silently would let a reader assume a reply commitment that does not
  // exist anywhere in the schema.
  it("says the order is the wait, and only in the view it describes", () => {
    navigation.search = "view=needs-you";
    const { unmount } = render(
      <CoachConversations
        fixtureMode
        initialConversations={[escalated("a", "Marcus T.", "2026-08-30T11:38:00.000Z")]}
        nowIso={NOW}
      />,
    );
    const panel = screen.getByLabelText("Escalations");
    expect(within(panel).getByText(/Longest wait first/u)).toBeVisible();
    expect(within(panel).getByText(/Nothing here stores a reply promise/u)).toBeVisible();
    unmount();

    navigation.search = "";
    render(<CoachConversations fixtureMode initialConversations={conversations} nowIso={NOW} />);
    expect(screen.queryByLabelText("Escalations")).not.toBeInTheDocument();
  });

  // Ranking lives on the rows, not only in a summary sentence: longest wait reads first.
  it("orders the rows longest wait first and clocks each one", () => {
    navigation.search = "view=needs-you";
    render(
      <CoachConversations
        fixtureMode
        initialConversations={[
          escalated("recent", "Jenna W.", "2026-08-30T11:58:00.000Z"),
          escalated("oldest", "Marcus T.", "2026-08-30T11:38:00.000Z"),
          escalated("middle", "Devon K.", "2026-08-30T11:51:00.000Z"),
        ]}
        nowIso={NOW}
      />,
    );

    const rows = within(screen.getByLabelText("Conversation list")).getAllByRole("listitem");
    expect(rows.map((row) => within(row).getByRole("button").textContent))
      .toEqual([
        expect.stringContaining("Marcus T."),
        expect.stringContaining("Devon K."),
        expect.stringContaining("Jenna W."),
      ]);
    expect(within(rows[0]).getByText("waiting 22m")).toBeVisible();
    expect(within(rows[2]).getByText("waiting 2m")).toBeVisible();
  });

  // Honest states: an unstamped handoff has an unknown wait. It never reads as zero or "just
  // now", and it never outranks a thread whose wait is actually known.
  it("says a missing wait is missing and sorts it below every recorded wait", () => {
    navigation.search = "view=needs-you";
    render(
      <CoachConversations
        fixtureMode
        initialConversations={[
          escalated("unstamped", "Tom B.", null),
          escalated("stamped", "Marcus T.", "2026-08-30T11:38:00.000Z"),
        ]}
        nowIso={NOW}
      />,
    );

    const rows = within(screen.getByLabelText("Conversation list")).getAllByRole("listitem");
    expect(within(rows[0]).getByText("waiting 22m")).toBeVisible();
    expect(within(rows[1]).getByText("wait not measured")).toBeVisible();
    expect(screen.queryByText("waiting 0s")).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("Escalations")).getByText("Wait not measured")).toBeVisible();
    // The tile counts nulls and null has four causes, so it may not name one of them. A note that
    // asserts the stamp was missing misreports the clock-skew case, where the stamp exists.
    expect(within(screen.getByLabelText("Escalations")).getByText("the wait could not be measured for these")).toBeVisible();
    expect(screen.queryByText(/before the clock was stamped/u)).not.toBeInTheDocument();
  });

  // No hardcoded rates: every count on the rules list comes off the queued rows, and a rule
  // nothing is waiting on renders as an absence rather than as a zero to weigh.
  it("counts each handoff rule from the queue and marks the quiet ones absent", () => {
    navigation.search = "view=needs-you";
    render(
      <CoachConversations
        fixtureMode
        initialConversations={[
          escalated("a", "Marcus T.", "2026-08-30T11:38:00.000Z", "lead_requested_human"),
          escalated("b", "Devon K.", "2026-08-30T11:51:00.000Z", "lead_requested_human"),
          escalated("c", "Priya N.", "2026-08-30T11:55:00.000Z", "no_match_threshold"),
        ]}
        nowIso={NOW}
      />,
    );

    const rules = within(screen.getByLabelText("What hands a thread over"));
    expect(rules.getByText("2 waiting")).toBeVisible();
    expect(rules.getByText("1 waiting")).toBeVisible();
    // Every published rule is listed, including the three nothing is waiting on.
    expect(rules.getAllByText("No thread is waiting on this one")).toHaveLength(3);
    expect(rules.queryByText("0 waiting")).not.toBeInTheDocument();
  });

  // An enum arm this build has never been taught must still get a row. It is the one page whose
  // job is explaining why a thread was handed over, so a silent drop is the worst failure it has.
  it("gives an unpublished handoff reason its own row rather than dropping it", () => {
    navigation.search = "view=needs-you";
    render(
      <CoachConversations
        fixtureMode
        initialConversations={[
          escalated("a", "Marcus T.", "2026-08-30T11:38:00.000Z", "tenant_suspended"),
        ]}
        nowIso={NOW}
      />,
    );

    const rules = within(screen.getByLabelText("What hands a thread over"));
    expect(rules.getByText("Tenant suspended")).toBeVisible();
    expect(rules.getByText(/has not published what this one does/u)).toBeVisible();
    expect(rules.getByText("1 waiting")).toBeVisible();
  });

  // needs_human_at is stamped by three of the four escalation paths and cleared by only one of the
  // four ways out, so the page has to say what the number is measured from.
  it("says what the wait is measured from, including the carried-over case", () => {
    navigation.search = "view=needs-you";
    render(
      <CoachConversations
        fixtureMode
        initialConversations={[escalated("a", "Marcus T.", "2026-08-30T11:38:00.000Z")]}
        nowIso={NOW}
      />,
    );

    const panel = within(screen.getByLabelText("Escalations"));
    expect(panel.getByText(/Measured from the moment the agent handed the thread over/u)).toBeVisible();
    expect(panel.getByText(/handed over more than once can still read from the earlier handoff/u)).toBeVisible();
    // The same waitSeconds is the tile, every row's clock and the sort key, so the one disclosure
    // has to name the ordering too -- that is where a coach triaging longest-wait-first decides.
    expect(panel.getByText(/so does the order these threads are in/u)).toBeVisible();
  });

  // The clock is a server instant. Without one the page says so rather than reaching for
  // Date.now() and disagreeing with itself between the server pass and hydration.
  it("reports the clock as unavailable when no instant was supplied", () => {
    navigation.search = "view=needs-you";
    render(
      <CoachConversations
        fixtureMode
        initialConversations={[escalated("a", "Marcus T.", "2026-08-30T11:38:00.000Z")]}
      />,
    );

    const panel = within(screen.getByLabelText("Escalations"));
    expect(panel.getByText("wait clock unavailable")).toBeVisible();
    expect(panel.getByText("no wait could be measured")).toBeVisible();
  });
  /*
   * The state a coach opens this page to find. Under the legacy five-tone scale `needs_human`,
   * `human` and `nurture` all resolved to the same amber, so the one state meaning the agent
   * stopped and a person is required looked exactly like the two that need nothing. This asserts
   * the hue is unshared rather than merely present: `failure` belongs to the handed-over thread
   * and to nothing else in the list.
   */
  it("gives a handed-over thread a tone no other state on the page shares", () => {
    render(
      <CoachConversations
        fixtureMode
        initialConversations={[
          escalated("a", "Marcus T.", "2026-08-30T11:38:00.000Z"),
          { ...conversation("b", "Jordan Pike", "sms"), status: "human" as const, takenOverBy: "someone" },
          { ...conversation("c", "Aisha Bello", "instagram"), status: "nurture" as const },
        ]}
        nowIso={NOW}
      />,
    );

    const rows = within(screen.getByLabelText("Conversation list")).getAllByRole("listitem");
    const toneOf = (row: HTMLElement) =>
      row.querySelector('[data-slot="status"]')?.getAttribute("data-tone");

    expect(rows.map(toneOf)).toEqual(["failure", "waiting", "neutral"]);
    // The row itself carries the tint too, so the state is legible before anything is read.
    expect(rows[0].getAttribute("data-stopped")).toBe("true");
    expect(rows[1].getAttribute("data-stopped")).toBeNull();
  });

  /*
   * `Inbox.dc.html` draws the reason inside the message flow, at the point the agent went quiet.
   * It was computed and rendered on the list row and inside a collapsed accordion, which is
   * everywhere except the place a coach is actually reading when they ask why nobody answered
   * this lead. The callout carries the handoff rule's behaviour sentence too, so the coach reads
   * what the platform did, not only what tripped.
   */
  it("puts the stop reason in the transcript where the agent stopped", () => {
    render(
      <CoachConversations
        fixtureMode
        initialConversations={[escalated("a", "Marcus T.", "2026-08-30T11:38:00.000Z")]}
        nowIso={NOW}
      />,
    );

    const callout = document.querySelector('[data-slot="transcript-stop"]');
    expect(callout).not.toBeNull();
    expect(callout).toHaveTextContent("Your agent stopped here.");
    expect(callout).toHaveTextContent("The lead asked for a person.");
    expect(callout).toHaveTextContent("It does not try to talk them out of it.");
  });

  // A thread the agent is still working carries no stop, so the flow says nothing about one.
  it("leaves the transcript alone while the agent is still on the thread", () => {
    render(
      <CoachConversations fixtureMode initialConversations={[conversation("a", "Marcus T.", "instagram")]} nowIso={NOW} />,
    );

    expect(document.querySelector('[data-slot="transcript-stop"]')).toBeNull();
  });

  /*
   * The reason belongs on the row in every view, not only inside the escalation cohort. A coach
   * reading All is the reader most likely not to know a thread is waiting, and "Handoff requested"
   * on its own does not say what to do about it.
   */
  it("says why the agent stopped on the row itself, outside the escalation view", () => {
    render(
      <CoachConversations
        fixtureMode
        initialConversations={[escalated("a", "Marcus T.", "2026-08-30T11:38:00.000Z")]}
        nowIso={NOW}
      />,
    );

    const rows = within(screen.getByLabelText("Conversation list")).getAllByRole("listitem");
    expect(within(rows[0]).getByText("The lead asked for a person")).toBeVisible();
  });

  // An arm the enum grew that this build has not been taught still reaches the row, humanised,
  // rather than the row falling silent about why a person is needed.
  it("carries an unpublished reason onto the row rather than dropping it", () => {
    render(
      <CoachConversations
        fixtureMode
        initialConversations={[escalated("a", "Marcus T.", "2026-08-30T11:38:00.000Z", "tenant_suspended")]}
        nowIso={NOW}
      />,
    );

    const rows = within(screen.getByLabelText("Conversation list")).getAllByRole("listitem");
    expect(within(rows[0]).getByText("Tenant suspended")).toBeVisible();
  });
});

/*
 * The row's own layout, which is a thing tests have to hold because the failure is silent.
 *
 * The list column at the four-pane breakpoint is `--sidebar-w * 1.7`. Every element on the name's
 * line spends part of that: 44px of padding, a 24px checkbox column and its gap, a 44px avatar and
 * its gap. When a `shrink-0` timestamp shared that line too, the name got whatever was left, which
 * at the old `* 1.35` width was about 56px -- so the pane rendered "Jo...", "M...", "La..." down
 * every row and told a coach nothing about who was waiting. Nothing went red: the name was in the
 * DOM in full, and `truncate` is invisible to jsdom.
 *
 * So these assert placement rather than pixels. The clock lives with the channel, on the line where
 * wrapping is already allowed and nothing is identity; the name's line holds the name and the
 * unread dot and nothing else that refuses to shrink.
 */
describe("CoachConversations row layout", () => {
  function firstRow() {
    return within(screen.getByLabelText("Conversation list")).getAllByRole("listitem")[0];
  }

  it("keeps the clock on the metadata line rather than beside the name", () => {
    render(<CoachConversations fixtureMode initialConversations={conversations} />);

    const row = firstRow();
    const clock = within(row).getAllByText(/2026|Aug/u).find((node) => node.tagName === "TIME");
    expect(clock, "the row should still print when the thread last moved").toBeDefined();

    const channel = within(row).getByText("Instagram");
    expect(
      clock?.parentElement,
      "the clock and the channel share the metadata line; moving the clock back up beside the name "
        + "is what squeezed every lead's name to two letters",
    ).toBe(channel.parentElement);

    const name = within(row).getByText("Aisha Bello");
    expect(
      name.parentElement?.contains(clock as Node),
      "nothing that refuses to shrink may sit on the name's line",
    ).toBe(false);
  });

  /*
   * A thread with no transcript. The preview slot is read as a quote of the lead -- every other row
   * in the column is one -- so the absent case has to be marked as absent rather than set in the
   * same colour as something somebody actually said.
   */
  it("marks an empty thread's preview as absent instead of quoting it", () => {
    const empty: ConversationRead = { ...conversation("empty", "Nadia Farouk", "sms"), messages: [] };
    render(<CoachConversations fixtureMode initialConversations={[empty]} />);

    const row = firstRow();
    // The positive control: the row rendered at all, so the negative below means something.
    expect(within(row).getByText("Nadia Farouk")).toBeVisible();

    const preview = within(row).getByText("No messages yet");
    expect(preview.className).toContain("italic");
    expect(
      preview.className,
      "an absent transcript must not be set in the body colour, which reads as a real message",
    ).not.toContain("var(--body)");
  });

  /*
   * The reason the agent stopped is prose, and one clipped line of it ("A tripwire that always
   * needs a pers...") answers nothing. Two lines is what the sentences this column draws from
   * actually need.
   */
  it("gives the stop reason two lines rather than one", () => {
    render(
      <CoachConversations
        fixtureMode
        initialConversations={[{
          ...conversation("a", "Marcus T.", "instagram"),
          needsHumanAt: "2026-08-30T11:38:00.000Z",
          status: "needs_human" as const,
          statusReason: "lead_requested_human",
        }]}
        nowIso="2026-08-30T12:00:00.000Z"
      />,
    );

    const reason = within(firstRow()).getByText("The lead asked for a person");
    expect(reason.className).toContain("line-clamp-2");
    expect(reason.className).not.toContain("truncate");
  });
});

/**
 * The inbox at rest, which is the one screen on this surface that can lie without anybody noticing.
 *
 * `InboxEmpty.dc.html` draws an empty "Needs you" as a calm centred statement rather than three
 * blank panes, and the statement makes a claim about a number: your agent is handling *27* on its
 * own. That sentence is only true while the other cohort actually holds something, and the number
 * and the cohort are computed in two different places -- so the drift these tests catch is a coach
 * with a genuinely quiet workspace being told their agent is busy with nothing.
 *
 * They also pin the two things the artboard deliberately keeps on screen. The filter tabs and the
 * search box stay, because below the four-pane breakpoint the tabs are the only way back to another
 * cohort and an earlier pass unmounted them along with the list. And a search that matched nothing
 * keeps the list pane's own "clear the filters" remedy: collapsing the two would tell a coach who
 * misspelt a name that their agent is handling everything.
 */
describe("CoachConversations at rest", () => {
  function quiet(status: ConversationRead["status"]) {
    return [
      { ...conversation("one", "Aisha Bello", "instagram"), status },
      { ...conversation("two", "Jordan Pike", "sms"), status },
    ];
  }

  it("names the real other-cohort count and keeps the tabs and the search on screen", () => {
    navigation.search = "view=needs-you";
    render(<CoachConversations fixtureMode initialConversations={quiet("agent")} />);

    expect(screen.getByText("Nothing needs you right now")).toBeVisible();
    expect(
      screen.getByText(
        (_content, node) =>
        node?.textContent ===
        "Your agent is handling 2 conversations on its own, and it will pull you in the moment one of them hits something only you can answer.",
      ),
    ).toBeVisible();
    // The route out of the cohort, which is the whole reason the filter bar comes with the calm
    // statement instead of leaving with the list.
    expect(screen.getByRole("searchbox", { name: "Search a name or a message" })).toBeVisible();
    // Scoped to the filter bar's own switch rather than to the page: the views rail carries a
    // button of the same name, and an unscoped query would pass on the rail alone -- which is
    // precisely the control that is hidden below the four-pane breakpoint and therefore precisely
    // the one that cannot stand in for this.
    const filters = screen.getByRole("group", { name: "Views" });
    expect(within(filters).getByRole("button", { name: "Agent is handling" })).toBeVisible();
  });

  it("counts one conversation as one rather than as one conversations", () => {
    navigation.search = "view=needs-you";
    render(
      <CoachConversations fixtureMode initialConversations={[quiet("agent")[0]]} />,
    );

    expect(
      screen.getByText(
        (_content, node) =>
        node?.textContent ===
        "Your agent is handling 1 conversation on its own, and it will pull you in the moment one of them hits something only you can answer.",
      ),
    ).toBeVisible();
  });

  /*
   * The honest-states arm. A workspace whose threads are all closed has nothing waiting and nothing
   * running, and the artboard's sentence would print "handling 0 conversations on its own" -- which
   * reads as a claim about the agent having failed rather than about the inbox being quiet. The
   * offer to go and look at the other cohort goes with it: there is nothing there to look at.
   */
  it("refuses the agent sentence when the agent is holding nothing either", () => {
    navigation.search = "view=needs-you";
    render(<CoachConversations fixtureMode initialConversations={quiet("closed")} />);

    expect(screen.getByText("Nothing needs you right now")).toBeVisible();
    expect(
      screen.getByText("Nothing is waiting on you, and nothing is open with your agent either."),
    ).toBeVisible();
    expect(screen.queryByText(/Your agent is handling/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "See what the agent is handling" })).toBeNull();
  });

  it("says a workspace with no threads at all is new rather than at rest", () => {
    render(<CoachConversations fixtureMode initialConversations={[]} />);

    expect(screen.getByText("No conversations yet")).toBeVisible();
    expect(
      screen.getByText(
        "When a lead messages you on a connected channel, the thread will appear here.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/Your agent is handling/i)).toBeNull();
  });

  it("switches to the cohort the sentence is about", async () => {
    const user = userEvent.setup();
    navigation.search = "view=needs-you";
    render(<CoachConversations fixtureMode initialConversations={quiet("agent")} />);

    await user.click(screen.getByRole("button", { name: "See what the agent is handling" }));

    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Conversation list" })).toBeVisible();
    });
    expect(screen.queryByText("Nothing needs you right now")).toBeNull();
    expect(screen.getByRole("button", { name: /Open conversation with Aisha Bello/ })).toBeVisible();
  });

  it("keeps a search that matched nothing on the filter remedy, not on the calm statement", () => {
    navigation.search = "q=zzzzz";
    render(<CoachConversations fixtureMode initialConversations={quiet("agent")} />);

    // Positive control first: the three panes really did render, so the absence below is a
    // decision this component made rather than a component that rendered nothing at all.
    expect(screen.getByRole("region", { name: "Conversation list" })).toBeVisible();
    expect(screen.getByText("No matching conversations")).toBeVisible();
    expect(screen.getByText("Clear the search or filters to bring conversations back into view.")).toBeVisible();
    expect(screen.queryByText("Nothing needs you right now")).toBeNull();
    expect(screen.queryByText(/Your agent is handling/i)).toBeNull();
  });

  /*
   * The filter bar belongs to the workspace, not to the list.
   *
   * `Inbox.dc.html` draws it as a `padding: 20px 40px` row across the whole frame, closed by a
   * hairline, with the 380px list column starting underneath. It had been mounted inside that
   * column, which is a claim about scope as much as about layout: a search box sitting in the list
   * reads as a search over the list, and the three views it carries filter all three panes. The
   * width made it worse -- a 16px field, three view pills and their counts do not fit 380px, so
   * they wrapped.
   *
   * Asserting containment rather than a class is what makes this a guard: the bar can be restyled
   * freely and this still fails the moment somebody moves it back inside a pane.
   */
  /*
   * One h1 per page, in every state the page has.
   *
   * `CoachPageHead` renders "Your inbox" as the h1 and sits outside the at-rest branch, so a quiet
   * inbox mounted a second one -- `InboxAtRest`'s "Nothing needs you right now" -- and the page
   * read as two top-level headings, the second smaller than the first. `7c2844f2` fixed the same
   * defect on the coach error page days apart from this one surviving, which is the argument for
   * counting rather than looking: a duplicate h1 changes nothing visible, so it is invisible to
   * every check except one that enumerates the outline.
   *
   * Both states are asserted because the defect lives in exactly one of them, and a test that only
   * rendered the populated inbox would have passed throughout.
   */
  it("has one top-level heading whether the inbox is busy or at rest", () => {
    const busy = render(<CoachConversations fixtureMode initialConversations={conversations} />);
    expect(busy.container.querySelectorAll("h1")).toHaveLength(1);
    busy.unmount();

    navigation.search = "view=needs-you";
    const { container } = render(<CoachConversations fixtureMode initialConversations={quiet("agent")} />);

    // Positive control: this really is the calm state, so the count below is about the branch the
    // defect lived in rather than about the populated page rendering twice.
    expect(screen.getByText("Nothing needs you right now")).toBeVisible();
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.querySelector("h1")).toHaveTextContent("Your inbox");
  });

  it("puts the filter bar across the workspace rather than inside the list column", () => {
    render(<CoachConversations fixtureMode initialConversations={conversations} />);

    const workspace = screen.getByRole("region", { name: "Conversation workspace" });
    const list = screen.getByRole("region", { name: "Conversation list" });
    const search = screen.getByPlaceholderText("Search a name or a message");

    expect(workspace.contains(search)).toBe(true);
    expect(list.contains(search)).toBe(false);
  });

  /*
   * And the reason it was ever duplicated. Below `@5xl` the views rail is hidden and the bar's own
   * view switch is the only route out of a cohort, so an empty "Needs you" that unmounted the bar
   * would strand a coach on a screen with nothing to press. While the bar lived in the list column
   * that meant a second copy inside the calm branch; hoisting it above the branch makes the
   * guarantee structural, and this test is what says so.
   */
  it("keeps the view switch mounted when the calm statement has replaced the panes", () => {
    navigation.search = "view=needs-you";
    render(<CoachConversations fixtureMode initialConversations={quiet("agent")} />);

    expect(screen.getByText("Nothing needs you right now")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Conversation list" })).toBeNull();
    expect(screen.getByPlaceholderText("Search a name or a message")).toBeVisible();
    expect(screen.getByRole("button", { name: /Everything/ })).toBeVisible();
  });
});
