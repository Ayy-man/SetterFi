"use client";

/**
 * Agent performance (screen 2b): the cross-tenant measurement snapshot, read as a leaderboard.
 *
 * The artifact draws a ranking of agents with a booking rate, a 30-day trend, a lead count, a
 * reply time and a delta against an account baseline. This snapshot carries one per-client number
 * (booked appointments) plus the two money figures the economics roles are allowed to see. So
 * the *form* is transcribed and the *columns* are only what the route supplies; a column the
 * route cannot fill is left out rather than filled with plausible numbers.
 *
 * A leaderboard ranks livelihoods, so ranking has a contract here rather than a sort call:
 *
 *   - Every measure declares whether it is a total or a rate. A total over one shared window is
 *     comparable between any two clients; a rate is not, until its denominator is stated and large
 *     enough to mean anything. `comparableRows` enforces that, and a rate measure cannot be
 *     declared without naming its denominator: the type will not allow it.
 *   - The delta names its baseline. It is the median of the ranked values, the column head says
 *     VS MEDIAN, and the footer says over how many clients. Below three clients there is no
 *     median worth the name, so the column does not render at all.
 *   - Clay is spent on a figure only when it is far below that median, not merely under it.
 *     Half a fleet is always below its own median, and a table half in clay says nothing.
 *
 * Economics stay behind the role projection, so a success user never receives the money fields and
 * they cannot be revealed from a segment either.
 */

import { useId, useMemo, useState } from "react";

import {
  AxisTicks,
  Figure,
  GridTable,
  GridTableCell,
  GridTableFooter,
  GridTableHead,
  GridTableIdentity,
  GridTableRow,
  HeatRow,
  MonoMeta,
  Overline,
  Segmented,
  Surface,
  SurfaceHeader,
} from "@/components/kit/atomics";
import { absentValue } from "@/components/kit/columns";
import { DataState } from "@/components/kit/data-state";
import { ExportMenu, type ExportMenuProps } from "@/components/kit/export-menu";
import { KeyValue } from "@/components/kit/key-value";
import { RecordSheet } from "@/components/kit/record-sheet";
import type { StateTone } from "@/components/kit/state-badge";
import { ConsoleStatDeck } from "@/components/kit/console-stat-deck";
import type { StatStripItem } from "@/components/kit/stat-strip";
import { ListPage } from "@/components/kit/templates/list-page";
import { workspaceCountFormat } from "@/lib/format/datetime";
import type { PlatformMeasurement } from "@/lib/repositories/platform-analytics";

import { clientLabel } from "./admin-overview";
import type { AdminMeasurementView } from "./admin-measurement-view-models";

const EXPORT_REASON = "platform-measurement-surface-read";

const MONEY = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 0,
  style: "currency",
});

/** A money figure for the record sheet. An amount nobody recorded is not a formatted zero. */
function moneyValue(cents: number | null | undefined, emptyLabel: string) {
  return cents === null || cents === undefined
    ? absentValue(emptyLabel)
    : MONEY.format(cents / 100);
}

/** The one place the margin enum becomes a sentence. */
const MARGIN_STATE = {
  available: { label: "Cost evidence recorded", tone: "good" },
  unavailable: { label: "Waiting on cost evidence", tone: "warning" },
} as const satisfies Record<string, { label: string; tone: StateTone }>;

export type PerformanceRow = {
  client: string;
  tenantId: string;
  bookedAppointments: number;
  grossMrrCents?: number | null;
  commissionCents?: number | null;
  marginCents?: number | null;
  marginState?: "available" | "unavailable";
};

function marginKey(row: PerformanceRow) {
  return row.marginState === "available" ? "available" : "unavailable";
}

function marginState(row: PerformanceRow) {
  return MARGIN_STATE[marginKey(row)];
}

/* -------------------------------------------------------------------------------------------- */
/* The measure contract                                                                          */
/* -------------------------------------------------------------------------------------------- */

export type MeasureKey = "booked" | "grossMrr" | "margin";

type MeasureBase = {
  key: MeasureKey;
  /** The segment label. */
  label: string;
  /** The column head, uppercased by the head strip. */
  overline: string;
  /** Owner and admin only. A success reviewer never receives the field, let alone the column. */
  economics: boolean;
  /** What is missing when a row carries no value. Never rendered as a zero. */
  emptyLabel: string;
  value: (row: PerformanceRow) => number | null;
  format: (value: number) => string;
  /** The signed distance from the baseline, already formatted with its unit. */
  formatDelta: (delta: number) => string;
};

/**
 * A rate cannot be declared without its denominator.
 *
 * This is the type doing the work the brief asks for: 100% of four leads outranking 44% of three
 * hundred is only possible if a rate can be added as a bare number. Here it cannot: a `rate`
 * measure has to name the population it is over and the smallest population it may be ranked on,
 * and `comparableRows` withholds anything under that from the ranking while still rendering the
 * figure with its denominator beside it.
 */
export type Measure =
  | (MeasureBase & { kind: "total" })
  | (MeasureBase & {
      kind: "rate";
      denominator: (row: PerformanceRow) => number | null;
      /** "leads", "messages sent". Printed beside the figure as `of 300 leads`. */
      denominatorLabel: string;
      minDenominator: number;
    });

/**
 * The three measures the snapshot actually carries, all of them totals over one shared window.
 *
 * There is deliberately no booking *rate* here: the snapshot has no per-client lead count, so a
 * rate would have to be invented. See the gap note in the header.
 */
export const MEASURES = [
  {
    key: "booked",
    kind: "total",
    label: "Booked",
    overline: "Booked",
    economics: false,
    emptyLabel: "Not measured",
    value: (row) => row.bookedAppointments,
    format: (value) => workspaceCountFormat.format(value),
    formatDelta: (delta) => `${delta > 0 ? "+" : "−"}${workspaceCountFormat.format(Math.abs(delta))}`,
  },
  {
    key: "grossMrr",
    kind: "total",
    label: "Gross MRR",
    overline: "Gross MRR",
    economics: true,
    emptyLabel: "No priced subscription",
    value: (row) => row.grossMrrCents ?? null,
    format: (value) => MONEY.format(value / 100),
    formatDelta: (delta) => `${delta > 0 ? "+" : "−"}${MONEY.format(Math.abs(delta) / 100)}`,
  },
  {
    key: "margin",
    kind: "total",
    label: "Margin",
    overline: "Margin",
    economics: true,
    emptyLabel: "No cost evidence",
    value: (row) => row.marginCents ?? null,
    format: (value) => MONEY.format(value / 100),
    formatDelta: (delta) => `${delta > 0 ? "+" : "−"}${MONEY.format(Math.abs(delta) / 100)}`,
  },
] as const satisfies readonly Measure[];

export function measureFor(key: MeasureKey): Measure {
  return MEASURES.find((measure) => measure.key === key) ?? MEASURES[0];
}

export type MeasuredRow = {
  row: PerformanceRow;
  value: number;
  /** Present only for a rate measure; it is what makes the figure comparable. */
  denominator: number | null;
};

/**
 * Split the rows into the ones this measure may rank and the ones it may not.
 *
 * A row with no value is not a zero and never ranks. A rate over a population smaller than the
 * measure's own floor is withheld from the ranking: it still renders, with its denominator, below
 * the ranked rows, because hiding a client from its own leaderboard is worse than saying the
 * sample is too small to place.
 */
export function comparableRows(
  measure: Measure,
  rows: readonly PerformanceRow[],
): { ranked: MeasuredRow[]; withheld: MeasuredRow[]; absent: PerformanceRow[] } {
  const ranked: MeasuredRow[] = [];
  const withheld: MeasuredRow[] = [];
  const absent: PerformanceRow[] = [];
  for (const row of rows) {
    const value = measure.value(row);
    if (value === null || !Number.isFinite(value)) {
      absent.push(row);
      continue;
    }
    if (measure.kind === "rate") {
      const denominator = measure.denominator(row);
      // A rate over too small a population still renders, with its denominator, but it may not
      // rank: 100% of four leads is not a better number than 44% of three hundred.
      if (denominator === null || denominator < measure.minDenominator) {
        withheld.push({ row, value, denominator });
        continue;
      }
      ranked.push({ row, value, denominator });
      continue;
    }
    ranked.push({ row, value, denominator: null });
  }
  ranked.sort((left, right) => right.value - left.value);
  return { ranked, withheld, absent };
}

/**
 * The fewest clients a median may be taken over.
 *
 * Two clients have no median, only a pair, and "above the baseline" would mean "not the smaller of
 * two". Under this the delta column does not render and the footer says why.
 */
export const MIN_BASELINE_ROWS = 3;

export function baselineMedian(values: readonly number[]): number | null {
  if (values.length < MIN_BASELINE_ROWS) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * How far under the baseline a figure has to fall before it is drawn in clay.
 *
 * Exactly half a fleet sits below its own median by construction, so tinting everything below it
 * would put half the table in the failure colour and say nothing. Half the median is an outlier.
 */
export const FAR_BELOW_BASELINE_SHARE = 0.5;

export function deltaTone(value: number, baseline: number) {
  if (value > baseline) return "good" as const;
  if (value >= baseline * FAR_BELOW_BASELINE_SHARE) return "neutral" as const;
  return "failure" as const;
}

/**
 * Which rows may carry the amber evidence tint.
 *
 * A tint marks the row that is the exception. When most of the fleet has no cost rollup yet the
 * missing rollup is the norm, and a table tinted end to end has stopped pointing at anything, so
 * the words stay on every row and the tint goes away.
 */
export function evidenceTintedRows(rows: readonly PerformanceRow[]): ReadonlySet<string> {
  const missing = rows.filter((row) => marginKey(row) === "unavailable");
  // Fewer than half the fleet: the tint still points at something. Half or more and it is the
  // norm, so the words stay on every row and the colour goes away.
  return missing.length > 0 && missing.length * 2 < rows.length
    ? new Set(missing.map((row) => row.tenantId))
    : new Set<string>();
}

/* -------------------------------------------------------------------------------------------- */
/* Follow-up reply rates                                                                          */
/* -------------------------------------------------------------------------------------------- */

export type TouchRate = { touchNo: number; sent: number; replied: number; rate: number };

/**
 * Reply rate per follow-up touch, with the touches that have no denominator taken out.
 *
 * This is the same rule as the leaderboard, one level down: a touch nobody has sent yet has no
 * reply rate, and drawing it as an empty cell would put a measured zero next to an unmeasured one.
 */
export function followupReplyRates(
  rows: AdminMeasurementView["followupPerformance"],
): { rates: TouchRate[]; unsentTouches: number[] } {
  const rates: TouchRate[] = [];
  const unsentTouches: number[] = [];
  for (const row of [...rows].sort((left, right) => left.touchNo - right.touchNo)) {
    if (row.sent <= 0) {
      unsentTouches.push(row.touchNo);
      continue;
    }
    rates.push({
      touchNo: row.touchNo,
      sent: row.sent,
      replied: row.replied,
      rate: row.replied / row.sent,
    });
  }
  return { rates, unsentTouches };
}

const PERCENT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0, style: "percent" });

/* -------------------------------------------------------------------------------------------- */
/* The panels                                                                                     */
/* -------------------------------------------------------------------------------------------- */

/**
 * The follow-up card, which is 2b's bottom-left heat row against the data that exists.
 *
 * The artifact draws booked appointments by hour of day. The snapshot carries no hour-of-day
 * histogram at all, so this draws the cadence question it *can* answer (how each follow-up touch
 * replies), and every cell states the population it is over underneath it.
 */
function FollowupReplyPanel({ rows }: { rows: AdminMeasurementView["followupPerformance"] }) {
  const headingId = useId();
  const { rates, unsentTouches } = useMemo(() => followupReplyRates(rows), [rows]);

  return (
    <Surface aria-labelledby={headingId} as="section" className="flex flex-col gap-[var(--s-3)]">
      <div>
        <h2 className="t-section-title m-0" id={headingId}>
          Reply rate by follow-up touch
        </h2>
        <p className="mt-[var(--s-1)] mb-0 text-[length:var(--t-body)] text-[color:var(--muted)]">
          Replies divided by the messages actually sent at that touch, across every account.
        </p>
      </div>

      {rates.length === 0 ? (
        <p className="t-muted m-0 max-w-[var(--measure-prose)]" data-slot="followup-refusal">
          No follow-up touch in this snapshot has sent a message yet, so there is no reply rate to
          draw.
        </p>
      ) : (
        <div className="flex flex-col gap-[var(--s-2)]">
          <HeatRow
            label={`Reply rate across ${rates.length} follow-up touches`}
            points={rates.map((touch) => touch.rate)}
          />
          <AxisTicks ticks={rates.map((touch) => `T${touch.touchNo}`)} />
          {/* The denominator strip, laid out on the same flex track as the cells so each count
              sits under the cell it is the population for. A rate without its denominator on
              screen is the exact chart this page is not allowed to draw. */}
          <div className="flex gap-[3px]" data-slot="followup-denominators">
            {rates.map((touch) => (
              <MonoMeta
                className="flex-1 text-center text-[10.5px]"
                key={touch.touchNo}
                title={`${workspaceCountFormat.format(touch.replied)} replied of ${workspaceCountFormat.format(touch.sent)} sent`}
              >
                {workspaceCountFormat.format(touch.sent)}
              </MonoMeta>
            ))}
          </div>
          <p className="t-muted m-0">
            Messages sent at each touch. Highest reply rate:{" "}
            {PERCENT.format(Math.max(...rates.map((touch) => touch.rate)))} at touch{" "}
            {rates.reduce((best, touch) => (touch.rate > best.rate ? touch : best)).touchNo}.
            {unsentTouches.length > 0
              ? ` ${unsentTouches.length} touch${unsentTouches.length === 1 ? "" : "es"} had nothing sent and are not drawn.`
              : ""}
          </p>
        </div>
      )}
    </Surface>
  );
}

/**
 * 2b's suggested-action card, rendered as what this snapshot can support.
 *
 * The artifact's card says "retire the Home services closer and re-route its queue to Solar",
 * derived from a booking rate, a three-week trend and a script family: three things the route
 * supplies none of. Retiring a client's agent is a real consequence for a real business, so this
 * card states that no recommendation is derivable and names the evidence that would make one,
 * rather than printing a hardcoded sentence that looks computed. It carries no accent frame and no
 * fill: an empty recommendation is not the page's live action.
 */
function SuggestedActionPanel() {
  const headingId = useId();
  return (
    <Surface
      aria-labelledby={headingId}
      as="section"
      className="flex flex-col gap-[var(--s-2)]"
      data-slot="suggested-action"
    >
      <Overline>Suggested action</Overline>
      <h2 className="t-section-title m-0" id={headingId}>
        Nothing in this snapshot supports a recommendation.
      </h2>
      <p className="t-muted m-0 max-w-[var(--measure-prose)]">
        Retiring an agent or re-routing its queue turns on evidence the measurement snapshot does
        not carry: a per-agent booking rate with the leads it is over, reply latency, and a trend
        long enough to show a decline rather than a bad week. Until those are recorded, the
        leaderboard above is a ranking of totals and the call stays with a person.
      </p>
    </Surface>
  );
}

/* -------------------------------------------------------------------------------------------- */
/* The surface                                                                                    */
/* -------------------------------------------------------------------------------------------- */

/** The most rows the panel draws. Everything measured is still in the export. */
const ROW_LIMIT = 25;

/**
 * Two panels the canvas draws that this page deliberately does not.
 *
 * `AdminAgentPerformance.dc.html` puts a five-stage funnel (messaged / answered the first question
 * / finished qualifying / qualified for a call / booked) beside an objection-frequency chart. Both
 * are refused rather than approximated, and the reason is the same in each case: the figure exists
 * at a different scope than this page, so drawing it here would put a real number under a label
 * that means something else.
 *
 * - **The funnel.** `PlatformMeasurement` carries no conversation-stage counts at all. The nearest
 *   real thing is the coach-scoped three-stage `coach.funnel.entered / qualified / booked`
 *   (`src/lib/analytics/metric-definitions.ts`), which is three stages rather than five and is
 *   per-tenant. Summing thirty coaches' funnels into a "fleet-wide" one would produce a chart
 *   whose stages are real and whose totals answer a question nobody asked.
 * - **The objections.** These exist as `CoachObjectionRow` in `src/lib/repositories/analytics.ts`,
 *   read per tenant through `read_coach_top_objections_for_actor`. There is no platform-wide
 *   aggregate, and the underlying `coach.objection.booked_rate` is marked PROPOSED AND UNAPPROVED
 *   in its own definition, so its window and denominator are not settled yet.
 *
 * Both become buildable the day someone adds a platform aggregate; neither is buildable by
 * reshaping what the snapshot already returns, which is the only reason to say so here rather
 * than in a report nobody reads next to the code.
 */
export function AdminAgentPerformanceSurface({
  clientNames = {},
  origin,
  view,
}: {
  /** Tenant id to display name, resolved server-side; see `loadClientNames`. */
  clientNames?: Readonly<Record<string, string>>;
  origin: PlatformMeasurement["origin"];
  view: AdminMeasurementView;
}) {
  const economicsVisible = view.role !== "success";
  const [openTenantId, setOpenTenantId] = useState<string | null>(null);
  const [measureKey, setMeasureKey] = useState<MeasureKey>("booked");

  const rows = useMemo<PerformanceRow[]>(
    () => view.tenantPerformance.map((row) => ({
      ...row,
      client: clientLabel(clientNames, row.tenantId),
    })),
    [clientNames, view.tenantPerformance],
  );
  const openRow = rows.find((row) => row.tenantId === openTenantId) ?? null;

  // The window is not a sentence this surface makes up: it is the booked-appointments metric's own
  // declared window, carried through the projection with the metric it describes.
  const windowLabel = view.metrics
    .find((metric) => metric.key === "platform.booked_appointments")
    ?.descriptor.window ?? null;

  const measures = useMemo(
    () => MEASURES.filter((measure) => economicsVisible || !measure.economics),
    [economicsVisible],
  );
  const measure = measureFor(
    measures.some((candidate) => candidate.key === measureKey) ? measureKey : "booked",
  );

  const { ranked, withheld, absent } = useMemo(
    () => comparableRows(measure, rows),
    [measure, rows],
  );
  const baseline = useMemo(
    () => baselineMedian(ranked.map((entry) => entry.value)),
    [ranked],
  );
  const tinted = useMemo(
    () => (economicsVisible ? evidenceTintedRows(rows) : new Set<string>()),
    [economicsVisible, rows],
  );

  const visible = [...ranked, ...withheld].slice(0, ROW_LIMIT);

  const performanceExport: ExportMenuProps = economicsVisible
    ? {
        filename: "setterfi-platform-tenant-performance",
        mode: "server",
        resource: "platform-tenant-performance",
        query: {
          reason: EXPORT_REASON,
          columns: [
            "dataOrigin",
            "tenantId",
            "bookedAppointments",
            "grossMrrCents",
            "commissionCents",
            "marginCents",
            "marginState",
          ],
        },
      }
    : {
        filename: "setterfi-platform-tenant-performance",
        mode: "local",
        rows: view.tenantPerformance.map((row) => ({
          dataOrigin: origin === "synthetic_preview"
            ? "Synthetic review preview"
            : "Real analytics",
          tenantId: row.tenantId,
          bookedAppointments: row.bookedAppointments,
        })),
      };

  // Three figures at most, and only ones the snapshot actually carries.
  const tiles = useMemo<StatStripItem[]>(() => {
    const booked = rows.reduce((total, row) => total + row.bookedAppointments, 0);
    const items: StatStripItem[] = [
      {
        label: "Clients measured",
        availability: rows.length === 0
          ? { kind: "no-events", note: "The snapshot carried no client rows" }
          : { kind: "value", value: rows.length, format: "count" },
      },
      {
        label: "Booked appointments",
        availability: rows.length === 0
          ? { kind: "no-events", note: "The snapshot carried no client rows" }
          : { kind: "value", value: booked, format: "count" },
      },
      {
        label: "Booked per client",
        availability: rows.length === 0
          ? { kind: "unavailable", note: "No clients in this snapshot to average over" }
          : { kind: "value", value: booked / rows.length, format: "count" },
        precision: 1,
      },
    ];
    if (!economicsVisible) return items;
    const missingEvidence = rows.filter((row) => marginKey(row) === "unavailable").length;
    items.push({
      label: "Clients missing cost evidence",
      availability: rows.length === 0
        ? { kind: "unavailable", note: "No clients in this snapshot" }
        : { kind: "value", value: missingEvidence, format: "count" },
      ...(rows.length === 0 ? {} : {
        note: missingEvidence === 0
          ? "Every measured client has a cost rollup behind its margin"
          : "Margin cannot be stated for these clients yet",
      }),
    });
    return items;
  }, [economicsVisible, rows]);

  const showDelta = baseline !== null;
  const columns = economicsVisible
    ? `44px minmax(0, 1.7fr) 108px 118px 118px${showDelta ? " 124px" : ""}`
    : `44px minmax(0, 1.7fr) 118px${showDelta ? " 124px" : ""}`;
  const columnsNarrow = economicsVisible
    ? `36px minmax(0, 1.4fr) 84px 96px 96px${showDelta ? " 96px" : ""}`
    : `36px minmax(0, 1.4fr) 96px${showDelta ? " 96px" : ""}`;

  const headColumns = [
    { label: "#", align: "left" as const },
    { label: "Client", align: "left" as const },
    ...MEASURES.filter((candidate) => economicsVisible || !candidate.economics).map((candidate) => ({
      label: candidate.overline,
      align: "right" as const,
    })),
    ...(showDelta ? [{ label: "Vs median", align: "right" as const }] : []),
  ];

  return (
    <ListPage
      actions={(
        <>
          {measures.length > 1 ? (
            <Segmented
              face="sans"
              label="Rank clients by"
              onValueChange={(next) => setMeasureKey(next as MeasureKey)}
              options={measures.map((candidate) => ({ key: candidate.key, label: candidate.label }))}
              value={measure.key}
            />
          ) : null}
          <ExportMenu {...performanceExport} />
        </>
      )}
      /*
       * The canvas's sentence is "How well the fleet converts, where conversations die, and which
       * shared answers are doing the work." Two of those three clauses describe panels this page
       * cannot draw -- there is no platform-level conversation funnel and no platform aggregate of
       * objection usage (see the panel note below) -- so promising them in the description would
       * be the page telling the reader to look for something that is not there. What survives is
       * the first clause, kept in the canvas's plainer voice, plus the standing caveat that these
       * are totals and not rates, which is the thing a reader most often gets wrong here.
       */
      description={`How well the fleet converts, ranked on recorded cross-tenant measurement evidence, as totals rather than rates.${windowLabel ? ` Window: ${windowLabel.replace(/\.$/, "")}.` : ""}`}
      provenanceKind={origin === "synthetic_preview" ? "preview" : undefined}
      /*
        * The strip is drawn as console deck panels rather than as `StatStrip` tiles, which is the
        * whole visual change on this page: same items, same availability handling, the canvas's
        * card shape. Booked appointments takes the screen's one drench because it is the outcome
        * the other three figures are context for -- clients measured is a denominator, booked per
        * client is the same number divided, and missing cost evidence is a caveat. Exactly one
        * fill per console screen; `console.css` explains why the console allows one where the
        * coach side allows two.
        */
      stats={(
        <ConsoleStatDeck
          ariaLabel="Agent performance figures"
          heroLabel="Booked appointments"
          items={tiles}
        />
      )}
      title="Agent performance"
    >
      <div className="@container/perf flex min-h-0 min-w-0 flex-col gap-[var(--s-4)] overflow-y-auto">
        <Surface variant="panel">
          <SurfaceHeader
            subtitle={
              showDelta
                ? `Ranked by ${measure.label.toLowerCase()}. The baseline is the median across the ${workspaceCountFormat.format(ranked.length)} clients that carry a ${measure.label.toLowerCase()} figure.`
                : `Ranked by ${measure.label.toLowerCase()}. Fewer than ${MIN_BASELINE_ROWS} clients carry a ${measure.label.toLowerCase()} figure, so there is no median to compare against and the delta column is not drawn.`
            }
            title="Client leaderboard"
            trailing={<MonoMeta>{workspaceCountFormat.format(ranked.length)} ranked</MonoMeta>}
          />

          {rows.length === 0 ? (
            <div className="p-[var(--d-card-p)]">
              <DataState
                body="No client rows were recorded in this measurement snapshot."
                kind="empty"
                title="Nothing measured yet"
              />
            </div>
          ) : (
            <>
              <GridTable
                className="@max-[720px]/grid-table:[--grid-table-columns:var(--grid-table-columns-narrow)]"
                columns={columns}
                columnsNarrow={columnsNarrow}
                label="Client performance"
              >
                <GridTableHead columns={headColumns} />
                {visible.map((entry, index) => {
                  const isRanked = index < ranked.length;
                  const delta = showDelta && isRanked ? entry.value - baseline : null;
                  const tone = delta === null || baseline === null
                    ? "neutral"
                    : deltaTone(entry.value, baseline);
                  return (
                    <GridTableRow
                      key={entry.row.tenantId}
                      last={index === visible.length - 1}
                      selected={entry.row.tenantId === openTenantId}
                      tone={tinted.has(entry.row.tenantId) ? "warning" : "neutral"}
                    >
                      <GridTableCell>
                        <Figure size="sm" tone={isRanked && index === 0 ? "good" : "neutral"}>
                          {isRanked
                            ? String(index + 1).padStart(2, "0")
                            : "—"}
                        </Figure>
                      </GridTableCell>
                      <GridTableCell>
                        <GridTableIdentity
                          name={(
                            <button
                              className="max-w-full truncate text-left hover:text-[color:var(--accent-text)]"
                              onClick={() => setOpenTenantId(entry.row.tenantId)}
                              type="button"
                            >
                              {entry.row.client}
                            </button>
                          )}
                          subline={
                            economicsVisible
                              ? marginState(entry.row).label
                              : undefined
                          }
                        />
                      </GridTableCell>
                      {measures.map((candidate) => {
                        const value = candidate.value(entry.row);
                        const selected = candidate.key === measure.key;
                        return (
                          <GridTableCell align="right" key={candidate.key}>
                            {value === null ? (
                              absentValue(candidate.emptyLabel)
                            ) : selected ? (
                              <Figure size="md">{candidate.format(value)}</Figure>
                            ) : (
                              <MonoMeta className="text-[12.5px]">
                                {candidate.format(value)}
                              </MonoMeta>
                            )}
                            {/* A rate is never shown without the population it is over. */}
                            {selected && measure.kind === "rate" ? (
                              <MonoMeta className="mt-[2px] block text-[10.5px]">
                                {entry.denominator === null
                                  ? `no ${measure.denominatorLabel} recorded`
                                  : `of ${workspaceCountFormat.format(entry.denominator)} ${measure.denominatorLabel}`}
                              </MonoMeta>
                            ) : null}
                          </GridTableCell>
                        );
                      })}
                      {showDelta ? (
                        <GridTableCell align="right">
                          {delta === null ? (
                            <MonoMeta className="text-[12px]">not ranked</MonoMeta>
                          ) : delta === 0 ? (
                            <MonoMeta className="text-[12px]">flat</MonoMeta>
                          ) : (
                            <Figure size="sm" tone={tone}>
                              {measure.formatDelta(delta)}
                            </Figure>
                          )}
                        </GridTableCell>
                      ) : null}
                    </GridTableRow>
                  );
                })}
              </GridTable>

              <GridTableFooter
                left={(
                  <>
                    {visible.length < rows.length
                      ? `Showing ${workspaceCountFormat.format(visible.length)} of ${workspaceCountFormat.format(rows.length)} measured clients; the export carries all of them.`
                      : `${workspaceCountFormat.format(rows.length)} measured clients.`}
                    {absent.length > 0
                      ? ` ${workspaceCountFormat.format(absent.length)} carry no ${measure.label.toLowerCase()} figure and are not ranked.`
                      : ""}
                    {withheld.length > 0
                      ? ` ${workspaceCountFormat.format(withheld.length)} are below the sample this measure may be ranked on.`
                      : ""}
                  </>
                )}
                right={
                  showDelta
                    ? `median ${measure.format(baseline)} · ${workspaceCountFormat.format(ranked.length)} clients`
                    : undefined
                }
              />
            </>
          )}
        </Surface>

        <div className="grid grid-cols-1 gap-[var(--s-4)] @min-[760px]/perf:grid-cols-2">
          <FollowupReplyPanel rows={view.followupPerformance} />
          <SuggestedActionPanel />
        </div>
      </div>

      <RecordSheet
        onOpenChange={(open) => {
          if (!open) setOpenTenantId(null);
        }}
        open={openRow !== null}
        secondaryAction={{ label: "Open client book", href: "/admin/platform-clients" }}
        sections={openRow ? [
          {
            title: "Recorded results",
            body: (
              <dl className="m-0 grid grid-cols-1 gap-[var(--s-3)] sm:grid-cols-2">
                <KeyValue
                  label="Booked appointments"
                  layout="stacked"
                  value={workspaceCountFormat.format(openRow.bookedAppointments)}
                />
                {economicsVisible ? (
                  <>
                    <KeyValue
                      label="Gross MRR"
                      layout="stacked"
                      value={moneyValue(openRow.grossMrrCents, "No priced subscription")}
                    />
                    <KeyValue
                      label="Affiliate commission"
                      layout="stacked"
                      value={moneyValue(openRow.commissionCents, "No commission recorded")}
                    />
                    <KeyValue
                      label="Margin"
                      layout="stacked"
                      value={moneyValue(openRow.marginCents, "No cost evidence")}
                    />
                  </>
                ) : null}
              </dl>
            ),
          },
        ] : []}
        state={openRow && economicsVisible ? {
          kind: "lifecycle",
          label: marginState(openRow).label,
          tone: marginState(openRow).tone,
        } : undefined}
        subtitle="Recorded evidence behind this row."
        technical={openRow ? [{ label: "Client", value: openRow.tenantId, mono: true }] : undefined}
        title={openRow?.client ?? ""}
      />
    </ListPage>
  );
}
