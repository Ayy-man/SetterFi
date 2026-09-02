import { describe, expect, it } from "vitest";

import {
  coachCadenceExportRows,
  coachCadenceSchedule,
  type CoachCadenceChannel,
} from "./coach-agent";
import { DURABLE_TOUCHES, WINDOW_BOUND_TOUCHES } from "@/lib/followups/touch-lists";
import { OFFER_CADENCE_PURPOSE_LABELS } from "@/lib/offer/types";

const CHANNELS: readonly CoachCadenceChannel[] = [
  {
    channel: "sms",
    channelLabel: "SMS",
    capability: { postWindow: "freeform", templateSend: false },
  },
  {
    channel: "instagram",
    channelLabel: "Instagram",
    capability: { postWindow: "human_agent_only", templateSend: false },
  },
];

describe("coachCadenceExportRows", () => {
  it("exports one row per rendered touch", () => {
    const schedule = coachCadenceSchedule(CHANNELS);
    const rows = coachCadenceExportRows(schedule, []);

    expect(rows).toHaveLength(
      WINDOW_BOUND_TOUCHES.length + DURABLE_TOUCHES.length,
    );
    expect(rows.map((row) => `${row.channelClass}:${row.touchNo}`)).toEqual(
      schedule.flatMap((group) =>
        group.touches.map((touch) => `${group.channelClass}:${touch.touchNo}`),
      ),
    );
  });

  it("carries the rendered timing, channel label, and platform default", () => {
    const schedule = coachCadenceSchedule(CHANNELS);
    const rows = coachCadenceExportRows(schedule, []);
    const first = rows[0];
    const group = schedule[0];

    expect(first.channel).toBe(group.channelLabel);
    expect(first.connected).toBe(group.connected);
    expect(first.when).toBe(group.touches[0].when);
    expect(first.purpose).toBe(group.touches[0].defaultPurpose);
    expect(first.purposeLabel).toBe(
      OFFER_CADENCE_PURPOSE_LABELS[group.touches[0].defaultPurpose],
    );
    expect(first.purposeSource).toBe("platform");
  });

  it("prefers a saved purpose and marks it as the coach's choice", () => {
    const schedule = coachCadenceSchedule(CHANNELS);
    const rows = coachCadenceExportRows(schedule, [
      { channelClass: "durable", touchNo: 2, purpose: "training" },
    ]);
    const saved = rows.find(
      (row) => row.channelClass === "durable" && row.touchNo === 2,
    );

    expect(saved?.purpose).toBe("training");
    expect(saved?.purposeLabel).toBe(OFFER_CADENCE_PURPOSE_LABELS.training);
    expect(saved?.purposeSource).toBe("coach");
    expect(
      rows.filter((row) => row.purposeSource === "coach"),
    ).toHaveLength(1);
  });

  it("ignores purposes saved against a touch the platform no longer schedules", () => {
    const schedule = coachCadenceSchedule(CHANNELS);
    const rows = coachCadenceExportRows(schedule, [
      { channelClass: "durable", touchNo: 99, purpose: "training" },
    ]);

    expect(rows.every((row) => row.purposeSource === "platform")).toBe(true);
  });
});
