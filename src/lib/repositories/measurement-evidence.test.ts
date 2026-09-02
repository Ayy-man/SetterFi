import { describe, expect, it, vi } from "vitest";

import {
  parseMetricEvidenceRows,
  recordConversationStepEvents,
} from "./measurement-evidence";

const WINDOW = {
  start: "2026-08-01T00:00:00.000Z",
  end: "2026-08-02T00:00:00.000Z",
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    metricKey: "coach.conversion_rate",
    numerator: 5,
    denominator: 10,
    value: 50,
    state: "available",
    windowStart: WINDOW.start,
    windowEnd: WINDOW.end,
    ...overrides,
  };
}

describe("measurement evidence", () => {
  it("retains exact database evidence without rounding or coercion", () => {
    expect(parseMetricEvidenceRows([row({ value: 33.333333 })], ["coach.conversion_rate"], {
      code: "COACH_METRIC_SET_INVALID",
      window: WINDOW,
    })).toEqual([row({ value: 33.333333 })]);
  });

  it("rejects a null or negative denominator rather than inventing a population", () => {
    for (const denominator of [null, -1]) {
      expect(() => parseMetricEvidenceRows([row({ denominator })], ["coach.conversion_rate"], {
        code: "COACH_METRIC_SET_INVALID",
        window: WINDOW,
      })).toThrow("MEASUREMENT_DENOMINATOR_REQUIRED");
    }
  });

  it("accepts a zero positive-denominator population only as explicit absence", () => {
    const absent = {
      metricKey: "platform.cross_channel_continuation_rate",
      numerator: 0,
      denominator: 0,
      value: null,
      state: "unavailable",
    };
    expect(parseMetricEvidenceRows(
      [absent],
      ["platform.cross_channel_continuation_rate"],
      { code: "PLATFORM_METRIC_SET_INVALID", window: null },
    )).toEqual([{ ...absent, windowStart: null, windowEnd: null }]);
    expect(() => parseMetricEvidenceRows(
      [{ ...absent, value: 0, state: "available" }],
      ["platform.cross_channel_continuation_rate"],
      { code: "PLATFORM_METRIC_SET_INVALID", window: null },
    )).toThrow("MEASUREMENT_DENOMINATOR_REQUIRED");
  });

  it("rejects numeric history/unavailable states and numerator drift", () => {
    expect(() => parseMetricEvidenceRows([row({ state: "needs_more_history" })], [
      "coach.conversion_rate",
    ], { code: "COACH_METRIC_SET_INVALID", window: WINDOW }))
      .toThrow("MEASUREMENT_NONNUMERIC_STATE_REQUIRED");
    expect(() => parseMetricEvidenceRows([row({ numerator: 11 })], ["coach.conversion_rate"], {
      code: "COACH_METRIC_SET_INVALID",
      window: WINDOW,
    })).toThrow("MEASUREMENT_RATE_POPULATION_INVALID");
  });

  it("calls the six-argument step RPC and retains both persisted message ids", async () => {
    const rpc = vi.fn(async () => ({
      data: [{ answered_event_id: "answered-event-1", asked_event_id: "asked-event-1" }],
      error: null,
    }));
    await expect(recordConversationStepEvents({
      expectedTenant: "tenant-1",
      conversationId: "conversation-1",
      leadMessageId: "lead-message-1",
      agentMessageId: "agent-message-1",
      answeredStepKey: " credit ",
      askedStepKey: "goal",
    }, { rpc })).resolves.toEqual({
      expectedTenant: "tenant-1",
      conversationId: "conversation-1",
      leadMessageId: "lead-message-1",
      agentMessageId: "agent-message-1",
      answeredStepKey: "credit",
      askedStepKey: "goal",
      answeredEventId: "answered-event-1",
      askedEventId: "asked-event-1",
    });
    expect(rpc).toHaveBeenCalledWith("record_conversation_step_events", {
      p_expected_tenant: "tenant-1",
      p_conversation_id: "conversation-1",
      p_lead_message_id: "lead-message-1",
      p_agent_message_id: "agent-message-1",
      p_answered_step_key: "credit",
      p_asked_step_key: "goal",
    });
  });

  it("passes exact null step facts and rejects a mismatched receipt", async () => {
    await expect(recordConversationStepEvents({
      expectedTenant: "tenant-1",
      conversationId: "conversation-1",
      leadMessageId: "lead-message-1",
      agentMessageId: "agent-message-1",
      answeredStepKey: null,
      askedStepKey: null,
    }, {
      rpc: async () => ({
        data: [{ answered_event_id: null, asked_event_id: null }],
        error: null,
      }),
    })).resolves.toMatchObject({ answeredEventId: null, askedEventId: null });

    await expect(recordConversationStepEvents({
      expectedTenant: "tenant-1",
      conversationId: "conversation-1",
      leadMessageId: "lead-message-1",
      agentMessageId: "agent-message-1",
      answeredStepKey: "credit",
      askedStepKey: null,
    }, {
      rpc: async () => ({
        data: [{ answered_event_id: null, asked_event_id: null }],
        error: null,
      }),
    })).rejects.toThrow("CONVERSATION_STEP_EVIDENCE_RECEIPT_INVALID");
  });
});

const PLATFORM_OPTIONS = { code: "PLATFORM_METRIC_SET_INVALID", window: null } as const;

function coachOptions(allowanceWindow: { start: string; end: string } | null = WINDOW) {
  return { code: "COACH_METRIC_SET_INVALID", window: WINDOW, allowanceWindow };
}

describe("the five row shapes the measurement RPCs actually emit", () => {
  it("accepts a count of zero over an empty population as evidence, not absence", () => {
    const zeroCount = {
      metricKey: "platform.new_signups",
      numerator: 0,
      denominator: 0,
      value: 0,
      state: "available",
    };
    expect(parseMetricEvidenceRows([zeroCount], ["platform.new_signups"], PLATFORM_OPTIONS))
      .toEqual([{ ...zeroCount, windowStart: null, windowEnd: null }]);
  });

  it("accepts an unavailable margin whose numerator is null rather than zero", () => {
    const margin = {
      metricKey: "platform.margin",
      numerator: null,
      denominator: 0,
      value: null,
      state: "unavailable",
    };
    expect(parseMetricEvidenceRows([margin], ["platform.margin"], PLATFORM_OPTIONS))
      .toEqual([{ ...margin, windowStart: null, windowEnd: null }]);
  });

  it("accepts a still-filling coach rate whose window contains no leads at all", () => {
    const stillFilling = {
      metricKey: "coach.conversion_rate",
      numerator: 0,
      denominator: 0,
      value: null,
      state: "still_filling",
      windowStart: WINDOW.start,
      windowEnd: WINDOW.end,
    };
    expect(parseMetricEvidenceRows([stillFilling], ["coach.conversion_rate"], coachOptions()))
      .toEqual([stillFilling]);
  });

  it("accepts an allowance row with no billing period to report", () => {
    const allowance = {
      metricKey: "coach.allowance_used",
      numerator: null,
      denominator: null,
      value: null,
      state: "unavailable",
      windowStart: null,
      windowEnd: null,
    };
    expect(parseMetricEvidenceRows([allowance], ["coach.allowance_used"], coachOptions(null)))
      .toEqual([allowance]);
  });

  it("still refuses an allowance row that claims a number with no period behind it", () => {
    const claimed = {
      metricKey: "coach.allowance_used",
      numerator: 3,
      denominator: 3,
      value: 3,
      state: "available",
      windowStart: null,
      windowEnd: null,
    };
    expect(() => parseMetricEvidenceRows([claimed], ["coach.allowance_used"], coachOptions(null)))
      .toThrow("MEASUREMENT_WINDOW_REQUIRED");
    expect(() => parseMetricEvidenceRows([{
      ...claimed,
      value: null,
      state: "unavailable",
      windowStart: WINDOW.start,
      windowEnd: WINDOW.end,
    }], ["coach.allowance_used"], coachOptions(null))).toThrow("MEASUREMENT_WINDOW_MISMATCH");
  });
});

describe("the refusals a value-led policy keeps", () => {
  it("refuses a claimed number that arrives without one", () => {
    expect(() => parseMetricEvidenceRows([row({ value: null })], ["coach.conversion_rate"],
      coachOptions())).toThrow("MEASUREMENT_AVAILABLE_VALUE_REQUIRED");
  });

  it("refuses a rate rendered over an empty or missing population", () => {
    for (const denominator of [0, null]) {
      expect(() => parseMetricEvidenceRows([row({ numerator: 0, denominator, value: 0 })],
        ["coach.conversion_rate"], coachOptions())).toThrow("MEASUREMENT_DENOMINATOR_REQUIRED");
    }
    expect(() => parseMetricEvidenceRows([row({
      metricKey: "coach.new_leads",
      numerator: 2,
      denominator: -1,
      value: 2,
    })], ["coach.new_leads"], coachOptions())).toThrow("MEASUREMENT_DENOMINATOR_REQUIRED");
  });

  it("refuses a negative or fractional count and a numerator past its own denominator", () => {
    for (const value of [-1, 1.5]) {
      expect(() => parseMetricEvidenceRows([row({
        metricKey: "coach.new_leads",
        numerator: 10,
        denominator: 10,
        value,
      })], ["coach.new_leads"], coachOptions())).toThrow("MEASUREMENT_COUNT_INVALID");
    }
    expect(() => parseMetricEvidenceRows([row({ numerator: 11 })], ["coach.conversion_rate"],
      coachOptions())).toThrow("MEASUREMENT_RATE_POPULATION_INVALID");
  });

  it("refuses a number carried under a state that says there is none", () => {
    expect(() => parseMetricEvidenceRows([row({ state: "unavailable" })],
      ["coach.conversion_rate"], coachOptions())).toThrow("MEASUREMENT_NONNUMERIC_STATE_REQUIRED");
  });

  it("refuses a wrong key, a duplicate key, and a short row array with the caller's own code", () => {
    expect(() => parseMetricEvidenceRows([row({ metricKey: "platform.margin" })],
      ["coach.conversion_rate"], coachOptions())).toThrow("COACH_METRIC_SET_INVALID");
    expect(() => parseMetricEvidenceRows([row(), row()],
      ["coach.conversion_rate", "coach.new_leads"], coachOptions()))
      .toThrow("COACH_METRIC_SET_INVALID");
    expect(() => parseMetricEvidenceRows([row()],
      ["coach.conversion_rate", "coach.new_leads"], coachOptions()))
      .toThrow("COACH_METRIC_SET_INVALID");
    expect(() => parseMetricEvidenceRows([{ ...row(), extra: 1 }], ["coach.conversion_rate"],
      coachOptions())).toThrow("COACH_METRIC_SET_INVALID");
  });

  it("refuses a window that disagrees with the one the reader asked for", () => {
    expect(() => parseMetricEvidenceRows([row({ windowEnd: "2026-08-03T00:00:00.000Z" })],
      ["coach.conversion_rate"], coachOptions())).toThrow("MEASUREMENT_WINDOW_MISMATCH");
    expect(() => parseMetricEvidenceRows([row({ windowStart: null, windowEnd: null })],
      ["coach.conversion_rate"], coachOptions())).toThrow("MEASUREMENT_WINDOW_REQUIRED");
  });
});
