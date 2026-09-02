/**
 * One structured log line per step of the marketplace install path.
 *
 * The audit rows are the record, but they live in the same database the install writes to, so a
 * failure between the provider and that database leaves no trace anywhere an operator can read
 * during the call. These lines go to the runtime log instead and are meant to be read live from the
 * Vercel logs, filtered on `[ghl-install]`.
 *
 * Nothing secret can reach a line: the fields are an allow-list of identifiers, booleans, codes,
 * timestamps, and counts. The raw state, the authorization code, any token, the client secret, and
 * provider prose have no key here and are dropped by the field filter if a caller passes them.
 */

export type InstallLogFields = {
  app?: string;
  state_ref?: string;
  actor_id?: string;
  actor_role?: string;
  tenant_id?: string | null;
  return_path?: string;
  expires_at?: string;
  code?: string;
  provider_status?: number;
  body_shape?: string;
  provider_error?: string;
  missing_env?: readonly string[];
  has_state?: boolean;
  has_code?: boolean;
  has_provider_error?: boolean;
  user_type?: string;
  company_id?: string | null;
  location_id?: string | null;
  install_target?: string;
  install_id?: string;
  token_expires_at?: string;
  approve_all_locations?: boolean | null;
  is_bulk_installation?: boolean | null;
  install_to_future_locations?: boolean | null;
  outcome?: string;
  redirect_to?: string;
  audit_action?: string;
  duration_ms?: number;
  attempt?: number;
};

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "app",
  "state_ref",
  "actor_id",
  "actor_role",
  "tenant_id",
  "return_path",
  "expires_at",
  "code",
  "provider_status",
  "body_shape",
  "provider_error",
  "missing_env",
  "has_state",
  "has_code",
  "has_provider_error",
  "user_type",
  "company_id",
  "location_id",
  "install_target",
  "install_id",
  "token_expires_at",
  "approve_all_locations",
  "is_bulk_installation",
  "install_to_future_locations",
  "outcome",
  "redirect_to",
  "audit_action",
  "duration_ms",
  "attempt",
]);

/** A value that could only be a token or a sentence is dropped even under an allowed key. */
const MAX_STRING = 96;

export type InstallLogLevel = "info" | "error";

export type InstallLogSink = (level: InstallLogLevel, line: string) => void;

const defaultSink: InstallLogSink = (level, line) => {
  if (level === "error") console.error(line);
  else console.info(line);
};

let sink: InstallLogSink = defaultSink;

/** Test seam only. */
export function setInstallLogSink(next: InstallLogSink | null) {
  sink = next ?? defaultSink;
}

export function installLogLine(step: string, fields: InstallLogFields) {
  const entry: Record<string, unknown> = { at: new Date().toISOString(), step };
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_KEYS.has(key) || value === undefined) continue;
    if (typeof value === "string" && value.length > MAX_STRING) continue;
    if (Array.isArray(value)) {
      entry[key] = value.filter((item) => typeof item === "string" && item.length <= MAX_STRING);
      continue;
    }
    entry[key] = value;
  }
  return `[ghl-install] ${JSON.stringify(entry)}`;
}

export function installLog(step: string, fields: InstallLogFields = {}, level: InstallLogLevel = "info") {
  try {
    sink(level, installLogLine(step, fields));
  } catch {
    // Observing the install must never be the reason it fails.
  }
}

/** Milliseconds since `startedAt`, for the duration field. */
export function installLogElapsed(startedAt: number) {
  return Math.max(0, Math.round(Date.now() - startedAt));
}
