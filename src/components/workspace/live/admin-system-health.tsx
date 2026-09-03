"use client";

import type { ColumnDef } from "@tanstack/react-table";

import {
  FigureStrip,
  MonoMeta,
  Prose,
  STATE_TONE_TO_TONE,
  Status,
  Surface,
  SurfaceHeader,
  type Tone,
} from "@/components/kit/atomics";
import { AppShell } from "@/components/kit/app-shell";
import { Callout, type CalloutTone } from "@/components/kit/callout";
import { CellQuiet } from "@/components/kit/cell-quiet";
import { DataState } from "@/components/kit/data-state";
import { DataTable } from "@/components/kit/data-table";
import { ExportMenu } from "@/components/kit/export-menu";
import type { MetricAvailability } from "@/components/kit/headline-stat";
import type { StateTone } from "@/components/kit/state-badge";
import { TechnicalDetail } from "@/components/kit/technical-detail";
import { DetailPage, type DetailTab } from "@/components/kit/templates/detail-page";
import { workspaceCountFormat, workspaceDateTimeFormat } from "@/lib/format/datetime";
import type {
  DeliveryQueueRow,
  SystemHealth,
  SystemHealthState,
} from "@/lib/operations/system-health";
import { withWorkspaceNavCounts, workspaceNavigationFor } from "@/lib/workspace-navigation";

const CRUMBS = [
  { label: "Run" },
  { label: "System" },
] as const;

/**
 * Each label names the specific thing that is wrong, because "Reporting interrupted" covered a
 * failing job, a stale report and a job that had never run at all: three states an operator has to
 * act on differently. Only a page whose queue reads and whose every scheduled job reported a fresh
 * success is allowed to say it is live.
 */
const SYSTEM_REPORTING_BADGE = {
  healthy: { label: "Reporting live", tone: "good" },
  failed: { label: "Scheduled job failing", tone: "critical" },
  stale: { label: "Job reports stale", tone: "warning" },
  "never-ran": { label: "Scheduled job has never run", tone: "warning" },
  "in-progress": { label: "Job run unfinished", tone: "info" },
  unavailable: { label: "Reporting interrupted", tone: "warning" },
} as const satisfies Record<SystemHealthState, { label: string; tone: StateTone }>;

function formatDateTime(value: string | null, emptyLabel: string) {
  if (!value) return emptyLabel;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Time not recorded"
    : workspaceDateTimeFormat.format(date);
}

function humanizeMachineValue(value: string) {
  const words = value.trim().replace(/[_-]+/g, " ").toLowerCase();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : "Not recorded";
}

function displayDestination(value: string) {
  const destinationLabels: Record<string, string> = {
    bell: "In-app notification",
    email: "Email",
  };
  return destinationLabels[value] ?? (/^[a-z0-9_-]+$/i.test(value)
    ? humanizeMachineValue(value)
    : value);
}

/**
 * What a failed receipt recorded, in the register the row is written in.
 *
 * Most details are the thrown code -- `PROVISIONING_TENANT_READ_FAILED` -- and a screaming
 * constant in a sentence-case row is a machine name on an operator screen, which the page rule
 * forbids. Anything that is not a bare code (a provider's message, a network error) is kept
 * verbatim, because lower-casing "ENOTFOUND db.example" would change what it says. The raw
 * string is still on the page, under Technical detail, for a log search.
 */
function displayErrorDetail(value: string) {
  const trimmed = value.trim().replace(/\.$/u, "");
  return /^[A-Z0-9_]+$/u.test(trimmed) ? humanizeMachineValue(trimmed) : trimmed;
}

function deliveryState(state: string): { label: string; tone: StateTone } {
  if (["delivered", "sent", "succeeded"].includes(state)) {
    return { label: "Delivered", tone: "good" };
  }
  if (["failed", "unavailable"].includes(state)) {
    return { label: "Failed", tone: "critical" };
  }
  if (["accepted", "pending", "retryable", "sending"].includes(state)) {
    return { label: humanizeMachineValue(state), tone: "warning" };
  }
  return { label: humanizeMachineValue(state), tone: "neutral" };
}

// Four default columns; attempt counts and the delivered stamp stay declared behind Display.
const DELIVERY_COLUMNS: ColumnDef<DeliveryQueueRow>[] = [
  {
    id: "event",
    accessorFn: (row) => humanizeMachineValue(row.event),
    header: "Event",
    meta: { cellKind: "identity", label: "Event" },
  },
  {
    id: "destination",
    accessorFn: (row) => displayDestination(row.destination),
    header: "Destination",
    meta: { cellKind: "secondary", label: "Destination" },
  },
  {
    // No State column: the rows are banded by delivery state, and a pill repeating the band
    // heading on every row is the same word twice across one line.
    id: "lastAttempt",
    accessorFn: (row) => formatDateTime(row.lastAttemptAt, "No attempt yet"),
    cell: ({ row }) => (row.original.lastAttemptAt
      ? formatDateTime(row.original.lastAttemptAt, "No attempt yet")
      : <CellQuiet>never attempted</CellQuiet>),
    header: "Last attempt",
    meta: { cellKind: "secondary", label: "Last attempt" },
  },
  {
    accessorKey: "attempts",
    header: "Attempts",
    meta: { cellKind: "secondary", defaultHidden: true, label: "Attempts" },
  },
  {
    id: "delivered",
    accessorFn: (row) => formatDateTime(row.deliveredAt, "Not delivered"),
    cell: ({ row }) => (row.original.deliveredAt
      ? formatDateTime(row.original.deliveredAt, "Not delivered")
      : <CellQuiet>not delivered</CellQuiet>),
    header: "Delivered",
    meta: { cellKind: "secondary", defaultHidden: true, label: "Delivered" },
  },
];

/**
 * The three states an operator reads the queue for, in the order they matter: what failed and is
 * not coming back, what is still trying, and what is done. Banding by this is what lets the table
 * drop its own State column.
 */
const DELIVERY_GROUPS = [
  {
    annotation: "no further attempt is scheduled for these",
    id: "failed",
    label: "Failed",
    tone: "failure",
  },
  {
    annotation: "the queue is still working these, so there is nothing to do yet",
    id: "in-flight",
    label: "Still trying",
    tone: "waiting",
  },
  {
    annotation: "the destination accepted the attempt",
    id: "delivered",
    label: "Delivered",
    tone: "good",
  },
] as const satisfies readonly { annotation: string; id: string; label: string; tone: Tone }[];

/**
 * What the queue records and what it does not. A delivered attempt is one a destination accepted;
 * whether a person read the notification is not something any of these rows can answer, and a
 * reader scanning a column of "Delivered" would otherwise take it for one that says they did.
 */
const DELIVERY_FOOTER_NOTE =
  "Delivered means the destination accepted the attempt. Nothing here records whether anyone read it.";

function deliveryGroup(row: DeliveryQueueRow): (typeof DELIVERY_GROUPS)[number]["id"] {
  const tone = deliveryState(row.state).tone;
  if (tone === "critical") return "failed";
  if (tone === "good") return "delivered";
  return "in-flight";
}

function queueMetric(value: number | null): MetricAvailability {
  return value === null
    ? { kind: "read-failed", retry: () => window.location.reload() }
    : { kind: "value", value, format: "count" };
}

function jobState(state: SystemHealthState): { label: string; tone: StateTone } {
  if (state === "healthy") return { label: "Healthy", tone: "good" };
  if (state === "failed") return { label: "Failed", tone: "critical" };
  return { label: "No recent report", tone: "warning" };
}

function providerState(
  state: SystemHealth["providers"][number]["state"],
): { label: string; tone: StateTone } {
  if (state === "real") return { label: "Real", tone: "good" };
  if (state === "mock") return { label: "Mock", tone: "neutral" };
  return { label: "Needs setup", tone: "warning" };
}

/**
 * Scheduled jobs carrying a stored run receipt, counted from the rows the Jobs tab lists.
 *
 * The canvas draws this as "Runs that produced a receipt" beside "Scheduled runs fired in the
 * last 24 hours", and only this half is readable: `health.jobs` records each job's latest run and
 * its receipt id, so how many have one is a count. How many times a schedule *fired* is not on
 * this read at all -- a refused invocation never reaches a handler that could record it, which is
 * exactly why a deployment with no key looks quiet. The canvas's "655 hits in 24 hours" comes
 * from the platform's own request log, which this page does not read.
 *
 * The other two figures the canvas puts on this strip stay off for the same reason. **Model spend
 * today** lives in the billing cost rollup, not in system health, and is already a real figure on
 * the Money screens where cost belongs. **Deepest queue, one tenant** needs a per-tenant
 * breakdown of the delivery queue; this read carries one total depth, and presenting that total
 * under a per-tenant label would be a different number wearing the drawn one's name.
 */
function jobsWithReceipts(health: SystemHealth) {
  return health.jobs.filter((job) => job.receiptId !== null).length;
}

function jobRollup(health: SystemHealth) {
  const missing = health.jobs.filter((job) => !job.reportedSinceYesterday).length;
  if (missing === 0) return `All ${health.jobs.length} jobs have reported since yesterday`;
  return `${missing} of ${health.jobs.length} jobs ${missing === 1 ? "has" : "have"} not reported since yesterday`;
}

/**
 * The tones on which a job-reporting state is the loudest thing on the page rather than a badge.
 *
 * `never-ran` and `failed` are both "the schedules are firing and nothing is coming back", which
 * is the single most misreadable state this product has: every table on the page renders
 * correctly, every count is a truthful zero, and the screen looks like a quiet platform. `stale`
 * is the same claim one degree weaker -- something reported once and has not since.
 *
 * `in-progress` and `unavailable` deliberately do not qualify. A run that has not finished yet is
 * not a fault, and a read that failed is already reported by the badge and by the queue's own
 * reason line; promoting either to a full-width callout would spend the alarm on a state nobody
 * needs to act on, and an alarm that fires on healthy days stops being read.
 */
const REPORTING_ALARM = {
  failed: "critical",
  "never-ran": "critical",
  stale: "warning",
} as const satisfies Partial<Record<SystemHealthState, CalloutTone>>;

type ReportingAlarmState = keyof typeof REPORTING_ALARM;

/**
 * What the alarm says, counted off the jobs rather than named after the state.
 *
 * The badge label and `health.reporting.reason` are both the symptom said twice -- "Scheduled job
 * has never run" over "At least one scheduled job has no recorded run" tells an operator the thing
 * they can already see and nothing they can act on. `AdminSystem.dc.html` heads this callout with
 * "No scheduled job has ever completed in production", which is the same evidence stated as a
 * finding: how much of the platform is affected, and therefore whether this is one broken cron or
 * the whole schedule not landing.
 *
 * `affected` and `total` come from `health.jobs`, the same array the Jobs tab renders, so the
 * headline cannot disagree with the table an operator opens next to check it.
 */
function alarmHeadline(state: ReportingAlarmState, affected: number, total: number) {
  const all = total > 0 && affected === total;
  if (state === "never-ran") {
    return all
      ? "No scheduled job has ever recorded a completed run"
      : `${affected} of ${total} scheduled jobs have never recorded a completed run`;
  }
  if (state === "failed") {
    return all
      ? "Every scheduled job's most recent run failed"
      : `${affected} of ${total} scheduled jobs failed their most recent run`;
  }
  return all
    ? "No scheduled job has reported inside its expected window"
    : `${affected} of ${total} scheduled job reports are outside their expected window`;
}

/**
 * What each state means for the zeroes underneath, and what happens next.
 *
 * **Deliberately no cause.** The artboard's body names one -- the handlers returning 401 because
 * the deployment holds no `CRON_SECRET` -- and that is a cause this read cannot know: the health
 * source reads job receipts, queue depth and attempt counts, and a run that never happened leaves
 * no row saying why. Printing the drawn sentence would be asserting a specific misconfiguration on
 * evidence that is only ever an absence, which is the one thing an alarm must never do; an operator
 * who chased a `CRON_SECRET` that was set correctly would stop trusting this card. So the body says
 * what IS known -- the reach of the failure, why the figures below are zero, and where the per-job
 * detail is -- and leaves the diagnosis to the Jobs tab, which carries each job's own reason line.
 */
const REPORTING_ALARM_CONSEQUENCE = {
  failed: "A run that fails writes no receipt, so the delivery figures below are zero because the "
    + "work did not finish rather than because the platform is quiet.",
  "never-ran": "Nothing has ever written a receipt, so the delivery figures below are zero because "
    + "the work did not run rather than because the platform is quiet.",
  stale: "The last receipt is older than its window, so the delivery figures below describe a "
    + "platform that stopped reporting rather than one with nothing to report.",
} as const satisfies Record<ReportingAlarmState, string>;

const REPORTING_ALARM_NEXT = "Nothing on this page retries a schedule. The Jobs tab beside this one "
  + "lists every job, its cron expression, when it last reported, and what that report said.";

/**
 * The one cause this read CAN know: what a failed run wrote into its own receipt.
 *
 * The comment above rules out naming a cause for a run that never happened. A run that failed
 * is the opposite case -- the runner caught the error and recorded its message -- so printing it
 * here is reporting evidence rather than asserting a diagnosis. A failed job whose receipt holds
 * no detail says so in those words; leaving it blank would read as though the field had not
 * been looked at.
 */
function failedJobsSentence(health: SystemHealth) {
  const failed = health.jobs.filter((job) => job.state === "failed");
  if (failed.length === 0) return null;
  return failed.map((job) => (job.errorDetail
    ? `${job.label}. Last error: ${displayErrorDetail(job.errorDetail)}.`
    : `${job.label}. No error detail was recorded.`)).join(" ");
}

function reportingAlarm(health: SystemHealth) {
  const state = health.reporting?.state;
  if (!state || !(state in REPORTING_ALARM)) return null;
  const alarmState = state as ReportingAlarmState;
  const affected = health.jobs.filter((job) => job.state === alarmState).length;
  return {
    tone: REPORTING_ALARM[alarmState],
    /*
      A count of zero means the rollup and the job rows disagree -- the rollup is derived from the
      same array, so it should not happen, and if it ever does the honest thing is to state the
      rollup's own verdict rather than print "0 of 5 jobs", which reads as a fixed platform on a
      card that is firing precisely because it is not.
    */
    title: affected === 0
      ? SYSTEM_REPORTING_BADGE[alarmState].label
      : alarmHeadline(alarmState, affected, health.jobs.length),
    body: [
      REPORTING_ALARM_CONSEQUENCE[alarmState],
      alarmState === "failed" ? failedJobsSentence(health) : null,
      REPORTING_ALARM_NEXT,
    ].filter(Boolean).join(" "),
  };
}

/** Tab one: the queue is the thing an operator opens this page to decide about. */
function StatusTab({ health }: { health: SystemHealth }) {
  const alarm = reportingAlarm(health);

  return (
    <div className="flex min-h-0 min-w-0 flex-col gap-[var(--s-4)]">
      {/*
        Above the figures, not beside them, and this is the whole point of the console redesign on
        this screen. A platform where no scheduled job has ever completed draws an empty delivery
        table, a zero queue depth and zero failed attempts -- three correct readings that together
        read as calm. The page header's state badge said so in eleven characters at the top right
        of the screen, which is not where anyone was looking. This card is the sentence that has
        to be read before the zeroes underneath it mean anything.
      */}
      {alarm ? (
        <Callout
          body={alarm.body}
          className="max-w-[var(--measure-wide)]"
          title={alarm.title}
          tone={alarm.tone}
        />
      ) : null}

      {/*
        Three figures SetterFi reports about its own queue, so they take the managed strip rather
        than three tiles: an operator reads them as one line about the queue, and a tile each would
        make three cards that share an interior -- the failure `docs/DESIGN.md` names. Failed and
        terminal carry a tone because a non-zero one is the reason to be on this page; the depth
        never does, because healthy traffic on its way out is not news.
      */}
      {/*
        A fourth figure, and it is the one the canvas leads this page with: how many scheduled
        jobs have a stored run receipt. It is counted off `health.jobs` rather than read from a
        counter, so it cannot disagree with the Jobs tab beside it.

        It earns the space because it is the only figure on the strip that goes wrong when the
        platform is doing nothing. Queue depth, failed attempts and terminal attempts are all
        truthfully zero on a deployment whose crons have never run, and three zeroes read as calm;
        "0 jobs have a run receipt" reads as broken, which is what it is.

        It carries no tone, and that is a constraint rather than an oversight: `FigureStrip`
        forces a zero to neutral, because for every other figure it draws a zero is good news or
        no news. This figure is the inverse -- zero is the whole alarm -- so the component cannot
        express it, and widening the component would put an "a zero may be bad" branch into an
        atomic the coach surfaces read too. The alarm therefore stays where it already is: the
        callout above, which fires on the same evidence and says it in a sentence. Spending it
        twice would not make it louder.
      */}
      <FigureStrip
        items={[
          { label: "Jobs with a run receipt", value: jobsWithReceipts(health) },
          { label: "Active queue", value: health.queue.depth ?? null },
          { label: "Failed attempts", tone: "failure", value: health.queue.failedAttempts ?? null },
          { label: "Terminal attempts", tone: "warning", value: health.queue.terminalAttempts ?? null },
        ]}
        label="Delivery summary"
      />

      {health.queue.reason ? (
        <Callout
          body={health.queue.reason}
          className="max-w-[var(--measure-wide)]"
          title="Queue needs attention"
          tone="warning"
        />
      ) : null}

      {/*
        With no rows there is nothing to search, page, or export, so the table is not rendered at
        all: an enabled toolbar over an empty table offered controls that could not do anything,
        and the footer printed "0 deliveries, showing 0 to 0" underneath an empty state that had
        already said there was nothing.
      */}
      {health.queue.rows.length === 0 ? (
        <DataState
          body={health.queue.state === "unavailable"
            ? "Delivery activity could not be read."
            : "New attempts appear here after the first real notification is queued."}
          kind={health.queue.state === "unavailable" ? "unavailable" : "empty"}
          title={health.queue.state === "unavailable"
            ? "Delivery activity unavailable"
            : "No recent delivery activity"}
        />
      ) : (
      <DataTable
        ariaLabel="Delivery queue"
        columns={DELIVERY_COLUMNS}
        data={health.queue.rows}
        // Unreachable while the branch above owns the zero-row case; the prop is required.
        emptyState={(
          <DataState
            body="New attempts appear here after the first real notification is queued."
            kind="empty"
            title="No recent delivery activity"
          />
        )}
        exportResource={{
          filename: "setterfi-notification-deliveries",
          mode: "server",
          query: {
            columns: ["event", "destination", "state", "attempts", "lastAttemptAt", "deliveredAt", "testData"],
            order: "created_desc",
            reason: "System delivery queue review",
          },
          resource: "notification-deliveries",
        }}
        footerNote={DELIVERY_FOOTER_NOTE}
        getRowId={(row) => row.id}
        groupBy={deliveryGroup}
        groups={DELIVERY_GROUPS}
        ordering="banded by delivery state, failures first"
        rowLabel={{ singular: "delivery", plural: "deliveries" }}
        search={{ placeholder: "Search deliveries" }}
        variant="ledger"
      />
      )}
    </div>
  );
}

/*
 * The Jobs tab is a table that wears a list's markup, so CLAUDE.md's export rule binds here.
 *
 * Every row carries the same five fields in the same order -- name, cron expression, last report,
 * state, and the receipt id behind it -- and an operator reads them down the column rather than
 * one row at a time, which is what makes it a table rather than a set of status cards. The `<ul>`
 * is a rendering choice (a `<dl>` broke the mono alignment; a `DataTable` would put a search box
 * and a column menu over eight rows derived from `vercel.json`), not a statement that the rows are
 * heterogeneous. So the export exists and the markup stays.
 *
 * `mode: "local"`, because the rows are already in the browser and there is no jobs resource on
 * `/api/exports/[resource]` to fetch them from. That is not a shortfall: the jobs list is derived
 * from the deployed cron topology joined to stored receipts at render time, so the rows on screen
 * are the rows, and a server round-trip could only reproduce them. Same shape the compliance,
 * channel-health and platform-inbox exports use.
 *
 * The row keeps `reportedSinceYesterday` even though the panel spends it on the rollup sentence
 * instead of a per-row badge: it is the field the header's "n of m have not reported" claim is
 * counted from, and an exported file that cannot be reconciled against the sentence above the
 * table it came from is worse than no file.
 */
function jobExportRows(health: SystemHealth) {
  return health.jobs.map((job) => ({
    job: job.label,
    schedule: job.schedule,
    state: jobState(job.state).label,
    lastRunAt: job.lastRunAt ?? "",
    reportedSinceYesterday: job.reportedSinceYesterday,
    receiptId: job.receiptId ?? "",
    reason: job.reason ?? "",
    lastError: job.errorDetail ?? "",
  }));
}

function JobsTab({ health }: { health: SystemHealth }) {
  const jobTechnicalDetail = health.jobs.flatMap((job) => [
    ...(job.receiptId ? [{ label: `${job.label} receipt`, value: job.receiptId }] : []),
    // Verbatim, because this is the string to paste into a log search; the row above reads it.
    ...(job.errorDetail ? [{ label: `${job.label} last error`, value: job.errorDetail }] : []),
  ]);

  return (
    <Surface aria-labelledby="jobs-title" className="min-w-0" variant="panel">
      {/*
        The tally that used to sit here as an info pill is the tab's own count now. A count is not
        a state, and a neutral pill beside the real ones read as though it were.
      */}
      <SurfaceHeader
        overline="Run"
        subtitle={jobRollup(health)}
        title={<span id="jobs-title">Scheduled jobs</span>}
        trailing={(
          <ExportMenu
            filename="setterfi-scheduled-jobs"
            mode="local"
            rows={jobExportRows(health)}
          />
        )}
      />
      <ul className="m-0 list-none p-0">
        {health.jobs.map((job, index) => {
          const state = jobState(job.state);
          return (
            <li
              className="border-b border-[var(--line-soft)] px-[var(--s-4)] py-[var(--s-3)] last:border-b-0"
              key={job.id}
            >
              <article
                className="@container flex min-w-0 flex-col gap-[var(--s-2)] @min-[520px]:flex-row @min-[520px]:items-start @min-[520px]:justify-between @min-[520px]:gap-[var(--s-3)]"
                data-testid="system-job-row"
              >
                <div className="min-w-0">
                  <div className="text-[length:var(--t-row)] font-[var(--t-row-w)] text-[color:var(--ink)]">
                    {job.label}
                  </div>
                  {/*
                    Schedule and last run are the two facts that decide whether a silent job is
                    fine, so they are mono on one line rather than a definition list: a reader is
                    comparing them down the column, and a wrapped <dl> broke that alignment.
                  */}
                  <div className="mt-[var(--s-1)] flex flex-wrap items-baseline gap-x-[var(--s-3)] gap-y-[2px]">
                    <MonoMeta>{job.schedule}</MonoMeta>
                    <MonoMeta tone={job.lastRunAt ? "neutral" : "warning"}>
                      {formatDateTime(job.lastRunAt, "no report yet")}
                    </MonoMeta>
                  </div>
                  {job.reason ? (
                    <Prose className="mt-[var(--s-2)] text-[12.5px] leading-[1.5] text-[color:var(--muted)]">
                      {job.reason}
                    </Prose>
                  ) : null}
                  {/*
                    The reason line says the run failed; this says why, from the receipt the run
                    wrote. Only a failed row has one, so the label appears exactly where there is
                    something to act on, and the row stays on the muted ink -- the state beside
                    it is already the only colour this row spends.
                  */}
                  {job.errorDetail ? (
                    <Prose className="mt-[var(--s-1)] text-[12.5px] leading-[1.5] text-[color:var(--muted)]">
                      <span className="font-medium text-[color:var(--ink)]">Last error</span>
                      {" "}
                      <span>{displayErrorDetail(job.errorDetail)}</span>
                    </Prose>
                  ) : null}
                </div>
                {/*
                  One treatment for the column. A list of pills reads as a column of lozenges, so
                  the state is the bare dot plus its words, which is what the roster and the client
                  book already do.
                */}
                <Status
                  className="shrink-0"
                  label={state.label}
                  tone={STATE_TONE_TO_TONE[state.tone]}
                  treatment="bare"
                />
              </article>
            </li>
          );
        })}
      </ul>
      <TechnicalDetail className="border-t border-[var(--line)] px-[var(--s-4)] py-[var(--s-3)]" items={jobTechnicalDetail} />
    </Surface>
  );
}

function IntegrationsTab({ health }: { health: SystemHealth }) {
  return (
    <Surface aria-labelledby="integrations-title" className="min-w-0" variant="panel">
      <SurfaceHeader
        overline="Run"
        subtitle="Integration mode and setup state, without deployment configuration names."
        title={<span id="integrations-title">Integrations</span>}
      />
      <ul className="m-0 list-none p-0">
        {health.providers.map((provider) => {
          const state = providerState(provider.state);
          return (
            <li
              className="@container flex min-w-0 flex-col gap-[var(--s-2)] border-b border-[var(--line-soft)] px-[var(--s-4)] py-[var(--s-3)] last:border-b-0 @min-[520px]:flex-row @min-[520px]:items-start @min-[520px]:justify-between @min-[520px]:gap-[var(--s-3)]"
              key={provider.id}
            >
              <div className="min-w-0">
                <div className="text-[length:var(--t-row)] font-[var(--t-row-w)] text-[color:var(--ink)]">
                  {provider.label}
                </div>
                {/*
                  A provider running on a mock is not a fault, but it is not production either, so
                  the reason line stays on every row that has one rather than only the bad ones --
                  the same "explanation on every row" rule SettingRow enforces structurally.
                */}
                {provider.reason ? (
                  <Prose className="mt-[var(--s-1)] text-[12.5px] leading-[1.5] text-[color:var(--muted)]">
                    {provider.reason}
                  </Prose>
                ) : null}
              </div>
              <Status
                className="shrink-0"
                label={state.label}
                tone={STATE_TONE_TO_TONE[state.tone]}
                treatment="bare"
              />
            </li>
          );
        })}
      </ul>
    </Surface>
  );
}

export function AdminSystemHealth({
  enabled = true,
  health,
}: {
  enabled?: boolean;
  health?: SystemHealth;
}) {
  /*
   * Counts sit in the tab strip's own faint mono slot, and each one is omitted rather than zeroed:
   * an empty queue says so in the tab body, where a grey 0 in the strip reads as a counter that
   * broke. A failed read leaves the count off entirely rather than reporting the rows it managed
   * to fetch as though they were the whole story.
   */
  const tabs: DetailTab[] = health ? [
    {
      id: "status",
      label: "Status",
      count: health.queue.rows.length || undefined,
      content: <StatusTab health={health} />,
    },
    {
      id: "jobs",
      label: "Jobs",
      count: health.jobs.length || undefined,
      content: <JobsTab health={health} />,
    },
    {
      id: "integrations",
      label: "Integrations",
      count: health.providers.length || undefined,
      content: <IntegrationsTab health={health} />,
    },
  ] : [];

  return (
    <AppShell
      activePath="/admin/system"
      crumbs={CRUMBS}
      /*
       * The rail counts what an operator would come here to chase -- attempts that failed -- not
       * the queue depth, most of which is healthy traffic on its way out. A failed read counts
       * nothing rather than guessing at zero.
       */
      nav={withWorkspaceNavCounts(workspaceNavigationFor("admin"), {
        "/admin/system": health?.queue.failedAttempts ?? 0,
      })}
      role="admin"
    >
      {enabled && health ? (
        <DetailPage
          state={{
            kind: "lifecycle",
            // "Reporting" alone named no alternative, so it read as a category rather than as a
            // state. Both halves now say what is and is not happening.
            //
            // The badge reads every owned signal, not just the queue. Reading the queue
            // successfully says nothing about whether the thirteen scheduled jobs ran, so deriving
            // "live" from the queue alone let the page claim health while every cron was silent.
            ...SYSTEM_REPORTING_BADGE[health.reporting?.state ?? (health.queue.state === "available" ? "healthy" : "unavailable")],
          }}
          subtitle="The jobs, the queues, and the integration modes: whether the platform is actually doing anything. Demo and test traffic is excluded."
          tabs={tabs}
          title="System"
        />
      ) : (
        <DetailPage
          subtitle="Queue activity, scheduled jobs, and integration state."
          tabs={[{
            id: "status",
            label: "Status",
            content: (
              <DataState
                body="System health reads are not enabled in this environment."
                kind="unavailable"
                title="System health is not enabled"
              />
            ),
          }]}
          title="System"
        />
      )}
    </AppShell>
  );
}
