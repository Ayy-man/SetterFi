import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DetailPage } from "@/components/kit/templates/detail-page";
import { ListPage } from "@/components/kit/templates/list-page";
import { PageSection } from "@/components/kit/templates/page-section";
import {
  SettingsLayout,
  SettingsSection,
} from "@/components/kit/templates/settings-layout";
import { FormSaveBar } from "@/components/kit/form-save-bar";
import { Button } from "@/components/ui/button";

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/settings",
}));

describe("ListPage", () => {
  it("gives the table a fixed-height container the page does not scroll", () => {
    render(
      <ListPage
        actions={<button type="button">Add client</button>}
        description="Every coach on the platform."
        stats={<div data-testid="stats">Four tiles</div>}
        title="Client book"
      >
        <div data-testid="table">Rows</div>
      </ListPage>,
    );

    const page = document.querySelector('[data-slot="list-page"]');
    expect(page).toHaveAttribute("data-layout", "fixed");
    expect(page).toHaveClass("min-h-0", "flex-1");
    expect(screen.getByRole("heading", { level: 1, name: "Client book" })).toBeVisible();
    expect(screen.getByTestId("stats")).toBeVisible();
    expect(screen.getByTestId("table")).toBeVisible();
    expect(
      within(document.querySelector('[data-slot="list-page-actions"]') as HTMLElement).getByRole(
        "button",
        { name: "Add client" },
      ),
    ).toBeVisible();
  });

  it("renders exactly one filled action, last in the row", () => {
    const onClick = vi.fn();
    render(
      <ListPage
        actions={<button type="button">Export</button>}
        description="Every coach on the platform."
        primaryAction={{ label: "Import now", onClick }}
        title="Client book"
      >
        <div>Rows</div>
      </ListPage>,
    );

    const row = document.querySelector('[data-slot="list-page-actions"]') as HTMLElement;
    const controls = Array.from(row.querySelectorAll("button, a"));
    expect(controls.at(-1)).toHaveTextContent("Import now");
    expect(controls.filter((control) => control.getAttribute("data-variant") === "primary"))
      .toHaveLength(1);
  });

  it("labels rows that are not production data when a page passes provenance", () => {
    render(
      <ListPage
        description="Every coach on the platform."
        provenance="Demo data, excluded from real analytics"
        title="Client book"
      >
        <div>Rows</div>
      </ListPage>,
    );

    expect(screen.getByText("Demo data, excluded from real analytics")).toBeVisible();
  });
});

describe("DetailPage", () => {
  it("carries the same provenance line as ListPage, under the header", () => {
    render(
      <DetailPage
        provenance="Demo data, excluded from real analytics"
        subtitle="Coach since March"
        tabs={[{ id: "overview", label: "Overview", content: <div>Overview</div> }]}
        title="Ledger Lift"
      />,
    );

    const line = screen.getByText("Demo data, excluded from real analytics");
    expect(line).toBeVisible();
    expect(line.closest('[data-slot="detail-page-header"]')).not.toBeNull();
  });

  it("shows the first tab by default and swaps content on selection", async () => {
    const user = userEvent.setup();
    render(
      <DetailPage
        state={{ kind: "lifecycle", label: "Live", tone: "good" }}
        subtitle="Coach since March"
        tabs={[
          { id: "overview", label: "Overview", content: <p>Decision view</p> },
          { id: "economics", label: "Economics", content: <p>Cost per booking</p> },
        ]}
        title="Bright Path Credit"
      >
      </DetailPage>,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Bright Path Credit" })).toBeVisible();
    expect(screen.getByText("Live")).toBeVisible();
    expect(screen.getByText("Decision view")).toBeVisible();

    await user.click(screen.getByRole("tab", { name: "Economics" }));
    expect(screen.getByText("Cost per booking")).toBeVisible();
  });
});

describe("scroll containers", () => {
  // `sr-only` is `position: absolute`. Inside a fixed-height scroller with no positioned
  // ancestor its containing block is the viewport, so it escapes the clip, adds its static
  // offset to documentElement.scrollHeight, and puts a scrollbar on a viewport-fixed page.
  // Every scroller a page can fill therefore carries `relative`.
  it("gives the detail tab body a positioned ancestor", () => {
    render(
      <DetailPage
        subtitle="Coach since March"
        tabs={[
          {
            id: "overview",
            label: "Overview",
            content: <h2 className="sr-only">Section</h2>,
          },
        ]}
        title="Bright Path Credit"
      />,
    );

    const panel = document.querySelector('[data-slot="tabs-content"]');
    expect(panel).toHaveClass("relative", "overflow-y-auto");
  });

  it("gives the settings content column a positioned ancestor", () => {
    render(
      <SettingsLayout items={[{ href: "/admin/settings", title: "General" }]} title="Settings">
        <h2 className="sr-only">Section</h2>
      </SettingsLayout>,
    );

    expect(document.querySelector('[data-slot="settings-layout-content"]')).toHaveClass(
      "relative",
      "overflow-y-auto",
    );
  });
});

describe("DetailPage route-driven tabs", () => {
  it("renders a tab with an href as a link that still reads as the open tab", () => {
    // An anchor rendered by a button-shaped primitive logs unless it is told it is not native.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <DetailPage
        defaultTab="costs"
        subtitle="Every figure behind the invoice."
        tabs={[
          { id: "costs", label: "Cost evidence", href: "/admin/billing/costs", content: <div>Costs</div> },
          { id: "revenue", label: "Revenue", href: "/admin/billing", content: <div>Revenue</div> },
        ]}
        title="Revenue"
      />,
    );

    const open = screen.getByRole("tab", { name: "Cost evidence" });
    expect(error).not.toHaveBeenCalled();
    expect(open.tagName).toBe("A");
    expect(open).toHaveAttribute("href", "/admin/billing/costs");
    expect(open).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("tab", { name: "Revenue" })).not.toHaveAttribute("aria-current");
    error.mockRestore();
  });
});

describe("ListPage scope", () => {
  it("puts the scope switch above the table, outside its toolbar", () => {
    render(
      <ListPage
        description="Every coach on the platform."
        scope={<button type="button">My clients</button>}
        stats={<div data-testid="stats">Tiles</div>}
        title="Client book"
      >
        <div data-testid="table">Rows</div>
      </ListPage>,
    );

    const slot = document.querySelector('[data-slot="list-page-scope"]') as HTMLElement;
    expect(within(slot).getByRole("button", { name: "My clients" })).toBeVisible();
    const body = document.querySelector('[data-slot="list-page-body"]') as HTMLElement;
    expect(slot.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("SettingsSection actions", () => {
  it("puts section actions on the heading row, not in the save bar", () => {
    render(
      <SettingsSection
        actions={<button type="button">Export plans</button>}
        title="Plan ladder"
      >
        <div>Fields</div>
      </SettingsSection>,
    );

    const actions = document.querySelector('[data-slot="settings-section-actions"]');
    expect(actions).not.toBeNull();
    expect(within(actions as HTMLElement).getByRole("button", { name: "Export plans" })).toBeVisible();
  });
});

describe("SettingsLayout", () => {
  it("renders a text-only rail that marks the current sub-page", () => {
    render(
      <SettingsLayout
        items={[
          { href: "/admin/settings", title: "General" },
          { href: "/admin/settings/branding", title: "Branding" },
        ]}
        title="Settings"
      >
        <SettingsSection
          footer={<FormSaveBar dirty logged="Logged" onSave={() => {}} />}
          title="Workspace"
        >
          <p>Fields</p>
        </SettingsSection>
      </SettingsLayout>,
    );

    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(nav).getByRole("link", { name: "General" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: "Branding" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(nav.querySelector("svg")).toBeNull();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    expect(screen.getByText("Logged")).toBeVisible();
  });

  it("disables the save bar until something is dirty", () => {
    render(<FormSaveBar dirty={false} onDiscard={() => {}} onSave={() => {}} />);

    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
  });
});

describe("page heads", () => {
  it("renders the required ListPage description as a muted line under the title", () => {
    render(
      <ListPage description="Every coach on the platform and who owns them." title="Client book">
        <div>Rows</div>
      </ListPage>,
    );

    const title = screen.getByRole("heading", { level: 1, name: "Client book" });
    expect(title).toHaveClass("t-page-title");

    const description = document.querySelector<HTMLElement>(
      '[data-slot="list-page-description"]',
    );
    expect(description).not.toBeNull();
    if (!description) throw new Error("Expected the ListPage description slot.");
    expect(description).toHaveTextContent("Every coach on the platform and who owns them.");
    expect(description.className).toContain("var(--muted)");
    expect(
      title.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders the required DetailPage subtitle as a muted line under the title", () => {
    render(
      <DetailPage
        subtitle="Coach since March, on the Growth plan."
        tabs={[{ id: "overview", label: "Overview", content: <div>Overview</div> }]}
        title="Bright Path Credit"
      />,
    );

    const title = screen.getByRole("heading", { level: 1, name: "Bright Path Credit" });
    expect(title).toHaveClass("t-page-title");

    const subtitle = document.querySelector<HTMLElement>(
      '[data-slot="detail-page-subtitle"]',
    );
    expect(subtitle).not.toBeNull();
    if (!subtitle) throw new Error("Expected the DetailPage subtitle slot.");
    expect(subtitle).toHaveTextContent("Coach since March, on the Growth plan.");
    expect(subtitle.className).toContain("var(--muted)");
  });

  it("sets the breadcrumb slot in the mono crumb role", () => {
    render(
      <ListPage
        breadcrumb={<span>Platform / Clients</span>}
        description="Every coach on the platform."
        title="Client book"
      >
        <div>Rows</div>
      </ListPage>,
    );

    expect(document.querySelector('[data-slot="list-page-breadcrumb"]')).toHaveClass(
      "t-mono-crumb",
    );
  });

  it("warns in development when the header row carries two filled actions", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(
      <ListPage
        actions={<Button>Publish</Button>}
        description="Every coach on the platform."
        primaryAction={{ label: "Import now", onClick: () => {} }}
        title="Client book"
      >
        <div>Rows</div>
      </ListPage>,
    );

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("ListPage: 2 filled actions in the header row."),
    );
    warn.mockRestore();
  });

  it("stays quiet when only the primary action is filled", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(
      <ListPage
        actions={<Button variant="outline">Export</Button>}
        description="Every coach on the platform."
        primaryAction={{ label: "Import now", onClick: () => {} }}
        title="Client book"
      >
        <div>Rows</div>
      </ListPage>,
    );

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("DetailPage tab counts", () => {
  it("renders an optional count faint in mono after the label, and leaves the tab name alone", () => {
    render(
      <DetailPage
        subtitle="The shared industry brain."
        tabs={[
          { id: "overview", label: "Overview", content: <div>Overview</div> },
          { id: "knowledge", label: "Knowledge", count: 412, content: <div>Entries</div> },
        ]}
        title="The Brain"
      />,
    );

    const tab = screen.getByRole("tab", { name: "Knowledge" });
    const count = within(tab).getByText("412");
    expect(count).toHaveAttribute("data-slot", "detail-page-tab-count");
    expect(count).toHaveAttribute("aria-hidden", "true");
    expect(count.className).toContain("var(--font-mono)");
    expect(count.className).toContain("var(--faint)");

    // A tab with no count renders none at all, rather than a zero.
    const plain = screen.getByRole("tab", { name: "Overview" });
    expect(
      plain.querySelector('[data-slot="detail-page-tab-count"]'),
    ).toBeNull();
  });
});

describe("vertical rhythm", () => {
  const slot = (name: string) =>
    document.querySelector(`[data-slot="${name}"]`) as HTMLElement;

  it("gives a list page with a stat strip a tall summary block over tight rows", () => {
    render(
      <ListPage
        breadcrumb={<span>Platform / Overview</span>}
        description="What needs a person today."
        stats={<div data-testid="stats">Four tiles</div>}
        title="Overview"
      >
        <div data-testid="table">Rows</div>
      </ListPage>,
    );

    // No container gap: every block owns the break above it, so the breaks can differ.
    expect(slot("list-page")).not.toHaveClass("gap-[var(--s-4)]");
    // The crumb labels the title, so it sits nearest of anything on the page.
    expect(slot("list-page-breadcrumb")).toHaveClass("mb-[var(--s-2)]");
    // Head to summary strip: the first real break.
    expect(slot("list-page-stats")).toHaveClass("mt-[var(--s-5)]");
    // Summary strip to table: the largest break, because they are two different sections.
    expect(slot("list-page-body")).toHaveClass("mt-[var(--d-section-gap)]");
  });

  it("puts a list page with no stat strip straight into its rows", () => {
    render(
      <ListPage description="Every coach on the platform." title="Client book">
        <div data-testid="table">Rows</div>
      </ListPage>,
    );

    // One section, so no section break: the table opens at the head break instead. This is the
    // whole point -- the client book and the Overview must not have the same texture.
    expect(slot("list-page-body")).toHaveClass("mt-[var(--s-5)]");
    expect(slot("list-page-body")).not.toHaveClass("mt-[var(--d-section-gap)]");
  });

  it("keeps a scope switch tight against the table it re-scopes", () => {
    render(
      <ListPage
        description="Every coach on the platform."
        scope={<button type="button">My clients</button>}
        stats={<div>Four tiles</div>}
        title="Client book"
      >
        <div>Rows</div>
      </ListPage>,
    );

    // The scope row takes the section break under the strip; the table then sits close under the
    // control that governs it rather than floating a section away from it.
    expect(slot("list-page-scope")).toHaveClass("mt-[var(--d-section-gap)]");
    expect(slot("list-page-body")).toHaveClass("mt-[var(--s-3)]");
  });

  it("gives a detail page's bare tab strip more air above than a bordered strip needs", () => {
    render(
      <DetailPage
        subtitle="Acme Coaching, Pro plan."
        tabs={[{ id: "overview", label: "Overview", content: <div>Body</div> }]}
        title="Acme Coaching"
      />,
    );

    // 24px above the tabs, 12px below them: a list page's stat strip is the other way round.
    const tabs = document.querySelector('[role="tablist"]')?.parentElement as HTMLElement;
    expect(tabs).toHaveClass("mt-[var(--s-6)]");
    expect(document.querySelector('[role="tabpanel"]')).toHaveClass("mt-[var(--s-3)]");
  });
});

describe("PageSection", () => {
  it("pushes a section away from what precedes it and pulls it tight around its own content", () => {
    render(
      <PageSection description="Who the agent talks to." title="Audience">
        <div data-testid="body">Fields</div>
      </PageSection>,
    );

    const section = document.querySelector('[data-slot="page-section"]') as HTMLElement;
    // The largest break on the page above the heading, the smallest one under it. That contrast is
    // the whole announcement: no rule, no tint, and no coloured edge bar.
    expect(section).toHaveClass("mt-[var(--d-section-gap)]", "first:mt-0");
    expect(document.querySelector('[data-slot="page-section-body"]')).toHaveClass(
      "mt-[var(--s-3)]",
    );
    expect(screen.getByTestId("body")).toBeVisible();
  });

  it("takes a heading level without changing how the heading is set", () => {
    render(
      <>
        <PageSection title="Audience">
          <div>Fields</div>
        </PageSection>
        <PageSection headingLevel={3} id="tone" title="Tone">
          <div>Fields</div>
        </PageSection>
      </>,
    );

    const two = screen.getByRole("heading", { level: 2, name: "Audience" });
    const three = screen.getByRole("heading", { level: 3, name: "Tone" });
    expect(three).toHaveAttribute("id", "tone");
    // The break above the heading carries the level, not the type: both are the same 14/600 role.
    expect(two.className).toBe(three.className);
  });

  it("puts section actions on the heading row rather than above the content", () => {
    render(
      <PageSection actions={<button type="button">Export</button>} title="Audience">
        <div>Fields</div>
      </PageSection>,
    );

    const row = document.querySelector('[data-slot="page-section-actions"]') as HTMLElement;
    expect(within(row).getByRole("button", { name: "Export" })).toBeVisible();
    expect(row.closest('[data-slot="page-section-heading"]')).not.toBeNull();
  });
});
