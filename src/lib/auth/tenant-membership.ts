import { createHash, randomBytes } from "node:crypto";

export const TENANT_MEMBER_ROLE = "coach_member" as const;
export const TENANT_MEMBERSHIP_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class TenantMembershipInvitationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TenantMembershipInvitationError";
  }
}

type RandomBytes = (size: number) => Buffer;

function requiredText(value: string, code: string) {
  const trimmed = value.trim();
  if (!trimmed) throw new TenantMembershipInvitationError(code);
  return trimmed;
}

/** The database stores only this digest, never a redeemable invitation secret. */
export function tenantMembershipInvitationTokenHash(token: string) {
  return createHash("sha256").update(requiredText(token, "TENANT_MEMBERSHIP_TOKEN_REQUIRED")).digest("hex");
}

export function normalizeTenantMemberEmail(email: string) {
  const normalized = requiredText(email, "TENANT_MEMBERSHIP_EMAIL_REQUIRED").toLowerCase();
  // The identity provider remains the final email validator. This merely rejects values that
  // cannot possibly identify an email recipient before an auditable invitation is created.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 320) {
    throw new TenantMembershipInvitationError("TENANT_MEMBERSHIP_EMAIL_INVALID");
  }
  return normalized;
}

export function issueTenantMembershipInvitation(
  email: string,
  {
    now = Date.now,
    generateRandomBytes = randomBytes,
  }: { now?: () => number; generateRandomBytes?: RandomBytes } = {},
) {
  const token = generateRandomBytes(32).toString("base64url");
  if (!token) throw new TenantMembershipInvitationError("TENANT_MEMBERSHIP_RANDOMNESS_INVALID");
  return {
    email: normalizeTenantMemberEmail(email),
    role: TENANT_MEMBER_ROLE,
    token,
    tokenHash: tenantMembershipInvitationTokenHash(token),
    expiresAt: new Date(now() + TENANT_MEMBERSHIP_INVITATION_TTL_MS).toISOString(),
  };
}
