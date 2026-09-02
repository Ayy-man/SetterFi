import { release } from "@/lib/audit";
import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { canWriteConversation, conversationMutationRefusal } from "@/lib/conversation-state";
import { inboxVerbsLive, phase3Live } from "@/lib/env-contract";

import {
  conversationResponse,
  loadConversationForRoute,
} from "../claim/handler";

const noStoreHeaders = { "Cache-Control": "no-store" };

type ReleaseDependencies = {
  enabled?(): boolean;
  session(): Promise<RouteActor | null>;
  release: typeof release;
  loadConversation: typeof loadConversationForRoute;
};

export function createReleaseHandler(dependencies: ReleaseDependencies) {
  return async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    if (!(dependencies.enabled ?? (() => true))()) {
      return Response.json({
        code: "INBOX_VERBS_DISABLED",
        message: "Conversation actions are disabled until the controlled inbox rollout is enabled.",
      }, { status: 409, headers: noStoreHeaders });
    }
    const actor = await dependencies.session();
    if (!actor) return Response.json({ error: "Authentication required." }, { status: 401, headers: noStoreHeaders });
    if (hasImpersonationMarker(actor)) {
      return Response.json({ message: "Impersonated sessions are read-only" }, { status: 403, headers: noStoreHeaders });
    }
    if (!canWriteConversation(actor.role)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: noStoreHeaders });
    }
    try {
      const body = await request.json() as { expectedHolderId?: unknown };
      if (typeof body.expectedHolderId !== "string" || !body.expectedHolderId.trim()) {
        throw new Error("EXPECTED_HOLDER_REQUIRED");
      }
      const { id } = await context.params;
      const result = await dependencies.release(actor.tenantId, {
        conversationId: id,
        actorId: actor.userId,
        expectedHolderId: body.expectedHolderId,
      });
      const conversation = await dependencies.loadConversation(actor.tenantId, id);
      if (!conversation.disclosurePending) throw new Error("DISCLOSURE_READBACK_REQUIRED");
      return Response.json({ conversation: conversationResponse(conversation), audit: result.audit }, { headers: noStoreHeaders });
    } catch (error) {
      return Response.json(conversationMutationRefusal(error), { status: 409, headers: noStoreHeaders });
    }
  };
}

export const POST = createReleaseHandler({
  enabled: () => phase3Live() && inboxVerbsLive(),
  session: loadRouteActor,
  release,
  loadConversation: loadConversationForRoute,
});
