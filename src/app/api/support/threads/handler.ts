/** Authenticated coach support list/create boundary; scope comes only from the session. */

import { phase8SupportLive } from "@/lib/env-contract";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { createSupportRepository, type CoachSupportThreadRead } from "@/lib/repositories/support";
import {
  createSupportService,
  loadSupportSession,
  type SupportSession,
} from "@/lib/support/service";

const noStoreHeaders = { "Cache-Control": "no-store" };

type CoachThreadsDependencies = {
  enabled(): boolean;
  session(): Promise<SupportSession | null>;
  list(session: SupportSession): Promise<CoachSupportThreadRead[]>;
  create(
    session: SupportSession,
    input: { subject: string; body: string },
  ): Promise<CoachSupportThreadRead>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

function authorizeCoach(session: SupportSession | null) {
  if (!session) return 401;
  if (hasImpersonationMarker(session) || !session.tenantId
    || !["coach", "coach_member"].includes(session.role)) return 403;
  return null;
}

export function createCoachThreadsHandlers(dependencies: CoachThreadsDependencies) {
  async function GET() {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    const session = await dependencies.session();
    const refusal = authorizeCoach(session);
    if (refusal) return Response.json({ error: refusal === 401
      ? "Authentication required." : "Forbidden." }, { status: refusal, headers: noStoreHeaders });
    try {
      return Response.json({ threads: await dependencies.list(session as SupportSession) }, {
        headers: noStoreHeaders,
      });
    } catch (cause) {
      console.error(
        "/api/support/threads failed.",
        cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
      );
      return Response.json(
        { error: "Support threads are temporarily unavailable." },
        { status: 503, headers: noStoreHeaders },
      );
    }
  }

  async function POST(request: Request) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    const session = await dependencies.session();
    const refusal = authorizeCoach(session);
    if (refusal) return Response.json({ error: refusal === 401
      ? "Authentication required." : "Forbidden." }, { status: refusal, headers: noStoreHeaders });
    try {
      const body: unknown = await request.json();
      if (!isRecord(body) || !exactKeys(body, ["subject", "body"])
        || typeof body.subject !== "string" || !body.subject.trim()
        || typeof body.body !== "string" || !body.body.trim()) {
        throw new Error("INVALID_BODY");
      }
      const thread = await dependencies.create(session as SupportSession, {
        subject: body.subject,
        body: body.body,
      });
      return Response.json({ thread }, { status: 201, headers: noStoreHeaders });
    } catch (error) {
      const status = error instanceof SyntaxError || (error instanceof Error
        && error.message === "INVALID_BODY") ? 400 : 409;
      return Response.json(
        { error: status === 400 ? "Support request is invalid." : "Support request was refused." },
        { status, headers: noStoreHeaders },
      );
    }
  }

  return { GET, POST };
}

const repository = createSupportRepository();
const service = createSupportService(repository);
const handlers = createCoachThreadsHandlers({
  enabled: phase8SupportLive,
  session: loadSupportSession,
  list: (session) => service.listCoachThreads(session),
  create: (session, input) => service.createCoachThread(session, input),
});

export const GET = handlers.GET;
export const POST = handlers.POST;
