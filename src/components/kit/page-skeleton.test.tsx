import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DetailPageSkeleton,
  ListPageLoading,
  ListPageSkeleton,
  OverviewSkeleton,
  PageSkeletonShell,
  SettingsPageSkeleton,
  loadingCrumbs,
} from "@/components/kit/page-skeleton";

const pathname = vi.hoisted(() => ({ current: "/admin/platform-clients" }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathname.current,
}));

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  pathname.current = "/admin/platform-clients";
});

function root(slot: string) {
  return document.querySelector(`[data-slot="${slot}"]`) as HTMLElement;
}

describe("page skeletons", () => {
  it("announces the list shape once and draws rows at the table's own row height", () => {
    render(<ListPageSkeleton columns={5} rows={6} stats={4} />);

    const page = root("list-page-skeleton");
    expect(page).toHaveAttribute("role", "status");
    expect(page).toHaveAttribute("aria-busy", "true");
    expect(page).toHaveAttribute("data-layout", "fixed");

    // One live region for the whole page: every bone under it is hidden from the reader.
    expect(screen.getAllByRole("status")).toHaveLength(1);

    expect(root("page-skeleton-stats")).toHaveAttribute("data-tile-count", "4");
    const table = root("page-skeleton-table");
    expect(table).toHaveAttribute("data-row-count", "6");
    expect(table).toHaveAttribute("data-column-count", "5");

    // The bones stand at the heights DataTable actually renders -- --d-row for a body row,
    // --d-th for the column header -- so the arriving rows land where the bones were. They were
    // both --row-h, the density-toggle contract, which is 4px taller than either.
    expect(table.querySelectorAll(".h-\\[var\\(--d-row\\)\\]")).toHaveLength(6);
    expect(table.querySelectorAll(".h-\\[var\\(--d-th\\)\\]")).toHaveLength(1);
    expect(table.querySelectorAll(".h-\\[var\\(--row-h\\)\\]")).toHaveLength(0);
  });

  it("drops the stat strip when a list page carries no tiles", () => {
    render(<ListPageSkeleton stats={0} />);

    expect(root("page-skeleton-stats")).toBeNull();
    expect(root("page-skeleton-table")).not.toBeNull();
  });

  it("draws the detail shape as a tab strip over a two-column body", () => {
    render(<DetailPageSkeleton tabs={4} />);

    const page = root("detail-page-skeleton");
    expect(page).toHaveAttribute("role", "status");
    expect(page).toHaveAttribute("aria-busy", "true");
    expect(root("page-skeleton-tabs")).toHaveAttribute("data-tab-count", "4");
    expect(root("page-skeleton-detail-body")).toHaveClass("lg:grid-cols-[2fr_1fr]");
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("draws the settings shape as a rail beside its sections", () => {
    render(<SettingsPageSkeleton railItems={5} sections={3} />);

    const page = root("settings-page-skeleton");
    expect(page).toHaveAttribute("role", "status");
    expect(page).toHaveAttribute("aria-busy", "true");
    const rail = root("page-skeleton-rail");
    expect(rail).toHaveAttribute("data-rail-count", "5");
    expect(rail).toHaveClass("lg:w-[calc(var(--sidebar-w)*0.8)]");
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("draws the overview shape as four tiles over a queue and a chart", () => {
    render(<OverviewSkeleton />);

    const page = root("overview-skeleton");
    expect(page).toHaveAttribute("role", "status");
    expect(page).toHaveAttribute("aria-busy", "true");
    expect(root("page-skeleton-stats")).toHaveAttribute("data-tile-count", "4");
    expect(root("page-skeleton-queue")).not.toBeNull();
    expect(root("page-skeleton-chart")).not.toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("plays no fade of its own, so the bones are painted on the first frame", () => {
    render(<ListPageSkeleton />);

    // kit-content-reveal starts at opacity 0; a skeleton wearing it is invisible for exactly the
    // window the skeleton exists to fill. The reveal belongs to the content replacing it.
    expect(root("list-page-skeleton").className).not.toContain("kit-content-reveal");
  });
});

describe("loadingCrumbs", () => {
  it("reads the trail off the same nav the shell builds", () => {
    expect(loadingCrumbs("admin", "/admin/platform-clients")).toEqual([
      { label: "Run" },
      { label: "Clients" },
    ]);
  });

  /*
   * Read against the coach rail rather than the admin one.
   *
   * This used `/admin/brain/testing`, which had its own "Evals" row under a "Brain" group that
   * also matched by prefix. The folded admin nav is eight single-segment destinations with no
   * nested rows at all, so nothing there can be exact and prefix at once. The coach rail still
   * can: "Leads" is `/coach/contacts` and carries `/coach/pipelines` as a `matchPaths` entry, so
   * the exact pass has to find it before the prefix pass reaches anything else.
   */
  it("prefers an exact href over a parent that only matches by prefix", () => {
    expect(loadingCrumbs("coach", "/coach/pipelines")).toEqual([
      { label: "Workspace" },
      { label: "Leads" },
    ]);
    // And a child route with no row of its own still resolves to the parent rather than falling
    // through to the neutral crumb, which is the other half of the two passes.
    expect(loadingCrumbs("admin", "/admin/brain/testing")).toEqual([
      { label: "Platform" },
      { label: "The Brain" },
    ]);
  });

  it("names the group Overview now lives in, since every admin group is labelled", () => {
    expect(loadingCrumbs("admin", "/admin/overview")).toEqual([
      { label: "Run" },
      { label: "Overview" },
    ]);
  });

  it("falls back to one neutral crumb for a path the nav does not carry", () => {
    expect(loadingCrumbs("admin", "/admin/not-a-route")).toEqual([{ label: "Loading" }]);
  });
});

describe("PageSkeletonShell", () => {
  it("keeps the shell on screen while the page it wraps is still suspending", async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    // Annotated `never`: a body that only throws infers `void`, which React's JSX
    // element type rejects. `never` is assignable to ReactNode, so the suspending
    // helper types as a component while still throwing the promise Suspense reads.
    function SuspendingPage(): never {
      throw pending;
    }

    render(
      <Suspense fallback={<ListPageLoading />}>
        <SuspendingPage />
      </Suspense>,
    );

    // The nav, the topbar and the breadcrumb are all present during the gap, which is what stops
    // the page going blank between routes.
    expect(document.querySelector("[data-shell-root]")).not.toBeNull();
    expect(screen.getAllByRole("link", { name: "Clients" })[0]).toBeVisible();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Clients");
    expect(root("list-page-skeleton")).not.toBeNull();

    resolve();
  });

  it("highlights the route being opened, not the one being left", () => {
    pathname.current = "/admin/brain";
    render(
      <PageSkeletonShell>
        <ListPageSkeleton />
      </PageSkeletonShell>,
    );

    const current = screen
      .getAllByRole("link", { name: "The Brain" })
      .find((link) => link.getAttribute("aria-current") === "page");
    expect(current).toBeDefined();
    expect(
      screen
        .getAllByRole("link", { name: "Overview" })
        .some((link) => link.getAttribute("aria-current") === "page"),
    ).toBe(false);
  });
});
