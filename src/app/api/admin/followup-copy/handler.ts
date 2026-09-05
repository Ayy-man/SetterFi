import { loadPlatformActor, type PlatformActor } from "@/lib/auth/actors";
import { decideFollowupCopy } from "@/lib/repositories/followup-copy";

const HEADERS = { "Cache-Control": "no-store" };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const valid = (value: unknown, maximum: number): value is string => typeof value === "string" && Boolean(value.trim()) && value.trim().length <= maximum;
const admin = (actor: PlatformActor | null): actor is PlatformActor => Boolean(actor && (actor.role === "owner" || actor.role === "admin"));

export function createAdminFollowupCopyHandler(deps: { session(): Promise<PlatformActor | null>; decide: typeof decideFollowupCopy }) {
  return async function POST(request: Request) {
    const actor = await deps.session(); if (!admin(actor)) return Response.json({ error: "Forbidden." }, { status: 403, headers: HEADERS });
    try {
      const body: unknown = await request.json();
      if (!record(body) || Object.keys(body).sort().join(",") !== "decision,reason,templateId,tenantId" ||
        !valid(body.tenantId, 64) || !valid(body.templateId, 64) || !valid(body.reason, 500) ||
        (body.decision !== "approved" && body.decision !== "rejected")) throw new Error("FOLLOWUP_COPY_DECISION_BODY_INVALID");
      const result = await deps.decide({ tenantId: body.tenantId.trim(), templateId: body.templateId.trim(), actorId: actor.userId,
        decision: body.decision as "approved" | "rejected", reason: body.reason.trim() });
      return Response.json({ ...result, audit: { auditId: result.auditId, actionKey: `followup_copy.${result.status}` } }, { headers: HEADERS });
    } catch { return Response.json({ code: "FOLLOWUP_COPY_DECISION_REFUSED" }, { status: 409, headers: HEADERS }); }
  };
}

export const POST = createAdminFollowupCopyHandler({ session: loadPlatformActor, decide: decideFollowupCopy });
