import { phase8SupportLive } from "@/lib/env-contract";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import type { SupportSession } from "@/lib/support/service";
import { loadSupportSession } from "@/lib/support/service";
import {
  recordClientOperatorCommand,
  undoOperatorCommand,
  type ClientCommandReceipt,
  type OperatorCommandUndoReceipt,
} from "@/lib/platform/operator-commands";

const noStoreHeaders = { "Cache-Control": "no-store" };
type Context = { params: Promise<{ id: string }> };
type ClientAction = "pause" | "resume" | "resend_signup" | "nudge_onboarding" | "archive" | "note";

export type ClientCommandDependencies = {
  enabled(): boolean;
  session(): Promise<SupportSession | null>;
  command(input: {
    expectedTenant: string;
    actorId: string;
    action: ClientAction;
    reason?: string;
    note?: string;
  }): Promise<ClientCommandReceipt>;
  undo(input: { expectedTenant: string; commandId: string; actorId: string; reason: string }): Promise<OperatorCommandUndoReceipt>;
};

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parse(body: unknown):
  | { action: ClientAction; reason?: string; note?: string }
  | { action: "undo"; commandId: string; reason: string }
  | null {
  if (!isRecord(body) || typeof body.action !== "string") return null;
  if (["pause", "resume", "resend_signup", "nudge_onboarding", "archive"].includes(body.action)) {
    const reason = text(body.reason);
    if (Object.keys(body).sort().join(",") !== "action,reason" || !reason || reason.length > 500) return null;
    return { action: body.action as ClientAction, reason };
  }
  if (body.action === "note") {
    const note = text(body.note);
    if (Object.keys(body).sort().join(",") !== "action,note" || !note || note.length > 2_000) return null;
    return { action: "note", note };
  }
  if (body.action === "undo") {
    const commandId = text(body.commandId);
    const reason = text(body.reason);
    if (Object.keys(body).sort().join(",") !== "action,commandId,reason" || !commandId || !reason || reason.length > 500) return null;
    return { action: "undo", commandId, reason };
  }
  return null;
}

function authorize(session: SupportSession | null) {
  if (!session) return 401;
  if (hasImpersonationMarker(session) || !["owner", "admin", "success"].includes(session.role)) return 403;
  return null;
}

function response(receipt: ClientCommandReceipt | OperatorCommandUndoReceipt) {
  return {
    command: { id: receipt.commandId, action: receipt.action, state: receipt.state },
    effect: receipt.state === "intent_recorded"
      ? { status: "intent_recorded", providerDispatch: "not_wired" }
      : { status: receipt.state, tenantStatus: receipt.tenantStatus },
    undo: { available: receipt.undoAvailable, commandId: receipt.undoAvailable ? receipt.commandId : null },
    audit: { id: receipt.auditId },
  };
}

export function createClientCommandHandler(dependencies: ClientCommandDependencies) {
  return async function POST(request: Request, context: Context) {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    const session = await dependencies.session();
    if (!session) return Response.json({ error: "Authentication required." }, { status: 401, headers: noStoreHeaders });
    const refused = authorize(session);
    if (refused) return Response.json({ error: "Forbidden." }, { status: refused, headers: noStoreHeaders });
    try {
      const input = parse(await request.json());
      const { id } = await context.params;
      if (!input || !id.trim()) throw new Error("INVALID_BODY");
      const receipt = input.action === "undo"
        ? await dependencies.undo({ expectedTenant: id, commandId: input.commandId, actorId: session.userId, reason: input.reason })
        : await dependencies.command({ expectedTenant: id, actorId: session.userId, ...input });
      if (receipt.tenantId !== id || !Number.isSafeInteger(receipt.auditId) || receipt.auditId <= 0) {
        throw new Error("COMMAND_READBACK_INVALID");
      }
      return Response.json(response(receipt), { headers: noStoreHeaders });
    } catch (error) {
      const status = error instanceof SyntaxError || error instanceof Error && error.message === "INVALID_BODY" ? 400 : 409;
      return Response.json({ error: status === 400 ? "Client command is invalid." : "Client command was refused." }, { status, headers: noStoreHeaders });
    }
  };
}

export const POST = createClientCommandHandler({
  enabled: phase8SupportLive,
  session: loadSupportSession,
  command: recordClientOperatorCommand,
  undo: undoOperatorCommand,
});
