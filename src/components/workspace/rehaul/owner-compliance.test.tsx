import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  pathname: "/admin/compliance",
  refresh: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ refresh: navigation.refresh }),
  useSearchParams: () => navigation.searchParams,
}));

import {
  channelLabel,
  complianceRecords,
  matchesBlockFilter,
  matchesSearch,
  MESSAGE_RULES,
  OwnerCompliance,
  recordConfirmation,
  sourceLabel,
} from "@/components/workspace/rehaul/owner-compliance";
import type {
  ComplianceContact,
  LiveSuppressionRow,
  SuppressionTombstoneRow,
} from "@/components/workspace/live/admin-compliance";

const contacts: ComplianceContact[] = [
  {
    id: "contact-1",
    tenantId: "workspace-1",
    tenantName: "Reid Funding Group",
    name: "Priya Raghunathan",
    pipelineStage: "qualifying",
    lastSeenAt: "2026-08-24T10:30:00.000Z",
    isDemo: false,
    isTest: false,
  },
];

function suppression(overrides: Partial<LiveSuppressionRow> & { id: string }): LiveSuppressionRow {
  return {
    channel: "sms",
    contactName: "Terrence Boyd",
    createdAt: "2026-08-24T09:00:00.000Z",
    identifierLast4: "4471",
    isDemo: false,
    isTest: false,
    providerSyncState: "confirmed",
    providerSyncedAt: "2026-08-24T09:00:00.000Z",
    reason: null,
    source: "stop_keyword",
    tenantName: "Reid Funding Group",
    ...overrides,
  };
}

const suppressions: LiveSuppressionRow[] = [
  suppression({
    id: "block-failed",
    providerSyncState: "failed",
    providerSyncedAt: null,
    contactName: null,
  }),
  suppression({ id: "block-confirmed", contactName: "Dana Ellis", tenantName: "Cedar Ridge" }),
  suppression({
    id: "block-pending",
    contactName: "Rae Whitlock",
    providerSyncState: "pending",
    providerSyncedAt: null,
  }),
  suppression({
    id: "block-manual",
    channel: "messenger",
    contactName: "Ivo Marek",
    reason: "Asked at a live event",
    source: "manual",
  }),
];

const tombstones: SuppressionTombstoneRow[] = [
  {
    id: "deleted-block-1",
    tenantName: "Bright Path Credit",
    channel: "sms",
    identifierLast4: "5522",
    deletionAuditId: 42,
    createdAt: "2026-08-23T16:45:00.000Z",
    isDemo: false,
  },
];

const actions = {
  preview: vi.fn(async () => ({
    ok: false as const,
    error: "The deletion preview could not be loaded.",
  })),
  remove: vi.fn(async () => ({ ok: false as const, error: "Contact deletion was refused." })),
};

function renderPage(tab?: string) {
  navigation.searchParams = new URLSearchParams(tab ? `tab=${tab}` : "");
  return render(
    <OwnerCompliance
      actions={actions}
      initialContacts={contacts}
      suppressions={suppressions}
      tombstones={tombstones}
    />,
  );
}

describe("compliance view models", () => {
  it("puts a deletion record in the same list as a live block", () => {
    const records = complianceRecords(suppressions, tombstones);
    expect(records).toHaveLength(5);
    const deleted = records.find((row) => row.kind === "deleted");
    expect(deleted?.source).toBe("deletion");
    expect(deleted?.reason).toBe("Kept from a permanent deletion");
    expect(deleted?.deletionAuditId).toBe(42);
  });

  it("reads a failed confirmation as failed and a tombstone as needing none", () => {
    expect(recordConfirmation({ providerSyncState: "failed", providerSyncedAt: null }))
      .toMatchObject({ label: "Failed", tone: "critical" });
    expect(recordConfirmation({ providerSyncState: null, providerSyncedAt: null }))
      .toMatchObject({ label: "Not required", kind: "none" });
    expect(recordConfirmation({ providerSyncState: "pending", providerSyncedAt: null }))
      .toMatchObject({ label: "Pending", tone: "warning" });
  });

  it("names no vendor in a channel or source label", () => {
    expect(channelLabel("sms")).toBe("SMS");
    expect(sourceLabel("ghl_sync")).toBe("SMS");
    expect(sourceLabel("stop_keyword")).toBe("Keyword match");
    expect(sourceLabel("manual")).toBe("By hand");
  });

  it("filters by the seg and by the search term", () => {
    const records = complianceRecords(suppressions, tombstones);
    expect(records.filter((row) => matchesBlockFilter(row, "failed"))).toHaveLength(1);
    expect(records.filter((row) => matchesBlockFilter(row, "stop"))).toHaveLength(3);
    expect(records.filter((row) => matchesBlockFilter(row, "manual"))).toHaveLength(1);
    expect(records.filter((row) => matchesBlockFilter(row, "all"))).toHaveLength(5);
    expect(records.filter((row) => matchesSearch(row, "cedar"))).toHaveLength(1);
  });
});

describe("OwnerCompliance", () => {
  it("titles the page and states the failed confirmations", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Compliance" })).toBeInTheDocument();
    expect(screen.getByText("1 confirmation failed")).toBeInTheDocument();
  });

  it("prints the four figures over the blocks table", () => {
    renderPage();
    const blocks = screen.getByText("current blocks").parentElement;
    expect(within(blocks!).getByText("4")).toBeInTheDocument();
    expect(screen.getByText("awaiting confirmation")).toBeInTheDocument();
    expect(screen.getByText("confirmation failed")).toBeInTheDocument();
    const kept = screen.getByText("kept after deletion").parentElement;
    expect(within(kept!).getByText("1")).toBeInTheDocument();
  });

  it("narrows the table to failed rows when the seg is used", async () => {
    const user = userEvent.setup();
    renderPage();
    const table = screen.getByRole("table", { name: "Contact blocks and deletion records" });
    expect(within(table).getAllByRole("row")).toHaveLength(6);
    await user.click(screen.getByRole("button", { name: "Failed" }));
    const failedOnly = screen.getByRole("table", { name: "Contact blocks and deletion records" });
    expect(within(failedOnly).getAllByRole("row")).toHaveLength(2);
    expect(within(failedOnly).getByText("Failed")).toBeInTheDocument();
  });

  it("shows the five message rules with their values and no paragraph", () => {
    renderPage("message-rules");
    for (const rule of MESSAGE_RULES) {
      expect(screen.getByText(rule.title)).toBeInTheDocument();
      expect(screen.getByText(rule.value)).toBeInTheDocument();
    }
    expect(screen.queryByRole("table", { name: "Contact blocks and deletion records" })).toBeNull();
  });

  it("offers the contacts table and its logged delete action", () => {
    renderPage("contacts");
    expect(screen.getByText("Priya Raghunathan")).toBeInTheDocument();
  });

  it("prints no explainer sentence the old surface carried under a heading", () => {
    renderPage();
    expect(screen.queryByText(/A block survives everything, including deleting the contact/))
      .toBeNull();
    expect(screen.queryByText(/Checked at send time, before anything the agent decided/)).toBeNull();
    expect(screen.queryByText(/Only the two hundred most recently recorded/)).toBeNull();
    expect(screen.queryByText(/A fresh impact preview and a recorded privacy-request reason/))
      .toBeNull();
  });
});

describe("OwnerCompliance, review fixes", () => {
  it("keeps a vendor out of the Why column as well as the Source column", () => {
    const records = complianceRecords(
      [suppression({ id: "block-ghl", source: "ghl_stop_sync", channel: "ghl_sms" })],
      [],
    );
    expect(records[0]?.reason).toBe("Recorded on the texting channel");
    expect(channelLabel("ghl_sms")).toBe("SMS");
    expect(records[0]?.reason.toLowerCase()).not.toContain("ghl");
  });

  it("draws the awaiting-confirmation tile amber while a confirmation is outstanding", () => {
    renderPage();
    const tile = screen.getByText("awaiting confirmation").parentElement;
    expect(tile?.className).toContain("--warning-line");
  });

  it("gives the blocks table its own export, under impersonation too", () => {
    render(
      <OwnerCompliance
        actions={actions}
        impersonation={{ sessionId: "session-1", tenantId: "workspace-1" }}
        initialContacts={contacts}
        suppressions={suppressions}
        tombstones={tombstones}
      />,
    );
    expect(screen.getByRole("button", { name: /Export blocks/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Export every deletion record/ })).toBeNull();
  });

  it("prints the empty states without an explainer sentence under them", () => {
    render(
      <OwnerCompliance actions={actions} initialContacts={[]} suppressions={[]} tombstones={[]} />,
    );
    expect(screen.getByText("No contact blocks recorded")).toBeInTheDocument();
    expect(screen.queryByText(/after an opt-out or another verified compliance event/)).toBeNull();
  });

  it("keeps the green dot off a header that only means the table is empty", () => {
    const { container } = render(
      <OwnerCompliance actions={actions} initialContacts={[]} suppressions={[]} tombstones={[]} />,
    );
    const dot = container.querySelector('[data-slot="status-dot"]');
    expect(dot?.getAttribute("data-tone")).toBe("grey");
  });
});
