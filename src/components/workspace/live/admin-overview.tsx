import { ArrowRight } from "@/components/kit/icons";

import Link from "next/link";
import { Fragment, type ReactNode } from "react";

import {
  AxisTicks,
  BAR_SPARKLINE_MIN_POINTS,
  BarSparkline,
  Figure,
  FunnelBars,
  KeyValueList,
  MetricCard,
  MonoMeta,
  Overline,
  ProgressBar,
  Surface,
  SurfaceHeader,
  type FunnelStep as FunnelBarStep,
  type KeyValueRow,
  type Tone,
} from "@/components/kit/atomics";
import { ExportMenu } from "@/components/kit/export-menu";
import type { MetricAvailability } from "@/components/kit/headline-stat";
import type { StateTone } from "@/components/kit/state-badge";
import { DetailPage } from "@/components/kit/templates/detail-page";
import { ListPage } from "@/components/kit/templates/list-page";
import {
  metricDefinition,
  type MetricEvidence,
  type MetricUnit,
} from "@/lib/analytics/metric-definitions";
import { formatMetric } from "@/lib/format/metric";
import { cn } from "@/lib/utils";
import type { PlatformMeasurement } from "@/lib/repositories/platform-analytics";

import {
  ATTENTION_NOW,
  ATTENTION_SOON,
  AttentionQueueTable,
  FollowupPerformanceTable,
  GuardrailRulesTable,
  ProvisioningPerformanceTable,
  SubscriptionsTable,
  type AttentionRow,
  type SubscriptionRow,
} from "./admin-measurement-tables";
import {
  adminMeasurementView,
  platformMetricDisplay,
  provisioningStateLabel,
  type PlatformMetricView,
  type PlatformMeasurementRole,
} from "./admin-measurement-view-models";

type AdminOverviewProps = {
  measurement: PlatformMeasurement;
  role: PlatformMeasurementRole;
};

export type AdminExceptionCategory = {
  title: string;
  count: number;
  tone: "warning" | "critical" | "info";
  href: string;
  note: string;
  /** Why the rows are waiting, from the same evidence the count is taken off. */
  reason?: string;
};

export const PLATFORM_DETAIL_HREF = "/admin/overview/detail";

// The four figures are chosen, not filled: revenue, growth, the population earning it, and the
// rate that eats it. Everything else is a number nobody opens the home page to see, so it lives on
// the platform detail page. A role that cannot see revenue simply gets fewer.
//
// The order is the hero order: the first entry the role is allowed to see becomes the page's one
// 44px figure and the rest fall into the strip beside it. Revenue leads for an owner because it is
// the number the platform owner opens this page for; a success reviewer, refused revenue, leads on
// signups instead.
//
// Five tiles beside the hero, which is the canvas's strip. Two of them -- median time to live and
// margin -- are new here and both have a metric key with real evidence behind it. The canvas's
// third addition, cost per booked call, is not: `metric-definitions.ts` declares 25 `platform.*`
// keys and not one of them is a cost rate, and `platform.margin` is cents with no call
// denominator, so drawing that tile would mean deriving a figure the platform does not measure.
// The tile is left out rather than approximated: a figure the platform does not measure is not a
// figure this page may draw.
const HEADLINE_METRIC_KEYS = [
  "platform.gross_mrr",
  "platform.new_signups",
  "platform.active_subscriptions",
  "platform.churn_rate",
  "platform.time_to_live",
  "platform.margin",
] as const satisfies readonly PlatformMetricView["key"][];
// Read once in the acquisition funnel, so they never take a tile in the strip.
const FUNNEL_METRIC_KEYS = new Set<string>([
  "platform.booked_appointments",
  "platform.no_show_rate",
]);
const EXPORT_REASON = "platform-measurement-surface-read";

const HUMAN_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

function humanDate(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Date not recorded" : HUMAN_DATE.format(parsed);
}

function metricFormat(unit: MetricUnit) {
  if (unit === "cents") return "money" as const;
  if (unit === "percent") return "percent" as const;
  if (unit === "seconds") return "duration" as const;
  return "count" as const;
}

function metricLabel(metric: MetricEvidence) {
  const definition = metricDefinition(metric.metricKey);
  return definition.unit === "days" ? `${definition.label}, days` : definition.label;
}

function noEventsNote(
  metric: MetricEvidence,
  absenceReason: PlatformMetricView["absenceLabel"],
) {
  if (absenceReason === "Needs more history") {
    if (metric.metricKey === "platform.growth_rate") {
      return "No prior-period subscription population yet";
    }
    if (metric.metricKey === "platform.time_to_live") {
      return "No completed onboarding runs yet";
    }
    if (metric.metricKey === "platform.a2p_median_days_to_clear") {
      return "No approved filings yet";
    }
    return "No completed evidence yet";
  }
  if (absenceReason === "No completed events yet") return "No completed events yet in this period";
  const unit = metricDefinition(metric.metricKey).unit;
  if (unit === "cents") return "No recorded amount in this period";
  if (unit === "percent") return "No matching events in this period";
  return "No recorded events in this period";
}

function metricAvailability(
  metric: MetricEvidence,
  absenceReason: PlatformMetricView["absenceLabel"],
): MetricAvailability {
  const definition = metricDefinition(metric.metricKey);

  const undefinedRatio =
    definition.unit === "percent"
    && !(typeof metric.denominator === "number" && metric.denominator > 0);

  if (metric.state === "available" && metric.value !== null && !undefinedRatio) {
    return {
      kind: "value",
      value: metric.value,
      format: metricFormat(definition.unit),
    };
  }

  if (undefinedRatio || absenceReason === "Needs more history" || absenceReason === "No completed events yet"
    || metric.denominator === 0 || metric.numerator === 0) {
    return { kind: "unavailable", note: noEventsNote(metric, absenceReason) };
  }

  return {
    kind: "not-connected",
    source: "Required source evidence is missing",
    action: { href: "/admin/agent-performance", label: "Review evidence" },
  };
}

function evidenceFor(measurement: PlatformMeasurement, key: string) {
  return measurement.metrics.find((row) => row.metricKey === key) ?? null;
}

function availabilityOf(
  measurement: PlatformMeasurement,
  visibleMetrics: readonly PlatformMetricView[],
  key: string,
): MetricAvailability | null {
  const visibleMetric = visibleMetrics.find((row) => row.key === key);
  const metric = evidenceFor(measurement, key);
  if (!visibleMetric || !metric) return null;
  return metricAvailability(metric, visibleMetric.absenceLabel);
}

/**
 * The four tiles across the top of the overview, transcribed from 1b.
 *
 * 1b draws four KPI tiles of one species: a mono overline, a 27px figure, one line saying what the
 * figure is a share of, and a footer that is either a sparkline or a progress bar. The tiles here
 * are the same object, and every one of them is a metric the platform snapshot actually carries.
 * What the tiles are *of* is not the drawing's: 1b's TOTAL LEADS / BOOKING RATE / MEDIAN FIRST
 * REPLY / DISQUALIFIED are per-client figures with no cross-tenant projection behind them, so
 * transcribing them literally would have meant four invented numbers on the client's first screen.
 *
 * A role that cannot see revenue simply gets fewer tiles. Nothing is promoted into the gap: a
 * success reviewer's overview is three tiles wide, not four with a substitute in the money slot.
 */
type HeadlineTile = {
  key: string;
  overline: string;
  /** The formatted reading, or null when the snapshot has no number for this period. */
  value: string | null;
  /** Why there is no number. Only read when `value` is null. */
  absence: string;
  note: string;
  tone: Tone;
  /** The signup series, drawn under the figure. Only the signup tile has one. */
  series: readonly number[] | null;
  /** A share the figure is literally of, from the metric's own numerator and denominator. */
  share: { ratio: number; label: string } | null;
  delta: { text: string; tone: Tone } | null;
};

/** Active revenue-bearing subscriptions, counted from the rows rather than asserted. */
function activeSubscriptionCount(measurement: PlatformMeasurement) {
  return measurement.subscriptions.filter((row) => /^(active|trialing)$/iu.test(row.status)).length;
}

/**
 * The three figures under the hero's hairline, which the canvas draws as Active clients, Booked
 * calls and Blended margin.
 *
 * All three are read, none is derived. Active clients is counted off the subscription rows, booked
 * calls is `platform.booked_appointments`, and margin is `platform.margin` -- the Phase 6
 * projection, which is the one surface in the product where cost and margin are allowed to be real
 * at all. Each renders its own absence rather than a zero, because a substat row is exactly where
 * a missing projection would otherwise read as break-even.
 *
 * **Margin is money here, not the canvas's "87.7%".** `platform.margin` is defined in cents over
 * `platform_margin_projection`, and turning it into a percentage needs a revenue denominator the
 * metric does not carry. Dividing it by gross MRR would produce a number that looks like the
 * drawing and answers a different question, on the one screen where a wrong margin figure is worst.
 * The canvas's own note for the tile -- "revenue less model spend" -- is what the cents figure
 * literally is, so the note is kept and the unit is not faked.
 *
 * A success reviewer never reaches the margin entry: `adminMeasurementView` drops every metric
 * whose `economics` is not `none` before the projection is serialized, so it is absent from the
 * data rather than hidden by this component. The row is two figures wide for that role.
 */
type HeroSubstat = { key: string; label: string; value: string | null; absence: string };

function heroSubstats(
  measurement: PlatformMeasurement,
  visibleMetrics: readonly PlatformMetricView[],
): HeroSubstat[] {
  const active = activeSubscriptionCount(measurement);
  const entries: HeroSubstat[] = [{
    key: "active-clients",
    label: active === 1 ? "Active client" : "Active clients",
    value: formatMetric(active, "count"),
    absence: "",
  }];

  for (const key of ["platform.booked_appointments", "platform.margin"] as const) {
    const metric = evidenceFor(measurement, key);
    const availability = availabilityOf(measurement, visibleMetrics, key);
    // No entry at all when the role is refused the metric, rather than an entry reading "-".
    // A dash implies a figure exists and is empty; refusal means it was never serialized.
    if (!metric || !availability) continue;
    const value = figureValue(metric, availability);
    entries.push({
      key,
      label: key === "platform.margin" ? "Margin" : "Booked calls",
      value,
      absence: value === null ? absenceNote(availability) : "",
    });
  }

  return entries;
}

function signupDelta(history: PlatformMeasurement["history"]) {
  const previous = history.at(-2);
  const current = history.at(-1);
  if (!previous || !current) return null;
  const difference = current.value - previous.value;
  if (difference === 0) {
    return { text: `level with ${periodLabel(previous.periodStart)}`, tone: "neutral" as Tone };
  }
  return {
    // The sign is spelled with a real minus so the mono column lines up with the figures above it.
    text: `${difference > 0 ? "+" : "\u2212"}${formatMetric(Math.abs(difference), "count")}`,
    tone: difference > 0 ? ("good" as Tone) : ("failure" as Tone),
  };
}

function headlineTiles(
  measurement: PlatformMeasurement,
  visibleMetrics: readonly PlatformMetricView[],
): HeadlineTile[] {
  const active = activeSubscriptionCount(measurement);
  const pastDue = measurement.subscriptions.filter((row) =>
    /past_due|unpaid|incomplete/iu.test(row.status),
  ).length;
  const churnThreshold = THRESHOLDS.find((row) => row.key === "platform.churn_rate");

  return HEADLINE_METRIC_KEYS.flatMap((key) => {
    const metric = evidenceFor(measurement, key);
    const availability = availabilityOf(measurement, visibleMetrics, key);
    if (!metric || !availability) return [];

    const value = figureValue(metric, availability);
    const reading = availability.kind === "value" ? availability.value : null;
    const tile: HeadlineTile = {
      key,
      overline: metricDefinition(key).label,
      value,
      absence: value === null ? absenceNote(availability) : "",
      note: "",
      tone: "neutral",
      series: null,
      share: null,
      delta: null,
    };

    if (key === "platform.gross_mrr") {
      // Both halves of this sentence are counted from the subscription rows, so the tile cannot
      // claim a population the table below it would contradict.
      tile.note = `across ${formatMetric(active, "count")} active ${active === 1 ? "subscription" : "subscriptions"}`;
      return [tile];
    }

    if (key === "platform.new_signups") {
      tile.note = "trailing 30 days";
      tile.delta = signupDelta(measurement.history);
      tile.series = measurement.history.map((period) => period.value);
      return [tile];
    }

    if (key === "platform.active_subscriptions") {
      tile.note = pastDue > 0
        ? `${formatMetric(pastDue, "count")} past due`
        : "none past due";
      return [tile];
    }

    if (key === "platform.time_to_live") {
      /*
       * The unit moves into the label, which is the convention `metricLabel` already carries for
       * every days-unit figure on this page. A tile's figure slot holds a reading or the absence
       * dash and nothing else -- "5.0 days" in the slot puts a word where the reader's eye is
       * trained to find only a number, and `admin-overview.test.tsx` refuses it outright.
       */
      tile.overline = metricLabel(metric);
      tile.value = reading === null ? null : ONE_DECIMAL.format(reading);
      // The definition's own window, said in words. Naming it matters more here than on the other
      // tiles: a median that silently covered all time and one that covers the last thirty days
      // are different claims about whether onboarding is getting faster, and the reader cannot
      // tell them apart from the figure.
      tile.note = "median across runs that went live in the last 30 days";
      return [tile];
    }

    if (key === "platform.margin") {
      /*
       * Money, and only money. The canvas draws this as "Gross margin 87.7%", and a percentage is
       * exactly what `platform.margin` cannot supply: it is margin cents off
       * `platform_margin_projection`, which carries no revenue denominator, so dividing it by
       * gross MRR would produce a number that looks like the drawing and answers a different
       * question. The label the metric registry already gives it is the honest one, and the note
       * says which period it covers so the figure is not read as a rate.
       */
      tile.note = "projected over the current margin period, from complete cost evidence only";
      return [tile];
    }

    // Churn is 1b's fourth tile: the one figure on the row that is allowed to be the bad news, and
    // the only one that takes a tone. It takes clay only when it is actually over the watch line;
    // a permanently clay tile is decoration, not a claim.
    const boundary = churnThreshold ? Number.parseFloat(churnThreshold.boundary) : null;
    const breached = reading !== null && boundary !== null && reading > boundary;
    tile.tone = breached ? "failure" : "neutral";
    tile.note = churnThreshold
      ? watchLineNote(churnThreshold.boundary, churnThreshold.direction, breached)
      : "";
    if (
      typeof metric.numerator === "number"
      && typeof metric.denominator === "number"
      && metric.denominator > 0
    ) {
      tile.share = {
        ratio: metric.numerator / metric.denominator,
        label: `Churn: ${formatMetric(metric.numerator, "count")} of ${formatMetric(metric.denominator, "count")} subscriptions`,
      };
    }
    return [tile];
  });
}

/**
 * The one drenched figure the console screen is allowed.
 *
 * The lead tile was already the lead: `HEADLINE_METRIC_KEYS` is documented as "the hero order --
 * the first entry the role is allowed to see becomes the page's one figure and the rest fall into
 * the strip beside it", and the page had been drawing that intent as a fourth identical tile. The
 * reader could not tell which of four equal rectangles the page was for.
 *
 * So the lead tile moves out of the strip and into a drenched deck panel, and the rule it carries
 * is unchanged: revenue leads for an owner, a success reviewer refused revenue leads on signups,
 * and nothing is promoted into the gap. `admin-overview.test.tsx` still reads the whole row in
 * order -- hero first, then the strip -- and asserts the same three things it always did.
 *
 * **One drench per console screen**, which is why this panel is the only fill on Overview and why
 * the tiles below it stay on the card face. `console.css` says the same thing in its own words.
 *
 * The absence convention survives the move intact. A tile with no reading renders the dash and
 * puts the reason beside it, so a drenched hero can say "no figure and here is why" as plainly as
 * a small tile could -- a hero that quietly rendered nothing would be the loudest dishonest state
 * on the platform.
 */
function HeadlineHero({ substats, tile }: { substats: readonly HeroSubstat[]; tile: HeadlineTile }) {
  return (
    <section
      aria-labelledby="overview-headline-hero-name"
      className="coach-panel"
      data-drench="live"
      data-hero="true"
      data-slot="overview-headline-hero"
    >
      <header className="coach-panel__header">
        <div className="min-w-0">
          {/*
            The 9.5px uppercase overline, which is alive and correct here. It was taken off the
            coach surfaces because coaches over 55 could not read it; on the console it is the
            category role `docs/DESIGN.md` defines and `src/app/overline-size.test.ts` pins in
            five places, and the panel's own name carries the metric underneath it.
          */}
          <Overline className="coach-panel__eyebrow block">Platform pulse</Overline>
          <h2 className="coach-panel__name" id="overview-headline-hero-name">
            {tile.overline}
          </h2>
        </div>
      </header>
      <div className="coach-panel__body">
        <div className="flex flex-wrap items-baseline gap-x-[var(--s-3)] gap-y-[var(--s-1)]">
          <Figure className="coach-panel__figure" size="xl" tone="neutral">
            {tile.value === null ? (
              <span data-slot="headline-tile-absent" style={{ color: "var(--faint)" }}>
                {"–"}
              </span>
            ) : (
              tile.value
            )}
          </Figure>
          {tile.delta ? (
            <span
              className="mono text-[12.5px] font-[500] tabular-nums"
              data-slot="metric-card-delta"
              style={{ color: "var(--console-on-drench-sub)" }}
            >
              {tile.delta.text}
            </span>
          ) : null}
        </div>
        <p className="coach-panel__sentence" data-slot="metric-card-note">
          {tile.value === null ? tile.absence : tile.note}
        </p>
        {tile.series && tile.series.length >= BAR_SPARKLINE_MIN_POINTS ? (
          <BarSparkline
            className="mt-[var(--s-3)]"
            emphasisCount={1}
            label={`${tile.overline} by 30-day period`}
            points={tile.series}
            tone="accent"
          />
        ) : null}
        {substats.length > 0 ? (
          <div className="coach-panel__footer console-substat" data-slot="overview-hero-substats">
            {substats.map((stat) => (
              <span key={stat.key}>
                <strong className="console-substat__figure">
                  {stat.value ?? <span style={{ color: "var(--console-on-drench-sub)" }}>{"–"}</span>}
                </strong>
                {/*
                  The label carries the absence when there is one, so a missing projection reads as
                  "Margin, not projected for this period" rather than as a dash nobody can account
                  for. Same convention as the tiles, at substat size.
                */}
                <i className="console-substat__label">{stat.value === null ? `${stat.label}, ${stat.absence.toLowerCase()}` : stat.label}</i>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * What the snapshot can honestly say about the fleet, which is less than the canvas draws.
 *
 * `AdminOverview.dc.html:257-274` puts a 108px donut reading **98.6 platform health** beside
 * "Fleet coverage 23/24 agents healthy" and an amber "1 isolated issue" pill. Two of those three
 * are not buildable and they fail for different reasons, so they are handled differently:
 *
 *   - **The 98.6 composite is not defined anywhere.** No metric key, no rollup, no formula in
 *     `metric-definitions.ts`. A score is a claim about how the platform is doing overall, and one
 *     assembled on a page out of whatever numbers were to hand is a number nobody can audit or
 *     reproduce. It is omitted rather than approximated.
 *   - **"Agents healthy" is not a measurement this read carries.** `PlatformMeasurement` has no
 *     agent dimension at all: `tenantPerformance` is booked calls and margin per tenant,
 *     `guardrailRules` is keyed by rule, `provisioningPerformance` by step. Calling a client with
 *     a paid subscription a healthy agent would be inventing the join.
 *
 * What the read does carry per client is the subscription state, so the ratio counts exactly that
 * and says so in its own label. The closing sentence names the exceptions the ratio cannot include
 * rather than letting a reader take it for a whole-fleet all-clear -- three of the four categories
 * in the queue below have no client dimension in this read, so a client blocked in provisioning
 * still counts as clear here.
 */
export function fleetSubscriptionHealth(measurement: PlatformMeasurement) {
  const clients = new Set<string>();
  for (const row of measurement.tenantPerformance) clients.add(row.tenantId);
  for (const row of measurement.subscriptions) clients.add(row.tenantId);

  const troubled = new Set(
    measurement.subscriptions
      .filter((subscription) => /past_due|unpaid|incomplete/iu.test(subscription.status))
      .map((subscription) => subscription.tenantId),
  );

  return { clients: clients.size, troubled: troubled.size, clear: clients.size - troubled.size };
}

export function FleetHealthPanel({ measurement }: { measurement: PlatformMeasurement }) {
  const { clear, clients, troubled } = fleetSubscriptionHealth(measurement);

  return (
    <Surface
      aria-labelledby="fleet-health-heading"
      as="section"
      className="flex min-w-0 flex-col"
      data-slot="fleet-health-panel"
      variant="panel"
    >
      <Overline className="mb-[var(--s-2)] block" id="fleet-health-heading">
        Fleet
      </Overline>
      {clients === 0 ? (
        <p className="m-0 text-body text-[var(--muted)]" data-slot="fleet-health-absent">
          This snapshot names no client, so there is no fleet to count.
        </p>
      ) : (
        <>
          <div className="flex items-baseline gap-[var(--s-2)]">
            <Figure data-slot="fleet-health-figure" size="lg" tone="neutral">
              {clear}
            </Figure>
            <span className="mono text-[19px] text-[var(--muted)] tabular-nums">{`/${clients}`}</span>
          </div>
          <p className="mt-[var(--s-1)] mb-0 text-body text-[var(--body)]">
            clients with no subscription in trouble
          </p>
          {troubled > 0 ? (
            <p className="mt-[var(--s-3)] mb-0" data-slot="fleet-health-exception">
              {/*
                A pill rather than an edge stripe, and the dot carries the tone as well as the
                colour, because the console's rule is that colour alone never carries meaning.
              */}
              <span className="inline-flex items-center gap-[6px] rounded-[var(--r-input)] border border-[var(--line)] bg-[var(--well)] px-[9px] py-[3px] text-[12.5px] font-medium text-[color:var(--warning-text)]">
                <span
                  aria-hidden
                  className="size-[6px] rounded-full"
                  style={{ background: "var(--warning)" }}
                />
                {`${troubled} ${troubled === 1 ? "client" : "clients"} past due, unpaid or incomplete`}
              </span>
            </p>
          ) : null}
          <p className="mt-auto pt-[var(--s-4)] mb-0 text-body text-[var(--muted)]">
            Subscription state only. Provisioning blocks, held replies and exhausted cadences are
            counted in the queue below and carry no client dimension in this read, so a client with
            one still counts as clear here.
          </p>
        </>
      )}
    </Surface>
  );
}

export function HeadlineTiles({
  fleet,
  substats = [],
  tiles,
}: {
  /** The panel beside the hero on the lead row. Omitted and the hero takes the full width. */
  fleet?: ReactNode;
  substats?: readonly HeroSubstat[];
  tiles: readonly HeadlineTile[];
}) {
  if (tiles.length === 0) return null;
  const [lead, ...rest] = tiles;
  return (
    <div className="flex flex-col gap-[13px]" data-slot="overview-headline-tiles">
      {/*
        The canvas's lead row: the drenched hero at 1.5fr beside the fleet panel at 1fr, which is
        what `console-deck--lead` already declares. With no panel to put beside it the hero keeps
        the full width rather than sitting in a half-empty grid.
      */}
      <div className={fleet ? "console-deck console-deck--lead" : undefined} data-slot="overview-lead-row">
        {lead ? <HeadlineHero substats={substats} tile={lead} /> : null}
        {fleet}
      </div>
      <div className="console-deck">
      {rest.map((tile) => (
        <MetricCard
          delta={tile.delta ? tile.delta.text : undefined}
          deltaTone={tile.delta?.tone}
          footer={
            tile.series && tile.series.length >= BAR_SPARKLINE_MIN_POINTS ? (
              <BarSparkline
                emphasisCount={1}
                label={`${tile.overline} by 30-day period`}
                points={tile.series}
                tone="accent"
              />
            ) : tile.share ? (
              <ProgressBar
                height={4}
                label={tile.share.label}
                tone={tile.tone === "neutral" ? "accent" : tile.tone}
                value={tile.share.ratio}
              />
            ) : undefined
          }
          key={tile.key}
          note={tile.value === null ? tile.absence : tile.note}
          overline={tile.overline}
          tone={tile.tone}
          value={
            tile.value === null ? (
              // The dash never stands alone: the reason sits beside it as the tile's own note,
              // which is the absence convention every figure on this page follows.
              <span data-slot="headline-tile-absent" style={{ color: "var(--faint)" }}>
                {"\u2013"}
              </span>
            ) : (
              tile.value
            )
          }
        />
      ))}
      </div>
    </div>
  );
}

type FunnelStage = {
  label: string;
  availability: MetricAvailability;
  note: string;
  step?: string;
};

const UNMEASURED_LEADS: MetricAvailability = {
  kind: "unavailable",
  note: "Lead volume is recorded per client, not across the platform yet",
};

const UNMEASURED_QUALIFIED: MetricAvailability = {
  kind: "unavailable",
  note: "Qualification counts are recorded per client, not across the platform yet",
};

/**
 * The acquisition sequence, built only from metrics the platform snapshot actually carries.
 *
 * Platform measurement records booked appointments and the no-show rate, so the booked stage and
 * the show-rate aside are real. There is no cross-tenant lead or qualification count, so those two
 * stages render their absence instead of a number the snapshot cannot support.
 */
function acquisitionFunnel(
  measurement: PlatformMeasurement,
  visibleMetrics: readonly PlatformMetricView[],
): { stages: FunnelStage[]; showRate: FunnelStage } {
  const booked = availabilityOf(measurement, visibleMetrics, "platform.booked_appointments");
  const noShow = availabilityOf(measurement, visibleMetrics, "platform.no_show_rate");

  const stages: FunnelStage[] = [
    { label: "New leads", availability: UNMEASURED_LEADS, note: "Across every client" },
    {
      label: "Qualified",
      availability: UNMEASURED_QUALIFIED,
      note: "Met the brain's qualification bar",
      step: "qualified",
    },
    {
      label: "Booked appointments",
      availability: booked ?? { kind: "unavailable", note: "Not recorded in this snapshot" },
      note: "Confirmed calendar slots only",
      step: "booked",
    },
  ];

  const showRate: FunnelStage = noShow && noShow.kind === "value"
    ? {
        label: "Show rate",
        availability: {
          kind: "value",
          value: Math.round((100 - noShow.value) * 10) / 10,
          format: "percent",
        },
        note: "The complement of the recorded no-show rate",
      }
    : {
        label: "Show rate",
        availability: {
          kind: "unavailable",
          note: "No recorded attendance yet",
        },
        note: "Reads once attendance is recorded against booked appointments",
      };

  return { stages, showRate };
}

function stageValue(stage: FunnelStage) {
  return stage.availability.kind === "value" ? stage.availability.value : null;
}

function conversionLabel(from: FunnelStage, to: FunnelStage) {
  const previous = stageValue(from);
  const current = stageValue(to);
  if (previous === null || current === null || previous <= 0) return null;
  return `${Math.round((current / previous) * 100)}%`;
}

function FunnelFigure({ availability }: { availability: MetricAvailability }) {
  if (availability.kind === "value") {
    return (
      <span className="text-title tabular-nums text-[var(--ink)]" data-slot="funnel-figure">
        {formatMetric(availability.value, availability.format)}
      </span>
    );
  }
  // The dash never stands alone: FunnelNote renders the reason sentence beside it,
  // matching the strip's established absence convention.
  return (
    <span className="text-title tabular-nums text-[var(--faint)]" data-slot="funnel-figure">
      {"–"}
    </span>
  );
}

function FunnelNote({ stage }: { stage: FunnelStage }) {
  const note = stage.availability.kind === "value"
    ? stage.note
    : "note" in stage.availability
      ? stage.availability.note
      : stage.note;
  return <span className="text-badge font-normal text-[var(--faint)]">{note}</span>;
}

function FunnelStageCell({ className, stage }: { className?: string; stage: FunnelStage }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-[var(--s-1)] pr-[var(--s-5)]", className)}>
      <span className="text-badge text-[var(--muted)]">{stage.label}</span>
      <FunnelFigure availability={stage.availability} />
      <FunnelNote stage={stage} />
    </div>
  );
}

function FunnelStep({ from, to }: { from: FunnelStage; to: FunnelStage }) {
  const conversion = conversionLabel(from, to);
  return (
    <div className="flex flex-col items-center justify-center gap-[var(--s-1)] pr-[var(--s-5)] text-badge whitespace-nowrap text-[var(--muted)]">
      <ArrowRight aria-hidden className="size-[var(--s-4)] text-[var(--line-strong)]" />
      <span>
        {conversion === null ? (
          "Rate needs both stages"
        ) : (
          <>
            <b className="font-semibold tabular-nums text-[var(--body)]">{conversion}</b>{" "}
            {to.step}
          </>
        )}
      </span>
    </div>
  );
}

export function AcquisitionFunnel({
  stages,
  showRate,
}: {
  stages: readonly FunnelStage[];
  showRate: FunnelStage;
}) {
  return (
    <section aria-labelledby="acquisition-heading" className="flex flex-col gap-[var(--s-3)]">
      <div className="flex flex-wrap items-baseline justify-between gap-[var(--s-2)]">
        <h2 className="m-0 text-section text-[var(--ink)]" id="acquisition-heading">
          Acquisition
        </h2>
        <span className="text-badge text-[var(--faint)]">
          Every client in this measurement snapshot
        </span>
      </div>
      <div
        className="flex flex-wrap items-stretch border-y border-[var(--line)] py-[var(--s-4)]"
        data-slot="acquisition-funnel"
      >
        {stages.map((stage, index) => (
          <Fragment key={stage.label}>
            {index > 0 ? <FunnelStep from={stages[index - 1]!} to={stage} /> : null}
            <FunnelStageCell stage={stage} />
          </Fragment>
        ))}
        <FunnelStageCell
          className="ml-auto justify-center border-l border-[var(--line)] pr-0 pl-[var(--s-5)]"
          stage={showRate}
        />
      </div>
    </section>
  );
}

function exceptionCategories(measurement: PlatformMeasurement): AdminExceptionCategory[] {
  const overdueSubscriptions = measurement.subscriptions.filter((subscription) =>
    /past_due|unpaid|incomplete/iu.test(subscription.status),
  ).length;
  const provisioningBlocks = measurement.provisioningPerformance
    .filter((row) => row.state === "blocked" || row.state === "failed")
    .reduce((total, row) => total + row.failures, 0);

  const heldReplies = measurement.guardrailRules.reduce((total, row) => total + row.holds, 0);
  const exhaustedFollowups = measurement.followupPerformance
    .reduce((total, row) => total + row.exhausted, 0);

  // Only categories the platform snapshot can count. Unanswered human handoffs, Instagram
  // re-approvals, and correction decisions have no evidence in this read, so they are not listed.
  return [
    {
      title: "Past due subscriptions",
      count: overdueSubscriptions,
      tone: "critical",
      href: "/admin/billing",
      note: "Review accounts",
      // Every reason below restates the filter its own count was taken through, so the sentence
      // cannot drift from the number beside it. None of them asserts a consequence the read
      // cannot see: nothing here says an agent is still live or that dunning is scheduled,
      // because this snapshot records neither.
      reason: "Stripe reports the subscription past due, unpaid or incomplete",
    },
    {
      title: "Provisioning blocks",
      count: provisioningBlocks,
      tone: "critical",
      href: "/admin/provisioning",
      note: "Resolve setup blocks",
      reason: "Recorded step attempts that failed, on steps now blocked or failed",
    },
    {
      title: "Held replies awaiting a decision",
      count: heldReplies,
      tone: "warning",
      href: "/admin/support",
      note: "Review holds",
      reason: "A guardrail held the reply rather than blocking or sending it",
    },
    {
      title: "Follow-up cadences exhausted",
      count: exhaustedFollowups,
      tone: "info",
      href: "/admin/support",
      note: "Review contacts",
      reason: "The cadence reached its last touch with no reply",
    },
  ];
}

const PERIOD_LABEL = new Intl.DateTimeFormat("en-US", {
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

function periodLabel(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Period" : PERIOD_LABEL.format(parsed);
}

/**
 * 1b's left-hand chart panel, carrying the one series the platform snapshot actually has.
 *
 * The drawing is "Lead flow: captured vs booked", two stacked series over ten periods. There is no
 * cross-tenant lead count and no per-period booked count anywhere in the snapshot, so a two-series
 * chart here would be one measured series beside one invented one. What the RPC does emit is a
 * contiguous run of 30-day signup periods (20260914000001), asked for six at a time, so the panel
 * draws that: one series, one axis, and the legend omitted because a key to a single series is
 * decoration.
 *
 * `needs_more_history` on a period describes how much history stands behind the growth comparison,
 * not a missing number (platform-analytics.ts): the count is real, so it is drawn and compared
 * against. A period that measured zero still draws a bar, because `BarSparkline` floors every bar
 * at a visible sliver for exactly that reason -- a missing bar would shift the axis and make the
 * chart lie about which period is which.
 */
export function SignupComparison({
  history,
}: {
  history: PlatformMeasurement["history"];
}) {
  const previous = history.at(-2) ?? null;
  const current = history.at(-1) ?? null;
  const points = history.map((period) => period.value);
  const drawable = current !== null
    && current.state === "available"
    && points.length >= BAR_SPARKLINE_MIN_POINTS
    && points.some((value) => value > 0);

  // The series label enumerates every period and its count, so the chart is countable by a screen
  // reader rather than announced as "a chart". A row of bars with no words is not a metric.
  const seriesLabel = `Signups by 30-day period: ${history
    .map((period) => `${periodLabel(period.periodStart)} ${formatMetric(period.value, "count")}`)
    .join(", ")}`;
  const difference = current !== null && previous !== null ? current.value - previous.value : null;

  return (
    <Surface className="flex min-h-0 min-w-0 flex-col" data-slot="signup-panel" variant="panel">
      <SurfaceHeader
        subtitle="Each bar is one trailing 30-day period, oldest first"
        title="Signups by period"
        trailing={
          current === null || current.state !== "available" ? null : (
            <>
              <Figure data-slot="signup-figure" size="md">
                {formatMetric(current.value, "count")}
              </Figure>
              {difference === null || previous === null ? (
                <MonoMeta>no prior period</MonoMeta>
              ) : difference === 0 ? (
                <MonoMeta>level with {periodLabel(previous.periodStart)}</MonoMeta>
              ) : (
                <MonoMeta tone={difference > 0 ? "good" : "failure"}>
                  {difference > 0 ? "+" : "\u2212"}
                  {formatMetric(Math.abs(difference), "count")} on{" "}
                  {periodLabel(previous.periodStart)}
                </MonoMeta>
              )}
            </>
          )
        }
      />
      <div className="flex min-h-0 flex-1 flex-col justify-end gap-[9px] p-[var(--s-4)]">
        {drawable ? (
          <>
            <BarSparkline
              className="min-h-[120px] flex-1"
              emphasisCount={1}
              height={186}
              label={seriesLabel}
              points={points}
              tone="accent"
            />
            <AxisTicks ticks={history.map((period) => periodLabel(period.periodStart))} />
          </>
        ) : (
          <p className="m-0 max-w-[var(--measure-tight)] text-[13px] leading-[1.5] text-[color:var(--muted)]">
            No completed signup period is recorded yet. The chart appears after the first full
            30-day period closes.
          </p>
        )}
      </div>
    </Surface>
  );
}

export type FollowupReach = {
  steps: FunnelBarStep[];
  /** The steepest fall between two adjacent touches, derived from those same steps. */
  drop: { from: string; to: string; percent: number } | null;
};

/**
 * 1b's right-hand funnel, over the one descending sequence the platform snapshot records.
 *
 * The drawing's funnel is Contacted \u2192 Replied \u2192 Qualified \u2192 Booked. Three of those four stages are
 * per-client counts with no cross-tenant projection, so the funnel is built from follow-up reach
 * instead: how many messages each touch of the cadence sent, touch by touch. That is a real
 * descending sequence over real rows, and it answers the question the drawn funnel answers -- where
 * the population falls away.
 *
 * The BIGGEST DROP line is derived from the same steps the bars render, never named ahead of time,
 * so the callout and the bars above it cannot disagree. When no adjacent pair actually falls, the
 * line is omitted rather than reporting the least-bad rise as a drop.
 */
export function followupReach(rows: PlatformMeasurement["followupPerformance"]): FollowupReach {
  const ordered = [...rows].sort((left, right) => left.touchNo - right.touchNo);
  const steps: FunnelBarStep[] = ordered.map((row) => ({
    label: `Touch ${row.touchNo}`,
    value: row.sent,
  }));

  let drop: FollowupReach["drop"] = null;
  for (let index = 1; index < ordered.length; index += 1) {
    const from = ordered[index - 1]!;
    const to = ordered[index]!;
    if (from.sent <= 0 || to.sent >= from.sent) continue;
    const percent = Math.round(((from.sent - to.sent) / from.sent) * 100);
    if (drop === null || percent > drop.percent) {
      drop = { from: `Touch ${from.touchNo}`, to: `Touch ${to.touchNo}`, percent };
    }
  }

  return { steps, drop };
}

export function FollowupReachPanel({ reach }: { reach: FollowupReach }) {
  const drawable = reach.steps.length >= 2 && (reach.steps[0]?.value ?? 0) > 0;

  return (
    <Surface className="flex min-h-0 min-w-0 flex-col" data-slot="followup-reach-panel" variant="panel">
      <SurfaceHeader
        subtitle="Messages sent at each touch of the cadence, this snapshot"
        title="Follow-up reach"
      />
      <div className="flex min-h-0 flex-1 flex-col gap-[var(--s-4)] p-[var(--s-4)]">
        {drawable ? (
          <FunnelBars steps={reach.steps} />
        ) : (
          <p className="m-0 max-w-[var(--measure-tight)] text-[13px] leading-[1.5] text-[color:var(--muted)]">
            No follow-up touch has sent a message in this snapshot yet.
          </p>
        )}
        {drawable && reach.drop ? (
          <div className="mt-auto flex items-center justify-between gap-[var(--s-3)] border-t border-[var(--line-soft)] pt-[14px]">
            <div className="min-w-0">
              <Overline className="block">Biggest drop</Overline>
              <div className="mt-[4px] text-[12.5px] text-[color:var(--body)]" data-slot="biggest-drop">
                {reach.drop.from} to {reach.drop.to}
              </div>
            </div>
            <Figure data-slot="biggest-drop-figure" size="md" tone="warning">
              {`\u2212${reach.drop.percent}%`}
            </Figure>
          </div>
        ) : null}
      </div>
    </Surface>
  );
}

/**
 * The client's own "(demo)"-marked name when the snapshot's tenant id resolves to one.
 *
 * The measurement snapshot carries tenant ids and no names, and the page used to invent
 * "Client 1 / 2 / 3" from the row index, which shipped placeholder identity strings to a client
 * demo. When a snapshot predates the seed that writes real tenant ids, the id itself is shown
 * rather than a counter: it is at least the true, distinct identifier for that row.
 */
export function clientLabel(names: Readonly<Record<string, string>>, tenantId: string) {
  return names[tenantId]?.trim() || tenantId;
}

/**
 * One of the home page's two blocks: the work that needs a person before anything else.
 *
 * Grouped by how soon rather than by what kind, because "how soon" is the only ordering an
 * operator acts on. A category with nothing in it is not a row -- the empty state names every
 * category that was checked, which is the same information without four rows of zeroes above the
 * real work.
 */
export function NeedsPersonToday({ categories }: { categories: readonly AdminExceptionCategory[] }) {
  const rows: AttentionRow[] = categories
    .filter((category) => category.count > 0)
    .slice(0, 5)
    .map((category) => ({
      id: category.title,
      title: category.title,
      count: category.count,
      band: category.tone === "info" ? ATTENTION_SOON : ATTENTION_NOW,
      href: category.href,
      note: category.note,
      reason: category.reason,
    }));

  return (
    <section aria-labelledby="needs-person-heading" className="flex min-h-0 flex-col gap-[var(--s-3)]">
      <div className="flex flex-wrap items-baseline justify-between gap-[var(--s-2)]">
        <div className="min-w-0">
          {/*
            The canvas's eyebrow, and it is making a claim rather than decorating: this queue is
            what the console opens on, so the panel says it is the default focus rather than one
            more section competing with the figures above it.
          */}
          <Overline className="mb-[var(--s-1)] block">Default focus</Overline>
          <h2 className="m-0 text-section text-[var(--ink)]" id="needs-person-heading">
            Needs a decision
          </h2>
        </div>
        <Link
          className="text-body font-medium text-[var(--accent-text)] no-underline hover:underline"
          href="/admin/support"
        >
          Open the queue
        </Link>
      </div>
      <AttentionQueueTable
        checked={categories.map((category) => category.title)}
        rows={rows}
      />
    </section>
  );
}

/**
 * The platform's figures, grouped by the subject they belong to.
 *
 * Eighteen identical cards four across told the reader nothing about which of eighteen numbers was
 * a problem, and the brief caps a stat strip at four tiles for exactly that reason. Everything a
 * reader scans rather than decides on now reads as a right-aligned definition list under the
 * subject it belongs to; the handful of figures that carry a threshold keep a tile.
 */
const FIGURE_GROUPS = [
  {
    id: "money",
    title: "Money and growth",
    keys: [
      "platform.gross_mrr", "platform.margin", "platform.affiliate_commission", "platform.ltv",
      "platform.active_subscriptions", "platform.new_signups", "platform.growth_rate",
      "platform.churn_rate", "platform.average_retention",
    ],
  },
  {
    id: "guardrails",
    title: "Guardrails",
    keys: [
      "platform.guardrail_rule_fire_rate", "platform.guardrail_block_rate",
      "platform.holding_reply_rate", "platform.escalation_rate", "platform.scope_block_rate",
    ],
  },
  {
    id: "appointments",
    title: "Appointments and follow-ups",
    keys: [
      "platform.booked_appointments", "platform.no_show_rate", "platform.reschedule_rate",
      "platform.cadence_completion_rate", "platform.followup_reply_rate",
      "platform.cross_channel_continuation_rate",
    ],
  },
  {
    id: "provisioning",
    title: "Provisioning and the brain",
    keys: [
      "platform.time_to_live", "platform.provisioning_step_failure_rate",
      "platform.a2p_approval_rate", "platform.a2p_median_days_to_clear",
      "platform.meta_live_sms_registering_share", "platform.eval_case_count",
      "platform.knowledge_usage_count",
    ],
  },
] as const satisfies readonly { id: string; title: string; keys: readonly string[] }[];

/**
 * The four figures that carry a threshold, so a tile can say good or bad rather than just print a
 * number. `bad` is the side of the boundary that needs a person; everything else is reference.
 */
const THRESHOLDS = [
  { key: "platform.churn_rate", direction: "above", boundary: "5%" },
  { key: "platform.provisioning_step_failure_rate", direction: "above", boundary: "5%" },
  { key: "platform.guardrail_block_rate", direction: "above", boundary: "10%" },
  { key: "platform.a2p_approval_rate", direction: "below", boundary: "80%" },
] as const satisfies readonly {
  key: string; direction: "above" | "below"; boundary: string;
}[];

/** Same sentence shape on all four tiles, whichever side of the line the figure is on. */
function watchLineNote(boundary: string, direction: "above" | "below", breached: boolean) {
  if (!breached) return `${boundary} is the watch line`;
  return direction === "above" ? `Over the ${boundary} watch line` : `Under the ${boundary} watch line`;
}

const ONE_DECIMAL = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 1,
});

/**
 * One decimal for every rate and every day count on this page.
 *
 * Siblings printed at whatever precision they happened to carry ("6%", "6.3%", "8.3%", "77.8%"),
 * which makes a column of rates impossible to compare down.
 */
function figureValue(metric: MetricEvidence, availability: MetricAvailability) {
  if (availability.kind !== "value") return null;
  const unit = metricDefinition(metric.metricKey).unit;
  if (unit === "percent") return `${ONE_DECIMAL.format(availability.value)}%`;
  if (unit === "days") return `${ONE_DECIMAL.format(availability.value)} days`;
  return formatMetric(availability.value, availability.format);
}

function absenceNote(availability: MetricAvailability) {
  if (availability.kind === "unavailable" || availability.kind === "no-events") {
    return availability.note;
  }
  if (availability.kind === "not-connected") return availability.source;
  return "Not recorded";
}

type FigureRow = {
  key: string;
  label: string;
  value: string | null;
  note: string;
};

function figureRow(
  measurement: PlatformMeasurement,
  visibleMetrics: readonly PlatformMetricView[],
  key: string,
): FigureRow | null {
  const metric = evidenceFor(measurement, key);
  const availability = availabilityOf(measurement, visibleMetrics, key);
  if (!metric || !availability) return null;
  const definition = metricDefinition(metric.metricKey);
  return {
    key,
    // "Average retention, days 4.2" reads as a column export. The unit belongs to the number.
    label: definition.label,
    value: figureValue(metric, availability),
    note: figureValue(metric, availability) === null ? absenceNote(availability) : "",
  };
}

/**
 * A subject's figures as one card face carrying a label-left, mono-value-right list.
 *
 * `KeyValueList` is the atomic for exactly this shape, so the detail page's four groups and the
 * BLAST RADIUS list on the attention screen are the same object rather than two dialects of a
 * definition list. An absent figure keeps its reason as the value, in the dimmer role, because a
 * blank row would read as zero.
 */
function FigureGroup({ rows, title }: { rows: readonly FigureRow[]; title: string }) {
  if (rows.length === 0) return null;
  const headingId = `figure-group-${title.replaceAll(/\W+/g, "-").toLowerCase()}`;
  const items: KeyValueRow[] = rows.map((row) => ({
    label: row.label,
    value: row.value === null
      ? <span style={{ color: "var(--faint)" }}>{row.note}</span>
      : row.value,
  }));
  return (
    <Surface aria-labelledby={headingId} as="section" className="flex min-w-0 flex-col gap-[var(--s-3)]">
      <Overline as="h3" className="m-0 block" id={headingId}>{title}</Overline>
      <KeyValueList rows={items} />
    </Surface>
  );
}

type ThresholdTile = {
  key: string;
  label: string;
  value: string | null;
  note: string;
  tone: Tone;
};

/**
 * The four figures that carry a watch line, drawn as 1b's KPI tile rather than a stat strip.
 *
 * The tone is the claim: a figure on the wrong side of its boundary takes clay, everything else
 * stays neutral. The sentence under it has the same shape either way, so the reader is comparing
 * the figure to the line and not two different sentences to each other.
 */
function thresholdTiles(
  measurement: PlatformMeasurement,
  visibleMetrics: readonly PlatformMetricView[],
): ThresholdTile[] {
  return THRESHOLDS.flatMap((threshold) => {
    const metric = evidenceFor(measurement, threshold.key);
    const availability = availabilityOf(measurement, visibleMetrics, threshold.key);
    if (!metric || !availability) return [];
    const boundaryValue = Number.parseFloat(threshold.boundary);
    const breached = availability.kind === "value"
      && (threshold.direction === "above"
        ? availability.value > boundaryValue
        : availability.value < boundaryValue);
    const value = figureValue(metric, availability);
    return [{
      key: threshold.key,
      label: metricDefinition(metric.metricKey).label,
      value,
      note: value === null
        ? absenceNote(availability)
        : watchLineNote(threshold.boundary, threshold.direction, breached),
      tone: breached ? ("failure" as Tone) : ("neutral" as Tone),
    } satisfies ThresholdTile];
  });
}

function provisioningStatus(stepKey: string, state: string): { label: string; tone: StateTone } {
  if (state === "failed" || state === "blocked") {
    return { label: provisioningStateLabel(stepKey, state), tone: "critical" };
  }
  if (state === "done") {
    return { label: "Completion evidence missing", tone: "neutral" };
  }
  if (state === "awaiting_provider" || state === "pending") {
    return { label: provisioningStateLabel(stepKey, state), tone: "warning" };
  }
  return { label: provisioningStateLabel(stepKey, state), tone: "info" };
}

function measurementExportRows(
  measurement: PlatformMeasurement,
  visibleMetrics: readonly PlatformMetricView[],
) {
  return visibleMetrics.map((view) => ({
    dataOrigin: measurement.origin === "synthetic_preview"
      ? "Synthetic review preview"
      : "Real analytics",
    asOf: measurement.asOf,
    metricKey: view.key,
    label: view.label,
    value: platformMetricDisplay(view),
    denominator: view.descriptor.denominator,
    window: view.descriptor.window,
    clock: view.descriptor.clock,
  }));
}

/**
 * How the page describes its own numbers.
 *
 * 1b's subline is "Last 30 days vs prior period · test leads excluded". Only the second half of
 * that can be said here. The exclusion is real and enforced in the database rather than in copy:
 * every analytics view the platform aggregate reads filters `is_test` and `is_demo`
 * (20260823000001), and `read_platform_measurement_for_actor` clears the demo-widening GUC before
 * it reads, so no demo tenant can reach a platform figure even if a caller left it set
 * (20260830000001). The first half cannot: these figures do not share one window. Gross MRR and
 * active subscriptions are point-in-time at the as-of instant, signups and booked appointments are
 * trailing 30 days, and churn is the most recent complete billing cycle. One period claim over the
 * four of them would be false for two, so each tile names its own window instead.
 *
 * A synthetic preview says so and claims nothing about real clients, because "test rows excluded"
 * over a snapshot that is entirely synthetic is the exact inversion of the honest-states rule.
 */
/**
 * What the page is for, which is a different sentence from what its numbers are made of.
 *
 * The canvas puts a purpose line under every console title, and this screen had none: it opened on
 * "31 Aug 2026. Every real client, at each figure's own window." -- true, load-bearing, and an
 * answer to a question nobody asks first. A reader landing on an unfamiliar console needs to know
 * what the screen is before they can care how its windows are drawn.
 *
 * So the two sentences split rather than compete. This is `description`; the provenance sentence
 * moves down one slot to `note`, where `ListPage` renders it in the smaller role it was always
 * doing the job of. Nothing about the windows claim is softened -- see `overviewDescription` for
 * why that sentence cannot be reduced to "last 30 days".
 */
const OVERVIEW_PURPOSE =
  "Platform performance, client health, and the work that needs a human decision.";

function overviewDescription(measurement: PlatformMeasurement) {
  const asOf = humanDate(measurement.asOf);
  if (measurement.origin === "synthetic_preview") {
    return `${asOf}. A synthetic review snapshot, not client performance.`;
  }
  return `${asOf}. Every real client, at each figure's own window. Demo tenants and test rows are excluded at the source.`;
}

/**
 * The home page, transcribed from 1b: four KPI tiles across the top, then a chart panel beside a
 * funnel panel, then the work that needs a person. Every other figure the platform records is one
 * click away on the platform detail page.
 *
 * The page spends its one accent fill on the attention queue's verb, so nothing in the tiles or the
 * two panels is filled: the period switch 1b draws is not here, because platform measurement takes
 * an as-of instant and no window, and a segmented control with nothing behind it is a control that
 * reads as broken.
 */
export function AdminOverviewSurface({ measurement, role }: AdminOverviewProps) {
  const projected = adminMeasurementView(measurement, role);
  // The tiles are the headline metrics the role is allowed to see, in decision order. A success
  // reviewer refused revenue gets three tiles; nothing is promoted into the money slot.
  const tiles = headlineTiles(measurement, projected.metrics);
  const substats = heroSubstats(measurement, projected.metrics);
  const reach = followupReach(projected.followupPerformance);

  return (
    <ListPage
      actions={(
        <>
          <Link
            className="text-body font-medium text-[var(--accent-text)] no-underline hover:underline"
            href={PLATFORM_DETAIL_HREF}
          >
            All figures
          </Link>
          <ExportMenu
            filename="setterfi-platform-operating-figures"
            mode="local"
            rows={measurementExportRows(measurement, projected.metrics)}
          />
        </>
      )}
      description={OVERVIEW_PURPOSE}
      note={overviewDescription(measurement)}
      provenanceKind={measurement.origin === "synthetic_preview" ? "preview" : undefined}
      stats={(
        <HeadlineTiles
          fleet={<FleetHealthPanel measurement={measurement} />}
          substats={substats}
          tiles={tiles}
        />
      )}
      title="Overview"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-[13px] overflow-y-auto">
        {/*
          1b's proportions: the chart takes 1.55 of the row and the funnel 1, so the series has room
          to be read across and the funnel stays a column of labelled bars rather than a wide band.
        */}
        <div className="grid min-w-0 gap-[13px] lg:grid-cols-[1.55fr_1fr]">
          <SignupComparison history={measurement.history} />
          <FollowupReachPanel reach={reach} />
        </div>
        <NeedsPersonToday categories={exceptionCategories(measurement)} />
      </div>
    </ListPage>
  );
}

/**
 * Everything the home page deliberately does not show: the rest of the figures, the acquisition
 * sequence, and the four evidence tables, each on its own tab with its own export.
 */
export function AdminPlatformDetailSurface({
  clientNames = {},
  measurement,
  role,
}: AdminOverviewProps & { clientNames?: Readonly<Record<string, string>> }) {
  const projected = adminMeasurementView(measurement, role);
  const funnel = acquisitionFunnel(measurement, projected.metrics);
  const subscriptionRows: SubscriptionRow[] = role === "success"
    ? []
    : (projected.subscriptions as unknown as readonly SubscriptionRow[])
        .map((row) => ({ ...row, client: clientLabel(clientNames, row.tenantId) }));

  const tiles = thresholdTiles(measurement, projected.metrics);
  // Every figure the platform records, grouped by subject. The reader sent here for "all the
  // numbers" still gets all of them, including the four the overview also shows.
  const groups = FIGURE_GROUPS.map((group) => ({
    id: group.id,
    title: group.title,
    rows: group.keys.flatMap((key) => {
      const row = figureRow(measurement, projected.metrics, key);
      return row ? [row] : [];
    }),
  })).filter((group) => group.rows.length > 0);

  return (
    <DetailPage
      subtitle={`${humanDate(measurement.asOf)}. Every figure and evidence table behind the overview.`}
      tabs={[
        {
          id: "figures",
          label: "Figures",
          content: groups.length === 0 ? (
            <p className="t-muted m-0">No platform figure was recorded in this snapshot.</p>
          ) : (
            <div className="flex flex-col gap-[var(--s-6)]">
              {tiles.length > 0 ? (
                <section aria-labelledby="thresholded-figures" className="flex flex-col gap-[var(--s-3)]">
                  <h2 className="m-0 text-section text-[var(--ink)]" id="thresholded-figures">
                    Against a threshold
                  </h2>
                  <div className="grid gap-[13px] sm:grid-cols-2 xl:grid-cols-4">
                    {tiles.map((tile) => (
                      <MetricCard
                        key={tile.key}
                        note={tile.note}
                        overline={tile.label}
                        tone={tile.tone}
                        value={
                          tile.value === null ? (
                            <span style={{ color: "var(--faint)" }}>{"–"}</span>
                          ) : (
                            tile.value
                          )
                        }
                      />
                    ))}
                  </div>
                </section>
              ) : null}
              <section aria-labelledby="reference-figures" className="flex flex-col gap-[var(--s-3)]">
                <h2 className="m-0 text-section text-[var(--ink)]" id="reference-figures">
                  Every recorded figure
                </h2>
                <div className="grid gap-x-[var(--s-8)] gap-y-[var(--s-5)] lg:grid-cols-2">
                  {groups.map((group) => (
                    <FigureGroup key={group.id} rows={group.rows} title={group.title} />
                  ))}
                </div>
              </section>
            </div>
          ),
        },
        {
          id: "acquisition",
          label: "Acquisition",
          content: <AcquisitionFunnel showRate={funnel.showRate} stages={funnel.stages} />,
        },
        ...(role !== "success" ? [{
          id: "subscriptions",
          label: "Subscriptions",
          content: (
            <SubscriptionsTable
              exportResource={{ filename: "setterfi-platform-subscriptions", mode: "server" as const, resource: "platform-subscriptions", query: { reason: EXPORT_REASON, columns: ["dataOrigin", "tenantId", "subscriptionId", "status", "stripePriceId", "periodStart", "periodEnd"] } }}
              rows={subscriptionRows}
            />
          ),
        }] : []),
        {
          id: "guardrails",
          label: "Guardrails",
          content: (
            <GuardrailRulesTable
              exportResource={{ filename: "setterfi-platform-guardrail-rules", mode: "server", resource: "platform-guardrail-rules", query: { reason: EXPORT_REASON, columns: ["dataOrigin", "ruleKey", "label", "fires", "blocks", "holds"] } }}
              rows={projected.guardrailRules}
            />
          ),
        },
        {
          id: "followups",
          label: "Follow-ups",
          content: (
            <FollowupPerformanceTable
              exportResource={{ filename: "setterfi-platform-followup-performance", mode: "server", resource: "platform-followup-performance", query: { reason: EXPORT_REASON, columns: ["dataOrigin", "touchNo", "sent", "replied", "crossChannel", "exhausted"] } }}
              rows={projected.followupPerformance}
            />
          ),
        },
        {
          id: "provisioning",
          label: "Provisioning",
          content: (
            <ProvisioningPerformanceTable
              exportResource={{ filename: "setterfi-platform-provisioning-performance", mode: "server", resource: "platform-provisioning-performance", query: { reason: EXPORT_REASON, columns: ["dataOrigin", "stepKey", "state", "attempts", "failures", "medianDaysToClear"] } }}
              rows={projected.provisioningPerformance.map((row) => {
                const status = provisioningStatus(row.stepKey, row.state);
                return { ...row, stateLabel: status.label, stateTone: status.tone };
              })}
            />
          ),
        },
      ]}
      title="Platform detail"
    />
  );
}
