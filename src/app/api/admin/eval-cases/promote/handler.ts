/** Platform-only eval promotion; actor, role, and source tenant never come from the request body. */

import {
  loadPlatformActor,
  type PlatformActor,
} from "@/lib/auth/actors";
import {
  EVAL_PROMOTION_SUITES,
  type EvalPromotionSuite,
} from "@/lib/evals/redaction";
import {
  promoteEvalCase,
  type EvalPromotionInput,
} from "@/lib/repositories/eval-promotion";
import { phase7EvalsLive } from "@/lib/env-contract";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const BODY_KEYS = [
  "confirmedRedactedHash",
  "contactId",
  "conversationId",
  "expectation",
  "messageId",
  "notes",
  "redactedTurns",
  "redactionManifest",
  "sourceHash",
  "suite",
] as const;

type PromotionDependencies = {
  enabled(): boolean;
  session(): Promise<PlatformActor | null>;
  promote(input: EvalPromotionInput): ReturnType<typeof promoteEvalCase>;
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function exactKeys(value: Record<string, unknown>) {
  return Object.keys(value).sort().join(",") === [...BODY_KEYS].sort().join(",");
}

function isOwnerAdmin(actor: PlatformActor | null): actor is PlatformActor {
  return actor?.role === "owner" || actor?.role === "admin";
}

export function createEvalPromotionHandler(dependencies: PromotionDependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE_HEADERS });
    }
    const actor = await dependencies.session();
    if (!isOwnerAdmin(actor)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: NO_STORE_HEADERS });
    }
    try {
      const body: unknown = await request.json();
      if (!record(body) || !exactKeys(body) ||
        !nonBlank(body.conversationId) || !nonBlank(body.messageId) ||
        !nonBlank(body.contactId) || !nonBlank(body.sourceHash) ||
        !nonBlank(body.confirmedRedactedHash) || !nonBlank(body.notes) ||
        !EVAL_PROMOTION_SUITES.includes(body.suite as EvalPromotionSuite)) {
        throw new Error("EVAL_PROMOTION_BODY_INVALID");
      }
      return Response.json(await dependencies.promote({
        actorId: actor.userId,
        conversationId: body.conversationId.trim(),
        messageId: body.messageId.trim(),
        contactId: body.contactId.trim(),
        redactedTurns: body.redactedTurns as EvalPromotionInput["redactedTurns"],
        expectation: body.expectation as EvalPromotionInput["expectation"],
        suite: body.suite as EvalPromotionSuite,
        redactionManifest: body.redactionManifest as EvalPromotionInput["redactionManifest"],
        sourceHash: body.sourceHash.trim(),
        confirmedRedactedHash: body.confirmedRedactedHash.trim(),
        notes: body.notes.trim(),
      }), { headers: NO_STORE_HEADERS });
    } catch {
      return Response.json(
        { state: "refused", code: "EVAL_PROMOTION_REFUSED" },
        { status: 409, headers: NO_STORE_HEADERS },
      );
    }
  };
}

export const POST = createEvalPromotionHandler({
  enabled: phase7EvalsLive,
  session: loadPlatformActor,
  promote: promoteEvalCase,
});
