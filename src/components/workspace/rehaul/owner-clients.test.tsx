import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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

  it("carries the five tabs and swaps the table columns with them", () => {
    const { unmount } = renderPage();
    for (const label of ["Status", "Agent", "Performance", "Health", "Team"]) {
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

  it("lists the success-team roster on the Team tab with the clients nobody owns", () => {
    renderPage({ tab: "team" });

    expect(screen.getByRole("columnheader", { name: "Person" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Theo Brightwell" })).toBeInTheDocument();
    expect(screen.getByText("Waiting for an owner")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Evergreen Funding" })).toBeInTheDocument();
  });

  it("keeps a folded tab's own refusal rather than showing it as an empty table", () => {
    renderPage({
      performance: { kind: "refused", reason: "Platform analytics is not turned on in this environment." },
      tab: "performance",
    });

    expect(screen.getByText("This tab could not be read")).toBeInTheDocument();
    expect(screen.getByText("Platform analytics is not turned on in this environment.")).toBeInTheDocument();
  });

  it("refuses honestly when the client book is not enabled", () => {
    renderPage({ enabled: false, rows: [] });

    expect(screen.getByText("Client book is not enabled")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
