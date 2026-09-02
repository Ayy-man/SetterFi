/** Brain publish route binds one immutable draft to one persisted eval run and audit receipt. */

import { publishBrainDraft } from "@/lib/brain/snapshot/publish";
import { phase2Live } from "@/lib/env-contract";
import { loadSafetyCorpus } from "@/lib/evals/corpus";
import { evaluatePublishGate } from "@/lib/evals/publish-gate";
import {
  brainPublishFailedEvent,
  createBookingEventEmitter,
  createNotificationRepository,
} from "@/lib/notifications/events";
import type { BrainDraftRevision } from "@/lib/repositories/brain-publish";
import { loadEvalRun, type EvalRunReceipt } from "@/lib/repositories/eval-runs";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
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

type PublishInput = {
  actorId: string;
  draft: BrainDraftRevision;
  evalRunId: string;
  expectedCurrentVersion: number;
  reason: string;
};

type PublishDependencies = {
  enabled(): boolean;
  session(): Promise<PlatformActor | null>;
  loadDraft(id: string): Promise<BrainDraftRevision | null>;
  loadEval(id: string): Promise<EvalRunReceipt | null>;
  corpusRevision(): string;
  publish(input: PublishInput): ReturnType<typeof publishBrainDraft>;
  emitFailure(event: ReturnType<typeof brainPublishFailedEvent>): Promise<unknown>;
};

async function loadDraft(id: string): Promise<BrainDraftRevision | null> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.from("brain_draft_versions")
    .select("id,content_hash,payload,created_by")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`BRAIN_DRAFT_READ_FAILED:${error.message}`);
  if (!data) return null;
  return {
    id: data.id,
    contentHash: data.content_hash,
    payload: data.payload as Readonly<Record<string, unknown>>,
    createdBy: data.created_by,
  };
}

function errorCode(error: unknown) {
  return error instanceof Error ? error.message.split(":", 1)[0] : "BRAIN_PUBLISH_FAILED";
}

export function createBrainPublishHandler(dependencies: PublishDependencies) {
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
      if (!isRouteRecord(raw) || !hasExactKeys(raw, [
        "draftId",
        "evalRunId",
        "expectedCurrentVersion",
        "reason",
      ]) || !nonBlank(raw.draftId) || !nonBlank(raw.evalRunId) || !nonBlank(raw.reason) ||
        !Number.isSafeInteger(raw.expectedCurrentVersion) || Number(raw.expectedCurrentVersion) < 0) {
        throw new Error("BRAIN_PUBLISH_BODY_INVALID");
      }
      const draft = await dependencies.loadDraft(raw.draftId.trim());
      if (!draft) {
        return Response.json(
          { state: "blocked", code: "BRAIN_DRAFT_NOT_FOUND" },
          { status: 404, headers: PHASE2_NO_STORE_HEADERS },
        );
      }
      const run = await dependencies.loadEval(raw.evalRunId.trim());
      const gate = evaluatePublishGate({
        expectedDraftId: draft.id,
        expectedContentHash: draft.contentHash,
        expectedCorpusRevision: dependencies.corpusRevision(),
        run,
      });
      if (gate.status === "not_run_for_this_version") {
        return Response.json(
          { state: "not_run_for_this_version", blockers: gate.blockers, warnings: gate.warnings },
          { status: 412, headers: PHASE2_NO_STORE_HEADERS },
        );
      }
      if (!gate.canPublish) {
        return Response.json(
          { state: "blocked", blockers: gate.blockers, warnings: gate.warnings },
          { status: 409, headers: PHASE2_NO_STORE_HEADERS },
        );
      }
      try {
        const result = await dependencies.publish({
          actorId: actor.userId,
          draft,
          evalRunId: raw.evalRunId.trim(),
          expectedCurrentVersion: Number(raw.expectedCurrentVersion),
          reason: raw.reason.trim(),
        });
        return Response.json({ ...result, warnings: gate.warnings }, { headers: PHASE2_NO_STORE_HEADERS });
      } catch (error) {
        const code = errorCode(error);
        // Only the RPC's typed transactional failure emits. Stale pre-reads and validation failures
        // are caller conflicts, not a failed platform publish effect.
        if (error instanceof Error && error.message.startsWith("BRAIN_PUBLISH_FAILED:")) {
          await dependencies.emitFailure(brainPublishFailedEvent({
            actorId: actor.userId,
            draftId: draft.id,
            errorCode: code,
          }));
        }
        return Response.json(
          { state: "failed", code },
          { status: 409, headers: PHASE2_NO_STORE_HEADERS },
        );
      }
    } catch {
      return Response.json(
        { state: "refused", code: "BRAIN_PUBLISH_REQUEST_REFUSED" },
        { status: 400, headers: PHASE2_NO_STORE_HEADERS },
      );
    }
  };
}

export const POST = createBrainPublishHandler({
  enabled: phase2Live,
  session: loadPlatformActor,
  loadDraft,
  loadEval: loadEvalRun,
  corpusRevision: () => loadSafetyCorpus().revision,
  publish: publishBrainDraft,
  emitFailure: async (event) => {
    const emit = createBookingEventEmitter(createNotificationRepository());
    return emit(event);
  },
});
