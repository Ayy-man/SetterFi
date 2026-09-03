import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_STAT_TILES, StatStrip, type StatStripItem } from "@/components/kit/stat-strip";

function tile(label: string, value: number): StatStripItem {
  return { label, availability: { kind: "value", value, format: "count" } };
}

afterEach(() => vi.restoreAllMocks());

describe("StatStrip", () => {
  it("renders one tile per item up to the cap without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(
      <StatStrip
        items={Array.from({ length: MAX_STAT_TILES }, (_, index) => tile(`Metric ${index}`, index))}
      />,
    );

    expect(document.querySelectorAll('[data-slot="stat-strip-tile"]')).toHaveLength(
      MAX_STAT_TILES,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("gives every tile a test hook carrying its label", () => {
    render(<StatStrip items={[tile("Active coaches", 12)]} />);

    const [strip] = screen.getAllByTestId("stat-tile");
    expect(strip).toHaveAttribute("data-label", "Active coaches");
  });

  it("is one bordered strip whose tiles are divided by a rule, not four floating cards", () => {
    render(
      <StatStrip items={[tile("Booked calls", 12), tile("Replies", 40), tile("Leads", 90)]} />,
    );

    // The chrome belongs to the strip: one border, one radius, one card ground.
    const strip = document.querySelector('[data-slot="stat-strip"]');
    expect(strip).toHaveClass("border", "border-[var(--line)]", "rounded-[var(--r-card)]");
    expect(strip).toHaveClass("bg-[var(--card)]");

    // Each tile carries the divider and nothing else: a left hairline where the strip is one row,
    // a top hairline where it stacks, and no border/radius/background of its own.
    const tiles = screen.getAllByTestId("stat-tile");
    for (const element of tiles) {
      expect(element).toHaveClass("lg:border-l", "border-[var(--line)]");
      expect(element.className).not.toMatch(/(?:^|\s)(?:lg:)?border(?:\s|$)/);
      expect(element.className).not.toMatch(/rounded-|bg-\[var\(--card\)\]/);
    }
    // The first tile in each direction has no rule before it -- the strip's own border is there.
    expect(tiles[0]).toHaveClass("first:border-t-0", "lg:first:border-l-0");
  });

  it("labels tiles in the 11px label role and keeps a long one on one line", () => {
    render(<StatStrip items={[tile("Qualified leads reaching a booked call", 12)]} />);

    const label = document.querySelector('[data-slot="stat-strip-label"]');
    expect(label).toHaveClass("t-label", "truncate", "whitespace-nowrap");
    // Truncation hides the tail visually, so the full label stays reachable on hover.
    expect(label).toHaveAttribute("title", "Qualified leads reaching a booked call");
  });

  it("gives every tile the same anatomy whatever the metric's availability", () => {
    render(
      <StatStrip
        items={[
          tile("Booked calls", 12),
          { label: "Failures", availability: { kind: "no-events", note: "No failures" } },
          { label: "Receipts", availability: { kind: "unavailable", note: "No receipt yet" } },
          { label: "Trend", availability: { kind: "needs-history", days: 3, needs: 14 } },
        ]}
      />,
    );

    const tiles = screen.getAllByTestId("stat-tile");
    expect(tiles).toHaveLength(4);
    for (const element of tiles) {
      // Label, one figure, and at most one note line beneath it -- never a sentence where the
      // figure belongs.
      const figure = element.querySelector('[data-slot="stat-strip-figure"]');
      expect(figure).not.toBeNull();
      expect(element.querySelectorAll('[data-slot="stat-strip-note"]').length).toBeLessThan(2);
    }

    // A real reading uses the mono figure role; the two that have no reading say "not yet".
    const measured = ["Booked calls", "Failures"];
    for (const element of tiles) {
      const figure = element.querySelector('[data-slot="stat-strip-figure"]');
      if (measured.includes(element.dataset.label ?? "")) {
        expect(figure).toHaveClass("t-figure");
      } else {
        expect(figure?.textContent).toBe("not yet");
      }
    }

    // The measured-and-empty window keeps its honest zero.
    const failures = tiles.find((element) => element.dataset.label === "Failures");
    expect(failures?.querySelector('[data-slot="stat-strip-figure"]')?.textContent).toBe("0");
    expect(screen.getByText("No receipt yet").closest('[data-slot="stat-strip-note"]')).not.toBeNull();
  });

  it("says 'not yet' in italic faint for a metric with no reading, with the reason under it", () => {
    render(
      <StatStrip
        items={[{ label: "Receipts", availability: { kind: "unavailable", note: "No receipt yet" } }]}
      />,
    );

    const figure = document.querySelector('[data-slot="stat-strip-figure"]');
    expect(figure).toHaveTextContent("not yet");
    expect(figure).toHaveClass("italic", "text-[var(--faint)]");
    expect(figure).toHaveAttribute("data-state", "not-yet");
    expect(screen.getByText("No receipt yet").closest('[data-slot="stat-strip-note"]')).not.toBeNull();
  });

  it("counts days for a metric still building history, never a percentage or a date", () => {
    render(
      <StatStrip items={[{ label: "Trend", availability: { kind: "needs-history", days: 11, needs: 14 } }]} />,
    );

    const tileElement = screen.getByTestId("stat-tile");
    expect(
      tileElement.querySelector('[data-slot="stat-strip-figure"]')?.textContent,
    ).toBe("not yet");
    // A real day counter, plus how many days are still needed. This is the honest-provisioning
    // rule: no "78%", no "ready on the 4th".
    expect(tileElement.querySelector('[data-slot="stat-strip-day-counter"]')).toHaveTextContent(
      "day 11",
    );
    expect(tileElement).toHaveTextContent("of about 14 needed");
    expect(tileElement.textContent).not.toMatch(/%/);
  });

  it("offers the connection instead of a number when the source is not connected", () => {
    render(
      <StatStrip
        items={[{
          label: "Ad spend",
          availability: {
            kind: "not-connected",
            source: "Meta not connected",
            action: { label: "Connect", onClick: () => {} },
          },
        }]}
      />,
    );

    expect(document.querySelector('[data-slot="stat-strip-figure"]')?.textContent).toBe("not yet");
    expect(screen.getByText("Meta not connected")).toBeVisible();
    expect(screen.getByRole("button", { name: "Connect" })).toBeVisible();
  });

  it("raises a read failure as an alert with a retry, still without a fake number", () => {
    const retry = vi.fn();
    render(
      <StatStrip items={[{ label: "Cost", availability: { kind: "read-failed", retry } }]} />,
    );

    expect(document.querySelector('[data-slot="stat-strip-figure"]')?.textContent).toBe("not yet");
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't read this metric");
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  it("puts a value tile's note on the same line as every other kind's", () => {
    render(
      <StatStrip items={[{ ...tile("Booked calls", 12), note: "Last 30 days" }]} />,
    );

    const note = screen.getByText("Last 30 days");
    expect(note.closest('[data-slot="stat-strip-note"]')).not.toBeNull();
  });

  it("colours the delta from the direction props, not from the sign of the number", () => {
    render(
      <StatStrip
        items={[
          {
            label: "Booking rate",
            availability: { kind: "value", value: 40, format: "count" },
            delta: { value: 4, direction: "down", goodDirection: "up" },
          },
          {
            label: "Cost per booking",
            availability: { kind: "value", value: 40, format: "count" },
            delta: { value: 4, direction: "down", goodDirection: "down", basis: "vs prior 30 days" },
          },
        ]}
      />,
    );

    const [rate, cost] = screen.getAllByTestId("stat-tile");
    // Same arrow, opposite news: only the passed-in goodDirection separates them.
    const rateDelta = rate?.querySelector('[data-slot="stat-strip-delta"]');
    expect(rateDelta).toHaveAttribute("data-tone", "critical");
    expect(rateDelta).toHaveClass("text-[var(--critical-text)]");

    const costDelta = cost?.querySelector('[data-slot="stat-strip-delta"]');
    expect(costDelta).toHaveAttribute("data-tone", "good");
    expect(costDelta).toHaveClass("text-[var(--good)]");
    // Mono, 11px, and one line -- the delta is a caption under the figure, not a second figure.
    expect(costDelta).toHaveClass("text-[11px]", "font-[family-name:var(--font-mono)]");
    expect(costDelta).toHaveTextContent("vs prior 30 days");
    expect(screen.getByRole("img", { name: "Down 4 vs prior 30 days" })).toBeVisible();
  });

  it("shows exactly one delta line, and none where there is no reading to compare", () => {
    render(
      <StatStrip
        items={[
          {
            label: "Booked calls",
            availability: { kind: "value", value: 12, format: "count" },
            delta: { value: 3, direction: "up", goodDirection: "up" },
          },
          {
            label: "Trend",
            availability: { kind: "needs-history", days: 3, needs: 14 },
            delta: { value: 3, direction: "up", goodDirection: "up" },
          },
        ]}
      />,
    );

    const [booked, trend] = screen.getAllByTestId("stat-tile");
    expect(booked?.querySelectorAll('[data-slot="stat-strip-delta"]')).toHaveLength(1);
    // "not yet" plus an arrow would be claiming a trend the metric does not have one for.
    expect(trend?.querySelectorAll('[data-slot="stat-strip-delta"]')).toHaveLength(0);
  });

  it("holds a fixed number of decimals so a tile matches the table beside it", () => {
    render(
      <StatStrip
        items={[{
          label: "Booking rate",
          availability: { kind: "value", value: 6, format: "percent" },
          precision: 1,
        }]}
      />,
    );

    // The figure is split into one element per character so the digits can re-enter when the
    // number changes, which defeats `getByText` -- the text is no longer one node. Read the
    // figure slot the way the em-dash case above does; the split leaves the element's own text
    // content exactly the figure, with no second hidden copy.
    const figure = document.querySelector('[data-slot="stat-strip-figure"]');
    expect(figure?.textContent).toBe("6.0%");
    // And the split stays readable as one number rather than four characters, which is the whole
    // reason it is safe to split at all.
    expect(screen.getByRole("img", { name: "6.0%" })).toBeVisible();
  });

  it("renders the figure at its fixed precision immediately under reduced motion", () => {
    // The digits animate in with CSS, not by counting up in JS, so the final value is in the DOM
    // on the first render whatever the reader's motion preference. This is the regression guard
    // for that: swap the entry animation for a JS count-up and the figure would start at some
    // other number and tick towards this one, which under reduced motion is exactly the thing
    // CLAUDE.md forbids.
    vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    }));

    render(
      <StatStrip
        items={[{
          label: "Booking rate",
          availability: { kind: "value", value: 6, format: "percent" },
          precision: 1,
        }]}
      />,
    );

    expect(
      document.querySelector('[data-slot="stat-strip-figure"]')?.textContent,
    ).toBe("6.0%");
  });

  it("warns in development when a page asks for more than four tiles", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(
      <StatStrip
        items={Array.from({ length: MAX_STAT_TILES + 1 }, (_, index) =>
          tile(`Metric ${index}`, index),
        )}
      />,
    );

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("at most 4 tiles");
  });

  it("renders a supplied sparkline under the figure", () => {
    render(
      <StatStrip
        items={[{ ...tile("Booked calls", 12), sparkline: <svg data-testid="spark" /> }]}
      />,
    );

    expect(screen.getByTestId("spark")).toBeInTheDocument();
    expect(document.querySelector('[data-slot="stat-strip-sparkline"]')).not.toBeNull();
  });

  it("draws the kit sparkline itself from a series of points", () => {
    render(
      <StatStrip items={[{ ...tile("Booked calls", 12), points: [2, 5, 3, 9, 6, 11] }]} />,
    );

    const spark = screen.getByRole("img", { name: "Booked calls trend" });
    expect(spark).toHaveAttribute("data-slot", "sparkline");
    expect(spark.closest('[data-slot="stat-strip-sparkline"]')).not.toBeNull();
  });
  it("stands a tile as a block rather than a wide table row", () => {
    render(<StatStrip items={[tile("Booked calls", 12)]} />);

    const [tileEl] = screen.getAllByTestId("stat-tile");
    // 20/16 around a 22px figure puts a tile near 100px against the table's 36px --d-row: close to
    // three rows to one tile. At the 16/12 it used to carry it stood at about two, and a summary
    // that reads as two rows of the thing it summarises is not a summary.
    expect(tileEl).toHaveClass("px-[var(--s-5)]", "py-[var(--s-4)]");
    // The label is a caption over the figure block, not a fourth evenly spaced line in it.
    expect(tileEl).toHaveClass("gap-[var(--s-2)]");
  });
});
