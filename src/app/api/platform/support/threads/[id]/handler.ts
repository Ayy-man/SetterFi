/** Platform support detail and explicit reply/internal-note mutation boundary. */

import { phase8SupportLive } from "@/lib/env-contract";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { createSupportRepository, type PlatformSupportThreadRead } from "@/lib/repositories/support";
import type { SupportStatus } from "@/lib/repositories/support";
import {
  createSupportService,
  loadSupportSession,
  type SupportSession,
} from "@/lib/support/service";
import {
  createSupportThreadLifecycle,
  type SupportThreadAssignmentReceipt,
  type SupportThreadStatusReceipt,
} from "@/lib/support/thread-lifecycle";

const noStoreHeaders = { "Cache-Control": "no-store" };
type Context = { params: Promise<{ id: string }> };

type PlatformThreadDependencies = {
  enabled(): boolean;
  session(): Promise<SupportSession | null>;
  get(session: SupportSession, threadId: string): Promise<PlatformSupportThreadRead>;
  append(
    session: SupportSession,
    input: { threadId: string; body: string; internal: boolean },
  ): Promise<PlatformSupportThreadRead>;
  setStatus?(
    session: SupportSession,
    input: { threadId: string; status: SupportStatus; reason: string },
  ): Promise<SupportThreadStatusReceipt>;
  setAssignee?(
    session: SupportSession,
    input: { threadId: string; assigneeId: string | null; reason: string },
  ): Promise<SupportThreadAssignmentReceipt>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function authorize(session: SupportSession | null) {
  if (!session) return 401;
  if (hasImpersonationMarker(session) || !["owner", "admin", "success"].includes(session.role)) {
    return 403;
  }
  return null;
}

export function createPlatformThreadHandlers(dependencies: PlatformThreadDependencies) {
  async function GET(_request: Request, context: Context) {
    if (!dependencies.enabled()) return Response.json(
      { error: "Not found." },
      { status: 404, headers: noStoreHeaders },
    );
    const session = await dependencies.session();
    const refusal = authorize(session);
    if (refusal) return Response.json(
      { error: refusal === 401 ? "Authentication required." : "Forbidden." },
      { status: refusal, headers: noStoreHeaders },
    );
    try {
      const { id } = await context.params;
      if (!id.trim()) throw new Error("INVALID_ID");
      return Response.json({ thread: await dependencies.get(session as SupportSession, id) }, {
        headers: noStoreHeaders,
      });
    } catch {
      return Response.json(
        { error: "Support thread is unavailable." },
        { status: 404, headers: noStoreHeaders },
      );
    }
  }

  async function POST(request: Request, context: Context) {
    if (!dependencies.enabled()) return Response.json(
      { error: "Not found." },
      { status: 404, headers: noStoreHeaders },
    );
    const session = await dependencies.session();
    const refusal = authorize(session);
    if (refusal) return Response.json(
      { error: refusal === 401 ? "Authentication required." : "Forbidden." },
      { status: refusal, headers: noStoreHeaders },
    );
    try {
      const body: unknown = await request.json();
      if (!isRecord(body)
        || Object.keys(body).sort().join(",") !== "body,kind"
        || !["reply", "internal_note"].includes(String(body.kind))
        || typeof body.body !== "string" || !body.body.trim()) {
        throw new Error("INVALID_BODY");
      }
      const { id } = await context.params;
      if (!id.trim()) throw new Error("INVALID_BODY");
      const thread = await dependencies.append(session as SupportSession, {
        threadId: id,
        body: body.body,
        internal: body.kind === "internal_note",
      });
      return Response.json({ thread }, { headers: noStoreHeaders });
    } catch (error) {
      const status = error instanceof SyntaxError || (error instanceof Error
        && error.message === "INVALID_BODY") ? 400 : 409;
      return Response.json(
        { error: status === 400 ? "Support reply is invalid." : "Support reply was refused." },
        { status, headers: noStoreHeaders },
      );
    }
  }

  async function PATCH(request: Request, context: Context) {
    if (!dependencies.enabled()) return Response.json(
      { error: "Not found." },
      { status: 404, headers: noStoreHeaders },
    );
    const session = await dependencies.session();
    const refusal = authorize(session);
    if (refusal) return Response.json(
      { error: refusal === 401 ? "Authentication required." : "Forbidden." },
      { status: refusal, headers: noStoreHeaders },
    );
    try {
      const body: unknown = await request.json();
      if (!isRecord(body) || typeof body.kind !== "string" || typeof body.reason !== "string"
        || !body.reason.trim()) throw new Error("INVALID_BODY");
      const { id } = await context.params;
      if (!id.trim()) throw new Error("INVALID_BODY");
      if (body.kind === "status"
        && Object.keys(body).sort().join(",") === "kind,reason,status"
        && ["open", "waiting_on_coach", "resolved"].includes(String(body.status))) {
        if (!dependencies.setStatus) throw new Error("LIFECYCLE_NOT_CONFIGURED");
        const receipt = await dependencies.setStatus(session as SupportSession, {
          threadId: id,
          status: body.status as SupportStatus,
          reason: body.reason,
        });
        return Response.json({
          thread: { id: receipt.threadId, tenantId: receipt.tenantId, status: receipt.status },
          audit: { id: receipt.auditId, actionKey: receipt.actionKey, microcopy: receipt.microcopy },
        }, { headers: noStoreHeaders });
      }
      if (body.kind === "assignment"
        && Object.keys(body).sort().join(",") === "assigneeId,kind,reason"
        && (body.assigneeId === null || typeof body.assigneeId === "string" && body.assigneeId.trim())) {
        if (!dependencies.setAssignee) throw new Error("LIFECYCLE_NOT_CONFIGURED");
        const receipt = await dependencies.setAssignee(session as SupportSession, {
          threadId: id,
          assigneeId: body.assigneeId as string | null,
          reason: body.reason,
        });
        return Response.json({
          thread: {
            id: receipt.threadId,
            tenantId: receipt.tenantId,
            assignedTo: receipt.assigneeId,
          },
          audit: { id: receipt.auditId, actionKey: receipt.actionKey, microcopy: receipt.microcopy },
        }, { headers: noStoreHeaders });
      }
      throw new Error("INVALID_BODY");
    } catch (error) {
      const status = error instanceof SyntaxError || (error instanceof Error
        && error.message === "INVALID_BODY") ? 400 : 409;
      return Response.json(
        { error: status === 400 ? "Support lifecycle request is invalid." : "Support lifecycle update was refused." },
        { status, headers: noStoreHeaders },
      );
    }
  }

  return { GET, POST, PATCH };
}

const repository = createSupportRepository();
const service = createSupportService(repository);
const lifecycle = createSupportThreadLifecycle();
const handlers = createPlatformThreadHandlers({
  enabled: phase8SupportLive,
  session: loadSupportSession,
  get: (session, threadId) => service.getPlatformThread(session, threadId),
  append: (session, input) => service.appendPlatformMessage(session, input),
  setStatus: (session, input) => lifecycle.setStatus({ actorId: session.userId, ...input }),
  setAssignee: (session, input) => lifecycle.setAssignee({ actorId: session.userId, ...input }),
});

export const GET = handlers.GET;
export const POST = handlers.POST;
export const PATCH = handlers.PATCH;
