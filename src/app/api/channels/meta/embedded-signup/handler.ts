import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { phase4Live, whatsappEmbeddedSignupEnabled } from "@/lib/env-contract";
import {
  selectWhatsAppEmbeddedSignupService,
  type WhatsAppEmbeddedSignupRepository,
  type WhatsAppEmbeddedSignupService,
} from "@/lib/integrations/meta-embedded-signup";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const noStoreHeaders = { "Cache-Control": "no-store" };

export type EmbeddedSignupDependencies = {
  session(): Promise<RouteActor | null>;
  service(): WhatsAppEmbeddedSignupService;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactCompletionBody(value: unknown): value is {
  code: string;
  wabaId: string;
  phoneNumberId: string;
} {
  if (
    !isRecord(value)
    || Object.keys(value).some((key) => !["code", "wabaId", "phoneNumberId"].includes(key))
  ) return false;
  return [value.code, value.wabaId, value.phoneNumberId].every(
    (item) => typeof item === "string" && item.trim().length > 0,
  );
}

export function createLiveEmbeddedSignupRepository(
  client = createSupabaseServiceClient(),
): WhatsAppEmbeddedSignupRepository {
  return {
    persistConnection: async (input) => {
      const completedAt = input.webhookSubscribedAt;
      const { data, error } = await client.rpc("persist_meta_whatsapp_connection_atomic", {
        p_expected_tenant: input.tenantId,
        p_actor_id: input.actorId,
        p_waba_id: input.wabaId,
        p_phone_number_id: input.phoneNumberId,
        p_state: input.state,
        p_credential_envelope: input.credentialEnvelope,
        p_token_expires_at: input.tokenExpiresAt,
        p_scopes: [...input.scopes],
        p_completed_at: completedAt,
        p_phone_verified_at: input.phoneVerifiedAt,
      });
      if (error || typeof data !== "string") {
        throw new Error("WHATSAPP_CONNECTION_ATOMIC_WRITE_FAILED");
      }
      return { connectionId: data };
    },
  };
}

function routeGate() {
  if (!phase4Live()) return { status: 404, message: "Not found." };
  if (!whatsappEmbeddedSignupEnabled()) {
    return { status: 404, message: "WhatsApp Embedded Signup is disabled." };
  }
  return null;
}

async function actorGate(dependencies: EmbeddedSignupDependencies): Promise<
  { actor: RouteActor; response: null } | { actor: null; response: Response }
> {
  const actor = await dependencies.session();
  if (!actor) return { actor: null, response: Response.json({ error: "Authentication required." }, {
    status: 401,
    headers: noStoreHeaders,
  }) };
  if (hasImpersonationMarker(actor)) return { actor: null, response: Response.json({
    error: "Impersonated sessions are read-only.",
  }, { status: 403, headers: noStoreHeaders }) };
  return { actor, response: null };
}

export function createEmbeddedSignupHandlers(dependencies: EmbeddedSignupDependencies) {
  return {
    GET: async () => {
      const gate = routeGate();
      if (gate) return Response.json({ error: gate.message }, { status: gate.status, headers: noStoreHeaders });
      const authorized = await actorGate(dependencies);
      if (authorized.response) return authorized.response;
      try {
        const launcher = dependencies.service().launcher();
        return Response.json({ launcher }, { headers: noStoreHeaders });
      } catch (cause) {
        console.error(
          "/api/channels/meta/embedded-signup failed.",
          cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
        );
        return Response.json({ error: "WhatsApp Embedded Signup is unavailable." }, {
          status: 503,
          headers: noStoreHeaders,
        });
      }
    },

    POST: async (request: Request) => {
      const gate = routeGate();
      if (gate) return Response.json({ error: gate.message }, { status: gate.status, headers: noStoreHeaders });
      const authorized = await actorGate(dependencies);
      if (authorized.response) return authorized.response;
      try {
        const body: unknown = await request.json();
        if (!exactCompletionBody(body)) {
          return Response.json({ error: "Invalid signup completion." }, {
            status: 400,
            headers: noStoreHeaders,
          });
        }
        const result = await dependencies.service().complete({
          tenantId: authorized.actor.tenantId,
          actorId: authorized.actor.userId,
          code: body.code,
          wabaId: body.wabaId,
          phoneNumberId: body.phoneNumberId,
        });
        return Response.json({ connectionId: result.connectionId, state: result.state }, {
          status: 202,
          headers: noStoreHeaders,
        });
      } catch {
        return Response.json({ error: "WhatsApp Embedded Signup was refused." }, {
          status: 409,
          headers: noStoreHeaders,
        });
      }
    },
  };
}

const handlers = createEmbeddedSignupHandlers({
  session: loadRouteActor,
  service: () => selectWhatsAppEmbeddedSignupService({
    dependencies: { repository: createLiveEmbeddedSignupRepository() },
  }),
});

export const GET = handlers.GET;
export const POST = handlers.POST;
