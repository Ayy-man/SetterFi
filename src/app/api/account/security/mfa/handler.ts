import { createHash } from "node:crypto";

import { authMode } from "@/lib/auth/mode";
import { generateTotpSecret, mfaCode, verifyTotpCode } from "@/lib/auth/mfa";
import { ACCOUNT_SECURITY_NO_STORE, sameOrigin, type AccountSecurityActor } from "@/lib/auth/account-security";
import { accountMfaLive } from "@/lib/env-contract";
import { sharedRateLimit } from "@/lib/shared-rate-limit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

import { loadAccountSecurityContext, throttled } from "../shared";

type MfaStatus = "none" | "pending" | "active";
type AuditReceipt = { auditId: number };

type Dependencies = {
  enabled(): boolean;
  context(): Promise<{
    actor: AccountSecurityActor;
    status(): Promise<MfaStatus>;
    enroll(secret: string): Promise<{ status: "pending"; auditId: number }>;
    disable(code: string): Promise<AuditReceipt | null>;
  } | null>;
  throttle(request: Request, actor: AccountSecurityActor): Promise<{ allowed: boolean; retryAfter: number }>;
  issueSecret(): string;
};

function record(value: unknown) {
  const row = Array.isArray(value) ? value[0] : value;
  return row && typeof row === "object" ? row as Record<string, unknown> : null;
}

function auditId(value: unknown): number | null {
  const id = record(value)?.audit_id;
  return typeof id === "number" && Number.isSafeInteger(id) ? id : null;
}

function mfaStatus(value: unknown): MfaStatus | null {
  const status = record(value)?.status;
  return status === "none" || status === "pending" || status === "active" ? status : null;
}

async function verifyThrottle(_request: Request, actor: AccountSecurityActor) {
  const service = createSupabaseServiceClient();
  const account = createHash("sha256").update(actor.userId).digest("hex");
  return sharedRateLimit(`auth-account-mfa:verification:account:${account}`, {
    limit: 5, windowMs: 15 * 60_000,
  }, { client: { rpc: async (name, arguments_) => service.rpc(name, arguments_) } });
}

async function failedVerification(actor: AccountSecurityActor) {
  const { data, error } = await createSupabaseServiceClient().rpc("record_account_mfa_failed_verification", {
    p_expected_user: actor.userId, p_expected_tenant: actor.tenantId,
  });
  if (error || !auditId(data)) throw new Error("ACCOUNT_MFA_FAILURE_AUDIT_FAILED");
}

async function verificationFactor(actor: AccountSecurityActor) {
  const { data, error } = await createSupabaseServiceClient().rpc("get_account_mfa_factor_for_verification", {
    p_expected_user: actor.userId, p_expected_tenant: actor.tenantId,
  });
  const row = record(data);
  if (error || !row || (row.status !== "pending" && row.status !== "active") || typeof row.secret !== "string") {
    throw new Error("ACCOUNT_MFA_FACTOR_UNAVAILABLE");
  }
  return { status: row.status, secret: row.secret } as const;
}

async function consume(actor: AccountSecurityActor, code: string, purpose: "activate" | "disable") {
  const factor = await verificationFactor(actor);
  const allowedState = purpose === "activate" ? "pending" : "active";
  if (factor.status !== allowedState) return null;
  const counter = verifyTotpCode(factor.secret, code);
  if (counter === null) {
    await failedVerification(actor);
    return null;
  }
  const { data, error } = await createSupabaseServiceClient().rpc("consume_account_mfa_totp", {
    p_expected_user: actor.userId, p_expected_tenant: actor.tenantId, p_counter: counter, p_purpose: purpose,
  });
  const id = error ? null : auditId(data);
  if (id !== null) return { auditId: id };
  await failedVerification(actor);
  return null;
}

export function createAccountMfaHandler(dependencies: Dependencies) {
  return {
    async GET() {
      if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: ACCOUNT_SECURITY_NO_STORE });
      const security = await dependencies.context();
      if (!security) return Response.json({ error: "Authentication required." }, { status: 401, headers: ACCOUNT_SECURITY_NO_STORE });
      try {
        // A status is deliberately the entire read model: the stored secret has no read route.
        return Response.json({ status: await security.status() }, { headers: ACCOUNT_SECURITY_NO_STORE });
      } catch (cause) {
        console.error(
          "/api/account/security/mfa failed.",
          cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
        );
        return Response.json({ error: "Second-factor status could not be loaded." }, { status: 503, headers: ACCOUNT_SECURITY_NO_STORE });
      }
    },
    async POST(request: Request) {
      if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: ACCOUNT_SECURITY_NO_STORE });
      if (!sameOrigin(request)) return Response.json({ error: "Request origin was refused." }, { status: 403, headers: ACCOUNT_SECURITY_NO_STORE });
      const security = await dependencies.context();
      if (!security) return Response.json({ error: "Authentication required." }, { status: 401, headers: ACCOUNT_SECURITY_NO_STORE });
      try {
        const secret = dependencies.issueSecret();
        const result = await security.enroll(secret);
        // This is the one and only response that contains the secret; activation remains pending.
        return Response.json({ status: result.status, secret, audit: { id: result.auditId, action: "auth.mfa.enrolled" } }, { headers: ACCOUNT_SECURITY_NO_STORE });
      } catch {
        return Response.json({ error: "Second-factor enrollment could not be started." }, { status: 409, headers: ACCOUNT_SECURITY_NO_STORE });
      }
    },
    async DELETE(request: Request) {
      if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: ACCOUNT_SECURITY_NO_STORE });
      if (!sameOrigin(request)) return Response.json({ error: "Request origin was refused." }, { status: 403, headers: ACCOUNT_SECURITY_NO_STORE });
      const security = await dependencies.context();
      if (!security) return Response.json({ error: "Authentication required." }, { status: 401, headers: ACCOUNT_SECURITY_NO_STORE });
      const limit = await dependencies.throttle(request, security.actor);
      if (!limit.allowed) return throttled(limit.retryAfter);
      let code: string | null = null;
      try { code = mfaCode((await request.json() as Record<string, unknown>).code); } catch { code = null; }
      if (!code) return Response.json({ error: "A six-digit authenticator code is required." }, { status: 400, headers: ACCOUNT_SECURITY_NO_STORE });
      try {
        const result = await security.disable(code);
        if (!result) return Response.json({ error: "The authenticator code was refused." }, { status: 400, headers: ACCOUNT_SECURITY_NO_STORE });
        return Response.json({ status: "none", audit: { id: result.auditId, action: "auth.mfa.disabled" } }, { headers: ACCOUNT_SECURITY_NO_STORE });
      } catch {
        return Response.json({ error: "Second-factor removal could not be completed." }, { status: 409, headers: ACCOUNT_SECURITY_NO_STORE });
      }
    },
  };
}

const handler = createAccountMfaHandler({
  enabled: () => authMode() === "supabase" && accountMfaLive(),
  context: async () => {
    const context = await loadAccountSecurityContext();
    if (!context) return null;
    return {
      actor: context.actor,
      status: async () => {
        const { data, error } = await createSupabaseServiceClient().rpc("get_account_mfa_status", {
          p_expected_user: context.actor.userId, p_expected_tenant: context.actor.tenantId,
        });
        const status = error ? null : mfaStatus(data);
        if (!status) throw new Error("ACCOUNT_MFA_STATUS_INVALID");
        return status;
      },
      enroll: async (secret) => {
        const { data, error } = await createSupabaseServiceClient().rpc("enroll_account_mfa", {
          p_expected_user: context.actor.userId, p_expected_tenant: context.actor.tenantId, p_secret: secret,
        });
        const status = error ? null : mfaStatus(data);
        const id = error ? null : auditId(data);
        if (status !== "pending" || id === null) throw new Error("ACCOUNT_MFA_ENROLL_FAILED");
        return { status, auditId: id };
      },
      disable: (code) => consume(context.actor, code, "disable"),
    };
  },
  throttle: verifyThrottle,
  issueSecret: generateTotpSecret,
});

export const GET = handler.GET;
export const POST = handler.POST;
export const DELETE = handler.DELETE;
