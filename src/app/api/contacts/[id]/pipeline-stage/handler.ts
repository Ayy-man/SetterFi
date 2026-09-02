import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { phase1Live, phase3Live, pipelineWriteLive } from "@/lib/env-contract";
import {
  PIPELINE_STAGES,
  type PipelineStage,
} from "@/lib/pipeline/transitions";
import { setPipelineStage } from "@/lib/repositories/contacts";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const BODY_KEYS = [
  "stage",
  "expectedStage",
  "reason",
  "appointmentId",
  "idempotencyKey",
] as const;
const ALLOWED_ROLES = ["coach", "coach_member", "owner", "admin", "success"] as const;

type PipelineStageBody = {
  stage: PipelineStage;
  expectedStage: PipelineStage;
  reason: string | null;
  appointmentId: string | null;
  idempotencyKey: string;
};

type PipelineStageRouteDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  setStage: typeof setPipelineStage;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function isPipelineStage(value: unknown): value is PipelineStage {
  return typeof value === "string" && PIPELINE_STAGES.includes(value as PipelineStage);
}

function parseBody(value: unknown): PipelineStageBody | null {
  if (!isRecord(value) || !hasExactKeys(value, BODY_KEYS) ||
    !isPipelineStage(value.stage) || !isPipelineStage(value.expectedStage) ||
    (value.reason !== null && typeof value.reason !== "string") ||
    (typeof value.reason === "string" && value.reason.length > 500) ||
    (value.appointmentId !== null &&
      (typeof value.appointmentId !== "string" || value.appointmentId.trim().length === 0)) ||
    typeof value.idempotencyKey !== "string") {
    return null;
  }
  const idempotencyKey = value.idempotencyKey.trim();
  if (idempotencyKey.length < 1 || idempotencyKey.length > 128) return null;
  return {
    stage: value.stage,
    expectedStage: value.expectedStage,
    reason: value.reason === null ? null : value.reason.trim(),
    appointmentId: value.appointmentId === null ? null : value.appointmentId.trim(),
    idempotencyKey,
  };
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: NO_STORE_HEADERS });
}

function refused(error: unknown) {
  const code = error instanceof Error ? error.message : "PIPELINE_STAGE_REFUSED";
  const reasons: Array<[string, string]> = [
    ["PIPELINE_EXPECTED_STAGE_STALE", "This contact moved before your change. Refresh and try again."],
    ["PIPELINE_SAME_STAGE", "This contact is already in that pipeline stage."],
    ["PIPELINE_BOOKED_REQUIRES_APPOINTMENT", "Moving to Booked requires an appointment."],
    ["PIPELINE_BOOKED_APPOINTMENT_MISMATCH", "That appointment does not belong to this contact."],
    ["PIPELINE_BOOKED_APPOINTMENT_INVALID_STATUS", "Only a scheduled or confirmed appointment can mark this contact Booked."],
    ["PIPELINE_NO_SHOW_REQUIRES_LATEST_APPOINTMENT", "The latest appointment must be marked no-show before this move."],
    ["EXPECTED_TENANT_MISMATCH", "This contact is not available in this workspace."],
    ["CONTACT_NOT_FOUND", "This contact no longer exists in this workspace."],
  ];
  const reason = reasons.find(([candidate]) => code.includes(candidate));
  console.error(
    "Pipeline stage change refused.",
    code,
  );
  return json({
    code: reason?.[0] ?? "PIPELINE_STAGE_REFUSED",
    message: reason?.[1] ?? "The stage could not be changed. Refresh the contact and try again.",
  }, 409);
}

export function createPipelineStageHandler(dependencies: PipelineStageRouteDependencies) {
  return async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    if (!dependencies.enabled()) return json({ error: "Not found." }, 404);

    const actor = await dependencies.session();
    if (!actor) return json({ error: "Authentication required." }, 401);
    if (hasImpersonationMarker(actor)) {
      return json({ message: "Impersonated sessions are read-only" }, 403);
    }
    if (!ALLOWED_ROLES.some((role) => role === actor.role)) {
      return json({ error: "Forbidden." }, 403);
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return json({ message: "The request body is invalid." }, 400);
    }
    const body = parseBody(rawBody);
    const contactId = (await context.params).id.trim();
    if (!body || !contactId) return json({ message: "The request body is invalid." }, 400);

    const mutation = {
      contactId,
      expectedStage: body.expectedStage,
      stage: body.stage,
      setBy: "user" as const,
      actorId: actor.userId,
      reason: body.reason,
      appointmentId: body.appointmentId,
      idempotencyKey: body.idempotencyKey,
    };

    try {
      const result = await dependencies.setStage(actor.tenantId, mutation);
      return json(result);
    } catch (error) {
      return refused(error);
    }
  };
}

function enabled() {
  return phase1Live() && phase3Live() && pipelineWriteLive();
}

export const POST = createPipelineStageHandler({
  enabled,
  session: loadRouteActor,
  setStage: setPipelineStage,
});
