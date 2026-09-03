import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DataTable, DataTableToolbarShell } from "@/components/kit/data-table";
import { StateBadge } from "@/components/kit/state-badge";
import {
  absentValue,
  dateColumn,
  identityColumn,
  numberColumn,
  stateColumn,
  type StateBadgeRendererProps,
} from "@/components/kit/columns";
import { ExportMenu } from "@/components/kit/export-menu";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
}));

const setDensity = vi.fn();

vi.mock("@/components/kit/app-shell", () => ({
  useShellDensity: () => ({ density: "compact", setDensity }),
}));

beforeEach(() => setDensity.mockClear());

type Person = {
  id: string;
  name: string;
  status: string;
};

const columns: ColumnDef<Person>[] = [
  {
    accessorKey: "name",
    header: "Name",
    enableSorting: true,
  },
  {
    accessorKey: "status",
    header: "Status",
    enableSorting: true,
  },
];

function renderTable(data: readonly Person[]) {
  return render(
    <DataTable
      ariaLabel="People"
      columns={columns}
      data={data}
      emptyState={<div>No people match this view.</div>}
      getRowId={(row) => row.id}
    />,
  );
}

describe("DataTable", () => {
  it("renders the required empty state without a bare table header", () => {
    renderTable([]);

    expect(screen.getByText("No people match this view.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader")).not.toBeInTheDocument();
  });

  it("puts aria-sort and a visible control on every sortable header", () => {
    renderTable([{ id: "person-1", name: "Priya", status: "Active" }]);

    const headers = screen.getAllByRole("columnheader");
    expect(headers).toHaveLength(2);
    for (const header of headers) {
      expect(header).toHaveAttribute("aria-sort", "none");
      expect(within(header).getByRole("button")).toBeVisible();
    }
  });

  it("renders a labelled, focusable horizontal-scroll region", () => {
    renderTable([{ id: "person-1", name: "Priya", status: "Active" }]);

    const region = screen.getByRole("region", { name: "People" });
    expect(region).toHaveAttribute("tabindex", "0");
    // A positioned ancestor keeps any sr-only label inside the scroller's containing block,
    // so it cannot escape the clip and grow the page's scroll height.
    expect(region).toHaveClass("relative", "overflow-x-auto");
    expect(region.parentElement).toHaveClass("min-w-0");
  });

  it("uses tokenized column bounds and truncates long cell content", () => {
    renderTable([
      {
        id: "person-1",
        name: "A deliberately long identity value that must stay inside its column",
        status: "Active",
      },
    ]);

    const nameHeader = screen.getByRole("columnheader", { name: /Name/ });
    expect(nameHeader).toHaveClass(
      "min-w-[calc(var(--drawer-w)/4)]",
      "max-w-[calc(var(--drawer-w)/2)]",
      "overflow-hidden",
      "text-ellipsis",
    );

    const nameCell = screen.getAllByRole("cell")[0];
    expect(nameCell).toHaveClass(
      "min-w-[calc(var(--drawer-w)/4)]",
      "max-w-[calc(var(--drawer-w)/2)]",
      "overflow-hidden",
      "text-ellipsis",
    );
    expect(nameCell.firstElementChild?.firstElementChild).toHaveClass(
      "min-w-0",
      "truncate",
    );
  });

  it("gives identity columns a wider band and lets a column override it", () => {
    render(
      <DataTable
        ariaLabel="People"
        columns={[
          identityColumn<Person, string>({
            id: "name",
            header: "Name",
            accessor: (row) => row.name,
          }) as ColumnDef<Person>,
          {
            accessorKey: "status",
            header: "Status",
            meta: { minWidth: "9rem", width: "12rem" },
          },
        ]}
        data={[
          { id: "person-1", name: "Marcus Vaughn (demo)", status: "Active" },
        ]}
        emptyState={<div>No people match this view.</div>}
        getRowId={(row) => row.id}
      />,
    );

    const nameHeader = screen.getByRole("columnheader", { name: /Name/ });
    expect(nameHeader).toHaveClass(
      "min-w-[220px]",
      "max-w-[calc(var(--drawer-w)*0.75)]",
    );

    // A per-column width beats the cellKind default, because inline styles win over the classes.
    const statusHeader = screen.getByRole("columnheader", { name: /Status/ });
    expect(statusHeader.getAttribute("style")).toContain("width: 12rem");
    expect(statusHeader.getAttribute("style")).toContain("max-width: 12rem");
    expect(screen.getAllByRole("cell")[1].getAttribute("style")).toContain(
      "width: 12rem",
    );
  });

  it("gives sortable and plain headers one type treatment, with the chevron as the only difference", () => {
    renderTable([{ id: "person-1", name: "Priya", status: "Active" }]);

    const trigger = screen.getByRole("button", { name: "Name column options" });
    // Inherit, rather than restating ink sentence-case: two treatments in one header row made
    // sortability look like a property of the data.
    expect(trigger).toHaveClass("text-inherit", "uppercase");
    expect(trigger.querySelector("svg")).toHaveClass("opacity-0");
  });

  it("opens on the sort a page hands it, so the indicator names the ordering column", () => {
    render(
      <DataTable
        ariaLabel="People"
        columns={columns}
        data={[
          { id: "person-a", name: "Ana", status: "Active" },
          { id: "person-z", name: "Zoe", status: "Paused" },
        ]}
        emptyState={<div>No people match this view.</div>}
        getRowId={(row) => row.id}
        initialSorting={[{ id: "name", desc: true }]}
      />,
    );

    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    expect(screen.getAllByRole("row")[1]).toHaveAttribute(
      "data-row-id",
      "person-z",
    );
  });

  it("lets a short result set end at its last row instead of stretching", () => {
    renderTable([{ id: "person-1", name: "Priya", status: "Active" }]);

    // The frame takes the page's height; the card inside it is only as tall as its rows.
    const card = document.querySelector(
      '[data-slot="data-table"]',
    ) as HTMLElement;
    const frame = card.parentElement as HTMLElement;
    expect(frame).toHaveAttribute("data-slot", "data-table-frame");
    expect(card).toHaveClass("max-h-full");
    expect(card.className).not.toContain("flex-1");
  });

  it("drives a facet from a page's own value when the server does the paging", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        data={[{ id: "person-a", name: "Ana", status: "Active" }]}
        emptyState={<div>No people match this view.</div>}
        facets={[
          {
            title: "Scope",
            options: [
              { label: "Platform", value: "platform" },
              { label: "Client account", value: "tenant" },
            ],
            onChange,
            value: ["platform"],
          },
        ]}
        getRowId={(row) => row.id}
      />,
    );

    // The chosen value comes from the page, not from column state.
    const chip = screen.getByRole("button", { name: /Scope/ });
    expect(chip).toHaveTextContent("Platform");

    await user.click(chip);
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: "Client account" }),
    );
    expect(onChange).toHaveBeenCalledWith(["platform", "tenant"]);
  });

  it("uses getRowId so duplicate display names remain distinct", () => {
    renderTable([
      { id: "person-a", name: "Alex Morgan", status: "Active" },
      { id: "person-b", name: "Alex Morgan", status: "Paused" },
    ]);

    expect(screen.getAllByText("Alex Morgan")).toHaveLength(2);
    expect(
      document.querySelector('[data-row-id="person-a"]'),
    ).toBeInTheDocument();
    expect(
      document.querySelector('[data-row-id="person-b"]'),
    ).toBeInTheDocument();
  });

  it("gives row opening the same keyboard path as pointer opening", async () => {
    const user = userEvent.setup();
    const onRowOpen = vi.fn();
    render(
      <DataTable
        columns={columns}
        data={[{ id: "person-1", name: "Priya", status: "Active" }]}
        emptyState={<div>No people match this view.</div>}
        getRowId={(row) => row.id}
        onRowOpen={onRowOpen}
      />,
    );

    const openButton = screen.getByRole("button", { name: "Priya" });
    openButton.focus();
    await user.keyboard("{Enter}");
    expect(onRowOpen).toHaveBeenCalledWith({
      id: "person-1",
      name: "Priya",
      status: "Active",
    });
  });

  it("requires a safe label for every hideable functional header", () => {
    const technicalColumns: ColumnDef<Person>[] = [
      {
        accessorKey: "name",
        header: "Name",
      },
      {
        accessorKey: "status",
        header: () => <span>Status</span>,
        id: "internal_status_code",
      },
    ];

    expect(() =>
      render(
        <DataTable
          columns={technicalColumns}
          data={[{ id: "person-1", name: "Priya", status: "Active" }]}
          emptyState={<div>No people match this view.</div>}
          getRowId={(row) => row.id}
        />,
      ),
    ).toThrow(
      "Every hideable column with a functional header requires a safe meta.label.",
    );
  });

  it("uses a functional header's safe label without exposing its technical id", async () => {
    const user = userEvent.setup();
    const technicalColumns: ColumnDef<Person>[] = [
      {
        accessorKey: "name",
        header: "Name",
      },
      {
        accessorKey: "status",
        header: () => <span>Lifecycle</span>,
        id: "lifecycle_code",
        meta: { label: "Lifecycle" },
      },
    ];
    render(
      <DataTable
        columns={technicalColumns}
        data={[{ id: "person-1", name: "Priya", status: "Active" }]}
        emptyState={<div>No people match this view.</div>}
        getRowId={(row) => row.id}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Display" }));
    const menu = await screen.findByRole("menu");
    expect(
      within(menu).queryByText("internal_status_code"),
    ).not.toBeInTheDocument();
    expect(within(menu).getByText("Lifecycle")).toBeVisible();
  });

  it("lets a state column carry an absence, which renders quietly and still sorts", () => {
    type StatefulPerson = Person & { state: StateBadgeRendererProps };
    const columnsWithState = [
      stateColumn({
        accessor: (person: StatefulPerson) => person.state,
        header: "Scheduled change",
        id: "state",
        StateBadge,
      }),
    ] as ColumnDef<StatefulPerson>[];
    render(
      <DataTable
        columns={columnsWithState}
        data={[
          {
            id: "person-a",
            name: "Ana",
            status: "active",
            state: {
              kind: "none",
              label: "No scheduled change",
              tone: "neutral",
            },
          },
        ]}
        emptyState={<div>No people match this view.</div>}
        getRowId={(row) => row.id}
      />,
    );

    const badge = screen.getByText("No scheduled change");
    expect(badge).toHaveAttribute("data-kind", "none");
  });

  it("sorts state columns by their displayed label", async () => {
    const user = userEvent.setup();
    type StatefulPerson = Person & { state: StateBadgeRendererProps };
    const StateBadge = ({ label }: StateBadgeRendererProps) => (
      <span>{label}</span>
    );
    const stateColumns = [
      identityColumn({
        accessor: (person: StatefulPerson) => person.name,
        header: "Name",
        id: "name",
      }),
      stateColumn({
        accessor: (person: StatefulPerson) => person.state,
        header: "State",
        id: "state",
        StateBadge,
      }),
    ] as ColumnDef<StatefulPerson>[];
    render(
      <DataTable
        columns={stateColumns}
        data={[
          {
            id: "person-z",
            name: "Zoe",
            status: "active",
            state: { kind: "tag", label: "Middle", tone: "neutral" },
          },
          {
            id: "person-a",
            name: "Ana",
            status: "active",
            state: { kind: "tag", label: "Alpha", tone: "neutral" },
          },
          {
            id: "person-m",
            name: "Mina",
            status: "active",
            state: { kind: "tag", label: "Zebra", tone: "neutral" },
          },
        ]}
        emptyState={<div>No people match this view.</div>}
        getRowId={(row) => row.id}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "State column options" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Sort ascending" }),
    );
    expect(screen.getByRole("columnheader", { name: /State/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(
      rows.map((row) => within(row).getAllByRole("cell")[1]?.textContent),
    ).toEqual(["Alpha", "Middle", "Zebra"]);
  });

  it("delegates cursor sorting without reordering the loaded page", async () => {
    const user = userEvent.setup();
    const onSortingChange = vi.fn();

    function CursorTable() {
      const [sorting, setSorting] = useState<SortingState>([]);
      return (
        <DataTable
          columns={columns}
          data={[
            { id: "person-z", name: "Zoe", status: "Active" },
            { id: "person-a", name: "Ana", status: "Paused" },
          ]}
          emptyState={<div>No people match this view.</div>}
          getRowId={(row) => row.id}
          pagination={{
            hasNextPage: true,
            hasPreviousPage: false,
            mode: "cursor",
            onNextPage: vi.fn(),
            onPreviousPage: vi.fn(),
            onSortingChange: (updater) => {
              onSortingChange(updater);
              setSorting(updater);
            },
            pageIndex: 0,
            pageSize: 2,
            sorting,
            totalRows: 4,
          }}
        />
      );
    }

    render(<CursorTable />);
    await user.click(
      screen.getByRole("button", { name: "Name column options" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Sort ascending" }),
    );

    expect(onSortingChange).toHaveBeenCalledOnce();
    expect(
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).getAllByRole("cell")[0]?.textContent),
    ).toEqual(["Zoe", "Ana"]);
  });
});

describe("DataTable toolbar", () => {
  const people: Person[] = [
    { id: "person-a", name: "Ana", status: "Active" },
    { id: "person-z", name: "Zoe", status: "Paused" },
  ];

  const searchableColumns: ColumnDef<Person>[] = [
    { accessorKey: "name", header: "Name" },
    { accessorKey: "status", header: "Status", filterFn: "arrIncludesSome" },
  ];

  it("filters rows from the search field inside the table", async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        columns={searchableColumns}
        data={people}
        emptyState={<div>No people match this view.</div>}
        getRowId={(row) => row.id}
        search={{ columnId: "name", placeholder: "Search people" }}
      />,
    );

    await user.type(screen.getByPlaceholderText("Search people"), "Ana");

    expect(screen.getByText("Ana")).toBeVisible();
    expect(screen.queryByText("Zoe")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Reset/ }));
    expect(screen.getByText("Zoe")).toBeVisible();
  });

  it("filters rows from a faceted filter and clears with Reset", async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        columns={searchableColumns}
        data={people}
        emptyState={<div>No people match this view.</div>}
        facets={[
          {
            columnId: "status",
            title: "Status",
            options: [
              { label: "Active", value: "Active" },
              { label: "Paused", value: "Paused" },
            ],
          },
        ]}
        getRowId={(row) => row.id}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Status" }));
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: "Active" }),
    );

    expect(screen.getByText("Ana")).toBeVisible();
    expect(screen.queryByText("Zoe")).not.toBeInTheDocument();
  });

  it("hides a column from Display and keeps the export menu on the same row", async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        columns={searchableColumns}
        data={people}
        emptyState={<div>No people match this view.</div>}
        exportResource={{
          filename: "people",
          mode: "local",
          rows: [{ name: "Ana" }],
        }}
        getRowId={(row) => row.id}
      />,
    );

    const toolbar = document.querySelector(
      '[data-slot="data-table-toolbar"]',
    ) as HTMLElement;
    expect(
      within(toolbar).getByRole("button", { name: "Export table" }),
    ).toBeVisible();

    await user.click(within(toolbar).getByRole("button", { name: "Display" }));
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: "Status" }),
    );

    expect(
      screen.queryByRole("columnheader", { name: /Status/ }),
    ).not.toBeInTheDocument();
  });

  it("ships meta.defaultHidden columns behind Display rather than on the default view", async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        columns={[
          { accessorKey: "name", header: "Name" },
          {
            accessorKey: "status",
            header: "Status",
            meta: { defaultHidden: true },
          },
        ]}
        data={people}
        emptyState={<div>No people match this view.</div>}
        getRowId={(row) => row.id}
      />,
    );

    expect(
      screen.queryByRole("columnheader", { name: /Status/ }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Display" }));
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: "Status" }),
    );

    expect(screen.getByRole("columnheader", { name: /Status/ })).toBeVisible();
  });

  it("sends the density choice to the shell rather than keeping its own", async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        columns={searchableColumns}
        data={people}
        emptyState={<div>No people match this view.</div>}
        getRowId={(row) => row.id}
      />,
    );

    // One source of truth: the table writes no density of its own.
    expect(
      document.querySelector('[data-slot="data-table"]'),
    ).not.toHaveAttribute("data-density");

    await user.click(screen.getByRole("button", { name: "Display" }));
    await user.click(await screen.findByRole("menuitem", { name: "Compact" }));

    expect(setDensity).toHaveBeenCalledWith("dense");
  });
});

describe("DataTable toolbar slots", () => {
  const people: Person[] = [{ id: "person-a", name: "Ana", status: "Active" }];

  it("puts toolbarEnd controls beside Display and Export, not on the left", async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        columns={columns}
        data={people}
        displayOptions={
          <button role="menuitem" type="button">
            Grouped event feed
          </button>
        }
        emptyState={<div>No people match this view.</div>}
        exportResource={{
          filename: "people",
          mode: "local",
          rows: [{ name: "Ana" }],
        }}
        getRowId={(row) => row.id}
        toolbar={<button type="button">View switch</button>}
        toolbarEnd={<button type="button">Page export</button>}
      />,
    );

    const endGroup = document
      .querySelector('[data-slot="data-table-toolbar"] .ml-auto')
      ?.parentElement?.querySelector(".ml-auto") as HTMLElement;
    expect(
      within(endGroup).getByRole("button", { name: "Page export" }),
    ).toBeVisible();
    expect(
      within(endGroup).getByRole("button", { name: "Display" }),
    ).toBeVisible();
    expect(
      within(endGroup).getByRole("button", { name: "Export table" }),
    ).toBeVisible();
    expect(
      within(endGroup).queryByRole("button", { name: "View switch" }),
    ).toBeNull();

    await user.click(within(endGroup).getByRole("button", { name: "Display" }));
    expect(
      await screen.findByRole("menuitem", { name: "Grouped event feed" }),
    ).toBeVisible();
  });
});

describe("DataTableToolbarShell", () => {
  it("renders the toolbar row for a surface that is not a table", () => {
    render(
      <DataTableToolbarShell>
        <button type="button">Layout</button>
      </DataTableToolbarShell>,
    );

    const shell = document.querySelector('[data-slot="data-table-toolbar"]');
    expect(shell).toBeVisible();
    expect(
      within(shell as HTMLElement).getByRole("button", { name: "Layout" }),
    ).toBeVisible();
  });
});

describe("DataTable rows", () => {
  const people: Person[] = [
    { id: "person-a", name: "Ana", status: "Active" },
    { id: "person-t", name: "Test coach", status: "Active" },
  ];

  it("opens a record from a row click and from the kebab", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    const reassign = vi.fn();
    render(
      <DataTable
        columns={columns}
        data={[people[0] as Person]}
        emptyState={<div>No people match this view.</div>}
        getRowId={(row) => row.id}
        onRowClick={onRowClick}
        rowActions={() => [
          { id: "reassign", label: "Reassign owner", onSelect: reassign },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Ana" }));
    expect(onRowClick).toHaveBeenCalledWith(people[0]);

    await user.click(screen.getByRole("button", { name: "Row actions" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Reassign owner" }),
    );
    expect(reassign).toHaveBeenCalledOnce();
  });

  it("drops the per-row label when every row on screen is seeded", () => {
    render(
      <DataTable
        columns={columns}
        data={[people[1] as Person]}
        emptyState={<div>No people match this view.</div>}
        getRowId={(row) => row.id}
        testRow={() => true}
      />,
    );

    expect(screen.queryByText("Demo data")).not.toBeInTheDocument();
    expect(document.querySelector('[data-slot="data-table"]')).toHaveAttribute(
      "data-all-test-rows",
    );
  });

  it("keeps a press on the checkbox or the kebab off the row", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(
      <DataTable
        columns={columns}
        data={[people[0] as Person]}
        emptyState={<div>No people match this view.</div>}
        getRowId={(row) => row.id}
        onRowClick={onRowClick}
        rowActions={() => [{ id: "reassign", label: "Reassign owner" }]}
        selection={{ actions: [], onBulk: () => {} }}
      />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Select row 1" }));
    await user.click(screen.getByRole("button", { name: "Row actions" }));
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("labels seeded rows on screen", () => {
    render(
      <DataTable
        columns={columns}
        data={people}
        emptyState={<div>No people match this view.</div>}
        getRowId={(row) => row.id}
        testRow={(row) => row.id === "person-t"}
      />,
    );

    const label = screen.getByText("Demo data");
    expect(label).toBeVisible();
    expect(label.closest("tr")).toHaveAttribute("data-row-id", "person-t");
  });

  it("shows the failure state instead of rows when a read fails", () => {
    const retry = vi.fn();
    render(
      <DataTable
        columns={columns}
        data={[]}
        emptyState={<div>No people match this view.</div>}
        error={{
          title: "The client book could not be read.",
          body: "Try again.",
          retry,
        }}
        getRowId={(row) => row.id}
        loading={false}
      />,
    );

    expect(
      screen.getByText("The client book could not be read."),
    ).toBeVisible();
    expect(
      screen.queryByText("No people match this view."),
    ).not.toBeInTheDocument();
  });
});

describe("ExportMenu", () => {
  it("opens as a menu and closes on Escape and outside click", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <ExportMenu filename="people" mode="local" rows={[{ name: "Priya" }]} />
        <button type="button">Outside</button>
      </div>,
    );

    const trigger = screen.getByRole("button", { name: "Export table" });
    await user.click(trigger);
    expect(await screen.findByRole("menu")).toBeVisible();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );

    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Outside" }));
    await waitFor(() =>
      expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
    );
  });

  it("accepts printable characters in the required export reason", async () => {
    const user = userEvent.setup();
    render(
      <ExportMenu
        filename="audit-log"
        mode="server"
        query={{ reason: "", order: "at_desc" }}
        resource="audit-log"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Export table" }));
    const reasonInput = screen.getByRole("textbox", { name: "Export reason" });
    await user.type(reasonInput, "Quarterly access review");

    expect(reasonInput).toHaveValue("Quarterly access review");
    expect(
      screen.getAllByText(AUDIT_ACTIONS["platform_export.started"].microcopy),
    ).toHaveLength(2);
    expect(
      screen.getByRole("menuitem", { name: /Download CSV/ }),
    ).not.toHaveAttribute("aria-disabled", "true");
  });

  it("serializes only allowlisted server query keys", async () => {
    const user = userEvent.setup();
    // The menu asks the route for the export and inspects the answer before saving anything, so
    // the query it serializes now shows up on the fetch rather than on an anchor's href.
    const fetchMock = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(async () => new Response("", {
      status: 200,
      headers: { "Content-Type": "text/csv; charset=utf-8" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const createUrlSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:data-table-test");
    const revokeUrlSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    const queryWithUnexpectedKey = {
      action: "contact.delete",
      reason: "  Quarterly access review  ",
      unexpectedInternalKey: "must-not-leak",
    };
    render(
      <ExportMenu
        filename="audit-log"
        mode="server"
        query={queryWithUnexpectedKey as never}
        resource="audit-log"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Export table" }));
    await user.click(
      await screen.findByRole("menuitem", { name: /Download CSV/ }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const href = new URL(String(fetchMock.mock.calls[0][0]), "http://localhost");
    expect(href.searchParams.get("action")).toBe("contact.delete");
    expect(href.searchParams.get("reason")).toBe("Quarterly access review");
    expect(href.searchParams.has("unexpectedInternalKey")).toBe(false);
    clickSpy.mockRestore();
    createUrlSpy.mockRestore();
    revokeUrlSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("keys a reason draft to the resource, filename, and query", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ExportMenu
        filename="audit-log"
        mode="server"
        query={{ action: "contact.delete", reason: "" }}
        resource="audit-log"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Export table" }));
    await user.type(
      screen.getByRole("textbox", { name: "Export reason" }),
      "First reason",
    );

    rerender(
      <ExportMenu
        filename="audit-log"
        mode="server"
        query={{ action: "contact.merged", reason: "" }}
        resource="audit-log"
      />,
    );
    expect(screen.getByRole("textbox", { name: "Export reason" })).toHaveValue(
      "",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Export reason" }),
      "Second reason",
    );

    rerender(
      <ExportMenu
        filename="audit-log-renamed"
        mode="server"
        query={{ action: "contact.merged", reason: "" }}
        resource="audit-log"
      />,
    );
    expect(screen.getByRole("textbox", { name: "Export reason" })).toHaveValue(
      "",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Export reason" }),
      "Third reason",
    );

    rerender(
      <ExportMenu
        filename="billing-tiers"
        mode="server"
        query={{ order: "created_desc", reason: "" }}
        resource="billing-tiers"
      />,
    );
    expect(screen.getByRole("textbox", { name: "Export reason" })).toHaveValue(
      "",
    );
  });

  it("shows tenant registry microcopy for server exports without a platform reason", async () => {
    const user = userEvent.setup();
    render(
      <ExportMenu
        filename="contacts"
        mode="server"
        query={{ status: "active" }}
        resource="contacts"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Export table" }));
    expect(
      screen.getAllByText(AUDIT_ACTIONS["export.started"].microcopy),
    ).toHaveLength(2);
  });
});

describe("DataTable on the canvas", () => {
  const people: Person[] = [{ id: "person-a", name: "Ana", status: "Active" }];

  it("sits on the page canvas with a tinted header band instead of a card", () => {
    renderTable(people);

    const table = document.querySelector(
      '[data-slot="data-table"]',
    ) as HTMLElement;
    expect(table.className).toBe("flex max-h-full min-h-0 min-w-0 flex-col");

    // The tint is the only thing separating header from rows now, so it has to be on the `th`.
    const header = screen.getByRole("columnheader", { name: /Name/ });
    expect(header).toHaveClass(
      "bg-[var(--band)]",
      "h-[var(--d-th)]",
      "uppercase",
    );
    expect(header).toHaveClass(
      "text-[length:var(--t-label)]",
      "font-[var(--t-label-w)]",
      "text-[var(--muted)]",
    );

    const cell = screen.getAllByRole("cell")[0] as HTMLElement;
    expect(cell).toHaveClass("h-[var(--d-row)]", "text-[12.5px]");
  });

  it("names an absent value in the same quiet words a quiet cell uses", () => {
    render(
      <DataTable
        columns={[
          { accessorKey: "name", header: "Name" },
          dateColumn<Person>({
            accessor: () => null,
            emptyLabel: "Never",
            header: "Last message",
            id: "last-message",
          }) as ColumnDef<Person>,
          numberColumn<Person>({
            accessor: () => null,
            emptyLabel: "Not connected",
            header: "Threads",
            id: "threads",
          }) as ColumnDef<Person>,
        ]}
        data={people}
        emptyState={<div>No people match this view.</div>}
        getRowId={(row) => row.id}
      />,
    );

    const absent = document.querySelectorAll('[data-slot="absent-value"]');
    expect(Array.from(absent).map((node) => node.textContent)).toEqual([
      "Never",
      "Not connected",
    ]);
    // The upright muted treatment is `CellQuiet`'s, and the two share it on purpose: an italic
    // absence beside an upright one on the same row is two idioms for one idea, and the italic
    // overhang clipped its own last glyph inside the cell's `truncate` span.
    for (const node of absent) {
      expect(node).toHaveClass("text-[color:var(--muted)]");
      expect(node).not.toHaveClass("italic");
    }
  });

  it("refuses a placeholder glyph or a bare zero where a word belongs", () => {
    expect(() => absentValue("—")).toThrow(/must name what did not happen/);
    expect(() => absentValue("0")).toThrow(/must name what did not happen/);
    expect(absentValue("never")).toBeTruthy();
  });

  it("puts a muted secondary beside the identity name at the same weight contrast", () => {
    render(
      <DataTable
        columns={[
          identityColumn<Person, string>({
            accessor: (row) => row.name,
            header: "Name",
            id: "name",
            secondary: (row) => row.status,
          }) as ColumnDef<Person>,
        ]}
        data={people}
        emptyState={<div>No people match this view.</div>}
        getRowId={(row) => row.id}
      />,
    );

    const name = document.querySelector(
      '[data-slot="identity-name"]',
    ) as HTMLElement;
    expect(name).toHaveTextContent("Ana");
    // 600, the one identity weight, shared with CellTwoLine and GridTableIdentity. What this
    // pins is the *contrast* between the name and the secondary beside it, not the literal step.
    expect(name).toHaveClass("font-[600]", "text-[var(--ink)]");

    const secondary = document.querySelector(
      '[data-slot="identity-secondary"]',
    ) as HTMLElement;
    expect(secondary).toHaveTextContent("Active");
    expect(secondary).toHaveClass("text-[var(--muted)]");
  });
});

describe("DataTable row actions reveal", () => {
  const people: Person[] = [{ id: "person-a", name: "Ana", status: "Active" }];

  it("holds the kebab back until the row is hovered or focused within", () => {
    render(
      <DataTable
        ariaLabel="People"
        columns={columns}
        data={people}
        emptyState={<div>No people match this view.</div>}
        getRowId={(row) => row.id}
        rowActions={() => [{ id: "reassign", label: "Reassign owner" }]}
      />,
    );

    const reveal = document.querySelector(
      '[data-slot="data-table-row-actions-cell"]',
    ) as HTMLElement;
    expect(reveal).toHaveClass("opacity-0");
    // Hover is the pointer path; focus-within is the keyboard path. Both have to be present, or
    // the kebab is a pointer-only control.
    expect(reveal).toHaveClass(
      "group-hover/row:opacity-100",
      "group-focus-within/row:opacity-100",
      "has-[[data-popup-open]]:opacity-100",
    );
    expect(reveal.closest("tr")).toHaveClass("group/row");
  });

  it("still reaches the kebab by keyboard and opens it there", async () => {
    const user = userEvent.setup();
    const reassign = vi.fn();
    render(
      <DataTable
        ariaLabel="People"
        columns={columns}
        data={people}
        emptyState={<div>No people match this view.</div>}
        getRowId={(row) => row.id}
        rowActions={() => [
          { id: "reassign", label: "Reassign owner", onSelect: reassign },
        ]}
      />,
    );

    // Tab from the scroll region through the two sortable headers and onto the kebab: the reveal
    // is opacity, not display, so the button stays in the tab order and in the accessibility tree.
    // jsdom applies no Tailwind, so this test alone cannot tell opacity from display -- the
    // `opacity-0` assertion in the sibling test above is the half that pins the mechanism.
    screen.getByRole("region", { name: "People" }).focus();
    await user.tab();
    await user.tab();
    await user.tab();

    const kebab = screen.getByRole("button", { name: "Row actions" });
    expect(document.activeElement).toBe(kebab);

    await user.keyboard("{Enter}");
    await user.click(
      await screen.findByRole("menuitem", { name: "Reassign owner" }),
    );
    expect(reassign).toHaveBeenCalledOnce();
  });
});

describe("DataTable grouping", () => {
  const fleet: Person[] = [
    { id: "person-a", name: "Ana", status: "Live" },
    { id: "person-m", name: "Mina", status: "Vetting" },
    { id: "person-z", name: "Zoe", status: "Live" },
    { id: "person-q", name: "Quinn", status: "Retired" },
  ];

  function groupLabels() {
    return Array.from(
      document.querySelectorAll('[data-slot="data-table-group-row"]'),
    ).map((row) => row.getAttribute("data-group-id"));
  }

  function domOrder() {
    return Array.from(document.querySelectorAll("tbody tr")).map(
      (row) =>
        row.getAttribute("data-group-id") ?? row.getAttribute("data-row-id"),
    );
  }

  it("bands rows under a group header that names the band and counts it", () => {
    render(
      <DataTable
        columns={columns}
        data={fleet}
        emptyState={<div>No people match this view.</div>}
        getRowId={(row) => row.id}
        groupBy={(row) => row.status}
      />,
    );

    expect(groupLabels()).toEqual(["Live", "Vetting", "Retired"]);
    expect(domOrder()).toEqual([
      "Live",
      "person-a",
      "person-z",
      "Vetting",
      "person-m",
      "Retired",
      "person-q",
    ]);

    const live = document.querySelector(
      '[data-group-id="Live"]',
    ) as HTMLElement;
    expect(within(live).getByText("Live")).toBeVisible();
    expect(
      within(live).getByText("2", {
        selector: '[data-slot="data-table-group-count"]',
      }),
    ).toBeVisible();
    // A group header spans the grid rather than sitting in one column.
    expect(within(live).getByRole("columnheader")).toHaveAttribute(
      "colspan",
      "2",
    );
  });

  it("takes band order and band labels from the groups a page declares", () => {
    render(
      <DataTable
        columns={columns}
        data={fleet}
        emptyState={<div>No people match this view.</div>}
        getRowId={(row) => row.id}
        groupBy={(row) => row.status}
        groups={[
          { id: "Vetting", label: "Registering with carriers" },
          { id: "Paused", label: "Paused" },
          { id: "Live", label: "Answering now" },
        ]}
      />,
    );

    // Declared order wins, an undeclared key follows, and a declared band with no rows on this
    // page does not draw an empty header.
    expect(groupLabels()).toEqual(["Vetting", "Live", "Retired"]);
    const vetting = document.querySelector(
      '[data-group-id="Vetting"]',
    ) as HTMLElement;
    expect(
      within(vetting).getByText("Registering with carriers"),
    ).toBeVisible();
  });

  it("collects the rows no group claims into a trailing band", () => {
    render(
      <DataTable
        columns={columns}
        data={fleet}
        emptyState={<div>No people match this view.</div>}
        getRowId={(row) => row.id}
        groupBy={(row) => (row.status === "Live" ? "Live" : null)}
        ungroupedLabel="Not answering yet"
      />,
    );

    expect(groupLabels()).toEqual(["Live", "__ungrouped__"]);
    expect(domOrder()).toEqual([
      "Live",
      "person-a",
      "person-z",
      "__ungrouped__",
      "person-m",
      "person-q",
    ]);
    const trailing = document.querySelector(
      '[data-group-id="__ungrouped__"]',
    ) as HTMLElement;
    expect(within(trailing).getByText("Not answering yet")).toBeVisible();
  });

  it("bands from explicit predicates when a page passes groups alone", () => {
    render(
      <DataTable
        columns={columns}
        data={fleet}
        emptyState={<div>No people match this view.</div>}
        getRowId={(row) => row.id}
        groups={[
          {
            id: "answering",
            includes: (row) => row.status === "Live",
            label: "Answering now",
          },
          {
            id: "waiting",
            includes: (row) => row.status === "Vetting",
            label: "Registering with carriers",
          },
        ]}
        ungroupedLabel="Everything else"
      />,
    );

    expect(groupLabels()).toEqual(["answering", "waiting", "__ungrouped__"]);
    expect(domOrder()).toEqual([
      "answering",
      "person-a",
      "person-z",
      "waiting",
      "person-m",
      "__ungrouped__",
      "person-q",
    ]);
  });

  it("regroups the sorted page, so the sort still orders both the bands and their rows", async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        columns={columns}
        data={fleet}
        emptyState={<div>No people match this view.</div>}
        getRowId={(row) => row.id}
        groupBy={(row) => row.status}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Name column options" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Sort ascending" }),
    );

    // Ana, Mina, Quinn, Zoe by name: the first row of each band decides the band order, and Zoe
    // rejoins Ana under Live.
    expect(domOrder()).toEqual([
      "Live",
      "person-a",
      "person-z",
      "Vetting",
      "person-m",
      "Retired",
      "person-q",
    ]);

    await user.click(
      screen.getByRole("button", { name: "Name column options" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Sort descending" }),
    );
    expect(domOrder()).toEqual([
      "Live",
      "person-z",
      "person-a",
      "Retired",
      "person-q",
      "Vetting",
      "person-m",
    ]);
  });

  it("keeps selection and export working while rows are banded", async () => {
    const user = userEvent.setup();
    const onBulk = vi.fn();
    render(
      <DataTable
        columns={columns}
        data={fleet}
        emptyState={<div>No people match this view.</div>}
        exportResource={{
          filename: "people",
          mode: "local",
          rows: [{ name: "Ana" }],
        }}
        getRowId={(row) => row.id}
        groupBy={(row) => row.status}
        selection={{
          actions: [{ id: "pause", label: "Pause agents" }],
          onBulk,
        }}
      />,
    );

    // The select column widens the grid, and the group header has to span it too.
    const live = document.querySelector(
      '[data-group-id="Live"]',
    ) as HTMLElement;
    expect(within(live).getByRole("columnheader")).toHaveAttribute(
      "colspan",
      "3",
    );

    await user.click(screen.getByRole("checkbox", { name: "Select row 1" }));
    expect(screen.getByText("1 selected")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Pause agents" }));
    expect(onBulk).toHaveBeenCalledWith(["person-a"]);

    expect(screen.getByRole("button", { name: "Export table" })).toBeVisible();
  });

  it("renders a summary row but does not count it in the footer range", () => {
    render(
      <DataTable
        ariaLabel="People"
        columns={columns}
        data={[
          { id: "person-1", name: "Priya", status: "Active" },
          { id: "person-2", name: "Ana", status: "Paused" },
          { id: "total", name: "Total", status: "" },
        ]}
        emptyState={<div>No people match this view.</div>}
        getRowId={(row) => row.id}
        rowLabel={{ singular: "person", plural: "people" }}
        summaryRow={(row) => row.id === "total"}
      />,
    );

    expect(screen.getByText("Total")).toBeVisible();
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(screen.getByText(/Showing 1–2 of 2 people/u)).toBeVisible();
  });

  it("reads a lone summary row as no rows at all", () => {
    render(
      <DataTable
        ariaLabel="People"
        columns={columns}
        data={[{ id: "total", name: "Total", status: "" }]}
        emptyState={<div>No people match this view.</div>}
        getRowId={(row) => row.id}
        rowLabel={{ singular: "person", plural: "people" }}
        summaryRow={(row) => row.id === "total"}
      />,
    );

    expect(screen.getByText("No people")).toBeVisible();
  });
});
