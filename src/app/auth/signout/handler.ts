import { parseAppClaims } from "@/lib/auth/claims";
import { internalRedirectPath } from "@/lib/auth/internal-redirect";
import { writeAuthAuditEvent } from "@/lib/auth/recovery-audit";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };

type SignoutActor = { userId: string; tenantId: string | null };

type SignoutDependencies = {
  actor(): Promise<SignoutActor | null>;
  signOut(): Promise<boolean>;
  audit(request: Request, actor: SignoutActor): Promise<void>;
};

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}

function redirect(request: Request, next: string) {
  return new Response(null, {
    status: 303,
    headers: {
      ...NO_STORE,
      Location: new URL(internalRedirectPath(next, "/login"), request.url).toString(),
    },
  });
}

/** POST-only: sign-out mutates state, and a GET would let any <img src> log
 *  people out (classic CSRF-by-prefetch). A same-origin POST also stops cross-site form posts. */
export function createSignoutHandler(dependencies: SignoutDependencies) {
  return async function POST(request: Request) {
    if (!sameOrigin(request)) {
      return Response.json({ error: "Request origin was refused." }, { status: 403, headers: NO_STORE });
    }
    const next = internalRedirectPath(new URL(request.url).searchParams.get("next"), "/login");
    const actor = await dependencies.actor();
    if (!await dependencies.signOut()) {
      return Response.json({ error: "Sign out could not be completed." }, { status: 503, headers: NO_STORE });
    }
    if (actor) {
      try {
        await dependencies.audit(request, actor);
      } catch {
        return Response.json({ error: "Sign out could not be recorded." }, { status: 503, headers: NO_STORE });
      }
    }
    return redirect(request, next);
  };
}

export const POST = createSignoutHandler({
  actor: async () => {
    const client = await createSupabaseServerClient();
    const [{ data: userData, error: userError }, { data: claimsData, error: claimsError }] = await Promise.all([
      client.auth.getUser(),
      client.auth.getClaims(),
    ]);
    // getClaims can resolve to a null payload without reporting an error, so the absent case needs
    // its own check before the claims are read for a tenant.
    if (userError || claimsError || !claimsData || !userData.user?.id) return null;
    return { userId: userData.user.id, tenantId: parseAppClaims(claimsData.claims).tenantId };
  },
  signOut: async () => {
    const client = await createSupabaseServerClient();
    const { error } = await client.auth.signOut({ scope: "local" });
    return !error;
  },
  audit: (request, actor) => writeAuthAuditEvent({
    action: "auth.signed_out",
    actorId: actor.userId,
    tenantId: actor.tenantId,
    actorIp: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      || request.headers.get("x-real-ip") || null,
    payload: { flow: "self_service" },
  }),
});
