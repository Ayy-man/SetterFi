/** Challenger creation keeps actor, inactive-generator state, and audit custody server-owned. */

import { phase7EvalsLive } from "@/lib/env-contract";
import { createChallengerModelConfig } from "@/lib/repositories/eval-comparisons";
import {
  loadPlatformActor,
  type PlatformActor,
} from "@/lib/auth/actors";
import {
  hasExactKeys,
  isBrainAdmin,
  isRouteRecord,
  nonBlank,
  PHASE2_NO_STORE_HEADERS,
} from "@/app/api/admin/brain/import/handler";

type ChallengerRouteDependencies = {
  enabled(): boolean;
  session(): Promise<PlatformActor | null>;
  create(input: {
    actorId: string;
    model: string;
    params: Readonly<Record<string, unknown>>;
  }): ReturnType<typeof createChallengerModelConfig>;
};

export function createChallengerModelConfigHandler(
  dependencies: ChallengerRouteDependencies,
) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, {
        status: 404,
        headers: PHASE2_NO_STORE_HEADERS,
      });
    }
    const actor = await dependencies.session();
    if (!isBrainAdmin(actor)) {
      return Response.json({ error: "Forbidden." }, {
        status: 403,
        headers: PHASE2_NO_STORE_HEADERS,
      });
    }
    try {
      const body: unknown = await request.json();
      if (!isRouteRecord(body) || !hasExactKeys(body, ["model", "params"]) ||
        !nonBlank(body.model) || !isRouteRecord(body.params)) {
        throw new Error("EVAL_CHALLENGER_BODY_INVALID");
      }
      const receipt = await dependencies.create({
        actorId: actor.userId,
        model: body.model.trim(),
        params: body.params,
      });
      return Response.json({ state: "created", receipt }, {
        status: 201,
        headers: PHASE2_NO_STORE_HEADERS,
      });
    } catch {
      return Response.json({
        state: "refused",
        code: "EVAL_CHALLENGER_REFUSED",
      }, { status: 400, headers: PHASE2_NO_STORE_HEADERS });
    }
  };
}

export const POST = createChallengerModelConfigHandler({
  enabled: phase7EvalsLive,
  session: loadPlatformActor,
  create: createChallengerModelConfig,
});
