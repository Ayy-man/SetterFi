/**
 * "Send as the lead" on a demo tenant's test thread.
 *
 * The body carries only the lead's words. Tenant, actor, thread eligibility, the receipt and the
 * engine run are all server-owned, and the response is the reloaded conversation plus a receipt
 * that says exactly what happened, including the processor's error code when it did not finish.
 */

import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { canWriteConversation } from "@/lib/conversation-state";
import { simulatedSendsLive } from "@/lib/env-contract";
import { rehearsalBody, rehearseLeadTurn, type RehearsalOutcome } from "@/lib/webhooks/rehearsal";

import { conversationResponse, loadConversationForRoute } from "../claim/handler";

const noStoreHeaders = { "Cache-Control": "no-store" };

export type RehearseDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  rehearse(input: { tenantId: string; conversationId: string; actorId: string; body: string }): Promise<RehearsalOutcome>;
  loadConversation: typeof loadConversationForRoute;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const REFUSALS: Record<string, { status: number; message: string }> = {
  REHEARSAL_CONVERSATION_NOT_FOUND: { status: 404, message: "That thread was not found." },
  REHEARSAL_THREAD_NOT_REHEARSABLE: {
    status: 409,
    message: "Only a test thread on a demo workspace can be rehearsed.",
  },
  REHEARSAL_IDENTITY_REQUIRED: {
    status: 409,
    message: "This thread has no lead identity on its channel, so there is nobody to speak as.",
  },
};

export function createRehearseHandler(dependencies: RehearseDependencies) {
  return async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    const actor = await dependencies.session();
    if (!actor) return Response.json({ error: "Authentication required." }, { status: 401, headers: noStoreHeaders });
    if (hasImpersonationMarker(actor)) {
      return Response.json({ message: "Impersonated sessions are read-only" }, { status: 403, headers: noStoreHeaders });
    }
    if (!canWriteConversation(actor.role)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: noStoreHeaders });
    }
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      payload = null;
    }
    const body = isRecord(payload) && Object.keys(payload).join(",") === "body" ? rehearsalBody(payload.body) : null;
    if (!body) {
      return Response.json({
        code: "REHEARSAL_BODY_INVALID",
        message: "Write what the lead would say, up to 1,000 characters.",
      }, { status: 400, headers: noStoreHeaders });
    }
    const { id } = await context.params;
    let outcome: RehearsalOutcome;
    try {
      outcome = await dependencies.rehearse({
        tenantId: actor.tenantId,
        conversationId: id,
        actorId: actor.userId,
        body,
      });
    } catch (error) {
      const code = error instanceof Error ? error.message.split(":", 1)[0] : "REHEARSAL_FAILED";
      const refusal = REFUSALS[code];
      return Response.json({
        code,
        message: refusal?.message ?? `The rehearsal did not run: ${code}.`,
      }, { status: refusal?.status ?? 500, headers: noStoreHeaders });
    }
    const conversation = await dependencies.loadConversation(actor.tenantId, id, actor.userId);
    return Response.json({
      conversation: conversationResponse(conversation),
      audit: null,
      rehearsal: outcome,
    }, { headers: noStoreHeaders });
  };
}

export const POST = createRehearseHandler({
  enabled: simulatedSendsLive,
  session: loadRouteActor,
  rehearse: (input) => rehearseLeadTurn(input),
  loadConversation: loadConversationForRoute,
});
