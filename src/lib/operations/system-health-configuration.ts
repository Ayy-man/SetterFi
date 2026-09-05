/**
 * Presentation helpers for a scheduled job that is waiting on deployment configuration.
 *
 * Kept apart from `system-health.ts`, which imports the service Supabase client and the cron
 * topology: both operator screens are client components and need these three functions without
 * dragging a server module into the browser bundle. No directive, so a server component can share
 * the same values (see `src/app/server-client-boundary.test.ts`).
 */

export type JobMissingConfiguration = {
  /** Variable names only, never values. */
  variables: readonly string[];
  /** ISO instant the current run of skipped receipts began. */
  since: string;
};

type ConfigurationJob = {
  state: string;
  missingConfiguration: JobMissingConfiguration | null;
};

/**
 * One line for the top of a jobs section: how many jobs are waiting, and the union of the names
 * they wait on, each named once, in the order they are first met so the line is stable between
 * renders. Null when nothing is waiting, so the line is absent rather than "0 jobs".
 */
export function missingConfigurationSummary(jobs: readonly ConfigurationJob[]) {
  const waiting = jobs.filter((job) => job.state === "not-configured");
  if (waiting.length === 0) return null;
  const variables = [...new Set(waiting.flatMap((job) => job.missingConfiguration?.variables ?? []))];
  return {
    count: waiting.length,
    variables,
    label: `${waiting.length} ${waiting.length === 1 ? "job" : "jobs"} waiting on configuration`
      + (variables.length > 0 ? `: ${variables.join(", ")}` : ""),
  };
}

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/**
 * "3 days ago", "yesterday", "2 hours ago", "just now". Coarse on purpose: an operator needs to
 * know whether a variable has been missing since this morning or since last month, not the minute.
 */
export function relativeTimeLabel(iso: string, nowMs: number) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "an unknown time";
  const elapsedMs = nowMs - at;
  if (elapsedMs < 60_000) return "just now";
  const minutes = Math.round(elapsedMs / 60_000);
  if (minutes < 60) return RELATIVE.format(-minutes, "minute");
  const hours = Math.round(elapsedMs / 3_600_000);
  if (hours < 24) return RELATIVE.format(-hours, "hour");
  const days = Math.round(elapsedMs / 86_400_000);
  if (days < 30) return RELATIVE.format(-days, "day");
  const months = Math.round(days / 30);
  if (months < 12) return RELATIVE.format(-months, "month");
  return RELATIVE.format(-Math.round(days / 365), "year");
}

/** The words under the badge: "since 3 days ago". */
export function missingSinceLabel(configuration: JobMissingConfiguration, nowMs: number) {
  return `since ${relativeTimeLabel(configuration.since, nowMs)}`;
}
