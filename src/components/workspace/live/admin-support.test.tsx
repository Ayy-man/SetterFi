import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  pathname: "/admin/attention",
  replace: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ refresh: vi.fn(), replace: navigation.replace }),
  useSearchParams: () => navigation.searchParams,
}));

import { AdminSupport } from "@/components/workspace/live/admin-support";
import type { PlatformSupportThreadRead } from "@/lib/repositories/support";

function thread(
  overrides: Partial<PlatformSupportThreadRead> = {},
): PlatformSupportThreadRead {
  return {
    id: "thread-1",
    tenantId: "tenant-1",
    tenantName: "Ascend Credit Collective (demo)",
    tenantIsDemo: false,
    subject: "Booking link returns a closed calendar",
    status: "open",
    assignedTo: null,
    successOwner: { id: "owner-1", name: "Dana Whitfield" },
    isTest: false,
    createdAt: "2026-08-24T09:00:00.000Z",
    updatedAt: "2026-08-24T09:30:00.000Z",
    messages: [],
    ...overrides,
  };
}

/**
 * The surface reads its queue on mount, so every test states the rows the fetch returns rather
 * than letting an unmocked fetch decide. The URL is the filter state, so the assertions are on
 * what the control writes to it, not on component internals.
 */
function stubQueue(threads: PlatformSupportThreadRead[]) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ threads }), {
      headers: { "content-type": "application/json" },
      status: 200,
    }),
  );
}

function renderSupport(
  props: Partial<Parameters<typeof AdminSupport>[0]> = {},
) {
  return render(
    <AdminSupport actorId="owner-1" actorRole="admin" enabled {...props} />,
  );
}

describe("AdminSupport filters", () => {
  beforeEach(() => {
    navigation.pathname = "/admin/attention";
    navigation.replace.mockReset();
    navigation.searchParams = new URLSearchParams();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers the status filter as the shared facet chip rather than a page-local control", async () => {
    stubQueue([thread()]);
    renderSupport();

    const facet = await screen.findByRole("button", { name: /Status/ });
    expect(facet).toBeInTheDocument();
    // The idiom the audit log also uses. A native select here would mean two controls for one
    // idea across two pages, which is what this replaced.
    expect(
      screen.queryByRole("combobox", { name: /Status/i }),
    ).not.toBeInTheDocument();
  });

  it("writes the pressed status to the URL so the queue read and the export share one scope", async () => {
    const user = userEvent.setup();
    stubQueue([thread()]);
    renderSupport();

    await user.click(await screen.findByRole("button", { name: /Status/ }));
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: "Resolved" }),
    );

    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledWith(
        "/admin/attention?status=resolved",
        { scroll: false },
      );
    });
  });

  it("keeps the last status pressed, because the URL holds one status and the chip is multi-select", async () => {
    const user = userEvent.setup();
    stubQueue([thread()]);
    navigation.searchParams = new URLSearchParams("status=open");
    renderSupport();

    await user.click(await screen.findByRole("button", { name: /Status/ }));
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: "Resolved" }),
    );

    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledWith(
        "/admin/attention?status=resolved",
        { scroll: false },
      );
    });
    expect(navigation.replace).not.toHaveBeenCalledWith(
      expect.stringContaining("status=open&status=resolved"),
      expect.anything(),
    );
  });

  it("switches the client book through the same scope control the audit log uses", async () => {
    const user = userEvent.setup();
    stubQueue([thread()]);
    renderSupport();

    const scope = await screen.findByRole("group", { name: "Client book" });
    await user.click(within(scope).getByRole("button", { name: "My clients" }));

    await waitFor(() => {
      expect(navigation.replace).toHaveBeenCalledWith(
        "/admin/attention?view=mine",
        { scroll: false },
      );
    });
  });

  it("drops the per-row demo badge when every row in the queue is demo", async () => {
    stubQueue([
      thread({ id: "a", tenantIsDemo: true }),
      thread({ id: "b", subject: "Second demo request", tenantIsDemo: true }),
    ]);
    renderSupport();

    await screen.findByText("Booking link returns a closed calendar");
    // A badge on every row is noise rather than disclosure, so the page-level provenance line
    // carries it instead.
    expect(
      document.querySelectorAll('[data-slot="data-table-test-label"]'),
    ).toHaveLength(0);
    // The absence of the chip is the kit's own doing and stays true even if the page stops
    // handing it a predicate, so it proves nothing on its own. This marker is the part only the
    // page can get wrong: it appears only when DataTable is actually told which rows are seeded.
    expect(document.querySelector('[data-slot="data-table"]')).toHaveAttribute(
      "data-all-test-rows",
    );
    // A queue where every thread belongs to a demo tenant is a claim about the page, so it is the
    // chip above the title rather than the mixed-rows sentence -- and never both at once.
    expect(document.querySelector('[data-slot="provenance-chip"]')).toHaveAttribute(
      "data-provenance",
      "demo",
    );
    expect(screen.queryByText(/Demo and test threads are labelled/)).toBeNull();
  });

  it("keeps the per-row demo badge when only some of the queue is demo", async () => {
    stubQueue([
      thread({ id: "a", tenantIsDemo: true }),
      thread({ id: "b", subject: "A real request" }),
    ]);
    renderSupport();

    await screen.findByText("A real request");
    await waitFor(() => {
      expect(
        document.querySelectorAll('[data-slot="data-table-test-label"]').length,
      ).toBeGreaterThan(0);
    });
  });
});

describe("AdminSupport queue shape", () => {
  beforeEach(() => {
    navigation.pathname = "/admin/attention";
    navigation.replace.mockReset();
    navigation.searchParams = new URLSearchParams();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bands the queue by what is holding each request up", async () => {
    stubQueue([
      thread({ id: "a", status: "open" }),
      thread({
        id: "b",
        status: "waiting_on_coach",
        subject: "Second request",
      }),
    ]);
    renderSupport();

    await screen.findByRole("cell", { name: /Booking link/ });
    // The band is read by its group key rather than by a header name: the quiet treatment gives
    // its chevron column an sr-only "Open" heading, so a name match alone would find two things
    // and prove neither of them is the band.
    const open = document.querySelector('[data-group-id="open"]') as HTMLElement;
    expect(within(open).getByText("Open")).toBeVisible();
    expect(
      within(open).getByText("nobody on the team has answered yet"),
    ).toBeVisible();
    const parked = document.querySelector(
      '[data-group-id="waiting_on_coach"]',
    ) as HTMLElement;
    expect(within(parked).getByText("Waiting on coach")).toBeVisible();
    expect(
      within(parked).getByText("the clock is on the coach, not on the team"),
    ).toBeVisible();
  });

  it("narrows to the threads nobody owns when the unassigned view is chosen", async () => {
    navigation.searchParams = new URLSearchParams("view=unassigned");
    stubQueue([
      thread({
        id: "a",
        successOwner: { id: "owner-1", name: "Dana Whitfield" },
      }),
      thread({ id: "b", subject: "Nobody owns this", successOwner: null }),
    ]);
    renderSupport();

    await screen.findByRole("cell", { name: /Nobody owns this/ });
    expect(
      screen.queryByRole("cell", { name: /Booking link/ }),
    ).not.toBeInTheDocument();
  });

  it("names who raised a request and who touched it last in the drawer's audit line", async () => {
    const user = userEvent.setup();
    stubQueue([
      thread({
        messages: [
          {
            id: "m1",
            authorId: "coach-1",
            authorName: "Marcus Reed",
            body: "The link is closed.",
            internal: false,
            isTest: false,
            createdAt: "2026-08-24T09:00:00.000Z",
          },
          {
            id: "m2",
            authorId: "owner-1",
            authorName: "Dana Whitfield",
            body: "Looking now.",
            internal: false,
            isTest: false,
            createdAt: "2026-08-24T09:30:00.000Z",
          },
        ],
      }),
    ]);
    renderSupport();

    const identity = await screen.findByRole("cell", {
      name: /Ascend Credit Collective/,
    });
    await user.click(within(identity).getByRole("button"));

    const sheet = await screen.findByRole("dialog");
    expect(
      within(sheet).getByText(/created .* Marcus Reed/),
    ).toBeInTheDocument();
    expect(
      within(sheet).getByText(/last change .* Dana Whitfield/),
    ).toBeInTheDocument();
  });
});

describe("AdminSupport message append", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * A refused append used to rethrow out of `appendMessage` into a `void ...then(...)` chain with
   * no catch, so the browser received an unhandled rejection and the surface reported nothing
   * useful. The refusal now has to reach the alert and leave the draft where the writer left it.
   */
  it("keeps the draft and reports a refused append without an unhandled rejection", async () => {
    const user = userEvent.setup();
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);

    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      if ((init?.method ?? "GET") === "GET") {
        return Promise.resolve(
          new Response(JSON.stringify({ threads: [thread()] }), {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ error: "Refused." }), {
          headers: { "content-type": "application/json" },
          status: 500,
        }),
      );
    });

    try {
      renderSupport();

      const identity = await screen.findByRole("cell", {
        name: /Ascend Credit Collective/,
      });
      await user.click(within(identity).getByRole("button"));

      const sheet = await screen.findByRole("dialog");
      const draft = within(sheet).getByPlaceholderText(
        "Write a reply to the coach",
      );
      await user.type(draft, "Checking the calendar now.");
      await user.click(within(sheet).getByRole("button", { name: "Send reply" }));

      await screen.findByRole("alert");
      expect(screen.getByRole("alert")).toHaveTextContent(
        "The message was not saved. The thread is unchanged.",
      );
      expect(draft).toHaveValue("Checking the calendar now.");

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("clears the draft once the append is read back", async () => {
    const user = userEvent.setup();
    const saved = thread({
      messages: [
        {
          id: "m1",
          authorId: "owner-1",
          authorName: "Dana Whitfield",
          body: "Checking the calendar now.",
          internal: false,
          isTest: false,
          createdAt: "2026-08-24T09:40:00.000Z",
        },
      ],
    });

    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      if ((init?.method ?? "GET") === "GET") {
        return Promise.resolve(
          new Response(JSON.stringify({ threads: [thread()] }), {
            headers: { "content-type": "application/json" },
            status: 200,
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ thread: saved }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      );
    });

    renderSupport();

    const identity = await screen.findByRole("cell", {
      name: /Ascend Credit Collective/,
    });
    await user.click(within(identity).getByRole("button"));

    const sheet = await screen.findByRole("dialog");
    const draft = within(sheet).getByPlaceholderText("Write a reply to the coach");
    await user.type(draft, "Checking the calendar now.");
    await user.click(within(sheet).getByRole("button", { name: "Send reply" }));

    await waitFor(() => expect(draft).toHaveValue(""));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("AdminSupport nav count", () => {
  beforeEach(() => {
    navigation.pathname = "/admin/attention";
    navigation.replace.mockReset();
    navigation.searchParams = new URLSearchParams();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hands the rail the same depth the page counts, resolved threads excluded", async () => {
    stubQueue([
      thread({ id: "a", status: "open" }),
      thread({ id: "b", status: "waiting_on_coach" }),
      thread({ id: "c", status: "resolved" }),
    ]);
    renderSupport();

    await screen.findAllByRole("cell", { name: /Ascend Credit Collective/ });
    const rail = screen.getByRole("navigation", { name: "Primary" });
    // Screen 5a renamed this destination: /admin/support is Client requests, and the Inbox label
    // now belongs to the merged attention-and-escalations queue at /admin/alerts.
    const attention = within(rail).getByRole("link", { name: /Client requests/ });
    // The badge is a sibling of the link, not part of its accessible name. Two waiting, one
    // resolved: a resolved thread is not waiting on anyone.
    const badge = attention
      .closest("li")
      ?.querySelector('[data-slot="nav-count"]');
    expect(badge).toHaveTextContent("2");
  });
});

describe("AdminSupport breadcrumb", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sits under Run in the breadcrumb trail", async () => {
    stubQueue([thread()]);
    renderSupport();

    await screen.findAllByRole("cell", { name: /Ascend Credit Collective/ });
    expect(
      screen.getByRole("navigation", { name: "Breadcrumb" }),
    ).toHaveTextContent("Run");
  });
});
