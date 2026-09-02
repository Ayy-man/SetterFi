/**
 * Platform measurement projection over the single Phase 7 aggregate RPC.
 *
 * The local subscription mirror and complete Phase 6 margin view are the only money inputs. The
 * repository refuses partial arrays, pricing, margin, and history evidence instead of filling it.
 * The signup history arrives as a contiguous series of N 30-day periods (20260914000001); the
 * repository checks that they abut rather than assuming any particular count.
 */

import {
  PLATFORM_METRIC_KEYS,
  type MetricEvidence,
} from "@/lib/analytics/metric-definitions";
import { platformPreviewDataEnabled } from "@/lib/env-contract";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

import {
  assertHalfOpenWindow,
  evidenceArray,
  evidenceIso,
  evidenceNonnegativeInteger,
  evidenceNumber,
  evidenceObject,
  evidenceString,
  MeasurementEvidenceError,
  parseMetricEvidenceRows,
} from "./measurement-evidence";

/**
 * How many contiguous 30-day periods the signup series asks for.
 *
 * Six is half a year at the resolution the platform records signups, which is enough for a trend
 * to have a shape and short enough that every period fits the panel it is drawn in. The RPC clamps
 * the request to between two and twelve (20260914000001), so this is a request, not a promise: a
 * platform younger than six periods gets fewer periods marked `needs_more_history`, never invented
 * ones.
 */
export const PLATFORM_HISTORY_PERIODS = 6;

export type PlatformMeasurementSource = (actorId: string, asOf: string) => Promise<unknown>;
export type PlatformMeasurementOrigin = "real_analytics" | "synthetic_preview";

/**
 * A selected measurement source did not return evidence. Callers must render their unavailable
 * state instead of selecting another source, because a fallback could turn an outage into
 * invented platform performance.
 */
export class PlatformMeasurementUnavailableError extends Error {
  readonly code = "PLATFORM_MEASUREMENT_UNAVAILABLE";
  readonly state = "unavailable";

  constructor(readonly source: PlatformMeasurementOrigin) {
    super(`Platform measurement is unavailable from ${source}.`);
    this.name = "PlatformMeasurementUnavailableError";
  }
}

export type PlatformMeasurement = {
  origin?: PlatformMeasurementOrigin;
  asOf: string;
  metrics: readonly MetricEvidence[];
  subscriptions: readonly {
    tenantId: string;
    subscriptionId: string;
    status: string;
    stripePriceId: string;
    periodStart: string;
    periodEnd: string;
  }[];
  tenantPerformance: readonly {
    tenantId: string;
    bookedAppointments: number;
    grossMrrCents: number | null;
    commissionCents: number;
    marginCents: number | null;
    marginState: "available" | "unavailable";
  }[];
  guardrailRules: readonly {
    ruleKey: string;
    label: string;
    fires: number;
    blocks: number;
    holds: number;
  }[];
  followupPerformance: readonly {
    touchNo: number;
    sent: number;
    replied: number;
    crossChannel: number;
    exhausted: number;
  }[];
  provisioningPerformance: readonly {
    stepKey: string;
    state: string;
    attempts: number;
    failures: number;
    medianDaysToClear: number | null;
  }[];
  history: readonly {
    periodStart: string;
    periodEnd: string;
    value: number;
    state: "available" | "needs_more_history";
  }[];
};

export async function platformMeasurementSource(actorId: string, asOf: string) {
  const client = createSupabaseServiceClient();
  if (platformPreviewDataEnabled()) {
    const { data, error } = await client.rpc("read_platform_measurement_preview_for_actor", {
      p_actor_id: actorId,
    });
    if (error || data === null || data === undefined) {
      throw new PlatformMeasurementUnavailableError("synthetic_preview");
    }
    if (typeof data !== "object" || Array.isArray(data)) {
      throw new MeasurementEvidenceError("PLATFORM_PREVIEW_SNAPSHOT_INVALID");
    }
    // The stored values are intentionally static, but the read is always stamped with the
    // caller's as-of instant so the same validation contract applies to real and preview data.
    return { origin: "synthetic_preview", snapshot: { ...data, asOf } };
  }
  const { data, error } = await client.rpc("read_platform_measurement_for_actor", {
    p_actor_id: actorId,
    p_as_of: asOf,
    p_history_periods: PLATFORM_HISTORY_PERIODS,
  });
  if (error || data === null || data === undefined) {
    throw new PlatformMeasurementUnavailableError("real_analytics");
  }
  return { origin: "real_analytics", snapshot: data };
}

function count(value: unknown, code = "PLATFORM_MEASUREMENT_SNAPSHOT_INVALID") {
  return evidenceNonnegativeInteger(value, code);
}

function sourceEnvelope(value: unknown): { origin: PlatformMeasurementOrigin; snapshot: unknown } {
  // Test and caller-provided sources predate the review-preview envelope.  Treating their plain
  // RPC-shaped payload as real analytics preserves that narrow injection seam while the live
  // source records its provenance explicitly.
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !("origin" in value) || !("snapshot" in value)) {
    return { origin: "real_analytics", snapshot: value };
  }
  const wrapped = evidenceObject(value, ["origin", "snapshot"], "PLATFORM_MEASUREMENT_SOURCE_INVALID");
  if (wrapped.origin === "synthetic_preview") return { origin: "synthetic_preview", snapshot: wrapped.snapshot };
  if (wrapped.origin === "real_analytics") return { origin: "real_analytics", snapshot: wrapped.snapshot };
  throw new MeasurementEvidenceError("PLATFORM_MEASUREMENT_SOURCE_INVALID");
}

export async function loadPlatformMeasurement(
  actorId: string,
  asOf: string,
  source: PlatformMeasurementSource = platformMeasurementSource,
): Promise<PlatformMeasurement> {
  const actor = evidenceString(actorId, "MEASUREMENT_ACTOR_REQUIRED");
  const requestedAsOf = evidenceIso(asOf, "PLATFORM_MEASUREMENT_AS_OF_INVALID");
  const envelope = sourceEnvelope(await source(actor, requestedAsOf));
  const raw = evidenceObject(envelope.snapshot, [
    "asOf", "metrics", "subscriptions", "tenantPerformance", "guardrailRules",
    "followupPerformance", "provisioningPerformance", "history",
  ], "PLATFORM_MEASUREMENT_SNAPSHOT_INVALID");
  const persistedAsOf = evidenceIso(raw.asOf, "PLATFORM_MEASUREMENT_SNAPSHOT_INVALID");
  // Instant equality, not string equality: the RPC serializes timestamptz as +00:00 while the
  // caller requests with a trailing Z, and the same moment must not read as a mismatch.
  if (Date.parse(persistedAsOf) !== Date.parse(requestedAsOf)) {
    throw new MeasurementEvidenceError("PLATFORM_MEASUREMENT_AS_OF_MISMATCH");
  }
  const metrics = parseMetricEvidenceRows(raw.metrics, PLATFORM_METRIC_KEYS, {
    code: "PLATFORM_METRIC_SET_INVALID",
    window: null,
  });
  // The row has to be present, but it is allowed to say the projection does not exist yet. Its
  // own state carries that, and the parser already refuses an available row with no value, so a
  // second veto here only turned a platform without a cost rollup into a dead page.
  if (!metrics.some((metric) => metric.metricKey === "platform.margin")) {
    throw new MeasurementEvidenceError("PLATFORM_MARGIN_EVIDENCE_INCOMPLETE");
  }

  const subscriptions = evidenceArray(
    raw.subscriptions,
    "PLATFORM_SUBSCRIPTIONS_INVALID",
  ).map((value) => {
    const row = evidenceObject(value, [
      "tenantId", "subscriptionId", "status", "stripePriceId", "periodStart", "periodEnd",
    ], "PLATFORM_SUBSCRIPTIONS_INVALID");
    const periodStart = evidenceIso(row.periodStart, "PLATFORM_SUBSCRIPTIONS_INVALID");
    const periodEnd = evidenceIso(row.periodEnd, "PLATFORM_SUBSCRIPTIONS_INVALID");
    assertHalfOpenWindow(periodStart, periodEnd, "PLATFORM_SUBSCRIPTIONS_INVALID");
    return {
      tenantId: evidenceString(row.tenantId, "PLATFORM_SUBSCRIPTIONS_INVALID"),
      subscriptionId: evidenceString(row.subscriptionId, "PLATFORM_SUBSCRIPTIONS_INVALID"),
      status: evidenceString(row.status, "PLATFORM_SUBSCRIPTIONS_INVALID"),
      stripePriceId: evidenceString(row.stripePriceId, "PLATFORM_SUBSCRIPTIONS_INVALID"),
      periodStart,
      periodEnd,
    };
  });

  const tenantPerformance = evidenceArray(
    raw.tenantPerformance,
    "PLATFORM_TENANT_PERFORMANCE_INVALID",
  ).map((value) => {
    const row = evidenceObject(value, [
      "tenantId", "bookedAppointments", "grossMrrCents", "commissionCents", "marginCents",
      "marginState",
    ], "PLATFORM_TENANT_PERFORMANCE_INVALID");
    // A tenant that signed up before its first cost rollup has no margin projection, and one
    // without an active priced subscription has no gross MRR either. Both arrive as an explicit
    // null the table already knows how to print; only a state that claims a number it does not
    // carry is incoherent.
    const marginState: "available" | "unavailable" | null =
      row.marginState === "available" || row.marginState === "unavailable"
        ? row.marginState
        : null;
    if (marginState === null) {
      throw new MeasurementEvidenceError("PLATFORM_TENANT_PERFORMANCE_INVALID");
    }
    if (marginState === "available" && row.marginCents === null) {
      throw new MeasurementEvidenceError("PLATFORM_MARGIN_EVIDENCE_INCOMPLETE");
    }
    return {
      tenantId: evidenceString(row.tenantId, "PLATFORM_TENANT_PERFORMANCE_INVALID"),
      bookedAppointments: count(row.bookedAppointments, "PLATFORM_TENANT_PERFORMANCE_INVALID"),
      grossMrrCents: row.grossMrrCents === null
        ? null
        : evidenceNumber(row.grossMrrCents, "PLATFORM_TENANT_PERFORMANCE_INVALID"),
      commissionCents: evidenceNumber(row.commissionCents, "PLATFORM_TENANT_PERFORMANCE_INVALID"),
      marginCents: row.marginCents === null
        ? null
        : evidenceNumber(row.marginCents, "PLATFORM_TENANT_PERFORMANCE_INVALID"),
      marginState,
    };
  });

  const guardrailRules = evidenceArray(
    raw.guardrailRules,
    "PLATFORM_GUARDRAIL_ROWS_INVALID",
  ).map((value) => {
    const row = evidenceObject(value, [
      "ruleKey", "label", "fires", "blocks", "holds",
    ], "PLATFORM_GUARDRAIL_ROWS_INVALID");
    const fires = count(row.fires, "PLATFORM_GUARDRAIL_ROWS_INVALID");
    const blocks = count(row.blocks, "PLATFORM_GUARDRAIL_ROWS_INVALID");
    const holds = count(row.holds, "PLATFORM_GUARDRAIL_ROWS_INVALID");
    if (blocks > fires || holds > fires) {
      throw new MeasurementEvidenceError("PLATFORM_GUARDRAIL_ROWS_INVALID");
    }
    return {
      ruleKey: evidenceString(row.ruleKey, "PLATFORM_GUARDRAIL_ROWS_INVALID"),
      label: evidenceString(row.label, "PLATFORM_GUARDRAIL_ROWS_INVALID"),
      fires,
      blocks,
      holds,
    };
  });

  const followupPerformance = evidenceArray(
    raw.followupPerformance,
    "PLATFORM_FOLLOWUP_ROWS_INVALID",
  ).map((value) => {
    const row = evidenceObject(value, [
      "touchNo", "sent", "replied", "crossChannel", "exhausted",
    ], "PLATFORM_FOLLOWUP_ROWS_INVALID");
    const sent = count(row.sent, "PLATFORM_FOLLOWUP_ROWS_INVALID");
    const replied = count(row.replied, "PLATFORM_FOLLOWUP_ROWS_INVALID");
    const crossChannel = count(row.crossChannel, "PLATFORM_FOLLOWUP_ROWS_INVALID");
    const exhausted = count(row.exhausted, "PLATFORM_FOLLOWUP_ROWS_INVALID");
    if (replied > sent || crossChannel > sent) {
      throw new MeasurementEvidenceError("PLATFORM_FOLLOWUP_ROWS_INVALID");
    }
    return {
      touchNo: count(row.touchNo, "PLATFORM_FOLLOWUP_ROWS_INVALID"),
      sent,
      replied,
      crossChannel,
      exhausted,
    };
  });

  const provisioningPerformance = evidenceArray(
    raw.provisioningPerformance,
    "PLATFORM_PROVISIONING_ROWS_INVALID",
  ).map((value) => {
    const row = evidenceObject(value, [
      "stepKey", "state", "attempts", "failures", "medianDaysToClear",
    ], "PLATFORM_PROVISIONING_ROWS_INVALID");
    const attempts = count(row.attempts, "PLATFORM_PROVISIONING_ROWS_INVALID");
    const failures = count(row.failures, "PLATFORM_PROVISIONING_ROWS_INVALID");
    if (failures > attempts) {
      throw new MeasurementEvidenceError("PLATFORM_PROVISIONING_ROWS_INVALID");
    }
    const medianDaysToClear = row.medianDaysToClear === null
      ? null
      : evidenceNumber(row.medianDaysToClear, "PLATFORM_PROVISIONING_ROWS_INVALID");
    if (medianDaysToClear !== null && medianDaysToClear < 0) {
      throw new MeasurementEvidenceError("PLATFORM_PROVISIONING_ROWS_INVALID");
    }
    return {
      stepKey: evidenceString(row.stepKey, "PLATFORM_PROVISIONING_ROWS_INVALID"),
      state: evidenceString(row.state, "PLATFORM_PROVISIONING_ROWS_INVALID"),
      attempts,
      failures,
      medianDaysToClear,
    };
  });

  const history = evidenceArray(raw.history, "PLATFORM_HISTORY_INVALID").map((value) => {
    const row = evidenceObject(value, [
      "periodStart", "periodEnd", "value", "state",
    ], "PLATFORM_HISTORY_INVALID");
    // The RPC emits exactly two states here (20260914000001): `available`, and
    // `needs_more_history` for a period that closed before the platform had its first tenant.
    // That state describes how much history stands behind the series, not a missing number -
    // the count is a real count over a real period, and refusing it took the whole page down on
    // an empty platform. What is still refused is a row that names a period and supplies no
    // number for it, because the chart would then draw a gap it cannot account for.
    const state: "available" | "needs_more_history" | null =
      row.state === "available" || row.state === "needs_more_history" ? row.state : null;
    if (state === null) {
      throw new MeasurementEvidenceError("PLATFORM_HISTORY_UNAVAILABLE");
    }
    const periodStart = evidenceIso(row.periodStart, "PLATFORM_HISTORY_INVALID");
    const periodEnd = evidenceIso(row.periodEnd, "PLATFORM_HISTORY_INVALID");
    assertHalfOpenWindow(periodStart, periodEnd, "PLATFORM_HISTORY_INVALID");
    return {
      periodStart,
      periodEnd,
      value: count(row.value, "PLATFORM_HISTORY_INVALID"),
      state,
    };
  });
  // A series, not a fixed pair. Two periods is still the floor - one point is a dot, and a growth
  // comparison needs something to compare against - but the length is now whatever the RPC was
  // asked for. Every period has to abut the next one: a chart drawn from periods with a gap
  // between them shows a slope across time nobody measured.
  if (history.length < 2) {
    throw new MeasurementEvidenceError("PLATFORM_HISTORY_INVALID");
  }
  for (let index = 1; index < history.length; index += 1) {
    if (Date.parse(history[index - 1].periodEnd) !== Date.parse(history[index].periodStart)) {
      throw new MeasurementEvidenceError("PLATFORM_HISTORY_INVALID");
    }
  }

  return {
    origin: envelope.origin,
    // The requested spelling is the caller's canonical form; the persisted value proved equal.
    asOf: requestedAsOf,
    metrics,
    subscriptions,
    tenantPerformance,
    guardrailRules,
    followupPerformance,
    provisioningPerformance,
    history,
  };
}
