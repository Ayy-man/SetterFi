import { authMode } from "@/lib/auth/mode";
import { ACCOUNT_SECURITY_NO_STORE, passwordChange, sameOrigin, type AccountSecurityActor } from "@/lib/auth/account-security";
import { accountSecurityLive } from "@/lib/env-contract";
import { createClient } from "@supabase/supabase-js";

import { loadAccountSecurityContext, throttleAccountSecurity, throttled } from "../shared";

type Dependencies = {
  enabled(): boolean;
  context(): Promise<{ actor: AccountSecurityActor; verifyCurrentPassword(password: string): Promise<boolean>; endOtherSessions(): Promise<number>; update(input: { currentPassword: string; password: string }): Promise<boolean>; audit(): Promise<{ auditId: number }> } | null>;
  throttle(request: Request, actor: AccountSecurityActor): Promise<{ allowed: boolean; retryAfter: number }>;
};

export function createAccountSecurityPasswordHandler(dependencies: Dependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: ACCOUNT_SECURITY_NO_STORE });
    if (!sameOrigin(request)) return Response.json({ error: "Request origin was refused." }, { status: 403, headers: ACCOUNT_SECURITY_NO_STORE });
    const security = await dependencies.context();
    if (!security) return Response.json({ error: "Authentication required." }, { status: 401, headers: ACCOUNT_SECURITY_NO_STORE });
    const limit = await dependencies.throttle(request, security.actor);
    if (!limit.allowed) return throttled(limit.retryAfter);
    let change = null;
    try { change = passwordChange(await request.json()); } catch { change = null; }
    if (!change) return Response.json({ error: "Current and new passwords are required." }, { status: 400, headers: ACCOUNT_SECURITY_NO_STORE });
    try {
      if (!await security.verifyCurrentPassword(change.currentPassword)) {
        return Response.json({ error: "The password could not be changed." }, { status: 400, headers: ACCOUNT_SECURITY_NO_STORE });
      }
      /*
       * The other sessions are ended here, before the password changes, and by our own delete
       * rather than by trusting the provider.
       *
       * This route has always answered "Other sessions have been ended", and
       * `record_account_security_password_change` writes `'other_sessions': 'ended'` into the audit
       * row -- but nothing on this path ended one. `updateUser` requests a password change and
       * nothing else, and Supabase documents session termination on password change as conditional,
       * "depending on configuration" (https://supabase.com/docs/guides/auth/sessions, checked
       * 2026-09-01), never saying whether it means one session or all of them. So the sentence and
       * the audit record were both claims nothing in the code backed.
       *
       * BEFORE the update rather than after, which is the ordering that keeps the audit row honest.
       * The row's `'other_sessions': 'ended'` is written by the audit RPC unconditionally, so it
       * must only be reachable once the sessions are actually gone: revoke first and a failure
       * returns before the password changes and before any row is written. Revoking afterwards
       * would mean a failed revoke leaves a changed password and an audit row asserting something
       * false, which is the worse of the two, and the one this fix exists to remove.
       *
       * `revoke_other_account_security_sessions` keeps the session in the caller's JWT and returns
       * a real `revoked_count` from `row_count`, so the number below is counted rather than
       * assumed. `signOut({ scope: "others" })` was the alternative and is not usable as evidence:
       * `auth-js`'s `_signOut` swallows 401, 403 and 404 and resolves with `error: null`, so a
       * green result there would not tell us anything happened.
       */
      const revokedCount = await security.endOtherSessions();
      if (!await security.update(change)) return Response.json({ error: "The password could not be changed." }, { status: 400, headers: ACCOUNT_SECURITY_NO_STORE });
      const audit = await security.audit();
      return Response.json({ message: revokedCount === 1 ? "Password changed. 1 other session has been ended." : `Password changed. ${revokedCount} other sessions have been ended.`, revokedCount, audit: { id: audit.auditId, action: "auth.password.changed" } }, { headers: ACCOUNT_SECURITY_NO_STORE });
    } catch (cause) {
      console.error(
        "/api/account/security/password failed.",
        cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
      );
      return Response.json({ error: "The password could not be changed." }, { status: 503, headers: ACCOUNT_SECURITY_NO_STORE });
    }
  };
}

type AccountSecurityContext = NonNullable<Awaited<ReturnType<typeof loadAccountSecurityContext>>>;

/** The password verifier: a throwaway client that proves a password by spending it, then hangs up. */
type PasswordVerifier = {
  auth: {
    signInWithPassword(credentials: { email: string; password: string }): Promise<{
      data: { user: { id: string } | null };
      error: unknown;
    }>;
    signOut(options: { scope: "local" }): Promise<unknown>;
  };
};

function anonymousVerifier(): PasswordVerifier {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * The four operations the route actually runs, lifted out of the `POST` wiring so they can be
 * exercised.
 *
 * They used to be closures inside the `context()` passed to `createAccountSecurityPasswordHandler`,
 * which put them beyond the reach of the suite that appears to cover this route: every test in
 * `routes.test.ts` supplies its own `context`, so the stub and the assertion agreed on an error
 * string while the code that raises it ran nowhere. Two of these carry real rules -- the identity
 * check below, which is what stops a valid password for the wrong account passing, and the
 * PostgREST shape check in `endOtherSessions`, which is what stops a failed revoke reading as a
 * successful one. Injecting the verifier is what lets a test drive both without a live GoTrue.
 */
export function accountSecurityPasswordOperations(
  context: AccountSecurityContext,
  createVerifier: () => PasswordVerifier = anonymousVerifier,
) {
  return {
      actor: context.actor,
      verifyCurrentPassword: async (currentPassword: string) => {
        // GoTrue's current-password check is configurable per project. Verify it here as well so
        // this route keeps its own contract even before that provider setting is switched on.
        const verifier = createVerifier();
        const { data, error } = await verifier.auth.signInWithPassword({ email: context.actor.email, password: currentPassword });
        if (error || data.user?.id !== context.actor.userId) return false;
        // This temporary proof session is terminated locally before anything else runs, so it is
        // not one of the sessions the revoke below counts.
        await verifier.auth.signOut({ scope: "local" });
        return true;
      },
      endOtherSessions: async () => {
        const { data, error } = await context.client.rpc("revoke_other_account_security_sessions", {
          p_expected_user: context.actor.userId, p_expected_tenant: context.actor.tenantId, p_reason: "Password changed",
        });
        const row = Array.isArray(data) ? data[0] : data;
        // A PostgREST failure resolves with `{ error }` rather than throwing, so the error and the
        // shape are both checked; a catch alone would read a failed revoke as a successful one.
        if (error || !row || typeof row !== "object" || !Number.isSafeInteger((row as { revoked_count?: unknown }).revoked_count)) throw new Error("ACCOUNT_SECURITY_PASSWORD_OTHERS_REVOKE_FAILED");
        return (row as { revoked_count: number }).revoked_count;
      },
      update: async ({ currentPassword, password }: { currentPassword: string; password: string }) => {
        const { error } = await context.client.auth.updateUser({ password, current_password: currentPassword });
        return !error;
      },
      audit: async () => {
        const { data, error } = await context.client.rpc("record_account_security_password_change", {
          p_expected_user: context.actor.userId, p_expected_tenant: context.actor.tenantId,
        });
        const row = Array.isArray(data) ? data[0] : data;
        if (error || !row || typeof row !== "object" || !Number.isSafeInteger((row as { audit_id?: unknown }).audit_id)) throw new Error("ACCOUNT_SECURITY_PASSWORD_AUDIT_FAILED");
        return { auditId: (row as { audit_id: number }).audit_id };
      },
  };
}

export const POST = createAccountSecurityPasswordHandler({
  enabled: () => authMode() === "supabase" && accountSecurityLive(),
  context: async () => {
    const context = await loadAccountSecurityContext();
    if (!context) return null;
    return accountSecurityPasswordOperations(context);
  },
  throttle: (request, actor) => throttleAccountSecurity(request, actor, "password-change"),
});
