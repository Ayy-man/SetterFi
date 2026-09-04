import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { phase4Live } from "@/lib/env-contract";
import { isDemoTenant } from "@/lib/repositories/tenant-demo-flag";

import { createLiveMetaOAuth } from "../connect/handler";

const META_SESSION_COOKIE = "setterfi_meta_oauth_session";
const noStoreHeaders = { "Cache-Control": "no-store" };

export type MetaCallbackDependencies = {
  session(): Promise<RouteActor | null>;
  complete(input: {
    tenantId: string;
    actorId: string;
    code: string;
    oauthState: string;
  }): Promise<{ sessionId: string; returnPath: string }>;
};

function redirectLocation(returnPath: string) {
  const target = new URL(returnPath, "https://setterfi.invalid");
  target.searchParams.set("meta", "select_asset");
  return `${target.pathname}${target.search}`;
}

function redirect(location: string, sessionId?: string) {
  const headers = new Headers(noStoreHeaders);
  headers.set("Location", location);
  if (sessionId) {
    headers.append(
      "Set-Cookie",
      `${META_SESSION_COOKIE}=${encodeURIComponent(sessionId)}; HttpOnly; Secure; SameSite=Lax; Path=/api/channels/meta; Max-Age=600`,
    );
  }
  return new Response(null, { status: 303, headers });
}

export function createMetaCallbackHandler(dependencies: MetaCallbackDependencies) {
  return async function GET(request: Request) {
    if (!phase4Live()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    const actor = await dependencies.session();
    if (!actor) {
      return Response.json({ error: "Authentication required." }, { status: 401, headers: noStoreHeaders });
    }
    if (hasImpersonationMarker(actor)) {
      return Response.json({ error: "Impersonated sessions are read-only." }, {
        status: 403,
        headers: noStoreHeaders,
      });
    }
    const query = new URL(request.url).searchParams;
    const code = query.get("code")?.trim();
    const oauthState = query.get("state")?.trim();
    if (!code || !oauthState) return redirect("/coach/settings?meta=connection_error");
    try {
      const result = await dependencies.complete({
        tenantId: actor.tenantId,
        actorId: actor.userId,
        code,
        oauthState,
      });
      return redirect(redirectLocation(result.returnPath), result.sessionId);
    } catch {
      // Provider errors can carry token-bearing URLs and are deliberately collapsed before redirect.
      return redirect("/coach/settings?meta=connection_error");
    }
  };
}

export const GET = createMetaCallbackHandler({
  session: loadRouteActor,
  complete: async (input) => {
    const isDemo = await isDemoTenant(input.tenantId);
    const oauth = createLiveMetaOAuth({ isDemo });
    const channel = await oauth.channelForState(
      input.oauthState,
      input.tenantId,
      input.actorId,
    );
    if (!channel) throw new Error("META_OAUTH_STATE_INVALID_OR_REPLAYED");
    return oauth.service.complete({ ...input, channel });
  },
});

export { META_SESSION_COOKIE };
