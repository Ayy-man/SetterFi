/** Brain publish orchestration keeps no-op, publish, and rollback as distinct honest result shapes. */

import {
  canonicalizeBrainDraft,
  contentHashForPayload,
  type BrainDraftPayloadInput,
  type CanonicalBrainPayload,
} from "@/lib/brain/snapshot/canonicalize";
import { diffBrainPayloads, type BrainDiff } from "@/lib/brain/snapshot/diff";
import {
  loadBrainSnapshotVersion,
  loadCurrentBrainSnapshot,
  persistBrainDraftRevision,
  persistBrainPublish,
  persistBrainRollback,
  type BrainDraftRevision,
  type BrainPublishDependencies,
  type BrainSnapshotRecord,
  type BrainTransitionReceipt,
} from "@/lib/repositories/brain-publish";

function canonicalPayload(value: Readonly<Record<string, unknown>>): CanonicalBrainPayload {
  const payload = value as Partial<CanonicalBrainPayload>;
  if (!Array.isArray(payload.entities) || typeof payload.compiledPlatform !== "string" ||
    !Number.isSafeInteger(payload.platformTokens) ||
    (payload.knowledgeMode !== "inline" && payload.knowledgeMode !== "retrieved")) {
    throw new Error("BRAIN_SNAPSHOT_PAYLOAD_INVALID");
  }
  return value as CanonicalBrainPayload;
}

export function previewBrainPublish(
  current: BrainSnapshotRecord | null,
  draft: BrainDraftRevision,
): BrainDiff {
  const draftPayload = canonicalPayload(draft.payload);
  if (!current) {
    const empty = canonicalizeBrainDraft({
      entities: [],
      compiledPlatform: "",
      platformTokens: 0,
      knowledgeMode: draftPayload.knowledgeMode,
    });
    return diffBrainPayloads(empty, draftPayload);
  }
  return diffBrainPayloads(canonicalPayload(current.payload), draftPayload);
}

export async function createBrainDraftRevision(
  input: { actorId: string; draft: BrainDraftPayloadInput },
  dependencies?: BrainPublishDependencies,
) {
  const payload = canonicalizeBrainDraft(input.draft);
  const contentHash = contentHashForPayload(payload);
  return persistBrainDraftRevision({ actorId: input.actorId, contentHash, payload }, dependencies);
}

export async function publishBrainDraft(
  input: {
    actorId: string;
    draft: BrainDraftRevision;
    evalRunId: string;
    expectedCurrentVersion: number;
    reason: string;
  },
  dependencies?: BrainPublishDependencies,
): Promise<
  | { status: "nothing_changed"; diff: Extract<BrainDiff, { status: "nothing_changed" }> }
  | { status: "published"; diff: Extract<BrainDiff, { status: "changed" }>; receipt: BrainTransitionReceipt }
> {
  const current = await loadCurrentBrainSnapshot(dependencies);
  if ((current?.version ?? 0) !== input.expectedCurrentVersion) {
    throw new Error("BRAIN_PUBLISH_CURRENT_VERSION_STALE");
  }
  const diff = previewBrainPublish(current, input.draft);
  if (diff.status === "nothing_changed") return { status: "nothing_changed", diff };
  const receipt = await persistBrainPublish({
    actorId: input.actorId,
    draftId: input.draft.id,
    contentHash: input.draft.contentHash,
    evalRunId: input.evalRunId,
    expectedCurrentVersion: input.expectedCurrentVersion,
    reason: input.reason,
  }, dependencies);
  if (receipt.snapshot.contentHash !== input.draft.contentHash) {
    throw new Error("BRAIN_PUBLISH_CONTENT_READBACK_MISMATCH");
  }
  return { status: "published", diff, receipt };
}

export async function rollbackBrainSnapshot(
  input: {
    actorId: string;
    expectedCurrentVersion: number;
    selectedVersion: number;
    reason: string;
    checkHistoricalPayload: (
      payload: Readonly<Record<string, unknown>>,
    ) => Promise<{ passed: boolean; failures: readonly string[] }>;
  },
  dependencies?: BrainPublishDependencies,
) {
  const [current, selected] = await Promise.all([
    loadCurrentBrainSnapshot(dependencies),
    loadBrainSnapshotVersion(input.selectedVersion, dependencies),
  ]);
  if (!current || current.version !== input.expectedCurrentVersion) {
    throw new Error("BRAIN_ROLLBACK_CURRENT_VERSION_STALE");
  }
  if (!selected || selected.version >= current.version) {
    throw new Error("BRAIN_ROLLBACK_TARGET_INVALID");
  }
  const checks = await input.checkHistoricalPayload(selected.payload);
  if (!checks.passed) throw new Error(`BRAIN_ROLLBACK_CHECK_FAILED:${checks.failures.join(",")}`);
  const receipt = await persistBrainRollback({
    actorId: input.actorId,
    expectedCurrentVersion: input.expectedCurrentVersion,
    selectedVersion: input.selectedVersion,
    reason: input.reason,
  }, dependencies);
  if (receipt.snapshot.version !== current.version + 1 ||
    receipt.snapshot.rollbackOfSnapshotId !== selected.id ||
    receipt.snapshot.contentHash !== selected.contentHash) {
    throw new Error("BRAIN_ROLLBACK_APPEND_READBACK_MISMATCH");
  }
  return { status: "rolled_back" as const, from: current.version, selected: selected.version, receipt };
}
