import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CoachInbox } from "@/components/workspace/rehaul/coach-inbox";
import type { ConversationRead } from "@/lib/repositories/conversations";

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
      delivered: true,
    }],
    ...overrides,
  };
}

const OTHER = conversation({
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
    delivered: true,
  }],
});

function renderInbox(rows: ConversationRead[] = [conversation(), OTHER]) {
  return render(<CoachInbox initialConversations={rows} nowIso={NOW} viewerId="coach-1" />);
}

describe("CoachInbox", () => {
  it("titles the surface Inbox and reads the thread's wait as a mono figure", () => {
    renderInbox();

    expect(screen.getByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
    expect(screen.getByText("12m")).toBeInTheDocument();
  });

  it("prints none of the old page's explainer sentences", () => {
    renderInbox();

    expect(
      screen.queryByText(/Every thread your agent is running, and the ones it has handed to you\./u),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Search reads the lead's name/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/Taking over pauses the agent/u)).not.toBeInTheDocument();
  });

  it("opens on Needs you and shows every thread once All is chosen", async () => {
    const user = userEvent.setup();
    renderInbox();

    const list = screen.getByRole("region", { name: "Conversations" });
    expect(within(list).queryByText("Darnell Okafor")).not.toBeInTheDocument();

    await user.click(within(list).getByRole("button", { name: /^All$/u }));
    expect(within(list).getByText("Darnell Okafor")).toBeInTheDocument();
  });

  it("filters the list from the search box", async () => {
    const user = userEvent.setup();
    renderInbox();

    const list = screen.getByRole("region", { name: "Conversations" });
    await user.click(within(list).getByRole("button", { name: /^All$/u }));
    await user.type(screen.getByRole("searchbox", { name: "Search leads" }), "darnell");

    expect(within(list).getByText("Darnell Okafor")).toBeInTheDocument();
    expect(within(list).queryByText("Jasmine Torres")).not.toBeInTheDocument();
  });

  it("names the recorded handoff on the held line and gates the composer behind Take over", () => {
    renderInbox();

    expect(screen.getByText(/The lead asked for a person/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Take over" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: /^Reply as/u })).toBeDisabled();
  });

  it("reads collected answers off the conversation and says what was never asked", () => {
    renderInbox();

    const rail = screen.getByRole("complementary", { name: "Lead" });
    expect(within(rail).getByText("Wants")).toBeInTheDocument();
    expect(within(rail).getByText("Launching a business")).toBeInTheDocument();
    expect(within(rail).getByText("680 to 719")).toBeInTheDocument();
    expect(within(rail).getAllByText("not asked yet").length).toBeGreaterThan(0);
    expect(within(rail).getByText("not yet")).toBeInTheDocument();
  });

  it("carries Logged on both writes: taking the thread over and sending a reply", () => {
    renderInbox();

    // Take over pauses the agent on a real lead and writes an audit row; Send writes to the lead.
    // Neither is a preview, so neither goes without the microcopy.
    expect(screen.getAllByText("Logged")).toHaveLength(2);
  });

  it("carries the conversations export the old console had, as the server export", async () => {
    const user = userEvent.setup();
    renderInbox();

    await user.click(screen.getByRole("button", { name: "Export table" }));

    // Server mode, so the file is the whole set the route can see rather than the pane's rows,
    // and the shared menu says so and says the download is recorded.
    expect(screen.getByText("All matching rows")).toBeInTheDocument();
    expect(screen.getAllByText("Export start logged")).toHaveLength(2);
  });

  it("says the inbox is unavailable when conversations are disabled", () => {
    render(<CoachInbox enabled={false} initialConversations={[]} />);

    expect(screen.getByText("Conversations are not enabled")).toBeInTheDocument();
  });
});
