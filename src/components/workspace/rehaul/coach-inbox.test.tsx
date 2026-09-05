import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CoachInbox } from "@/components/workspace/rehaul/coach-inbox";
import type { ConversationRead } from "@/lib/repositories/conversations";

/*
 * The Inbox against `design/coach/Inbox.dc.html`.
 *
 * Each block below pins one rule the artboard draws rather than one implementation detail: the
 * three views and no fourth, the lane pill a single-lane view drops, the closing sentence, the
 * labelled agent toggle, attribution under every bubble, the handover as a centred line, the two
 * composer tabs over one field, and a rail of facts with nothing pressable in it.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/coach/conversations",
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const NOW = "2026-09-03T12:00:00.000Z";

function conversation(overrides: Partial<ConversationRead> = {}): ConversationRead {
  return {
    id: "one",
    contactId: "contact-one",
    contactName: "Jasmine Torres",
    channel: "instagram",
    status: "needs_human",
    statusReason: "lead_requested_human",
    takenOverBy: null,
    unreadByCoach: true,
    disclosurePending: false,
    currentStepAsks: 2,
    isDemo: false,
    isTest: false,
    lastActivityAt: "2026-09-03T11:48:00.000Z",
    qualification: {
      credit: "680 to 719",
      goal: "Launching a business",
      timeline: "Now",
      outcome: null,
    },
    appointment: null,
    messages: [{
      id: "message-one",
      direction: "in",
      author: "lead",
      body: "Is the credit rebuild included if I sign up?",
      createdAt: "2026-09-03T11:48:00.000Z",
      delivered: true, simulated: false,
    }],
    ...overrides,
  };
}

const AGENT_HELD = conversation({
  id: "two",
  contactId: "contact-two",
  contactName: "Darnell Okafor",
  channel: "sms",
  status: "agent",
  statusReason: null,
  lastActivityAt: "2026-09-03T09:00:00.000Z",
  qualification: { credit: null, goal: null, timeline: null, outcome: null },
  messages: [{
    id: "message-two",
    direction: "in",
    author: "lead",
    body: "can you call me instead",
    createdAt: "2026-09-03T09:00:00.000Z",
    delivered: true, simulated: false,
  }],
});

const COUNTS = { needsYou: 1, agentHandling: 1 };

function renderInbox(options: {
  rows?: ConversationRead[];
  view?: "needs-you" | "agent-handling" | "everything";
  viewIds?: string[];
} = {}) {
  const rows = options.rows ?? [conversation(), AGENT_HELD];
  const view = options.view ?? "needs-you";
  // The server hands the client the ids its own view filter kept, so the fixture does the same.
  const viewIds = options.viewIds
    ?? (view === "everything"
      ? rows.map((row) => row.id)
      : rows
        .filter((row) => (view === "needs-you"
          ? row.status === "needs_human" || row.status === "human" || row.status === "scope_blocked"
          : row.status === "agent"))
        .map((row) => row.id));
  return render(
    <CoachInbox
      initialConversations={rows}
      nowIso={NOW}
      view={view}
      viewCounts={COUNTS}
      viewerId="coach-1"
      viewIds={viewIds}
    />,
  );
}

describe("CoachInbox", () => {
  it("offers three views and no fourth, with the two lane sizes on their tabs", () => {
    renderInbox();

    const views = screen.getByRole("navigation", { name: "Which threads" });
    const links = within(views).getAllByRole("link");

    expect(links.map((link) => link.textContent)).toEqual([
      "Needs you1",
      "Agent handling1",
      "Everything",
    ]);
    expect(links[0]).toHaveAttribute("aria-current", "page");
  });

  it("prints none of the old page's explainer sentences on the page itself", () => {
    renderInbox();

    expect(screen.queryByText(/Every thread your agent is running/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/Search reads the lead's name/u)).not.toBeInTheDocument();
  });

  it("shows only the view the server resolved, and says so when the list ends", () => {
    renderInbox();

    const list = screen.getByRole("region", { name: "Conversations" });
    expect(within(list).getByText("Jasmine Torres")).toBeInTheDocument();
    expect(within(list).queryByText("Darnell Okafor")).not.toBeInTheDocument();
    expect(within(list).getByText("That is everything waiting on you.")).toBeInTheDocument();
  });

  it("drops the lane pill inside a single-lane view and carries it where lanes are mixed", () => {
    const { unmount } = renderInbox();

    const list = screen.getByRole("region", { name: "Conversations" });
    expect(within(list).queryByText("Needs you")).not.toBeInTheDocument();
    unmount();

    const handling = renderInbox({ view: "agent-handling" });
    expect(
      within(screen.getByRole("region", { name: "Conversations" })).queryByText("Agent handling"),
    ).not.toBeInTheDocument();
    handling.unmount();

    renderInbox({ view: "everything" });
    const everything = screen.getByRole("region", { name: "Conversations" });
    expect(within(everything).getByText("Needs you")).toBeInTheDocument();
    expect(within(everything).getByText("Agent handling")).toBeInTheDocument();
  });

  it("names the channel in words and the wait in words, never as a code or an abbreviation", () => {
    renderInbox({ view: "everything" });

    const list = screen.getByRole("region", { name: "Conversations" });
    expect(within(list).getByText("Instagram")).toBeInTheDocument();
    expect(within(list).getByText("Text message")).toBeInTheDocument();
    expect(within(list).getByText("12 minutes")).toBeInTheDocument();
    expect(within(list).queryByText("IG")).not.toBeInTheDocument();
    expect(within(list).queryByText("12m")).not.toBeInTheDocument();
  });

  it("filters the list from the search box", async () => {
    const user = userEvent.setup();
    renderInbox({ view: "everything" });

    const list = screen.getByRole("region", { name: "Conversations" });
    await user.type(screen.getByRole("searchbox", { name: /^Search a name/u }), "darnell");

    expect(within(list).getByText("Darnell Okafor")).toBeInTheDocument();
    expect(within(list).queryByText("Jasmine Torres")).not.toBeInTheDocument();
  });

  it("filters by channel from a menu rather than a native select", async () => {
    const user = userEvent.setup();
    const { container } = renderInbox({ view: "everything" });

    expect(container.querySelector("select")).toBeNull();
    await user.click(screen.getByRole("button", { name: /All channels/u }));
    await user.click(screen.getByRole("menuitem", { name: "Text message" }));

    const list = screen.getByRole("region", { name: "Conversations" });
    expect(within(list).getByText("Darnell Okafor")).toBeInTheDocument();
    expect(within(list).queryByText("Jasmine Torres")).not.toBeInTheDocument();
  });

  it("says the agent is answering only where the agent is actually running the thread", () => {
    const { unmount } = renderInbox({ view: "agent-handling" });

    const toggle = screen.getByRole("switch");
    expect(toggle).toHaveAccessibleName(/Your agent is answering/u);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("button", { name: "Take over" })).not.toBeInTheDocument();
    unmount();

    /*
     * The contradiction this replaced: a thread a handover rule had stopped carried a switch
     * reading "Your agent is answering", on and green, directly above a transcript line saying
     * the agent had stopped and would not resume on its own.
     */
    renderInbox();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByText(/Your agent is answering/u)).not.toBeInTheDocument();
  });

  it("offers the one write the route accepts on a thread the agent stopped", () => {
    renderInbox();

    // `release` refuses an empty holder id, so a stopped thread nobody holds can only be claimed.
    const thread = screen.getByRole("region", { name: "Thread" });
    expect(within(thread).getByRole("button", { name: "Answer this yourself" })).toBeEnabled();
    expect(within(thread).getByText(/Your agent stopped here\./u)).toBeInTheDocument();
  });

  it("hands the thread back with the same switch once it is the viewer's", () => {
    renderInbox({
      rows: [conversation({ status: "human", statusReason: null, takenOverBy: "coach-1" })],
      viewIds: ["one"],
    });

    const toggle = screen.getByRole("switch");
    expect(toggle).toHaveAccessibleName(/You are answering/u);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toBeEnabled();
  });

  it("names the holder and presses nothing when another person has the thread", () => {
    renderInbox({
      rows: [conversation({ status: "human", statusReason: null, takenOverBy: "coach-2" })],
      viewIds: ["one"],
    });

    const toggle = screen.getByRole("switch");
    expect(toggle).toHaveAccessibleName(/Someone on your team is answering/u);
    expect(toggle).toBeDisabled();
  });

  it("heads the thread with the lead, the channel and the age of the first message", () => {
    renderInbox();

    const thread = screen.getByRole("region", { name: "Thread" });
    expect(within(thread).getByRole("heading", { name: "Jasmine Torres" })).toBeInTheDocument();
    expect(within(thread).getByText("Instagram, first message 12 minutes ago")).toBeInTheDocument();
  });

  it("puts the sender and the time under every bubble", () => {
    renderInbox({
      rows: [conversation({
        messages: [
          {
            id: "message-one",
            direction: "in",
            author: "lead",
            body: "Is the credit rebuild included if I sign up?",
            createdAt: "2026-09-03T11:48:00.000Z",
            delivered: true, simulated: false,
          },
          {
            id: "message-two",
            direction: "out",
            author: "agent",
            body: "Two quick questions and I will know if this is a fit.",
            createdAt: "2026-09-03T11:50:00.000Z",
            delivered: true, simulated: false,
          },
        ],
      })],
    });

    const thread = screen.getByRole("region", { name: "Thread" });
    expect(within(thread).getByText("Jasmine, 7:48 am")).toBeInTheDocument();
    expect(within(thread).getByText("Your agent, 7:50 am")).toBeInTheDocument();
  });

  it("draws the handover the backend wrote as a centred line, in the second person when it is the viewer's", () => {
    renderInbox({
      rows: [conversation({
        status: "human",
        statusReason: null,
        takenOverBy: "coach-1",
        messages: [
          {
            id: "message-one",
            direction: "in",
            author: "lead",
            body: "Is the credit rebuild included if I sign up?",
            createdAt: "2026-09-03T11:48:00.000Z",
            delivered: true, simulated: false,
          },
          {
            id: "message-two",
            direction: "system",
            author: "system",
            body: "Automation paused, Reid Fletcher took over",
            createdAt: "2026-09-03T11:52:00.000Z",
            delivered: false, simulated: false,
          },
        ],
      })],
      viewIds: ["one"],
    });

    expect(screen.getByText("You joined the conversation, 7:52 am")).toBeInTheDocument();
  });

  /*
   * The thread's three voices.
   *
   * The user read the dark thread on 2026-09-04 and could not tell the two speakers apart: both
   * bubbles were dark navy on a darker navy ground, so which side a bubble sat on was the only
   * signal. The fix is colour, and the rule these two tests pin is that each voice carries its
   * own named surface rather than a side plus a shared fill -- a regression that goes back to one
   * fill for both would still place the bubbles correctly and would still be the reported bug.
   */
  it("gives the lead, the agent and a person's own reply three different surfaces", () => {
    renderInbox({
      rows: [conversation({
        status: "human",
        statusReason: null,
        takenOverBy: "coach-1",
        messages: [
          {
            id: "message-one",
            direction: "in",
            author: "lead",
            body: "Is the credit rebuild included if I sign up?",
            createdAt: "2026-09-03T11:48:00.000Z",
            delivered: true, simulated: false,
          },
          {
            id: "message-two",
            direction: "out",
            author: "agent",
            body: "It is, and I can show you the plan.",
            createdAt: "2026-09-03T11:50:00.000Z",
            delivered: true, simulated: false,
          },
          {
            id: "message-three",
            direction: "out",
            author: "human:coach-1",
            body: "Reid here, happy to walk you through it.",
            createdAt: "2026-09-03T11:55:00.000Z",
            delivered: true, simulated: false,
          },
        ],
      })],
      viewIds: ["one"],
    });

    const voices = [...document.querySelectorAll("[data-voice]")].map((element) => ({
      voice: element.getAttribute("data-voice"),
      className: element.className,
    }));
    expect(voices.map((entry) => entry.voice)).toEqual(["lead", "agent", "you"]);

    const fillOf = (voice: string) => {
      const found = voices.find((entry) => entry.voice === voice);
      return (found?.className.match(/bg-\[var\(--[a-z-]+\)\]/u) ?? [])[0];
    };
    expect(fillOf("lead")).toBe("bg-[var(--thread-lead)]");
    expect(fillOf("agent")).toBe("bg-[var(--thread-agent)]");
    expect(fillOf("you")).toBe("bg-[var(--thread-you)]");
    // Three surfaces, and no two of them the same, which is the whole of the reported complaint.
    expect(new Set([fillOf("lead"), fillOf("agent"), fillOf("you")]).size).toBe(3);
  });

  it("sets the thread at 18px over 1.6 leading, caps the measure, and keeps the time line at 14", () => {
    renderInbox();

    const bubble = document.querySelector("[data-voice]");
    const body = bubble?.querySelector("p");
    expect(body?.className).toContain("text-[18px]");
    expect(body?.className).toContain("leading-[1.6]");
    // A wide pane was giving a bubble 90-character lines; the measure is capped as well as the width.
    expect(bubble?.className).toContain("60ch");
    expect(
      bubble?.querySelector('[data-slot="inbox-stamp"]')?.className,
    ).toContain("text-[14px]");
  });

  /*
   * The day is said once, above the first message of each day, and every stamp under a bubble is
   * then the time alone. A seeded thread was printing "Aug 26" under every one of its bubbles.
   */
  it("opens each day's run with one day line and keeps the stamps to the time", () => {
    renderInbox({
      rows: [conversation({
        messages: [
          { author: "contact", body: "First", createdAt: "2026-09-01T14:00:00.000Z", delivered: true, simulated: false, direction: "in", id: "m1" },
          { author: "agent", body: "Second", createdAt: "2026-09-01T14:05:00.000Z", delivered: true, simulated: false, direction: "out", id: "m2" },
          { author: "contact", body: "Third", createdAt: "2026-09-03T11:48:00.000Z", delivered: true, simulated: false, direction: "in", id: "m3" },
        ],
      })],
    });

    const days = [...document.querySelectorAll("[data-slot='inbox-day']")].map((node) => node.textContent);
    expect(days).toEqual(["Tuesday", "Today"]);
    const stamps = [...document.querySelectorAll("[data-slot='inbox-stamp']")].map((node) => node.textContent);
    expect(stamps).toEqual(["Jasmine, 10:00 am", "Your agent, 10:05 am", "Jasmine, 7:48 am"]);
  });

  /*
   * The join, not the sentence. The backend writes some of these lines and a trigger writes
   * others, so a body can arrive already ending in a full stop; appending ", <time>" to it read
   * "A person joined this conversation., yesterday 7:04 pm" on the screen the user sent back.
   */
  it("joins a system line to its time without leaving the body's own full stop", () => {
    renderInbox({
      rows: [conversation({
        messages: [
          {
            id: "message-one",
            direction: "in",
            author: "lead",
            body: "Is the credit rebuild included if I sign up?",
            createdAt: "2026-09-03T11:48:00.000Z",
            delivered: true, simulated: false,
          },
          {
            id: "message-two",
            direction: "system",
            author: "system",
            body: "A person joined this conversation.",
            createdAt: "2026-09-03T11:52:00.000Z",
            delivered: false, simulated: false,
          },
        ],
      })],
      viewIds: ["one"],
    });

    expect(
      screen.getByText("A person joined this conversation, 7:52 am"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/conversation\., /u)).not.toBeInTheDocument();
  });

  it("says why the agent stopped, in the words of the rule the run recorded", () => {
    renderInbox();

    const stop = screen.getByText(/Your agent stopped here\./u);
    expect(stop).toHaveTextContent("The agent stops and the thread comes to you.");
  });

  it("offers Reply and Note as two tabs over one field, and gates the write behind the band", () => {
    renderInbox();

    expect(screen.getByRole("button", { name: "Reply to Jasmine" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Note to yourself" }))
      .toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("textbox", { name: "Reply to Jasmine" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("says why the field is shut in the words of the state it is actually in", () => {
    const stopped = renderInbox();
    // "Turn your agent off" is true only where the agent is answering, and here it is not.
    expect(screen.getByPlaceholderText("Take this thread to reply")).toBeInTheDocument();
    stopped.unmount();

    renderInbox({ view: "agent-handling" });
    expect(screen.getByPlaceholderText("Turn your agent off to reply")).toBeInTheDocument();
  });

  it("takes the composer's placeholder from the artboard once the thread is the viewer's", () => {
    renderInbox({
      rows: [conversation({ status: "human", statusReason: null, takenOverBy: "coach-1" })],
      viewIds: ["one"],
    });

    expect(screen.getByPlaceholderText("Type your message")).toBeEnabled();
  });

  it("renames the field when the note tab is chosen, keeping one field for both", async () => {
    const user = userEvent.setup();
    renderInbox({
      rows: [conversation({ status: "human", statusReason: null, takenOverBy: "coach-1" })],
      viewIds: ["one"],
    });

    await user.click(screen.getByRole("button", { name: "Note to yourself" }));

    expect(screen.getByRole("textbox", { name: "Note to yourself" })).toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("lists the lead's facts in the rail with nothing pressable but the hide chevron", () => {
    renderInbox();

    const rail = screen.getByRole("complementary", { name: "Lead details" });
    for (const label of [
      "Credit range",
      "Funding goal",
      "Timeline",
      "Questions answered",
      "Decision",
      "Booking",
    ]) {
      expect(within(rail).getByText(label)).toBeInTheDocument();
    }
    expect(within(rail).getByText("680 to 719")).toBeInTheDocument();
    expect(within(rail).getByText("3 of 4 answered")).toBeInTheDocument();
    expect(within(rail).getByText("Not decided yet")).toBeInTheDocument();
    expect(within(rail).getByText("Not booked yet")).toBeInTheDocument();

    const controls = within(rail).getAllByRole("button");
    expect(controls).toHaveLength(1);
    expect(controls[0]).toHaveAccessibleName("Hide lead details");
  });

  it("hides the rail behind its one chevron and offers the same chevron to bring it back", async () => {
    const user = userEvent.setup();
    renderInbox();

    const rail = screen.getByRole("complementary", { name: "Lead details" });
    await user.click(within(rail).getByRole("button", { name: "Hide lead details" }));

    expect(within(rail).queryByText("Credit range")).not.toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Show lead details" })).toBeInTheDocument();
  });

  it("keeps the thread reachable back to the list, which is what the phone needs", async () => {
    const user = userEvent.setup();
    renderInbox({ view: "everything" });

    const list = screen.getByRole("region", { name: "Conversations" });
    await user.click(within(list).getByRole("button", { name: /Darnell Okafor/u }));
    expect(screen.getByRole("heading", { name: "Darnell Okafor" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to the list" }));
    expect(within(list).getByText("Jasmine Torres")).toBeInTheDocument();
  });

  it("spends exactly one accent fill on the screen, on Send", () => {
    const { container } = renderInbox();

    const filled = container.querySelectorAll('[class*="bg-[image:var(--accent-fill)]"]');
    expect(filled).toHaveLength(1);
    expect(filled[0]).toHaveTextContent("Send");
  });

  it("says the inbox is unavailable when conversations are disabled", () => {
    render(<CoachInbox enabled={false} initialConversations={[]} />);

    expect(screen.getByText("Conversations are not enabled")).toBeInTheDocument();
  });
});
