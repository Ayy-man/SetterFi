import { render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/support-team",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { AdminSupportTeam, ownerBooks } from "@/components/workspace/live/admin-support-team";
import type { SuccessClientBookRead } from "@/lib/repositories/support";

const PRIYA = { id: "aa000000-0000-4000-8000-000000000001", name: "Priya Raman" };
const DANA = { id: "aa000000-0000-4000-8000-000000000002", name: "Dana Whitlock" };

function client(
  name: string,
  overrides: Partial<SuccessClientBookRead> = {},
): SuccessClientBookRead {
  return {
    client: { id: `t-${name}`, name, isDemo: false },
    status: "active",
    successOwner: PRIYA,
    supportStatus: null,
    planId: "plan-growth",
    planLabel: "Growth",
    updatedAt: "2026-08-30T09:00:00.000Z",
    ...overrides,
  };
}

const ROWS: SuccessClientBookRead[] = [
  client("Reid Funding Group", { supportStatus: "open" }),
  client("Northstar Funding"),
  client("Ledger Lift", { status: "onboarding" }),
  client("Cedar Capital", { successOwner: DANA, supportStatus: "waiting_on_coach" }),
  client("Harbour Credit", { successOwner: null }),
  client("Vale Advisors", { successOwner: null, status: "onboarding", supportStatus: "open" }),
];

function stubFetch(rows: SuccessClientBookRead[] = ROWS) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ clients: rows }) }) as unknown as Response),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  stubFetch();
});

describe("ownerBooks", () => {
  it("groups the client book by its owner and ranks the heaviest book first", () => {
    expect(ownerBooks(ROWS)).toEqual([
      { id: PRIYA.id, name: "Priya Raman", clients: 3, openRequests: 1, onboarding: 1, live: 2 },
      { id: DANA.id, name: "Dana Whitlock", clients: 1, openRequests: 1, onboarding: 0, live: 1 },
    ]);
  });

  /**
   * The projection types an owner's name as nullable, and a uuid on a card headed by a monogram
   * reads as a person's name to anybody scanning the roster.
   */
  it("names an owner it cannot name rather than printing an id", () => {
    const [book] = ownerBooks([client("Reid Funding Group", {
      successOwner: { id: PRIYA.id, name: null },
    })]);
    expect(book.name).toBe("Owner not named");
    expect(book.name).not.toContain(PRIYA.id);
  });

  it("counts nobody for a client with no owner", () => {
    expect(ownerBooks([client("Harbour Credit", { successOwner: null })])).toEqual([]);
  });
});

describe("AdminSupportTeam", () => {
  it("shows each owner's book with the counts behind it", async () => {
    const { container } = render(<AdminSupportTeam actorId={PRIYA.id} enabled />);

    await screen.findByText("Priya Raman");
    const cards = [...container.querySelectorAll('[data-slot="support-team-owner"]')];
    expect(cards).toHaveLength(2);
    expect(within(cards[0] as HTMLElement).getByText("Priya Raman")).toBeInTheDocument();
    expect(cards[0]).toHaveTextContent("2 live · 1 onboarding · 1 open");
    // The reader's own book is named as theirs, because an owner console is a shared login in
    // practice and "which of these is mine" is the first question asked of this page.
    expect(cards[0]).toHaveTextContent("Your book");
    expect(cards[1]).toHaveTextContent("Success owner");
  });

  /**
   * The canvas draws "Median reply" as the third figure on every person card. There is no
   * first-response stamp anywhere in the schema, so the card says the figure is not measured. The
   * failure this pins is the obvious substitute: timing off `updated_at`, which moves on every
   * write and would rank the team by how often their threads are touched.
   */
  it("says median reply is not measured rather than printing a lookalike figure", async () => {
    const { container } = render(<AdminSupportTeam actorId={PRIYA.id} enabled />);

    await screen.findByText("Priya Raman");
    const card = container.querySelector('[data-slot="support-team-owner"]');
    expect(card).toHaveTextContent(
      "Median reply is not measured. Nothing records when a thread was first answered.",
    );
    expect(card?.textContent ?? "").not.toMatch(/median reply\s*[:\s]*\d/iu);
  });

  /**
   * `Rotation running` and `Pause assignment` are drawn on the artboard and there is no rotation
   * behind either: `success_owner` is one nullable uuid with no queue, no cursor and no scheduler.
   * A dead control is worse than no control, so the panel states what actually happens instead.
   */
  it("offers no rotation control, because no rotation exists", async () => {
    const { container } = render(<AdminSupportTeam actorId={PRIYA.id} enabled />);

    await screen.findByText("Priya Raman");
    const panel = container.querySelector('[data-slot="support-team-assignment"]');
    expect(panel).toHaveTextContent("There is no rotation to start, pause or resume.");
    expect(screen.queryByRole("button", { name: /pause assignment/iu })).toBeNull();
    expect(screen.queryByText(/rotation running/iu)).toBeNull();
  });

  it("lists the clients nobody owns", async () => {
    const { container } = render(<AdminSupportTeam actorId={PRIYA.id} enabled />);

    await screen.findByText("Priya Raman");
    const panel = container.querySelector('[data-slot="support-team-unassigned"]');
    expect(panel).toHaveTextContent("2 clients have nobody's name on them");
    expect(within(panel as HTMLElement).getByText("Harbour Credit")).toBeInTheDocument();
    expect(within(panel as HTMLElement).getByText("Vale Advisors")).toBeInTheDocument();
    // The owned clients are not in this table; it is the list the team works down.
    expect(within(panel as HTMLElement).queryByText("Reid Funding Group")).toBeNull();
  });

  it("says plainly that an owner with no clients cannot appear", async () => {
    render(<AdminSupportTeam actorId={PRIYA.id} enabled />);

    await screen.findByText("Priya Raman");
    expect(
      screen.getByText(/somebody with no clients yet does not appear here/u),
    ).toBeInTheDocument();
  });

  it("reads the whole platform rather than the reader's own book", async () => {
    render(<AdminSupportTeam actorId={PRIYA.id} enabled />);

    await screen.findByText("Priya Raman");
    expect(fetch).toHaveBeenCalledWith("/api/platform/clients?book=all", expect.anything());
  });

  it("says the team is unavailable rather than showing an empty roster when support is off", () => {
    render(<AdminSupportTeam actorId="" enabled={false} />);

    expect(screen.getByText("The success team is not available yet")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  /**
   * The rail's nineteen destinations are pinned by `workspace-navigation.test.ts`, so this page is
   * not in it. A page with no route to it is the failure `f8d0381` already fixed once for
   * Connections and Notifications, so the client book -- whose read this page groups -- carries
   * the only link, and that link is what makes the route real.
   */
  /**
   * CLAUDE.md: "Every table exports CSV/JSON." This screen rendered a `GridTable` of unowned
   * clients with no export at all, which is the hard rule broken rather than a nicety missed --
   * the unowned list is the one the team works down, and a table that can only be read is a table
   * whose contents get retyped into a spreadsheet.
   *
   * Both controls are named, because `AdminSupportTeam.dc.html` draws Export twice here and two
   * buttons that both read "Export" is the same as neither of them being named. The assertion is
   * on the names for that reason: a second unnamed control would satisfy a bare count.
   */
  it("exports both tables on the page under names that tell them apart", async () => {
    render(<AdminSupportTeam actorId={PRIYA.id} enabled />);

    await screen.findByText("Priya Raman");

    expect(screen.getByRole("button", { name: "Export the roster" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Export unassigned" })).toBeEnabled();
  });

  /**
   * The export carries the rows the reader can see and nothing they cannot. `mode="local"` is what
   * makes that true -- the `success-client-book` server resource has no unassigned filter, so a
   * server export from under this heading would hand back the whole platform book -- and this
   * asserts the mode rather than the button, since a button wired to the wrong source still
   * renders.
   */
  it("exports the unassigned rows on screen rather than the whole platform book", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/workspace/live/admin-support-team.tsx"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//gu, "");

    expect(source).toMatch(/rows=\{unassignedExportRows\}/u);
    expect(source).not.toMatch(/resource=/u);
  });

  it("is reachable from the client book", () => {
    const book = readFileSync(
      resolve(process.cwd(), "src/components/workspace/live/success-client-book.tsx"),
      "utf8",
    );
    expect(book).toContain('href="/admin/support-team"');
  });
});
