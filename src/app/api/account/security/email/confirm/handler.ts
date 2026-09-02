import { accountEmailChangeCompletion, ACCOUNT_EMAIL_CHANGE_NO_STORE } from "@/lib/auth/email-change";
import { accountEmailChangeLive } from "@/lib/env-contract";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type Completion = { action: "confirm" | "refuse"; tokenHash: string };
type Pending = { userId: string; newEmail: string };
type AuthSync = "synced" | "taken" | "unavailable";
type Dependencies = {
  enabled(): boolean;
  resolve(tokenHash: string): Promise<Pending | null>;
  syncAuthIdentity(input: Pending): Promise<AuthSync>;
  voidRequest(tokenHash: string): Promise<void>;
  recordDivergence(tokenHash: string): Promise<void>;
  complete(input: Completion): Promise<{ state: "confirmed" | "refused" | "invalid"; auditId: number | null }>;
};

function response(state: "confirmed" | "refused" | "invalid", auditId: number | null) {
  if (state === "confirmed") return Response.json({ status: "confirmed", audit: { id: auditId, action: "auth.email_change.confirmed" } }, { headers: ACCOUNT_EMAIL_CHANGE_NO_STORE });
  if (state === "refused") return Response.json({ status: "refused", audit: { id: auditId, action: "auth.email_change.refused" } }, { headers: ACCOUNT_EMAIL_CHANGE_NO_STORE });
  return Response.json({ error: "This email-change link is invalid or expired." }, { status: 400, headers: ACCOUNT_EMAIL_CHANGE_NO_STORE });
}

function unavailable(message: string) {
  return Response.json({ error: message }, { status: 503, headers: ACCOUNT_EMAIL_CHANGE_NO_STORE });
}

/**
 * Ordering invariant: Supabase Auth is the authority while the two stores disagree.
 *
 * The confirmation moves GoTrue's identity first and only then redeems the token, which writes
 * `public.users.email` and ends every session in one transaction. A failure between the two leaves
 * sign-in on the new address with the application row still on the old one, the request row still
 * `pending`, and an `auth.email_change.diverged` audit receipt naming that direction. Opening the
 * same link again converges: the auth step is a no-op once the identity already carries the
 * requested address, so the projection write simply retries.
 *
 * The reverse order was rejected. Writing the application row first ends every session while
 * sign-in still requires the old address, which the screen no longer shows, so a provider outage
 * would lock the account owner out of their own account rather than leave a recoverable window.
 */
export function createAccountEmailChangeConfirmHandler(dependencies: Dependencies) {
  const confirm = async (tokenHash: string) => {
    const pending = await dependencies.resolve(tokenHash);
    if (!pending) return response("invalid", null);
    const sync = await dependencies.syncAuthIdentity(pending);
    if (sync === "unavailable") {
      // Nothing moved in either store, so the link stays spendable and the caller can retry.
      return unavailable("The email change could not be completed. Neither address was changed. Open the link again.");
    }
    if (sync === "taken") {
      // Another identity holds the address now. Same generic refusal as a bad link so this endpoint
      // never answers whether a given address has an account behind it.
      await dependencies.voidRequest(tokenHash).catch(() => undefined);
      return response("invalid", null);
    }
    let completed: Awaited<ReturnType<Dependencies["complete"]>>;
    try {
      completed = await dependencies.complete({ action: "confirm", tokenHash });
    } catch {
      await dependencies.recordDivergence(tokenHash).catch(() => undefined);
      return unavailable("Sign-in already uses the new address, but the account record could not be updated. Open the link again to finish.");
    }
    if (completed.state !== "confirmed") {
      await dependencies.recordDivergence(tokenHash).catch(() => undefined);
      return unavailable("Sign-in already uses the new address, but the account record could not be updated. Support has been sent a receipt.");
    }
    return response("confirmed", completed.auditId);
  };

  const complete = async (input: unknown) => {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: ACCOUNT_EMAIL_CHANGE_NO_STORE });
    const completion = accountEmailChangeCompletion(input) as Completion | null;
    if (!completion) return response("invalid", null);
    try {
      if (completion.action === "confirm") return await confirm(completion.tokenHash);
      const result = await dependencies.complete(completion);
      return response(result.state, result.auditId);
    } catch {
      return unavailable("The email change could not be completed.");
    }
  };
  return {
    POST: async (request: Request) => complete(await request.json().catch(() => null)),
    GET: async (request: Request) => {
      const url = new URL(request.url);
      return complete({ action: url.searchParams.get("action"), token: url.searchParams.get("token") });
    },
  };
}

function record(value: unknown) {
  const row = Array.isArray(value) ? value[0] : value;
  return row && typeof row === "object" ? row as Record<string, unknown> : null;
}

/** GoTrue answers an occupied address with a 422 and a message naming registration, not a 5xx. */
export function authIdentityFailure(error: { status?: number; code?: string; message?: string } | null): AuthSync {
  if (!error) return "synced";
  const message = (error.message ?? "").toLowerCase();
  const taken = error.code === "email_exists"
    || error.status === 422
    || message.includes("already been registered")
    || message.includes("already registered")
    || message.includes("already exists");
  return taken ? "taken" : "unavailable";
}

const handler = createAccountEmailChangeConfirmHandler({
  enabled: accountEmailChangeLive,
  resolve: async (tokenHash) => {
    const { data, error } = await createSupabaseServiceClient().rpc("resolve_account_email_change_confirmation", {
      p_token_hash: tokenHash,
    });
    if (error) throw new Error("ACCOUNT_EMAIL_CHANGE_RESOLVE_FAILED");
    const row = record(data);
    if (!row) return null;
    return typeof row.account_id === "string" && typeof row.target_email === "string"
      ? { userId: row.account_id, newEmail: row.target_email }
      : null;
  },
  syncAuthIdentity: async ({ userId, newEmail }) => {
    const service = createSupabaseServiceClient();
    const current = await service.auth.admin.getUserById(userId);
    if (current.error || !current.data.user) return "unavailable";
    // A retry after a partial failure finds the identity already moved; treat that as done so the
    // projection write is the only step left and the link converges instead of erroring.
    if (current.data.user.email?.trim().toLowerCase() === newEmail) return "synced";
    const { error } = await service.auth.admin.updateUserById(userId, { email: newEmail, email_confirm: true });
    return authIdentityFailure(error);
  },
  voidRequest: async (tokenHash) => {
    await createSupabaseServiceClient().rpc("void_account_email_change", {
      p_token_hash: tokenHash, p_reason: "address_unavailable",
    });
  },
  recordDivergence: async (tokenHash) => {
    await createSupabaseServiceClient().rpc("record_account_email_change_divergence", {
      p_token_hash: tokenHash, p_direction: "auth_ahead_of_app",
    });
  },
  complete: async ({ action, tokenHash }) => {
    const { data, error } = await createSupabaseServiceClient().rpc("complete_account_email_change", {
      p_token_hash: tokenHash, p_action: action,
    });
    const row = error ? null : record(data);
    if (!row || (row.state !== "confirmed" && row.state !== "refused" && row.state !== "invalid")) {
      throw new Error("ACCOUNT_EMAIL_CHANGE_COMPLETE_FAILED");
    }
    const auditId = typeof row.audit_id === "number" && Number.isSafeInteger(row.audit_id) ? row.audit_id : null;
    return { state: row.state, auditId };
  },
});

export const GET = handler.GET;
export const POST = handler.POST;
