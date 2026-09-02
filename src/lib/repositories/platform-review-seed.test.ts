import { describe, expect, it } from "vitest";

import { PLATFORM_METRIC_KEYS } from "@/lib/analytics/metric-definitions";
import { loadPlatformMeasurement } from "@/lib/repositories/platform-analytics";

import { platformReviewSnapshot } from "../../../scripts/seed-platform-review-data.mjs";

describe("platform review seed", () => {
  it("contains the closed platform metric set and passes the normal measurement parser", async () => {
    const snapshot = platformReviewSnapshot();
    const asOf = "2026-08-23T00:00:00.000Z";
    expect(snapshot.metrics.map((row: { metricKey: string }) => row.metricKey)).toEqual(PLATFORM_METRIC_KEYS);
    const parsed = await loadPlatformMeasurement(
      "82000000-0000-4000-8000-000000000001",
      asOf,
      async () => ({ origin: "synthetic_preview", snapshot: { ...snapshot, asOf } }),
    );
    expect(parsed.origin).toBe("synthetic_preview");
    expect(parsed.metrics).toHaveLength(PLATFORM_METRIC_KEYS.length);
    expect(parsed.guardrailRules).toHaveLength(3);
    expect(parsed.subscriptions).toHaveLength(3);
  });
});
