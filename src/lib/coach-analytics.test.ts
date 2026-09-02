import { describe, expect, it } from "vitest";

import { analyticsForDays, customRangeDays, PRESET_ANALYTICS } from "@/lib/coach-analytics";

describe("customRangeDays", () => {
  it("counts inclusively, so one date twice is one day", () => {
    expect(customRangeDays("2026-07-01", "2026-07-01")).toBe(1);
    expect(customRangeDays("2026-07-01", "2026-07-14")).toBe(14);
  });

  it("spans months and leap days without drifting", () => {
    expect(customRangeDays("2026-01-31", "2026-02-01")).toBe(2);
    expect(customRangeDays("2024-02-28", "2024-03-01")).toBe(3);
  });

  it("rejects a reversed or unparseable range instead of returning a negative span", () => {
    expect(customRangeDays("2026-07-14", "2026-07-01")).toBeNull();
    expect(customRangeDays("", "2026-07-01")).toBeNull();
    expect(customRangeDays("not-a-date", "also-not")).toBeNull();
  });
});

describe("analyticsForDays", () => {
  it("reproduces each preset at its own anchor, so the two paths cannot disagree", () => {
    expect(analyticsForDays(1, "x").leads).toBe(PRESET_ANALYTICS["1d"].leads);
    expect(analyticsForDays(7, "x").leads).toBe(PRESET_ANALYTICS["1w"].leads);
    expect(analyticsForDays(30, "x").leads).toBe(PRESET_ANALYTICS["1m"].leads);
    expect(analyticsForDays(90, "x").leads).toBe(PRESET_ANALYTICS["3m"].leads);
  });

  it("lands between the neighbouring anchors for a span between them", () => {
    const fortnight = analyticsForDays(14, "14 days");
    expect(fortnight.leads).toBeGreaterThan(PRESET_ANALYTICS["1w"].leads);
    expect(fortnight.leads).toBeLessThan(PRESET_ANALYTICS["1m"].leads);
  });

  it("grows monotonically with the window, so a wider range never shows fewer leads", () => {
    let previous = 0;
    for (const days of [1, 3, 7, 14, 30, 60, 90, 150, 220]) {
      const { leads } = analyticsForDays(days, "x");
      expect(leads).toBeGreaterThanOrEqual(previous);
      previous = leads;
    }
  });

  it("clamps out-of-range spans rather than extrapolating invented numbers", () => {
    expect(analyticsForDays(0, "x").leads).toBe(PRESET_ANALYTICS["1d"].leads);
    expect(analyticsForDays(-40, "x").leads).toBe(PRESET_ANALYTICS["1d"].leads);
    expect(analyticsForDays(99_999, "x").leads).toBe(PRESET_ANALYTICS.all.leads);
  });

  it("derives conversion from its own leads and booked, so the KPIs agree with each other", () => {
    const range = analyticsForDays(45, "45 days");
    expect(range.conversion).toBe(`${((range.booked / range.leads) * 100).toFixed(1)}%`);
  });

  it("keeps the funnel monotonically narrowing at every stage", () => {
    for (const days of [5, 20, 45, 120]) {
      const { funnel } = analyticsForDays(days, "x");
      for (let index = 1; index < funnel.length; index += 1) {
        expect(funnel[index]).toBeLessThanOrEqual(funnel[index - 1]);
      }
    }
  });

  it("switches time-to-book units at a day rather than printing 0.1d", () => {
    expect(analyticsForDays(1, "x").timeToBook).toMatch(/h$/);
    expect(analyticsForDays(30, "x").timeToBook).toMatch(/d$/);
  });
});
