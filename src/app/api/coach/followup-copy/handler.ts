import { hasImpersonationMarker } from "@/lib/auth/claims";
import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import type { MessagingChannel } from "@/lib/booking/types";
import { OFFER_CADENCE_SENDING_PURPOSES } from "@/lib/offer/types";
import { listFollowupCopy, saveFollowupCopyDraft, submitFollowupCopy } from "@/lib/repositories/followup-copy";

const HEADERS = { "Cache-Control": "no-store" };
const CHANNELS: readonly MessagingChannel[] = ["sms", "instagram", "messenger", "whatsapp"];
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: readonly string[]) => Object.keys(value).sort().join(",") === [...expected].sort().join(",");
const text = (value: unknown, maximum: number): value is string => typeof value === "string" && Boolean(value.trim()) && value.trim().length <= maximum;
const coach = (actor: RouteActor | null): actor is RouteActor => Boolean(actor && (actor.role === "coach" || actor.role === "coach_member") && !hasImpersonationMarker(actor));

export function createCoachFollowupCopyHandlers(deps: {
  session(): Promise<RouteActor | null>;
  list: typeof listFollowupCopy; save: typeof saveFollowupCopyDraft; submit: typeof submitFollowupCopy;
}) {
  async function actor() { const value = await deps.session(); return coach(value) ? value : null; }
  async function GET() {
    const value = await actor(); if (!value) return Response.json({ error: "Forbidden." }, { status: 403, headers: HEADERS });
    try { return Response.json({ items: await deps.list(value.tenantId) }, { headers: HEADERS }); }
    catch { return Response.json({ code: "FOLLOWUP_COPY_READ_FAILED" }, { status: 503, headers: HEADERS }); }
  }
  async function PUT(request: Request) {
    const value = await actor(); if (!value) return Response.json({ error: "Forbidden." }, { status: 403, headers: HEADERS });
    try {
      const body: unknown = await request.json();
      if (!isRecord(body) || !keys(body, ["channel", "purpose", "body"]) || !CHANNELS.includes(body.channel as MessagingChannel) ||
        !OFFER_CADENCE_SENDING_PURPOSES.includes(body.purpose as never) || !text(body.body, 4_000)) throw new Error("FOLLOWUP_COPY_BODY_INVALID");
      const result = await deps.save({ tenantId: value.tenantId, actorId: value.userId, channel: body.channel as MessagingChannel,
        purpose: body.purpose as never, body: body.body.trim() });
      return Response.json({ ...result, audit: { auditId: result.auditId, actionKey: "followup_copy.draft.saved" } }, { headers: HEADERS });
    } catch { return Response.json({ code: "FOLLOWUP_COPY_DRAFT_REFUSED" }, { status: 409, headers: HEADERS }); }
  }
  async function POST(request: Request) {
    const value = await actor(); if (!value) return Response.json({ error: "Forbidden." }, { status: 403, headers: HEADERS });
    try {
      const body: unknown = await request.json();
      if (!isRecord(body) || !keys(body, ["templateId"]) || !text(body.templateId, 64)) throw new Error("FOLLOWUP_COPY_SUBMIT_BODY_INVALID");
      const result = await deps.submit({ tenantId: value.tenantId, actorId: value.userId, templateId: body.templateId.trim() });
      return Response.json({ ...result, audit: { auditId: result.auditId, actionKey: "followup_copy.submitted" } }, { headers: HEADERS });
    } catch { return Response.json({ code: "FOLLOWUP_COPY_SUBMIT_REFUSED" }, { status: 409, headers: HEADERS }); }
  }
  return { GET, PUT, POST };
}

const handlers = createCoachFollowupCopyHandlers({ session: loadRouteActor, list: listFollowupCopy, save: saveFollowupCopyDraft, submit: submitFollowupCopy });
export const GET = handlers.GET; export const PUT = handlers.PUT; export const POST = handlers.POST;
