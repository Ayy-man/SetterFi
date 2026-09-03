import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
    tenantName: "Reid Funding Group (demo)",
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

function clientRequest(overrides: Partial<PlatformSupportThreadRead> = {}): PlatformSupportThreadRead {
  return {
    id: "thread-1",
    tenantId: "tenant-reid",
    tenantName: "Reid Funding Group (demo)",
    tenantIsDemo: true,
    subject: "Move my calendar to Calendly",
    status: "waiting_on_coach",
    assignedTo: { id: ACTOR, name: "Dana Whitfield (demo)" },
    successOwner: { id: "success-1", name: "Theo Brightwell (demo)" },
    isTest: false,
    createdAt: "2026-08-31T09:12:00.000Z",
    updatedAt: "2026-08-31T09:12:00.000Z",
    messages: [
      {
        id: "message-1",
        authorId: "coach-1",
        authorName: "Reid Calloway (demo)",
        body: "Can we switch my bookings to my Calendly instead of Google?",
        internal: false,
        isTest: false,
        createdAt: "2026-08-31T09:12:00.000Z",
      },
      {
        id: "message-2",
        authorId: ACTOR,
        authorName: "Dana Whitfield (demo)",
        body: "The calendar token expired overnight, and it is reconnected now.",
        internal: true,
        isTest: false,
        createdAt: "2026-08-31T10:02:00.000Z",
      },
    ],
    ...overrides,
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

function surface(input: {
  notices?: readonly AttentionItem[];
  requests?: readonly PlatformSupportThreadRead[];
} = {}) {
  const attention = queue(input.notices ?? [notice({ id: "notice-1" })]);
  const lanes = inboxLanes({
    queue: attention,
    conversations: null,
    unavailableReason: "The cross-tenant handoff queue is switched off in this environment.",
    clientRequests: input.requests ?? [clientRequest()],
  });
  return render(<OwnerInbox actorId={ACTOR} lanes={lanes} queue={attention} />);
}

function row(name: RegExp) {
  return screen.getByRole("button", { name });
}

describe("OwnerInbox", () => {
  it("heads the page with one line of counts and docks the eye as the last header control", () => {
    const { container } = surface();

    expect(screen.getByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
    // Both rows are in the reader's own book, so the default "Assigned to me" scope holds both.
    expect(screen.getByText("2 waiting on a person · longest wait 15d")).toBeInTheDocument();
    // The tiles the old surface stacked above the list are gone; the line above carries both figures.
    expect(screen.queryByText("cleared this week")).toBeNull();

    const eye = container.querySelector('[data-slot="context-eye"]');
    expect(eye).toHaveAttribute("data-placement", "header");
    expect(eye?.parentElement?.lastElementChild).toBe(eye);
  });

  it("names a seeded account once, in the pill, and never in the row text", () => {
    surface();

    expect(screen.getByText("Demo data")).toBeInTheDocument();
    expect(screen.queryByText(/\(demo\)/)).toBeNull();
    expect(row(/Reid Funding Group · Dana Whitfield/)).toBeInTheDocument();
  });

  it("carries no demo pill when nothing on the page is seeded", () => {
    surface({
      notices: [notice({ id: "notice-1", isTest: false, tenantName: "Northstar Capital" })],
      requests: [clientRequest({ isTest: false, tenantIsDemo: false, tenantName: "Northstar Capital" })],
    });

    expect(screen.queryByText("Demo data")).toBeNull();
  });

  it("heads each lane with a count, and collapses an uncounted lane to that header alone", () => {
    const { container } = surface();

    const headers = [...container.querySelectorAll('[data-slot="inbox-lane-header"]')];
    expect(headers.map((header) => header.textContent)).toEqual([
      "Client requests1",
      "System problems1",
      "Lead handoffsnot countedThe cross-tenant handoff queue is switched off in this environment.",
    ]);
    // A lane with no rows draws no list under its header: an empty framed area reads as a failure.
    expect(container.querySelectorAll('[data-slot="inbox-row"][data-lane="handoff"]')).toHaveLength(0);
  });

  it("spends amber on a notice that is past its response target, and on nothing else", () => {
    surface({ notices: [notice({ id: "notice-1", minutesToBreach: -120 })] });

    const late = row(/Payment failed/);
    expect(late.querySelector('[data-slot="status-dot"]')).toHaveAttribute("data-tone", "amber");

    // The client request has no response target anywhere in the platform, so it is never late.
    const request = row(/Move my calendar to Calendly/);
    expect(request.querySelector('[data-slot="status-dot"]')).toHaveAttribute("data-tone", "wait");
  });

  it("draws no amber when no row carries a recorded target", () => {
    surface();

    expect(row(/Payment failed/).querySelector('[data-slot="status-dot"]'))
      .toHaveAttribute("data-tone", "wait");
  });

  it("marks the selected row with an accent wash and a full accent hairline, not a side stripe", () => {
    surface();

    const selected = row(/Move my calendar to Calendly/);
    expect(selected).toHaveAttribute("aria-current", "true");
    expect(selected.className).toContain("bg-[var(--accent-wash)]");
    expect(selected.className).toContain("border-[var(--accent-edge)]");
    expect(selected.className).not.toContain("border-l-");
  });

  it("filters the list by the search box and says so when nothing matches", async () => {
    const user = userEvent.setup();
    surface();

    await user.type(screen.getByPlaceholderText("Search people, clients or subjects"), "Calendly");
    expect(screen.queryByRole("button", { name: /Payment failed/ })).toBeNull();
    expect(row(/Move my calendar to Calendly/)).toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText("Search people, clients or subjects"));
    await user.type(screen.getByPlaceholderText("Search people, clients or subjects"), "zzz");
    expect(screen.getByText("No row matches that search.")).toBeInTheDocument();
  });

  it("opens the selected request with tabs, a thread, a composer and a collapsed technical footer", () => {
    const { container } = surface();

    expect(screen.getByRole("tab", { name: "Request" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Success owner" })).toBeInTheDocument();

    // Sender and time sit on one line above the bubble.
    expect(screen.getByText("Reid Calloway")).toBeInTheDocument();
    expect(screen.getByText("Can we switch my bookings to my Calendly instead of Google?"))
      .toBeInTheDocument();

    // An internal note is a dashed divider row, never another bubble the coach might be shown.
    const note = container.querySelector('[data-slot="inbox-internal-note"]');
    expect(note?.textContent).toContain("Internal note ·");

    expect(screen.getByRole("button", { name: "Reply to coach" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Internal note" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Write a reply to the coach")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reassign" })).toBeInTheDocument();

    // The fill is a gradient, so it has to be painted as a background and not a background-color.
    expect(screen.getByRole("button", { name: "Send reply" }).className)
      .toContain("[background:var(--accent-fill)]");

    const technical = container.querySelector('[data-slot="inbox-technical"]');
    expect(technical).not.toHaveAttribute("open");
    expect(technical?.textContent).toContain("Technical detail");
  });

  it("switches the composer to an internal note", async () => {
    const user = userEvent.setup();
    surface();

    await user.click(screen.getByRole("button", { name: "Internal note" }));
    expect(screen.getByPlaceholderText("Write an internal note")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save note" })).toBeInTheDocument();
  });

  it("shows one clear panel when every lane is empty", () => {
    surface({ notices: [], requests: [] });

    expect(screen.getByText("Nothing is waiting on a person")).toBeInTheDocument();
    expect(screen.getByText(/^Clear as of /)).toBeInTheDocument();
    expect(screen.getByText(/6 notices were cleared in the last week\./)).toBeInTheDocument();
    // No detail pane and no row list to sit beside it.
    expect(document.querySelector('[data-slot="inbox-detail"]')).toBeNull();
    expect(document.querySelectorAll('[data-slot="inbox-row"]')).toHaveLength(0);
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
