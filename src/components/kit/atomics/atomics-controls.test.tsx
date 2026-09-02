import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AddChipButton, KitButton } from "@/components/kit/atomics/button";
import { Chip, KitInput, KitToggle, SelectShell } from "@/components/kit/atomics/field";
import {
  GridTable,
  GridTableCell,
  GridTableHead,
  GridTableRow,
} from "@/components/kit/atomics/grid-table";
import { Segmented, UnderlineTabs } from "@/components/kit/atomics/segmented";
import {
  CollapsedSettingCard,
  SettingGroup,
  SettingRow,
  SettingSection,
} from "@/components/kit/atomics/setting-row";
import { TONES } from "@/components/kit/atomics/tone";

function slot(name: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  if (!element) throw new Error(`No ${name} rendered`);
  return element;
}

describe("KitButton", () => {
  it.each(["primary", "secondary", "ghost", "destructive", "soft"] as const)(
    "declares the %s variant so a screen cannot half-apply it",
    (variant) => {
      const { unmount } = render(<KitButton variant={variant}>Publish</KitButton>);
      expect(slot("kit-button")).toHaveAttribute("data-variant", variant);
      unmount();
    },
  );

  it("fills only on primary: every other variant is a wash or nothing", () => {
    const filled: string[] = [];
    for (const variant of ["primary", "secondary", "ghost", "destructive", "soft"] as const) {
      const { unmount } = render(<KitButton variant={variant}>Go</KitButton>);
      if (slot("kit-button").className.includes("var(--accent-fill)")) filled.push(variant);
      unmount();
    }
    expect(filled).toEqual(["primary"]);
  });

  it("keeps the destructive action a clay wash rather than a solid red fill", () => {
    render(<KitButton variant="destructive">Restart agent</KitButton>);
    const button = slot("kit-button");
    expect(button.className).toContain("bg-[var(--failure-wash)]");
    expect(button.className).toContain("text-[color:var(--failure-text)]");
    expect(button.className).not.toContain("var(--critical)");
  });

  it.each(["sm", "md", "lg"] as const)("draws the %s height", (size) => {
    const { unmount } = render(<KitButton size={size}>Snooze</KitButton>);
    expect(slot("kit-button")).toHaveAttribute("data-size", size);
    unmount();
  });

  it("defaults to type=button, so a kit button inside a form cannot submit it by accident", () => {
    render(<KitButton>Snooze</KitButton>);
    expect(slot("kit-button")).toHaveAttribute("type", "button");
    render(<AddChipButton />);
    expect(slot("add-chip-button")).toHaveAttribute("type", "button");
  });
});

describe("Inputs", () => {
  it("keeps the real focus outline underneath the artifact's tint ring", () => {
    render(<KitInput />);
    const shell = slot("field-shell");
    // The shell paints the artifact's 3px teal tint...
    expect(shell.className).toContain("focus-within:[box-shadow:0_0_0_3px_var(--accent-wash-strong)]");
    // ...and nothing here removes the global :focus-visible outline from the input itself, which
    // is the indicator that actually clears WCAG 2.4.11.
    expect(shell.className).not.toContain("outline-none");
    expect(slot("kit-input").className).not.toContain("outline-none");
  });

  it("says invalid out loud as well as in clay", () => {
    render(<KitInput invalid />);
    expect(slot("kit-input")).toHaveAttribute("aria-invalid", "true");
    expect(slot("field-shell")).toHaveAttribute("data-invalid", "true");
  });

  it("marks a select that blocks publish where the setting is, not only in a summary", () => {
    render(<SelectShell needsValue value="Choose owner" />);
    const select = slot("select-shell");
    expect(select).toHaveAttribute("data-needs-value", "true");
    expect(select.className).toContain("var(--failure-line)");
  });

  it("is a real switch with a real state, so a toggle is never mistaken for a broken control", async () => {
    const onCheckedChange = vi.fn();
    render(<KitToggle checked={false} label="Quiet hours" onCheckedChange={onCheckedChange} />);
    const toggle = screen.getByRole("switch", { name: "Quiet hours" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAttribute("data-state", "off");
    await userEvent.click(toggle);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("gives a removable chip a named remove control rather than a bare glyph", () => {
    render(<Chip onRemove={() => undefined}>wrong number</Chip>);
    expect(screen.getByRole("button", { name: "Remove wrong number" })).toBeInTheDocument();
  });

  it("marks a selected chip, because selected means the coach chose it", () => {
    render(<Chip selected>Support: open</Chip>);
    expect(slot("chip")).toHaveAttribute("data-selected", "true");
  });
});

describe("Segmented", () => {
  it("never spends the accent on the active segment", () => {
    render(
      <Segmented
        label="Period"
        onValueChange={() => undefined}
        options={[{ key: "7D", label: "7D" }, { key: "30D", label: "30D" }]}
        value="30D"
      />,
    );
    const active = document.querySelector<HTMLElement>('[data-slot="segmented-option"][data-active="true"]');
    expect(active).toHaveAttribute("data-segment", "30D");
    // The band token rather than the white alpha this pinned before the light palette landed:
    // a 9% white wash over a near-white ground marks nothing, and --band is the token that means
    // "the recessed strip behind a header row" in both themes. The claim the test is making is
    // the line below -- the active segment is marked by a neutral fill and never by the accent,
    // because a period switch is not the page's live action and would spend the one fill a page
    // gets on a thing nobody clicked.
    expect(active!.className).toContain("bg-[var(--band)]");
    expect(active!.className).not.toContain("accent");
  });

  it("lets one segment carry a tone and its count while the rest stay neutral", () => {
    render(
      <Segmented
        label="Views"
        onValueChange={() => undefined}
        options={[
          { key: "all", label: "All" },
          { count: 8, key: "attention", label: "Needs attention", tone: "warning" },
        ]}
        value="all"
      />,
    );
    const toned = document.querySelector<HTMLElement>('[data-segment="attention"]');
    expect(toned).toHaveAttribute("data-tone", "warning");
    expect(toned!.style.background).toBe("var(--warning-wash)");
    expect(document.querySelector('[data-segment="all"]')).toHaveAttribute("data-tone", "neutral");
    expect(slot("segmented-count")).toHaveTextContent("8");
  });

  it("reports the active state to assistive tech and calls back with the key", async () => {
    const onValueChange = vi.fn();
    render(
      <Segmented
        label="Period"
        onValueChange={onValueChange}
        options={[{ key: "7D", label: "7D" }, { key: "30D", label: "30D" }]}
        value="30D"
      />,
    );
    const seven = screen.getByRole("button", { name: "7D" });
    expect(seven).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(seven);
    expect(onValueChange).toHaveBeenCalledWith("7D");
  });

  it("underlines the active tab instead of filling it", () => {
    render(
      <UnderlineTabs
        label="Sections"
        onValueChange={() => undefined}
        tabs={[{ key: "offer", label: "Offer" }, { key: "tone", label: "Tone" }]}
        value="tone"
      />,
    );
    const active = document.querySelector<HTMLElement>('[data-slot="underline-tab"][data-active="true"]');
    expect(active).toHaveAttribute("data-tab", "tone");
    expect(active!.className).toContain("box-shadow:0_2px_0_var(--accent-bright)");
    expect(active!.className).not.toContain("bg-");
  });
});

describe("SettingRow", () => {
  it("carries an explanation on every row, which is the whole reason the kit exists", () => {
    render(
      <SettingRow
        control={<span>on</span>}
        description="A short pause reads human. Instant replies get flagged as bots."
        title="First reply delay"
      />,
    );
    expect(screen.getByText("First reply delay")).toBeInTheDocument();
    expect(
      screen.getByText("A short pause reads human. Instant replies get flagged as bots."),
    ).toBeInTheDocument();
  });

  it.each(TONES)("tints the whole %s row rather than striping one edge", (tone) => {
    const { unmount } = render(<SettingRow description="x" title="Row" tone={tone} />);
    const row = slot("setting-row");
    expect(row).toHaveAttribute("data-tone", tone);
    expect(row.style.borderLeftWidth).toBe("");
    if (tone === "neutral") expect(row.style.background).toBe("");
    else expect(row.style.background).toContain("color-mix");
    unmount();
  });

  it("renders no control slot when the row states a decision instead of offering one", () => {
    render(<SettingRow description="Timing is ours." title="Follow-up cadence" />);
    expect(document.querySelector('[data-slot="setting-row-control"]')).toBeNull();
  });

  it("lays the group out from its own container, not from the viewport", () => {
    render(
      <SettingGroup>
        <SettingRow description="x" title="A" />
      </SettingGroup>,
    );
    expect(slot("setting-group").className).toContain("@container");
    expect(slot("setting-row").className).toContain("@min-[440px]:flex-row");
    expect(slot("setting-row").className).not.toMatch(/(?:^|\s)(?:sm|md|lg|xl):/);
  });

  /**
   * The tile is `accent` by default because most rows lead something the platform runs, but a
   * surface where the tile is the *only* mark saying "you changed this" needs a neutral one. Two
   * tones on the same untoned row is the whole reason this prop exists, so both have to be
   * reachable.
   */
  it("lets an untoned row state a neutral tile without pretending the row is toned", () => {
    const { unmount } = render(
      <SettingRow description="x" icon={<span />} iconTone="neutral" title="Row" />,
    );
    expect(slot("icon-tile")).toHaveAttribute("data-tone", "neutral");
    expect(slot("setting-row")).toHaveAttribute("data-tone", "neutral");
    unmount();

    render(<SettingRow description="x" icon={<span />} title="Row" />);
    expect(slot("icon-tile")).toHaveAttribute("data-tone", "accent");
  });

  /**
   * The open half of 3a's accordion. Its rows have to sit inside the section's own face -- a
   * second card stacked under the header would be a card inside a card, which the surface ladder
   * forbids outright -- and the state has to be announced rather than left to the chevron, which
   * is `aria-hidden` on purpose.
   */
  it("attaches an open section's rows to its own face and announces the state", async () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <SettingSection description="Where these reach you." onToggle={onToggle} summary="0 email" title="Bookings">
        <SettingRow description="x" title="A" />
      </SettingSection>,
    );

    const toggle = slot("setting-section-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector('[data-slot="setting-row"]')).toBeNull();
    await userEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledOnce();

    rerender(
      <SettingSection description="Where these reach you." expanded summary="0 email" title="Bookings">
        <SettingRow description="x" title="A" />
      </SettingSection>,
    );
    const section = slot("setting-section");
    expect(section).toHaveAttribute("data-expanded", "true");
    expect(section.querySelector('[data-slot="setting-row"]')).not.toBeNull();
    expect(section.querySelector(".surface-card"), "a section's body is rows, never a second card").toBeNull();
  });

  it("reports a collapsed section's open state, so the chevron is not the only cue", async () => {
    const onToggle = vi.fn();
    render(
      <CollapsedSettingCard
        description="What it quotes."
        onToggle={onToggle}
        summary="$4k setup"
        title="Offer and pricing"
      />,
    );
    const card = slot("collapsed-setting-card");
    expect(card).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(card);
    expect(onToggle).toHaveBeenCalledOnce();
  });
});

describe("GridTable", () => {
  it("declares the column template once and lets every row inherit it", () => {
    render(
      <GridTable columns="1.7fr 1fr 90px" label="Client book">
        <GridTableHead columns={[{ label: "Client" }, { label: "Owner" }, { align: "right", label: "MRR" }]} />
        <GridTableRow>
          <GridTableCell>Elevate</GridTableCell>
        </GridTableRow>
      </GridTable>,
    );
    const container = slot("grid-table-container");
    expect(container.style.getPropertyValue("--grid-table-columns")).toBe("1.7fr 1fr 90px");
    expect(slot("grid-table-head").style.gridTemplateColumns).toBe("var(--grid-table-columns)");
    expect(slot("grid-table-row").style.gridTemplateColumns).toBe("var(--grid-table-columns)");
  });

  /*
    The narrow template is applied by a class the caller writes, and a class can only win if two
    things hold: the query resolves at all, and nothing outranks what it sets. Both used to be
    false and both were invisible to a test that only asked whether `@container` appeared
    somewhere, so this asks about the arrangement instead.

    `collision` is the detector. It answers "does one element carry both a container query and the
    `@container` declaration that query would have to resolve past" -- the broken shape. A
    detector that finds nothing everywhere is not coverage, so it is run against a hand-built
    broken element first and has to say yes there.
  */
  const CONTAINER_QUERY = /(?:^|\s)@(?:max|min)-\[[^\]]+\](?:\/[\w-]+)?:/;

  function collision(element: HTMLElement): boolean {
    return CONTAINER_QUERY.test(element.className) && /(?:^|\s)@container(?:\/|\s|$)/.test(element.className);
  }

  it("detects a query sitting on the element that declares its own container", () => {
    const broken = document.createElement("div");
    broken.className = "@container w-full @max-[640px]:[--grid-table-columns:var(--grid-table-columns-narrow)]";
    expect(collision(broken)).toBe(true);
  });

  it("keeps the narrow query off the element that declares the container, and names it", () => {
    render(
      <GridTable
        className="@max-[640px]/grid-table:[--grid-table-columns:var(--grid-table-columns-narrow)]"
        columns="1fr"
        columnsNarrow="1fr"
        label="Client book"
      >
        <GridTableRow>
          <GridTableCell>x</GridTableCell>
        </GridTableRow>
      </GridTable>,
    );
    const container = slot("grid-table-container");
    const table = slot("grid-table");

    expect(container).not.toBe(table);
    expect(container.className).toContain("@container/grid-table");
    expect(container.contains(table)).toBe(true);
    expect(collision(table), "the narrow query shares an element with its own @container").toBe(false);
    expect(collision(container), "the container element carries a query of its own").toBe(false);
    // Named, so a `Surface` above it cannot capture the query as the nearer container.
    expect(table.className).toContain("@max-[640px]/grid-table:");
    // Inline would outrank the class that swaps it, so the template is inherited, never set here.
    expect(table.style.getPropertyValue("--grid-table-columns")).toBe("");
  });

  it("stays a table to a screen reader rather than a stack of divs", () => {
    render(
      <GridTable columns="1fr" label="Client book">
        <GridTableHead columns={[{ label: "Client" }]} />
        <GridTableRow>
          <GridTableCell>Elevate</GridTableCell>
        </GridTableRow>
      </GridTable>,
    );
    expect(screen.getByRole("table", { name: "Client book" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Client" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Elevate" })).toBeInTheDocument();
  });

  it.each(TONES)("tints a %s row across its full width", (tone) => {
    const { unmount } = render(
      <GridTable columns="1fr" label="Client book">
        <GridTableRow tone={tone}>
          <GridTableCell>x</GridTableCell>
        </GridTableRow>
      </GridTable>,
    );
    const row = slot("grid-table-row");
    expect(row).toHaveAttribute("data-tone", tone);
    expect(row.style.borderLeftWidth).toBe("");
    unmount();
  });
});
