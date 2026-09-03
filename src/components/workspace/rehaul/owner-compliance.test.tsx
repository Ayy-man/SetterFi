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
  MESSAGE_RULES,
  OwnerCompliance,
} from "@/components/workspace/rehaul/owner-compliance";
import {
  blockCounts,
  blockReason,
  channelLabel,
  clientOptions,
  complianceRecords,
  countBucket,
  INITIAL_BLOCK_FILTERS,
  matchesBlockFilters,
  matchesSearch,
  reasonOptions,
  recordConfirmation,
  sourceLabel,
} from "@/components/workspace/rehaul/owner-compliance-filters";
import type {
  ComplianceContact,
  LiveSuppressionRow,
  SuppressionTombstoneRow,
} from "@/components/workspace/live/admin-compliance";

const contacts: ComplianceContact[] = [
  {
    id: "contact-1",
    tenantId: "workspace-1",
    tenantName: "Reid Funding Group (demo)",
    name: "Priya Raghunathan (demo)",
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

function blocksTable() {
  return screen.getByRole("table", { name: "Contact blocks and deletion records" });
}

describe("compliance view models", () => {
  it("puts a deletion record in the same list as a live block", () => {
    const records = complianceRecords(suppressions, tombstones);
    expect(records).toHaveLength(5);
    const deleted = records.find((row) => row.kind === "deleted");
    expect(deleted?.source).toBe("deletion");
    expect(deleted?.reason).toBe("Kept through a permanent deletion");
    expect(deleted?.deletionAuditId).toBe(42);
  });

  it("reads a failed confirmation as failed and a tombstone as needing none", () => {
    expect(recordConfirmation({ providerSyncState: "failed", providerSyncedAt: null }))
      .toMatchObject({ label: "Failed", tone: "critical" });
    expect(recordConfirmation({ providerSyncState: null, providerSyncedAt: null }))
      .toMatchObject({ label: "Not required", kind: "none" });
    expect(recordConfirmation({ providerSyncState: "pending", providerSyncedAt: null }))
      .toMatchObject({ label: "Pending", tone: "neutral" });
  });

  it("turns a pending confirmation amber only once it has waited a week", () => {
    const row = {
      providerSyncState: "pending",
      providerSyncedAt: null,
      recordedAt: "2026-08-24T09:00:00.000Z",
    };
    const threeDays = recordConfirmation(row, Date.parse("2026-08-27T09:00:00.000Z"));
    expect(threeDays).toMatchObject({ label: "Pending · 3d", tone: "neutral" });
    const fifteenDays = recordConfirmation(row, Date.parse("2026-09-08T09:00:00.000Z"));
    expect(fifteenDays).toMatchObject({ label: "Pending · 15d", tone: "warning" });
  });

  it("names no vendor in a channel or source label", () => {
    expect(channelLabel("sms")).toBe("SMS");
    expect(sourceLabel("ghl_sync")).toBe("SMS");
    expect(sourceLabel("stop_keyword")).toBe("Keyword match");
    expect(sourceLabel("manual")).toBe("By hand");
  });

  it("says Replied STOP without the seeded reason the fixtures store beside it", () => {
    expect(blockReason({ source: "stop_keyword", reason: "Synthetic STOP state" }))
      .toBe("Replied STOP");
    expect(blockReason({ source: "manual", reason: "Asked at a live event" }))
      .toBe("Recorded by hand (Asked at a live event)");
  });

  it("counts each row under one chip, and a row needing no confirmation under none", () => {
    const records = complianceRecords(suppressions, tombstones);
    expect(blockCounts(records)).toEqual({
      all: 5,
      confirmed: 2,
      awaiting: 1,
      failed: 1,
      kept: 1,
    });
    expect(countBucket(records.find((row) => row.kind === "deleted")!)).toBe("kept");
  });

  it("filters by chip, by reason, by client, by recency and by the search term", () => {
    const records = complianceRecords(suppressions, tombstones);
    const filtered = (patch: Partial<typeof INITIAL_BLOCK_FILTERS>, now?: number) =>
      records.filter((row) => matchesBlockFilters(row, { ...INITIAL_BLOCK_FILTERS, ...patch }, now));

    expect(filtered({ count: "failed" })).toHaveLength(1);
    expect(filtered({ count: "kept" })).toHaveLength(1);
    expect(filtered({ count: "all" })).toHaveLength(5);
    expect(filtered({ reason: "Replied STOP" })).toHaveLength(3);
    expect(filtered({ client: "Cedar Ridge" })).toHaveLength(1);
    expect(filtered({ search: "cedar" })).toHaveLength(1);
    expect(filtered({ search: "4471" })).toHaveLength(4);
    expect(filtered({ recent: true }, Date.parse("2026-08-25T09:00:00.000Z"))).toHaveLength(5);
    expect(filtered({ recent: true }, Date.parse("2026-11-25T09:00:00.000Z"))).toHaveLength(0);
  });

  it("offers each reason and each client once, with no seeded suffix on a client name", () => {
    const records = complianceRecords(
      [suppression({ id: "block-demo", tenantName: "Reid Funding Group (demo)", isDemo: true })],
      [],
    );
    expect(reasonOptions(records)).toEqual(["Replied STOP"]);
    expect(clientOptions(records)).toEqual(["Reid Funding Group"]);
    expect(matchesSearch(records[0]!, "(demo)")).toBe(false);
  });
});

describe("OwnerCompliance", () => {
  it("titles the page and states the failed confirmations", () => {
    renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Compliance" })).toBeInTheDocument();
    expect(screen.getByText("1 confirmation failed")).toBeInTheDocument();
  });

  it("carries the five counts as chips instead of tiles", () => {
    renderPage();
    for (const [name, count] of [
      ["All", "5"],
      ["Confirmed", "2"],
      ["Awaiting confirmation", "1"],
      ["Failed", "1"],
      ["Kept after deletion", "1"],
    ] as const) {
      const chip = screen.getByRole("button", { name: `${count} ${name}` });
      expect(chip).toHaveAttribute("aria-pressed", name === "All" ? "true" : "false");
    }
    expect(screen.queryByText("current blocks")).toBeNull();
    expect(screen.queryByText("kept after deletion")).toBeNull();
  });

  it("narrows the table to failed rows when the count chip is pressed", async () => {
    const user = userEvent.setup();
    renderPage();
    expect(within(blocksTable()).getAllByRole("row")).toHaveLength(6);
    await user.click(screen.getByRole("button", { name: "1 Failed" }));
    expect(within(blocksTable()).getAllByRole("row")).toHaveLength(2);
    expect(within(blocksTable()).getByText("Failed")).toBeInTheDocument();
  });

  async function chooseFacet(
    user: ReturnType<typeof userEvent.setup>,
    facet: "Reason" | "Client",
    option: string,
  ) {
    await user.click(screen.getByRole("button", { name: new RegExp(`^${facet}`) }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: option }));
    // A checkbox item leaves the menu open, so the next press has to land on the chip itself.
    await user.keyboard("{Escape}");
  }

  async function clearFacet(
    user: ReturnType<typeof userEvent.setup>,
    facet: "Reason" | "Client",
  ) {
    await user.click(screen.getByRole("button", { name: new RegExp(`^${facet}`) }));
    await user.click(
      await screen.findByRole("menuitem", { name: `Clear ${facet.toLocaleLowerCase()}` }),
    );
  }

  it("narrows the table by reason, by client and by the search box", async () => {
    const user = userEvent.setup();
    renderPage();

    await chooseFacet(user, "Client", "Cedar Ridge");
    expect(within(blocksTable()).getAllByRole("row")).toHaveLength(2);
    expect(within(blocksTable()).getByText("Dana Ellis")).toBeInTheDocument();

    await clearFacet(user, "Client");
    await chooseFacet(user, "Reason", "Recorded by hand (Asked at a live event)");
    expect(within(blocksTable()).getAllByRole("row")).toHaveLength(2);
    expect(within(blocksTable()).getByText("Ivo Marek")).toBeInTheDocument();

    await clearFacet(user, "Reason");
    await user.type(
      screen.getByLabelText("Search contact, number, client or reason"),
      "whitlock",
    );
    expect(within(blocksTable()).getAllByRole("row")).toHaveLength(2);
    expect(within(blocksTable()).getByText("Rae Whitlock")).toBeInTheDocument();
  });

  it("filters through the kit chip rather than a native select", () => {
    const { container } = renderPage();
    expect(container.querySelector("select")).toBeNull();
    expect(screen.getByRole("button", { name: /^Reason/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Client/ })).toBeInTheDocument();
  });

  it("says nothing matches once the filters exclude every row", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(
      screen.getByLabelText("Search contact, number, client or reason"),
      "nobody by that name",
    );
    expect(screen.getByText("No blocks match this filter")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Contact blocks and deletion records" })).toBeNull();
  });

  it("explains the amber rule in one footer line and nowhere else", () => {
    renderPage();
    expect(screen.getByText("A block still awaiting confirmation after 7 days is shown amber."))
      .toBeInTheDocument();
    expect(screen.getByText("Deletion records live under Export")).toBeInTheDocument();
  });

  it("names the client column and the client, with no seeded suffix in the cell", () => {
    renderPage();
    const table = blocksTable();
    expect(within(table).getByRole("columnheader", { name: "Client" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Reason" })).toBeInTheDocument();
    expect(within(table).queryByRole("columnheader", { name: "Workspace" })).toBeNull();
    expect(within(table).getAllByText("Replied STOP").length).toBeGreaterThan(0);
  });

  it("docks the context eye in the header after the exports", () => {
    const { container } = renderPage();
    const header = container.querySelector('[data-slot="context-eye"]')?.parentElement;
    expect(header).not.toBeNull();
    const controls = [...header!.children];
    expect(controls.at(-1)).toBe(container.querySelector('[data-slot="context-eye"]'));
    expect(controls.length).toBeGreaterThan(1);
  });

  it("shows the five message rules with their values and no paragraph", () => {
    renderPage("message-rules");
    for (const rule of MESSAGE_RULES) {
      expect(screen.getByText(rule.title)).toBeInTheDocument();
      expect(screen.getByText(rule.value)).toBeInTheDocument();
    }
    expect(screen.queryByRole("table", { name: "Contact blocks and deletion records" })).toBeNull();
  });

  it("offers the contacts table under the name a reader should see", () => {
    renderPage("contacts");
    expect(screen.getByText("Priya Raghunathan")).toBeInTheDocument();
    expect(screen.queryByText("Priya Raghunathan (demo)")).toBeNull();
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
  it("keeps a vendor out of the Reason column as well as the Source column", () => {
    const records = complianceRecords(
      [suppression({ id: "block-ghl", source: "ghl_stop_sync", channel: "ghl_sms" })],
      [],
    );
    expect(records[0]?.reason).toBe("Recorded on the texting channel");
    expect(channelLabel("ghl_sms")).toBe("SMS");
    expect(records[0]?.reason.toLowerCase()).not.toContain("ghl");
  });

  it("carries both exports under one header control", async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole("button", { name: "Export" }));
    expect(await screen.findByRole("menuitem", { name: /Download CSV, Blocks on screen/ }))
      .toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Download CSV, Every deletion record/ }))
      .toBeInTheDocument();
  });

  it("gives the blocks export under impersonation, and the deletion export to nobody there", async () => {
    const user = userEvent.setup();
    render(
      <OwnerCompliance
        actions={actions}
        impersonation={{ sessionId: "session-1", tenantId: "workspace-1" }}
        initialContacts={contacts}
        suppressions={suppressions}
        tombstones={tombstones}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Export" }));
    expect(await screen.findByRole("menuitem", { name: /Download CSV, Blocks on screen/ }))
      .toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Every deletion record/ })).toBeNull();
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
