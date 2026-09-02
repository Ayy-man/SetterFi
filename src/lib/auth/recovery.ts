import { createHash } from "node:crypto";

import { internalRedirectPath } from "@/lib/auth/internal-redirect";

export const AUTH_REQUEST_ACCEPTED = {
  message: "If an eligible account matches that email address, we have sent instructions.",
};

const MAX_EMAIL_LENGTH = 320;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

export type RecoveryRequest = {
  email: string | null;
  next: string;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Normalizes only values that are safe to send to Supabase. Invalid input still gets the generic reply. */
export function recoveryEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH || CONTROL_CHARACTERS.test(email)) return null;
  return email;
}

/** Parses public request bodies without allowing caller data to choose a redirect origin. */
export function recoveryRequest(value: unknown): RecoveryRequest {
  const body = object(value);
  const next = internalRedirectPath(typeof body?.next === "string" ? body.next : undefined, "/login");
  return {
    email: recoveryEmail(body?.email),
    next,
  };
}

/** The throttling store never receives an email address in plaintext. */
export function recoveryEmailKey(email: string | null) {
  return createHash("sha256").update(email ?? "invalid").digest("hex");
}

/**
 * The deployment's own public origin, and the only thing allowed to name it.
 *
 * Exported because `sameOrigin` needs the same answer this flow already trusts: the emailed
 * recovery link is built from `APP_BASE_URL` through here, so a post arriving back from that page
 * must not be refused for disagreeing with a runtime host. Refusing it would be the app disowning
 * the link it sent. The https-and-no-credentials strictness travels with the function rather than
 * being re-derived by each caller.
 */
export function configuredOrigin(appBaseUrl: string) {
  const parsed = new URL(appBaseUrl);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("AUTH_RECOVERY_APP_BASE_URL_INVALID");
  }
  return parsed.origin;
}

/**
 * Builds the Supabase mail callback from deployment configuration, never from the request Host
 * header. The only caller-controlled component is first passed through the canonical validator.
 */
export function recoveryCallbackUrl(
  appBaseUrl: string,
  path: "/auth/recovery" | "/auth/confirm",
  next: string | null | undefined,
) {
  const url = new URL(path, configuredOrigin(appBaseUrl));
  const destination = internalRedirectPath(next, "/login");
  url.searchParams.set("next", destination);
  return url.toString();
}

/**
 * Every way the reset can end, one code per fact the reader has to act on differently.
 *
 * `reset-failed` used to carry three of these at once -- a rejected password, a failed sign-out and
 * a failed audit write -- and two of the three happen *after* the new password is live, so the page
 * told people the reset had not happened when it had. The sentence set has to be as wide as the
 * failure set.
 */
export type ResetPasswordOutcome =
  | "invalid-link"
  | "password-rejected"
  | "reset-failed"
  | "sessions-live"
  | "not-recorded";

/** Set by the complete route on success and required by the page before it says so. */
export const PASSWORD_RESET_DONE_COOKIE = "sf_password_reset_done";

export function resetPasswordPath(
  next: string | null | undefined,
  options: { error?: ResetPasswordOutcome; success?: boolean } = {},
) {
  const url = new URL(internalRedirectPath("/auth/reset-password", "/login"), "https://setterfi.internal");
  url.searchParams.set("next", internalRedirectPath(next, "/login"));
  if (options.error) url.searchParams.set("error", options.error);
  if (options.success) url.searchParams.set("success", "1");
  return `${url.pathname}${url.search}`;
}

export function authRequestRateLimitKeys(
  operation: "password-reset" | "email-verification",
  caller: string,
  email: string | null,
) {
  const namespace = `auth-recovery:${operation}`;
  return {
    caller: `${namespace}:caller:${caller}`,
    email: `${namespace}:email:${recoveryEmailKey(email)}`,
  };
}
