import { POST as beginMetaConnection } from "@/app/api/channels/meta/connect/route";
import { POST as completeWhatsappSignup } from "@/app/api/channels/meta/embedded-signup/route";
import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { phase5Live } from "@/lib/env-contract";
import { PROVISIONING_STEPS, type ProvisioningStep } from "@/lib/onboarding/contracts";
import { PROVISIONING_STEP_REGISTRY } from "@/lib/onboarding/steps";

const NO_STORE = { "Cache-Control": "no-store" };

type StepActionDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  meta?: ((request: Request) => Promise<Response>) | null;
  whatsapp?: ((request: Request) => Promise<Response>) | null;
};

type StepActionBody = { action: "start"; input: Record<string, unknown> };

function parseBody(value: unknown): StepActionBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["action", "input"].includes(key))) return null;
  if (body.action !== "start" || !body.input || typeof body.input !== "object" || Array.isArray(body.input)) {
    return null;
  }
  return { action: "start", input: body.input as Record<string, unknown> };
}

function delegatedRequest(request: Request, path: string, input: Record<string, unknown>) {
  const headers = new Headers();
  for (const name of ["cookie", "origin", "x-forwarded-for", "x-real-ip"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("content-type", "application/json");
  return new Request(new URL(path, request.url), {
    method: "POST",
    headers,
    body: JSON.stringify(input),
  });
}

const ACTION_TARGETS: Readonly<Partial<Record<ProvisioningStep, string>>> = {
  sms_eligibility_screen: "/onboarding/sms-eligibility",
  business_profile: "/onboarding/business-profile",
  optin_artifact: "/api/onboarding/artifacts",
  calendar_connect: "/onboarding/calendar",
  offer_layer: "/coach/agent",
  go_live: "/api/onboarding/go-live",
};

export function createStepActionHandler(dependencies: StepActionDependencies) {
  return async function POST(
    request: Request,
    context: { params: Promise<{ step: string }> },
  ) {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    const actor = await dependencies.session();
    if (!actor) return Response.json({ error: "Authentication required." }, { status: 401, headers: NO_STORE });
    if (hasImpersonationMarker(actor)) return Response.json({ error: "Impersonated sessions are read-only." }, { status: 403, headers: NO_STORE });
    if (actor.role !== "coach") return Response.json({ error: "Forbidden." }, { status: 403, headers: NO_STORE });
    const { step: rawStep } = await context.params;
    if (!PROVISIONING_STEPS.includes(rawStep as ProvisioningStep)) {
      return Response.json({ error: "Provisioning step was not found." }, { status: 404, headers: NO_STORE });
    }
    const step = rawStep as ProvisioningStep;
    const definition = PROVISIONING_STEP_REGISTRY.find((candidate) => candidate.key === step)!;
    if (definition.owner !== "coach") {
      return Response.json({ error: "This step has no coach action." }, { status: 403, headers: NO_STORE });
    }
    let body: StepActionBody | null = null;
    try {
      body = parseBody(await request.json());
    } catch {
      body = null;
    }
    if (!body) return Response.json({ error: "Step action is invalid." }, { status: 400, headers: NO_STORE });

    try {
      if (step === "meta_connect") {
        if (typeof dependencies.meta !== "function") throw new Error("PHASE4_META_CONNECT_SEAM_MISSING");
        return dependencies.meta(delegatedRequest(request, "/api/channels/meta/connect", body.input));
      }
      if (step === "whatsapp_connect") {
        if (typeof dependencies.whatsapp !== "function") throw new Error("PHASE4_WHATSAPP_CONNECT_SEAM_MISSING");
        return dependencies.whatsapp(delegatedRequest(
          request,
          "/api/channels/meta/embedded-signup",
          body.input,
        ));
      }
      return Response.json({
        step,
        state: "action_required",
        actionTarget: ACTION_TARGETS[step],
      }, { status: 202, headers: NO_STORE });
    } catch (error) {
      const code = error instanceof Error && /^PHASE4_[A-Z0-9_]+_MISSING$/.test(error.message)
        ? error.message
        : null;
      return Response.json(
        code
          ? { error: "Required channel connection route is unavailable.", code }
          : { error: "Step action was refused." },
        { status: code ? 503 : 409, headers: NO_STORE },
      );
    }
  };
}

export const POST = createStepActionHandler({
  enabled: phase5Live,
  session: loadRouteActor,
  meta: beginMetaConnection,
  whatsapp: completeWhatsappSignup,
});
