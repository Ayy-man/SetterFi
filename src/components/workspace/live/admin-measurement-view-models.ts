/**
 * Role-projected platform measurement over the validated Phase 7 snapshot.
 *
 * The projection is the serialization boundary: success users receive operational evidence only,
 * so restricted economics cannot reach the browser as fields that JSX merely chooses to hide.
 */

import {
  availableMetric,
  metricDefinition,
  PLATFORM_METRIC_KEYS,
  type MetricEvidence,
  type MetricKey,
  type MetricState,
} from "@/lib/analytics/metric-definitions";
import type { UserRole } from "@/lib/auth/claims";
import { utcTimestampLabel } from "@/lib/format/datetime";
import type { PlatformMeasurement } from "@/lib/repositories/platform-analytics";

export const ADMIN_MEASUREMENT_KPI_KEYS = PLATFORM_METRIC_KEYS;

export const SUCCESS_RESTRICTED_METRIC_KEYS = [
  "platform.gross_mrr",
  "platform.affiliate_commission",
  "platform.margin",
] as const satisfies readonly MetricKey[];

export type PlatformMeasurementRole = Extract<UserRole, "owner" | "admin" | "success">;

export type PlatformMetricDescriptorView = {
  denominator: string;
  window: string;
  clock: string;
  text: string;
};

export type PlatformMetricView = {
  key: (typeof ADMIN_MEASUREMENT_KPI_KEYS)[number];
  label: string;
  value: string | null;
  absenceLabel: "Unavailable" | "No completed events yet" | "Needs more history" | null;
  descriptor: PlatformMetricDescriptorView;
};

export type SuccessTenantPerformanceRow = {
  tenantId: string;
  bookedAppointments: number;
};

export type AdminMeasurementView = {
  role: PlatformMeasurementRole;
  metrics: readonly PlatformMetricView[];
  subscriptions: readonly Record<string, string>[];
  tenantPerformance: readonly (
    | PlatformMeasurement["tenantPerformance"][number]
    | SuccessTenantPerformanceRow
  )[];
  guardrailRules: PlatformMeasurement["guardrailRules"];
  followupPerformance: PlatformMeasurement["followupPerformance"];
  provisioningPerformance: PlatformMeasurement["provisioningPerformance"];
  history: PlatformMeasurement["history"];
};

export function platformMetricDisplay(
  view: Pick<PlatformMetricView, "value" | "absenceLabel">,
) {
  return view.value ?? view.absenceLabel ?? "Unavailable";
}

/**
 * The parameter name every platform metric writes its window against, and what a reader gets
 * instead.
 *
 * `metric-definitions.ts` is the measurement vocabulary, written for whoever has to reconcile a
 * number against the query that produced it, so its windows say "Trailing 30 days ending at asOf"
 * -- `asOf` being the argument the RPC takes. That is the right sentence in that file and a leaked
 * identifier the moment it reaches a screen, which is where it had been going: `/admin/agent-
 * performance` printed "Window: Trailing 30 days ending at asOf" under its heading, and the
 * methodology note on every KPI tile printed it again.
 *
 * Substituting at the projection rather than at either surface is deliberate. There are two
 * renderers of these strings and twenty-one definitions carrying the token, so a fix at a surface
 * fixes one of them and leaves the identifier on the other -- and the next surface to read a
 * descriptor inherits the leak. Here, a metric cannot be rendered without the substitution having
 * happened. The instant is the snapshot's own `asOf`, so the sentence names the moment the numbers
 * beside it were measured at rather than a re-read of the clock, and it is printed in UTC because
 * every definition carrying the token also declares `clock: "UTC."`.
 *
 * A snapshot whose `asOf` will not parse leaves the token unsubstituted rather than printing
 * "Invalid Date" or a silently wrong instant. That is the one case where the identifier can still
 * reach a screen, and it is the right trade: an unparseable measurement instant is a fault worth
 * seeing, and inventing a date to cover it would put a wrong number under a heading that claims to
 * say what was measured when.
 */
const AS_OF_TOKEN = /\basOf\b/gu;

function withAsOf(text: string, asOfLabel: string | null) {
  return asOfLabel ? text.replaceAll(AS_OF_TOKEN, asOfLabel) : text;
}

function descriptorFor(key: MetricKey, asOfLabel: string | null): PlatformMetricDescriptorView {
  const definition = metricDefinition(key);
  const denominator = withAsOf(definition.denominator, asOfLabel);
  const window = withAsOf(definition.window, asOfLabel);
  const clock = withAsOf(definition.clock, asOfLabel);
  return {
    denominator,
    window,
    clock,
    text: `Denominator: ${denominator} Window: ${window} Clock: ${clock}`,
  };
}

function absenceLabel(state: MetricState | "missing") {
  if (state === "still_filling") return "No completed events yet" as const;
  if (state === "needs_more_history") return "Needs more history" as const;
  return "Unavailable" as const;
}

function formatMetric(evidence: MetricEvidence, value: number) {
  const definition = metricDefinition(evidence.metricKey);
  if (definition.unit === "percent") return `${value}%`;
  if (definition.unit === "cents") {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(value / 100);
  }
  if (definition.unit === "seconds") {
    if (value < 60) return `${Math.round(value)} sec`;
    if (value < 3_600) return `${Math.round(value / 60)} min`;
    return `${Math.round((value / 3_600) * 10) / 10} hr`;
  }
  if (definition.unit === "days") return `${Math.round(value * 10) / 10} days`;
  return new Intl.NumberFormat("en").format(value);
}

function metricView(evidence: MetricEvidence, asOfLabel: string | null): PlatformMetricView {
  const definition = metricDefinition(evidence.metricKey);
  const numeric = availableMetric(evidence);
  return {
    key: evidence.metricKey as PlatformMetricView["key"],
    label: definition.label,
    value: numeric === null ? null : formatMetric(evidence, numeric),
    absenceLabel: numeric === null ? absenceLabel(evidence.state) : null,
    descriptor: descriptorFor(evidence.metricKey, asOfLabel),
  };
}

function isEconomicsMetric(key: MetricKey) {
  return metricDefinition(key).economics !== "none";
}

function assertPlatformRole(role: UserRole): asserts role is PlatformMeasurementRole {
  if (role !== "owner" && role !== "admin" && role !== "success") {
    throw new Error("PLATFORM_MEASUREMENT_ROLE_FORBIDDEN");
  }
}

export function adminMeasurementView(
  snapshot: PlatformMeasurement,
  role: UserRole,
): AdminMeasurementView {
  assertPlatformRole(role);
  const asOfLabel = utcTimestampLabel(snapshot.asOf);
  const metrics = snapshot.metrics
    .filter((row) => role !== "success" || !isEconomicsMetric(row.metricKey))
    .map((row) => metricView(row, asOfLabel));
  // Both roles are projected, not just the restricted one. The success arm was already field by
  // field while the owner/admin arm spread the row, so "a new field has to be admitted" held for
  // exactly the reader it did not need to hold for -- an unadmitted column reached an owner
  // untouched and would reach the next reader the moment someone widened the role test rather than
  // the projection. The economics fields on `tenantPerformance` are admitted here by name, which
  // is the point: they are legitimate for an owner and their presence is a decision on the page
  // rather than a consequence of the row's shape.
  const subscriptions = role === "success"
    ? snapshot.subscriptions.map(({ periodEnd, periodStart, status, tenantId }) => ({
        tenantId,
        status,
        periodStart,
        periodEnd,
      }))
    : snapshot.subscriptions.map(
        ({ periodEnd, periodStart, status, stripePriceId, subscriptionId, tenantId }) => ({
          tenantId,
          subscriptionId,
          status,
          stripePriceId,
          periodStart,
          periodEnd,
        }),
      );
  const tenantPerformance = role === "success"
    ? snapshot.tenantPerformance.map(({ bookedAppointments, tenantId }) => ({
        tenantId,
        bookedAppointments,
      }))
    : snapshot.tenantPerformance.map(
        ({
          bookedAppointments,
          commissionCents,
          grossMrrCents,
          marginCents,
          marginState,
          tenantId,
        }) => ({
          tenantId,
          bookedAppointments,
          grossMrrCents,
          commissionCents,
          marginCents,
          marginState,
        }),
      );

  return {
    role,
    metrics,
    subscriptions,
    tenantPerformance,
    // The remaining four are rebuilt field by field for the same reason the two above are, even
    // though none of them carries economics today. Spreading a row admits whatever the row grows:
    // the day a cost figure lands on a guardrail rule or a history period it reaches a success
    // reviewer with nobody having touched this function, and nobody will think to, because the
    // role logic will still read as correct. Naming the fields makes a new one invisible until
    // someone admits it deliberately, which is the only point at which the audience question gets
    // asked. `metrics` is filtered rather than projected because `MetricEvidence` already carries
    // its own audience in `metricDefinition().economics`.
    guardrailRules: snapshot.guardrailRules.map(({ blocks, fires, holds, label, ruleKey }) => ({
      blocks,
      fires,
      holds,
      label,
      ruleKey,
    })),
    followupPerformance: snapshot.followupPerformance.map(
      ({ crossChannel, exhausted, replied, sent, touchNo }) => ({
        crossChannel,
        exhausted,
        replied,
        sent,
        touchNo,
      }),
    ),
    provisioningPerformance: snapshot.provisioningPerformance.map(
      ({ attempts, failures, medianDaysToClear, state, stepKey }) => ({
        attempts,
        failures,
        medianDaysToClear,
        state,
        stepKey,
      }),
    ),
    history: snapshot.history.map(({ periodEnd, periodStart, state, value }) => ({
      periodEnd,
      periodStart,
      state,
      value,
    })),
  };
}

export function provisioningStateLabel(stepKey: string, state: string) {
  if (state === "awaiting_provider" && /a2p|sms/iu.test(stepKey)) {
    return "Registering · carrier review takes 2–3 weeks";
  }
  if (state === "blocked" && /a2p|sms/iu.test(stepKey)) return "Permanently blocked";
  const labels: Record<string, string> = {
    pending: "Pending",
    running: "Running",
    awaiting_coach: "Awaiting coach",
    awaiting_platform: "Awaiting platform",
    awaiting_provider: "Awaiting provider",
    done: "Done",
    failed: "Failed",
    blocked: "Blocked",
  };
  return labels[state] ?? "Unavailable";
}
