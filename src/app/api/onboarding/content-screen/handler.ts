import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { phase5Live } from "@/lib/env-contract";
import type { ContentScreenResult } from "@/lib/onboarding/contracts";
import { createOnboardingEvidenceRepository } from "@/lib/repositories/onboarding-evidence";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };

type ContentScreenDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  load(tenantId: string): Promise<ContentScreenResult | null>;
  acknowledge(input: { tenantId: string; screenId: string; actorId: string }): Promise<{
    auditId: string;
    actionKey: "onboarding.content_acknowledged";
  }>;
};

function exactBody(value: unknown): value is { screenId: string } {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && typeof (value as { screenId?: unknown }).screenId === "string"
    && Boolean((value as { screenId: string }).screenId.trim());
}

function refuse(actor: RouteActor | null, write = false) {
  if (!actor) return Response.json({ error: "Authentication required." }, { status: 401, headers: NO_STORE });
  if (hasImpersonationMarker(actor)) return Response.json({ error: "Impersonated sessions are read-only." }, { status: 403, headers: NO_STORE });
  if (write && actor.role !== "coach") return Response.json({ error: "Forbidden." }, { status: 403, headers: NO_STORE });
  return null;
}

export function createContentScreenHandlers(dependencies: ContentScreenDependencies) {
  return {
    GET: async () => {
      if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
      const actor = await dependencies.session();
      const refused = refuse(actor);
      if (refused || !actor) return refused!;
      try {
        return Response.json({ screen: await dependencies.load(actor.tenantId) }, { headers: NO_STORE });
      } catch (cause) {
        console.error(
          "/api/onboarding/content-screen failed.",
          cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
        );
        return Response.json({ error: "Content screen is unavailable." }, { status: 503, headers: NO_STORE });
      }
    },
    POST: async (request: Request) => {
      if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
      const actor = await dependencies.session();
      const refused = refuse(actor, true);
      if (refused || !actor) return refused!;
      try {
        const body: unknown = await request.json();
        if (!exactBody(body)) throw new Error("INVALID_BODY");
        const receipt = await dependencies.acknowledge({
          tenantId: actor.tenantId,
          screenId: body.screenId,
          actorId: actor.userId,
        });
        if (!receipt.auditId.trim()) throw new Error("ACKNOWLEDGE_ONBOARDING_CONTENT_SCREEN_EMPTY");
        return Response.json({ screenId: body.screenId, receipt }, { headers: NO_STORE });
      } catch {
        return Response.json({ error: "Content acknowledgement was refused." }, { status: 409, headers: NO_STORE });
      }
    },
  };
}

async function loadCurrentContentScreen(tenantId: string): Promise<ContentScreenResult | null> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client
    .from("onboarding_content_screens")
    .select("id, input_hash, result, matches, acknowledged_at, admin_confirmed_at")
    .eq("tenant_id", tenantId)
    .eq("is_current", true)
    .maybeSingle();
  if (error) throw new Error("ONBOARDING_CONTENT_SCREEN_READ_FAILED");
  if (!data) return null;
  return {
    screenId: data.id,
    inputHash: data.input_hash,
    state: data.result === "clean"
      ? "clean"
      : data.admin_confirmed_at
        ? "confirmed"
        : "flagged",
    matches: Array.isArray(data.matches) ? data.matches : [],
    coachAcknowledgedAt: data.acknowledged_at,
    adminConfirmedAt: data.admin_confirmed_at,
  } as ContentScreenResult;
}

const handlers = createContentScreenHandlers({
  enabled: phase5Live,
  session: loadRouteActor,
  load: loadCurrentContentScreen,
  acknowledge: (input) => createOnboardingEvidenceRepository().acknowledgeContentScreen(input),
});

export const GET = handlers.GET;
export const POST = handlers.POST;
