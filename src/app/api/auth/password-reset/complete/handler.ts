import { internalRedirectPath } from "@/lib/auth/internal-redirect";
import { sameOrigin } from "@/lib/auth/account-security";
import { parseAppClaims } from "@/lib/auth/claims";
import { writeAuthAuditEvent } from "@/lib/auth/recovery-audit";
import { PASSWORD_RESET_DONE_COOKIE, resetPasswordPath, type ResetPasswordOutcome } from "@/lib/auth/recovery";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };
const MIN_PASSWORD_LENGTH = 12;
const REFUSED_PASSWORD = new Set(["weak_password", "same_password", "validation_failed"]);

type ResetActor = { userId: string; tenantId: string | null };

/**
 * Why this is three-valued rather than a boolean. `updateUser` refuses a password for reasons the
 * reader can fix -- too weak, already in use here, failing a policy -- and for reasons they cannot.
 * Collapsing both into false sent the first kind to "request a new link", which is the defect this
 * flow was already fixed for once: the link is fine, the password is the thing that was refused.
 */
type PasswordUpdate = "ok" | "rejected" | "failed";

type CompletePasswordResetDependencies = {
  session(): Promise<ResetActor | null>;
  updatePassword(password: string): Promise<PasswordUpdate>;
  endOtherSessions(actor: ResetActor): Promise<boolean>;
  signOut(): Promise<boolean>;
  audit(request: Request, actor: ResetActor): Promise<void>;
};

function passwordFromForm(form: FormData) {
  const password = form.get("password");
  return typeof password === "string" ? password : "";
}

function acceptsHtml(request: Request) {
  return request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")
    || request.headers.get("content-type")?.startsWith("multipart/form-data");
}

/**
 * The success cookie, set here and required by the page.
 *
 * `success=1` in the query string routes the redirect; this decides whether the page is allowed to
 * believe it. Without it `/auth/reset-password?success=1` is a sentence anyone can make the product
 * say -- "Your password was reset. Other sessions were signed out." -- with no write behind it, in
 * the past tense, on an auth surface. Short-lived and scoped to the one path that reads it, because
 * it is a receipt for the redirect that follows rather than a session of any kind.
 */
function successCookie() {
  const secure = process.env.NODE_ENV === "production" ? " Secure;" : "";
  return `${PASSWORD_RESET_DONE_COOKIE}=1; HttpOnly;${secure} SameSite=Lax; Path=/auth/reset-password; Max-Age=120`;
}

function formRedirect(
  request: Request,
  next: string,
  options: { error?: ResetPasswordOutcome; success?: boolean; passwordChanged?: boolean },
) {
  const path = resetPasswordPath(next, options);
  const headers = new Headers({ ...NO_STORE, Location: new URL(internalRedirectPath(path, "/login"), request.url).toString() });
  // The receipt goes with every state that reports on a password already changed, not just the
  // clean one: `sessions-live` and `not-recorded` also say "your password was reset", and a
  // sentence is no more true for being bad news.
  if (options.success || options.passwordChanged) headers.append("Set-Cookie", successCookie());
  return new Response(null, { status: 303, headers });
}

/**
 * The non-form arm, which is narrower than it looks: `acceptsHtml` matches exactly the two content
 * types `Request.formData()` can parse, so a caller who is not sending a form fails at the parse
 * above and never reaches the outcomes below it. Every post-parse refusal is a redirect.
 *
 * `passwordChanged` is carried anyway rather than left to the status code, because the two
 * post-change outcomes would otherwise read as "nothing happened" to anyone who ever does reach
 * them -- the same collapse this change exists to undo.
 */
function jsonError(status: number, code: ResetPasswordOutcome, passwordChanged: boolean) {
  return Response.json({ error: "The password reset could not be completed.", code, passwordChanged }, {
    status,
    headers: NO_STORE,
  });
}

/**
 * Which of the three outcomes a GoTrue error means, exported so it can be tested.
 *
 * It lives out here rather than inside the dependency because the handler's tests stub
 * `updatePassword` wholesale -- so a mapping written in the closure is a rule nothing exercises,
 * and mutating it to "always rejected" left the suite green. The three codes below mean the
 * password itself was refused: it fails a strength or leaked-password policy, it is already the
 * one on the account, or it failed validation. All three are the reader's to fix, and none of them
 * are fixed by a new link.
 */
export function passwordUpdateOutcome(error: { code?: string } | null): PasswordUpdate {
  if (!error) return "ok";
  return REFUSED_PASSWORD.has(error.code ?? "") ? "rejected" : "failed";
}

/**
 * Did the revoke RPC actually delete rows, or only fail to throw?
 *
 * Out here for the same reason as `passwordUpdateOutcome` above, and the reason is worth stating
 * twice because I only applied it to one of the three operations the first time: the handler's
 * tests stub `endOtherSessions` wholesale, so every rule written inside that closure was a rule
 * nothing exercised. This one had no test at all -- not a weak test, none -- while the flow it
 * guards is the one that decides whether an attacker's stolen session survives a password reset.
 *
 * A failed PostgREST call resolves to `{ error }` rather than throwing, so the result has to be
 * read rather than awaited and trusted. And the shape has to be checked too: the RPC returns a set,
 * so a successful call that matched nothing arrives as an empty array, which is not the same as a
 * revoke that ran.
 */
export function revokedOtherSessions(result: { data: unknown; error: unknown }): boolean {
  if (result.error) return false;
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  if (!row || typeof row !== "object") return false;
  return Number.isSafeInteger((row as { revoked_count?: unknown }).revoked_count);
}

/**
 * The actor a recovery session names, or null when it names nobody we can act for.
 *
 * Extracted for the same reason, and it carries the arm that is easiest to lose: `getClaims`
 * resolves to a null payload *without* reporting an error, so an absent payload has to be checked
 * on its own rather than inferred from `claimsError`. Returning null refuses the reset instead of
 * completing one against a session whose tenant could not be established -- which for a
 * multi-tenant product is the difference between a scoped write and an unscoped one.
 */
export function recoveryActor(
  user: { data: { user?: { id?: string | null } | null }; error: unknown },
  claims: { data: { claims?: unknown } | null; error: unknown },
): ResetActor | null {
  if (user.error || claims.error || !claims.data || !user.data.user?.id) return null;
  return { userId: user.data.user.id, tenantId: parseAppClaims(claims.data.claims).tenantId };
}

export function createCompletePasswordResetHandler(dependencies: CompletePasswordResetDependencies) {
  return async function POST(request: Request) {
    // Every mutating account-security route already refuses a foreign origin; this endpoint sets a
    // password and did not. A form on any site, posted while the reader holds a live recovery
    // session, set their password to a value its author chose -- narrow window, account takeover.
    //
    // The refusal is the same shape those routes use rather than a variant, including for a form
    // post: a refused origin is an attack or a misconfiguration, not a state a reader can act on,
    // so it does not get a sentence on the page. Same-origin form submissions do send `Origin` --
    // user agents add it to same-origin requests other than GET and HEAD
    // (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Origin, read
    // 2026-09-01) -- so this does not cost the scripting-unavailable path the form exists to serve.
    if (!sameOrigin(request)) {
      return Response.json({ error: "Request origin was refused." }, { status: 403, headers: NO_STORE });
    }
    const html = acceptsHtml(request);
    const url = new URL(request.url);
    const next = internalRedirectPath(url.searchParams.get("next"), "/login");
    const fail = (status: number, code: ResetPasswordOutcome, passwordChanged = false) =>
      html
        ? formRedirect(request, next, { error: code, passwordChanged })
        : jsonError(status, code, passwordChanged);

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return fail(400, "reset-failed");
    }
    const password = passwordFromForm(form);
    // Its own code, because the link is fine: the recovery session is still in the reader's cookie
    // and they need a longer password, not another of three throttled emails. Reachable with
    // scripting unavailable, which is the mode this form exists to serve.
    if (password.length < MIN_PASSWORD_LENGTH) return fail(400, "password-rejected");

    const actor = await dependencies.session();
    if (!actor) return fail(401, "invalid-link");
    const updated = await dependencies.updatePassword(password);
    if (updated === "rejected") return fail(400, "password-rejected");
    if (updated !== "ok") return fail(400, "reset-failed");

    // Past this line the new password is live, so no outcome may say the reset did not happen.
    // Ending every other session is the point of a password reset -- the person may have lost
    // control of one -- so it is attempted before the recovery session is closed, while the JWT
    // this runs under still names a session to keep.
    const othersEnded = await dependencies.endOtherSessions(actor);
    const localEnded = await dependencies.signOut();

    let recorded = true;
    try {
      await dependencies.audit(request, actor);
    } catch {
      recorded = false;
    }

    // A session left alive outranks a row left unwritten: one is a way in for whoever prompted the
    // reset, the other is bookkeeping the reader cannot act on.
    if (!othersEnded || !localEnded) return fail(503, "sessions-live", true);
    if (!recorded) return fail(503, "not-recorded", true);

    if (html) return formRedirect(request, next, { success: true });
    return Response.json({ message: "Your password was reset and your other sessions were signed out.", next }, { headers: NO_STORE });
  };
}

export const POST = createCompletePasswordResetHandler({
  session: async () => {
    const client = await createSupabaseServerClient();
    const [{ data: userData, error: userError }, { data: claimsData, error: claimsError }] = await Promise.all([
      client.auth.getUser(),
      client.auth.getClaims(),
    ]);
    // getClaims resolves to a null payload without reporting an error, so the absent case has to
    // be checked on its own. Returning null here refuses the reset rather than completing one
    // against a session whose tenant could not be established.
    return recoveryActor(
      { data: userData, error: userError },
      { data: claimsData, error: claimsError },
    );
  },
  updatePassword: async (password) => {
    const client = await createSupabaseServerClient();
    const { error } = await client.auth.updateUser({ password });
    return passwordUpdateOutcome(error);
  },
  /**
   * The same RPC the account-security screen's "Revoke other sessions" control calls, which deletes
   * every `auth.sessions` row for this user except the one named by the JWT's `session_id` and
   * returns how many it removed. Chosen over `signOut({ scope: "others" })` for two reasons the
   * copy depends on: it is our own row delete rather than a GoTrue behaviour whose session handling
   * on password change the docs describe only as "depending on configuration"
   * (https://supabase.com/docs/guides/auth/sessions, read 2026-09-01), and `signOut` swallows 401,
   * 403 and 404 and still resolves with no error, so it cannot report whether it did anything.
   * A PostgREST failure resolves to `{ error }` rather than throwing, so the result is read.
   */
  endOtherSessions: async (actor) => {
    const client = await createSupabaseServerClient();
    return revokedOtherSessions(await client.rpc("revoke_other_account_security_sessions", {
      p_expected_user: actor.userId,
      p_expected_tenant: actor.tenantId,
      p_reason: "Password reset completed from an emailed recovery link.",
    }));
  },
  signOut: async () => {
    const client = await createSupabaseServerClient();
    const { error } = await client.auth.signOut({ scope: "local" });
    return !error;
  },
  audit: async (request, actor) => writeAuthAuditEvent({
    action: "auth.password_reset.completed",
    actorId: actor.userId,
    tenantId: actor.tenantId,
    actorIp: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || request.headers.get("x-real-ip") || null,
    payload: { flow: "password_reset" },
  }),
});
