import { createHash } from "node:crypto";

import { authMode } from "@/lib/auth/mode";
import { mfaCode, verifyTotpCode } from "@/lib/auth/mfa";
import { ACCOUNT_SECURITY_NO_STORE, sameOrigin, type AccountSecurityActor } from "@/lib/auth/account-security";
import { accountMfaLive } from "@/lib/env-contract";
import { sharedRateLimit } from "@/lib/shared-rate-limit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

import { loadAccountSecurityContext, throttled } from "../../shared";

type Dependencies = {
  enabled(): boolean;
  context(): Promise<{ actor: AccountSecurityActor; activate(code: string): Promise<{ auditId: number } | null> } | null>;
  throttle(request: Request, actor: AccountSecurityActor): Promise<{ allowed: boolean; retryAfter: number }>;
};

function row(value: unknown) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : null;
}

function auditId(value: unknown): number | null {
  const id = row(value)?.audit_id;
  return typeof id === "number" && Number.isSafeInteger(id) ? id : null;
}

async function verificationThrottle(_request: Request, actor: AccountSecurityActor) {
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
  if (error || auditId(data) === null) throw new Error("ACCOUNT_MFA_FAILURE_AUDIT_FAILED");
}

async function activate(actor: AccountSecurityActor, code: string) {
  const service = createSupabaseServiceClient();
  const factor = await service.rpc("get_account_mfa_factor_for_verification", {
    p_expected_user: actor.userId, p_expected_tenant: actor.tenantId,
  });
  const factorRow = factor.error ? null : row(factor.data);
  if (!factorRow || factorRow.status !== "pending" || typeof factorRow.secret !== "string") return null;
  const counter = verifyTotpCode(factorRow.secret, code);
  if (counter === null) {
    await failedVerification(actor);
    return null;
  }
  const consumed = await service.rpc("consume_account_mfa_totp", {
    p_expected_user: actor.userId, p_expected_tenant: actor.tenantId, p_counter: counter, p_purpose: "activate",
  });
  const id = consumed.error ? null : auditId(consumed.data);
  if (id !== null) return { auditId: id };
  await failedVerification(actor);
  return null;
}

export function createAccountMfaVerifyHandler(dependencies: Dependencies) {
  return async function POST(request: Request) {
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
      const result = await security.activate(code);
      if (!result) return Response.json({ error: "The authenticator code was refused." }, { status: 400, headers: ACCOUNT_SECURITY_NO_STORE });
      return Response.json({ status: "active", audit: { id: result.auditId, action: "auth.mfa.activated" } }, { headers: ACCOUNT_SECURITY_NO_STORE });
    } catch {
      return Response.json({ error: "Second-factor verification could not be completed." }, { status: 409, headers: ACCOUNT_SECURITY_NO_STORE });
    }
  };
}

export const POST = createAccountMfaVerifyHandler({
  enabled: () => authMode() === "supabase" && accountMfaLive(),
  context: async () => {
    const context = await loadAccountSecurityContext();
    if (!context) return null;
    return { actor: context.actor, activate: (code) => activate(context.actor, code) };
  },
  throttle: verificationThrottle,
});
