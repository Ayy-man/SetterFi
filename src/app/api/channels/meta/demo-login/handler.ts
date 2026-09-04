/**
 * `GET /api/channels/meta/demo-login?state=<oauthState>` -- what the simulated `/demo/meta-login`
 * page reads to render the right words before it posts back the fixed demo authorization code.
 *
 * It answers only for a state row that is real, unexpired, unconsumed, and bound to a demo
 * tenant's own actor: the same binding `POST /api/channels/meta/callback` enforces before it will
 * complete an OAuth. A state that fails any of those returns 404 rather than a reason, so this
 * route cannot be used to probe which OAuth attempts exist.
 */

import { createHash } from "node:crypto";

import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { phase4Live } from "@/lib/env-contract";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const noStoreHeaders = { "Cache-Control": "no-store" };

export type MetaDemoLoginResult = {
  channel: "instagram" | "messenger";
  coachName: string | null;
};

export type MetaDemoLoginDependencies = {
  session(): Promise<RouteActor | null>;
  lookup(input: {
    tenantId: string;
    actorId: string;
    oauthState: string;
  }): Promise<MetaDemoLoginResult | null>;
};

function stateHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function createMetaDemoLoginHandler(dependencies: MetaDemoLoginDependencies) {
  return async function GET(request: Request) {
    if (!phase4Live()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    const actor = await dependencies.session();
    if (!actor) {
      return Response.json({ error: "Authentication required." }, { status: 401, headers: noStoreHeaders });
    }
    if (hasImpersonationMarker(actor)) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    const oauthState = new URL(request.url).searchParams.get("state")?.trim();
    if (!oauthState) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    const found = await dependencies.lookup({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      oauthState,
    });
    if (!found) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    return Response.json({
      channel: found.channel,
      coachName: found.coachName,
      tenantIsDemo: true,
    }, { headers: noStoreHeaders });
  };
}

export const GET = createMetaDemoLoginHandler({
  session: loadRouteActor,
  lookup: async ({ tenantId, actorId, oauthState }) => {
    const client = createSupabaseServiceClient();

    const { data: tenant, error: tenantError } = await client
      .from("tenants")
      .select("is_demo")
      .eq("id", tenantId)
      .maybeSingle();
    if (tenantError || !tenant || tenant.is_demo !== true) return null;

    const { data: state, error: stateError } = await client
      .from("channel_oauth_states")
      .select("channel, expires_at")
      .eq("state_hash", stateHash(oauthState))
      .eq("tenant_id", tenantId)
      .eq("actor_id", actorId)
      .is("consumed_at", null)
      .maybeSingle();
    if (stateError || !state) return null;
    if (new Date(state.expires_at).getTime() <= Date.now()) return null;
    if (state.channel !== "instagram" && state.channel !== "messenger") return null;

    const { data: user, error: userError } = await client
      .from("users")
      .select("full_name")
      .eq("id", actorId)
      .maybeSingle();
    const coachName = !userError && user?.full_name?.trim() ? user.full_name.trim() : null;

    return { channel: state.channel, coachName };
  },
});
