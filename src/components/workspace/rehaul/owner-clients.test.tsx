import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  pathname: "/admin/platform-clients",
  refresh: vi.fn(),
  replace: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: vi.fn(), refresh: navigation.refresh, replace: navigation.replace }),
  useSearchParams: () => navigation.searchParams,
}));

import {
  OwnerClients,
  type OwnerClientsHealth,
  type OwnerClientsPerformance,
} from "@/components/workspace/rehaul/owner-clients";
import type { ProvisioningTrackerRow } from "@/lib/onboarding/contracts";
import type { AgentRoster } from "@/lib/operations/agent-roster";
import type { SuccessClientBookRead } from "@/lib/repositories/support";

const NOW_ISO = "2026-09-03T09:00:00.000Z";

/** The sentence the old client book printed under its title. It may not survive the rehaul. */
const OLD_PURPOSE =
  "Every coach on the platform, the state they are in, and who on the team owns them.";
const OLD_FOOTER_NOTE =
  "Order is what each row is waiting on, then how recently it moved.";

function client(overrides: Partial<SuccessClientBookRead> & { id: string; name: string }): SuccessClientBookRead {
  const { id, name, ...rest } = overrides;
  return {
    client: { id, name, isDemo: false },
    status: "active",
    successOwner: { id: "owner-1", name: "Theo Brightwell" },
    supportStatus: null,
    planId: "plan-growth",
    planLabel: "Growth",
    updatedAt: "2026-08-28T12:00:00.000Z",
    ...rest,
  };
}

const rows: SuccessClientBookRead[] = [
  client({ id: "tenant-1", name: "Reid Funding Group", supportStatus: "open" }),
  client({
    id: "tenant-2",
    name: "Northstar Funding",
    planLabel: "Launch",
    status: "onboarding",
  }),
  client({ id: "tenant-3", name: "Evergreen Funding", successOwner: null, status: "onboarding" }),
];

/**
 * A seeded row, exactly as the fixtures write one: the `(demo)` marker is on the tenant, the plan
 * and the person. The screen has to strip all three and let the pill carry the fact instead.
 */
const demoRow: SuccessClientBookRead = {
  client: { id: "tenant-4", name: "Staging Demo Tenant (demo)", isDemo: true },
  status: "active",
  successOwner: { id: "owner-2", name: "Marisol Vance (demo)" },
  supportStatus: null,
  planId: "plan-launch",
  planLabel: "Launch (demo)",
  updatedAt: "2026-08-27T12:00:00.000Z",
};

const roster: AgentRoster = {
  brainVersion: 18,
  entries: [
    {
      tenantId: "tenant-1",
      clientName: "Reid Funding Group",
      isTest: false,
      state: "live",
      liveVersion: 7,
      publishedAt: "2026-07-21T10:00:00.000Z",
      unpublishedEdits: 2,
      latestEditAt: "2026-08-30T10:00:00.000Z",
      openThreads: 12,
      overrides: 5,
      accountState: "active",
    },
  ],
  settingCount: 18,
  threadsUnavailable: false,
};

const performance: OwnerClientsPerformance = {
  origin: "real_analytics",
  role: "owner",
  tenantPerformance: [
    { tenantId: "tenant-1", bookedAppointments: 7, grossMrrCents: 59_700 },
  ],
  history: [
    { periodStart: "2026-07-01", periodEnd: "2026-07-31", value: 18, state: "available" },
    { periodStart: "2026-08-01", periodEnd: "2026-08-31", value: 24, state: "available" },
  ],
};

const tracker: ProvisioningTrackerRow = {
  signupIntentId: "intent-1",
  tenantId: "tenant-1",
  businessName: "Reid Funding Group",
  signupState: "completed",
  currentStep: "a2p_campaign",
  state: "awaiting_provider",
  attempts: 1,
  errorCode: null,
  blockingParty: "provider",
  blockingProvider: "carrier",
  stalledSince: null,
  isDemo: false,
  contentScreenId: null,
  contentScreenState: null,
};

const health: OwnerClientsHealth = {
  rows: [tracker],
  a2pSubmittedAtByTenant: { "tenant-1": "2026-08-25T09:00:00.000Z" },
};

function renderPage(overrides: Partial<Parameters<typeof OwnerClients>[0]> = {}) {
  return render(
    <OwnerClients
      actorId="actor-1"
      actorRole="owner"
      agents={{ kind: "ready", value: roster }}
      book="all"
      enabled
      health={{ kind: "ready", value: health }}
      nowIso={NOW_ISO}
      performance={{ kind: "ready", value: performance }}
      rows={rows}
      rowsError={null}
      selectedClientId={null}
      selectedOwnerId={null}
      tab="status"
      {...overrides}
    />,
  );
}

describe("OwnerClients", () => {
  /**
   * The suite's jsdom carries no storage of its own, and the saved view is browser storage, so each
   * spec gets a fresh one. A spec's Save view must not open the next spec's tab.
   */
  beforeEach(() => {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        key: (index: number) => [...values.keys()][index] ?? null,
        get length() {
          return values.size;
        },
        removeItem: (key: string) => void values.delete(key),
        setItem: (key: string, value: string) => void values.set(key, value),
      },
    });
  });

  it("heads the page with Clients and a counted subline, and prints none of the old explainers", () => {
    renderPage();

    expect(screen.getByRole("heading", { level: 1, name: "Clients" })).toBeInTheDocument();
    expect(screen.getByText("3", { selector: ".font-mono" })).toBeInTheDocument();
    expect(screen.getByText(/need a hand/u)).toBeInTheDocument();
    expect(screen.queryByText(OLD_PURPOSE)).not.toBeInTheDocument();
    expect(screen.queryByText(new RegExp(OLD_FOOTER_NOTE, "u"))).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("GoHighLevel");
    expect(document.body.textContent).not.toContain("Twilio");
  });

  it("carries the six tabs and swaps the table columns with them", () => {
    const { unmount } = renderPage();
    for (const label of ["Status", "Agent", "Performance", "Health", "Team", "Setup"]) {
      expect(screen.getByRole("navigation", { name: "Client sections" })).toHaveTextContent(label);
    }
    expect(screen.getByRole("columnheader", { name: "Success owner" })).toBeInTheDocument();
    unmount();

    renderPage({ tab: "agent" });
    expect(screen.getByRole("columnheader", { name: "Live version" })).toBeInTheDocument();
    expect(screen.getByText("v7")).toBeInTheDocument();
    expect(screen.getByText("13 of 18")).toBeInTheDocument();
  });

  it("counts the carrier wait in days on the Health tab and never as a date or a percentage", () => {
    renderPage({ tab: "health" });

    expect(screen.getByText("day 9")).toBeInTheDocument();
    expect(screen.getByText(/Waiting on the carrier/u)).toBeInTheDocument();
    // A carrier wait is never a percentage and never a predicted date, so neither reaches the table.
    expect(screen.getByRole("table").textContent).not.toMatch(/%/u);
    expect(screen.getByRole("table").textContent).not.toMatch(/\d{1,2} (Sep|Oct|Nov)/u);
  });

  it("opens the drawer for the selected client and draws the six stages on the Health tab", () => {
    renderPage({ selectedClientId: "tenant-1", tab: "health" });

    const drawer = document.querySelector("[data-slot='owner-clients-drawer']");
    expect(drawer).not.toBeNull();
    const stepper = document.querySelector("[data-slot='owner-clients-stepper']");
    expect(stepper?.children).toHaveLength(6 + 1);
    expect(within(drawer as HTMLElement).getByText("Texting registration")).toBeInTheDocument();
    expect(within(drawer as HTMLElement).getByText("with carrier")).toBeInTheDocument();
    expect(within(drawer as HTMLElement).getByText("Logged")).toBeInTheDocument();
  });

  it("draws the Team tab as counted tiles and one card per person, with the clients nobody owns", () => {
    renderPage({ tab: "team" });

    // Four tiles: one person holds a book, two of the three clients are assigned to them, one of
    // those has an open request, and the third client has no owner at all.
    const tiles = document.querySelector("[data-slot='owner-clients-team-tiles']");
    expect(tiles).not.toBeNull();
    expect(within(tiles as HTMLElement).getByText("person with a book").previousSibling)
      .toHaveTextContent("1");
    expect(within(tiles as HTMLElement).getByText("clients assigned").previousSibling)
      .toHaveTextContent("2");
    expect(within(tiles as HTMLElement).getByText("open requests").previousSibling)
      .toHaveTextContent("1");
    expect(within(tiles as HTMLElement).getByText("unassigned").previousSibling)
      .toHaveTextContent("1");

    const cards = document.querySelector("[data-slot='owner-clients-team-cards']");
    expect(cards).not.toBeNull();
    const card = within(cards as HTMLElement).getByRole("link", { name: /Theo Brightwell/u });
    expect(card).toHaveTextContent("1 live · 1 onboarding · 1 open");
    expect(card).toHaveTextContent("Reid Funding Group");
    // No reply clock is recorded per owner, so the card says so rather than standing a number in.
    expect(card).toHaveTextContent("not measured");
    // The roster is a board now, so the tab carries no column set of its own.
    expect(screen.queryByRole("columnheader", { name: "Person" })).toBeNull();

    expect(screen.getByText("Waiting for an owner")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Evergreen Funding" })).toBeInTheDocument();
    // The unassigned table carries its own export, scoped to the rows it draws.
    const waiting = screen.getByText("Waiting for an owner").closest("div") as HTMLElement;
    expect(within(waiting).getByRole("button", { name: /Export/u })).toBeInTheDocument();
  });

  it("opens the owner drawer with the book, the open requests and a reassign route", () => {
    renderPage({ selectedOwnerId: "owner-1", tab: "team" });

    const drawer = document.querySelector("[data-slot='owner-clients-drawer']") as HTMLElement;
    expect(drawer).not.toBeNull();
    expect(within(drawer).getByText("Success owner · 2 clients")).toBeInTheDocument();
    expect(within(drawer).getByText("Book")).toBeInTheDocument();
    expect(within(drawer).getByText("Open requests")).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: "Reassign a client" })).toBeInTheDocument();
    expect(within(drawer).getByRole("link", { name: "Open in Support" })).toBeInTheDocument();
    expect(within(drawer).getByText("Logged")).toBeInTheDocument();
  });

  it("draws the marketplace install surface on the Setup tab instead of the client table", () => {
    renderPage({
      setup: <div data-testid="install-surface">Marketplace install</div>,
      tab: "setup",
    });

    expect(screen.getByTestId("install-surface")).toBeInTheDocument();
    // The tab is a mounted surface, not a sixth column set, so no client table is drawn under it
    // and no drawer opens beside it.
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByTestId("owner-clients-drawer")).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("keeps a folded tab's own refusal rather than showing it as an empty table", () => {
    renderPage({
      performance: { kind: "refused", reason: "Platform analytics is not turned on in this environment." },
      tab: "performance",
    });

    expect(screen.getByText("This tab could not be read")).toBeInTheDocument();
    expect(screen.getByText("Platform analytics is not turned on in this environment.")).toBeInTheDocument();
  });

  it("docks the context eye in the header row as the last control, and never floats it", () => {
    renderPage();

    const eye = document.querySelector("[data-slot='context-eye']") as HTMLElement;
    expect(eye).not.toBeNull();
    expect(eye.dataset.placement).toBe("header");
    expect(eye.className).not.toMatch(/fixed/u);

    // Last in the header's trailing control row, after Export.
    const controls = eye.parentElement as HTMLElement;
    expect(controls.lastElementChild).toBe(eye);
    expect(within(controls).getByRole("button", { name: /Export/u })).toBeInTheDocument();
  });

  it("prints a seeded name without its marker and lets the Demo pill carry the fact", () => {
    renderPage({ rows: [demoRow] });

    expect(screen.getByRole("link", { name: "Staging Demo Tenant" })).toBeInTheDocument();
    expect(screen.getByText("Launch")).toBeInTheDocument();
    expect(screen.getByText("Marisol Vance")).toBeInTheDocument();
    expect(screen.getByRole("table").textContent).not.toContain("(demo)");
    const pill = document.querySelector("[data-slot='pill']");
    expect(pill).toHaveTextContent("Demo");
  });

  it("searches the client and the owner name across every tab and counts what survives", async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage();

    const box = screen.getByRole("searchbox", { name: "Search clients" });
    expect(screen.getByTestId("owner-clients-count")).toHaveTextContent("3 of 3");

    await user.type(box, "northstar");
    expect(screen.getByRole("link", { name: "Northstar Funding" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Reid Funding Group" })).toBeNull();
    expect(screen.getByTestId("owner-clients-count")).toHaveTextContent("1 of 3");

    // A search that matches nothing says so, rather than reading as an empty book.
    await user.clear(box);
    await user.type(box, "nobody");
    expect(screen.getByText(/matches the search and filters/u)).toBeInTheDocument();
    unmount();

    // The same box, on a tab with a different column set, over the owner's name this time.
    renderPage({ tab: "health" });
    await user.type(screen.getByRole("searchbox", { name: "Search clients" }), "brightwell");
    expect(screen.getByTestId("owner-clients-count")).toHaveTextContent("2 of 3");
  });

  it("carries the artboard's chips per tab and narrows the rows with them", async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage();

    for (const chip of ["Plan", "Billing state", "Live since", "Owner"]) {
      expect(screen.getByRole("button", { name: new RegExp(chip, "u") })).toBeInTheDocument();
    }

    await user.click(screen.getByRole("button", { name: /^Plan/u }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Launch" }));
    expect(screen.getByRole("button", { name: /Plan/u })).toHaveTextContent("Launch");
    expect(screen.getByTestId("owner-clients-count")).toHaveTextContent("1 of 3");
    expect(screen.getByRole("link", { name: "Northstar Funding" })).toBeInTheDocument();
    unmount();

    renderPage({ tab: "performance" });
    for (const chip of ["Booked calls", "Gross MRR", "Margin", "Period"]) {
      expect(screen.getByRole("button", { name: new RegExp(chip, "u") })).toBeInTheDocument();
    }
    // Margin has no read behind it, so its chip says which figure is missing instead of filtering.
    await user.click(screen.getByRole("button", { name: /Margin/u }));
    expect(await screen.findByText(/Margin is not measured per client yet/u)).toBeInTheDocument();
    expect(screen.getByTestId("owner-clients-count")).toHaveTextContent("3 of 3");
  });

  it("lifts the problem rows on Health without hiding the rest", async () => {
    const user = userEvent.setup();
    renderPage({
      health: {
        kind: "ready",
        value: {
          a2pSubmittedAtByTenant: {},
          rows: [{ ...tracker, tenantId: "tenant-2", state: "failed", currentStep: "phone_number" }],
        },
      },
      tab: "health",
    });

    const first = () => within(screen.getByRole("table")).getAllByRole("link")[0];
    expect(first()).toHaveTextContent("Reid Funding Group");

    await user.click(screen.getByRole("button", { name: /Problems first/u }));
    expect(first()).toHaveTextContent("Northstar Funding");
    expect(screen.getByTestId("owner-clients-count")).toHaveTextContent("3 of 3");
  });

  it("remembers a saved view per tab and opens the tab with it", async () => {
    const user = userEvent.setup();
    const { unmount } = renderPage();

    await user.type(screen.getByRole("searchbox", { name: "Search clients" }), "evergreen");
    await user.click(screen.getByRole("button", { name: "Save view" }));
    expect(screen.getByRole("status")).toHaveTextContent(/opens with these filters/u);
    unmount();

    const reopened = renderPage();
    expect(screen.getByRole("searchbox", { name: "Search clients" })).toHaveValue("evergreen");
    expect(screen.getByTestId("owner-clients-count")).toHaveTextContent("1 of 3");
    reopened.unmount();

    // The view is scoped to the tab it was saved on: Health opens unfiltered.
    renderPage({ tab: "health" });
    expect(screen.getByRole("searchbox", { name: "Search clients" })).toHaveValue("");
    expect(screen.getByTestId("owner-clients-count")).toHaveTextContent("3 of 3");
  });

  it("draws no filter row on Setup, which is an install surface rather than a book of clients", () => {
    renderPage({ setup: <div>Marketplace install</div>, tab: "setup" });

    expect(screen.queryByRole("searchbox", { name: "Search clients" })).toBeNull();
    expect(screen.queryByTestId("owner-clients-count")).toBeNull();
  });

  it("refuses honestly when the client book is not enabled", () => {
    renderPage({ enabled: false, rows: [] });

    expect(screen.getByText("Client book is not enabled")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
