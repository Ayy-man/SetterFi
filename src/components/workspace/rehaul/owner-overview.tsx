"use client";

/**
 * Owner Overview, rehaul draw.
 *
 * The screen is the artboard: a title with the day it was read, a window switch over the signup
 * history, an export, one drenched pulse card carrying revenue, four KPI cards that each open a
 * figures dialog, a signups bar panel and the decision queue.
 *
 * Every figure on it comes from the one platform measurement snapshot the page already loads
 * (`loadPlatformMeasurement`) and is projected through `adminMeasurementView`, so a success
 * reviewer is refused revenue at the serialization boundary rather than by JSX. Nothing here
 * derives a figure the snapshot does not carry: where the artboard draws a series the RPC has no
 * evidence for (a revenue history, an active-subscription history, signup source attribution), the
 * slot renders its absence in words instead of an invented line.
 */

import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";

import { BarChart } from "@/components/kit/bar-chart";
import { DataState } from "@/components/kit/data-state";
import { ExportMenu } from "@/components/kit/export-menu";
import { LineChart } from "@/components/kit/line-chart";
import { Sparkline, SPARKLINE_MIN_POINTS } from "@/components/kit/sparkline";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { formatMetric } from "@/lib/format/metric";
import type { PlatformMeasurement } from "@/lib/repositories/platform-analytics";
import { cn } from "@/lib/utils";

import {
  adminMeasurementView,
  type PlatformMeasurementRole,
  type PlatformMetricView,
} from "../live/admin-measurement-view-models";

/* ------------------------------------------------------------------ constants */

const DETAIL_HREF = "/admin/overview/detail";
const SUPPORT_HREF = "/admin/support";
const EXPORT_FILENAME = "setterfi-platform-operating-figures";

/**
 * The window switch, over the one windowed series the snapshot carries.
 *
 * The artboard draws 1D / 1W / 1M / 3M / All. Platform measurement is a point-in-time read at one
 * as-of instant with no window parameter, so four of those five would move nothing: a control that
 * reads as broken is worse than no control. What the RPC does emit is a contiguous run of 30-day
 * signup periods, so the switch picks how many of them the signup series draws, and every figure
 * beside it keeps naming its own window so the switch cannot be read as governing them.
 */
const HISTORY_WINDOWS = [
  { key: "3m", label: "3M", periods: 3 },
  { key: "6m", label: "6M", periods: 6 },
  { key: "all", label: "All", periods: null },
] as const;

type HistoryWindowKey = (typeof HISTORY_WINDOWS)[number]["key"];

const DEFAULT_WINDOW: HistoryWindowKey = "all";

/** The four cards under the pulse, in the order the artboard draws them. */
const KPI_KEYS = [
  "platform.new_signups",
  "platform.active_subscriptions",
  "platform.churn_rate",
  "platform.time_to_live",
] as const;

/** The pulse leads on revenue; a role refused revenue leads on signups instead. */
const PULSE_KEYS = ["platform.gross_mrr", "platform.new_signups"] as const;

const LONG_DATE = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
  year: "numeric",
});

const PERIOD_LABEL = new Intl.DateTimeFormat("en-US", {
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

const SHORT_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

/* -------------------------------------------------------------------- format */

function longDate(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Date not recorded";
  // en-GB puts a comma after the weekday; the artboard does not, and the comma is the only
  // difference between the two spellings.
  return LONG_DATE.format(parsed).replace(",", "");
}

function periodLabel(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Period" : PERIOD_LABEL.format(parsed);
}

function shortDate(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Not recorded" : SHORT_DATE.format(parsed);
}

/**
 * The reading for a figure slot.
 *
 * A days-unit metric arrives from the view model as "9 days"; the figure slot holds a number, so
 * the unit is compressed to the suffix the artboard draws rather than putting a word where the
 * reader's eye is trained to find only a figure.
 */
function figureText(view: PlatformMetricView | undefined) {
  if (!view || view.value === null) return null;
  return view.value.replace(/\s*days$/u, "d");
}

function absenceText(view: PlatformMetricView | undefined) {
  return view?.absenceLabel ?? "Unavailable";
}

/* ---------------------------------------------------------------- derivation */

export function resolveHistoryWindow(value: string | undefined): HistoryWindowKey {
  const match = HISTORY_WINDOWS.find((entry) => entry.key === value?.toLowerCase());
  return match ? match.key : DEFAULT_WINDOW;
}

function windowedHistory(
  history: PlatformMeasurement["history"],
  key: HistoryWindowKey,
): PlatformMeasurement["history"] {
  const entry = HISTORY_WINDOWS.find((row) => row.key === key);
  if (!entry || entry.periods === null) return history;
  return history.slice(-entry.periods);
}

/** Revenue-bearing subscriptions, counted off the rows rather than asserted. */
function activeSubscriptions(measurement: PlatformMeasurement) {
  return measurement.subscriptions.filter((row) => /^(active|trialing)$/iu.test(row.status)).length;
}

function pastDueSubscriptions(measurement: PlatformMeasurement) {
  return measurement.subscriptions.filter((row) =>
    /past_due|unpaid|incomplete/iu.test(row.status),
  ).length;
}

type SignupDelta = { text: string; tone: "good" | "bad" | "neutral" };

function signupDelta(history: PlatformMeasurement["history"]): SignupDelta | null {
  const previous = history.at(-2);
  const current = history.at(-1);
  if (!previous || !current) return null;
  const difference = current.value - previous.value;
  if (difference === 0) {
    return { text: `level with ${periodLabel(previous.periodStart)}`, tone: "neutral" };
  }
  return {
    text: `${difference > 0 ? "+" : "−"}${formatMetric(Math.abs(difference), "count")}`,
    tone: difference > 0 ? "good" : "bad",
  };
}

export type OverviewDecision = {
  id: string;
  title: string;
  count: number;
  tone: "warning" | "critical" | "info";
  href: string;
};

/**
 * The decision queue, over the categories the snapshot can actually count.
 *
 * Each count restates the filter it was taken through, so no row can claim a population the
 * evidence tables would contradict. Categories with no evidence in this read (unanswered human
 * handoffs, re-approvals, correction decisions) are not listed at all.
 */
export function overviewDecisions(measurement: PlatformMeasurement): OverviewDecision[] {
  const provisioningBlocks = measurement.provisioningPerformance
    .filter((row) => row.state === "blocked" || row.state === "failed")
    .reduce((total, row) => total + row.failures, 0);
  const heldReplies = measurement.guardrailRules.reduce((total, row) => total + row.holds, 0);
  const exhaustedFollowups = measurement.followupPerformance.reduce(
    (total, row) => total + row.exhausted,
    0,
  );

  return [
    {
      id: "past-due",
      title: "Past due subscriptions",
      count: pastDueSubscriptions(measurement),
      tone: "critical",
      href: "/admin/billing",
    },
    {
      id: "provisioning",
      title: "Provisioning blocks",
      count: provisioningBlocks,
      tone: "critical",
      href: "/admin/provisioning",
    },
    {
      id: "holds",
      title: "Held replies awaiting a decision",
      count: heldReplies,
      tone: "warning",
      href: SUPPORT_HREF,
    },
    {
      id: "exhausted",
      title: "Follow-up cadences exhausted",
      count: exhaustedFollowups,
      tone: "info",
      href: SUPPORT_HREF,
    },
  ];
}

function exportRows(
  measurement: PlatformMeasurement,
  metrics: readonly PlatformMetricView[],
) {
  return metrics.map((view) => ({
    dataOrigin:
      measurement.origin === "synthetic_preview" ? "Synthetic review preview" : "Real analytics",
    asOf: measurement.asOf,
    metricKey: view.key,
    label: view.label,
    value: view.value ?? view.absenceLabel ?? "Unavailable",
    denominator: view.descriptor.denominator,
    window: view.descriptor.window,
    clock: view.descriptor.clock,
  }));
}

/* --------------------------------------------------------------- small parts */

function Label({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("text-[12.5px] font-medium text-[var(--faint)]", className)}>{children}</div>
  );
}

function Figure({
  children,
  className,
  size,
}: {
  children: React.ReactNode;
  className?: string;
  size: number;
}) {
  return (
    <div
      className={cn("font-mono font-medium tracking-[-0.05em] tabular-nums", className)}
      style={{ fontSize: size, lineHeight: 1 }}
    >
      {children}
    </div>
  );
}

function Pill({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "good" | "bad";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-[var(--s-1)] rounded-[6px] border px-[var(--s-2)] py-[2px] text-[12px]",
        tone === "good" && "border-[var(--good)] text-[var(--good)]",
        tone === "bad" && "border-[var(--warning-line)] text-[var(--warning-text)]",
        tone === "neutral" && "border-[var(--line)] text-[var(--muted)]",
      )}
    >
      {children}
    </span>
  );
}

function Dot({ tone }: { tone: "good" | "amber" | "wait" | "grey" }) {
  const background =
    tone === "good"
      ? "var(--good)"
      : tone === "amber"
        ? "var(--warning)"
        : tone === "wait"
          ? "var(--accent)"
          : "var(--line-strong)";
  return (
    <span
      aria-hidden="true"
      className="block size-[7px] shrink-0 rounded-full"
      style={{ background }}
    />
  );
}

function ExpandIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="14"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="14"
    >
      <path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" />
    </svg>
  );
}

/* ------------------------------------------------------------ fluid charts */

/**
 * The drawn width of a chart that has to fill a fluid column.
 *
 * `BarChart` and `LineChart` compute their geometry in real pixels rather than stretching a
 * viewBox, which is what keeps a 2px stroke 2px wide and a 4px bar radius round. That means the
 * panel has to measure itself and hand the width down. The fallback is the artboard's own width,
 * so a first paint and a server render both draw something sensible.
 */
function useMeasuredWidth(fallback: number) {
  const [width, setWidth] = useState(fallback);
  // A callback ref rather than a stored one: the observer attaches the moment the node mounts and
  // detaches when it unmounts, so nothing reads a ref while the component is rendering.
  const measure = useCallback((node: HTMLDivElement | null) => {
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      if (next > 0) setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { measure, width };
}

/* ---------------------------------------------------------------- the screen */

export type OwnerOverviewProps = {
  measurement: PlatformMeasurement;
  role: PlatformMeasurementRole;
  /** The `window` search param, which picks how much signup history the series draws. */
  historyWindow?: string;
};

export function OwnerOverview({ historyWindow, measurement, role }: OwnerOverviewProps) {
  const [openMetric, setOpenMetric] = useState<string | null>(null);
  const projected = useMemo(() => adminMeasurementView(measurement, role), [measurement, role]);
  const byKey = useMemo(() => {
    const map = new Map<string, PlatformMetricView>();
    for (const view of projected.metrics) map.set(view.key, view);
    return map;
  }, [projected.metrics]);

  const activeWindow = resolveHistoryWindow(historyWindow);
  const history = windowedHistory(measurement.history, activeWindow);
  const active = activeSubscriptions(measurement);
  const pastDue = pastDueSubscriptions(measurement);
  const delta = signupDelta(history);
  const decisions = overviewDecisions(measurement).filter((row) => row.count > 0).slice(0, 5);

  const pulseKey = PULSE_KEYS.find((key) => byKey.has(key)) ?? null;
  const pulse = pulseKey ? byKey.get(pulseKey) : undefined;
  const kpis = KPI_KEYS.flatMap((key) => {
    const view = byKey.get(key);
    return view ? [{ key, view }] : [];
  });

  const barsDrawable = history.length >= 2 && history.some((period) => period.value > 0);
  const { measure: measureBars, width: barsWidth } = useMeasuredWidth(640);

  return (
    <div className="flex min-w-0 flex-col gap-[var(--s-4)]">
      <header className="flex flex-wrap items-end gap-[var(--s-3)]">
        <div className="min-w-0">
          <h1 className="m-0 text-[30px] leading-[1.1] font-semibold tracking-[-0.02em] text-[var(--ink)]">
            Overview
          </h1>
          <p className="m-0 mt-[var(--s-1)] text-[var(--faint)]">{longDate(measurement.asOf)}</p>
        </div>
        <div className="ml-auto flex items-center gap-[var(--s-2)]">
          <nav
            aria-label="Signup history range"
            className="inline-flex rounded-[8px] border border-[var(--line)] bg-[var(--card)] p-[2px]"
            data-slot="history-window"
          >
            {HISTORY_WINDOWS.map((entry) => {
              const on = entry.key === activeWindow;
              return (
                <Link
                  aria-current={on ? "true" : undefined}
                  className={cn(
                    "rounded-[6px] px-[10px] py-[5px] text-[12.5px] no-underline",
                    on
                      ? "bg-[var(--accent-wash-strong)] font-medium text-[var(--accent-text)]"
                      : "text-[var(--faint)] hover:text-[var(--ink)]",
                  )}
                  href={`/admin/overview?window=${entry.key}`}
                  key={entry.key}
                  scroll={false}
                >
                  {entry.label}
                </Link>
              );
            })}
          </nav>
          <ExportMenu
            filename={EXPORT_FILENAME}
            mode="local"
            rows={exportRows(measurement, projected.metrics)}
          />
        </div>
      </header>

      {/* The one drenched surface the screen is allowed: the figure it is opened for. */}
      <section
        aria-labelledby="overview-pulse-heading"
        className="flex min-h-[196px] flex-wrap items-stretch gap-[var(--s-6)] rounded-[14px] px-[28px] py-[24px]"
        data-slot="overview-pulse"
        style={{
          background:
            "linear-gradient(160deg, oklch(0.30 0.07 262), oklch(0.19 0.045 262) 70%)",
          border: "1px solid oklch(0.22 0.04 262)",
          boxShadow: "0 18px 40px -22px rgba(28,42,82,0.6)",
          color: "oklch(0.97 0.004 262)",
        }}
      >
        <div className="flex min-w-[260px] flex-1 flex-col">
          <h2
            className="m-0 text-[12.5px] font-medium"
            id="overview-pulse-heading"
            style={{ color: "oklch(0.78 0.02 262)" }}
          >
            {pulse?.label ?? "Gross MRR"}
          </h2>
          <Figure className="my-[var(--s-2)]" size={72}>
            {pulse && pulse.value !== null ? (
              figureText(pulse)
            ) : (
              <span style={{ color: "oklch(0.78 0.02 262)" }}>{"–"}</span>
            )}
          </Figure>
          <p className="m-0" style={{ color: "oklch(0.78 0.02 262)" }}>
            {pulse && pulse.value !== null
              ? pulseKey === "platform.gross_mrr"
                ? `across ${formatMetric(active, "count")} active ${active === 1 ? "subscription" : "subscriptions"}`
                : "trailing 30 days"
              : absenceText(pulse)}
          </p>
          <p
            className="mt-auto pt-[var(--s-4)] font-mono text-[11px]"
            style={{ color: "oklch(0.70 0.02 262)" }}
          >
            No revenue history series is recorded in this snapshot
          </p>
        </div>
        <dl
          className="m-0 grid min-w-[260px] flex-1 grid-cols-3 content-end gap-[var(--s-5)] pl-[var(--s-6)]"
          style={{ borderLeft: "1px solid rgba(255,255,255,0.12)" }}
        >
          <PulseSubstat
            label={active === 1 ? "Active client" : "Active clients"}
            value={formatMetric(active, "count")}
          />
          <PulseSubstat
            label="Booked calls"
            value={figureText(byKey.get("platform.booked_appointments"))}
            absence={absenceText(byKey.get("platform.booked_appointments"))}
            present={byKey.has("platform.booked_appointments")}
          />
          <PulseSubstat
            label="Margin"
            value={figureText(byKey.get("platform.margin"))}
            absence={absenceText(byKey.get("platform.margin"))}
            present={byKey.has("platform.margin")}
          />
        </dl>
      </section>

      <div className="grid min-w-0 gap-[var(--s-4)] sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map(({ key, view }) => (
          <article
            className="relative flex flex-col rounded-[14px] border border-[var(--line)] bg-[var(--card)] px-[18px] py-[16px]"
            data-slot="overview-kpi"
            key={key}
          >
            <Label>{view.label}</Label>
            <div className="mt-[var(--s-2)] flex flex-wrap items-baseline gap-[10px]">
              <Figure size={34}>
                {view.value === null ? (
                  <span className="text-[var(--faint)]">{"–"}</span>
                ) : (
                  figureText(view)
                )}
              </Figure>
              {view.value === null ? (
                <Pill>{absenceText(view)}</Pill>
              ) : key === "platform.new_signups" ? (
                delta ? (
                  <Pill tone={delta.tone}>{delta.text}</Pill>
                ) : (
                  <Pill>no prior period</Pill>
                )
              ) : key === "platform.active_subscriptions" ? (
                <Pill tone={pastDue > 0 ? "bad" : "neutral"}>
                  {pastDue > 0 ? `${formatMetric(pastDue, "count")} past due` : "none past due"}
                </Pill>
              ) : key === "platform.churn_rate" ? (
                <Pill>most recent cycle</Pill>
              ) : (
                <Pill>median</Pill>
              )}
            </div>
            <div className="mt-[10px] h-[36px]">
              {key === "platform.new_signups" && history.length >= SPARKLINE_MIN_POINTS ? (
                <Sparkline
                  className="h-[36px] w-full"
                  height={36}
                  label={`${view.label} by 30-day period`}
                  points={history.map((period) => period.value)}
                  width={220}
                />
              ) : (
                <p className="m-0 font-mono text-[11px] text-[var(--faint)]">
                  No period series recorded
                </p>
              )}
            </div>
            <button
              aria-label={`Expand ${view.label}`}
              className="absolute top-[14px] right-[14px] text-[var(--faint)] hover:text-[var(--ink)]"
              onClick={() => setOpenMetric(key)}
              type="button"
            >
              <ExpandIcon />
            </button>
          </article>
        ))}
      </div>

      <div className="grid min-w-0 gap-[var(--s-4)] lg:grid-cols-[1.4fr_1fr]">
        <section
          aria-labelledby="signups-by-period-heading"
          className="flex min-w-0 flex-col rounded-[14px] border border-[var(--line)] bg-[var(--card)] px-[20px] py-[18px]"
          data-slot="signups-panel"
        >
          <div className="flex flex-wrap items-center gap-[var(--s-2)]">
            <h2
              className="m-0 text-[15px] font-semibold text-[var(--ink)]"
              id="signups-by-period-heading"
            >
              Signups by period
            </h2>
            <span className="ml-auto text-[12.5px] font-medium text-[var(--faint)]">
              trailing 30 days each
            </span>
          </div>
          <div className="mt-[14px]" ref={measureBars}>
            {barsDrawable ? (
              <BarChart
                height={150}
                label={`Signups by 30-day period: ${history
                  .map(
                    (period) =>
                      `${periodLabel(period.periodStart)} ${formatMetric(period.value, "count")}`,
                  )
                  .join(", ")}`}
                labels={history.map((period) => periodLabel(period.periodStart))}
                values={history.map((period) => period.value)}
                width={barsWidth}
              />
            ) : (
              <DataState
                body="The chart appears once a full 30-day period has closed with a recorded signup."
                kind="empty"
                title="No completed signup period yet"
              />
            )}
          </div>
        </section>

        <section
          aria-labelledby="needs-a-decision-heading"
          className="flex min-w-0 flex-col rounded-[14px] border border-[var(--line)] bg-[var(--card)] px-[20px] py-[18px]"
          data-slot="decision-queue"
        >
          <div className="flex flex-wrap items-center gap-[var(--s-2)]">
            <h2
              className="m-0 text-[15px] font-semibold text-[var(--ink)]"
              id="needs-a-decision-heading"
            >
              Needs a decision
            </h2>
            <Link
              className="ml-auto text-[12.5px] font-medium text-[var(--accent-text)] no-underline hover:underline"
              href={SUPPORT_HREF}
            >
              Open the queue
            </Link>
          </div>
          {decisions.length === 0 ? (
            <p className="mt-[10px] m-0 text-[var(--muted)]">
              Nothing in this snapshot is waiting on a person.
            </p>
          ) : (
            <ul className="m-0 mt-[10px] flex list-none flex-col p-0">
              {decisions.map((row, index) => (
                <li
                  className={cn(
                    "flex h-[40px] items-center gap-[10px]",
                    index < decisions.length - 1 && "border-b border-[var(--line-soft)]",
                  )}
                  key={row.id}
                >
                  <Dot tone={row.tone === "info" ? "wait" : "amber"} />
                  <Link
                    className="min-w-0 flex-1 truncate text-[var(--ink)] no-underline hover:underline"
                    href={row.href}
                  >
                    {row.title}
                  </Link>
                  <span
                    className={cn(
                      "font-mono text-[11.5px] tabular-nums",
                      row.tone === "info" ? "text-[var(--faint)]" : "text-[var(--warning-text)]",
                    )}
                  >
                    {formatMetric(row.count, "count")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <FiguresDialog
        active={active}
        history={history}
        kpis={kpis}
        measurement={measurement}
        metrics={projected.metrics}
        onOpenChange={(next) => {
          if (!next) setOpenMetric(null);
        }}
        openMetric={openMetric}
        subscriptions={projected.subscriptions}
      />

      <ContextEye
          screen="owner-overview"
          copy="Every figure here is read from one platform measurement snapshot at a single as-of instant. Gross MRR and active subscriptions are point-in-time; signups and booked calls are trailing 30 days; churn is the most recent complete billing cycle. Demo tenants and test rows are excluded at the source."
        />
    </div>
  );
}

function PulseSubstat({
  absence,
  label,
  present = true,
  value,
}: {
  absence?: string;
  label: string;
  present?: boolean;
  value: string | null;
}) {
  if (!present) return null;
  return (
    <div>
      <dd className="m-0">
        <Figure size={34}>
          {value ?? <span style={{ color: "oklch(0.78 0.02 262)" }}>{"–"}</span>}
        </Figure>
      </dd>
      <dt className="mt-[6px] text-[13.5px]" style={{ color: "oklch(0.78 0.02 262)" }}>
        {value === null ? (absence ?? label) : label}
      </dt>
    </div>
  );
}

/* -------------------------------------------------------------------- dialog */

const DIALOG_TABS = [
  { id: "acquisition", label: "Acquisition" },
  { id: "subscriptions", label: "Subscriptions" },
  { id: "followups", label: "Follow-ups" },
  { id: "guardrails", label: "Guardrails" },
  { id: "provisioning", label: "Provisioning" },
] as const;

function subscriptionTone(status: string): "good" | "amber" | "wait" | "grey" {
  if (/^(active|trialing)$/iu.test(status)) return "good";
  if (/past_due|unpaid|incomplete/iu.test(status)) return "amber";
  if (/canceled|cancelled/iu.test(status)) return "grey";
  return "wait";
}

function FiguresDialog({
  active,
  history,
  kpis,
  measurement,
  metrics,
  onOpenChange,
  openMetric,
  subscriptions,
}: {
  active: number;
  history: PlatformMeasurement["history"];
  kpis: readonly { key: string; view: PlatformMetricView }[];
  measurement: PlatformMeasurement;
  metrics: readonly PlatformMetricView[];
  onOpenChange: (open: boolean) => void;
  openMetric: string | null;
  subscriptions: readonly Record<string, string>[];
}) {
  const opened = kpis.find((row) => row.key === openMetric) ?? null;
  const delta = signupDelta(history);
  const drawable = history.length >= 2;
  const { measure: measureLine, width: lineWidth } = useMeasuredWidth(700);

  return (
    <Dialog onOpenChange={onOpenChange} open={openMetric !== null}>
      <DialogContent
        className="flex h-[min(760px,calc(100dvh-4rem))] w-full max-w-[1120px] flex-col gap-0 overflow-hidden bg-[var(--canvas)] p-0 sm:max-w-[1120px]"
        data-slot="overview-figures-dialog"
      >
        <div className="flex flex-wrap items-center gap-[14px] px-[24px] pt-[18px]">
          <div className="min-w-0">
            <Label>{opened?.view.label ?? "Figures"}</Label>
            <div className="flex flex-wrap items-baseline gap-[12px]">
              <DialogTitle className="sr-only">
                {opened ? `${opened.view.label}, figures` : "Figures"}
              </DialogTitle>
              <div
                className="m-0 font-mono text-[44px] leading-none font-medium tracking-[-0.05em] tabular-nums text-[var(--ink)]"
                data-slot="dialog-figure"
              >
                {opened && opened.view.value !== null ? (
                  figureText(opened.view)
                ) : (
                  <span className="text-[var(--faint)]">{"–"}</span>
                )}
              </div>
              {opened?.key === "platform.new_signups" && delta ? (
                <span
                  className={cn(
                    "font-mono text-[13px]",
                    delta.tone === "good"
                      ? "text-[var(--good)]"
                      : delta.tone === "bad"
                        ? "text-[var(--warning-text)]"
                        : "text-[var(--muted)]",
                  )}
                >
                  {delta.text}
                </span>
              ) : null}
            </div>
          </div>
          <div className="ml-auto flex items-center gap-[var(--s-2)] pr-[36px]">
            <ExportMenu
              filename={EXPORT_FILENAME}
              mode="local"
              rows={exportRows(measurement, metrics)}
            />
          </div>
        </div>

        <div className="mt-[10px] flex flex-wrap gap-[22px] border-b border-[var(--line)] px-[24px] text-[13px]">
          <span className="border-b-2 border-[var(--accent)] py-[8px] font-medium text-[var(--accent-text)]">
            Figures
          </span>
          {DIALOG_TABS.map((tab) => (
            <Link
              className="py-[8px] text-[var(--faint)] no-underline hover:text-[var(--ink)]"
              href={`${DETAIL_HREF}#${tab.id}`}
              key={tab.id}
            >
              {tab.label}
            </Link>
          ))}
        </div>

        <div className="grid min-h-0 flex-1 gap-[20px] overflow-y-auto px-[24px] py-[20px] lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-[18px]">
            <div className="flex flex-wrap items-center gap-[16px] text-[12.5px]">
              <h3 className="m-0 text-[13px] font-semibold text-[var(--ink)]">
                Signups and active subscriptions
              </h3>
            </div>
            {drawable ? (
              <div ref={measureLine}>
                <LineChart
                  height={260}
                  label="Signups by 30-day period"
                  labels={history.map((period) => periodLabel(period.periodStart))}
                  series={[
                    { name: "Signups", values: history.map((period) => period.value) },
                  ]}
                  width={lineWidth}
                />
              </div>
            ) : (
              <DataState
                body="Two closed periods are the fewest a line can honestly be drawn from."
                kind="empty"
                title="Not enough signup history yet"
              />
            )}
            <p className="m-0 font-mono text-[11px] text-[var(--faint)]">
              No active-subscription history series is recorded, so only signups are drawn
            </p>
            <div className="mt-auto grid gap-[12px] sm:grid-cols-2 xl:grid-cols-4">
              {kpis.map(({ key, view }) => (
                <div
                  className={cn(
                    "rounded-[11px] border px-[14px] py-[12px]",
                    key === openMetric
                      ? "border-[var(--accent)] bg-[var(--accent-wash)]"
                      : "border-[var(--line)] bg-[var(--well)]",
                  )}
                  key={key}
                >
                  <Label>{view.label}</Label>
                  <Figure className="mt-[4px] text-[var(--ink)]" size={24}>
                    {view.value === null ? (
                      <span className="text-[var(--faint)]">{"–"}</span>
                    ) : (
                      figureText(view)
                    )}
                  </Figure>
                </div>
              ))}
            </div>
          </div>

          <section
            aria-labelledby="dialog-subscriptions-heading"
            className="flex min-h-0 flex-col overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--card)]"
          >
            <div className="flex items-center gap-[var(--s-2)] border-b border-[var(--line)] px-[14px] py-[10px]">
              <h3
                className="m-0 text-[13.5px] font-semibold text-[var(--ink)]"
                id="dialog-subscriptions-heading"
              >
                Subscriptions in this snapshot
              </h3>
              <span className="ml-auto font-mono text-[11.5px] text-[var(--faint)] tabular-nums">
                {formatMetric(active, "count")} active
              </span>
            </div>
            {subscriptions.length === 0 ? (
              <p className="m-0 px-[14px] py-[12px] text-[var(--muted)]">
                No subscription row is recorded in this snapshot.
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col overflow-y-auto p-0">
                {subscriptions.map((row, index) => (
                  <li
                    className={cn(
                      "px-[14px] py-[12px]",
                      index < subscriptions.length - 1
                        && "border-b border-[var(--line-soft)]",
                    )}
                    key={`${row.tenantId}-${row.periodStart}`}
                  >
                    <div className="flex items-center gap-[8px]">
                      <Dot tone={subscriptionTone(row.status ?? "")} />
                      <span className="min-w-0 flex-1 truncate font-medium text-[var(--ink)]">
                        {row.tenantId}
                      </span>
                      <span className="font-mono text-[11.5px] text-[var(--faint)] tabular-nums">
                        {shortDate(row.periodStart ?? "")}
                      </span>
                    </div>
                    <div className="mt-[3px] pl-[15px] text-[12.5px] text-[var(--faint)]">
                      {row.status} · renews {shortDate(row.periodEnd ?? "")}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="m-0 mt-auto border-t border-[var(--line-soft)] px-[14px] py-[10px] font-mono text-[11px] text-[var(--faint)]">
              Demo and test rows are excluded at the source
            </p>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
