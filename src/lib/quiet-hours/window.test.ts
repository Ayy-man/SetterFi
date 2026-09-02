import { describe, expect, it } from "vitest";

import type { QuietHoursInput, QuietHoursPort } from "@/lib/sends/contracts";

import { resolveLeadTimezones } from "./resolve-timezone";
import {
  createQuietHoursPort,
  decideQuietHours,
  type QuietHoursContext,
} from "./window";

const baseInput: QuietHoursInput = {
  tenantId: "tenant-a",
  contactId: "contact-a",
  channel: "sms",
  purpose: "follow_up",
  occurredAt: "2026-07-01T15:00:00.000Z",
  originalScheduledAt: "2026-07-01T15:00:00.000Z",
  deferredCount: 0,
};

const baseContext: QuietHoursContext = {
  followupId: "followup-a",
  contactTimezone: null,
  normalizedPhone: null,
  quietHoursStart: "08:00",
  quietHoursEnd: "20:00",
};

describe("resolveLeadTimezones", () => {
  it("uses a valid supplied IANA zone rather than widening from phone provenance", () => {
    expect(resolveLeadTimezones("Asia/Kolkata", "+1 208 555 0100")).toEqual({
      timezones: ["Asia/Kolkata"],
      source: "contact",
    });
  });

  it("keeps every ambiguous NPA candidate rather than choosing the first one", () => {
    expect(resolveLeadTimezones(null, "+1 208 555 0100")).toEqual({
      timezones: ["America/Boise", "America/Denver", "America/Los_Angeles"],
      source: "npa",
    });
  });

  it("rejects a non-US half-hour NPA from fallback rather than treating it as continental", () => {
    const resolution = resolveLeadTimezones(null, "+1 709 555 0100");
    expect(resolution).toEqual({
      timezones: [
        "America/New_York",
        "America/Chicago",
        "America/Denver",
        "America/Los_Angeles",
      ],
      source: "continental_intersection",
    });
    expect(resolution.timezones).not.toContain("America/St_Johns");
  });
});

describe("decideQuietHours", () => {
  it("opens the four-zone fallback only at 11 Eastern and 08 Pacific", () => {
    expect(decideQuietHours(baseInput, baseContext)).toEqual({ kind: "send_now" });
    const beforeOpen = decideQuietHours(
      { ...baseInput, occurredAt: "2026-07-01T14:59:59.999Z" },
      baseContext,
    );
    expect(beforeOpen.kind).toBe("defer_once");
    if (beforeOpen.kind === "defer_once") {
      expect(Date.parse(beforeOpen.at)).toBeGreaterThanOrEqual(Date.parse("2026-07-01T15:00:00Z"));
      expect(Date.parse(beforeOpen.at)).toBeLessThanOrEqual(Date.parse("2026-07-01T15:05:00Z"));
      expect(beforeOpen.allowedWindow).toBe("8:00 AM–8:00 PM");
      expect(beforeOpen.leadLocalTimes).toEqual([
        "America/New_York: 10:59 AM",
        "America/Chicago: 9:59 AM",
        "America/Denver: 8:59 AM",
        "America/Los_Angeles: 7:59 AM",
      ]);
    }
  });

  it("treats the closing edge as excluded rather than sending at 20 Eastern", () => {
    const result = decideQuietHours(
      {
        ...baseInput,
        occurredAt: "2026-07-02T00:00:00.000Z",
        originalScheduledAt: "2026-07-02T00:00:00.000Z",
      },
      baseContext,
    );
    expect(result.kind).toBe("defer_once");
  });

  it("clamps a widening tenant value to the platform-owned 08:00 to 20:00 floor", () => {
    const widened = { ...baseContext, quietHoursStart: "00:00", quietHoursEnd: "23:59" };
    expect(decideQuietHours({
      ...baseInput,
      occurredAt: "2026-07-01T14:59:59.999Z",
      originalScheduledAt: "2026-07-01T14:59:59.999Z",
    }, widened).kind).toBe("defer_once");
  });

  it("keeps spring-forward window edges on civil 08:00 and 20:00", () => {
    const context = { ...baseContext, contactTimezone: "America/New_York" };
    expect(decideQuietHours({
      ...baseInput,
      occurredAt: "2026-03-08T11:59:59.999Z",
      originalScheduledAt: "2026-03-08T11:59:59.999Z",
    }, context).kind).toBe("defer_once");
    expect(decideQuietHours({
      ...baseInput,
      occurredAt: "2026-03-08T12:00:00.000Z",
      originalScheduledAt: "2026-03-08T12:00:00.000Z",
    }, context)).toEqual({ kind: "send_now" });
  });

  it("keeps fall-back window edges on civil 08:00 and 20:00", () => {
    const context = { ...baseContext, contactTimezone: "America/New_York" };
    expect(decideQuietHours({
      ...baseInput,
      occurredAt: "2026-11-01T12:59:59.999Z",
      originalScheduledAt: "2026-11-01T12:59:59.999Z",
    }, context).kind).toBe("defer_once");
    expect(decideQuietHours({
      ...baseInput,
      occurredAt: "2026-11-01T13:00:00.000Z",
      originalScheduledAt: "2026-11-01T13:00:00.000Z",
    }, context)).toEqual({ kind: "send_now" });
  });

  it("intersects every ambiguous NPA zone rather than using its widest member", () => {
    const context = { ...baseContext, normalizedPhone: "+1 208 555 0100" };
    expect(decideQuietHours({
      ...baseInput,
      occurredAt: "2026-07-01T14:30:00.000Z",
      originalScheduledAt: "2026-07-01T14:30:00.000Z",
    }, context).kind).toBe("defer_once");
    expect(decideQuietHours(baseInput, context)).toEqual({ kind: "send_now" });
  });

  it("returns the same bounded opening jitter when a cron retry repeats the decision", () => {
    const input = {
      ...baseInput,
      occurredAt: "2026-07-01T14:00:00.000Z",
      originalScheduledAt: "2026-07-01T14:00:00.000Z",
    };
    expect(decideQuietHours(input, baseContext)).toEqual(decideQuietHours(input, baseContext));
  });

  it("permits one deferral and cancels instead of shifting a second time", () => {
    const input = {
      ...baseInput,
      occurredAt: "2026-07-01T14:00:00.000Z",
      originalScheduledAt: "2026-07-01T14:00:00.000Z",
    };
    expect(decideQuietHours(input, baseContext).kind).toBe("defer_once");
    expect(decideQuietHours({ ...input, deferredCount: 1 }, baseContext)).toEqual({
      kind: "cancel_stale",
      reason: "already_deferred",
    });
  });

  it("cancels work more than one day past its original schedule", () => {
    expect(decideQuietHours({
      ...baseInput,
      occurredAt: "2026-07-02T15:00:00.001Z",
      originalScheduledAt: "2026-07-01T15:00:00.000Z",
    }, baseContext)).toEqual({ kind: "cancel_stale", reason: "stale" });
  });

  it("allows enumerated control messages at any hour without a generic bypass", () => {
    expect(decideQuietHours({
      ...baseInput,
      purpose: "stop_confirmation",
      occurredAt: "2026-07-02T04:00:00.000Z",
    }, baseContext)).toEqual({ kind: "send_now" });
  });
});

describe("createQuietHoursPort", () => {
  it("satisfies the frozen asynchronous port with loaded contact evidence", async () => {
    const port: QuietHoursPort = createQuietHoursPort(async () => ({
      ...baseContext,
      contactTimezone: "America/New_York",
    }));
    await expect(port.resolve(baseInput)).resolves.toEqual({ kind: "send_now" });
  });
});
