import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { phase1Live, phase3Live } from "@/lib/env-contract";
import {
  acknowledgeConversationRead,
  getConversation,
  type ConversationRead,
} from "@/lib/repositories/conversations";

import { conversationResponse } from "../claim/handler";

const noStoreHeaders = { "Cache-Control": "no-store" };

type ConversationReadDependencies = {
  session(): Promise<RouteActor | null>;
  acknowledge: typeof acknowledgeConversationRead;
  getConversation(tenantId: string, conversationId: string): Promise<ConversationRead | null>;
};

/** POST keeps acknowledgement explicit, so a prefetch cannot silently mark a thread as read. */
export function createConversationReadHandler(dependencies: ConversationReadDependencies) {
  return async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
    if (!phase1Live() || !phase3Live()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    const actor = await dependencies.session();
    if (!actor) {
      return Response.json({ error: "Authentication required." }, { status: 401, headers: noStoreHeaders });
    }
    try {
      const { id } = await context.params;
      await dependencies.acknowledge({
        tenantId: actor.tenantId,
        conversationId: id,
        actorId: actor.userId,
      });
      const conversation = await dependencies.getConversation(actor.tenantId, id);
      if (!conversation || conversation.unreadByCoach) throw new Error("CONVERSATION_READBACK_INVALID");
      return Response.json({
        conversation: conversationResponse(conversation, { allowWebchat: true }),
      }, { headers: noStoreHeaders });
    } catch {
      // A tenant mismatch is deliberately indistinguishable from a missing thread.
      return Response.json({ error: "Conversation read was refused." }, { status: 409, headers: noStoreHeaders });
    }
  };
}

export const POST = createConversationReadHandler({
  session: loadRouteActor,
  acknowledge: acknowledgeConversationRead,
  getConversation,
});
