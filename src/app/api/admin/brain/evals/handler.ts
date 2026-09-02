/** Exact-draft checker runs expose persisted evidence without accepting editable case data. */

import { phase2Live } from "@/lib/env-contract";
import { runAndRecordEval } from "@/lib/evals/runner";
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
} from "../import/handler";

type EvalDependencies = {
  enabled(): boolean;
  session(): Promise<PlatformActor | null>;
  run(input: { draftId: string; contentHash: string; kind: "checker" }): ReturnType<typeof runAndRecordEval>;
};

export function createBrainEvalHandler(dependencies: EvalDependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: PHASE2_NO_STORE_HEADERS });
    }
    const actor = await dependencies.session();
    if (!isBrainAdmin(actor)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: PHASE2_NO_STORE_HEADERS });
    }
    try {
      const raw: unknown = await request.json();
      if (!isRouteRecord(raw) || !hasExactKeys(raw, ["contentHash", "draftId", "kind"]) ||
        !nonBlank(raw.draftId) || !/^[0-9a-f]{64}$/.test(String(raw.contentHash)) || raw.kind !== "checker") {
        throw new Error("BRAIN_EVAL_BODY_INVALID");
      }
      const receipt = await dependencies.run({
        draftId: raw.draftId.trim(),
        contentHash: String(raw.contentHash),
        kind: "checker",
      });
      return Response.json({ state: "complete", receipt }, { headers: PHASE2_NO_STORE_HEADERS });
    } catch {
      return Response.json(
        { state: "incomplete", code: "BRAIN_EVAL_REFUSED" },
        { status: 400, headers: PHASE2_NO_STORE_HEADERS },
      );
    }
  };
}

export const POST = createBrainEvalHandler({
  enabled: phase2Live,
  session: loadPlatformActor,
  run: runAndRecordEval,
});
