"use client";

import Link from "next/link";
import { useState } from "react";

import { DayCounter, elapsedWorkspaceDays } from "@/components/kit/day-counter";
import { SegmentedControl } from "@/components/kit/segmented-control";
import { Sparkline } from "@/components/kit/sparkline";
import { LineChart } from "@/components/kit/line-chart";
import { ExportMenu } from "@/components/kit/export-menu";
import { Figure, Pill, StatusDot } from "@/components/workspace/rehaul/_primitives";
import {
  availableMetric,
  metricDefinition,
  type MetricEvidence,
  type MetricKey,
} from "@/lib/analytics/metric-definitions";
import { formatMetric } from "@/lib/format/metric";
import { workspaceCountFormat } from "@/lib/format/datetime";
import { CARRIER_TYPICAL_DAYS } from "@/lib/onboarding/contracts";
import type {
  CoachLeadComposition,
  CoachMeasurement,
  CoachMeasurementWindow,
} from "@/lib/repositories/analytics";
import type { CoachChannelStatus } from "@/components/workspace/live/coach-channel-status";
import type { MessagingChannel } from "@/lib/integrations/types";

/*
 * TODO(rehaul): swap the inline eye for the shared component once
 * `src/components/workspace/rehaul/context-eye.tsx` lands. The exact JSX this file wants is:
 *
 *   <ContextEye copy={EYE_COPY} screen="coach-dashboard" />
 *
 * with `import { ContextEye } from "@/components/workspace/rehaul/context-eye";` at the top.
 * Until then `EYE_COPY` is rendered by `InlineEye` at the foot of the page body, so the sentences
 * the old surface printed under its headings are on the screen exactly once, in the eye's slot.
 */

/**
 * Every explainer sentence the live coach dashboard printed under a heading, moved off the page.
 *
 * These are `coach-measurement.tsx`'s own `DECK_COPY` sentences and the carrier reassurance from
 * `CoachCarrierNotice`, copied verbatim rather than imported because neither is exported and that
 * file is not ours to edit. If a sentence there changes, it changes here.
 */
const EYE_COPY = [
  "Leads: everyone your agent reached in the window you picked.",
  "Booked: leads who took a slot on your calendar.",
  "Time to book: the average from a lead's first message to a call on the calendar.",
  "The keyword table counts opt-ins per conversation and qualified and booked per contact, so a lead who returns through a second keyword is counted on both rows.",
  "Percent view uses each keyword's share of all keyword opt-ins; qualified and booked use that keyword's opt-ins.",
  "Carriers take about three weeks to approve a new business for texting. Nothing is broken and there is nothing for you to do.",
].join(" ");

/**
 * How a panel sentence names the window it is counting over.
 *
 * A fixed "this month" is false on five of the six settings, so the phrase follows the control.
 * Same table as the live surface's `WINDOW_PHRASE`, for the same reason.
 */
const WINDOW_PHRASE: Record<CoachMeasurementWindow, string> = {
  "1d": "today",
  "1w": "this week",
  "1m": "this month",
  "3m": "in the last three months",
  all: "since you started",
  custom: "in the window you picked",
};

/** The five pills the artboard draws. `custom` has no pill; it stays a URL the page still reads. */
const WINDOW_PILLS = [
  { value: "1d", label: "1D" },
  { value: "1w", label: "1W" },
  { value: "1m", label: "1M" },
  { value: "3m", label: "3M" },
  { value: "all", label: "All" },
] as const satisfies ReadonlyArray<{ value: CoachMeasurementWindow; label: string }>;

const COACH_CHANNEL_NAMES: Readonly<Record<MessagingChannel, string>> = {
  instagram: "Instagram",
  messenger: "Messenger",
  sms: "Text messaging",
  webchat: "Web chat",
  whatsapp: "WhatsApp",
};

export type CoachDashboardProps = {
  attention: {
    threadsNeedingHuman: number;
    leadsToCallBack: number;
    blockedSetupSteps: number;
    openConversations?: number;
  };
  billingPeriod?: { periodStart: string; periodEnd: string } | null | "unavailable";
  channelStatus?: CoachChannelStatus | null;
  composition: CoachLeadComposition;
  customFrom?: string | null;
  customTo?: string | null;
  greeting?: string | null;
  measurement: CoachMeasurement;
  window: CoachMeasurementWindow;
  /** Injected by tests so the day counter and the elapsed reading cannot disagree. */
  now?: Date;
};

/* --------------------------------------------------------------------------------------------
 * Readings
 * ------------------------------------------------------------------------------------------ */

type Reading =
  | { kind: "value"; text: string }
  | { kind: "absent"; note: string };

function metricFormat(evidence: MetricEvidence) {
  const unit = metricDefinition(evidence.metricKey).unit;
  if (unit === "percent") return "percent" as const;
  if (unit === "seconds" || unit === "days") return "duration" as const;
  return "count" as const;
}

/**
 * One figure, or the reason there is not one.
 *
 * The five ways a figure can be absent are this page's whole honest-states story, so an absent
 * reading carries its own words rather than falling back to a zero or to a dash with no cause.
 * The arms are the same ones `coach-measurement.tsx` derives, read off the same evidence rows.
 */
function readMetric(measurement: CoachMeasurement, key: MetricKey): Reading {
  const evidence = measurement.metrics.find((metric) => metric.metricKey === key);
  if (!evidence) return { kind: "absent", note: "No sourced reading is available for this window." };

  const definition = metricDefinition(evidence.metricKey);
  if (
    definition.requiresPositiveDenominator
    && (evidence.denominator === null
      || !Number.isFinite(evidence.denominator)
      || evidence.denominator <= 0)
  ) {
    return { kind: "absent", note: "There is no eligible activity for this calculation." };
  }

  const value = availableMetric(evidence);
  if (value !== null) return { kind: "value", text: formatMetric(value, metricFormat(evidence)) };

  if (evidence.state === "still_filling" || evidence.state === "needs_more_history") {
    return { kind: "absent", note: "This window is still filling." };
  }
  return { kind: "absent", note: "This window has no sourced reading yet." };
}

/* --------------------------------------------------------------------------------------------
 * Faces
 * ------------------------------------------------------------------------------------------ */

const PANEL_CLASS = [
  "flex min-w-0 flex-col overflow-hidden rounded-[24px_24px_17px_17px]",
  "border border-[var(--line)]",
  "bg-[linear-gradient(180deg,var(--card-top),var(--card))]",
  "shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_1px_2px_rgba(28,42,82,0.04),0_8px_20px_-14px_rgba(28,42,82,0.16)]",
].join(" ");

const PANEL_DARK_CLASS = [
  "flex min-w-0 flex-col overflow-hidden rounded-[24px_24px_17px_17px]",
  "border border-[oklch(0.22_0.04_262)]",
  "bg-[linear-gradient(160deg,oklch(0.30_0.07_262),oklch(0.19_0.045_262)_70%)]",
  "text-[oklch(0.97_0.004_262)]",
].join(" ");

function Band({
  children,
  dark,
  eyebrow,
  name,
  titleId,
}: {
  children?: React.ReactNode;
  dark?: boolean;
  eyebrow: string;
  name: string;
  titleId?: string;
}) {
  return (
    <div
      className={`flex min-h-[78px] items-center gap-3 border-b px-5 py-[19px] ${
        dark ? "border-[rgba(255,255,255,0.12)]" : "border-[var(--line)]"
      }`}
    >
      <div className="min-w-0">
        <div className={`text-[14px] ${dark ? "text-[oklch(0.78_0.02_262)]" : "text-[var(--muted)]"}`}>
          {eyebrow}
        </div>
        <h2
          className="m-0 text-[17px] font-semibold tracking-[-0.01em]"
          id={titleId}
        >
          {name}
        </h2>
      </div>
      {children ? <div className="ml-auto flex items-center gap-3">{children}</div> : null}
    </div>
  );
}

/** The one sentence a coach panel is allowed. Absent readings say why instead. */
function Sentence({ children, dark }: { children: React.ReactNode; dark?: boolean }) {
  return (
    <p
      className={`m-0 mt-[10px] max-w-[34ch] text-[14px] ${
        dark ? "text-[oklch(0.78_0.02_262)]" : "text-[var(--muted)]"
      }`}
    >
      {children}
    </p>
  );
}

function HeroFigure({ reading, tone }: { reading: Reading; tone?: string }) {
  if (reading.kind === "value") {
    return (
      <Figure className={tone} size="hero">
        {reading.text}
      </Figure>
    );
  }
  return (
    <Figure className="text-[var(--faint)]" size="hero">
      <span aria-hidden="true">&mdash;</span>
      <span className="sr-only">{reading.note}</span>
    </Figure>
  );
}

/* --------------------------------------------------------------------------------------------
 * Status line
 * ------------------------------------------------------------------------------------------ */

function nameList(names: readonly string[]) {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The two-dot line under the greeting.
 *
 * The green half is drawn only from connection rows that say `live`, so a coach mid-onboarding is
 * never told their agent is answering. The amber half is a day count and never a percentage or a
 * predicted date, because A2P vetting is a wait on a third party who publishes no schedule.
 */
function StatusLine({ now, status }: { now?: Date; status: CoachChannelStatus | null | undefined }) {
  if (!status) return null;
  const liveNames = status.liveChannels.map((channel) => COACH_CHANNEL_NAMES[channel]);
  const carrier = status.carrier;
  const carrierDay = carrier.kind === "in-review" && carrier.submittedAt
    ? elapsedWorkspaceDays(carrier.submittedAt, now)
    : null;
  const carrierWaiting = carrier.kind === "in-review";
  if (liveNames.length === 0 && !carrierWaiting) return null;

  return (
    <p className="m-0 mt-[10px] flex flex-wrap items-center gap-5 text-[15px] text-[var(--muted)]">
      {liveNames.length > 0 ? (
        <span className="flex items-center gap-2">
          <StatusDot tone="good" />
          Your agent is live on {nameList(liveNames)}
        </span>
      ) : null}
      {carrierWaiting ? (
        <span className="flex items-center gap-2">
          <StatusDot tone="amber" />
          {carrierDay === null
            ? "Texting is with the carrier"
            : (
              <>
                Texting is with the carrier, day{" "}
                <span className="font-mono">{carrierDay}</span>
              </>
            )}
        </span>
      ) : null}
    </p>
  );
}

/* --------------------------------------------------------------------------------------------
 * Window pills
 * ------------------------------------------------------------------------------------------ */

/**
 * The window control, as links.
 *
 * The window is a server read: the URL is what the page renders from, so a control that changed
 * the view without changing the URL would leave a coach unable to reload or share what they are
 * looking at. Each pill is the current URL with `window` rewritten; the custom-range keys are
 * dropped, because a preset window is not a custom one and carrying `from`/`to` onto it would
 * hand the page a pair it refuses.
 */
function WindowPills({ window }: { window: CoachMeasurementWindow }) {
  return (
    <nav aria-label="Performance window" className="ml-auto flex gap-1.5">
      {WINDOW_PILLS.map((pill) => {
        const active = pill.value === window;
        return (
          <Link
            aria-current={active ? "page" : undefined}
            className={`flex h-11 min-w-14 items-center justify-center rounded-[10px] border px-3.5 font-mono text-[14px] no-underline hover:no-underline ${
              active
                ? "border-[var(--accent-edge)] bg-[var(--accent-wash)] text-[var(--accent-text)]"
                : "border-[var(--line)] bg-[var(--card)] text-[var(--muted)]"
            }`}
            href={`/coach/home?window=${pill.value}`}
            key={pill.value}
          >
            {pill.label}
          </Link>
        );
      })}
    </nav>
  );
}

/* --------------------------------------------------------------------------------------------
 * Six-month chart
 * ------------------------------------------------------------------------------------------ */

/**
 * The two-line chart, drawn from `read_coach_lead_composition_for_actor` through the kit's
 * `LineChart`, which owns the scale, the legend, the axis ends, the crosshair and the sr-only
 * table so this file owns none of them.
 *
 * The artboard's second series is booked calls. The composition rows carry `total`, `qualified`,
 * `disqualified` and `active` and no booked count at all, and a booked-per-month read does not
 * exist on this page, so the second line is Qualified. It comes from the same six rows as the
 * first, which is the property that matters: both lines are one query's answer about one cohort,
 * so the gap between them is a fact rather than two windows compared by eye.
 *
 * The legend carries each series' total, which is the artboard's "Leads · 214" wording, and the
 * partial-month flag is the one fact `LineChart`'s own table cannot know: a month still filling
 * reads low, and a chart that does not say which one invites the wrong conclusion.
 */
function LeadsTrend({ composition }: { composition: CoachLeadComposition }) {
  const months = composition.months;
  if (months.length < 2) {
    return (
      <p className="m-0 text-[14px] text-[var(--muted)]">
        Two months of history are needed before a trend can be drawn.
      </p>
    );
  }

  const totals = months.map((month) => month.total);
  const qualified = months.map((month) => month.qualified);
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
  const partial = months.filter((month) => month.partial).map((month) => month.label);

  return (
    <div className="flex flex-col gap-2">
      <LineChart
        className="w-full"
        height={220}
        label="Leads and qualified leads by month"
        labels={months.map((month) => month.label)}
        series={[
          { name: `Leads · ${workspaceCountFormat.format(sum(totals))}`, values: totals },
          { name: `Qualified · ${workspaceCountFormat.format(sum(qualified))}`, values: qualified },
        ]}
        width={440}
      />
      {partial.length > 0 ? (
        <p className="m-0 text-[12.5px] text-[var(--muted)]">
          {partial.join(" and ")} {partial.length === 1 ? "is" : "are"} still filling.
        </p>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------------------------------------
 * Keyword table
 * ------------------------------------------------------------------------------------------ */

type KeywordRow = CoachMeasurement["keywords"][number];

/**
 * The per-row line, which is a funnel and is labelled as one.
 *
 * The artboard draws a time sparkline beside each keyword. There is no per-keyword time series on
 * this page -- `read_coach_measurement_for_actor` returns one aggregate row per keyword over the
 * chosen window -- so a trend line here would be four made-up points. What the row does carry is
 * its own four stages, and those descend, which is the shape the artboard draws. The label says
 * "funnel", never "trend", so nothing claims a direction over time.
 */
function KeywordShape({ row }: { row: KeywordRow }) {
  return (
    <Sparkline
      height={24}
      label={`${row.keyword} funnel: ${row.conversations} opt-ins, ${row.respondedConversations} replied, ${row.qualifiedContacts} qualified, ${row.bookedContacts} booked`}
      points={[
        row.conversations,
        row.respondedConversations,
        row.qualifiedContacts,
        row.bookedContacts,
      ]}
      width={100}
    />
  );
}

function keywordCell(count: number, denominator: number, mode: "count" | "percent") {
  if (mode === "count") return workspaceCountFormat.format(count);
  if (denominator === 0) return "not yet";
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(
    (count * 100) / denominator,
  )}%`;
}

function KeywordPanel({
  customFrom,
  customTo,
  keywords,
  window,
}: {
  customFrom?: string | null;
  customTo?: string | null;
  keywords: CoachMeasurement["keywords"];
  window: CoachMeasurementWindow;
}) {
  const [mode, setMode] = useState<"count" | "percent">("count");
  // Opt-ins are a share of every keyword's opt-ins; the three stages after it are a share of the
  // row's own opt-ins. Same denominators the live surface uses, so the two cannot disagree.
  const optInDenominator = keywords.reduce((total, row) => total + row.conversations, 0);

  return (
    <section aria-labelledby="rehaul-keywords-heading" className={PANEL_CLASS}>
      <Band
        eyebrow="By keyword"
        name="Which keyword brings the best leads"
        titleId="rehaul-keywords-heading"
      >
        <SegmentedControl
          ariaLabel="Keyword figures"
          onValueChange={(value) => setMode(value as "count" | "percent")}
          scale="coach"
          segments={[{ key: "count", label: "Count" }, { key: "percent", label: "Percent" }]}
          value={mode}
        />
        <ExportMenu
          filename="setterfi-coach-measurement-keywords"
          mode="server"
          query={{
            window,
            ...(window === "custom" && customFrom && customTo
              ? { from: customFrom, to: customTo }
              : {}),
          }}
          resource="coach-measurement-keywords"
        />
      </Band>
      {keywords.length === 0 ? (
        <p className="m-0 px-[26px] py-6 text-[14px] text-[var(--muted)]">
          Keyword rows appear once a conversation is attributed to a keyword.
        </p>
      ) : (
        <table className="w-full border-collapse text-[16px]">
          <thead>
            <tr>
              <th className="border-b border-[var(--line)] px-[26px] py-3.5 text-left text-[14px] font-medium text-[var(--faint)]">
                Keyword
              </th>
              {["Opt-ins", "Replied", "Qualified", "Booked"].map((header) => (
                <th
                  className="border-b border-[var(--line)] px-[26px] py-3.5 text-right text-[14px] font-medium text-[var(--faint)]"
                  key={header}
                  scope="col"
                >
                  {header}
                </th>
              ))}
              <th className="w-[120px] border-b border-[var(--line)] px-[26px] py-3.5">
                <span className="sr-only">Funnel shape</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {keywords.map((row) => (
              <tr key={row.keyword}>
                <td className="border-b border-[var(--line-soft)] px-[26px] py-[19px] font-medium">
                  {row.keyword}
                </td>
                {[
                  keywordCell(row.conversations, optInDenominator, mode),
                  keywordCell(row.respondedConversations, row.conversations, mode),
                  keywordCell(row.qualifiedContacts, row.conversations, mode),
                  keywordCell(row.bookedContacts, row.conversations, mode),
                ].map((cell, index) => (
                  <td
                    className="border-b border-[var(--line-soft)] px-[26px] py-[19px] text-right font-mono tabular-nums"
                    // The four cells are positional stages of one row, so the index is the
                    // identity here rather than a stand-in for one.
                    key={["optins", "replied", "qualified", "booked"][index]}
                  >
                    {cell}
                  </td>
                ))}
                <td className="border-b border-[var(--line-soft)] px-[26px] py-[19px]">
                  <KeywordShape row={row} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/* --------------------------------------------------------------------------------------------
 * First run
 * ------------------------------------------------------------------------------------------ */

/**
 * Setup is unfinished when the connection read succeeded and found nothing live.
 *
 * `channelsChecked` is the load-bearing half. A failed connection read is not the same claim as
 * "no channel is live", and greeting a working coach with a setup checklist because a query timed
 * out is exactly the fake state this surface is not allowed to invent. A missing status is
 * likewise not evidence of anything, so it renders the figures.
 */
function setupIncomplete(status: CoachChannelStatus | null | undefined) {
  return Boolean(status && status.channelsChecked && status.liveChannels.length === 0);
}

function StepRow({
  action,
  children,
  eyebrow,
  name,
  status,
  tone,
}: {
  action?: React.ReactNode;
  children?: React.ReactNode;
  eyebrow: string;
  name: string;
  status: React.ReactNode;
  tone: "good" | "amber" | "wait" | "grey";
}) {
  return (
    <li className="flex list-none items-start gap-5">
      <span
        aria-hidden="true"
        className="mt-0 flex size-16 flex-[0_0_64px] items-center justify-center rounded-2xl border border-[var(--line)] bg-[var(--well)]"
      >
        <StatusDot tone={tone} />
      </span>
      <div className={`${PANEL_CLASS} flex-1`}>
        <Band eyebrow={eyebrow} name={name}>
          {status}
        </Band>
        {children || action ? (
          <div className="flex flex-wrap items-center gap-6 px-5 py-[18px]">
            {children}
            {action ? <div className="ml-auto">{action}</div> : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The setup journey, built only from state this page already reads.
 *
 * The artboard draws five steps with a state on each. This page loads two of them -- the channel
 * connections and the A2P registration -- and one count of blocked steps; the per-step states for
 * the calendar, the offer and the safe test live behind the Get started page's own reads, and
 * adding a query here is the one thing this screen may not do. So three rows carry a state
 * because a row was read for them, and the rest is one row that names no state and links to the
 * page that has them. A checklist that guessed at three step states would be worse than one that
 * is honest about only having two.
 */
function FirstRun({
  blockedSetupSteps,
  now,
  status,
}: {
  blockedSetupSteps: number;
  now?: Date;
  status: CoachChannelStatus;
}) {
  const carrier = status.carrier;
  const carrierDay = carrier.kind === "in-review" && carrier.submittedAt
    ? elapsedWorkspaceDays(carrier.submittedAt, now)
    : null;

  return (
    <ol className="m-0 flex list-none flex-col gap-4 p-0">
      <StepRow
        action={(
          <Link
            className="inline-flex h-11 items-center rounded-xl border border-transparent bg-[var(--accent-fill)] px-5 text-[16px] font-medium text-[var(--on-accent)] no-underline hover:no-underline"
            href="/coach/integrations"
          >
            Connect Instagram and Messenger
          </Link>
        )}
        eyebrow="Step 1"
        name="Instagram and Messenger"
        status={<Pill tone="neutral">Not connected</Pill>}
        tone="grey"
      />
      <StepRow
        eyebrow="Step 2 · with the carrier"
        name="Texting registration"
        status={
          carrier.kind === "in-review"
            ? (
              <Pill tone="amber">
                <StatusDot tone="amber" />
                {carrierDay === null ? "In review" : `Day ${carrierDay}`}
              </Pill>
            )
            : <Pill tone="neutral">Not filed</Pill>
        }
        tone={carrier.kind === "in-review" ? "amber" : "grey"}
      >
        {/* The day count says itself once in the band's pill and once, with the range it is
            measured against, in the counter. A third copy as a hero figure said nothing the
            counter does not already say in words. */}
        {carrier.kind === "in-review" && carrier.submittedAt ? (
          <DayCounter now={now} since={carrier.submittedAt} typicalDays={CARRIER_TYPICAL_DAYS} />
        ) : null}
      </StepRow>
      {blockedSetupSteps > 0 ? (
        <StepRow
          action={(
            <Link
              className="inline-flex h-11 items-center rounded-xl border border-[var(--line-input)] bg-[var(--card)] px-5 text-[16px] font-medium text-[var(--ink)] no-underline hover:no-underline"
              href="/coach/get-started"
            >
              See setup
            </Link>
          )}
          eyebrow="Waiting on you"
          name={`${workspaceCountFormat.format(blockedSetupSteps)} ${
            blockedSetupSteps === 1 ? "step is" : "steps are"
          } blocked`}
          status={<Pill tone="amber">Blocked</Pill>}
          tone="amber"
        />
      ) : null}
      <StepRow
        action={(
          <Link
            className="inline-flex h-11 items-center rounded-xl border border-[var(--line-input)] bg-[var(--card)] px-5 text-[16px] font-medium text-[var(--ink)] no-underline hover:no-underline"
            href="/coach/get-started"
          >
            See setup
          </Link>
        )}
        eyebrow="Calendar, offer, and the safe test"
        name="The rest of your setup"
        status={null}
        tone="grey"
      />
    </ol>
  );
}

/* --------------------------------------------------------------------------------------------
 * Eye
 * ------------------------------------------------------------------------------------------ */

/** TODO(rehaul): delete once `ContextEye` exists; see the note at the top of the file. */
function InlineEye({ copy }: { copy: string }) {
  return (
    <details className="mt-6 text-[14px] text-[var(--muted)]" data-slot="context-eye">
      <summary className="w-fit cursor-pointer font-medium">What these mean</summary>
      <p className="m-0 mt-2 max-w-[70ch]">{copy}</p>
    </details>
  );
}

/* --------------------------------------------------------------------------------------------
 * The screen
 * ------------------------------------------------------------------------------------------ */

export function CoachDashboard({
  attention,
  channelStatus,
  composition,
  customFrom,
  customTo,
  greeting,
  measurement,
  now,
  window,
}: CoachDashboardProps) {
  const firstRun = setupIncomplete(channelStatus);
  const when = WINDOW_PHRASE[measurement.window];
  const leads = readMetric(measurement, "coach.new_leads");
  const booked = readMetric(measurement, "coach.booked_contacts");
  const timeToBook = readMetric(measurement, "coach.average_time_to_book");
  const { allowance } = measurement;
  const remaining = allowance.state === "available"
    ? Math.max(0, allowance.limit - allowance.used)
    : null;
  const monthTotals = composition.months.map((month) => month.total);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-end gap-6">
        <div className="min-w-0">
          <h1 className="m-0 text-[46px] leading-[1.05] font-semibold tracking-[-0.025em]">
            {greeting
              ? `${firstRun ? "Welcome" : "Welcome back"}, ${greeting}`
              : "Dashboard"}
          </h1>
          <StatusLine now={now} status={channelStatus} />
        </div>
        {firstRun ? null : <WindowPills window={window} />}
      </div>

      {firstRun && channelStatus ? (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start">
          <div className="flex min-w-0 flex-col gap-4">
            <div className="flex items-baseline gap-3">
              <h2 className="m-0 text-[17px] font-semibold tracking-[-0.01em]">Your setup</h2>
            </div>
            <FirstRun
              blockedSetupSteps={attention.blockedSetupSteps}
              now={now}
              status={channelStatus}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-5">
            <h2 className="m-0 text-[17px] font-semibold tracking-[-0.01em]">Your numbers</h2>
            {([
              { name: "Leads", reading: leads },
              { name: "Booked calls", reading: booked },
              { name: "Time to book", reading: timeToBook },
            ] as const).map((panel) => (
              <section className={PANEL_CLASS} key={panel.name}>
                <Band eyebrow={when} name={panel.name} />
                <div className="flex flex-1 flex-col p-5">
                  <HeroFigure reading={panel.reading} />
                </div>
              </section>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-3">
            <section aria-labelledby="rehaul-leads-heading" className={PANEL_CLASS}>
              <Band eyebrow={when} name="Leads" titleId="rehaul-leads-heading" />
              <div className="flex flex-1 flex-col p-5">
                <HeroFigure reading={leads} />
                <Sentence>Everyone your agent reached {when}.</Sentence>
                {monthTotals.length >= 2 ? (
                  <Sparkline
                    className="mt-auto w-full pt-4"
                    height={44}
                    label="Leads by month, last six months"
                    points={monthTotals}
                    width={300}
                  />
                ) : null}
              </div>
            </section>

            <section aria-labelledby="rehaul-booked-heading" className={PANEL_DARK_CLASS}>
              <Band dark eyebrow={when} name="Booked" titleId="rehaul-booked-heading" />
              <div className="flex flex-1 flex-col p-5">
                <HeroFigure reading={booked} tone="text-[oklch(0.82_0.13_164)]" />
                <Sentence dark>
                  {allowance.state === "available" && remaining !== null
                    ? `${workspaceCountFormat.format(remaining)} to go on your ${
                      workspaceCountFormat.format(allowance.limit)
                    }-call plan.`
                    : "No plan allowance is recorded to count these against."}
                </Sentence>
                {allowance.state === "available" && allowance.limit > 0 ? (
                  <div className="mt-auto pt-4">
                    <div className="flex justify-between text-[14px] text-[oklch(0.78_0.02_262)]">
                      <span className="font-mono">
                        {workspaceCountFormat.format(allowance.used)} /{" "}
                        {workspaceCountFormat.format(allowance.limit)}
                      </span>
                      <span>Monthly plan</span>
                    </div>
                    <div className="mt-2 h-1.5 rounded-full bg-[rgba(255,255,255,0.14)]">
                      <div
                        className="h-full rounded-full bg-[oklch(0.82_0.13_164)]"
                        style={{
                          width: `${Math.min(100, (allowance.used / allowance.limit) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                ) : null}
              </div>
            </section>

            <section aria-labelledby="rehaul-ttb-heading" className={PANEL_CLASS}>
              <Band eyebrow={when} name="Time to book" titleId="rehaul-ttb-heading" />
              <div className="flex flex-1 flex-col p-5">
                <HeroFigure reading={timeToBook} />
                <Sentence>From first message to a call on the calendar.</Sentence>
              </div>
            </section>
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <KeywordPanel
              customFrom={customFrom}
              customTo={customTo}
              keywords={measurement.keywords}
              window={window}
            />
            <section aria-labelledby="rehaul-trend-heading" className={PANEL_CLASS}>
              <Band
                eyebrow="Six months"
                name="Leads and qualified leads"
                titleId="rehaul-trend-heading"
              />
              <div className="flex flex-1 flex-col p-5">
                <LeadsTrend composition={composition} />
              </div>
            </section>
          </div>
        </>
      )}

      <InlineEye copy={EYE_COPY} />
    </div>
  );
}
