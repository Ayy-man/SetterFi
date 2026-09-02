import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  pathname: "/admin/platform-clients",
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({
    push: navigation.push,
    refresh: navigation.refresh,
    replace: navigation.replace,
  }),
  useSearchParams: () => navigation.searchParams,
}));

import {
  SuccessClientBook,
  assigneeOptionsFor,
  clientCommandsFor,
  healthSignalRow,
} from "@/components/workspace/live/success-client-book";
import type { TenantHealthSignalDetail } from "@/lib/operations/tenant-health-detail";
import type { SuccessClientBookRead } from "@/lib/repositories/support";

const sessionUserId = "success-user-1";

const rows: SuccessClientBookRead[] = [
  {
    client: { id: "client-1", name: "Northstar Funding", isDemo: false },
    status: "active",
    successOwner: { id: "success-user-2", name: "Priya Natarajan" },
    supportStatus: "open",
    planId: "tier-growth",
    planLabel: "Growth",
    updatedAt: "2026-08-24T08:00:00.000Z",
  },
  {
    client: { id: "client-2", name: "Ledger Lift (demo)", isDemo: true },
    status: "onboarding",
    successOwner: null,
    supportStatus: "waiting_on_coach",
    planId: null,
    planLabel: null,
    updatedAt: "2026-08-23T08:00:00.000Z",
  },
  {
    client: { id: "client-3", name: "Boyd and Sons Advisory", isDemo: false },
    status: "active",
    successOwner: { id: "success-user-2", name: "Priya Natarajan" },
    supportStatus: null,
    planId: "tier-growth",
    planLabel: "Growth",
    updatedAt: "2026-08-28T08:00:00.000Z",
  },
];

function signal(over: Partial<TenantHealthSignalDetail> = {}): TenantHealthSignalDetail {
  return {
    key: "carrier",
    label: "Carrier delivery",
    state: "healthy",
    freshness: "current",
    observedValue: null,
    threshold: {},
    observedAt: null,
    staleAfterAt: null,
    calculatedAt: null,
    reason: "",
    action: { availability: "not-available", command: null, endpoint: null, reason: "" },
    ...over,
  };
}

const health = {
  tenantId: "client-1",
  state: "unhealthy" as const,
  snapshotDay: "2026-08-29",
  calculatedAt: "2026-08-29T11:00:00.000Z",
  signals: [
    signal({ key: "carrier", label: "Carrier delivery", state: "healthy" }),
    signal({ key: "channel", label: "Messaging channel", state: "unhealthy" }),
    signal({ key: "provisioning", label: "Provisioning", freshness: "not-measured", state: "indeterminate" }),
    signal({ key: "subscription", label: "Subscription", freshness: "stale", state: "healthy" }),
  ],
};

/**
 * One stub answering both reads the page makes: the book itself, and the per-client health route
 * the drawer opens. Anything else throws rather than resolving, so a fetch this page should not be
 * making fails loudly instead of silently returning an empty body.
 */
type FetchOptions = {
  commandResponse?: Record<string, unknown>;
  clientsAfterCommand?: unknown[];
  impersonationResponse?: Record<string, unknown>;
};

function stubFetch(clients: unknown[] = rows, healthStatus = 200, options: FetchOptions = {}) {
  let commandRecorded = false;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    void init;
    const url = String(input);
    if (url.startsWith("/api/platform/clients?book=")) {
      return new Response(JSON.stringify({
        clients: commandRecorded && options.clientsAfterCommand
          ? options.clientsAfterCommand
          : clients,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (/\/api\/platform\/clients\/[^/]+\/health$/.test(url)) {
      return new Response(JSON.stringify(healthStatus === 200 ? { health } : { error: "no" }), {
        status: healthStatus,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (/\/api\/platform\/clients\/[^/]+\/commands$/.test(url) && options.commandResponse) {
      commandRecorded = true;
      return new Response(JSON.stringify(options.commandResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/platform/impersonation/start" && options.impersonationResponse) {
      return new Response(JSON.stringify(options.impersonationResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

function renderBook() {
  return render(<SuccessClientBook actorId="admin-1" actorRole="admin" enabled />);
}

/**
 * The support filter offers every state as an option, so a bare text query matches the menu as
 * well as the rows. Every assertion about what a client reads means the table.
 */
function book() {
  return within(document.querySelector('[data-slot="grid-table"]') as HTMLElement);
}

function fills() {
  return document.querySelectorAll('[data-slot="kit-button"][data-variant="primary"]');
}

describe("SuccessClientBook", () => {
  it("limits success actors to their own session user ID", () => {
    const options = assigneeOptionsFor({ rows, actorId: sessionUserId, actorRole: "success" });
    expect(options.map((option) => option.value)).toEqual([sessionUserId]);
  });

  it("offers only lifecycle commands the current client status can satisfy", () => {
    expect(clientCommandsFor(rows[0])).toEqual(["pause", "archive", "note"]);
    expect(clientCommandsFor({ ...rows[0], status: "paused" }))
      .toEqual(["resume", "archive", "note"]);
    expect(clientCommandsFor(rows[1]))
      .toEqual(["nudge_onboarding", "resend_signup", "archive", "note"]);
    expect(clientCommandsFor({ ...rows[0], status: "churned" })).toEqual(["note"]);
  });
});

describe("healthSignalRow", () => {
  it("says a signal was never measured rather than calling it undetermined", () => {
    expect(healthSignalRow(signal({ freshness: "not-measured", state: "indeterminate" })))
      .toMatchObject({ value: "Not measured", tone: "neutral" });
  });

  it("carries staleness in the value, because an old healthy is a different claim", () => {
    expect(healthSignalRow(signal({ freshness: "stale", state: "healthy" })))
      .toMatchObject({ value: "Healthy, stale", tone: "waiting" });
    expect(healthSignalRow(signal({ state: "unhealthy" })))
      .toMatchObject({ value: "Unhealthy", tone: "failure" });
  });
});

describe("SuccessClientBook surface", () => {
  beforeEach(() => {
    navigation.searchParams = new URLSearchParams();
    navigation.replace.mockReset();
    navigation.push.mockReset();
    navigation.refresh.mockReset();
    // Left stubbed between tests on purpose: unstubbing globals here would also drop the
    // IntersectionObserver and ResizeObserver stubs the shared UI setup installs.
    stubFetch();
  });

  it("opens on the comfortable column set", async () => {
    renderBook();

    await screen.findByText("Northstar Funding");
    for (const header of ["Client", "Success owner", "Support", "Updated"]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeInTheDocument();
    }
    // One answer per row, so one status. The billing lifecycle used to sit beside the support
    // state as a second status on the same line, and a row carrying two of them carries neither:
    // the reader has to work out which one the row is about. It reads in the drawer instead.
    expect(screen.queryByRole("columnheader", { name: "Status" })).toBeNull();
  });

  it("writes the density into the URL so the switch survives a reload", async () => {
    const user = userEvent.setup();
    renderBook();

    await screen.findByText("Northstar Funding");
    await user.click(screen.getByRole("button", { name: "Dense" }));

    await waitFor(() => {
      expect(String(navigation.replace.mock.calls.at(-1)?.[0])).toContain("density=dense");
    });
  });

  it("drops the lifecycle column at the dense density rather than squeezing five in", async () => {
    // The density is query state, so the dense render is the one the URL already asked for.
    navigation.searchParams = new URLSearchParams("density=dense");
    renderBook();

    await screen.findByText("Northstar Funding");
    expect(screen.getByRole("columnheader", { name: "Owner" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Status" })).not.toBeInTheDocument();
    // The plan rides on the name line instead, so the density loses a column and no information.
    expect(screen.getAllByText("· Growth", { exact: false }).length).toBeGreaterThan(0);
  });

  it("writes every support enum as a sentence", async () => {
    renderBook();

    await screen.findAllByText("Open request");
    expect(book().getByText("Waiting on coach")).toBeInTheDocument();
    expect(screen.queryByText("waiting_on_coach")).not.toBeInTheDocument();
    expect(screen.queryByText("open")).not.toBeInTheDocument();
  });

  it("gives an absent request no pill at all", async () => {
    renderBook();

    await screen.findByText("Boyd and Sons Advisory");
    // Three clients, two of which have a thread. A "No request" pill on the third would weigh the
    // same as the two that are actually waiting on somebody.
    expect(document.querySelectorAll('[data-slot="status"][data-treatment="pill"]')).toHaveLength(2);
    expect(book().getByText("No request")).toBeInTheDocument();
  });

  it("leads the book with what is waiting on a person, not with what was touched last", async () => {
    renderBook();

    await screen.findByText("Northstar Funding");
    const names = [...document.querySelectorAll('[data-slot="grid-table-identity"]')]
      .map((node) => node.textContent ?? "");
    // Boyd is the most recently updated row and it is quiet, so it may not lead.
    expect(names[0]).toContain("Northstar Funding");
    expect(names[1]).toContain("Ledger Lift");
    expect(names[2]).toContain("Boyd and Sons Advisory");
  });

  it("draws the ranking it sorts by as bands, and says once what each band commits to", async () => {
    renderBook();

    await screen.findByText("Northstar Funding");
    const bands = [...document.querySelectorAll('[data-slot="table-group-header"]')];
    // The order is a ranking, so every band a reader can see has to say which rank it is and why
    // the rows under it are there. A label alone would only restate what the rows already show.
    expect(bands.map((band) => band.textContent)).toEqual([
      "Waiting on the team1a coach asked and nobody has answered yet",
      "Nobody owns these1assign a success owner before anything else moves",
      "Running quietly1an owner on file and no open request",
    ]);
  });

  it("says under the table what the ordering is blind to", async () => {
    renderBook();

    await screen.findByText("Northstar Funding");
    const footer = document.querySelector('[data-slot="table-footer-note"]') as HTMLElement;
    expect(
      within(footer).getByText("Showing 3 of 3 clients", { exact: false }),
    ).toBeVisible();
    expect(
      footer.querySelector('[data-slot="table-footer-ordering"]'),
    ).toHaveTextContent("waiting on a person first");
    expect(
      footer.querySelector('[data-slot="data-table-footer-note"]'),
    ).toHaveTextContent("not a ranking of which client matters most");
  });

  it("spends no accent fill until a row is open, and exactly one then", async () => {
    const user = userEvent.setup();
    renderBook();

    await screen.findByText("Northstar Funding");
    expect(fills()).toHaveLength(0);

    await user.click(screen.getByText("Northstar Funding"));
    await screen.findByRole("button", { name: "Reassign owner" });
    expect(fills()).toHaveLength(1);
  });

  it("reads health per client on open and states each signal's freshness", async () => {
    const user = userEvent.setup();
    const fetcher = stubFetch();
    renderBook();

    await screen.findByText("Northstar Funding");
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/health"))).toBe(false);

    await user.click(screen.getByText("Northstar Funding"));

    await screen.findByText("Healthy, stale");
    expect(screen.getByText("Not measured")).toBeInTheDocument();
    expect(screen.getByText("Unhealthy")).toBeInTheDocument();
    expect(
      fetcher.mock.calls.some(([url]) => String(url) === "/api/platform/clients/client-1/health"),
    ).toBe(true);
  });

  it("scopes a failed health read to the card that failed", async () => {
    const user = userEvent.setup();
    stubFetch(rows, 503);
    renderBook();

    await screen.findByText("Northstar Funding");
    await user.click(screen.getByText("Northstar Funding"));

    await screen.findByText("Couldn't load the health signals.");
    // The row and the book survive it.
    expect(screen.getByText("Boyd and Sons Advisory")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("keeps the reassign action's logged microcopy on screen", async () => {
    const user = userEvent.setup();
    renderBook();

    await screen.findByText("Northstar Funding");
    await user.click(screen.getByText("Northstar Funding"));

    expect(await screen.findByText("Reassignment logged")).toBeInTheDocument();
  });

  it("records an onboarding nudge intent without claiming provider dispatch", async () => {
    const user = userEvent.setup();
    const fetcher = stubFetch(rows, 200, {
      commandResponse: {
        command: { id: "command-nudge", action: "client_nudge_onboarding", state: "intent_recorded" },
        effect: { status: "intent_recorded", providerDispatch: "not_wired" },
        undo: { available: false, commandId: null },
        audit: { id: 41 },
      },
    });
    renderBook();

    await screen.findByText("Ledger Lift (demo)");
    await user.click(screen.getByText("Ledger Lift (demo)"));
    await user.click(screen.getByRole("button", { name: "Record onboarding nudge…" }));
    expect(screen.getByText(/does not message the coach because provider dispatch is not wired/i))
      .toBeVisible();
    await user.type(screen.getByLabelText("Reason"), "Provisioning has been waiting for two days");
    await user.click(screen.getByRole("button", { name: "Record onboarding nudge" }));

    expect(await screen.findByText(/No message was sent; provider dispatch is not wired/i)).toBeVisible();
    const call = fetcher.mock.calls.find(([url]) => String(url).endsWith("/client-2/commands"));
    expect(JSON.parse(String((call?.[1] as RequestInit | undefined)?.body))).toEqual({
      action: "nudge_onboarding",
      reason: "Provisioning has been waiting for two days",
    });
  });

  it("confirms a lifecycle command against the refreshed client book", async () => {
    const user = userEvent.setup();
    const pausedRows = rows.map((row) => row.client.id === "client-1" ? { ...row, status: "paused" } : row);
    stubFetch(rows, 200, {
      clientsAfterCommand: pausedRows,
      commandResponse: {
        command: { id: "command-pause", action: "client_pause", state: "applied" },
        effect: { status: "applied", tenantStatus: "paused" },
        undo: { available: true, commandId: "command-pause" },
        audit: { id: 42 },
      },
    });
    renderBook();

    await screen.findByText("Northstar Funding");
    await user.click(screen.getByText("Northstar Funding"));
    await user.click(screen.getByRole("button", { name: "Pause client…" }));
    await user.type(screen.getByLabelText("Reason"), "Requested by the account owner");
    await user.click(screen.getByRole("button", { name: "Pause client" }));

    expect(await screen.findByText("Client paused and logged.")).toBeVisible();
    expect(screen.getByText(/Audit receipt #42 · Command command-pause/)).toBeVisible();
  });

  it("sends an internal note as note content rather than inventing a reason", async () => {
    const user = userEvent.setup();
    const fetcher = stubFetch(rows, 200, {
      commandResponse: {
        command: { id: "command-note", action: "client_note", state: "recorded" },
        effect: { status: "recorded", tenantStatus: "active" },
        undo: { available: false, commandId: null },
        audit: { id: 43 },
      },
    });
    renderBook();

    await screen.findByText("Northstar Funding");
    await user.click(screen.getByText("Northstar Funding"));
    await user.click(screen.getByRole("button", { name: "Add internal note…" }));
    await user.type(screen.getByLabelText("Internal note"), "Coach reported an inbox issue on the call.");
    await user.click(screen.getByRole("button", { name: "Add internal note" }));

    expect(await screen.findByText("Internal note recorded and logged.")).toBeVisible();
    const call = fetcher.mock.calls.find(([url]) => String(url).endsWith("/client-1/commands"));
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      action: "note",
      note: "Coach reported an inbox issue on the call.",
    });
  });

  it("starts view-as only after a tenant-bound thirty-minute session read-back", async () => {
    const user = userEvent.setup();
    stubFetch(rows, 200, {
      impersonationResponse: {
        session: {
          id: "session-1",
          actorId: "admin-1",
          tenantId: "client-1",
          reason: "Investigate reported inbox issue",
          startedAt: "2026-08-31T00:00:00.000Z",
          endedAt: null,
          expiresAt: "2026-08-31T00:30:00.000Z",
        },
      },
    });
    renderBook();

    await screen.findByText("Northstar Funding");
    await user.click(screen.getByText("Northstar Funding"));
    await user.click(screen.getByRole("button", { name: "View as coach…" }));
    expect(screen.getByText(/30-minute read-only view-as session/i)).toBeVisible();
    await user.type(screen.getByLabelText("Reason"), "Investigate reported inbox issue");
    await user.click(screen.getByRole("button", { name: "Start read-only view" }));

    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/coach/home"));
    expect(navigation.refresh).toHaveBeenCalled();
  });

  /**
   * The tenant-isolation disclosure, pinned to the moment it matters.
   *
   * Opening a coach's workspace crosses a tenant boundary, and the product rule is that the read
   * is audit-logged with visible "Logged" microcopy and that the screen says plainly the coach can
   * see the visit. The drift this catches is the confirmation being trimmed back to the two
   * mechanical facts it used to carry -- thirty minutes, mutations blocked -- which describe the
   * session's limits and say nothing about the person on the other side of it. It reads the
   * confirmation rather than the receipt on purpose: a disclosure the operator meets only after
   * deciding is a notification, not a disclosure.
   */
  it("says the client can see the visit before the view-as session is started", async () => {
    const user = userEvent.setup();
    renderBook();

    await screen.findByText("Northstar Funding");
    await user.click(screen.getByText("Northstar Funding"));
    await user.click(screen.getByRole("button", { name: "View as coach…" }));

    const confirmation = screen
      .getByText(/30-minute read-only view-as session/i)
      .closest("div") as HTMLElement;
    expect(confirmation).toHaveTextContent(/crosses a tenant boundary/u);
    expect(confirmation).toHaveTextContent(
      /Northstar Funding can see the visit on their own audit trail/u,
    );
    expect(
      within(confirmation).getByText(/Logged\. The visit is recorded against your name/u),
    ).toBeInTheDocument();
  });

  it("carries the demo claim at page level once every client is seeded", async () => {
    // The mixed set above labels rows and says so. Once EVERY row is seeded the table drops its
    // per-row label, so this line is the only thing on screen saying the view is demo.
    stubFetch(rows.map((row) => ({ ...row, client: { ...row.client, isDemo: true } })));
    renderBook();

    await screen.findByText("Northstar Funding");
    // The chip over the title. It asserts the page, which is only honest once every row is
    // seeded -- the mixed case below keeps its sentence for exactly that reason.
    expect(screen.getByText("Demo workspace data")).toBeInTheDocument();
    expect(screen.getByText("Excluded from analytics")).toBeInTheDocument();
    expect(screen.queryByText(/Demo data/)).not.toBeInTheDocument();
  });

  it("labels the seeded row while the view is mixed", async () => {
    renderBook();

    await screen.findByText("Ledger Lift (demo)");
    expect(screen.getByText(/Demo data/)).toBeInTheDocument();
    // The chip over the title asserts every row, so a mixed view must not carry it. Without this
    // line the page could claim the whole book is seeded while real clients sit in the table, and
    // the disclosure would be misleading in the direction nobody checks.
    expect(screen.queryByText("Demo workspace data")).not.toBeInTheDocument();
  });

  /**
   * The figures are console deck panels since the canvas port, so this reads
   * `console-stat-panel` where it used to read `metric-card`. Every count it asserts is unchanged:
   * the drift it catches is a figure counted over a different set than the one its label names,
   * which is the failure mode that makes an operator work the wrong rows.
   */
  it("counts every figure from the rows it describes", async () => {
    renderBook();

    await screen.findByText("Northstar Funding");
    const figures = within(
      document.querySelector('[data-slot="client-book-figures"]') as HTMLElement,
    );
    const tile = (label: string) =>
      figures.getByText(label).closest('[data-slot="console-stat-panel"]');
    expect(within(tile("Onboarding") as HTMLElement).getByText("1")).toBeInTheDocument();
    expect(within(tile("Live") as HTMLElement).getByText("2")).toBeInTheDocument();
    expect(within(tile("Open requests") as HTMLElement).getByText("2")).toBeInTheDocument();
    expect(within(tile("Unassigned") as HTMLElement).getByText("1")).toBeInTheDocument();
  });

  /**
   * Catches two drifts at once. A second drenched panel would break the console's one-fill rule,
   * and a hero that moved off Open requests would lead the page on a figure nobody opens it for --
   * the book already sorts on what is waiting on a person, and the strip has to agree with it.
   */
  it("leads the strip on the one figure the page exists to work down", async () => {
    renderBook();

    await screen.findByText("Northstar Funding");
    const figures = document.querySelector('[data-slot="client-book-figures"]') as HTMLElement;
    const panels = [...figures.querySelectorAll('[data-slot="console-stat-panel"]')];
    expect(panels).toHaveLength(4);
    const drenched = panels.filter((panel) => panel.getAttribute("data-drench"));
    expect(drenched).toHaveLength(1);
    expect(drenched[0]).toHaveTextContent("Open requests");
  });

  it("narrows to the rows waiting on a person when the attention view is chosen", async () => {
    const user = userEvent.setup();
    renderBook();

    await screen.findByText("Northstar Funding");
    await user.click(screen.getByRole("button", { name: /Needs attention/ }));

    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalled();
    });
  });

  /**
   * The defect this covers put `88000000-0000-4000-8000-000000000001` under ASSIGNEE in the
   * drawer. The row is the one the join cannot resolve -- an owner id with no `users.full_name`
   * behind it -- which is the only shape that ever reached the fallback.
   */
  it("names the success owner rather than printing the id it is stored as", async () => {
    const user = userEvent.setup();
    const ownerId = "88000000-0000-4000-8000-000000000001";
    stubFetch([{ ...rows[0], successOwner: { id: ownerId, name: null } }]);
    renderBook();

    await screen.findByText("Northstar Funding");
    expect(document.body.textContent ?? "").not.toContain(ownerId);
    expect(book().getAllByText("Assigned owner").length).toBeGreaterThan(0);

    await user.click(screen.getByText("Northstar Funding"));
    await screen.findByRole("button", { name: "Reassign owner" });

    expect(
      document.body.textContent ?? "",
      "the drawer printed the stored owner id at the reader",
    ).not.toContain(ownerId);
    // Nothing to assign to, because naming an option would mean labelling it with that id.
    expect(screen.getByText(
      "The client book did not supply a named success owner, so there is nobody to assign to yet.",
    )).toBeInTheDocument();
  });

  it("asks the server for the chosen book when the view switches", async () => {
    const user = userEvent.setup();
    renderBook();

    await screen.findByText("Northstar Funding");
    await user.click(screen.getByRole("button", { name: "My clients" }));

    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalled();
    });
  });
});

/**
 * The loader against the one thing it was not keyed on: who the page is for.
 *
 * A cross-role redirect swaps the session under a book that is already mounted. The effect was
 * keyed on the chosen book alone, so nothing re-fired, and the table -- which had no reading state
 * of its own -- told the new actor their book was empty until they reloaded the page.
 */
describe("SuccessClientBook across an actor change", () => {
  const otherActorRows: SuccessClientBookRead[] = [
    {
      client: { id: "client-9", name: "Cedar Row Capital", isDemo: false },
      status: "active",
      successOwner: { id: "success-user-3", name: "Marcus Reid" },
      supportStatus: null,
      planId: "tier-growth",
      planLabel: "Growth",
      updatedAt: "2026-08-29T08:00:00.000Z",
    },
  ];

  beforeEach(() => {
    navigation.searchParams = new URLSearchParams();
    navigation.replace.mockReset();
  });

  it("reads the book again when the session actor changes under a mounted page", async () => {
    const fetcher = stubFetch();
    const { rerender } = render(
      <SuccessClientBook actorId="admin-1" actorRole="admin" enabled />,
    );

    await screen.findByText("Northstar Funding");
    const before = fetcher.mock.calls.filter(([url]) =>
      String(url).startsWith("/api/platform/clients?book=")).length;

    stubFetch(otherActorRows);
    rerender(<SuccessClientBook actorId="admin-2" actorRole="admin" enabled />);

    await screen.findByText("Cedar Row Capital");
    expect(screen.queryByText("Northstar Funding")).not.toBeInTheDocument();
    expect(before).toBeGreaterThan(0);
  });

  it("says it is reading rather than telling the new actor their book is empty", async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const held = new Promise<void>((resolve) => { gate.release = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.startsWith("/api/platform/clients?book=")) throw new Error(`Unexpected fetch: ${url}`);
      await held;
      return new Response(JSON.stringify({ clients: otherActorRows }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));

    render(<SuccessClientBook actorId="admin-2" actorRole="admin" enabled />);

    // The empty state is a claim about the book. Nothing has answered, so it must not be made.
    await waitFor(() => {
      expect(document.querySelector('[data-slot="grid-table"]')).toBeInTheDocument();
    });
    expect(screen.queryByText("No clients match this view")).not.toBeInTheDocument();

    gate.release?.();
    await screen.findByText("Cedar Row Capital");
    expect(screen.queryByText("No clients match this view")).not.toBeInTheDocument();
  });

  it("ignores a read that lands after the actor it was made for has gone", async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const firstRead = new Promise<void>((resolve) => { gate.release = resolve; });
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.startsWith("/api/platform/clients?book=")) throw new Error(`Unexpected fetch: ${url}`);
      call += 1;
      const body = call === 1 ? rows : otherActorRows;
      if (call === 1) await firstRead;
      return new Response(JSON.stringify({ clients: body }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));

    const { rerender } = render(
      <SuccessClientBook actorId="admin-1" actorRole="admin" enabled />,
    );
    rerender(<SuccessClientBook actorId="admin-2" actorRole="admin" enabled />);

    await screen.findByText("Cedar Row Capital");
    // The first actor's read resolves last and must not be allowed to write over the second's.
    gate.release?.();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.getByText("Cedar Row Capital")).toBeInTheDocument();
    expect(screen.queryByText("Northstar Funding")).not.toBeInTheDocument();
  });
});

describe("SuccessClientBook nav count", () => {
  beforeEach(() => {
    navigation.searchParams = new URLSearchParams();
    navigation.replace.mockReset();
  });

  it("hands the rail the whole book's attention count, not the current view's", async () => {
    stubFetch([
      // Unowned: needs somebody.
      { ...rows[0], client: { ...rows[0].client, id: "c1" }, successOwner: null, supportStatus: null },
      // Owned and quiet: not a queue entry.
      {
        ...rows[0],
        client: { ...rows[0].client, id: "c2" },
        successOwner: { id: "u2", name: "Priya Natarajan" },
        supportStatus: "resolved",
      },
    ]);

    render(<SuccessClientBook actorId="admin-1" actorRole="admin" enabled />);

    await screen.findAllByText("Northstar Funding");
    const rail = screen.getByRole("navigation", { name: "Primary" });
    const book = within(rail).getByRole("link", { name: /Client book/ });
    expect(book.closest("li")?.querySelector('[data-slot="nav-count"]')).toHaveTextContent("1");
  });
});
