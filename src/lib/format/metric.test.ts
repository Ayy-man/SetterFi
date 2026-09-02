import { describe, expect, it } from "vitest";

import { formatMetric, money } from "./metric";

describe("metric formatting", () => {
  it("formats counts with grouping and whole-number rounding", () => {
    expect(formatMetric(1_234.4, "count")).toBe("1,234");
  });

  it("formats money from cents without exposing the stored unit", () => {
    expect(formatMetric(12_345, "money")).toBe("$123.45");
    expect(money(12_345, "GBP")).toBe("£123.45");
  });

  it("formats percentage-point values as percentages", () => {
    expect(formatMetric(12.34, "percent")).toBe("12.3%");
  });

  it("chooses a readable duration unit from seconds", () => {
    expect(formatMetric(45, "duration")).toBe("45 sec");
    expect(formatMetric(90, "duration")).toBe("1.5 min");
    expect(formatMetric(7_200, "duration")).toBe("2 hr");
  });
});
