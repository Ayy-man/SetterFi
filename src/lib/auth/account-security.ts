import { createHash } from "node:crypto";

import { configuredOrigin } from "@/lib/auth/recovery";

export const ACCOUNT_SECURITY_NO_STORE = { "Cache-Control": "no-store" };
export const ACCOUNT_SECURITY_LIMIT = { limit: 3, windowMs: 15 * 60_000 };
export const ACCOUNT_SECURITY_CALLER_LIMIT = { limit: 10, windowMs: 15 * 60_000 };
export const MIN_ACCOUNT_PASSWORD_LENGTH = 12;

export type AccountSecurityOperation = "sessions-list" | "session-revoke" | "sessions-revoke-others" | "password-change";

export type AccountSecurityActor = {
  userId: string;
  tenantId: string | null;
  email: string;
};

export type AccountSecuritySession = {
  id: string;
  startedAt: string;
  lastSeenAt: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  isCurrent: boolean;
};

export type PasswordChange = {
  currentPassword: string;
  password: string;
};

type JsonObject = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REASON_LENGTH = 500;
const MAX_PASSWORD_LENGTH = 1024;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

export function accountSecurityRateLimitKeys(
  operation: AccountSecurityOperation,
  caller: string,
  userId: string,
) {
  const namespace = `auth-account-security:${operation}`;
  const account = createHash("sha256").update(userId).digest("hex");
  return {
    caller: `${namespace}:caller:${caller}`,
    account: `${namespace}:account:${account}`,
  };
}

/**
 * The deployment's configured public origin, or null when it is unset or not a usable https origin.
 *
 * Never throws: `configuredOrigin` refuses a non-https or credentialed base URL, and a throw here
 * would turn a misconfigured variable into a 500 on every mutating route rather than into one
 * fewer accepted origin.
 */
function deployedOrigin(): string | null {
  try {
    return configuredOrigin(process.env.APP_BASE_URL ?? "");
  } catch {
    return null;
  }
}

/**
 * Mutating account-security routes are same-origin so a foreign form cannot end a session.
 *
 * Two accepted values, not a looser comparison: the request's own origin, and the origin the
 * deployment is configured to be. The second exists because `new URL(request.url).origin` is the
 * host as the runtime reconstructs it, and behind a proxy that can be an internal host no browser
 * will ever send. `APP_BASE_URL` is already the authority for this -- `recoveryCallbackUrl` builds
 * the emailed recovery link from it -- so accepting it names trust the app already places rather
 * than adding any.
 *
 * The asymmetry is why it is worth the line. If `request.url` carries the public host this arm
 * never fires and costs nothing; if it carries an internal one, without this arm every reader is
 * refused on a page reached from an email, and the refusal is indistinguishable from an expired
 * link, so nobody would diagnose it as an origin problem. A foreign origin still refuses either
 * way, which is the whole point of the check.
 */
export function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  return origin === new URL(request.url).origin || origin === deployedOrigin();
}

export function sessionId(value: unknown) {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

/** A reason is deliberately mandatory for ending a chosen session: it distinguishes accidental from suspicious-device revocations in the audit trail. */
export function sessionRevocationReason(value: unknown) {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  return reason && reason.length <= MAX_REASON_LENGTH ? reason : null;
}

export function passwordChange(value: unknown): PasswordChange | null {
  const body = object(value);
  const currentPassword = body?.currentPassword;
  const password = body?.password;
  if (
    typeof currentPassword !== "string" || !currentPassword || currentPassword.length > MAX_PASSWORD_LENGTH
    || typeof password !== "string" || password.length < MIN_ACCOUNT_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH
    || password === currentPassword
  ) return null;
  return { currentPassword, password };
}

function text(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

/** Reject malformed RPC output rather than returning a provider-shaped security record to the browser. */
export function accountSecuritySessions(value: unknown): AccountSecuritySession[] | null {
  if (!Array.isArray(value)) return null;
  const sessions: AccountSecuritySession[] = [];
  for (const candidate of value) {
    const row = object(candidate);
    const id = sessionId(row?.id);
    const startedAt = text(row?.started_at);
    if (!id || !startedAt || typeof row?.is_current !== "boolean") return null;
    const lastSeenAt = row.last_seen_at === null ? null : text(row.last_seen_at);
    const ipAddress = row.ip_address === null ? null : text(row.ip_address);
    const userAgent = row.user_agent === null ? null : text(row.user_agent);
    if ((row.last_seen_at !== null && !lastSeenAt) || (row.ip_address !== null && !ipAddress) || (row.user_agent !== null && !userAgent)) return null;
    sessions.push({ id, startedAt, lastSeenAt, ipAddress, userAgent, isCurrent: row.is_current });
  }
  return sessions;
}
