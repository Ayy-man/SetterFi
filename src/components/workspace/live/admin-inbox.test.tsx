import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The empty state renders a router-aware action, so the surface needs an app router mounted.
vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/alerts",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { AdminInboxSurface } from "@/components/workspace/live/admin-inbox";
import { inboxLanes } from "@/components/workspace/live/inbox-lanes";
import type { AttentionItem, AttentionQueue } from "@/lib/operations/attention-queue";
import type { PlatformHumanConversation } from "@/lib/platform/conversation-projection";

function notice(overrides: Partial<AttentionItem> & { id: string }): AttentionItem {
  return {
    kind: "channel.disconnected",
    severity: "critical",
    title: "Agent stopped replying",
    body: null,
    link: null,
    tenantId: `tenant-${overrides.id}`,
    tenantName: "Elevate Funding Co.",
    assignedToMe: false,
    isTest: false,
    createdAt: "2026-08-31T09:00:00.000Z",
    readAt: null,
    openForMinutes: 34,
    breachAt: null,
    minutesToBreach: null,
    ruleName: null,
    ruleDescription: "Instagram sign-in expired",
    ruleCategory: null,
    primaryAction: {
      availability: "not-available",
      command: null,
      endpoint: null,
      reason: "No implemented command restarts an agent.",
    },
    ...overrides,
  };
}

function handoff(overrides: Partial<PlatformHumanConversation> & { conversationId: string }) {
  return {
    tenantId: `tenant-${overrides.conversationId}`,
    tenantName: "Reid Funding Group",
    channel: "instagram" as const,
    status: "needs_human" as const,
    statusReason: "lead_requested_human",
    waitingSince: "2026-08-31T09:00:00.000Z",
    waitingSeconds: 41 * 60,
    ...overrides,
  };
}

function queue(items: readonly AttentionItem[], overrides: Partial<AttentionQueue> = {}): AttentionQueue {
  return {
    asOf: "2026-08-31T10:00:00.000Z",
    items,
    summary: {
      open: items.filter((item) => item.readAt === null).length,
      critical: 0,
      warning: 0,
      clearedInWindow: 11,
      medianMinutesToClear: 6,
    },
    blastRadius: [],
    replyVolume: [],
    responseTargets: { configured: false, reason: "No response target is stored." },
    truncated: false,
    ...overrides,
  };
}

function renderInbox(
  items: readonly AttentionItem[],
  conversations: readonly PlatformHumanConversation[] | null,
  unavailableReason?: string,
) {
  const value = queue(items);
  return render(
    <AdminInboxSurface
      actorId="owner-1"
      lanes={inboxLanes({ queue: value, conversations, unavailableReason })}
      queue={value}
    />,
  );
}

describe("AdminInboxSurface lanes", () => {
  // The merge is the point of 5a: one destination, two lanes, and each lane says what its rows are.
  it("bands the two lanes and counts each from its own list", () => {
    renderInbox(
      [notice({ id: "a" }), notice({ id: "b", openForMinutes: 12 })],
      [handoff({ conversationId: "x" }), handoff({ conversationId: "y", waitingSeconds: 11 * 60 })],
    );

    expect(screen.getByText("System problems")).toBeVisible();
    expect(screen.getByText("need a fix, not a reply")).toBeVisible();
    expect(screen.getByText("Lead handoffs")).toBeVisible();
    expect(screen.getByText("the agent stopped; nobody has taken these over")).toBeVisible();
  });

  // A lead's name and words never leave their tenant. The handoff row is about an account.
  it("names the account on a handoff row and never a lead", () => {
    renderInbox([], [handoff({ conversationId: "x", tenantName: "Reid Funding Group" })]);

    expect(screen.getByText("Reid Funding Group")).toBeVisible();
    expect(screen.getByText(/Instagram · The lead asked for a person/u)).toBeVisible();
    expect(screen.queryByText(/Marcus/u)).not.toBeInTheDocument();
  });

  // The projection filters `taken_over_by is null`, so a claimed thread leaves the lane rather than
  // showing a claimed state. The lane must say it counts threads nobody has picked up, or a reader
  // takes an empty lane for "every handoff is handled".
  it("says the handoff lane is threads nobody has taken over", () => {
    renderInbox([], [handoff({ conversationId: "x" })]);

    expect(screen.getByText("the agent stopped; nobody has taken these over")).toBeVisible();
    expect(screen.getByText(/leaves this lane the moment the coach takes it over/u)).toBeVisible();
  });

  // An unreadable lane is not an empty one. Counting it as zero would report half the inbox as all
  // of it, and would let the page call itself clear while leads were waiting.
  it("says a switched-off handoff lane is not counted, rather than showing zero", () => {
    renderInbox([notice({ id: "a" })], null, "The cross-tenant handoff queue is switched off here.");

    expect(screen.getByText("The cross-tenant handoff queue is switched off here.")).toBeVisible();
    expect(screen.getByText("not counted")).toBeVisible();
    expect(screen.getByText(/lead handoffs not counted/u)).toBeVisible();
  });

  it("stays out of the clear state while a lead handoff is waiting and no notice is", () => {
    renderInbox([], [handoff({ conversationId: "x" })]);

    expect(screen.queryByText("The Inbox is clear")).not.toBeInTheDocument();
    expect(screen.getByText("Reid Funding Group")).toBeVisible();
  });

  it("calls itself clear only when both lanes are empty and readable", () => {
    renderInbox([], []);
    expect(screen.getByText("The Inbox is clear")).toBeVisible();
  });
});

describe("AdminInboxSurface routes to the fix", () => {
  // A channel notice is fixed on Channel health, which holds the provider's own error text. The
  // Inbox routes there rather than duplicating that read, and only when it can land on an account.
  it("offers channel health for a channel notice on a known account", () => {
    renderInbox([notice({ id: "a", kind: "channel.disconnected", tenantId: "tenant-a" })], []);
    expect(screen.getByRole("button", { name: "Open channel health" })).toBeVisible();
  });

  it("offers nothing to open when the notice is not about a channel", () => {
    renderInbox([notice({ id: "a", kind: "onboarding.stalled" })], []);
    expect(screen.queryByRole("button", { name: "Open channel health" })).not.toBeInTheDocument();
  });

  it("offers nothing to open when no account is attached, rather than a link to a picker", () => {
    renderInbox([notice({ id: "a", kind: "channel.disconnected", tenantId: null })], []);
    expect(screen.queryByRole("button", { name: "Open channel health" })).not.toBeInTheDocument();
  });
});

describe("AdminInboxSurface honest figures", () => {
  // Nothing stores a claim, so the artifact's claimed tile and owner column cannot be drawn, and
  // read_at means opened rather than handled or fixed.
  it("reports opened rather than handled, names its window, and claims no ownership", () => {
    renderInbox([notice({ id: "a" })], [handoff({ conversationId: "x" })]);

    expect(screen.getByText("Opened in the last 7 days")).toBeVisible();
    expect(screen.getByText("median 6m to open")).toBeVisible();
    expect(screen.getByText(/opened means somebody has read it, not that it is fixed/u)).toBeVisible();
    expect(screen.queryByText(/Claim/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/in progress/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/Handled today/u)).not.toBeInTheDocument();
  });

  it("adds the two lanes into one waiting figure and splits it in the note", () => {
    renderInbox(
      [notice({ id: "a" }), notice({ id: "b", readAt: "2026-08-31T09:30:00.000Z" })],
      [handoff({ conversationId: "x" }), handoff({ conversationId: "y" })],
    );

    const tile = screen.getByText("Waiting on a person").closest('[data-slot="metric-card"]') as HTMLElement;
    expect(within(tile).getByText("3")).toBeVisible();
    expect(within(tile).getByText("1 problems · 2 lead handoffs")).toBeVisible();
  });

  // No response target exists anywhere, so the order is the wait and the page has to say so.
  it("states that the order is the wait because no promise is stored", () => {
    renderInbox([notice({ id: "a" })], []);

    expect(screen.getByText(/Longest wait first, in both lanes/u)).toBeVisible();
    expect(screen.getByText(/response target/u)).toBeVisible();
  });

  it("names the lane the longest wait came from", () => {
    renderInbox([notice({ id: "a", openForMinutes: 34 })], [handoff({ conversationId: "x" })]);

    const tile = screen.getByText("Longest wait").closest('[data-slot="metric-card"]') as HTMLElement;
    expect(within(tile).getByText("41m")).toBeVisible();
    expect(within(tile).getByText("a lead handoff")).toBeVisible();
  });
});
