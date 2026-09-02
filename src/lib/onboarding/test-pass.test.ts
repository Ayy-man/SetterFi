import { describe, expect, it } from "vitest";

import type { CalendarConnection } from "@/lib/booking/types";
import type { CalendarDriver } from "@/lib/integrations/types";

import type { StepAttempt } from "./contracts";
import {
  createTestPassExecutor,
  type GroundedTestTurnResult,
  type TestPassRepository,
} from "./test-pass";

const TENANT = "51000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-17T12:00:00.000Z");

const ATTEMPT: StepAttempt = {
  tenantId: TENANT,
  stepKey: "test_pass",
  attemptId: "51000000-0000-4000-8000-000000000099",
  idempotencyKey: `${TENANT}:test_pass`,
  isDemo: false,
};

const CALENDAR: CalendarConnection = {
  id: "calendar-1",
  tenantId: TENANT,
  provider: "ghl",
  externalCalendarId: "external-calendar-1",
  externalLocationId: "external-location-1",
  timezone: "America/Chicago",
  bookingUrl: null,
};

const PASSING_TURN: GroundedTestTurnResult = {
  grounded: true,
  outputChecksPassed: true,
  citationIds: ["synthetic-citation"],
  outputCheckRuleIds: ["NUM-001", "CLAIM-001"],
  unresolvedPlaceholders: [],
};

function harness(overrides: {
  turn?: GroundedTestTurnResult;
  calendarConnection?: CalendarConnection | null;
  slotError?: Error;
} = {}) {
  const health: Array<Parameters<TestPassRepository["recordCalendarSlotFetch"]>[0]> = [];
  let appointmentWrites = 0;
  const repository: TestPassRepository = {
    loadPrimaryCalendar: async () => overrides.calendarConnection === undefined
      ? CALENDAR
      : overrides.calendarConnection,
    recordCalendarSlotFetch: async (input) => {
      health.push(input);
    },
  };
  const calendar: CalendarDriver = {
    fetchSlots: async (input) => {
      if (overrides.slotError) throw overrides.slotError;
      return [{
        id: "slot-1",
        startAt: input.startAt,
        endAt: new Date(Date.parse(input.startAt) + 30 * 60_000).toISOString(),
        timezone: input.timezone,
      }];
    },
    createAppointment: async () => {
      appointmentWrites += 1;
      return { externalId: "should-not-exist" };
    },
    updateAppointment: async (input) => ({ externalId: input.externalId }),
    cancelAppointment: async () => undefined,
    listAppointments: async () => [],
  };
  const executor = createTestPassExecutor({
    runGroundedTurn: async () => overrides.turn ?? PASSING_TURN,
    calendar,
    repository,
    now: () => NOW,
  });
  return { executor, health, appointmentWrites: () => appointmentWrites };
}

describe("test pass", () => {
  it("holds unresolved placeholders with the coach before claiming configuration is complete", async () => {
    const test = harness({
      turn: { ...PASSING_TURN, unresolvedPlaceholders: ["niche", "target funding amount"] },
    });
    await expect(test.executor(ATTEMPT)).resolves.toEqual({
      kind: "awaiting_coach",
      code: "unresolved_placeholders",
    });
    expect(test.health).toEqual([]);
  });

  it("fails separately when grounding or output checks do not pass", async () => {
    const ungrounded = harness({ turn: { ...PASSING_TURN, grounded: false } });
    await expect(ungrounded.executor(ATTEMPT)).resolves.toMatchObject({
      kind: "retryable_failure",
      code: "TEST_PASS_GROUNDING_FAILED",
    });
    const unsafe = harness({ turn: { ...PASSING_TURN, outputChecksPassed: false } });
    await expect(unsafe.executor(ATTEMPT)).resolves.toMatchObject({
      kind: "retryable_failure",
      code: "TEST_PASS_OUTPUT_CHECK_FAILED",
    });
  });

  it("waits for a primary calendar rather than inventing a live slot fetch", async () => {
    const test = harness({ calendarConnection: null });
    await expect(test.executor(ATTEMPT)).resolves.toEqual({
      kind: "awaiting_coach",
      code: "primary_calendar_missing",
    });
  });

  it("persists failed BOOK-01 health and returns no false test receipt", async () => {
    const test = harness({ slotError: new Error("Synthetic calendar timeout") });
    await expect(test.executor(ATTEMPT)).resolves.toMatchObject({
      kind: "retryable_failure",
      code: "TEST_PASS_SLOT_FETCH_FAILED",
    });
    expect(test.health).toEqual([{
      tenantId: TENANT,
      calendarConnectionId: CALENDAR.id,
      ok: false,
      error: "Synthetic calendar timeout",
      fetchedAt: NOW.toISOString(),
    }]);
    expect(test.appointmentWrites()).toBe(0);
  });

  it("returns a grounded live-read receipt with a labelled simulated write and zero appointments", async () => {
    const test = harness();
    await expect(test.executor(ATTEMPT)).resolves.toEqual({
      kind: "done",
      externalRef: {
        test_receipt: {
          grounded: true,
          output_checks_passed: true,
          citation_ids: ["synthetic-citation"],
          output_check_rule_ids: ["NUM-001", "CLAIM-001"],
          slot_fetch_at: NOW.toISOString(),
          timezone: "America/Chicago",
          duration_minutes: 30,
          simulated_write: true,
        },
      },
    });
    expect(test.health).toEqual([{
      tenantId: TENANT,
      calendarConnectionId: CALENDAR.id,
      ok: true,
      error: null,
      fetchedAt: NOW.toISOString(),
    }]);
    expect(test.appointmentWrites()).toBe(0);
  });

  it("refuses a calendar row from another tenant before the provider call", async () => {
    const test = harness({ calendarConnection: { ...CALENDAR, tenantId: "other-tenant" } });
    await expect(test.executor(ATTEMPT)).rejects.toThrow(/CALENDAR_CONNECTION_TENANT_MISMATCH/);
    expect(test.health).toEqual([]);
  });
});
