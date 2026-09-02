import { createHash, randomBytes } from "node:crypto";

import { mfaCode } from "@/lib/auth/mfa";

export const ACCOUNT_EMAIL_CHANGE_TOKEN_BYTES = 32;
export const ACCOUNT_EMAIL_CHANGE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const ACCOUNT_EMAIL_CHANGE_MAX_EMAIL_LENGTH = 320;
export const ACCOUNT_EMAIL_CHANGE_NO_STORE = { "Cache-Control": "no-store" };

export type AccountEmailChangeRequest = {
  currentPassword: string;
  newEmail: string;
  mfaCode: string | null;
};

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

export function normalizeAccountEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > ACCOUNT_EMAIL_CHANGE_MAX_EMAIL_LENGTH) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function accountEmailChangeRequest(value: unknown): AccountEmailChangeRequest | null {
  const body = object(value);
  const currentPassword = body?.currentPassword;
  const newEmail = normalizeAccountEmail(body?.newEmail);
  const suppliedMfaCode = body?.mfaCode;
  const parsedMfaCode = mfaCode(suppliedMfaCode);
  if (typeof currentPassword !== "string" || !currentPassword || currentPassword.length > 1024 || !newEmail) return null;
  if (suppliedMfaCode !== undefined && suppliedMfaCode !== null && !parsedMfaCode) return null;
  return { currentPassword, newEmail, mfaCode: parsedMfaCode };
}

/** A browser never receives the hash persisted in Postgres; only this opaque capability appears in its email. */
export function issueAccountEmailChangeToken() {
  return randomBytes(ACCOUNT_EMAIL_CHANGE_TOKEN_BYTES).toString("base64url");
}

export function hashAccountEmailChangeToken(token: string): string | null {
  if (!ACCOUNT_EMAIL_CHANGE_TOKEN_PATTERN.test(token)) return null;
  return createHash("sha256").update(token).digest("hex");
}

export function accountEmailChangeLink(baseUrl: string, action: "confirm" | "refuse", token: string) {
  const url = new URL("/api/account/security/email/confirm", baseUrl);
  url.searchParams.set("action", action);
  url.searchParams.set("token", token);
  return url.toString();
}

export function accountEmailChangeCompletion(value: unknown) {
  const body = object(value);
  const action = body?.action;
  const token = body?.token;
  if ((action !== "confirm" && action !== "refuse") || typeof token !== "string") return null;
  const tokenHash = hashAccountEmailChangeToken(token);
  return tokenHash ? { action, tokenHash } : null;
}
