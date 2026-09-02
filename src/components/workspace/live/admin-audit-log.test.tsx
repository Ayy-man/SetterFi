import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  pathname: "/admin/audit",
  replace: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ refresh: vi.fn(), replace: navigation.replace }),
  useSearchParams: () => navigation.searchParams,
}));

import {
  AdminAuditLog,
  type AdminAuditRow,
} from "@/components/workspace/live/admin-audit-log";
import { auditActionLabel } from "@/lib/copy/audit-labels";
import { AUDIT_ACTION_KEYS, AUDIT_ACTIONS } from "@/lib/audit/actions";

const rows: AdminAuditRow[] = [
  {
    id: "42",
    action: "channel.connect.completed",
    actor: "System",
    target: "ghl_install: install-42",
    reason: "The messaging connection was confirmed.",
    at: "2026-08-24T11:00:00.000Z",
    testData: false,
    source: null,
    actorIp: "169.150.254.103",
    tenantId: "tenant-a",
    tenantName: "Reid Funding",
  },
  {
    id: "41",
    action: "billing.correction.approved",
    actor: "7b4012f5-2ea1-4a40-8d6e-cf631989242a",
    target: "billing_correction: correction-41",
    reason: "The duplicate booked call was confirmed.",
    at: "2026-08-24T10:30:00.000Z",
    testData: false,
    source: "dashboard",
    actorIp: "169.150.254.102",
    tenantId: "tenant-b",
    tenantName: "Elevate Credit",
  },
  {
    id: "40",
    action: "brain.published",
    actor: "Actor unavailable",
    target: "brain_snapshot: snapshot-40",
    reason: "Qualification guidance was updated.",
    at: "2026-08-24T09:15:00.000Z",
    testData: null,
    source: null,
    actorIp: null,
    tenantId: null,
    tenantName: null,
  },
  {
    id: "39",
    action: "conversation.takeover.claimed",
    actor: "9c5123a6-3fb2-4b51-9e7f-df742090353b",
    actorName: "Marcus Lane",
    target: "conversation: conversation-39",
    reason: null,
    at: "2026-08-24T08:40:00.000Z",
    testData: false,
    source: "dashboard",
    actorIp: "169.150.254.104",
    tenantId: "tenant-a",
    tenantName: "Reid Funding",
  },
  {
    id: "38",
    action: "channel.disconnected",
    actor: "9c5123a6-3fb2-4b51-9e7f-df742090353b",
    actorName: "Marcus Lane",
    target: "channel: channel-38",
    reason: "The page token was revoked at Meta.",
    at: "2026-08-24T08:05:00.000Z",
    testData: false,
    source: "dashboard",
    actorIp: "169.150.254.104",
    tenantId: "tenant-a",
    tenantName: "Reid Funding",
  },
];

const pagination = {
  hasNextPage: true,
  hasPreviousPage: false,
  pageIndex: 0,
  pageSize: 50,
  totalRows: 212,
};

function renderAudit(props: Partial<Parameters<typeof AdminAuditLog>[0]> = {}) {
  return render(
    <AdminAuditLog enabled pagination={pagination} rows={rows} {...props} />,
  );
}

/** The table is the alternate layout now, so the table tests ask for it by name. */
function renderTable(props: Partial<Parameters<typeof AdminAuditLog>[0]> = {}) {
  navigation.searchParams = new URLSearchParams("display=table");
  return renderAudit(props);
}

describe("AdminAuditLog", () => {
  beforeEach(() => {
    navigation.pathname = "/admin/audit";
    navigation.replace.mockReset();
    navigation.searchParams = new URLSearchParams();
  });

  it("renders human filter labels instead of raw action keys", () => {
    const labels = AUDIT_ACTION_KEYS.map((key) => auditActionLabel(key));

    expect(labels).toContain(auditActionLabel("brain.published"));
    expect(labels.some((label) => /^[a-z_]+\.[a-z_.]+$/.test(label))).toBe(
      false,
    );
  });

  it("maps internal provider and knowledge targets to approved client labels", () => {
    renderTable();

    expect(screen.getAllByText("Text messages (SMS)").length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByText("The Brain").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Ghl install/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Brain snapshot/i)).not.toBeInTheDocument();
  });

  /*
   * Re-pointed from "starts with the data table". Screen 1h draws the audit log as one panel of
   * sentences, so the feed is the default and the table is the alternate. The rule this guards is
   * unchanged in substance: both layouts stay reachable and neither one is the only way to read
   * the log.
   */
  it("opens on the event feed and keeps the data table behind Display", () => {
    const view = renderAudit();

    expect(screen.getByTestId("audit-feed")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Display" })).toBeInTheDocument();
    expect(screen.getByText("August 24, 2026")).toBeInTheDocument();
    expect(
      screen.queryByText("billing.correction.approved"),
    ).not.toBeInTheDocument();

    navigation.searchParams = new URLSearchParams("display=table");
    view.rerender(
      <AdminAuditLog enabled pagination={pagination} rows={rows} />,
    );
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.queryByTestId("audit-feed")).not.toBeInTheDocument();
  });

  /*
   * "Every table exports CSV/JSON" is a project hard rule, and the redesign moved which layout is
   * the default. Both of them have to carry the export, or flipping the default would have quietly
   * removed it from the page a reader actually lands on.
   */
  it("carries the export control in both layouts", () => {
    const view = renderAudit();
    expect(
      screen.getByRole("button", { name: "Export table" }),
    ).toBeInTheDocument();

    navigation.searchParams = new URLSearchParams("display=table");
    view.rerender(
      <AdminAuditLog enabled pagination={pagination} rows={rows} />,
    );
    expect(
      screen.getByRole("button", { name: "Export table" }),
    ).toBeInTheDocument();
  });

  /*
   * Re-pointed from "opens on the five decision columns": the table gained Where, the feed's scope
   * column, so the two layouts carry the same facts. The rule is unchanged -- the decision columns
   * open and the forensic ones stay behind Display.
   */
  it("opens on the decision columns and keeps the rest behind Display", () => {
    renderTable();

    for (const header of ["When", "Actor", "Action", "Where", "Target", "Outcome"]) {
      expect(
        screen.getByRole("columnheader", { name: new RegExp(`^${header}$`) }),
      ).toBeInTheDocument();
    }
    for (const hidden of ["Reason", "IP address", "Kind"]) {
      expect(
        screen.queryByRole("columnheader", { name: new RegExp(`^${hidden}$`) }),
      ).not.toBeInTheDocument();
    }
  });

  it("reads an outcome off the event rather than a raw action key", () => {
    renderTable();

    expect(screen.getAllByText("Completed").length).toBeGreaterThan(0);
    expect(
      screen.queryByText("channel.connect.completed"),
    ).not.toBeInTheDocument();
  });

  /*
   * The outcome column is on the kit's Status now, and its tone comes through STATE_TONE_TO_TONE
   * rather than being re-spelled by hand. The two vocabularies are not the same size -- the kit
   * split `critical` three ways -- so a hand-written mapping is where a "Failed" row quietly stops
   * being clay. This asserts the mapped kit tone, not the legacy one.
   */
  it("renders the outcome through the kit's tone vocabulary, not the legacy badge", () => {
    renderTable();

    const outcomes = [...document.querySelectorAll('[data-slot="status"]')]
      .filter((node) => node.getAttribute("data-treatment") === "bare");
    expect(outcomes.length).toBeGreaterThan(0);
    const reversed = outcomes.find((node) => node.textContent === "Reversed");
    expect(reversed).toHaveAttribute("data-tone", "warning");
    expect(
      document.querySelectorAll('[data-slot="state-badge"][data-kind="verdict"]'),
    ).toHaveLength(0);
  });

  it("moves to the next cursor without exposing the cursor in the page copy", async () => {
    const user = userEvent.setup();
    renderAudit();

    await user.click(screen.getByRole("button", { name: "Next page" }));

    expect(navigation.replace).toHaveBeenCalledWith(
      "/admin/audit?cursor=2026-08-24T08%3A05%3A00.000Z%7E38&direction=next&page=1",
      { scroll: false },
    );
    expect(document.body).not.toHaveTextContent("2026-08-24T08:05:00.000Z~38");
  });

  it("exports the active search and removes the missing-reason explanation after input", async () => {
    const user = userEvent.setup();
    // The export menu asks the route for the file and checks the answer before saving, so the
    // query it carries is read off the fetch rather than off an anchor's href.
    const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(
      async () => new Response("", {
        status: 200,
        headers: { "Content-Type": "text/csv; charset=utf-8" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const createUrlSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:admin-audit-log-test");
    const revokeUrlSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    navigation.searchParams = new URLSearchParams("q=delivery+failed");
    renderAudit();

    const trigger = screen.getByRole("button", { name: "Export table" });
    const tooltipTrigger = trigger.parentElement;
    expect(tooltipTrigger).not.toBeNull();
    expect(tooltipTrigger).toHaveAttribute(
      "data-export-reason-required",
      "true",
    );
    await user.click(trigger);
    await user.type(
      screen.getByRole("textbox", { name: "Export reason" }),
      "Quarterly access review",
    );
    expect(tooltipTrigger).not.toHaveAttribute("data-export-reason-required");
    await user.click(
      await screen.findByRole("menuitem", { name: /Download CSV/ }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const href = new URL(String(fetchMock.mock.calls[0][0]), "http://localhost");
    expect(href.searchParams.get("search")).toBe("delivery failed");
    expect(href.searchParams.get("reason")).toBe("Quarterly access review");
    clickSpy.mockRestore();
    createUrlSpy.mockRestore();
    revokeUrlSpy.mockRestore();
    vi.unstubAllGlobals();
    // Typing a full export reason character by character over a rendered feed is slow enough to
    // brush the default per-test budget.
  }, 20_000);
});

describe("AdminAuditLog craft", () => {
  beforeEach(() => {
    navigation.pathname = "/admin/audit";
    navigation.replace.mockReset();
    navigation.searchParams = new URLSearchParams();
  });

  it("writes a human sentence with the actor name it has and Operator for a bare id", () => {
    render(
      <AdminAuditLog
        enabled
        pagination={{
          hasNextPage: false,
          hasPreviousPage: false,
          pageIndex: 0,
          pageSize: 50,
          totalRows: 2,
        }}
        rows={[{ ...rows[1]!, actorName: "Alec Delpuech" }, rows[2]!]}
      />,
    );

    const sentences = screen.getAllByTestId("feed-row-sentence");
    expect(sentences[0]).toHaveTextContent(
      "Alec Delpuech approved a billing correction",
    );
    expect(sentences[0]?.querySelector("strong")).toHaveTextContent(
      "Alec Delpuech",
    );
    expect(
      sentences[0]?.querySelector('[data-slot="feed-row-object"]'),
    ).toHaveTextContent("a billing correction");
    expect(sentences[1]).toHaveTextContent(
      "Actor unavailable published a new version of the Brain",
    );
    expect(
      screen.queryByText(/billing\.correction\.approved/),
    ).not.toBeInTheDocument();
  });

  it("flattens a bare user id to Operator rather than showing the uuid", () => {
    renderAudit();

    expect(screen.getAllByTestId("feed-row-sentence")[1]).toHaveTextContent(
      "Operator approved a billing correction",
    );
  });

  /*
   * Screen 1h puts a category on every row. It has to be derived from the action key, because the
   * log stores no category field -- and it has to carry words, not only a hue, or the row's kind
   * would be invisible to anyone who cannot separate the teal pill from the clay one.
   */
  it("derives the row's category from the action and states it in words", () => {
    renderAudit();

    const categoryOf = (id: string) => screen
      .getByTestId("audit-feed")
      .querySelector(`[data-slot="audit-row"][aria-label*="${id}"]`);

    const rowsRendered = screen.getAllByTestId("audit-row");
    const labels = rowsRendered.map((row) => row
      .querySelector('[data-slot="status"] [data-slot="status-label"]')
      ?.textContent);
    expect(labels).toEqual([
      "automatic",
      "change",
      "publish",
      "takeover",
      "pause",
    ]);
    expect(categoryOf("Published a new version of the Brain")).not.toBeNull();
  });

  /*
   * The 180px scope column. The registry's own `scope` field is the authority for whether a change
   * reached everybody, so a platform key says so without counting anything: the artifact's
   * "all 14 agents" is a number the log does not record, and printing one would be a fabrication.
   */
  it("names where a change landed without inventing an agent count", () => {
    renderAudit();

    const scopes = screen
      .getAllByTestId("audit-row")
      .map((row) => row.querySelector('[data-slot="audit-row-scope"]')?.textContent);
    expect(scopes).toEqual([
      "Reid Funding",
      "Elevate Credit",
      "Every workspace",
      "Reid Funding",
      "Reid Funding",
    ]);
    expect(screen.queryByText(/\d+ agents/)).not.toBeInTheDocument();
  });

  /*
   * The segmented control in 1h. Every count renders from the loaded rows, per the named rule in
   * docs/DESIGN.md: three hardcoded counts have already shipped wrong on this product.
   */
  it("counts each event kind from the loaded rows", () => {
    renderAudit();

    for (const [label, count] of [
      ["Everything", "5"],
      ["Publishes", "1"],
      ["Takeovers", "1"],
      ["Pauses", "1"],
    ]) {
      expect(
        screen.getByRole("button", { name: new RegExp(`^${label}`) }),
      ).toHaveTextContent(count);
    }
  });

  it("shows only the kind a segment maps to, and says so when the page holds none", () => {
    navigation.searchParams = new URLSearchParams("view=publish");
    const view = renderAudit();

    expect(screen.getAllByTestId("feed-row-sentence")).toHaveLength(1);
    expect(screen.getAllByTestId("feed-row-sentence")[0]).toHaveTextContent(
      "a new version of the Brain",
    );

    navigation.searchParams = new URLSearchParams("view=takeover");
    view.rerender(
      <AdminAuditLog enabled pagination={pagination} rows={[rows[2]!]} />,
    );

    expect(screen.getByText("No takeovers on this page")).toBeInTheDocument();
    expect(screen.queryByTestId("feed-row-sentence")).not.toBeInTheDocument();
  });

  /*
   * "Filterable to what did the client see change" is the screen's own name. The options are the
   * workspaces on the loaded page and nothing else: offering a client whose events are on another
   * page would let a reader see an empty list and conclude that client changed nothing.
   */
  it("offers only the workspaces the loaded page holds, and no client filter when none", () => {
    const view = renderAudit();

    const clientFilter = screen.getByRole("button", { name: /Client/ });
    expect(clientFilter).toBeInTheDocument();

    view.rerender(
      <AdminAuditLog enabled pagination={pagination} rows={[rows[2]!]} />,
    );
    expect(
      screen.queryByRole("button", { name: /Client/ }),
    ).not.toBeInTheDocument();
  });

  /*
   * Screen 1h's divider reads `TODAY \u00b7 AUG 31`. The relative word is the half that makes a long
   * log scannable -- a reader scrolling for what just happened is looking for a word, not doing
   * date arithmetic -- and the absolute date stays beside it so nothing depends on the reader
   * knowing what today is.
   */
  it("names today and yesterday on the day dividers, keeping the date beside them", () => {
    // The fixture's newest rows are on 2026-08-24; the clock says the next day, so that run is
    // yesterday and nothing on the page may claim to be today.
    renderAudit({ nowIso: "2026-08-25T15:00:00.000Z" });

    expect(screen.getByText("Yesterday \u00b7 August 24, 2026")).toBeVisible();
    expect(screen.queryByText(/^Today/)).toBeNull();

    cleanup();
    renderAudit({ nowIso: "2026-08-24T15:00:00.000Z" });
    expect(screen.getByText("Today \u00b7 August 24, 2026")).toBeVisible();
  });

  /*
   * With no server clock there is no honest relative word, and inventing one from the browser's
   * own timezone is how a divider ends up naming the wrong day. The absolute date alone is less
   * scannable and never wrong.
   */
  it("falls back to the bare date when no server clock was passed", () => {
    renderAudit();

    expect(screen.getByText("August 24, 2026")).toBeVisible();
    expect(screen.queryByText(/Today|Yesterday/)).toBeNull();
  });

  it("keeps the day separator a hairline label instead of a filled band", () => {
    renderAudit();

    const separator = screen.getByText("August 24, 2026");
    expect(separator.className).toContain("t-overline");
    expect(separator.className).toContain("border-b");
    expect(separator.className).not.toContain("bg-[var(--quiet)]");
  });

  /*
   * "Never a left or right edge colour stripe" is a named rule in docs/DESIGN.md, and a selected
   * row is exactly where a stripe keeps getting reintroduced. Selection is a background tint.
   */
  it("marks a selected row with a tint rather than an edge stripe", async () => {
    const user = userEvent.setup();
    renderAudit();

    const row = screen.getByRole("button", {
      name: "Open event detail: Approved a billing correction",
    });
    await user.click(row);

    expect(row).toHaveAttribute("data-selected", "true");
    expect(row.className).toContain("bg-[var(--row-selected)]");
    expect(row.className).not.toMatch(/border-l|border-r|shadow-\[inset/);
  });

  /*
   * The One Fill Rule: at most one accent fill per page, and zero is the correct resting state.
   * Nothing on the audit log acts -- every control reads, filters or exports -- so it spends none.
   */
  it("spends no accent fill, because nothing on this page acts", () => {
    renderAudit();

    expect(
      document.querySelectorAll('[data-slot="kit-button"][data-variant="primary"]'),
    ).toHaveLength(0);
  });

  it("opens the event drawer with lineage, related, and copyable ids", async () => {
    const user = userEvent.setup();
    renderAudit();

    await user.click(
      screen.getByRole("button", {
        name: "Open event detail: Approved a billing correction",
      }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Approved a billing correction");
    expect(within(dialog).getByText("What happened")).toBeInTheDocument();
    expect(within(dialog).getByText("Lineage")).toBeInTheDocument();
    expect(within(dialog).getByText("Related")).toBeInTheDocument();
    expect(within(dialog).getByText("Technical detail")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Copy Event ID" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("169.150.254.102")).toBeInTheDocument();
  });

  /*
   * Screen 1i opens a publish onto its blast radius. Two of its three facts are derivable and one
   * is not, so the panel prints the derivable pair and names the gap. The live count is labelled
   * "live now" every time, because a bare number beside "Took effect on" would be read as the
   * reach the publish had at the time -- which the log does not record.
   */
  it("states a publish's reach from the registry and names what it cannot know", async () => {
    const user = userEvent.setup();
    renderAudit({ liveWorkspaceCount: 12 });

    await user.click(
      screen.getByRole("button", {
        name: "Open event detail: Published a new version of the Brain",
      }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Blast radius")).toBeInTheDocument();
    expect(within(dialog).getByText("Every workspace")).toBeInTheDocument();
    expect(within(dialog).getByText("12 live now")).toBeInTheDocument();
    expect(
      dialog.querySelector('[data-slot="blast-radius-limit"]'),
    ).toHaveTextContent(
      /not how many workspaces were live at the time or how many conversations have run since/,
    );
  });

  /*
   * An unreadable count is never rendered as 0. "No workspaces are live" and "we could not read
   * how many are" are different claims and only one of them is ever true here.
   */
  it("says an unreadable live count in words rather than printing zero", async () => {
    const user = userEvent.setup();
    renderAudit({ liveWorkspaceCount: null });

    await user.click(
      screen.getByRole("button", {
        name: "Open event detail: Published a new version of the Brain",
      }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("how many are live is not readable right now"),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText("0 live now")).not.toBeInTheDocument();
  });

  /** A tenant-scoped event reaches one workspace and names it, never "Every workspace". */
  it("scopes a tenant event to its own workspace in the blast radius", async () => {
    const user = userEvent.setup();
    renderAudit({ liveWorkspaceCount: 12 });

    await user.click(
      screen.getByRole("button", {
        name: "Open event detail: Approved a billing correction",
      }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Elevate Credit")).toBeInTheDocument();
    expect(within(dialog).getByText("this workspace only")).toBeInTheDocument();
    expect(
      within(dialog).queryByText("Every workspace"),
    ).not.toBeInTheDocument();
  });

  it("says a section is empty rather than inventing lineage the row does not carry", async () => {
    const user = userEvent.setup();
    renderAudit();

    await user.click(
      screen.getByRole("button", {
        name: "Open event detail: Published a new version of the Brain",
      }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("No lineage on this page"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Nothing related on this page"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Qualification guidance was updated."),
    ).toBeInTheDocument();
  });

  it("puts who acted and when in the drawer's audit line, and the microcopy in its logged slot", async () => {
    const user = userEvent.setup();
    renderAudit();

    await user.click(
      screen.getByRole("button", {
        name: "Open event detail: Approved a billing correction",
      }),
    );

    const dialog = await screen.findByRole("dialog");
    const auditLine = dialog.querySelector(
      '[data-slot="record-sheet-created"]',
    );
    expect(auditLine).toHaveTextContent("created");
    expect(auditLine).toHaveTextContent("Operator");
    expect(
      dialog.querySelector('[data-slot="record-sheet-logged"]'),
    ).toHaveTextContent(AUDIT_ACTIONS["billing.correction.approved"].microcopy);
    // The subtitle names the record the event landed on, and nothing else.
    expect(
      dialog.querySelector('[data-slot="record-sheet-value"]'),
    ).toBeInTheDocument();
  });

  /*
   * Re-pointed from "omits the origin footer when provenance is absent or incomplete". The feed
   * row no longer expands -- 1h's row is one line that opens the record -- so origin lives in the
   * drawer only. The rule it guarded is intact and now asserted where the fact is shown: a
   * recorded origin prints, and a missing one is words rather than a fact the log does not have.
   */
  it("prints an absent origin as words in the value column rather than a fact it does not have", async () => {
    const user = userEvent.setup();
    renderAudit();

    await user.click(
      screen.getByRole("button", {
        name: "Open event detail: Published a new version of the Brain",
      }),
    );

    const dialog = await screen.findByRole("dialog");
    const absences = [
      ...dialog.querySelectorAll('[data-slot="record-sheet-absence"]'),
    ].map((node) => node.textContent);
    expect(absences).toContain("no origin recorded");
    expect(absences).toContain("no address recorded");
    expect(within(dialog).queryByText("Not recorded")).not.toBeInTheDocument();
  });
});

/**
 * The table language from `.planning/design/screens-r5/6ab-table-anatomy-screenshot.png`, applied
 * here first: this is the exemplar the other admin tables are migrated against.
 */
describe("AdminAuditLog table language", () => {
  beforeEach(() => {
    navigation.pathname = "/admin/audit";
    navigation.replace.mockReset();
    navigation.searchParams = new URLSearchParams();
  });

  it("summarises the page in four figures and tones only the one that needs reading", () => {
    renderAudit();

    const strip = screen.getByLabelText("Audit summary");
    const tiles = within(strip).getAllByTestId("stat-tile");
    expect(tiles.map((tile) => tile.getAttribute("data-label"))).toEqual([
      "Events recorded",
      "Refused or reversed",
      "People acting",
      "Workspaces touched",
    ]);
    // The fixture holds one reversal (channel.disconnected) and nothing refused or failed.
    const toned = tiles.filter(
      (tile) => tile.querySelector('[data-slot="stat-strip-tone-dot"]') !== null,
    );
    expect(toned).toHaveLength(1);
    expect(toned[0]?.getAttribute("data-label")).toBe("Refused or reversed");
  });

  /*
   * A count that could only be honest about the loaded page has to say so. "212" is the log; every
   * other figure here is this page, and the note is the only thing that separates them.
   */
  it("says which figures are about this page rather than the whole log", () => {
    renderAudit();

    const strip = screen.getByLabelText("Audit summary");
    expect(within(strip).getByText("5 events on this page")).toBeVisible();
    // The figure animates per character, so the whole number is only readable through its role.
    expect(within(strip).getByRole("img", { name: "212" })).toBeVisible();
  });

  it("wears the inset ledger treatment, because it is a dense admin table", () => {
    renderTable();

    expect(document.querySelector('[data-slot="data-table"]')).toHaveAttribute(
      "data-variant",
      "ledger",
    );
    expect(document.querySelector('[data-slot="data-table"]')?.className).toContain(
      "surface-card",
    );
  });

  /*
   * The feed's day boundary, kept in the table. Without it, switching layouts drops the divider and
   * yesterday's events sit flush against today's.
   */
  it("bands the table by day and says whose clock drew the boundary", () => {
    renderTable({ nowIso: "2026-08-25T15:00:00.000Z" });

    const band = document.querySelector('[data-slot="data-table-group-row"]');
    expect(band).not.toBeNull();
    expect(
      within(band as HTMLElement).getByText("Yesterday · August 24, 2026"),
    ).toBeVisible();
    expect(
      within(band as HTMLElement).getByText(
        "day boundaries follow the workspace clock in New York",
      ),
    ).toBeVisible();
  });

  it("names the order and what the order cannot tell you, in both layouts", () => {
    renderAudit();
    const feedFooter = document.querySelector('[data-slot="table-footer-note"]');
    expect(feedFooter).toHaveTextContent("newest first");
    expect(feedFooter).toHaveTextContent(
      "The log does not store when the change took effect.",
    );

    cleanup();
    renderTable();
    const tableFooter = document.querySelector('[data-slot="table-footer-note"]');
    expect(tableFooter).toHaveTextContent("newest first");
    expect(tableFooter).toHaveTextContent(
      "The log does not store when the change took effect.",
    );
  });

  it("puts the actor's role under their name instead of behind Display", () => {
    renderTable();

    const cell = [...document.querySelectorAll('[data-slot="cell-two-line"]')].find(
      (node) => node.textContent?.includes("Marcus Lane"),
    );
    expect(cell).toBeDefined();
    expect(
      within(cell as HTMLElement).getByText("Person"),
    ).toBeVisible();
    expect(cell?.querySelector('[data-slot="monogram"]')).not.toBeNull();
  });

  /*
   * Round 5 on the 6a frame: an empty cell goes quiet rather than repeating italic filler down the
   * column. It still says what did not happen -- a dash would claim "not measured", "not
   * applicable" and "none" at once.
   */
  it("prints an absent origin as quiet words in the table, not italic filler", async () => {
    const user = userEvent.setup();
    renderTable();

    await user.click(screen.getByRole("button", { name: "Display" }));
    await user.click(await screen.findByRole("menuitemcheckbox", { name: "Source" }));

    const quiet = document.querySelectorAll('[data-slot="cell-quiet"]');
    expect(quiet.length).toBeGreaterThan(0);
    expect([...quiet].map((node) => node.textContent)).toContain("no origin recorded");
    for (const node of quiet) {
      expect(node.className).not.toContain("italic");
    }
  });
  /**
   * The time range, and why it is a URL filter rather than a facet.
   *
   * The Outcome, Actor role and Client controls beside it narrow the rows already on the page,
   * which is right for a facet whose options come from those rows. A window cannot work that way:
   * "7 days" over one loaded page shows the last 50 events that happen to be recent, and the
   * footer's total then answers a different question from the control above it. So the range goes
   * into the URL, the server applies it to the count query and the row query alike, and paging
   * resets -- a page-4 cursor pointing into a window that no longer has four pages lands the
   * reader on an empty page for a range that has events in it.
   */
  it("puts the time range in the URL and resets paging, because the server applies it", async () => {
    const user = userEvent.setup();
    navigation.searchParams = new URLSearchParams("page=3&cursor=2026-08-01T00:00:00.000Z~40");
    navigation.replace.mockClear();
    renderAudit();

    await user.click(within(screen.getByRole("group", { name: "Time range" }))
      .getByRole("button", { name: "7 days" }));

    const [href] = navigation.replace.mock.calls.at(-1) ?? [];
    const query = new URLSearchParams(String(href).split("?")[1] ?? "");
    expect(query.get("range")).toBe("7d");
    expect(query.get("page")).toBeNull();
    expect(query.get("cursor")).toBeNull();
  });

  it("names the server's own cutoff date rather than saying seven days ago", () => {
    navigation.searchParams = new URLSearchParams("range=7d");
    renderAudit({ rangeStart: "2026-08-17T11:00:00.000Z" });

    // The boundary the query actually used. A browser subtracting seven days from its own clock
    // would print a cutoff the server never applied, on the one page whose whole value is
    // "what happened and when".
    expect(screen.getByText(/since Aug 17, 2026/)).toBeVisible();
  });

  it("prints no cutoff at all on the whole log, because there is no boundary to name", () => {
    navigation.searchParams = new URLSearchParams();
    renderAudit({ rangeStart: null });

    expect(
      within(screen.getByRole("group", { name: "Time range" })).getByRole("button", { name: "All" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(/^since /)).toBeNull();
  });
  /**
   * The range has to reach the count query as well as the row query.
   *
   * If it only narrowed the rows, the footer would read "212 events, showing 1 to 50" under a
   * control that says 7 days -- a total for the whole log presented as the total for the window,
   * on the page whose job is to be exact. Both queries go through `withVisibleAuditFilters`, so
   * the assertion is that the range filter lives inside that helper and nowhere else.
   */
  it("applies the range inside the shared filter, so the total counts the same window", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/app/(workspace)/admin/audit/page.tsx"),
      "utf8",
    );

    const occurrences = source.split('gte("created_at"').length - 1;
    expect(occurrences).toBe(1);
    const helper = source.indexOf("function withVisibleAuditFilters");
    const countQuery = source.indexOf("let countQuery");
    const filter = source.indexOf('gte("created_at"');
    expect(helper).toBeGreaterThan(-1);
    expect(filter).toBeGreaterThan(helper);
    expect(filter).toBeLessThan(countQuery);
  });
});
