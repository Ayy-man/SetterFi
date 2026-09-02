import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { META_SESSION_COOKIE } from "@/app/api/channels/meta/callback/handler";
import { createLiveMetaOAuth } from "@/app/api/channels/meta/connect/handler";
import { phase4Live } from "@/lib/env-contract";
import type { MetaOAuthSessionRecord } from "@/lib/integrations/meta-oauth";

const noStoreHeaders = { "Cache-Control": "no-store" };

type OAuthChannel = "instagram" | "messenger";

export type MetaAssetsDependencies = {
  session(): Promise<RouteActor | null>;
  loadSession(sessionId: string): Promise<MetaOAuthSessionRecord | null>;
  subscribe(input: {
    tenantId: string;
    actorId: string;
    sessionId: string;
    assetId: string;
  }): Promise<{ connectionId: string; state: "ready" }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sessionCookie(request: Request) {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === META_SESSION_COOKIE) return decodeURIComponent(value.join("="));
  }
  return null;
}

function exactAssetBody(value: unknown): value is { assetId: string; channel: OAuthChannel } {
  if (!isRecord(value) || Object.keys(value).some((key) => !["assetId", "channel"].includes(key))) {
    return false;
  }
  return typeof value.assetId === "string" && value.assetId.trim().length > 0
    && (value.channel === "instagram" || value.channel === "messenger");
}

async function authorizedSession(
  request: Request,
  actor: RouteActor,
  dependencies: MetaAssetsDependencies,
) {
  const sessionId = sessionCookie(request);
  if (!sessionId) return null;
  const oauth = await dependencies.loadSession(sessionId);
  if (!oauth || oauth.tenantId !== actor.tenantId || oauth.actorId !== actor.userId) return null;
  return { sessionId, oauth };
}

export function createMetaAssetsHandlers(dependencies: MetaAssetsDependencies) {
  return {
    GET: async (request: Request) => {
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
      try {
        const authorized = await authorizedSession(request, actor, dependencies);
        if (!authorized) {
          return Response.json({ error: "Connection session not found." }, {
            status: 404,
            headers: noStoreHeaders,
          });
        }
        return Response.json({
          items: authorized.oauth.assets.map(({ assetId, channel, label, eligible }) => ({
            assetId,
            channel,
            label,
            eligible,
          })),
        }, { headers: noStoreHeaders });
      } catch (cause) {
        console.error(
          "/api/channels/meta/assets failed.",
          cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
        );
        return Response.json({ error: "Connection assets are unavailable." }, {
          status: 503,
          headers: noStoreHeaders,
        });
      }
    },

    POST: async (request: Request) => {
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
      try {
        const body: unknown = await request.json();
        if (!exactAssetBody(body)) {
          return Response.json({ error: "Invalid asset selection." }, {
            status: 400,
            headers: noStoreHeaders,
          });
        }
        const authorized = await authorizedSession(request, actor, dependencies);
        if (!authorized || authorized.oauth.channel !== body.channel) {
          return Response.json({ error: "Connection session not found." }, {
            status: 404,
            headers: noStoreHeaders,
          });
        }
        const result = await dependencies.subscribe({
          tenantId: actor.tenantId,
          actorId: actor.userId,
          sessionId: authorized.sessionId,
          assetId: body.assetId,
        });
        return Response.json({ connectionId: result.connectionId, state: result.state }, {
          status: 202,
          headers: noStoreHeaders,
        });
      } catch {
        return Response.json({ error: "Asset selection was refused." }, {
          status: 409,
          headers: noStoreHeaders,
        });
      }
    },
  };
}

const live = () => createLiveMetaOAuth();

const handlers = createMetaAssetsHandlers({
  session: loadRouteActor,
  loadSession: (sessionId) => live().loadSession(sessionId),
  subscribe: (input) => live().service.subscribe(input),
});

export const GET = handlers.GET;
export const POST = handlers.POST;
