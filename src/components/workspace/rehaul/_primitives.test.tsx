import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  CARD_TABLE,
  CardTable,
  Figure,
  Pill,
  RehaulTabs,
  Seg,
  StatusDot,
} from "@/components/workspace/rehaul/_primitives";

describe("RehaulTabs", () => {
  it("underlines only the active tab and links the ones with an href", () => {
    render(
      <RehaulTabs
        items={[
          { active: true, label: "Billing" },
          { href: "/console/money/costs", label: "Costs" },
          { count: 2, href: "/console/money/affiliates", label: "Affiliates" },
        ]}
        label="Money sections"
      />,
    );

    const active = screen.getByText("Billing");
    expect(active.className).toContain("border-b-2");
    expect(active.className).toContain("var(--accent)");
    expect(active).toHaveAttribute("aria-current", "page");

    const costs = screen.getByRole("link", { name: "Costs" });
    expect(costs).toHaveAttribute("href", "/console/money/costs");
    expect(costs.className).not.toContain("border-b-2");

    expect(screen.getByRole("navigation")).toHaveAccessibleName("Money sections");
  });

  it("prints a tab count as an amber mono figure", () => {
    render(<RehaulTabs items={[{ count: 2, label: "Corrections" }]} />);

    const count = screen.getByText("2");
    expect(count.className).toContain("font-mono");
    expect(count.className).toContain("var(--warning-text)");
  });
});

describe("StatusDot", () => {
  it.each([
    ["good", "var(--good)"],
    ["amber", "var(--warning)"],
    ["wait", "oklch(0.6398_0.115_271)"],
    ["bad", "oklch(0.6503_0.135_32)"],
    ["grey", "rgba(60,90,150,0.3)"],
  ] as const)("paints the %s tone from the artboard palette", (tone, colour) => {
    const { container } = render(<StatusDot tone={tone} />);
    const dot = container.querySelector<HTMLElement>('[data-slot="status-dot"]');

    expect(dot).toHaveAttribute("data-tone", tone);
    expect(dot?.className).toContain(colour);
    expect(dot?.className).toContain("size-[7px]");
    expect(dot).toHaveAttribute("aria-hidden", "true");
  });
});

describe("Pill", () => {
  it("is neutral unless a tone asks otherwise", () => {
    const { rerender } = render(<Pill>Unassigned</Pill>);
    expect(screen.getByText("Unassigned").className).toContain("var(--line)");

    rerender(<Pill tone="amber">Day 9</Pill>);
    expect(screen.getByText("Day 9").className).toContain("var(--warning-text)");
  });
});

describe("Figure", () => {
  it.each([
    ["sm", "text-[24px]"],
    ["md", "text-[30px]"],
    ["lg", "text-[44px]"],
    ["hero", "text-[72px]"],
  ] as const)("renders the %s size as a mono figure", (size, sizeClass) => {
    render(<Figure size={size}>$2,982</Figure>);
    const figure = screen.getByText("$2,982");

    expect(figure).toHaveAttribute("data-size", size);
    expect(figure.className).toContain("font-mono");
    expect(figure.className).toContain("font-medium");
    expect(figure.className).toContain(sizeClass);
  });

  it("tightens the hero beyond the smaller sizes", () => {
    const { rerender } = render(<Figure size="lg">44</Figure>);
    expect(screen.getByText("44").className).toContain("tracking-[-0.05em]");

    rerender(<Figure size="hero">72</Figure>);
    const hero = screen.getByText("72");
    expect(hero.className).toContain("tracking-[-0.075em]");
    expect(hero.className).toContain("leading-[0.92]");
  });
});

describe("Seg", () => {
  it("washes the active cell and keeps the others quiet", () => {
    render(
      <Seg
        items={[{ label: "1M" }, { active: true, label: "3M" }, { label: "12M" }]}
        label="Window"
      />,
    );

    expect(screen.getByRole("group")).toHaveAccessibleName("Window");
    expect(screen.getByText("3M").className).toContain("var(--accent-wash-strong)");
    expect(screen.getByText("1M").className).toContain("var(--muted)");
  });

  it("stands taller in the coach density than in the console", () => {
    const { rerender } = render(<Seg items={[{ label: "Week" }]} />);
    expect(screen.getByText("Week").className).toContain("text-[12.5px]");

    rerender(<Seg density="coach" items={[{ label: "Week" }]} />);
    const coach = screen.getByText("Week");
    expect(coach.className).toContain("h-[38px]");
    expect(coach.className).toContain("text-[15px]");
  });

  it("renders a cell with an href as a link", () => {
    render(<Seg items={[{ href: "/console/money?window=12m", label: "12M" }]} />);
    expect(screen.getByRole("link", { name: "12M" })).toHaveAttribute(
      "href",
      "/console/money?window=12m",
    );
  });
});

describe("CardTable", () => {
  it("wraps a table in the card face and exports the cell classes", () => {
    const { container } = render(
      <CardTable>
        <table className={CARD_TABLE.table}>
          <tbody>
            <tr>
              <td className={CARD_TABLE.td}>Cedar Ridge Credit Coaching</td>
            </tr>
          </tbody>
        </table>
      </CardTable>,
    );

    const card = container.querySelector<HTMLElement>('[data-slot="card-table"]');
    expect(card?.className).toContain("rounded-[14px]");
    expect(card?.className).toContain("border-[var(--line)]");
    expect(CARD_TABLE.num).toContain("font-mono");
    expect(CARD_TABLE.th).toContain("var(--band)");
    expect(screen.getByText("Cedar Ridge Credit Coaching").className).toContain("h-10");
  });
});
