"use client";

/**
 * The owner System screen, rehaul face.
 *
 * The headline is the state rather than the noun: a page titled "System" says nothing, and the
 * one fact an operator opens this screen for is whether the platform is reporting. So the h1 is
 * the reporting state itself, with the dot beside it, and the tabs underneath carry the detail.
 *
 * This file adds no read of its own. Every row comes out of `loadSystemHealth()` exactly as the
 * live surface receives it. What the artboard asks for that the platform cannot say:
 *
 * - **The seven-day delivery line.** `SystemHealth` carries queue totals and the hundred most
 *   recent delivery rows, not a per-day count. Bucketing a capped sample into seven days would
 *   draw a curve that flattens out precisely when volume is high, so the figures the health read
 *   does own take that space instead.
 * - **"2 registrations with carriers" and a day counter per waiting client.** No per-client
 *   texting-registration state reaches this read at all, so neither the amber headline pill nor
 *   the `DayCounter` rows have anything to count. The carrier-vetting probe still appears in
 *   Services as the job it is.
 * - **The window control** selects the span the Incidents rail covers. It does not re-scope the
 *   figures, which are the platform totals this read returns, and saying otherwise on a control
 *   that cannot reach the query would be a filter that quietly does nothing.
 */

import { usePathname, useSearchParams } from "next/navigation";
import { useMemo } from "react";

import { FigureStrip } from "@/components/kit/atomics";
import { ExportMenu } from "@/components/kit/export-menu";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import {
  Pill,
  RehaulTabs,
  Seg,
  StatusDot,
  type PillTone,
  type StatusTone,
} from "@/components/workspace/rehaul/_primitives";
import { workspaceDateTimeFormat } from "@/lib/format/datetime";
import type {
  DeliveryQueueRow,
  SystemHealth,
  SystemHealthState,
} from "@/lib/operations/system-health";
import { cn } from "@/lib/utils";

export type OwnerSystemProps = {
  health: SystemHealth;
  /**
   * One instant, sampled once on the server and threaded into the window arithmetic. Reading the
   * wall clock at render makes the rail disagree with the page it sits on, because the two are
   * evaluated milliseconds and one hydration apart.
   */
  nowIso: string;
};

/* ------------------------------------------------------------------------------------------- */
/* Headline                                                                                     */
/* ------------------------------------------------------------------------------------------- */

/**
 * The same six states the live badge names, promoted to the page title. Each names the specific
 * thing that is wrong, because one "Reporting interrupted" covered a failing job, a stale report
 * and a job that had never run: three states an operator acts on differently.
 */
const HEADLINE: Record<SystemHealthState, { label: string; tone: StatusTone }> = {
  failed: { label: "Scheduled job failing", tone: "bad" },
  healthy: { label: "Reporting live", tone: "good" },
  "in-progress": { label: "Job run unfinished", tone: "wait" },
  "never-ran": { label: "Scheduled job has never run", tone: "amber" },
  stale: { label: "Job reports stale", tone: "amber" },
  unavailable: { label: "Reporting interrupted", tone: "amber" },
};

function headlineState(health: SystemHealth): SystemHealthState {
  return health.reporting?.state
    ?? (health.queue.state === "available" ? "healthy" : "unavailable");
}

/* ------------------------------------------------------------------------------------------- */
/* Naming                                                                                       */
/* ------------------------------------------------------------------------------------------- */

/** Left uppercase by the sentence-case pass: these are the words, not shouted versions of them. */
const ACRONYMS = new Set(["A2P", "CAPI", "SMS"]);

function sentenceCase(label: string) {
  return label
    .split(" ")
    .map((word, index) => (ACRONYMS.has(word) || index === 0 ? word : word.toLowerCase()))
    .join(" ");
}

/**
 * Job names, said in the platform's own words.
 *
 * `jobLabel()` derives its text from the cron path, which is named after the vendor behind the
 * channel. A vendor name is not what the job does, and the naming rule keeps it off every surface,
 * so the two paths that carry one are named for their work instead and everything else falls
 * through the vendor scrub below.
 */
const JOB_NAMES: Record<string, string> = {
  "a2p-probe": "Texting registration",
  "ghl-install-reconcile": "Channel install reconcile",
};

function jobName(job: SystemHealth["jobs"][number]) {
  return JOB_NAMES[job.id]
    ?? sentenceCase(job.label.replace(/\bGHL\b/g, "Channel").replace(/\bTwilio\b/gi, "Carrier"));
}

/** What each job is, in the provider slot. The cron expression itself lives in the Jobs tab. */
const JOB_PROVIDERS: Record<string, string> = {
  "a2p-probe": "carrier vetting",
  "appointment-reconcile": "calendar",
  "billing-allowances": "billing",
  "billing-cost-rollup": "billing",
  "capi-events": "Meta",
  "stripe-webhooks": "Stripe",
};

/** The integration slot, without a deployment configuration name anywhere in it. */
const PROVIDER_LABELS: Record<string, string> = {
  alerts: "Slack",
  calendar: "calendar sync",
  "credential-storage": "encryption",
  email: "email",
  "model-routing": "OpenRouter",
  payments: "Stripe",
  "social-messaging": "Meta",
  "text-messages": "SMS",
};

/* ------------------------------------------------------------------------------------------- */
/* Services                                                                                     */
/* ------------------------------------------------------------------------------------------- */

type ServiceRow = {
  key: string;
  name: string;
  provider: string;
  /** Last run or last event. Mono, right-aligned, and an em dash where nothing recorded one. */
  meta: string;
  metaAmber: boolean;
  dot: StatusTone;
  pill: { label: string; tone: PillTone };
};

function formatDateTime(value: string | null, absent: string) {
  if (!value) return absent;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "time not recorded" : workspaceDateTimeFormat.format(date);
}

/**
 * A failed job takes a neutral pill and a red dot rather than an amber one.
 *
 * Amber is the pending colour, and a job that failed is not pending: it ran and it did not work.
 * `PillTone` carries no red, and `_primitives.tsx` is not this screen's file to change, so the
 * artboard's own pattern for a settled bad outcome applies -- a neutral pill whose dot carries the
 * colour, the way `OwnerAudit.body.html` draws "Reversed". Amber stays on the states that really
 * are waiting on something: a stale report, a job that has never run.
 */
function jobPill(state: SystemHealthState): { label: string; tone: PillTone } {
  if (state === "healthy") return { label: "Healthy", tone: "good" };
  if (state === "failed") return { label: "Failed", tone: "neutral" };
  return { label: "No recent report", tone: "amber" };
}

function jobDot(state: SystemHealthState): StatusTone {
  if (state === "healthy") return "good";
  if (state === "failed") return "bad";
  if (state === "in-progress") return "wait";
  return "amber";
}

function providerPill(
  state: SystemHealth["providers"][number]["state"],
): { label: string; tone: PillTone } {
  if (state === "real") return { label: "Real", tone: "good" };
  if (state === "mock") return { label: "Mock", tone: "neutral" };
  return { label: "Needs setup", tone: "amber" };
}

/**
 * Integrations first, then scheduled jobs. The artboard interleaves them by importance, which is
 * a judgement no field on this read carries; a stable order a reader can learn beats one that
 * rearranges itself between visits.
 */
function serviceRows(health: SystemHealth): ServiceRow[] {
  const integrations = health.providers.map((provider) => ({
    key: `provider:${provider.id}`,
    name: sentenceCase(provider.label),
    provider: PROVIDER_LABELS[provider.id] ?? "integration",
    meta: "—",
    metaAmber: false,
    dot: provider.state === "real" ? ("good" as const)
      : provider.state === "mock" ? ("grey" as const)
        : ("amber" as const),
    pill: providerPill(provider.state),
  }));

  const jobs = health.jobs.map((job) => ({
    key: `job:${job.id}`,
    name: jobName(job),
    provider: JOB_PROVIDERS[job.id] ?? "scheduled job",
    meta: formatDateTime(job.lastRunAt, "no report yet"),
    metaAmber: job.lastRunAt === null,
    dot: jobDot(job.state),
    pill: jobPill(job.state),
  }));

  return [...integrations, ...jobs];
}

function ServicesCard({ rows }: { rows: readonly ServiceRow[] }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--card)] shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-2 border-b border-[var(--line)] px-[14px] py-[10px] text-[13px] font-semibold text-[color:var(--ink)]">
        Services
      </div>
      <ul className="m-0 list-none p-0">
        {rows.map((row) => (
          <li
            className="flex h-12 items-center gap-3 border-b border-[var(--line-soft)] px-4 last:border-b-0"
            data-testid="owner-system-service-row"
            key={row.key}
          >
            <StatusDot tone={row.dot} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[color:var(--ink)]">
              {row.name}
            </span>
            <span className="hidden shrink-0 text-[12.5px] text-[color:var(--faint)] sm:inline">
              {row.provider}
            </span>
            <span
              className={cn(
                "hidden w-[120px] shrink-0 text-right font-mono text-[12px] md:inline",
                row.metaAmber ? "text-[color:var(--warning-text)]" : "text-[color:var(--muted)]",
              )}
            >
              {row.meta}
            </span>
            <Pill className="shrink-0" tone={row.pill.tone}>
              <StatusDot tone={row.dot} />
              {row.pill.label}
            </Pill>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------- */
/* Incidents                                                                                    */
/* ------------------------------------------------------------------------------------------- */

type Incident = {
  key: string;
  at: string | null;
  title: string;
  detail: string;
  tone: "bad" | "amber";
};

const WINDOWS = { "24h": 1, "7d": 7, "30d": 30 } as const;
type WindowKey = keyof typeof WINDOWS;

function humanize(value: string) {
  const words = value.trim().replace(/[_-]+/g, " ").toLowerCase();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : "Not recorded";
}

function failedDelivery(row: DeliveryQueueRow): Incident {
  return {
    key: `delivery:${row.id}`,
    at: row.lastAttemptAt,
    title: `${humanize(row.event)} was not delivered`,
    detail: `${humanize(row.destination)} · ${row.attempts} ${row.attempts === 1 ? "attempt" : "attempts"}`,
    tone: "bad",
  };
}

/**
 * Failed deliveries and job faults on one rail, newest first.
 *
 * An incident that carries no timestamp -- a job that has never recorded a run -- is never filtered
 * out by the window. It is the loudest thing this page can say, and a span that hid it would be a
 * control that suppresses the one row nobody may miss.
 */
function incidents(health: SystemHealth, span: WindowKey, now: number): Incident[] {
  const cutoff = now - WINDOWS[span] * 86_400_000;

  const deliveries = health.queue.rows
    .filter((row) => ["failed", "unavailable"].includes(row.state))
    .map(failedDelivery);

  const jobs = health.jobs
    .filter((job) => job.state !== "healthy" && job.reason !== null)
    .map((job) => ({
      key: `job:${job.id}`,
      at: job.lastRunAt,
      title: `${jobName(job)}: ${jobPill(job.state).label.toLowerCase()}`,
      detail: job.reason ?? "",
      tone: job.state === "failed" ? ("bad" as const) : ("amber" as const),
    }));

  return [...deliveries, ...jobs]
    .filter((incident) => {
      if (!incident.at) return true;
      const at = Date.parse(incident.at);
      return !Number.isFinite(at) || at >= cutoff;
    })
    .sort((left, right) => Date.parse(right.at ?? "") - Date.parse(left.at ?? "") || 0)
    .slice(0, 8);
}

function IncidentsRail({ incidents: rows }: { incidents: readonly Incident[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-[14px] border border-[var(--line)] bg-[var(--card)] p-[18px_20px] shadow-[var(--shadow-card)]">
      <div className="text-[12.5px] font-medium text-[color:var(--faint)]">Incidents</div>
      {rows.length === 0 ? (
        <p className="m-0 font-mono text-[12px] text-[color:var(--muted)]">
          Nothing recorded in this window
        </p>
      ) : (
        rows.map((incident) => (
          <div className="flex gap-3" data-testid="owner-system-incident" key={incident.key}>
            <div
              aria-hidden="true"
              className={cn(
                "w-[2px] shrink-0 rounded-[2px]",
                incident.tone === "bad" ? "bg-[oklch(0.6503_0.135_32)]" : "bg-[var(--warning)]",
              )}
            />
            <div className="min-w-0">
              <div className="font-mono text-[11.5px] text-[color:var(--muted)]">
                {formatDateTime(incident.at, "no run recorded")}
              </div>
              <div className="mt-[2px] text-[13px] font-medium text-[color:var(--ink)]">
                {incident.title}
              </div>
              <div className="mt-[2px] text-[12.5px] leading-[1.5] text-[color:var(--faint)]">
                {incident.detail}
              </div>
            </div>
          </div>
        ))
      )}
      <div className="mt-auto pt-2 font-mono text-[11px] text-[color:var(--faint)]">
        Demo and test traffic excluded
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------- */
/* Tabs                                                                                         */
/* ------------------------------------------------------------------------------------------- */

function JobsTab({ health }: { health: SystemHealth }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--card)] shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-3 border-b border-[var(--line)] px-[14px] py-[10px]">
        <span className="text-[13px] font-semibold text-[color:var(--ink)]">Scheduled jobs</span>
        <span className="ml-auto">
          <ExportMenu
            filename="setterfi-scheduled-jobs"
            mode="local"
            rows={health.jobs.map((job) => ({
              job: jobName(job),
              schedule: job.schedule,
              state: jobPill(job.state).label,
              lastRunAt: job.lastRunAt ?? "",
              reportedSinceYesterday: job.reportedSinceYesterday,
              receiptId: job.receiptId ?? "",
              reason: job.reason ?? "",
            }))}
          />
        </span>
      </div>
      <ul className="m-0 list-none p-0">
        {health.jobs.map((job) => (
          <li
            className="flex flex-col gap-2 border-b border-[var(--line-soft)] px-4 py-3 last:border-b-0 sm:flex-row sm:items-start sm:justify-between"
            data-testid="owner-system-job-row"
            key={job.id}
          >
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-[color:var(--ink)]">{jobName(job)}</div>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-[2px] font-mono text-[11.5px] text-[color:var(--muted)]">
                <span>{job.schedule}</span>
                <span className={job.lastRunAt ? undefined : "text-[color:var(--warning-text)]"}>
                  {formatDateTime(job.lastRunAt, "no report yet")}
                </span>
                {job.receiptId ? <span className="text-[color:var(--faint)]">{job.receiptId}</span> : null}
              </div>
              {job.reason ? (
                <div className="mt-2 text-[12.5px] leading-[1.5] text-[color:var(--muted)]">
                  {job.reason}
                </div>
              ) : null}
            </div>
            <Pill className="shrink-0" tone={jobPill(job.state).tone}>
              {jobPill(job.state).label}
            </Pill>
          </li>
        ))}
      </ul>
    </div>
  );
}

function IntegrationsTab({ health }: { health: SystemHealth }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-[14px] border border-[var(--line)] bg-[var(--card)] shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-3 border-b border-[var(--line)] px-[14px] py-[10px]">
        <span className="text-[13px] font-semibold text-[color:var(--ink)]">Integrations</span>
        <span className="ml-auto">
          <ExportMenu
            filename="setterfi-integrations"
            mode="local"
            rows={health.providers.map((provider) => ({
              integration: provider.label,
              provider: PROVIDER_LABELS[provider.id] ?? "integration",
              state: providerPill(provider.state).label,
              reason: provider.reason ?? "",
            }))}
          />
        </span>
      </div>
      <ul className="m-0 list-none p-0">
        {health.providers.map((provider) => (
          <li
            className="flex flex-col gap-2 border-b border-[var(--line-soft)] px-4 py-3 last:border-b-0 sm:flex-row sm:items-start sm:justify-between"
            data-testid="owner-system-integration-row"
            key={provider.id}
          >
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-[color:var(--ink)]">
                {sentenceCase(provider.label)}
              </div>
              {provider.reason ? (
                <div className="mt-1 text-[12.5px] leading-[1.5] text-[color:var(--muted)]">
                  {provider.reason}
                </div>
              ) : null}
            </div>
            <Pill className="shrink-0" tone={providerPill(provider.state).tone}>
              {providerPill(provider.state).label}
            </Pill>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------- */
/* Page body                                                                                    */
/* ------------------------------------------------------------------------------------------- */

/**
 * Every sentence this screen used to print under a heading, handed to the eye instead: what the
 * page covers, what "delivered" does and does not mean, and why an integration row never names a
 * deployment configuration.
 */
const EYE_COPY = "The jobs, the queues and the integration modes: whether the platform is actually "
  + "doing anything. Demo and test traffic is excluded everywhere on this page. Delivered means a "
  + "destination accepted the attempt; nothing here records whether a person read it. Integration "
  + "rows carry the mode and the setup state without naming any deployment configuration. Nothing "
  + "on this page retries a schedule.";

const TAB_IDS = ["status", "jobs", "integrations"] as const;
type TabId = (typeof TAB_IDS)[number];

export function OwnerSystem({ health, nowIso }: OwnerSystemProps) {
  const pathname = usePathname();
  const params = useSearchParams();

  const requestedTab = params.get("tab");
  const tab: TabId = TAB_IDS.includes(requestedTab as TabId) ? (requestedTab as TabId) : "status";
  const requestedWindow = params.get("window");
  const span: WindowKey = requestedWindow === "24h" || requestedWindow === "30d"
    ? requestedWindow
    : "7d";

  const state = headlineState(health);
  const headline = HEADLINE[state];
  const rows = useMemo(() => serviceRows(health), [health]);
  const rail = useMemo(
    () => incidents(health, span, Date.parse(nowIso)),
    [health, nowIso, span],
  );

  function href(next: Partial<{ tab: TabId; window: WindowKey }>) {
    const query = new URLSearchParams(params.toString());
    if (next.tab) query.set("tab", next.tab);
    if (next.window) query.set("window", next.window);
    return `${pathname}?${query.toString()}`;
  }

  return (
    <div className="relative flex min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex items-center gap-3">
          <StatusDot className="size-[12px] flex-[0_0_12px]" tone={headline.tone} />
          <h1 className="m-0 text-[30px] leading-[1.1] font-[600] tracking-[-0.02em] text-[color:var(--ink)]">
            {headline.label}
          </h1>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Seg
            items={(Object.keys(WINDOWS) as WindowKey[]).map((key) => ({
              active: key === span,
              href: href({ window: key }),
              label: key,
            }))}
            label="Window the incidents rail covers"
          />
          <ExportMenu
            filename="setterfi-system-services"
            mode="local"
            rows={rows.map((row) => ({
              service: row.name,
              provider: row.provider,
              lastActivity: row.meta,
              state: row.pill.label,
            }))}
          />
        </div>
      </div>

      <RehaulTabs
        items={[
          { active: tab === "status", href: href({ tab: "status" }), label: "Status" },
          {
            active: tab === "jobs",
            count: health.jobs.length || undefined,
            href: href({ tab: "jobs" }),
            label: "Jobs",
          },
          { active: tab === "integrations", href: href({ tab: "integrations" }), label: "Integrations" },
        ]}
        label="System sections"
      />

      {tab === "status" ? (
        <div className="flex min-h-0 flex-col gap-4">
          <FigureStrip
            items={[
              {
                label: "Jobs with a run receipt",
                value: health.jobs.filter((job) => job.receiptId !== null).length,
              },
              { label: "Active queue", value: health.queue.depth },
              { label: "Failed attempts", tone: "failure", value: health.queue.failedAttempts },
              { label: "Terminal attempts", tone: "warning", value: health.queue.terminalAttempts },
            ]}
            label="Delivery summary"
          />
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <ServicesCard rows={rows} />
            <IncidentsRail incidents={rail} />
          </div>
        </div>
      ) : tab === "jobs" ? (
        <JobsTab health={health} />
      ) : (
        <IntegrationsTab health={health} />
      )}

      <ContextEye copy={EYE_COPY} screen="owner-system" />
    </div>
  );
}
