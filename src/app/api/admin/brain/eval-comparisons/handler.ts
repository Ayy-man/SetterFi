/** A/B execution accepts identifiers only; every case, version, parameter, and driver is server-derived. */

import {
  DriverConfigurationError,
  phase7EvalsLive,
} from "@/lib/env-contract";
import { runEvalComparison } from "@/lib/repositories/eval-comparisons";
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

export const runtime = "nodejs";
export const maxDuration = 300;

type EvalComparisonRouteDependencies = {
  enabled(): boolean;
  session(): Promise<PlatformActor | null>;
  run(input: {
    actorId: string;
    draftId: string;
    contentHash: string;
    modelConfigAId: string;
    modelConfigBId: string;
  }): ReturnType<typeof runEvalComparison>;
};

export function createEvalComparisonHandler(
  dependencies: EvalComparisonRouteDependencies,
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
      if (!isRouteRecord(body) || !hasExactKeys(body, [
        "contentHash",
        "draftId",
        "modelConfigAId",
        "modelConfigBId",
      ]) || !nonBlank(body.draftId) || !nonBlank(body.modelConfigAId) ||
        !nonBlank(body.modelConfigBId) ||
        typeof body.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(body.contentHash)) {
        throw new Error("EVAL_COMPARISON_BODY_INVALID");
      }
      const comparison = await dependencies.run({
        actorId: actor.userId,
        draftId: body.draftId.trim(),
        contentHash: body.contentHash,
        modelConfigAId: body.modelConfigAId.trim(),
        modelConfigBId: body.modelConfigBId.trim(),
      });
      return Response.json({ state: comparison.state, comparison }, {
        headers: PHASE2_NO_STORE_HEADERS,
      });
    } catch (error) {
      if (error instanceof DriverConfigurationError) {
        return Response.json({
          state: "refused",
          code: error.code,
          driver: error.driver,
          variableNames: error.variableNames,
        }, { status: 503, headers: PHASE2_NO_STORE_HEADERS });
      }
      return Response.json({
        state: "refused",
        code: "EVAL_COMPARISON_REFUSED",
      }, { status: 409, headers: PHASE2_NO_STORE_HEADERS });
    }
  };
}

export const POST = createEvalComparisonHandler({
  enabled: phase7EvalsLive,
  session: loadPlatformActor,
  run: runEvalComparison,
});
