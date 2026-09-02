import { createHash } from "node:crypto";

import { authMode } from "@/lib/auth/mode";
import { ACCOUNT_SECURITY_CALLER_LIMIT, ACCOUNT_SECURITY_LIMIT, sameOrigin, type AccountSecurityActor } from "@/lib/auth/account-security";
import { accountEmailChangeLink, accountEmailChangeRequest, ACCOUNT_EMAIL_CHANGE_NO_STORE, hashAccountEmailChangeToken, issueAccountEmailChangeToken } from "@/lib/auth/email-change";
import { mfaCode, verifyTotpCode } from "@/lib/auth/mfa";
import { accountEmailChangeLive } from "@/lib/env-contract";
import { createMockEmailDriver } from "@/lib/integrations/email/mock";
import { createRealEmailDriver } from "@/lib/integrations/email/real";
import { resolveEmailDriver } from "@/lib/integrations/email/selector";
import { callerKey } from "@/lib/rate-limit";
import { sharedRateLimit } from "@/lib/shared-rate-limit";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";
import { createClient } from "@supabase/supabase-js";

import { loadAccountSecurityContext, throttled } from "../shared";

type StartResult = { requestId: string; expiresAt: string; auditId: number };
type MfaFactor = { state: "none" | "pending" | "active"; secret: string | null };

type Dependencies = {
  enabled(): boolean;
  context(): Promise<{
    actor: AccountSecurityActor;
    verifyCurrentPassword(password: string): Promise<boolean>;
    factor(): Promise<MfaFactor>;
    recordFailedMfaVerification(): Promise<void>;
    start(input: { newEmail: string; confirmationTokenHash: string; refusalTokenHash: string; mfaCounter: number | null }): Promise<StartResult>;
  } | null>;
  throttle(request: Request, actor: AccountSecurityActor): Promise<{ allowed: boolean; retryAfter: number }>;
  issueToken(): string;
  send(input: { requestId: string; currentEmail: string; newEmail: string; confirmationToken: string; refusalToken: string }): Promise<boolean>;
};

function genericRefusal(status = 400) {
  return Response.json({ error: "The email address could not be changed." }, { status, headers: ACCOUNT_EMAIL_CHANGE_NO_STORE });
}

async function verifyMfa(security: NonNullable<Awaited<ReturnType<Dependencies["context"]>>>, suppliedCode: string | null) {
  const factor = await security.factor();
  if (factor.state !== "active") return null;
  const code = mfaCode(suppliedCode);
  const counter = code && factor.secret ? verifyTotpCode(factor.secret, code) : null;
  if (counter !== null) return counter;
  await security.recordFailedMfaVerification();
  throw new Error("ACCOUNT_EMAIL_CHANGE_MFA_REFUSED");
}

export function createAccountEmailChangeHandler(dependencies: Dependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: ACCOUNT_EMAIL_CHANGE_NO_STORE });
    if (!sameOrigin(request)) return Response.json({ error: "Request origin was refused." }, { status: 403, headers: ACCOUNT_EMAIL_CHANGE_NO_STORE });
    const security = await dependencies.context();
    if (!security) return Response.json({ error: "Authentication required." }, { status: 401, headers: ACCOUNT_EMAIL_CHANGE_NO_STORE });
    const limit = await dependencies.throttle(request, security.actor);
    if (!limit.allowed) return throttled(limit.retryAfter);
    let change = null;
    try { change = accountEmailChangeRequest(await request.json()); } catch { change = null; }
    if (!change) return genericRefusal();

    try {
      if (!await security.verifyCurrentPassword(change.currentPassword)) return genericRefusal();
      const mfaCounter = await verifyMfa(security, change.mfaCode);
      const confirmationToken = dependencies.issueToken();
      const refusalToken = dependencies.issueToken();
      const confirmationTokenHash = hashAccountEmailChangeToken(confirmationToken);
      const refusalTokenHash = hashAccountEmailChangeToken(refusalToken);
      if (!confirmationTokenHash || !refusalTokenHash || confirmationToken === refusalToken) throw new Error("ACCOUNT_EMAIL_CHANGE_TOKEN_INVALID");
      const started = await security.start({ newEmail: change.newEmail, confirmationTokenHash, refusalTokenHash, mfaCounter });
      // API acceptance is the furthest honest state here. Delivery needs the signed Resend receipt
      // pipeline and the application address remains pending until the new mailbox uses its link.
      if (!await dependencies.send({
        requestId: started.requestId, currentEmail: security.actor.email, newEmail: change.newEmail,
        confirmationToken, refusalToken,
      })) {
        return Response.json({ error: "The email change is pending but its confirmation messages could not be accepted." }, { status: 503, headers: ACCOUNT_EMAIL_CHANGE_NO_STORE });
      }
      return Response.json({
        status: "pending", expiresAt: started.expiresAt,
        audit: { id: started.auditId, action: "auth.email_change.requested" },
      }, { status: 202, headers: ACCOUNT_EMAIL_CHANGE_NO_STORE });
    } catch (cause) {
      // Password, second-factor, address-taken, and replay refusals deliberately collapse to one
      // answer. Operational failures retain 503 so a caller does not mistake a queued request for
      // a usable confirmation email.
      if (cause instanceof Error && cause.message.includes("REFUSED")) return genericRefusal();
      return genericRefusal(503);
    }
  };
}

async function emailChangeThrottle(request: Request, actor: AccountSecurityActor) {
  const service = createSupabaseServiceClient();
  const account = createHash("sha256").update(actor.userId).digest("hex");
  const namespace = "auth-account-security:email-change";
  const consume = (key: string, limit: typeof ACCOUNT_SECURITY_LIMIT) => sharedRateLimit(key, limit, {
    client: { rpc: async (name, arguments_) => service.rpc(name, arguments_) },
  });
  const caller = await consume(`${namespace}:caller:${callerKey(request, "auth-account-security")}`, ACCOUNT_SECURITY_CALLER_LIMIT);
  return caller.allowed ? consume(`${namespace}:account:${account}`, ACCOUNT_SECURITY_LIMIT) : caller;
}

function record(value: unknown) {
  const row = Array.isArray(value) ? value[0] : value;
  return row && typeof row === "object" ? row as Record<string, unknown> : null;
}

async function sendAccountEmailChange(input: { requestId: string; currentEmail: string; newEmail: string; confirmationToken: string; refusalToken: string }) {
  const baseUrl = process.env.APP_BASE_URL?.trim();
  if (!baseUrl) return false;
  const confirmationLink = accountEmailChangeLink(baseUrl, "confirm", input.confirmationToken);
  const refusalLink = accountEmailChangeLink(baseUrl, "refuse", input.refusalToken);
  const driver = resolveEmailDriver({ factories: { mock: createMockEmailDriver, real: createRealEmailDriver } });
  const from = process.env.SETTERFI_EMAIL_FROM?.trim() || "mock@setterfi.invalid";
  // Send the old-address warning first: a provider outage must never produce a new-mailbox link
  // while suppressing the account owner's opportunity to reject the takeover attempt.
  const oldAddress = await driver.deliverEmail({
    deliveryId: `${input.requestId}:old`, attemptNumber: 1, to: input.currentEmail, from,
    subject: "SetterFi email change requested",
    text: `An email change was requested for your SetterFi account. If this was not you, refuse it here: ${refusalLink}`,
  });
  if (oldAddress.kind !== "accepted") return false;
  const newAddress = await driver.deliverEmail({
    deliveryId: `${input.requestId}:new`, attemptNumber: 1, to: input.newEmail, from,
    subject: "Confirm your SetterFi email address",
    text: `Confirm this email address for your SetterFi account: ${confirmationLink}`,
  });
  return newAddress.kind === "accepted";
}

export const POST = createAccountEmailChangeHandler({
  enabled: () => authMode() === "supabase" && accountEmailChangeLive(),
  context: async () => {
    const context = await loadAccountSecurityContext();
    if (!context) return null;
    return {
      actor: context.actor,
      verifyCurrentPassword: async (currentPassword) => {
        const verifier = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const { data, error } = await verifier.auth.signInWithPassword({ email: context.actor.email, password: currentPassword });
        if (error || data.user?.id !== context.actor.userId) return false;
        await verifier.auth.signOut({ scope: "local" });
        return true;
      },
      factor: async () => {
        const { data, error } = await createSupabaseServiceClient().rpc("get_account_mfa_factor_for_verification", {
          p_expected_user: context.actor.userId, p_expected_tenant: context.actor.tenantId,
        });
        const row = error ? null : record(data);
        if (!row) return { state: "none", secret: null } as const;
        if (row.status === "pending") return { state: "pending", secret: null } as const;
        if (row.status === "active" && typeof row.secret === "string") return { state: "active", secret: row.secret } as const;
        throw new Error("ACCOUNT_EMAIL_CHANGE_MFA_FACTOR_INVALID");
      },
      recordFailedMfaVerification: async () => {
        const { error } = await createSupabaseServiceClient().rpc("record_account_mfa_failed_verification", {
          p_expected_user: context.actor.userId, p_expected_tenant: context.actor.tenantId,
        });
        if (error) throw new Error("ACCOUNT_EMAIL_CHANGE_MFA_FAILURE_AUDIT_FAILED");
      },
      start: async ({ newEmail, confirmationTokenHash, refusalTokenHash, mfaCounter }) => {
        const { data, error } = await createSupabaseServiceClient().rpc("begin_account_email_change", {
          p_expected_user: context.actor.userId, p_expected_tenant: context.actor.tenantId,
          p_current_auth_email: context.actor.email, p_requested_email: newEmail,
          p_confirmation_token_hash: confirmationTokenHash, p_refusal_token_hash: refusalTokenHash,
          p_mfa_counter: mfaCounter,
        });
        const row = error ? null : record(data);
        const auditId = row && typeof row.audit_id === "number" && Number.isSafeInteger(row.audit_id) ? row.audit_id : null;
        if (!row || typeof row.request_id !== "string" || typeof row.expires_at !== "string" || auditId === null) {
          throw new Error("ACCOUNT_EMAIL_CHANGE_REQUEST_FAILED");
        }
        return { requestId: row.request_id, expiresAt: row.expires_at, auditId };
      },
    };
  },
  throttle: emailChangeThrottle,
  issueToken: issueAccountEmailChangeToken,
  send: sendAccountEmailChange,
});
