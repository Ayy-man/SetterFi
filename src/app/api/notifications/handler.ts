import { loadAlertActor, type AlertActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { phase8AlertsLive } from "@/lib/env-contract";
import { createBellRepository, type BellRepository } from "@/lib/notifications/bell";

export { loadAlertActor } from "@/lib/auth/actors";

const headers = { "Cache-Control": "no-store" };
type Dependencies = {
  enabled(): boolean;
  session(): Promise<AlertActor | null>;
  repository(): BellRepository;
};

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

function parsePage(request: Request) {
  const url = new URL(request.url);
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? DEFAULT_PAGE_SIZE : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) return null;
  const rawCursor = url.searchParams.get("cursor");
  if (rawCursor === null) return { limit, cursor: null };
  try {
    const value = JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const cursor = value as { createdAt?: unknown; id?: unknown };
    if (typeof cursor.createdAt !== "string" || !Number.isFinite(Date.parse(cursor.createdAt))
      || typeof cursor.id !== "string" || !cursor.id) return null;
    return { limit, cursor: { createdAt: cursor.createdAt, id: cursor.id } };
  } catch {
    return null;
  }
}

function pageCursor(cursor: { createdAt: string; id: string } | null) {
  return cursor === null ? null : Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function createNotificationsHandlers(dependencies: Dependencies) {
  return {
    GET: async (request: Request) => {
      if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers });
      const actor = await dependencies.session();
      if (!actor || hasImpersonationMarker(actor)) return Response.json({ error: "Authentication required." }, { status: 401, headers });
      const page = parsePage(request);
      if (!page) return Response.json({ error: "Invalid page." }, { status: 400, headers });
      try {
        const repository = dependencies.repository();
        const [result, unreadCount] = await Promise.all([
          repository.list({ userId: actor.userId, ...page }),
          repository.unreadCount(actor.userId),
        ]);
        return Response.json({
          notifications: result.notifications,
          unreadCount,
          page: { limit: page.limit, nextCursor: pageCursor(result.nextCursor) },
        }, { headers });
      } catch (cause) {
        console.error(
          "/api/notifications failed.",
          cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
        );
        return Response.json({ error: "Notifications unavailable." }, { status: 503, headers });
      }
    },
    PUT: async (request: Request) => {
      if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers });
      const actor = await dependencies.session();
      if (!actor || hasImpersonationMarker(actor)) return Response.json({ error: "Authentication required." }, { status: 401, headers });
      try {
        const body: unknown = await request.json();
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return Response.json({ error: "Invalid request." }, { status: 400, headers });
        }
        const value = body as Record<string, unknown>;
        if (Object.keys(value).length === 1 && value.markAll === true) {
          return Response.json({ markedCount: await dependencies.repository().markAllRead() }, { headers });
        }
        if (Object.keys(value).length === 1 && typeof value.notificationId === "string" && value.notificationId) {
          return Response.json({
            notification: await dependencies.repository().markRead(actor.userId, value.notificationId),
          }, { headers });
        }
        return Response.json({ error: "Invalid request." }, { status: 400, headers });
      } catch {
        return Response.json({ error: "Notification update refused." }, { status: 409, headers });
      }
    },
  };
}

const handlers = createNotificationsHandlers({
  enabled: phase8AlertsLive,
  session: loadAlertActor,
  repository: createBellRepository,
});
export const GET = handlers.GET;
export const PUT = handlers.PUT;
