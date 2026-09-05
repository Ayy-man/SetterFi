import { DriverConfigurationError } from "@/lib/env-contract";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const JOB_RECEIPT_KEYS = [
  "a2p-probe",
  "agent-inactivity-sweep",
  "appointment-reconcile",
  "billing-allowances",
  "billing-cost-rollup",
  "capi-events",
  "compliance-reconcile",
  "contact-deletion-recovery",
  "engine-evals",
  "followups",
  "ghl-install-reconcile",
  "inbound-recovery",
  "notification-deliveries",
  "outbound-reconciliation",
  "platform-smoke",
  "provisioning-run",
  "stripe-webhooks",
  "tenant-health-rollup",
  "tier-change-reconcile",
] as const;

export type JobReceiptKey = typeof JOB_RECEIPT_KEYS[number];
export type JobReceiptOutcome = "succeeded" | "failed" | "skipped";
export type JobReceiptCounters = Record<string, number | string | readonly string[]>;

/**
 * Returned to the scheduler after a deliberate no-driver skip. It is deliberately a normal 200
 * response so a cron service does not retry configuration that an operator has intentionally left
 * unset.
 */
export const DRIVER_NOT_CONFIGURED_COUNTERS = { skipped: "driver_not_configured" } as const;

/** The counters key under which a skipped receipt stores the missing variable names, as an array. */
export const MISSING_VARIABLES_COUNTER = "missing_variables";

export function isDriverNotConfiguredResult(value: unknown): value is typeof DRIVER_NOT_CONFIGURED_COUNTERS {
  return value === DRIVER_NOT_CONFIGURED_COUNTERS;
}

/**
 * What a skipped receipt persists: the scheduler's marker plus the variable names as their own
 * JSON array, so the operator surface reads a field rather than splitting `error_detail`.
 */
export function driverNotConfiguredCounters(variableNames: readonly string[]): JobReceiptCounters {
  return { ...DRIVER_NOT_CONFIGURED_COUNTERS, [MISSING_VARIABLES_COUNTER]: [...variableNames] };
}

/** Environment variable names are upper-case identifiers; anything else is not a name. */
const VARIABLE_NAME = /^[A-Z][A-Z0-9_]*$/u;

/**
 * The variable names a skipped receipt is waiting on.
 *
 * The structured counter is authoritative. Receipts written before it existed carry only
 * `error_detail`, which `DriverConfigurationError` writes as the names joined with ", ", so that
 * is split on commas and filtered to identifiers; a free-text detail yields no names rather than
 * fragments of a sentence.
 */
export function parseMissingVariableNames(input: {
  counters: unknown;
  errorDetail: string | null;
}): string[] {
  const counters = input.counters;
  if (counters && typeof counters === "object" && !Array.isArray(counters)) {
    const stored = (counters as Record<string, unknown>)[MISSING_VARIABLES_COUNTER];
    if (Array.isArray(stored)) {
      const names = stored.filter((name): name is string => typeof name === "string" && VARIABLE_NAME.test(name));
      if (names.length > 0) return [...new Set(names)];
    }
  }
  const detail = input.errorDetail?.trim() ?? "";
  return [...new Set(detail.split(",").map((part) => part.trim()).filter((part) => VARIABLE_NAME.test(part)))];
}

export type MissingConfiguration = {
  /** Names only, never values. */
  variables: string[];
  /** When the current unbroken run of skipped receipts for this job began. */
  since: string;
};

type StartedReceipt = { id: string; started_at: string };

export type JobReceiptStore = {
  start(input: { jobKey: JobReceiptKey; startedAt: string }): Promise<StartedReceipt>;
  finish(input: {
    id: string;
    finishedAt: string;
    outcome: JobReceiptOutcome;
    errorDetail: string | null;
    counters: JobReceiptCounters;
  }): Promise<void>;
};

export type JobReceiptExecution = <T>(
  jobKey: JobReceiptKey,
  work: () => Promise<T>,
  options?: {
    counters?: (result: T) => JobReceiptCounters;
    outcome?: (result: T) => JobReceiptOutcome;
    errorDetail?: (result: T) => string | null;
  },
) => Promise<T>;

export type LatestJobReceipt = {
  id: string | null;
  jobKey: JobReceiptKey;
  startedAt: string | null;
  finishedAt: string | null;
  outcome: JobReceiptOutcome | null;
  errorDetail: string | null;
  counters: JobReceiptCounters;
  /** Set only on a skipped receipt: which variables the driver is waiting on, and since when. */
  missingConfiguration: MissingConfiguration | null;
  freshness: "fresh" | "stale" | "in_progress" | "missing";
  ageMs: number | null;
  freshnessWindowMs: number;
};

type ReceiptRow = {
  id: string;
  job_key: JobReceiptKey;
  started_at: string;
  finished_at: string | null;
  outcome: JobReceiptOutcome | null;
  error_detail: string | null;
  counters: unknown;
};

const JOB_FRESHNESS_WINDOWS_MS: Record<JobReceiptKey, number> = {
  "a2p-probe": 26 * 60 * 60_000,
  "appointment-reconcile": 26 * 60 * 60_000,
  "agent-inactivity-sweep": 26 * 60 * 60_000,
  "billing-allowances": 26 * 60 * 60_000,
  "billing-cost-rollup": 26 * 60 * 60_000,
  "capi-events": 10 * 60_000,
  "compliance-reconcile": 26 * 60 * 60_000,
  "contact-deletion-recovery": 10 * 60_000,
  "engine-evals": 26 * 60 * 60_000,
  "followups": 20 * 60_000,
  "ghl-install-reconcile": 20 * 60_000,
  "inbound-recovery": 10 * 60_000,
  "notification-deliveries": 26 * 60 * 60_000,
  "outbound-reconciliation": 10 * 60_000,
  // Hourly at :20; two cycles plus slack so one slow run does not read as stale.
  "platform-smoke": 130 * 60_000,
  "provisioning-run": 20 * 60_000,
  "stripe-webhooks": 45 * 60_000,
  "tenant-health-rollup": 26 * 60 * 60_000,
  "tier-change-reconcile": 26 * 60 * 60_000,
};
const ERROR_DETAIL_LIMIT = 1_000;

function errorDetail(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.slice(0, ERROR_DETAIL_LIMIT) || "JOB_FAILED_WITHOUT_ERROR_DETAIL";
}

function numericCounters(value: unknown): JobReceiptCounters {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, candidate]) =>
    typeof candidate === "number" && Number.isFinite(candidate),
  )) as JobReceiptCounters;
}

function isDriverNotConfigured(cause: unknown): cause is DriverConfigurationError {
  return cause instanceof DriverConfigurationError;
}

function parseCounters(value: unknown): JobReceiptCounters {
  return numericCounters(value);
}

function sameNames(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

/**
 * `since` is the start of the current unbroken run of skipped receipts naming the same variables,
 * walking back from the newest row (the rows arrive newest first). A job skipped nightly for a
 * month has been waiting a month, not since last night; a change in the missing set, a failure
 * or a success in between ends the run.
 */
function missingConfiguration(rows: readonly ReceiptRow[]): MissingConfiguration | null {
  const newest = rows[0];
  if (!newest || newest.outcome !== "skipped") return null;
  const variables = parseMissingVariableNames({ counters: newest.counters, errorDetail: newest.error_detail });
  let since = newest.finished_at ?? newest.started_at;
  for (const row of rows.slice(1)) {
    if (row.outcome !== "skipped") break;
    const names = parseMissingVariableNames({ counters: row.counters, errorDetail: row.error_detail });
    if (!sameNames(names, variables)) break;
    since = row.finished_at ?? row.started_at;
  }
  return { variables, since };
}

function serviceStore(): JobReceiptStore {
  return {
    async start(input) {
      const client = createSupabaseServiceClient();
      const { data, error } = await client.from("job_receipts").insert({
        job_key: input.jobKey,
        started_at: input.startedAt,
      }).select("id,started_at").single();
      if (error || !data) throw new Error("JOB_RECEIPT_START_FAILED");
      return data;
    },
    async finish(input) {
      const client = createSupabaseServiceClient();
      const { data, error } = await client.from("job_receipts").update({
        finished_at: input.finishedAt,
        outcome: input.outcome,
        error_detail: input.errorDetail,
        counters: input.counters,
      }).eq("id", input.id).is("finished_at", null).select("id").maybeSingle();
      if (error || !data) throw new Error("JOB_RECEIPT_FINISH_FAILED");
    },
  };
}

export function createJobReceiptExecution(
  store: JobReceiptStore,
  now: () => Date = () => new Date(),
): JobReceiptExecution {
  return async function executeJobWithReceipt(jobKey, work, options = {}) {
    const receipt = await store.start({ jobKey, startedAt: now().toISOString() });
    try {
      const result = await work();
      const outcome = options.outcome?.(result) ?? "succeeded";
      await store.finish({
        id: receipt.id,
        finishedAt: now().toISOString(),
        outcome,
        errorDetail: outcome === "failed"
          ? options.errorDetail?.(result) ?? "JOB_RETURNED_FAILED_OUTCOME"
          : null,
        counters: options.counters?.(result) ?? numericCounters(result),
      });
      return result;
    } catch (cause) {
      try {
        if (isDriverNotConfigured(cause)) {
          await store.finish({
            id: receipt.id,
            finishedAt: now().toISOString(),
            outcome: "skipped",
            errorDetail: cause.variableNames.join(", "),
            counters: driverNotConfiguredCounters(cause.variableNames),
          });
          return DRIVER_NOT_CONFIGURED_COUNTERS as never;
        }
        await store.finish({
          id: receipt.id,
          finishedAt: now().toISOString(),
          outcome: "failed",
          errorDetail: errorDetail(cause),
          counters: {},
        });
      } catch {
        // Preserve the job failure for the HTTP handler; a failed finalization is unavailable,
        // never a reason to report the job as successful.
      }
      throw cause;
    }
  };
}

export const runJobWithReceipt = createJobReceiptExecution(serviceStore());

export async function readLatestJobReceipts(input: {
  now?: Date;
  freshnessMs?: Partial<Record<JobReceiptKey, number>>;
} = {}): Promise<readonly LatestJobReceipt[]> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.from("job_receipts")
    .select("id,job_key,started_at,finished_at,outcome,error_detail,counters")
    .in("job_key", JOB_RECEIPT_KEYS)
    .order("started_at", { ascending: false })
    .order("id", { ascending: false });
  if (error) throw new Error("JOB_RECEIPT_READ_FAILED");

  const history = new Map<JobReceiptKey, ReceiptRow[]>();
  for (const row of (data ?? []) as ReceiptRow[]) {
    const rows = history.get(row.job_key);
    if (rows) rows.push(row);
    else history.set(row.job_key, [row]);
  }
  const latest = new Map<JobReceiptKey, ReceiptRow>();
  for (const [jobKey, rows] of history) latest.set(jobKey, rows[0]);
  const now = input.now ?? new Date();
  return JOB_RECEIPT_KEYS.map((jobKey) => {
    const row = latest.get(jobKey);
    const freshnessWindowMs = input.freshnessMs?.[jobKey] ?? JOB_FRESHNESS_WINDOWS_MS[jobKey];
    if (!row) {
      return {
        id: null, jobKey, startedAt: null, finishedAt: null, outcome: null, errorDetail: null,
        counters: {}, missingConfiguration: null, freshness: "missing" as const, ageMs: null,
        freshnessWindowMs,
      };
    }
    const referenceAt = row.finished_at ?? row.started_at;
    const ageMs = now.getTime() - Date.parse(referenceAt);
    return {
      id: row.id,
      jobKey: row.job_key,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      outcome: row.outcome,
      errorDetail: row.error_detail,
      counters: parseCounters(row.counters),
      missingConfiguration: missingConfiguration(history.get(jobKey) ?? [row]),
      freshness: row.finished_at === null
        ? Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= freshnessWindowMs
          ? "in_progress"
          : "stale"
        : Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= freshnessWindowMs
          ? "fresh"
          : "stale",
      ageMs: Number.isFinite(ageMs) ? ageMs : null,
      freshnessWindowMs,
    };
  });
}
