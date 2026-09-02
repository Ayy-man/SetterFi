import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BarSparkline, HeatRow } from "@/components/kit/atomics/bar-sparkline";
import { IconTile, Monogram, initialsFor } from "@/components/kit/atomics/icon-tile";
import { KeyValueList, MetricCard } from "@/components/kit/atomics/metric-card";
import { FunnelBars, Legend, ProgressBar, SplitBar } from "@/components/kit/atomics/progress";
import { Status, StatusAbsent, StatusDot } from "@/components/kit/atomics/status";
import { Surface } from "@/components/kit/atomics/surface";
import { TONES } from "@/components/kit/atomics/tone";

function slot(name: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  if (!element) throw new Error(`No ${name} rendered`);
  return element;
}

describe("Status", () => {
  it.each(TONES)("carries the %s tone as data, not only as colour", (tone) => {
    render(<Status label={tone} tone={tone} />);
    expect(slot("status")).toHaveAttribute("data-tone", tone);
  });

  it("draws the two treatments differently: the pill has a border and a wash, the bare dot does not", () => {
    const { unmount } = render(<Status label="Open request" tone="warning" treatment="pill" />);
    const pill = slot("status");
    expect(pill).toHaveAttribute("data-treatment", "pill");
    expect(pill.className).toContain("border");
    expect(pill.style.background).toBeTruthy();
    unmount();

    render(<Status label="Open request" tone="warning" treatment="bare" />);
    const bare = slot("status");
    expect(bare).toHaveAttribute("data-treatment", "bare");
    expect(bare.style.background).toBe("");
  });

  /**
   * Every dot is flat unless something asks. This test used to assert the opposite -- that warning
   * and failure glowed by default -- which is the behaviour a design ruling overruled on
   * 2026-08-30, after a tone-keyed default shipped five glowing dots on one screen.
   * The ruling was recorded and the code did not move, so this test kept the overruled position
   * green for a day. It now pins the ruling instead.
   */
  it("leaves every dot flat, including the attention tones, until asked", () => {
    for (const tone of TONES) {
      const { unmount } = render(<Status label={tone} tone={tone} />);
      expect(slot("status-dot").style.boxShadow, `${tone} glowed without being asked`).toBe("");
      unmount();
    }
  });

  it("gives a halo to an attention tone that asks for one", () => {
    const { unmount } = render(<StatusDot glow tone="warning" />);
    expect(slot("status-dot").style.boxShadow).toContain("0 0");
    unmount();
  });

  /**
   * The permission half of the rule. A glowing "Resolved" dot is a defect, so asking must not be
   * enough on a tone that should never carry attention.
   */
  it("refuses a halo on a tone that may never glow, even when asked", () => {
    for (const tone of ["good", "neutral", "waiting", "draft"] as const) {
      const { unmount } = render(<StatusDot glow tone={tone} />);
      expect(slot("status-dot").style.boxShadow, `${tone} was allowed to glow`).toBe("");
      unmount();
    }
  });

  it("renders an absence as a rule with a spoken label, never as a neutral pill", () => {
    render(<StatusAbsent label="No request" />);
    const absent = slot("status-absent");
    expect(absent).not.toHaveAttribute("data-tone");
    expect(screen.getByText("No request")).toHaveClass("sr-only");
    expect(document.querySelector('[data-slot="status"]')).toBeNull();
  });
});

describe("Surface", () => {
  it.each(["card", "panel", "well", "strip"] as const)("uses the %s recipe class", (variant) => {
    const { unmount } = render(<Surface variant={variant} />);
    const surface = slot("surface");
    expect(surface).toHaveAttribute("data-variant", variant);
    const expected = { card: "surface-card", panel: "surface-card", well: "surface-well", strip: "surface-strip" }[variant];
    expect(surface.className).toContain(expected);
    unmount();
  });

  it("frames a toned surface with a full border and a face wash, never an edge stripe", () => {
    render(<Surface tone="failure" />);
    const surface = slot("surface");
    expect(surface.style.borderColor).toBe("var(--failure-line)");
    expect(surface.style.backgroundImage).toContain("radial-gradient");
    expect(surface.style.borderLeftWidth).toBe("");
  });

  it("leaves a neutral surface's face alone", () => {
    render(<Surface />);
    expect(slot("surface").style.backgroundImage).toBe("");
  });

  it("marks an open card with the attribute the recipe switches on", () => {
    render(<Surface open />);
    expect(slot("surface")).toHaveAttribute("data-open", "true");
  });
});

describe("MetricCard", () => {
  it("orders label, then figure, then what the figure is a share of", () => {
    render(<MetricCard note="1,780 of 4,812" overline="Booking rate" value="37%" />);
    const label = screen.getByText("Booking rate");
    const figure = screen.getByText("37%");
    const note = screen.getByText("1,780 of 4,812");
    expect(label.compareDocumentPosition(figure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(figure.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each(TONES)("passes the %s tone down to the figure and the frame", (tone) => {
    render(<MetricCard overline="Leads" tone={tone} value="12" />);
    expect(slot("metric-card")).toHaveAttribute("data-tone", tone);
    expect(slot("figure")).toHaveAttribute("data-tone", tone);
  });

  it("draws the corner radial only when asked, because four glowing tiles is the hero template", () => {
    const { unmount } = render(<MetricCard overline="Leads" value="12" />);
    expect(document.querySelector('[data-slot="metric-card-glow"]')).toBeNull();
    unmount();
    render(<MetricCard glow overline="Leads" tone="warning" value="3" />);
    expect(slot("metric-card-glow").style.background).toContain("radial-gradient");
  });
});

describe("ProgressBar", () => {
  it("reports its share to assistive tech, not just to the eye", () => {
    render(<ProgressBar label="Rollout checklist, 4 of 6" value={4 / 6} />);
    const bar = slot("progress-bar");
    expect(bar).toHaveAttribute("role", "progressbar");
    expect(bar).toHaveAttribute("aria-label", "Rollout checklist, 4 of 6");
    expect(bar).toHaveAttribute("aria-valuenow", "66.7");
  });

  it.each([
    [4.2, "100"],
    [-3, "0"],
    [Number.NaN, "0"],
  ])("clamps %s to %s rather than overflowing its track", (value, expected) => {
    render(<ProgressBar label="Clamped" value={value} />);
    expect(slot("progress-bar")).toHaveAttribute("aria-valuenow", expected);
    expect(slot("progress-bar-fill").style.width).toBe(`${expected}%`);
  });
});

describe("SplitBar and FunnelBars", () => {
  it("sizes every segment against the whole, so the parts add up to the bar", () => {
    render(
      <SplitBar
        label="Movement"
        segments={[
          { label: "New", tone: "good", value: 75 },
          { label: "Churn", tone: "failure", value: 25 },
        ]}
      />,
    );
    const segments = document.querySelectorAll<HTMLElement>('[data-slot="split-bar-segment"]');
    expect(segments[0]!.style.width).toBe("75%");
    expect(segments[1]!.style.width).toBe("25%");
  });

  it("draws nothing rather than dividing by zero", () => {
    render(<SplitBar label="Empty" segments={[{ label: "New", tone: "good", value: 0 }]} />);
    expect(document.querySelector('[data-slot="split-bar"]')).toBeNull();
  });

  it("computes each funnel share from the steps themselves rather than from a passed percentage", () => {
    render(
      <FunnelBars
        steps={[
          { label: "Contacted", value: 4812 },
          { label: "Booked", tone: "good", value: 1780 },
        ]}
      />,
    );
    const bars = document.querySelectorAll<HTMLElement>('[data-slot="progress-bar"]');
    expect(bars[0]).toHaveAttribute("aria-valuenow", "100");
    expect(bars[1]).toHaveAttribute("aria-valuenow", "37");
  });
});

describe("BarSparkline", () => {
  it("refuses to draw a trend from a single point", () => {
    render(<BarSparkline label="Too short" points={[7]} />);
    expect(document.querySelector('[data-slot="bar-sparkline"]')).toBeNull();
  });

  it("names the series for assistive tech", () => {
    render(<BarSparkline label="Total leads, last 7 days" points={[1, 2, 3]} />);
    expect(slot("bar-sparkline")).toHaveAttribute("aria-label", "Total leads, last 7 days");
  });

  it("scales bar heights against the peak and floors a measured zero at a visible sliver", () => {
    render(<BarSparkline label="Leads" points={[0, 50, 100]} />);
    const bars = document.querySelectorAll<HTMLElement>('[data-slot="bar-sparkline-bar"]');
    expect(bars[0]!.style.height).toBe("2%");
    expect(bars[1]!.style.height).toBe("50%");
    expect(bars[2]!.style.height).toBe("100%");
  });

  it("saturates only the trailing bars, so recency reads without a second hue", () => {
    render(<BarSparkline emphasisCount={2} label="Leads" points={[1, 2, 3, 4]} />);
    const bars = document.querySelectorAll<HTMLElement>('[data-slot="bar-sparkline-bar"]');
    expect(Number(bars[0]!.style.opacity)).toBeLessThan(1);
    expect(Number(bars[1]!.style.opacity)).toBeLessThan(1);
    expect(bars[2]!.style.opacity).toBe("1");
    expect(bars[3]!.style.opacity).toBe("1");
  });

  it("keeps every heat cell the same height and moves only the fill", () => {
    render(<HeatRow height={34} label="Bookings by hour" points={[0, 5, 10]} />);
    const cells = document.querySelectorAll<HTMLElement>('[data-slot="heat-row-cell"]');
    expect([...cells].every((cell) => cell.style.height === "34px")).toBe(true);
    expect(Number(cells[0]!.style.opacity)).toBeLessThan(Number(cells[2]!.style.opacity));
  });
});

describe("IconTile, Monogram and the empty seat", () => {
  it.each(["xs", "sm", "md", "lg"] as const)("draws the %s box at its own size", (size) => {
    const { unmount } = render(<IconTile size={size} />);
    const tile = slot("icon-tile");
    expect(tile).toHaveAttribute("data-size", size);
    expect(tile.style.width).toBe({ xs: "22px", sm: "26px", md: "28px", lg: "33px" }[size]);
    unmount();
  });

  it("is decorative unless it is given a label of its own", () => {
    const { unmount } = render(<IconTile />);
    expect(slot("icon-tile")).toHaveAttribute("aria-hidden", "true");
    unmount();
    render(<IconTile label="Breaching" />);
    expect(slot("icon-tile")).toHaveAttribute("role", "img");
  });

  it.each([
    ["Elevate Funding Co.", "EC"],
    ["Reid Funding Group", "RG"],
    ["Ayman", "AY"],
    ["  ", "?"],
  ])("derives %s down to %s rather than trusting a passed string", (name, expected) => {
    expect(initialsFor(name)).toBe(expected);
  });

  it("shapes an account square and a person round, so a table can tell them apart", () => {
    const { unmount } = render(<Monogram name="Reid Funding Group" />);
    expect(slot("monogram").style.borderRadius).toBe("8px");
    unmount();
    render(<Monogram kind="person" name="Dana Whitfield" />);
    expect(slot("monogram").style.borderRadius).toBe("var(--r-full)");
  });
});

describe("Legend and KeyValueList", () => {
  it("keys with a rounded square, never a dot, so it cannot be read as a status", () => {
    render(<Legend items={[{ label: "New", tone: "good", value: "+7,900" }]} />);
    const swatch = slot("legend-swatch");
    expect(swatch.className).toContain("rounded-[2px]");
    expect(swatch.className).not.toContain("var(--r-full)");
  });

  it("puts the tone on the value, because the number is what is alarming", () => {
    render(<KeyValueList rows={[{ label: "Leads waiting", tone: "failure", value: "38" }]} />);
    const value = screen.getByText("38");
    expect(value).toHaveAttribute("data-tone", "failure");
    expect(screen.getByText("Leads waiting")).not.toHaveAttribute("data-tone");
  });
});
