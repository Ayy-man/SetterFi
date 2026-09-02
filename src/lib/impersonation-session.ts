/**
 * The one server read that lets every workspace page say whose workspace it is.
 *
 * `ImpersonationBanner` was built, tested and mounted nowhere, so an operator inside a coach's
 * workspace saw no band, no clock, no audit line, and had no way out before the session's thirty
 * minutes expired -- `/api/platform/impersonation/end` had no caller anywhere in the app. This
 * resolves the props the banner needs, once, above every workspace route.
 *
 * ## Why the session comes from the table and not from the claims
 *
 * The claims carry `impersonation_session_id`, and reading it would be one fewer query. The end
 * route does not trust it: `createImpersonationEndHandler` refuses any `sessionId` that is not
 * `loadImpersonationLifecycleActor().activeSession.id`, which is resolved from
 * `impersonation_sessions` by actor. Resolving the banner's id from anywhere else would let a
 * stale claim -- a session already ended in another tab, or expired -- render a button whose only
 * possible outcome is a 409. The banner posts the id the route will accept, or it does not render.
 *
 * `resolveActiveImpersonationSession` is that same authority, so this asks it first and then reads
 * the row for the two timestamps and the names. A session that has ended or expired is not active,
 * and the band disappears with it.
 */

import { resolveActiveImpersonationSession } from "@/lib/auth/actors";
import { parseAppClaims, type UserRole } from "@/lib/auth/claims";
import { authMode } from "@/lib/auth/mode";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

export type ImpersonationSessionBanner = {
  tenantName: string;
  operator?: { name: string; role: string };
  sessionId: string;
  startedAt: string;
  expiresAt: string;
};

/**
 * The capacity the operator is reading in, in words a coach would recognise on their audit trail.
 *
 * Only these three roles can open a session (`IMPERSONATION_ROLES` in `src/lib/impersonation.ts`),
 * so anything else is a row that should not exist; it prints nothing rather than a raw enum value.
 */
function operatorRole(role: UserRole | null): string | null {
  if (role === "owner") return "platform owner";
  if (role === "admin") return "platform admin";
  if (role === "success") return "client success";
  return null;
}

export async function loadImpersonationSessionBanner(): Promise<ImpersonationSessionBanner | null> {
  /*
   * The open and password fixtures have no claims to read and no impersonation to be inside, and
   * asking would cost a round trip per page for a null. Same reasoning the workspace layout
   * already applies to the nav's role gate.
   */
  if (authMode() !== "supabase") return null;

  try {
    const client = await createSupabaseServerClient();
    const { data, error } = await client.auth.getClaims();
    if (error || !data?.claims) return null;

    const claims = parseAppClaims(data.claims);
    if (!claims.userId) return null;

    const active = await resolveActiveImpersonationSession(claims.userId);
    if (!active) return null;

    const service = createSupabaseServiceClient();
    const [session, tenant, operator] = await Promise.all([
      service
        .from("impersonation_sessions")
        .select("started_at, expires_at")
        .eq("id", active.id)
        .maybeSingle(),
      service.from("tenants").select("name").eq("id", active.tenantId).maybeSingle(),
      service.from("users").select("full_name, role").eq("id", claims.userId).maybeSingle(),
    ]);

    if (session.error || !session.data) return null;

    /*
     * A workspace with no resolvable name is not a workspace the band can honestly announce, and
     * "You are viewing 8f3a-…'s workspace" names nobody. The session is still enforced by the
     * database either way; what would be lost is the sentence, so the band stays off.
     */
    const tenantName = typeof tenant.data?.name === "string" ? tenant.data.name.trim() : "";
    if (!tenantName) return null;

    const name = typeof operator.data?.full_name === "string" ? operator.data.full_name.trim() : "";
    const role = operatorRole((operator.data?.role as UserRole | undefined) ?? null);

    return {
      expiresAt: session.data.expires_at,
      // Optional by contract: a caller that cannot resolve a name prints nothing rather than an id.
      operator: name && role ? { name, role } : undefined,
      sessionId: active.id,
      startedAt: session.data.started_at,
      tenantName,
    };
  } catch {
    /*
     * A failed read must not take the workspace down with it. The band is the visible half of a
     * rule Postgres already keeps -- writes are refused while the claim exists whether or not this
     * query succeeds -- so the safe failure is a missing band, not a broken page.
     */
    return null;
  }
}
