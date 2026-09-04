import { createLiveBillingOperations, type BillingOperations } from "@/lib/billing/operations";
import { createLiveBillingNotificationPort } from "@/lib/notifications/billing-events";
import { phase6Live } from "@/lib/env-contract";
import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import {
  createBillingRepository,
  type BillingRepository,
  type CoachBillingRead,
} from "@/lib/repositories/billing";

const headers = { "Cache-Control": "no-store" };

type Dependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  operations: Pick<
    BillingOperations, "requestCorrection" | "requestPeriodCorrection" | "recordAttendance"
  > & {
    skipAttendance: BillingRepository["skipAttendance"];
  };
};

type ReadDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  load(tenantId: string): Promise<CoachBillingRead | null>;
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export function createBillingCorrectionsHandler(dependencies: Dependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers });
    const actor = await dependencies.session();
    if (!actor || !["coach", "coach_member"].includes(actor.role ?? "")) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers });
    }
    try {
      const body: unknown = await request.json();
      if (!record(body) || typeof body.action !== "string") throw new Error("INVALID_BODY");
      if (body.action === "request_correction") {
        if (
          !hasExactKeys(body, ["action", "eventId", "quantityDelta", "reason"])
          || typeof body.eventId !== "string" || !body.eventId.trim()
          || !Number.isSafeInteger(body.quantityDelta) || body.quantityDelta === 0
          || typeof body.reason !== "string" || !body.reason.trim()
        ) throw new Error("INVALID_BODY");
        const result = await dependencies.operations.requestCorrection({
          tenantId: actor.tenantId,
          eventId: body.eventId,
          quantityDelta: body.quantityDelta as number,
          reason: body.reason,
        });
        return Response.json({ result }, { headers });
      }
      if (body.action === "request_period_correction") {
        if (
          !hasExactKeys(body, ["action", "reason"])
          || typeof body.reason !== "string" || !body.reason.trim()
        ) throw new Error("INVALID_BODY");
        const result = await dependencies.operations.requestPeriodCorrection({
          tenantId: actor.tenantId,
          reason: body.reason,
        });
        return Response.json({ result }, { headers });
      }
      if (body.action === "record_attendance") {
        if (
          !hasExactKeys(body, ["action", "appointmentId", "status"])
          || typeof body.appointmentId !== "string" || !body.appointmentId.trim()
          || (body.status !== "completed" && body.status !== "no_show")
        ) throw new Error("INVALID_BODY");
        const result = await dependencies.operations.recordAttendance({
          actorId: actor.userId,
          tenantId: actor.tenantId,
          appointmentId: body.appointmentId,
          status: body.status,
        });
        return Response.json({ result }, { headers });
      }
      if (body.action === "skip_attendance") {
        if (
          !hasExactKeys(body, ["action", "appointmentId", "idempotencyKey"])
          || typeof body.appointmentId !== "string" || !body.appointmentId.trim()
          || typeof body.idempotencyKey !== "string"
          || !body.idempotencyKey.trim() || body.idempotencyKey.trim().length > 128
        ) throw new Error("INVALID_BODY");
        const result = await dependencies.operations.skipAttendance({
          actorId: actor.userId,
          tenantId: actor.tenantId,
          appointmentId: body.appointmentId.trim(),
          idempotencyKey: body.idempotencyKey.trim(),
        });
        return Response.json({ appointment: result.appointment }, { headers });
      }
      throw new Error("INVALID_ACTION");
    } catch {
      return Response.json({ error: "Billing correction was refused." }, { status: 409, headers });
    }
  };
}

export function createCoachBillingSnapshotHandler(dependencies: ReadDependencies) {
  return async function GET(request: Request) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers });
    }
    const actor = await dependencies.session();
    if (!actor || !["coach", "coach_member"].includes(actor.role ?? "")) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers });
    }
    if ([...new URL(request.url).searchParams.keys()].length > 0) {
      return Response.json(
        { error: "Billing selectors are not accepted." },
        { status: 400, headers },
      );
    }
    try {
      return Response.json(
        { snapshot: await dependencies.load(actor.tenantId) },
        { headers },
      );
    } catch (cause) {
      console.error(
        "/api/billing/corrections failed.",
        cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
      );
      return Response.json(
        { error: "Billing details are temporarily unavailable." },
        { status: 503, headers },
      );
    }
  };
}

const repository = createBillingRepository();
const operations = {
  ...createLiveBillingOperations(createLiveBillingNotificationPort()),
  skipAttendance: (input: Parameters<BillingRepository["skipAttendance"]>[0]) =>
    repository.skipAttendance(input),
};
export const POST = createBillingCorrectionsHandler({
  enabled: phase6Live,
  session: loadRouteActor,
  operations,
});

export const GET = createCoachBillingSnapshotHandler({
  enabled: phase6Live,
  session: loadRouteActor,
  load: (tenantId) => repository.loadOwnBilling(tenantId),
});
