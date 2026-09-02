/** Read-only, evidence-backed tenant health detail for platform operators. */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const TENANT_HEALTH_SIGNAL_KEYS = [
  "carrier",
  "channel",
  "provisioning",
  "subscription",
] as const;

export type TenantHealthSignalKey = (typeof TENANT_HEALTH_SIGNAL_KEYS)[number];
export type TenantHealthState = "healthy" | "unhealthy" | "indeterminate";
export type TenantHealthFreshness = "current" | "stale" | "not-measured";

type JsonObject = Record<string, unknown>;

type RawTenantHealthDetailRow = {
  tenant_id: string;
  snapshot_day: string | null;
  overall_state: TenantHealthState;
  signal_key: TenantHealthSignalKey;
  signal_state: TenantHealthState;
  observed_value: JsonObject | null;
  threshold: JsonObject;
  observed_at: string | null;
  stale_after_at: string | null;
  calculated_at: string | null;
};

export type TenantHealthAction = {
  availability: "available" | "not-available";
  command: "nudge_onboarding" | null;
  endpoint: string | null;
  reason: string;
};

export type TenantHealthSignalDetail = {
  key: TenantHealthSignalKey;
  label: string;
  state: TenantHealthState;
  freshness: TenantHealthFreshness;
  observedValue: JsonObject | null;
  threshold: JsonObject;
  observedAt: string | null;
  staleAfterAt: string | null;
  calculatedAt: string | null;
  reason: string;
  action: TenantHealthAction;
};

export type TenantHealthDetail = {
  tenantId: string;
  state: TenantHealthState;
  snapshotDay: string | null;
  calculatedAt: string | null;
  signals: readonly TenantHealthSignalDetail[];
};

export class TenantHealthDetailError extends Error {
  constructor(readonly code: "ACCESS_REFUSED" | "UNAVAILABLE" | "INVALID_PROJECTION") {
    super(code);
  }
}

export type TenantHealthDetailDependencies = {
  read(input: { expectedTenant: string; actorId: string }): Promise<unknown>;
};

const SIGNAL_LABELS: Record<TenantHealthSignalKey, string> = {
  carrier: "Carrier delivery",
  channel: "Messaging channel",
  provisioning: "Provisioning",
  subscription: "Subscription",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function jsonObject(value: unknown) {
  return value === null || isRecord(value) ? value : null;
}

function requiredString(value: unknown, code: TenantHealthDetailError["code"]) {
  if (typeof value !== "string" || !value.trim()) throw new TenantHealthDetailError(code);
  return value;
}

function nullableString(value: unknown, code: TenantHealthDetailError["code"]) {
  if (value !== null && typeof value !== "string") throw new TenantHealthDetailError(code);
  return value;
}

function healthState(value: unknown, code: TenantHealthDetailError["code"]) {
  if (value === "healthy" || value === "unhealthy" || value === "indeterminate") return value;
  throw new TenantHealthDetailError(code);
}

function signalKey(value: unknown, code: TenantHealthDetailError["code"]): TenantHealthSignalKey {
  if (typeof value === "string" && TENANT_HEALTH_SIGNAL_KEYS.includes(value as TenantHealthSignalKey)) {
    return value as TenantHealthSignalKey;
  }
  throw new TenantHealthDetailError(code);
}

function parseRow(value: unknown): RawTenantHealthDetailRow {
  const code = "INVALID_PROJECTION" as const;
  if (!isRecord(value) || !exactKeys(value, [
    "tenant_id", "snapshot_day", "overall_state", "signal_key", "signal_state", "observed_value",
    "threshold", "observed_at", "stale_after_at", "calculated_at",
  ])) throw new TenantHealthDetailError(code);
  const observedValue = jsonObject(value.observed_value);
  const threshold = jsonObject(value.threshold);
  if ((value.observed_value !== null && !observedValue) || !threshold) {
    throw new TenantHealthDetailError(code);
  }
  return {
    tenant_id: requiredString(value.tenant_id, code),
    snapshot_day: nullableString(value.snapshot_day, code),
    overall_state: healthState(value.overall_state, code),
    signal_key: signalKey(value.signal_key, code),
    signal_state: healthState(value.signal_state, code),
    observed_value: observedValue,
    threshold,
    observed_at: nullableString(value.observed_at, code),
    stale_after_at: nullableString(value.stale_after_at, code),
    calculated_at: nullableString(value.calculated_at, code),
  };
}

function parseTimestamp(value: string | null, code: TenantHealthDetailError["code"]) {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TenantHealthDetailError(code);
  return parsed;
}

function freshness(row: RawTenantHealthDetailRow, now: Date): TenantHealthFreshness {
  if (!row.observed_at || !row.stale_after_at) return "not-measured";
  parseTimestamp(row.observed_at, "INVALID_PROJECTION");
  const staleAfter = parseTimestamp(row.stale_after_at, "INVALID_PROJECTION");
  if (staleAfter === null) return "not-measured";
  return staleAfter <= now.getTime() ? "stale" : "current";
}

function actionFor(tenantId: string, key: TenantHealthSignalKey, state: TenantHealthState): TenantHealthAction {
  if (key === "provisioning" && state !== "healthy") {
    return {
      availability: "available",
      command: "nudge_onboarding",
      endpoint: `/api/platform/clients/${encodeURIComponent(tenantId)}/commands`,
      reason: "An onboarding nudge can be recorded through the existing client command endpoint.",
    };
  }
  return {
    availability: "not-available",
    command: null,
    endpoint: null,
    reason: "No implemented client command directly addresses this signal.",
  };
}

function reasonFor(state: TenantHealthState, signalFreshness: TenantHealthFreshness) {
  if (signalFreshness === "not-measured") return "No observation has been recorded for this signal.";
  if (signalFreshness === "stale") return "The latest observation is outside its expected window.";
  if (state === "healthy") return "The latest observation meets its threshold.";
  if (state === "unhealthy") return "The latest observation does not meet its threshold.";
  return "The latest observation is current but cannot establish a healthy state.";
}

function detailState(rows: readonly TenantHealthSignalDetail[]): TenantHealthState {
  if (rows.some((row) => row.state === "unhealthy")) return "unhealthy";
  if (rows.every((row) => row.state === "healthy")) return "healthy";
  return "indeterminate";
}

function liveDependencies(): TenantHealthDetailDependencies {
  return {
    async read(input) {
      const client = createSupabaseServiceClient();
      const { data, error } = await client.rpc("read_tenant_health_detail", {
        p_expected_tenant: input.expectedTenant,
        p_actor_id: input.actorId,
      });
      if (error) {
        const message = `${error.message} ${error.details ?? ""}`;
        if (/TENANT_HEALTH_(CLIENT_NOT_FOUND|CLIENT_NOT_IN_BOOK|OPERATOR_FORBIDDEN)/.test(message)) {
          throw new TenantHealthDetailError("ACCESS_REFUSED");
        }
        throw new TenantHealthDetailError("UNAVAILABLE");
      }
      return data;
    },
  };
}

export async function loadTenantHealthDetail(input: {
  expectedTenant: string;
  actorId: string;
  source?: TenantHealthDetailDependencies;
  now?: Date;
}): Promise<TenantHealthDetail> {
  const source = input.source ?? liveDependencies();
  const raw = await source.read({ expectedTenant: input.expectedTenant, actorId: input.actorId });
  if (!Array.isArray(raw) || raw.length !== TENANT_HEALTH_SIGNAL_KEYS.length) {
    throw new TenantHealthDetailError("INVALID_PROJECTION");
  }
  const rows = raw.map(parseRow);
  if (new Set(rows.map((row) => row.signal_key)).size !== TENANT_HEALTH_SIGNAL_KEYS.length
    || rows.some((row) => row.tenant_id !== input.expectedTenant)) {
    throw new TenantHealthDetailError("INVALID_PROJECTION");
  }
  const now = input.now ?? new Date();
  const details = rows.map((row) => {
    const signalFreshness = freshness(row, now);
    const state = signalFreshness === "current" ? row.signal_state : "indeterminate" as const;
    return {
      key: row.signal_key,
      label: SIGNAL_LABELS[row.signal_key],
      state,
      freshness: signalFreshness,
      observedValue: row.observed_value,
      threshold: row.threshold,
      observedAt: row.observed_at,
      staleAfterAt: row.stale_after_at,
      calculatedAt: row.calculated_at,
      reason: reasonFor(state, signalFreshness),
      action: actionFor(input.expectedTenant, row.signal_key, state),
    } satisfies TenantHealthSignalDetail;
  }).sort((left, right) => left.key.localeCompare(right.key));
  const snapshotDay = rows[0]?.snapshot_day ?? null;
  const calculatedAt = rows.map((row) => row.calculated_at).find((value) => value !== null) ?? null;
  return {
    tenantId: input.expectedTenant,
    state: detailState(details),
    snapshotDay,
    calculatedAt,
    signals: details,
  };
}
