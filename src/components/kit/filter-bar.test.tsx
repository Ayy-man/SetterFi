import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  pathname: "/coach/conversations",
  replace: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => navigation.searchParams,
}));

import { FilterBar, type FacetGroup, type ViewDef } from "@/components/kit/filter-bar";
import { DropdownMenuCheckboxItem } from "@/components/ui/dropdown-menu";

const views: readonly ViewDef[] = [
  { key: "all", label: "All", count: 38 },
  { key: "needs-you", label: "Needs you", count: 4 },
];

const facets: readonly FacetGroup[] = [
  {
    key: "channel",
    label: "Channel",
    multi: true,
    options: [
      { value: "all", label: "All", count: 38 },
      { value: "instagram", label: "Instagram", count: 16 },
      { value: "sms", label: "Text messages (SMS)", count: 11 },
    ],
  },
  {
    key: "stage",
    label: "Stage",
    multi: false,
    options: [
      { value: "qualifying", label: "Qualification Active" },
      { value: "booked", label: "Booked" },
    ],
  },
];

function renderFilterBar() {
  return render(
    <FilterBar
      displayOptions={
        <DropdownMenuCheckboxItem checked>Compact rows</DropdownMenuCheckboxItem>
      }
      facets={facets}
      searchPlaceholder="Search conversations"
      views={views}
    />,
  );
}

describe("FilterBar", () => {
  beforeEach(() => {
    navigation.pathname = "/coach/conversations";
    navigation.replace.mockReset();
    navigation.searchParams = new URLSearchParams();
  });

  it("renders at most one control labelled All", () => {
    renderFilterBar();

    expect(screen.getAllByRole("button", { name: "All" })).toHaveLength(1);
  });

  it("applies two facets, renders two chips, and offers Clear all", async () => {
    const user = userEvent.setup();
    const view = renderFilterBar();

    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByRole("checkbox", { name: "Channel: Instagram" }));
    await user.click(screen.getByRole("checkbox", { name: "Stage: Booked" }));

    navigation.searchParams = new URLSearchParams("channel=instagram&stage=booked");
    view.rerender(
      <FilterBar
        displayOptions={
          <DropdownMenuCheckboxItem checked>Compact rows</DropdownMenuCheckboxItem>
        }
        facets={facets}
        searchPlaceholder="Search conversations"
        views={views}
      />,
    );

    const chips = screen.getByLabelText("Applied filters");
    expect(within(chips).getByText("Instagram")).toBeInTheDocument();
    expect(within(chips).getByText("Booked")).toBeInTheDocument();
    expect(within(chips).getAllByRole("button", { name: /Remove .* filter/ })).toHaveLength(2);
    expect(within(chips).getByRole("button", { name: "Clear all" })).toBeInTheDocument();
    expect(navigation.replace).toHaveBeenLastCalledWith(
      "/coach/conversations?channel=instagram&stage=booked",
      { scroll: false },
    );
  });

  it("keeps consecutive selections in the same multi-select group", async () => {
    const user = userEvent.setup();
    renderFilterBar();

    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByRole("checkbox", { name: "Channel: Instagram" }));
    await user.click(screen.getByRole("checkbox", { name: "Channel: Text messages (SMS)" }));

    expect(navigation.replace).toHaveBeenLastCalledWith(
      "/coach/conversations?channel=instagram&channel=sms",
      { scroll: false },
    );
  });

  it("keeps display options outside the Filters popover", async () => {
    const user = userEvent.setup();
    const view = renderFilterBar();

    await user.click(screen.getByRole("button", { name: "Filters" }));
    const filtersDialog = await screen.findByRole("dialog", { name: "Filters" });
    expect(within(filtersDialog).queryByText("Compact rows")).not.toBeInTheDocument();

    view.unmount();
    renderFilterBar();
    fireEvent.click(screen.getByRole("button", { name: "Display" }));
    expect(screen.getByRole("menu", { name: "Display" })).toHaveTextContent(
      "Compact rows",
    );
  });

  it("follows new search params on rerender", () => {
    navigation.searchParams = new URLSearchParams("channel=instagram");
    const view = renderFilterBar();
    expect(screen.getByLabelText("Applied filters")).toHaveTextContent("Instagram");

    navigation.searchParams = new URLSearchParams("stage=booked");
    view.rerender(
      <FilterBar facets={facets} searchPlaceholder="Search conversations" views={views} />,
    );

    expect(screen.getByLabelText("Applied filters")).toHaveTextContent("Booked");
    expect(screen.getByLabelText("Applied filters")).not.toHaveTextContent("Instagram");
  });

  it("clears the active view, search, and facets from the URL", async () => {
    navigation.searchParams = new URLSearchParams(
      "view=needs-you&q=price&channel=sms&sort=oldest&cols=name&density=compact&cursor=next",
    );
    const user = userEvent.setup();
    const view = renderFilterBar();

    await user.click(screen.getByRole("button", { name: "Clear all" }));

    expect(navigation.replace).toHaveBeenLastCalledWith("/coach/conversations", {
      scroll: false,
    });

    navigation.searchParams = new URLSearchParams();
    view.rerender(
      <FilterBar facets={facets} searchPlaceholder="Search conversations" views={views} />,
    );
    expect(screen.queryByLabelText("Applied filters")).not.toBeInTheDocument();
  });

  it("canonicalizes unknown and duplicate facet values", async () => {
    navigation.searchParams = new URLSearchParams(
      "channel=unknown&channel=sms&stage=qualifying&stage=booked&sort=oldest",
    );
    const user = userEvent.setup();
    renderFilterBar();

    const chips = screen.getByLabelText("Applied filters");
    expect(within(chips).getByText("Text messages (SMS)")).toBeInTheDocument();
    expect(within(chips).getByText("Qualification Active")).toBeInTheDocument();
    expect(within(chips).queryByText("Booked")).not.toBeInTheDocument();
    expect(within(chips).queryByText("unknown")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Filters/ }));
    expect(screen.getByRole("checkbox", { name: "Channel: Text messages (SMS)" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Stage: Qualification Active" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Stage: Booked" })).not.toBeChecked();

    expect(navigation.replace).toHaveBeenLastCalledWith(
      "/coach/conversations?sort=oldest&channel=sms&stage=qualifying",
      { scroll: false },
    );
  });

  it("debounces search updates for 250ms", async () => {
    vi.useFakeTimers();
    renderFilterBar();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search conversations" }), {
      target: { value: "price" },
    });
    expect(navigation.replace).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(249));
    expect(navigation.replace).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));

    expect(navigation.replace).toHaveBeenLastCalledWith(
      "/coach/conversations?q=price",
      { scroll: false },
    );
    vi.useRealTimers();
  });
});

describe("FilterBar segmented chips", () => {
  beforeEach(() => {
    navigation.pathname = "/coach/conversations";
    navigation.replace.mockReset();
    navigation.searchParams = new URLSearchParams();
  });

  it("splits a facet chip into field, operator, and value, with the value alone in ink", () => {
    navigation.searchParams = new URLSearchParams("channel=instagram");
    renderFilterBar();

    const chip = document.querySelector<HTMLElement>('[data-slot="filter-chip"]');
    expect(chip).not.toBeNull();
    if (!chip) throw new Error("Expected a filter chip.");

    const field = chip.querySelector<HTMLElement>('[data-chip-segment="field"]');
    const operator = chip.querySelector<HTMLElement>('[data-chip-segment="operator"]');
    const value = chip.querySelector<HTMLElement>('[data-chip-segment="value"]');

    expect(field).toHaveTextContent("Channel");
    expect(operator).toHaveTextContent("is");
    expect(value).toHaveTextContent("Instagram");

    // The value is the answer, so it alone is ink at 500; the grammar around it stays muted.
    expect(value?.className).toContain("[font-weight:500]");
    expect(value?.className).toContain("var(--ink)");
    expect(field?.className).toContain("var(--muted)");
    expect(operator?.className).toContain("var(--muted)");

    // Hairline dividers separate the segments, never a coloured edge.
    expect(operator?.className).toContain("[border-left-width:calc(var(--s-1)/4)]");
    expect(value?.className).toContain("[border-left-width:calc(var(--s-1)/4)]");
  });

  it("says a search chip contains its text rather than equals it", () => {
    navigation.searchParams = new URLSearchParams("q=price");
    renderFilterBar();

    const chips = screen.getByLabelText("Applied filters");
    const searchChip = within(chips)
      .getByText("Search")
      .closest('[data-slot="filter-chip"]');
    expect(searchChip).not.toBeNull();
    expect(
      searchChip?.querySelector('[data-chip-segment="operator"]'),
    ).toHaveTextContent("contains");
    expect(searchChip?.querySelector('[data-chip-segment="value"]')).toHaveTextContent(
      "price",
    );
  });

  it("shows the esc hint in a mono kbd beside Clear all", () => {
    navigation.searchParams = new URLSearchParams("channel=instagram");
    renderFilterBar();

    const clear = screen.getByRole("button", { name: "Clear all" });
    const hint = within(clear).getByText("esc");
    expect(hint.tagName).toBe("KBD");
    expect(hint).toHaveAttribute("aria-hidden", "true");
    expect(hint.className).toContain("var(--font-mono)");
  });

  it("clears every applied filter when Escape is pressed", async () => {
    navigation.searchParams = new URLSearchParams("q=price&channel=instagram");
    renderFilterBar();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(navigation.replace).toHaveBeenLastCalledWith("/coach/conversations", {
      scroll: false,
    });
  });

  it("leaves Escape to an open popover instead of clearing behind it", async () => {
    navigation.searchParams = new URLSearchParams("channel=instagram");
    const user = userEvent.setup();
    renderFilterBar();

    await user.click(screen.getByRole("button", { name: /^Filters/ }));
    const dialog = await screen.findByRole("dialog", { name: "Filters" });
    navigation.replace.mockReset();

    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("binds no Escape handler while there is nothing to clear", () => {
    renderFilterBar();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(navigation.replace).not.toHaveBeenCalled();
  });
});

describe("FilterBar saved views", () => {
  beforeEach(() => {
    navigation.pathname = "/coach/conversations";
    navigation.replace.mockReset();
    navigation.searchParams = new URLSearchParams();
  });

  it("renders the saved views as a bordered segmented control with a quiet active fill", async () => {
    const user = userEvent.setup();
    renderFilterBar();

    const control = screen.getByRole("group", { name: "Views" });
    expect(control).toHaveAttribute("data-slot", "segmented-control");
    expect(control.className).toContain("[border-width:calc(var(--s-1)/4)]");

    const all = within(control).getByRole("button", { name: "All" });
    const needsYou = within(control).getByRole("button", { name: "Needs you" });

    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(all.className).toContain("bg-[var(--quiet)]");
    expect(all.className).toContain("[font-weight:500]");
    expect(needsYou).toHaveAttribute("aria-pressed", "false");

    // A hairline divides the segments; the outer edge carries the single border.
    expect(needsYou.className).toContain("[border-left-width:calc(var(--s-1)/4)]");

    // The count rides along faint in mono, without joining the button's name.
    const count = within(all).getByText("38");
    expect(count).toHaveAttribute("aria-hidden", "true");
    expect(count.className).toContain("var(--faint)");

    await user.click(needsYou);
    expect(navigation.replace).toHaveBeenLastCalledWith(
      "/coach/conversations?view=needs-you",
      { scroll: false },
    );
  });
});
