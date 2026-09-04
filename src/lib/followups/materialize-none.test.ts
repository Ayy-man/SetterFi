import { describe, expect, it } from "vitest";

import { materializeCadence } from "@/lib/followups/materialize";
import { cadenceTouchSummary, DURABLE_TOUCHES, WINDOW_BOUND_TOUCHES } from "@/lib/followups/touch-lists";

const ANCHOR = "2026-09-05T10:00:00.000Z";

function durable(overrides: { touchNo: number; purpose: "none" | "lead_magnet" }[]) {
  return materializeCadence({
    tenantId: "tenant-1",
    conversationId: "conversation-1",
    channel: "sms",
    cadenceAnchorAt: ANCHOR,
    materializedAt: ANCHOR,
    lastOutboundAt: null,
    providerWindowExpiresAt: null,
    purposeOverrides: overrides.map((row) => ({ channelClass: "durable" as const, ...row })),
  });
}

/**
 * "Nothing" is the coach switching one touch off. It is dropped before anything is queued, so
 * no template named followup:none is ever looked up, and every other position keeps its slot.
 */
describe("a touch set to Nothing", () => {
  it("is dropped from the queue while the other touches keep their numbers", () => {
    const rows = durable([{ touchNo: 1, purpose: "none" }, { touchNo: 3, purpose: "none" }]);
    expect(rows.map((row) => row.touchNo)).toEqual([2, 4, 5]);
    expect(rows.every((row) => row.purpose !== "none")).toBe(true);
  });

  it("changes nothing when no touch is off", () => {
    expect(durable([]).map((row) => row.touchNo)).toEqual(DURABLE_TOUCHES.map((touch) => touch.touchNo));
  });
});

describe("cadenceTouchSummary", () => {
  it("counts the touches that still send across both classes", () => {
    const total = DURABLE_TOUCHES.length + WINDOW_BOUND_TOUCHES.length;
    expect(cadenceTouchSummary([])).toEqual({ sending: total, total });
    expect(cadenceTouchSummary([
      { channelClass: "durable", purpose: "none" },
      { channelClass: "window_bound", purpose: "none" },
      { channelClass: "durable", purpose: "training" },
    ])).toEqual({ sending: total - 2, total });
  });
});
