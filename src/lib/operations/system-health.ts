/** Read-only, receipt-derived system health projection for the platform console. */

import type { EnvironmentName, EnvironmentSource } from "@/lib/env-contract";
import {
  EMAIL_CONFIGURATION_NAMES,
  META_CONFIGURATION_NAMES,
} from "@/lib/integrations/selector";
import { STRIPE_CONFIGURATION_NAMES } from "@/lib/integrations/stripe/selector";
import {
  readJobReceipts,
  type SystemJobReceipt,
} from "@/lib/repositories/job-receipts";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import cronTopology from "../../../vercel.json";

export type SystemHealthState = "healthy" | "failed" | "not-configured" | "stale" | "never-ran" | "in-progress" | "unavailable";

export type DeliveryQueueRow = {
  id: string;
  event: string;
  destination: string;
  state: string;
  attempts: number;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  testData: false;
};

type QueueEvidence = {
  depth: number;
  rows: readonly DeliveryQueueRow[];
};

type AttemptEvidence = {
  failed: number;
  terminal: number;
};

export type SystemHealthSource = {
  readQueueEvidence(): Promise<QueueEvidence>;
  readAttemptEvidence(): Promise<AttemptEvidence>;
  readJobReceipts(): Promise<readonly SystemJobReceipt[]>;
};

export type SystemHealth = {
  queue: {
    state: "available" | "unavailable";
    depth: number | null;
    failedAttempts: number | null;
    terminalAttempts: number | null;
    rows: readonly DeliveryQueueRow[];
    reason: string | null;
  };
  jobs: readonly {
    id: string;
    label: string;
    schedule: string;
    state: SystemHealthState;
    lastRunAt: string | null;
    reportedSinceYesterday: boolean;
    receiptId: string | null;
    reason: string | null;
    /**
     * The failed receipt's own `error_detail`, only on a job whose latest run failed. Every other
     * state sets it null: a stale row's old failure would read as a current one, and a succeeded
     * receipt carrying a detail is a writer bug rather than something to report.
     */
    errorDetail: string | null;
  }[];
  providers: readonly {
    id: string;
    label: string;
    state: "mock" | "real" | "unavailable";
    reason: string | null;
  }[];
  /** Queue and scheduled-job evidence, which is distinct from provider configuration mode. */
  reporting?: {
    state: SystemHealthState;
    reason: string | null;
  };
};

const SINCE_YESTERDAY_MINUTES = 24 * 60;

type CronTopology = {
  crons: readonly { path: string; schedule: string }[];
};

function jobLabel(id: string) {
  return id.split("-").map((part) => {
    if (part === "a2p") return "A2P";
    if (part === "capi") return "CAPI";
    if (part === "ghl") return "GHL";
    return `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`;
  }).join(" ");
}

/**
 * Most scheduled work lives under /api/jobs and its receipt key is the last path segment. A cron
 * that does not is named here explicitly, because a route whose derived id misses its receipt key
 * reads never-ran on this board forever while the job is in fact running fine.
 */
const RECEIPT_KEY_BY_CRON_PATH: Record<string, string> = {
  "/api/onboarding/run": "provisioning-run",
};

function receiptKeyForCron(path: string) {
  return RECEIPT_KEY_BY_CRON_PATH[path] ?? path.replace("/api/jobs/", "");
}

/** `vercel.json` is the deployed schedule authority; a route without a cron never appears here. */
const SYSTEM_JOBS = (cronTopology as CronTopology).crons.map((cron) => ({
  id: receiptKeyForCron(cron.path),
  label: jobLabel(receiptKeyForCron(cron.path)),
  schedule: cron.schedule,
}));

type ProviderDescriptor = {
  id: string;
  label: string;
  checks: readonly {
    selectorName: EnvironmentName;
    requiredNames: readonly EnvironmentName[];
  }[];
};

const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    id: "text-messages",
    label: "Text messages (SMS)",
    checks: [{ selectorName: "SETTERFI_GHL_DRIVER", requiredNames: ["GHL_CLIENT_ID", "GHL_CLIENT_SECRET", "GHL_WEBHOOK_PUBLIC_KEY"] }],
  },
  {
    id: "calendar",
    label: "Calendar",
    checks: [{ selectorName: "SETTERFI_GHL_DRIVER", requiredNames: ["GHL_CLIENT_ID", "GHL_CLIENT_SECRET", "GHL_WEBHOOK_PUBLIC_KEY"] }],
  },
  {
    id: "model-routing",
    label: "Model routing",
    checks: [
      { selectorName: "SETTERFI_OPENROUTER_DRIVER", requiredNames: ["OPENROUTER_API_KEY"] },
      { selectorName: "SETTERFI_EMBEDDINGS_DRIVER", requiredNames: ["OPENROUTER_API_KEY"] },
    ],
  },
  {
    id: "social-messaging",
    label: "Instagram and Messenger",
    checks: [{
      selectorName: "SETTERFI_META_DRIVER",
      requiredNames: META_CONFIGURATION_NAMES.filter(
        (name) => name !== "SETTERFI_CREDENTIAL_ENCRYPTION_KEY",
      ),
    }],
  },
  {
    id: "credential-storage",
    label: "Credential storage",
    checks: [{
      selectorName: "SETTERFI_META_DRIVER",
      requiredNames: ["SETTERFI_CREDENTIAL_ENCRYPTION_KEY"],
    }],
  },
  {
    id: "payments",
    label: "Payments",
    checks: [{ selectorName: "SETTERFI_STRIPE_DRIVER", requiredNames: STRIPE_CONFIGURATION_NAMES }],
  },
  {
    id: "email",
    label: "Email",
    checks: [{ selectorName: "SETTERFI_EMAIL_DRIVER", requiredNames: EMAIL_CONFIGURATION_NAMES }],
  },
] as const;

function configured(name: string, environment: EnvironmentSource) {
  return Boolean(environment[name]?.trim());
}

function providerInventory(environment: EnvironmentSource): SystemHealth["providers"] {
  return PROVIDERS.map((provider) => {
    const checks = provider.checks.map((check) => {
      const selected = environment[check.selectorName]?.trim();
      if (!selected || selected === "mock") return "mock" as const;
      if (selected !== "real") return "invalid" as const;
      return check.requiredNames.every((name) => configured(name, environment))
        ? "real" as const
        : "incomplete" as const;
    });
    const state = checks.some((check) => check === "invalid" || check === "incomplete")
      ? "unavailable" as const
      : checks.every((check) => check === "real")
        ? "real" as const
        : "mock" as const;
    const reason = checks.some((check) => check === "invalid")
      ? "The integration mode is not recognised."
      : checks.some((check) => check === "incomplete")
        ? "Required setup is incomplete."
        : checks.some((check) => check === "real") && checks.some((check) => check === "mock")
          ? "Part of this integration is using mock data."
          : null;

    return {
      id: provider.id,
      label: provider.label,
      state,
      reason,
    };
  });
}

function jobInventory(
  receipts: readonly SystemJobReceipt[],
  now: Date,
  receiptReadAvailable: boolean,
): SystemHealth["jobs"] {
  return SYSTEM_JOBS.map((job) => {
    const receipt = receipts
      .filter((candidate) => candidate.job === job.id)
      .sort((left, right) => (right.finishedAt ?? "").localeCompare(left.finishedAt ?? ""))[0];
    if (!receiptReadAvailable) {
      return {
        ...job,
        state: "unavailable" as const,
        lastRunAt: null,
        reportedSinceYesterday: false,
        receiptId: null,
        reason: "Job receipts could not be read.",
        errorDetail: null,
      };
    }
    if (!receipt) {
      return {
        ...job,
        state: "never-ran" as const,
        lastRunAt: null,
        reportedSinceYesterday: false,
        receiptId: null,
        reason: "No run report has been recorded.",
        errorDetail: null,
      };
    }
    const lastRunAt = receipt.finishedAt ?? receipt.startedAt;
    const age = lastRunAt ? now.getTime() - Date.parse(lastRunAt) : Number.NaN;
    const reportedSinceYesterday = Number.isFinite(age)
      && age >= 0
      && age <= SINCE_YESTERDAY_MINUTES * 60_000;
    if (receipt.freshness === "missing") {
      return {
        ...job,
        state: "never-ran" as const,
        lastRunAt: null,
        reportedSinceYesterday: false,
        receiptId: null,
        reason: "No run report has been recorded.",
        errorDetail: null,
      };
    }
    if (receipt.freshness === "stale") {
      return {
        ...job,
        state: "stale" as const,
        lastRunAt,
        reportedSinceYesterday,
        receiptId: receipt.receiptId,
        reason: "The latest run report is outside its expected window.",
        errorDetail: null,
      };
    }
    if (receipt.freshness === "in_progress") {
      return {
        ...job,
        state: "in-progress" as const,
        lastRunAt,
        reportedSinceYesterday,
        receiptId: receipt.receiptId,
        reason: "The latest run has not recorded a terminal outcome.",
        errorDetail: null,
      };
    }
    const skipped = receipt.outcome === "skipped";
    const failed = receipt.outcome === "failed";
    return {
      ...job,
      state: skipped ? "not-configured" as const : failed ? "failed" as const : "healthy" as const,
      lastRunAt,
      reportedSinceYesterday,
      receiptId: receipt.receiptId,
      reason: skipped
        ? "The job driver is not configured in this environment."
        : failed ? "The latest run report says this job failed." : null,
      errorDetail: (failed || skipped) ? receipt.errorDetail?.trim() || null : null,
    };
  });
}

export function deriveSystemReportingState(input: {
  queueState: SystemHealth["queue"]["state"];
  jobs: SystemHealth["jobs"];
}): NonNullable<SystemHealth["reporting"]> {
  if (input.queueState === "unavailable") {
    return { state: "unavailable", reason: "Delivery activity could not be read." };
  }
  if (input.jobs.some((job) => job.state === "unavailable")) {
    return { state: "unavailable", reason: "At least one scheduled job could not be assessed." };
  }
  if (input.jobs.some((job) => job.state === "failed")) {
    return { state: "failed", reason: "At least one scheduled job reports a failure." };
  }
  if (input.jobs.some((job) => job.state === "not-configured")) {
    return { state: "not-configured", reason: "At least one scheduled job driver is not configured." };
  }
  if (input.jobs.some((job) => job.state === "stale")) {
    return { state: "stale", reason: "At least one scheduled job report is stale." };
  }
  if (input.jobs.some((job) => job.state === "never-ran")) {
    return { state: "never-ran", reason: "At least one scheduled job has no recorded run." };
  }
  if (input.jobs.some((job) => job.state === "in-progress")) {
    return { state: "in-progress", reason: "At least one scheduled job has not recorded a terminal outcome." };
  }
  return { state: "healthy", reason: null };
}

function createLiveSystemHealthSource(): SystemHealthSource {
  async function realTenantIds() {
    const client = createSupabaseServiceClient();
    const result = await client.from("analytics_tenants").select("tenant_id").order("tenant_id");
    if (result.error) throw new Error("SYSTEM_HEALTH_TENANT_BOUNDARY_UNAVAILABLE");
    return (result.data ?? []).map((row) => String(row.tenant_id));
  }

  return {
    async readQueueEvidence() {
      const client = createSupabaseServiceClient();
      const tenants = await realTenantIds();
      if (tenants.length === 0) return { depth: 0, rows: [] };
      const active = await client.from("notification_deliveries")
        .select("id,notification:notifications!inner(tenant_id,is_test)", { count: "exact", head: true })
        .in("status", ["pending", "failed", "sending", "accepted"])
        .eq("notification.is_test", false)
        .in("notification.tenant_id", tenants);
      if (active.error || active.count === null) throw new Error("SYSTEM_HEALTH_QUEUE_COUNT_UNAVAILABLE");
      const recent = await client.from("notification_deliveries")
        .select("id,destination,status,attempts,last_attempt_at,delivered_at,created_at,notification:notifications!inner(tenant_id,kind,is_test)")
        .eq("notification.is_test", false)
        .in("notification.tenant_id", tenants)
        .order("created_at", { ascending: false })
        .limit(100);
      if (recent.error) throw new Error("SYSTEM_HEALTH_QUEUE_ROWS_UNAVAILABLE");
      return {
        depth: active.count,
        rows: (recent.data ?? []).map((row) => {
          const notification = Array.isArray(row.notification) ? row.notification[0] : row.notification;
          return {
            id: String(row.id), event: String(notification?.kind ?? "Event unavailable"),
            destination: String(row.destination), state: String(row.status), attempts: Number(row.attempts),
            lastAttemptAt: row.last_attempt_at, deliveredAt: row.delivered_at, testData: false as const,
          };
        }),
      };
    },
    async readAttemptEvidence() {
      const client = createSupabaseServiceClient();
      const tenants = await realTenantIds();
      if (tenants.length === 0) return { failed: 0, terminal: 0 };
      const result = await client.from("notification_delivery_attempts")
        .select("outcome,delivery:notification_deliveries!inner(notification:notifications!inner(tenant_id,is_test))")
        .in("outcome", ["retryable", "failed", "unavailable"])
        .eq("delivery.notification.is_test", false)
        .in("delivery.notification.tenant_id", tenants);
      if (result.error) throw new Error("SYSTEM_HEALTH_ATTEMPTS_UNAVAILABLE");
      const outcomes = (result.data ?? []).map((row) => row.outcome);
      return {
        failed: outcomes.filter((outcome) => outcome === "retryable" || outcome === "failed").length,
        terminal: outcomes.filter((outcome) => outcome === "unavailable").length,
      };
    },
    readJobReceipts,
  };
}

export async function loadSystemHealth(input: {
  source?: SystemHealthSource;
  environment?: EnvironmentSource;
  now?: Date;
} = {}): Promise<SystemHealth> {
  const source = input.source ?? createLiveSystemHealthSource();
  const [queueResult, attemptResult, receiptResult] = await Promise.allSettled([
    source.readQueueEvidence(), source.readAttemptEvidence(), source.readJobReceipts(),
  ]);
  const queueAvailable = queueResult.status === "fulfilled" && attemptResult.status === "fulfilled";
  const receiptReadAvailable = receiptResult.status === "fulfilled";
  const receipts = receiptReadAvailable ? receiptResult.value : [];
  const queue = queueAvailable ? {
    state: "available" as const, depth: queueResult.value.depth,
    failedAttempts: attemptResult.value.failed, terminalAttempts: attemptResult.value.terminal,
    rows: queueResult.value.rows, reason: null,
  } : {
    state: "unavailable" as const, depth: null, failedAttempts: null, terminalAttempts: null, rows: [],
    reason: "Delivery activity could not be read.",
  };
  const jobs = jobInventory(receipts, input.now ?? new Date(), receiptReadAvailable);
  return {
    queue,
    jobs,
    providers: providerInventory(input.environment ?? process.env),
    reporting: deriveSystemReportingState({ queueState: queue.state, jobs }),
  };
}
