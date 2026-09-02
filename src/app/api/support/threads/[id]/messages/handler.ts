/** Coach support replies are always public support messages; internal is not an input. */

import { phase8SupportLive } from "@/lib/env-contract";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { createSupportRepository, type CoachSupportThreadRead } from "@/lib/repositories/support";
import {
  createSupportService,
  loadSupportSession,
  type SupportSession,
} from "@/lib/support/service";

const noStoreHeaders = { "Cache-Control": "no-store" };

type CoachMessageDependencies = {
  enabled(): boolean;
  session(): Promise<SupportSession | null>;
  append(
    session: SupportSession,
    input: { threadId: string; body: string },
  ): Promise<CoachSupportThreadRead>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createCoachMessageHandler(dependencies: CoachMessageDependencies) {
  return async function POST(
    request: Request,
    context: { params: Promise<{ id: string }> },
  ) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    const session = await dependencies.session();
    if (!session) {
      return Response.json(
        { error: "Authentication required." },
        { status: 401, headers: noStoreHeaders },
      );
    }
    if (hasImpersonationMarker(session) || !session.tenantId
      || !["coach", "coach_member"].includes(session.role)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: noStoreHeaders });
    }
    try {
      const body: unknown = await request.json();
      if (!isRecord(body) || Object.keys(body).join(",") !== "body"
        || typeof body.body !== "string" || !body.body.trim()) {
        throw new Error("INVALID_BODY");
      }
      const { id } = await context.params;
      if (!id.trim()) throw new Error("INVALID_BODY");
      const thread = await dependencies.append(session, { threadId: id, body: body.body });
      return Response.json({ thread }, { headers: noStoreHeaders });
    } catch (error) {
      const status = error instanceof SyntaxError || (error instanceof Error
        && error.message === "INVALID_BODY") ? 400 : 409;
      return Response.json(
        { error: status === 400 ? "Support reply is invalid." : "Support reply was refused." },
        { status, headers: noStoreHeaders },
      );
    }
  };
}

const repository = createSupportRepository();
const service = createSupportService(repository);

export const POST = createCoachMessageHandler({
  enabled: phase8SupportLive,
  session: loadSupportSession,
  append: (session, input) => service.appendCoachMessage(session, input),
});
