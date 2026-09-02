/**
 * Fail-closed validation for measurement RPC evidence and step-event receipts.
 *
 * The database owns every value and window. Repositories validate that closed evidence rather
 * than repairing it, because coercing an invalid denominator or history state would manufacture
 * a number at the boundary where wrong analytics must stop.
 */

import {
  metricDefinition,
  type MetricEvidence,
  type MetricKey,
  type MetricState,
} from "@/lib/analytics/metric-definitions";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export class MeasurementEvidenceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MeasurementEvidenceError";
  }
}

export function evidenceObject(
  value: unknown,
  keys: readonly string[],
  code: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MeasurementEvidenceError(code);
  }
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(",") !== [...keys].sort().join(",")) {
    throw new MeasurementEvidenceError(code);
  }
  return candidate;
}

export function evidenceArray(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) throw new MeasurementEvidenceError(code);
  return value;
}

export function evidenceString(value: unknown, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new MeasurementEvidenceError(code);
  return value;
}

export function evidenceNullableString(value: unknown, code: string): string | null {
  return value === null ? null : evidenceString(value, code);
}

export function evidenceNumber(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MeasurementEvidenceError(code);
  }
  return value;
}

export function evidenceNonnegativeInteger(value: unknown, code: string): number {
  const parsed = evidenceNumber(value, code);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new MeasurementEvidenceError(code);
  return parsed;
}

export function evidenceIso(value: unknown, code: string): string {
  const parsed = evidenceString(value, code);
  if (!Number.isFinite(Date.parse(parsed))) throw new MeasurementEvidenceError(code);
  return parsed;
}

export function evidenceNullableIso(value: unknown, code: string): string | null {
  return value === null ? null : evidenceIso(value, code);
}

export function assertHalfOpenWindow(start: string, end: string, code: string) {
  if (Date.parse(start) >= Date.parse(end)) throw new MeasurementEvidenceError(code);
}

const METRIC_STATES = [
  "available",
  "still_filling",
  "needs_more_history",
  "unavailable",
] as const satisfies readonly MetricState[];

function metricState(value: unknown, code: string): MetricState {
  if (typeof value !== "string" || !METRIC_STATES.includes(value as MetricState)) {
    throw new MeasurementEvidenceError(code);
  }
  return value as MetricState;
}

function nullableMetricNumber(value: unknown, code: string): number | null {
  return value === null ? null : evidenceNumber(value, code);
}

export function parseMetricEvidenceRows(
  value: unknown,
  expectedKeys: readonly MetricKey[],
  options: {
    code: string;
    window: { start: string; end: string } | null;
    allowanceWindow?: { start: string; end: string } | null;
  },
): readonly MetricEvidence[] {
  const rows = evidenceArray(value, options.code);
  if (rows.length !== expectedKeys.length) throw new MeasurementEvidenceError(options.code);
  const expected = new Set<string>(expectedKeys);
  const seen = new Set<string>();
  const parsed = rows.map((value) => {
    const keys = options.window
      ? ["metricKey", "numerator", "denominator", "value", "state", "windowStart", "windowEnd"]
      : ["metricKey", "numerator", "denominator", "value", "state"];
    const row = evidenceObject(value, keys, options.code);
    const metricKey = evidenceString(row.metricKey, options.code);
    if (!expected.has(metricKey) || seen.has(metricKey)) {
      throw new MeasurementEvidenceError(options.code);
    }
    seen.add(metricKey);
    const definition = metricDefinition(metricKey);
    const numerator = nullableMetricNumber(row.numerator, options.code);
    const denominator = nullableMetricNumber(row.denominator, options.code);
    const metricValue = nullableMetricNumber(row.value, options.code);
    const state = metricState(row.state, options.code);

    // A row carrying a number is a claim and has to carry the population it was computed over.
    // A row carrying no number is an absence and only has to say which kind. A count of zero over
    // an empty population is a claim the database can support - it counted, and found none - so
    // refusing it turned the honest empty platform into a crash rather than into a zero.
    if (metricValue !== null) {
      if (state !== "available" && state !== "still_filling") {
        throw new MeasurementEvidenceError("MEASUREMENT_NONNUMERIC_STATE_REQUIRED");
      }
      if (
        denominator === null
        || denominator < 0
        || (definition.requiresPositiveDenominator && denominator === 0)
      ) {
        throw new MeasurementEvidenceError("MEASUREMENT_DENOMINATOR_REQUIRED");
      }
      if (definition.unit === "count" && (
        numerator === null
        || numerator < 0
        || !Number.isSafeInteger(numerator)
        || !Number.isSafeInteger(metricValue)
        || metricValue < 0
      )) {
        throw new MeasurementEvidenceError("MEASUREMENT_COUNT_INVALID");
      }
      if (definition.unit === "percent") {
        if (numerator === null || numerator < 0 || numerator > denominator) {
          throw new MeasurementEvidenceError("MEASUREMENT_RATE_POPULATION_INVALID");
        }
        if (metricValue < 0 || metricValue > 100) {
          throw new MeasurementEvidenceError("MEASUREMENT_RATE_VALUE_INVALID");
        }
      }
    } else {
      if (state === "available") {
        throw new MeasurementEvidenceError("MEASUREMENT_AVAILABLE_VALUE_REQUIRED");
      }
      if ((numerator !== null && numerator < 0) || (denominator !== null && denominator < 0)) {
        throw new MeasurementEvidenceError("MEASUREMENT_DENOMINATOR_REQUIRED");
      }
    }

    let windowStart: string | null = null;
    let windowEnd: string | null = null;
    if (options.window) {
      windowStart = evidenceNullableIso(row.windowStart, options.code);
      windowEnd = evidenceNullableIso(row.windowEnd, options.code);
      const expectedWindow = metricKey === "coach.allowance_used"
        || metricKey === "coach.allowance_limit"
        ? options.allowanceWindow ?? null
        : options.window;
      // A tenant with no active subscription has no billing period, so its two allowance rows
      // lose their window along with their numbers. An absent expected window admits an absent
      // row and nothing else: a claimed number with no window behind it is still refused.
      if (expectedWindow === null) {
        if (windowStart !== null || windowEnd !== null) {
          throw new MeasurementEvidenceError("MEASUREMENT_WINDOW_MISMATCH");
        }
        if (metricValue !== null) {
          throw new MeasurementEvidenceError("MEASUREMENT_WINDOW_REQUIRED");
        }
      } else {
        if (windowStart === null || windowEnd === null) {
          throw new MeasurementEvidenceError("MEASUREMENT_WINDOW_REQUIRED");
        }
        assertHalfOpenWindow(windowStart, windowEnd, "MEASUREMENT_WINDOW_INVALID");
        if (windowStart !== expectedWindow.start || windowEnd !== expectedWindow.end) {
          throw new MeasurementEvidenceError("MEASUREMENT_WINDOW_MISMATCH");
        }
      }
    }

    return {
      metricKey: metricKey as MetricKey,
      numerator,
      denominator,
      value: metricValue,
      state,
      windowStart,
      windowEnd,
    };
  });
  if (seen.size !== expected.size) throw new MeasurementEvidenceError(options.code);
  return parsed;
}

export type ConversationStepEvidenceInput = {
  expectedTenant: string;
  conversationId: string;
  leadMessageId: string;
  agentMessageId: string;
  answeredStepKey: string | null;
  askedStepKey: string | null;
};

export type ConversationStepEvidenceReceipt = ConversationStepEvidenceInput & {
  answeredEventId: string | null;
  askedEventId: string | null;
};

export type ConversationStepEvidenceRpcClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

function nullableStepKey(value: string | null) {
  if (value === null) return null;
  const key = value.trim();
  if (!key) throw new MeasurementEvidenceError("CONVERSATION_STEP_KEY_INVALID");
  return key;
}

export async function recordConversationStepEvents(
  input: ConversationStepEvidenceInput,
  client: ConversationStepEvidenceRpcClient = createSupabaseServiceClient(),
): Promise<ConversationStepEvidenceReceipt> {
  const expectedTenant = evidenceString(input.expectedTenant, "EXPECTED_TENANT_REQUIRED");
  const conversationId = evidenceString(
    input.conversationId,
    "CONVERSATION_STEP_EVIDENCE_INPUT_INVALID",
  );
  const leadMessageId = evidenceString(
    input.leadMessageId,
    "CONVERSATION_STEP_EVIDENCE_INPUT_INVALID",
  );
  const agentMessageId = evidenceString(
    input.agentMessageId,
    "CONVERSATION_STEP_EVIDENCE_INPUT_INVALID",
  );
  const answeredStepKey = nullableStepKey(input.answeredStepKey);
  const askedStepKey = nullableStepKey(input.askedStepKey);
  const { data, error } = await client.rpc("record_conversation_step_events", {
    p_expected_tenant: expectedTenant,
    p_conversation_id: conversationId,
    p_lead_message_id: leadMessageId,
    p_agent_message_id: agentMessageId,
    p_answered_step_key: answeredStepKey,
    p_asked_step_key: askedStepKey,
  });
  if (error) throw new MeasurementEvidenceError("CONVERSATION_STEP_EVIDENCE_WRITE_FAILED");
  const rows = evidenceArray(data, "CONVERSATION_STEP_EVIDENCE_RECEIPT_INVALID");
  if (rows.length !== 1) {
    throw new MeasurementEvidenceError("CONVERSATION_STEP_EVIDENCE_RECEIPT_INVALID");
  }
  const receipt = evidenceObject(rows[0], [
    "answered_event_id", "asked_event_id",
  ], "CONVERSATION_STEP_EVIDENCE_RECEIPT_INVALID");
  const answeredEventId = evidenceNullableString(
    receipt.answered_event_id,
    "CONVERSATION_STEP_EVIDENCE_RECEIPT_INVALID",
  );
  const askedEventId = evidenceNullableString(
    receipt.asked_event_id,
    "CONVERSATION_STEP_EVIDENCE_RECEIPT_INVALID",
  );
  if ((answeredStepKey === null) !== (answeredEventId === null)) {
    throw new MeasurementEvidenceError("CONVERSATION_STEP_EVIDENCE_RECEIPT_INVALID");
  }
  if ((askedStepKey === null) !== (askedEventId === null)) {
    throw new MeasurementEvidenceError("CONVERSATION_STEP_EVIDENCE_RECEIPT_INVALID");
  }
  return {
    expectedTenant,
    conversationId,
    leadMessageId,
    agentMessageId,
    answeredStepKey,
    askedStepKey,
    answeredEventId,
    askedEventId,
  };
}
