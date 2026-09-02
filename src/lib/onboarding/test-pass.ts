/**
 * Honest proof step for grounded output and live calendar reads.
 *
 * The provider write method is never called: a real slot fetch proves connection health while the
 * returned receipt labels the booking write as simulated, preventing a test from creating an
 * external appointment or a billable appointment row.
 */

import type { CalendarConnection, CalendarSlot } from "@/lib/booking/types";
import type { CalendarDriver } from "@/lib/integrations/types";
import type { StepExecutor } from "@/lib/onboarding/contracts";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type GroundedTestTurnResult = {
  grounded: boolean;
  outputChecksPassed: boolean;
  citationIds: readonly string[];
  outputCheckRuleIds: readonly string[];
  unresolvedPlaceholders: readonly string[];
};

export type TestPassRepository = {
  loadPrimaryCalendar(tenantId: string): Promise<CalendarConnection | null>;
  recordCalendarSlotFetch(input: {
    tenantId: string;
    calendarConnectionId: string;
    ok: boolean;
    error: string | null;
    fetchedAt: string;
  }): Promise<void>;
};

export type TestPassDependencies = {
  runGroundedTurn(tenantId: string): Promise<GroundedTestTurnResult>;
  calendar: CalendarDriver;
  repository: TestPassRepository;
  now?: () => Date;
};

function boundedError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (message.trim() || "Calendar slot fetch failed").slice(0, 240);
}

function durationMinutes(slot: CalendarSlot | undefined) {
  if (!slot) return null;
  const duration = (Date.parse(slot.endAt) - Date.parse(slot.startAt)) / 60_000;
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

export function createTestPassExecutor({
  runGroundedTurn,
  calendar,
  repository,
  now = () => new Date(),
}: TestPassDependencies): StepExecutor {
  return async (attempt) => {
    if (attempt.stepKey !== "test_pass") throw new Error("ONBOARDING_EXECUTOR_STEP_MISMATCH:test_pass");
    const turn = await runGroundedTurn(attempt.tenantId);
    if (turn.unresolvedPlaceholders.length > 0) {
      return { kind: "awaiting_coach", code: "unresolved_placeholders" };
    }
    if (!turn.grounded) {
      return {
        kind: "retryable_failure",
        code: "TEST_PASS_GROUNDING_FAILED",
        safeMessage: "The grounded test reply did not cite published Brain evidence.",
      };
    }
    if (!turn.outputChecksPassed) {
      return {
        kind: "retryable_failure",
        code: "TEST_PASS_OUTPUT_CHECK_FAILED",
        safeMessage: "The test reply did not pass the output checks.",
      };
    }

    const connection = await repository.loadPrimaryCalendar(attempt.tenantId);
    if (!connection) return { kind: "awaiting_coach", code: "primary_calendar_missing" };
    if (connection.tenantId !== attempt.tenantId) throw new Error("CALENDAR_CONNECTION_TENANT_MISMATCH");
    const fetchedAt = now();
    const rangeEnd = new Date(fetchedAt.getTime() + 7 * 24 * 60 * 60_000);
    let slots: CalendarSlot[];
    try {
      slots = await calendar.fetchSlots({
        locationId: connection.externalLocationId,
        calendarId: connection.externalCalendarId,
        startAt: fetchedAt.toISOString(),
        endAt: rangeEnd.toISOString(),
        timezone: connection.timezone,
      });
      await repository.recordCalendarSlotFetch({
        tenantId: attempt.tenantId,
        calendarConnectionId: connection.id,
        ok: true,
        error: null,
        fetchedAt: fetchedAt.toISOString(),
      });
    } catch (error) {
      const message = boundedError(error);
      await repository.recordCalendarSlotFetch({
        tenantId: attempt.tenantId,
        calendarConnectionId: connection.id,
        ok: false,
        error: message,
        fetchedAt: fetchedAt.toISOString(),
      });
      return {
        kind: "retryable_failure",
        code: "TEST_PASS_SLOT_FETCH_FAILED",
        safeMessage: "The primary calendar could not return live availability.",
      };
    }

    return {
      kind: "done",
      externalRef: {
        test_receipt: {
          grounded: true,
          output_checks_passed: true,
          citation_ids: [...turn.citationIds],
          output_check_rule_ids: [...turn.outputCheckRuleIds],
          slot_fetch_at: fetchedAt.toISOString(),
          timezone: connection.timezone,
          duration_minutes: durationMinutes(slots[0]),
          simulated_write: true,
        },
      },
    };
  };
}

/** Live BOOK-01 health adapter; the grounded-turn port remains supplied by the engine owner. */
export function createLiveTestPassRepository(): TestPassRepository {
  const client = createSupabaseServiceClient();
  return {
    loadPrimaryCalendar: async (tenantId) => {
      const { data, error } = await client
        .from("calendar_connections")
        .select(`
          id, tenant_id, provider, external_calendar_id, external_location_id, timezone, booking_url
        `)
        .eq("tenant_id", tenantId)
        .eq("is_primary", true)
        .eq("state", "ready")
        .maybeSingle();
      if (error) throw new Error(`PRIMARY_CALENDAR_READ_FAILED:${error.message}`);
      if (!data) return null;
      return {
        id: data.id,
        tenantId: data.tenant_id,
        provider: data.provider,
        externalCalendarId: data.external_calendar_id,
        externalLocationId: data.external_location_id,
        timezone: data.timezone,
        bookingUrl: data.booking_url,
      } as CalendarConnection;
    },
    recordCalendarSlotFetch: async (input) => {
      const { error } = await client.rpc("record_calendar_slot_fetch", {
        p_expected_tenant: input.tenantId,
        p_calendar_connection_id: input.calendarConnectionId,
        p_ok: input.ok,
        p_error: input.error,
        p_fetched_at: input.fetchedAt,
      });
      if (error) throw new Error(`CALENDAR_SLOT_HEALTH_WRITE_FAILED:${error.message}`);
    },
  };
}
