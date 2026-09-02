import { loadAlertActor, type AlertActor } from "@/lib/auth/actors";
import {
  platformConversationQueueLive,
  readPlatformHumanConversationQueue,
  type PlatformHumanConversationQueue,
} from "@/lib/platform/conversation-projection";

const NO_STORE = { "Cache-Control": "no-store" };
const HUMAN_QUEUE_ROLES = new Set(["owner", "admin", "success"]);

type PlatformConversationQueueDependencies = {
  enabled(): boolean;
  session(): Promise<AlertActor | null>;
  read(actorId: string): Promise<PlatformHumanConversationQueue>;
};

/**
 * Read-only platform queue. There is intentionally no tenant id in the request contract: staff
 * either receive the database-authorized cross-tenant projection or no row at all.
 */
export function createPlatformConversationQueueHandler(dependencies: PlatformConversationQueueDependencies) {
  return async function GET(_request?: Request) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    }
    const actor = await dependencies.session();
    if (!actor) {
      return Response.json({ error: "Authentication required." }, { status: 401, headers: NO_STORE });
    }
    if (!HUMAN_QUEUE_ROLES.has(actor.role ?? "")) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: NO_STORE });
    }
    try {
      const queue = await dependencies.read(actor.userId);
      return Response.json({ queue }, { headers: NO_STORE });
    } catch (cause) {
      console.error(
        "/api/platform/conversations failed.",
        cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
      );
      return Response.json({ error: "Human conversation queue is unavailable." }, {
        status: 503,
        headers: NO_STORE,
      });
    }
  };
}

export const GET = createPlatformConversationQueueHandler({
  enabled: platformConversationQueueLive,
  session: loadAlertActor,
  read: readPlatformHumanConversationQueue,
});
