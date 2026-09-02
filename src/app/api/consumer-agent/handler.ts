import { NextResponse } from "next/server";
import { confirmConsumerBooking, runConsumerTurn, startConsumerSession } from "@/lib/consumer/conversation";

const NO_STORE = { "Cache-Control": "no-store" };
type Dependencies = { start: typeof startConsumerSession; turn: typeof runConsumerTurn; confirm: typeof confirmConsumerBooking };
function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown, max = 800) { return typeof value === "string" && value.trim() && value.trim().length <= max ? value.trim() : null; }
function failure(error: unknown) {
  const code = error instanceof Error ? error.message.split(":")[0] : "CONSUMER_REQUEST_REFUSED";
  const [errorText, status] = code === "RATE_LIMIT_STORE_UNAVAILABLE" ? ["The assistant is temporarily unavailable.", 503] : code.includes("RATE_LIMIT") ? ["The assistant is temporarily unavailable.", 429] : code.includes("TENANT_UNAVAILABLE") || code.includes("SESSION_UNAVAILABLE") ? ["Conversation is unavailable.", 404] : code.includes("CONSENT") ? ["Consent is required before this conversation can start.", 403] : code.includes("BOOKING") ? ["This time cannot be confirmed yet.", 409] : ["The assistant couldn’t process that request.", 400];
  return NextResponse.json({ error: errorText, code }, { status, headers: NO_STORE });
}
/** Client history is deliberately absent: only a server-bound opaque session can continue a lead's transcript. */
export function createConsumerHandler(dependencies: Dependencies) {
  return async function POST(request: Request) {
    try {
      const body: unknown = await request.json(); if (!record(body) || typeof body.action !== "string") throw new Error("CONSUMER_BODY_INVALID");
      if (body.action === "start" && Object.keys(body).sort().join(",") === "action,consentToken,tenantSlug") {
        const tenantSlug = text(body.tenantSlug, 63), consentToken = text(body.consentToken, 2_048);
        if (!tenantSlug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tenantSlug) || !consentToken) throw new Error("CONSUMER_BODY_INVALID");
        return NextResponse.json(await dependencies.start({ request, tenantSlug, consentToken }), { status: 201, headers: NO_STORE });
      }
      if (body.action === "turn" && Object.keys(body).sort().join(",") === "action,message,sessionReference") {
        const sessionReference = text(body.sessionReference, 200), message = text(body.message);
        if (!sessionReference || !message) throw new Error("CONSUMER_BODY_INVALID");
        return NextResponse.json(await dependencies.turn({ request, sessionReference, message }), { headers: NO_STORE });
      }
      if (body.action === "confirm-booking" && Object.keys(body).sort().join(",") === "action,selectedSlotId,sessionReference") {
        const sessionReference = text(body.sessionReference, 200), selectedSlotId = text(body.selectedSlotId, 200);
        if (!sessionReference || !selectedSlotId || !/^[A-Za-z0-9._~-]+$/.test(selectedSlotId)) throw new Error("CONSUMER_BODY_INVALID");
        return NextResponse.json({ appointment: await dependencies.confirm({ request, sessionReference, selectedSlotId }) }, { status: 201, headers: NO_STORE });
      }
      throw new Error("CONSUMER_BODY_INVALID");
    } catch (error) { return failure(error); }
  };
}
export const POST = createConsumerHandler({ start: startConsumerSession, turn: runConsumerTurn, confirm: confirmConsumerBooking });
