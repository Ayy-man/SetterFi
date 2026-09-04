import { claim } from "@/lib/audit";
import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { inboxVerbsLive, phase3Live } from "@/lib/env-contract";
import { canWriteConversation, conversationMutationRefusal } from "@/lib/conversation-state";
import { getConversation, type ConversationRead } from "@/lib/repositories/conversations";

export { loadRouteActor, type RouteActor } from "@/lib/auth/actors";

const noStoreHeaders = { "Cache-Control": "no-store" };

type ClaimDependencies = {
  enabled?(): boolean;
  session(): Promise<RouteActor | null>;
  claim: typeof claim;
  loadConversation(tenantId: string, conversationId: string): Promise<ConversationRead>;
};

export function conversationResponse(
  conversation: ConversationRead,
  options: { allowWebchat?: boolean } = {},
) {
  if (conversation.channel === "webchat" && !options.allowWebchat) {
    throw new Error("CONVERSATION_CHANNEL_UNSUPPORTED");
  }
  return {
    id: conversation.id,
    contactId: conversation.contactId,
    contactName: conversation.contactName,
    channel: conversation.channel,
    status: conversation.status,
    statusReason: conversation.statusReason,
    takenOverBy: conversation.takenOverBy,
    unreadByCoach: conversation.unreadByCoach,
    disclosurePending: conversation.disclosurePending,
    isDemo: conversation.isDemo,
    isTest: conversation.isTest,
    qualification: { ...conversation.qualification },
    appointment: conversation.appointment ? { ...conversation.appointment } : null,
    proposedSlots: conversation.proposedSlots
      ? { ...conversation.proposedSlots, slots: conversation.proposedSlots.slots.map((slot) => ({ ...slot })) }
      : null,
    messages: conversation.messages.map((message) => ({ ...message })),
  };
}

export async function loadConversationForRoute(tenantId: string, conversationId: string) {
  const conversation = await getConversation(tenantId, conversationId);
  if (conversation) return conversation;
  throw new Error("CONVERSATION_NOT_FOUND");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createClaimHandler(dependencies: ClaimDependencies) {
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
      const body: unknown = await request.json();
      if (!isRecord(body)) throw new Error("INVALID_BODY");
      const expectedState = body.expectedState;
      const expectedHolderId = body.expectedHolderId;
      const confirmDisplace = body.confirmDisplace;
      if (
        typeof expectedState !== "string" ||
        !["agent", "needs_human", "human", "nurture", "closed", "scope_blocked", "opted_out"].includes(expectedState) ||
        (expectedHolderId !== null && typeof expectedHolderId !== "string") ||
        typeof confirmDisplace !== "boolean"
      ) throw new Error("INVALID_BODY");
      const { id } = await context.params;
      const result = await dependencies.claim(actor.tenantId, {
        conversationId: id,
        actorId: actor.userId,
        expectedStatus: expectedState as Parameters<typeof claim>[1]["expectedStatus"],
        expectedHolderId,
        confirmDisplace,
      });
      const conversation = await dependencies.loadConversation(actor.tenantId, id);
      return Response.json({ conversation: conversationResponse(conversation), audit: result.audit }, { headers: noStoreHeaders });
    } catch (error) {
      return Response.json(conversationMutationRefusal(error), { status: 409, headers: noStoreHeaders });
    }
  };
}

export const POST = createClaimHandler({
  enabled: () => phase3Live() && inboxVerbsLive(),
  session: loadRouteActor,
  claim,
  loadConversation: loadConversationForRoute,
});
