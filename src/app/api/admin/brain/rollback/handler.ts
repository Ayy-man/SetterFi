/** Rollback appends a checked historical payload and requires a human reason. */

import { rollbackBrainSnapshot } from "@/lib/brain/snapshot/publish";
import { phase2Live } from "@/lib/env-contract";
import { runCheckerCorpus } from "@/lib/evals/runner";
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

type RollbackDependencies = {
  enabled(): boolean;
  session(): Promise<PlatformActor | null>;
  rollback(input: Parameters<typeof rollbackBrainSnapshot>[0]): ReturnType<typeof rollbackBrainSnapshot>;
};

async function checkHistoricalPayload() {
  const cases = runCheckerCorpus().flatMap((suite) => suite.cases);
  return {
    passed: cases.every((testCase) => testCase.passed),
    failures: cases.filter((testCase) => !testCase.passed).map((testCase) => testCase.caseKey),
  };
}

export function createBrainRollbackHandler(dependencies: RollbackDependencies) {
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
      if (!isRouteRecord(raw) || !hasExactKeys(raw, ["expectedCurrentVersion", "reason", "selectedVersion"]) ||
        !Number.isSafeInteger(raw.expectedCurrentVersion) || Number(raw.expectedCurrentVersion) < 1 ||
        !Number.isSafeInteger(raw.selectedVersion) || Number(raw.selectedVersion) < 1 ||
        !nonBlank(raw.reason)) throw new Error("BRAIN_ROLLBACK_BODY_INVALID");
      const result = await dependencies.rollback({
        actorId: actor.userId,
        expectedCurrentVersion: Number(raw.expectedCurrentVersion),
        selectedVersion: Number(raw.selectedVersion),
        reason: raw.reason.trim(),
        checkHistoricalPayload,
      });
      return Response.json(result, { headers: PHASE2_NO_STORE_HEADERS });
    } catch {
      return Response.json(
        { state: "refused", code: "BRAIN_ROLLBACK_REFUSED" },
        { status: 409, headers: PHASE2_NO_STORE_HEADERS },
      );
    }
  };
}

export const POST = createBrainRollbackHandler({
  enabled: phase2Live,
  session: loadPlatformActor,
  rollback: rollbackBrainSnapshot,
});
