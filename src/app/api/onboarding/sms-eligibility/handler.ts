import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { phase5Live } from "@/lib/env-contract";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };

export type SmsEligibilityScreen = {
  screenId: string;
  state: "clean" | "flagged" | "confirmed";
  matches: unknown[];
  coachAcknowledgedAt: string | null;
  adminConfirmedAt: string | null;
};

export type SmsRegistration = { submittedAt: string | null; state: string | null };

export type SmsEligibilityDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  load(tenantId: string): Promise<SmsEligibilityScreen | null>;
  registration?(tenantId: string): Promise<SmsRegistration | null>;
  acknowledge(input: { tenantId: string; screenId: string; actorId: string }): Promise<{ auditId: string }>;
};

function exactBody(value: unknown): value is { screenId: string } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 1 && typeof (value as { screenId?: unknown }).screenId === "string"
    && Boolean((value as { screenId: string }).screenId.trim());
}

function refuse(actor: RouteActor | null) {
  if (!actor) return Response.json({ error: "Authentication required." }, { status: 401, headers: NO_STORE });
  if (hasImpersonationMarker(actor)) {
    return Response.json({ error: "Impersonated sessions are read-only." }, { status: 403, headers: NO_STORE });
  }
  if (actor.role !== "coach") return Response.json({ error: "Forbidden." }, { status: 403, headers: NO_STORE });
  return null;
}

export function createSmsEligibilityHandlers(dependencies: SmsEligibilityDependencies) {
  return {
    GET: async () => {
      if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
      const actor = await dependencies.session();
      const rejected = refuse(actor);
      if (rejected || !actor) return rejected!;
      try {
        const [screen, registration] = await Promise.all([
          dependencies.load(actor.tenantId), dependencies.registration?.(actor.tenantId) ?? null,
        ]);
        return Response.json({ screen, registration }, { headers: NO_STORE });
      } catch (cause) {
        console.error(
          "/api/onboarding/sms-eligibility failed.",
          cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
        );
        return Response.json({ error: "SMS eligibility is unavailable." }, { status: 503, headers: NO_STORE });
      }
    },
    POST: async (request: Request) => {
      if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
      const actor = await dependencies.session();
      const rejected = refuse(actor);
      if (rejected || !actor) return rejected!;
      const body = await request.json().catch(() => null);
      if (!exactBody(body)) return Response.json({ error: "Invalid eligibility acknowledgement." }, { status: 400, headers: NO_STORE });
      try {
        const receipt = await dependencies.acknowledge({ tenantId: actor.tenantId, screenId: body.screenId, actorId: actor.userId });
        if (!receipt.auditId.trim()) throw new Error("SMS_ELIGIBILITY_AUDIT_REQUIRED");
        return Response.json({ screenId: body.screenId, receipt: { auditId: receipt.auditId, actionKey: "onboarding.content_acknowledged" } }, { headers: NO_STORE });
      } catch {
        return Response.json({ error: "Eligibility acknowledgement was refused." }, { status: 409, headers: NO_STORE });
      }
    },
  };
}

const handlers = createSmsEligibilityHandlers({
  enabled: phase5Live,
  session: loadRouteActor,
  load: async (tenantId) => {
    const client = createSupabaseServiceClient();
    const { data, error } = await client.from("onboarding_content_screens")
      .select("id, result, matches, acknowledged_at, admin_confirmed_at")
      .eq("tenant_id", tenantId).eq("is_current", true).maybeSingle();
    if (error) throw new Error("SMS_ELIGIBILITY_READ_FAILED");
    if (!data) return null;
    return {
      screenId: data.id, state: data.result === "clean" ? "clean" : data.admin_confirmed_at ? "confirmed" : "flagged",
      matches: Array.isArray(data.matches) ? data.matches : [], coachAcknowledgedAt: data.acknowledged_at,
      adminConfirmedAt: data.admin_confirmed_at,
    } as SmsEligibilityScreen;
  },
  acknowledge: async (input) => {
    const client = createSupabaseServiceClient();
    const { data, error } = await client.rpc("acknowledge_onboarding_content_screen", {
      p_expected_tenant: input.tenantId, p_screen_id: input.screenId, p_actor_id: input.actorId,
    });
    if (error || (typeof data !== "number" && typeof data !== "string")) throw new Error("SMS_ELIGIBILITY_ACK_FAILED");
    return { auditId: String(data) };
  },
  registration: async (tenantId) => {
    const client = createSupabaseServiceClient();
    const { data, error } = await client.from("provisioning_steps")
      .select("state, external_ref").eq("tenant_id", tenantId).eq("step_key", "a2p_campaign").maybeSingle();
    if (error) throw new Error("SMS_REGISTRATION_READ_FAILED");
    const submittedAt = data?.external_ref && typeof data.external_ref === "object"
      && typeof (data.external_ref as Record<string, unknown>).submittedAt === "string"
      ? (data.external_ref as Record<string, unknown>).submittedAt as string
      : null;
    return data ? { submittedAt, state: data.state } : null;
  },
});

export const GET = handlers.GET;
export const POST = handlers.POST;
