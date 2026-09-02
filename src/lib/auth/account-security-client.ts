import { fetchWithTimeout } from "@/lib/fetch-with-timeout";

export type AccountSecuritySessionView = {
  id: string;
  startedAt: string;
  lastSeenAt: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  isCurrent: boolean;
};

export type AccountSecurityReceipt = {
  id: number;
  action: string;
};

export type AccountSecurityClientResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; status: number | null; retryAfter: number | null };

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function receipt(value: unknown, action: string): AccountSecurityReceipt | null {
  const row = object(value);
  return typeof row?.id === "number" && Number.isSafeInteger(row.id) && row.action === action
    ? { id: row.id, action }
    : null;
}

function failureMessage(value: unknown, fallback: string) {
  const message = object(value)?.error;
  return typeof message === "string" && message.trim() ? message : fallback;
}

async function request<T>(
  path: string,
  init: RequestInit,
  parse: (value: unknown) => T | null,
  fallback: string,
): Promise<AccountSecurityClientResult<T>> {
  try {
    const response = await fetchWithTimeout(path, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : null),
        ...init.headers,
      },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const retryHeader = response.headers.get("retry-after");
      const retryAfter = retryHeader && /^\d+$/.test(retryHeader) ? Number(retryHeader) : null;
      return {
        ok: false,
        message: failureMessage(body, fallback),
        status: response.status,
        retryAfter,
      };
    }
    const parsed = parse(body);
    return parsed
      ? { ok: true, value: parsed }
      : { ok: false, message: fallback, status: response.status, retryAfter: null };
  } catch {
    return { ok: false, message: fallback, status: null, retryAfter: null };
  }
}

function parseSession(value: unknown): AccountSecuritySessionView | null {
  const row = object(value);
  if (
    typeof row?.id !== "string"
    || typeof row.startedAt !== "string"
    || typeof row.isCurrent !== "boolean"
  ) return null;
  const nullableText = (candidate: unknown) => candidate === null || typeof candidate === "string";
  if (!nullableText(row.lastSeenAt) || !nullableText(row.ipAddress) || !nullableText(row.userAgent)) {
    return null;
  }
  return {
    id: row.id,
    startedAt: row.startedAt,
    lastSeenAt: row.lastSeenAt as string | null,
    ipAddress: row.ipAddress as string | null,
    userAgent: row.userAgent as string | null,
    isCurrent: row.isCurrent,
  };
}

export function loadAccountSecuritySessions() {
  return request(
    "/api/account/security/sessions",
    { method: "GET", cache: "no-store" },
    (value) => {
      const body = object(value);
      if (!Array.isArray(body?.sessions)) return null;
      const sessions = body.sessions.map(parseSession);
      const audit = receipt(body.audit, "auth.sessions.viewed");
      return sessions.every((session): session is AccountSecuritySessionView => session !== null) && audit
        ? { sessions, audit }
        : null;
    },
    "Active sessions could not be loaded. Nothing on the account was changed.",
  );
}

export function changeAccountPassword(input: { currentPassword: string; password: string }) {
  return request(
    "/api/account/security/password",
    { method: "POST", body: JSON.stringify(input) },
    (value) => {
      const body = object(value);
      const audit = receipt(body?.audit, "auth.password.changed");
      return typeof body?.message === "string" && audit ? { message: body.message, audit } : null;
    },
    "The password could not be changed. Your existing password is still active.",
  );
}

export function revokeAccountSecuritySession(sessionId: string, reason: string) {
  return request(
    `/api/account/security/sessions/${encodeURIComponent(sessionId)}`,
    { method: "DELETE", body: JSON.stringify({ reason }) },
    (value) => {
      const body = object(value);
      const audit = receipt(body?.audit, "auth.session.revoked");
      return body?.revokedSessionId === sessionId && audit ? { revokedSessionId: sessionId, audit } : null;
    },
    "The session could not be revoked. Its saved state has not been changed on this screen.",
  );
}

export function revokeOtherAccountSecuritySessions(reason: string) {
  return request(
    "/api/account/security/sessions/others",
    { method: "DELETE", body: JSON.stringify({ reason }) },
    (value) => {
      const body = object(value);
      const audit = receipt(body?.audit, "auth.sessions.others_revoked");
      return typeof body?.revokedCount === "number" && Number.isSafeInteger(body.revokedCount) && audit
        ? { revokedCount: body.revokedCount, audit }
        : null;
    },
    "Other sessions could not be revoked. Their saved state has not been changed on this screen.",
  );
}

const EMAIL_VERIFICATION_ACCEPTED =
  "If an eligible account matches that email address, we have sent instructions.";

export function requestAccountEmailVerification(email: string) {
  return request(
    "/api/auth/resend-verification",
    {
      method: "POST",
      body: JSON.stringify({ email, next: "/account/security" }),
    },
    (value) => {
      const message = object(value)?.message;
      return message === EMAIL_VERIFICATION_ACCEPTED ? { message } : null;
    },
    "Verification instructions could not be requested. The sign-in email is unchanged.",
  );
}

/**
 * Starting a change is the only step a signed-in browser takes. The address moves when the new
 * mailbox opens its confirmation link, which is where Supabase Auth and the account record are
 * written together, so nothing here may claim the address has changed.
 */
export function requestAccountEmailChange(input: {
  newEmail: string;
  currentPassword: string;
  mfaCode: string | null;
}) {
  return request(
    "/api/account/security/email",
    { method: "POST", body: JSON.stringify(input) },
    (value) => {
      const body = object(value);
      const audit = receipt(body?.audit, "auth.email_change.requested");
      return body?.status === "pending" && typeof body.expiresAt === "string" && audit
        ? { expiresAt: body.expiresAt, audit }
        : null;
    },
    "The email address could not be changed. Your current sign-in address is unchanged.",
  );
}

export type AccountMfaStatus = "none" | "pending" | "active";

export function loadAccountMfaStatus() {
  return request(
    "/api/account/security/mfa",
    { method: "GET", cache: "no-store" },
    (value) => {
      const status = object(value)?.status;
      return status === "none" || status === "pending" || status === "active"
        ? { status: status as AccountMfaStatus }
        : null;
    },
    "Authenticator status could not be loaded. No security setting was changed.",
  );
}

export function beginAccountMfaEnrollment() {
  return request(
    "/api/account/security/mfa",
    { method: "POST" },
    (value) => {
      const body = object(value);
      const audit = receipt(body?.audit, "auth.mfa.enrolled");
      return body?.status === "pending" && typeof body.secret === "string" && body.secret && audit
        ? { status: "pending" as const, secret: body.secret, audit }
        : null;
    },
    "Authenticator setup could not be started. No factor was activated.",
  );
}

export function verifyAccountMfa(code: string) {
  return request(
    "/api/account/security/mfa/verify",
    { method: "POST", body: JSON.stringify({ code }) },
    (value) => {
      const body = object(value);
      const audit = receipt(body?.audit, "auth.mfa.activated");
      return body?.status === "active" && audit ? { status: "active" as const, audit } : null;
    },
    "The authenticator code was not accepted. The factor was not activated.",
  );
}

export function disableAccountMfa(code: string) {
  return request(
    "/api/account/security/mfa",
    { method: "DELETE", body: JSON.stringify({ code }) },
    (value) => {
      const body = object(value);
      const audit = receipt(body?.audit, "auth.mfa.disabled");
      return body?.status === "none" && audit ? { status: "none" as const, audit } : null;
    },
    "Extra verification could not be removed. The active factor is unchanged.",
  );
}
