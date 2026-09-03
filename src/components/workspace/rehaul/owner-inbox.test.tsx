import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The surface reads and writes the row selection through the URL, so it needs a router mounted.
vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/alerts",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { inboxLanes } from "@/components/workspace/live/inbox-lanes";
import { OwnerInbox } from "@/components/workspace/rehaul/owner-inbox";
import type { AttentionItem, AttentionQueue } from "@/lib/operations/attention-queue";
import type { PlatformSupportThreadRead } from "@/lib/repositories/support";

const ACTOR = "owner-1";

function notice(overrides: Partial<AttentionItem> & { id: string }): AttentionItem {
  return {
    kind: "billing.payment_failed",
    severity: "warning",
    title: "Payment failed, billing contact emailed",
    body: null,
    link: null,
    tenantId: "tenant-reid",
    tenantName: "Reid Funding Group",
    assignedToMe: true,
    isTest: false,
    createdAt: "2026-08-17T09:00:00.000Z",
    readAt: null,
    openForMinutes: 15 * 24 * 60,
    breachAt: null,
    minutesToBreach: null,
    ruleName: null,
    ruleDescription: null,
    ruleCategory: null,
    primaryAction: {
      availability: "not-available",
      command: null,
      endpoint: null,
      reason: "No implemented command settles an invoice.",
    },
    ...overrides,
  };
}

function clientRequest(): PlatformSupportThreadRead {
  return {
    id: "thread-1",
    tenantId: "tenant-reid",
    tenantName: "Reid Funding Group",
    tenantIsDemo: false,
    subject: "Move my calendar to Calendly",
    status: "open",
    assignedTo: { id: ACTOR, name: "Dana Whitfield" },
    successOwner: { id: "success-1", name: "Theo Brightwell" },
    isTest: false,
    createdAt: "2026-08-31T09:12:00.000Z",
    updatedAt: "2026-08-31T09:12:00.000Z",
    messages: [{
      id: "message-1",
      authorId: "coach-1",
      authorName: "Reid Calloway",
      body: "Can we switch my bookings to my Calendly instead of Google?",
      internal: false,
      isTest: false,
      createdAt: "2026-08-31T09:12:00.000Z",
    }],
  };
}

function queue(items: readonly AttentionItem[]): AttentionQueue {
  return {
    asOf: "2026-09-01T09:12:00.000Z",
    items,
    summary: {
      open: items.length,
      critical: 0,
      warning: items.length,
      clearedInWindow: 6,
      medianMinutesToClear: 12,
    },
    responseTargets: { configured: false, reason: "No rule stores a response target." },
    blastRadius: [],
    replyVolume: [],
    truncated: false,
  };
}

function surface() {
  const attention = queue([notice({ id: "notice-1" })]);
  const lanes = inboxLanes({
    queue: attention,
    conversations: null,
    unavailableReason: "The cross-tenant handoff queue is switched off in this environment.",
    clientRequests: [clientRequest()],
  });
  return render(<OwnerInbox actorId={ACTOR} lanes={lanes} queue={attention} />);
}

describe("OwnerInbox", () => {
  it("heads the page and counts what is waiting", () => {
    surface();

    expect(screen.getByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
    // Both rows are in the reader's own book, so the default "Assigned to me" scope holds both.
    expect(screen.getByText("waiting on you").previousSibling).toHaveTextContent("2");
    // `clearedInWindow` counts reads, so the tile says cleared: nothing in the payload counts opens.
    expect(screen.queryByText("opened this week")).toBeNull();
    expect(screen.getByText("cleared this week").previousSibling).toHaveTextContent("6");
    expect(screen.getByText("longest wait").previousSibling).toHaveTextContent("15d");
  });

  it("bands the three lanes and opens the selected row", () => {
    surface();

    expect(screen.getByText("Client requests")).toBeInTheDocument();
    expect(screen.getByText("System problems")).toBeInTheDocument();
    expect(screen.getByText("Lead handoffs")).toBeInTheDocument();
    expect(screen.getByText("Collected from this account")).toBeInTheDocument();
    expect(screen.getByText("Can we switch my bookings to my Calendly instead of Google?"))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resolve" })).toBeInTheDocument();
    expect(screen.getByText("Logged")).toBeInTheDocument();
  });

  it("shows none of the explainer sentences the old surface printed", () => {
    surface();

    expect(screen.queryByText(/System problems and lead handoffs in one queue/)).toBeNull();
    expect(screen.queryByText(/Everything here is waiting on a person, not a job/)).toBeNull();
    expect(screen.queryByText(/Nothing records who is working a system problem/)).toBeNull();
    expect(screen.queryByText(/Longest wait first, in both lanes/)).toBeNull();
    // The handoff pane's "the coach takes this over" line now lives only in the eye copy.
    expect(screen.queryByText("The coach takes this over in their own inbox.")).toBeNull();
  });
});
