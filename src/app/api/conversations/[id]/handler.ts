import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { phase1Live, phase3Live } from "@/lib/env-contract";
import { getConversation, type ConversationRead } from "@/lib/repositories/conversations";

import { conversationResponse } from "./claim/handler";

const noStoreHeaders = { "Cache-Control": "no-store" };

type ConversationDetailDependencies = {
  session(): Promise<RouteActor | null>;
  getConversation(tenantId: string, conversationId: string, actorId: string): Promise<ConversationRead | null>;
};

/** Stable thread read for deep links; acknowledgement is intentionally a separate POST. */
export function createConversationDetailHandler(dependencies: ConversationDetailDependencies) {
  return async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
    if (!phase1Live() || !phase3Live()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    const actor = await dependencies.session();
    if (!actor) {
      return Response.json({ error: "Authentication required." }, { status: 401, headers: noStoreHeaders });
    }
    try {
      const { id } = await context.params;
      const conversation = await dependencies.getConversation(actor.tenantId, id, actor.userId);
      if (!conversation) {
        return Response.json({ error: "Conversation not found." }, { status: 404, headers: noStoreHeaders });
      }
      return Response.json({
        conversation: conversationResponse(conversation, { allowWebchat: true }),
      }, { headers: noStoreHeaders });
    } catch {
      return Response.json({ error: "Conversation not found." }, { status: 404, headers: noStoreHeaders });
    }
  };
}

export const GET = createConversationDetailHandler({
  session: loadRouteActor,
  getConversation,
});
