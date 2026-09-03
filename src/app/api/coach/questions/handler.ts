/**
 * `/api/coach/questions` -- the tenant-scoped read and the two audited writes behind step 3 of
 * `/coach/agent`.
 *
 * Shaped after `/api/coach/keyword-goals`: the browser never names a tenant or an actor, the
 * signed coach's claims are what reach the repository, and an impersonating session is refused
 * outright because a view-as operator must not reorder somebody else's agent. Every write returns
 * the canonical list the repository read back, so the screen redraws from storage rather than from
 * its own optimistic guess.
 */

import { hasImpersonationMarker } from "@/lib/auth/claims";
import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import {
  readCoachQuestions,
  reorderCoachQuestions,
  setCoachQuestionEnabled,
  type CoachQuestion,
  type CoachQuestionActor,
} from "@/lib/repositories/coach-questions";
import {
  hasExactKeys,
  isRouteRecord,
  PHASE2_NO_STORE_HEADERS,
} from "@/app/api/admin/brain/import/handler";

type WriteResult = { questions: readonly CoachQuestion[]; auditId: string };

type Dependencies = {
  session(): Promise<RouteActor | null>;
  read(actor: CoachQuestionActor): Promise<readonly CoachQuestion[]>;
  reorder(actor: CoachQuestionActor, questionIds: readonly string[]): Promise<WriteResult>;
  toggle(actor: CoachQuestionActor, questionId: string, enabled: boolean): Promise<WriteResult>;
};

/** The registry spellings the two RPCs write, mirrored so the screen can check what it got. */
export const COACH_QUESTION_ORDER_ACTION = "coach.question_order.saved";
export const COACH_QUESTION_ENABLED_ACTION = "coach.question.enabled.changed";

function coach(actor: RouteActor | null): actor is RouteActor {
  return Boolean(
    actor && (actor.role === "coach" || actor.role === "coach_member") &&
    !hasImpersonationMarker(actor),
  );
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 64) {
    throw new Error("COACH_QUESTION_ID_INVALID");
  }
  return value.trim();
}

function parseOrder(raw: unknown): readonly string[] {
  if (!isRouteRecord(raw) || !hasExactKeys(raw, ["questionIds"]) || !Array.isArray(raw.questionIds)) {
    throw new Error("COACH_QUESTION_BODY_INVALID");
  }
  const ids = raw.questionIds.map(identifier);
  if (ids.length < 1 || new Set(ids).size !== ids.length) {
    throw new Error("COACH_QUESTION_ORDER_INVALID");
  }
  return ids;
}

function parseToggle(raw: unknown): { questionId: string; enabled: boolean } {
  if (!isRouteRecord(raw) || !hasExactKeys(raw, ["questionId", "enabled"])
    || typeof raw.enabled !== "boolean") {
    throw new Error("COACH_QUESTION_BODY_INVALID");
  }
  return { questionId: identifier(raw.questionId), enabled: raw.enabled };
}

export function createCoachQuestionHandlers(dependencies: Dependencies) {
  async function actorOrForbidden() {
    const actor = await dependencies.session();
    return coach(actor) ? actor : null;
  }

  function forbidden() {
    return Response.json({ error: "Forbidden." }, { status: 403, headers: PHASE2_NO_STORE_HEADERS });
  }

  async function GET() {
    const actor = await actorOrForbidden();
    if (!actor) return forbidden();
    try {
      const questions = await dependencies.read({
        userId: actor.userId,
        tenantId: actor.tenantId,
      });
      return Response.json({ questions }, { headers: PHASE2_NO_STORE_HEADERS });
    } catch (error) {
      console.error(
        "/api/coach/questions unavailable.",
        error instanceof Error ? error.message : "COACH_QUESTION_READ_FAILED",
      );
      return Response.json({ code: "COACH_QUESTION_READ_FAILED" }, {
        status: 503, headers: PHASE2_NO_STORE_HEADERS,
      });
    }
  }

  async function PUT(request: Request) {
    const actor = await actorOrForbidden();
    if (!actor) return forbidden();
    try {
      const questionIds = parseOrder(await request.json());
      const result = await dependencies.reorder(
        { userId: actor.userId, tenantId: actor.tenantId },
        questionIds,
      );
      return Response.json({
        questions: result.questions,
        audit: { auditId: result.auditId, actionKey: COACH_QUESTION_ORDER_ACTION },
      }, { headers: PHASE2_NO_STORE_HEADERS });
    } catch {
      return Response.json({ code: "COACH_QUESTION_REORDER_REFUSED" }, {
        status: 409, headers: PHASE2_NO_STORE_HEADERS,
      });
    }
  }

  async function PATCH(request: Request) {
    const actor = await actorOrForbidden();
    if (!actor) return forbidden();
    try {
      const { questionId, enabled } = parseToggle(await request.json());
      const result = await dependencies.toggle(
        { userId: actor.userId, tenantId: actor.tenantId },
        questionId,
        enabled,
      );
      return Response.json({
        questions: result.questions,
        audit: { auditId: result.auditId, actionKey: COACH_QUESTION_ENABLED_ACTION },
      }, { headers: PHASE2_NO_STORE_HEADERS });
    } catch {
      return Response.json({ code: "COACH_QUESTION_TOGGLE_REFUSED" }, {
        status: 409, headers: PHASE2_NO_STORE_HEADERS,
      });
    }
  }

  return { GET, PUT, PATCH };
}

const handlers = createCoachQuestionHandlers({
  session: loadRouteActor,
  read: (actor) => readCoachQuestions(actor),
  reorder: (actor, questionIds) => reorderCoachQuestions(actor, questionIds),
  toggle: (actor, questionId, enabled) => setCoachQuestionEnabled(actor, questionId, enabled),
});

export const GET = handlers.GET;
export const PUT = handlers.PUT;
export const PATCH = handlers.PATCH;
