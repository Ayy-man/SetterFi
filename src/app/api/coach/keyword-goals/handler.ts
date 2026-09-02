import { hasImpersonationMarker } from "@/lib/auth/claims";
import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import {
  createKeywordGoalRepository,
  type KeywordGoalRepository,
  type KeywordGoalWrite,
} from "@/lib/repositories/keyword-goals";
import {
  hasExactKeys,
  isRouteRecord,
  PHASE2_NO_STORE_HEADERS,
} from "@/app/api/admin/brain/import/handler";

type Dependencies = {
  session(): Promise<RouteActor | null>;
  list: KeywordGoalRepository["list"];
  save: KeywordGoalRepository["save"];
  deactivate: KeywordGoalRepository["deactivate"];
};

const WRITE_KEYS = [
  "id", "keyword", "goal", "resourceUrl", "resourceMessage", "postBookingUrl",
  "postBookingMessage",
] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function coach(actor: RouteActor | null): actor is RouteActor {
  return Boolean(
    actor && (actor.role === "coach" || actor.role === "coach_member") &&
    !hasImpersonationMarker(actor),
  );
}

function textOrNull(value: unknown, maximum: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("KEYWORD_GOAL_BODY_INVALID");
  const result = value.trim();
  if (!result || result.length > maximum) throw new Error("KEYWORD_GOAL_BODY_INVALID");
  return result;
}

function httpsOrNull(value: unknown): string | null {
  const result = textOrNull(value, 2_000);
  if (result === null) return null;
  let url: URL;
  try { url = new URL(result); } catch { throw new Error("KEYWORD_GOAL_URL_INVALID"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    throw new Error("KEYWORD_GOAL_URL_INVALID");
  }
  return result;
}

function parseWrite(raw: unknown): Omit<KeywordGoalWrite, "tenantId" | "actorId"> {
  if (!isRouteRecord(raw) || !hasExactKeys(raw, WRITE_KEYS)) {
    throw new Error("KEYWORD_GOAL_BODY_INVALID");
  }
  const id = raw.id === null ? null : textOrNull(raw.id, 36);
  if (id !== null && !UUID.test(id)) throw new Error("KEYWORD_GOAL_ID_INVALID");
  const keyword = textOrNull(raw.keyword, 120);
  if (!keyword || (raw.goal !== "resource" && raw.goal !== "book")) {
    throw new Error("KEYWORD_GOAL_BODY_INVALID");
  }
  const resourceUrl = httpsOrNull(raw.resourceUrl);
  const resourceMessage = textOrNull(raw.resourceMessage, 1_000);
  const postBookingUrl = httpsOrNull(raw.postBookingUrl);
  const postBookingMessage = textOrNull(raw.postBookingMessage, 1_000);
  if (
    (raw.goal === "resource" && resourceUrl === null) ||
    (raw.goal === "book" && (resourceUrl !== null || resourceMessage !== null))
  ) throw new Error("KEYWORD_GOAL_MODE_SHAPE_INVALID");
  return {
    id, keyword, goal: raw.goal, resourceUrl, resourceMessage, postBookingUrl, postBookingMessage,
  };
}

export function createCoachKeywordGoalHandlers(dependencies: Dependencies) {
  async function actorOrForbidden() {
    const actor = await dependencies.session();
    return coach(actor) ? actor : null;
  }

  async function GET() {
    const actor = await actorOrForbidden();
    if (!actor) return Response.json({ error: "Forbidden." }, { status: 403, headers: PHASE2_NO_STORE_HEADERS });
    try {
      return Response.json({ goals: await dependencies.list(actor.tenantId) }, {
        headers: PHASE2_NO_STORE_HEADERS,
      });
    } catch (error) {
      console.error(
        "/api/coach/keyword-goals unavailable.",
        error instanceof Error ? error.message : "KEYWORD_GOALS_READ_FAILED",
      );
      return Response.json({ code: "KEYWORD_GOALS_READ_FAILED" }, {
        status: 503, headers: PHASE2_NO_STORE_HEADERS,
      });
    }
  }

  async function PUT(request: Request) {
    const actor = await actorOrForbidden();
    if (!actor) return Response.json({ error: "Forbidden." }, { status: 403, headers: PHASE2_NO_STORE_HEADERS });
    try {
      const input = parseWrite(await request.json());
      const saved = await dependencies.save({
        tenantId: actor.tenantId, actorId: actor.userId, ...input,
      });
      return Response.json({
        goal: saved.goal,
        audit: { auditId: saved.auditId, actionKey: "keyword_goal.saved" },
      }, { headers: PHASE2_NO_STORE_HEADERS });
    } catch {
      return Response.json({ code: "KEYWORD_GOAL_SAVE_REFUSED" }, {
        status: 409, headers: PHASE2_NO_STORE_HEADERS,
      });
    }
  }

  async function DELETE(request: Request) {
    const actor = await actorOrForbidden();
    if (!actor) return Response.json({ error: "Forbidden." }, { status: 403, headers: PHASE2_NO_STORE_HEADERS });
    try {
      const raw: unknown = await request.json();
      if (!isRouteRecord(raw) || !hasExactKeys(raw, ["id"]) ||
        typeof raw.id !== "string" || !UUID.test(raw.id)) {
        throw new Error("KEYWORD_GOAL_ID_INVALID");
      }
      const result = await dependencies.deactivate({
        tenantId: actor.tenantId, actorId: actor.userId, id: raw.id,
      });
      return Response.json({
        goal: result.goal,
        audit: { auditId: result.auditId, actionKey: "keyword_goal.deactivated" },
      }, { headers: PHASE2_NO_STORE_HEADERS });
    } catch {
      return Response.json({ code: "KEYWORD_GOAL_DEACTIVATE_REFUSED" }, {
        status: 409, headers: PHASE2_NO_STORE_HEADERS,
      });
    }
  }

  return { GET, PUT, DELETE };
}

const handlers = createCoachKeywordGoalHandlers({
  session: loadRouteActor,
  list: (tenantId) => createKeywordGoalRepository().list(tenantId),
  save: (input) => createKeywordGoalRepository().save(input),
  deactivate: (input) => createKeywordGoalRepository().deactivate(input),
});

export const GET = handlers.GET;
export const PUT = handlers.PUT;
export const DELETE = handlers.DELETE;
