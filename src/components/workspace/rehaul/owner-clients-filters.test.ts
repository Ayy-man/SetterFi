import { describe, expect, it } from "vitest";

import {
  applyClientFilters,
  chipsForTab,
  matchesSearch,
  savedViewSnapshot,
  savedViewKey,
  writeSavedView,
  UNASSIGNED_OWNER,
  type ClientFilterRow,
} from "@/components/workspace/rehaul/owner-clients-filters";

const NOW_ISO = "2026-09-03T09:00:00.000Z";

function row(overrides: Partial<ClientFilterRow> & { id: string; name: string }): ClientFilterRow {
  return {
    ownerId: "owner-1",
    ownerName: "Theo Brightwell",
    email: null,
    plan: "Growth",
    billingState: "active",
    lastChangeIso: "2026-09-01T09:00:00.000Z",
    agentState: "live",
    unpublishedEdits: 0,
    openThreads: 0,
    bookedCalls: 7,
    grossMrrCents: 59_700,
    channelConnected: true,
    calendarConnected: true,
    texting: "cleared",
    hasProblem: false,
    ...overrides,
  };
}

const rows: ClientFilterRow[] = [
  row({ id: "tenant-1", name: "Reid Funding Group", email: "ops@reid.example" }),
  row({
    id: "tenant-2",
    name: "Northstar Funding",
    ownerId: "owner-2",
    ownerName: "Marisol Vance",
    plan: "Launch",
    billingState: "onboarding",
    lastChangeIso: "2026-06-01T09:00:00.000Z",
    agentState: "draft",
    unpublishedEdits: 3,
    openThreads: 12,
    bookedCalls: 0,
    grossMrrCents: null,
    channelConnected: false,
    calendarConnected: false,
    texting: "waiting",
  }),
  row({
    id: "tenant-3",
    name: "Evergreen Funding",
    ownerId: null,
    ownerName: null,
    plan: "Launch",
    billingState: "suspended",
    lastChangeIso: "2026-08-20T09:00:00.000Z",
    agentState: null,
    unpublishedEdits: null,
    openThreads: null,
    bookedCalls: null,
    grossMrrCents: null,
    channelConnected: null,
    calendarConnected: null,
    texting: null,
    hasProblem: true,
  }),
];

function visible(input: Parameters<typeof applyClientFilters>[0]) {
  return applyClientFilters(input).map((entry) => entry.id);
}

describe("client book search", () => {
  it("matches the client name, the owner name and the address, case-insensitively", () => {
    expect(matchesSearch(rows[0], "reid")).toBe(true);
    expect(matchesSearch(rows[0], "BRIGHTWELL")).toBe(true);
    expect(matchesSearch(rows[0], "ops@reid")).toBe(true);
    expect(matchesSearch(rows[0], "northstar")).toBe(false);
  });

  it("treats a blank search as no search at all", () => {
    expect(matchesSearch(rows[2], "   ")).toBe(true);
  });

  it("narrows the rows the table draws", () => {
    expect(visible({ nowIso: NOW_ISO, rows, search: "funding", selections: {} }))
      .toEqual(["tenant-1", "tenant-2", "tenant-3"]);
    expect(visible({ nowIso: NOW_ISO, rows, search: "marisol", selections: {} }))
      .toEqual(["tenant-2"]);
  });
});

describe("chips per tab", () => {
  it("reads its value lists off the rows rather than a fixed vocabulary", () => {
    const chips = chipsForTab("status", rows);
    expect(chips.map((chip) => chip.label))
      .toEqual(["Plan", "Billing state", "Live since", "Owner"]);

    const plan = chips.find((chip) => chip.key === "plan");
    expect(plan?.kind === "menu" && plan.options.map((option) => option.value))
      .toEqual(["Growth", "Launch"]);

    const owner = chips.find((chip) => chip.key === "owner");
    expect(owner?.kind === "menu" && owner.options.map((option) => option.label))
      .toEqual(["Marisol Vance", "Theo Brightwell", "Nobody owns this"]);
  });

  it("carries the four artboard chips per tab, with the unmeasured ones saying so", () => {
    expect(chipsForTab("performance", rows).map((chip) => chip.label))
      .toEqual(["Booked calls", "Gross MRR", "Margin", "Period"]);
    const margin = chipsForTab("performance", rows).find((chip) => chip.key === "margin");
    expect(margin?.kind).toBe("note");
    expect(margin?.kind === "note" && margin.note).toMatch(/not measured per client/u);

    expect(chipsForTab("health", rows).map((chip) => chip.label))
      .toEqual(["Channel", "Problems first", "Texting registration", "Calendar"]);
    expect(chipsForTab("health", rows).find((chip) => chip.key === "problems")?.kind)
      .toBe("toggle");

    // Every other tab that draws rows offers Plan at least, and Setup draws no rows at all.
    expect(chipsForTab("agent", rows).map((chip) => chip.key)).toContain("plan");
    expect(chipsForTab("team", rows).map((chip) => chip.key)).toContain("plan");
    expect(chipsForTab("setup", rows)).toHaveLength(0);
  });
});

describe("chip filtering", () => {
  it("combines chips with AND and leaves the incoming book order alone", () => {
    expect(visible({ nowIso: NOW_ISO, rows, search: "", selections: { plan: "Launch" } }))
      .toEqual(["tenant-2", "tenant-3"]);
    expect(visible({
      nowIso: NOW_ISO,
      rows,
      search: "",
      selections: { plan: "Launch", billing: "suspended" },
    })).toEqual(["tenant-3"]);
  });

  it("filters the clients nobody owns behind their own owner value", () => {
    expect(visible({ nowIso: NOW_ISO, rows, search: "", selections: { owner: UNASSIGNED_OWNER } }))
      .toEqual(["tenant-3"]);
    expect(visible({ nowIso: NOW_ISO, rows, search: "", selections: { owner: "owner-2" } }))
      .toEqual(["tenant-2"]);
  });

  it("buckets the last change by age, including the older-than bucket", () => {
    expect(visible({ nowIso: NOW_ISO, rows, search: "", selections: { since: "7" } }))
      .toEqual(["tenant-1"]);
    expect(visible({ nowIso: NOW_ISO, rows, search: "", selections: { since: "30" } }))
      .toEqual(["tenant-1", "tenant-3"]);
    expect(visible({ nowIso: NOW_ISO, rows, search: "", selections: { since: "older" } }))
      .toEqual(["tenant-2"]);
  });

  it("drops an unmeasured figure from a threshold rather than counting it as zero", () => {
    expect(visible({ nowIso: NOW_ISO, rows, search: "", selections: { booked: "1" } }))
      .toEqual(["tenant-1"]);
    expect(visible({ nowIso: NOW_ISO, rows, search: "", selections: { mrr: "100000" } }))
      .toEqual([]);
    expect(visible({ nowIso: NOW_ISO, rows, search: "", selections: { threads: "any" } }))
      .toEqual(["tenant-2"]);
    expect(visible({ nowIso: NOW_ISO, rows, search: "", selections: { edits: "none" } }))
      .toEqual(["tenant-1"]);
  });

  it("names the agent, channel, texting and calendar states the health tab draws", () => {
    expect(visible({ nowIso: NOW_ISO, rows, search: "", selections: { agentState: "none" } }))
      .toEqual(["tenant-3"]);
    expect(visible({ nowIso: NOW_ISO, rows, search: "", selections: { channel: "connected" } }))
      .toEqual(["tenant-1"]);
    expect(visible({ nowIso: NOW_ISO, rows, search: "", selections: { texting: "waiting" } }))
      .toEqual(["tenant-2"]);
    expect(visible({ nowIso: NOW_ISO, rows, search: "", selections: { calendar: "not_cleared" } }))
      .toEqual(["tenant-2"]);
  });

  it("lifts problem rows without hiding the rest", () => {
    expect(visible({ nowIso: NOW_ISO, rows, search: "", selections: { problems: "on" } }))
      .toEqual(["tenant-3", "tenant-1", "tenant-2"]);
  });

  it("ignores a chip key it does not know, so a stale saved view cannot empty the table", () => {
    expect(visible({ nowIso: NOW_ISO, rows, search: "", selections: { retired: "yes" } }))
      .toHaveLength(3);
  });
});

describe("the saved view", () => {
  /**
   * An in-memory stand-in rather than the real `localStorage`: this module is pure and its tests
   * run in node, and a storage the test owns is also the only way to make the throwing case real.
   */
  function memoryStorage() {
    const held = new Map<string, string>();
    return {
      getItem: (key: string) => held.get(key) ?? null,
      setItem: (key: string, value: string) => void held.set(key, value),
      removeItem: (key: string) => void held.delete(key),
    };
  }

  it("round-trips one view per tab", () => {
    const store = memoryStorage();
    writeSavedView("status", { search: "reid", selections: { plan: "Growth" } }, store);

    expect(savedViewSnapshot("status", store))
      .toEqual({ search: "reid", selections: { plan: "Growth" } });
    expect(savedViewSnapshot("health", store)).toBeNull();
    expect(savedViewKey("status")).not.toBe(savedViewKey("health"));
  });

  it("returns null rather than throwing when storage is unreadable or holds nonsense", () => {
    const broken = {
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("blocked"); },
      removeItem() { throw new Error("blocked"); },
    };
    expect(savedViewSnapshot("status", broken)).toBeNull();
    expect(writeSavedView("status", { search: "", selections: {} }, broken)).toBe(false);

    const store = memoryStorage();
    store.setItem(savedViewKey("agent"), "{not json");
    expect(savedViewSnapshot("agent", store)).toBeNull();
    store.setItem(savedViewKey("agent"), JSON.stringify({ selections: 4 }));
    expect(savedViewSnapshot("agent", store)).toEqual({ search: "", selections: {} });
  });
});
