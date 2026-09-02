import { describe, expect, it } from "vitest";

import {
  canonicalizeBrainDraft,
  contentHashForPayload,
} from "@/lib/brain/snapshot/canonicalize";
import {
  publishBrainDraft,
  rollbackBrainSnapshot,
} from "@/lib/brain/snapshot/publish";
import {
  persistBrainDraftRevision,
  type BrainAuditReceipt,
  type BrainPublishDependencies,
  type BrainSnapshotRecord,
} from "@/lib/repositories/brain-publish";

const ACTOR = "actor-1";

function payload(label: string) {
  return canonicalizeBrainDraft({
    entities: [{ type: "knowledge_entry", id: "entry-1", value: { answer: label } }],
    compiledPlatform: label,
    platformTokens: 1,
    knowledgeMode: "inline",
  });
}

function snapshot(version: number, label: string, rollbackOfSnapshotId: string | null = null): BrainSnapshotRecord {
  const value = payload(label);
  return {
    id: `snapshot-${version}`,
    version,
    contentHash: contentHashForPayload(value),
    sourceHash: contentHashForPayload(value),
    payload: value,
    compiledPlatform: label,
    platformTokens: 1,
    knowledgeMode: "inline",
    evalRunId: `eval-${version}`,
    rollbackOfSnapshotId,
  };
}

function dependencies(initial: BrainSnapshotRecord[] = []) {
  const snapshots = [...initial];
  const audits = new Map<number, BrainAuditReceipt>();
  const drafts = new Map<string, { id: string; contentHash: string; payload: Readonly<Record<string, unknown>>; createdBy: string }>();
  const calls = { create: 0, publish: 0, rollback: 0 };
  const deps: BrainPublishDependencies = {
    createDraft: async (args) => {
      calls.create += 1;
      const id = `draft-${calls.create}`;
      drafts.set(id, {
        id,
        contentHash: String(args.p_expected_content_hash),
        payload: args.p_payload as Readonly<Record<string, unknown>>,
        createdBy: String(args.p_actor_id),
      });
      return id;
    },
    loadDraft: async (id) => drafts.get(id) ?? null,
    publish: async (args) => {
      calls.publish += 1;
      const next = snapshot((snapshots.at(-1)?.version ?? 0) + 1, "Second");
      next.contentHash = String(args.p_expected_content_hash);
      next.payload = drafts.get(String(args.p_expected_draft_id))?.payload ?? next.payload;
      next.evalRunId = String(args.p_eval_run_id);
      snapshots.push(next);
      const audit: BrainAuditReceipt = {
        id: 40 + calls.publish,
        action: "brain.published",
        payload: { prior: next.version - 1, new: next.version },
      };
      audits.set(audit.id, audit);
      return { snapshot_id: next.id, brain_version: next.version, audit_id: audit.id };
    },
    rollback: async (args) => {
      calls.rollback += 1;
      const selected = snapshots.find((item) => item.version === args.p_selected_version);
      if (!selected) throw new Error("missing selected snapshot");
      const next = { ...selected, id: `snapshot-${Number(args.p_expected_current_version) + 1}`,
        version: Number(args.p_expected_current_version) + 1, rollbackOfSnapshotId: selected.id };
      snapshots.push(next);
      const audit: BrainAuditReceipt = {
        id: 80 + calls.rollback,
        action: "brain.rolled_back",
        payload: { prior: args.p_expected_current_version, new: next.version, selected_version: selected.version },
      };
      audits.set(audit.id, audit);
      return { snapshot_id: next.id, brain_version: next.version, audit_id: audit.id };
    },
    loadSnapshotById: async (id) => snapshots.find((item) => item.id === id) ?? null,
    loadSnapshotByVersion: async (version) => snapshots.find((item) => item.version === version) ?? null,
    loadCurrentSnapshot: async () => snapshots.at(-1) ?? null,
    loadAudit: async (id) => audits.get(id) ?? null,
  };
  return { deps, snapshots, calls };
}

describe("Brain publish repository", () => {
  it("reads back the immutable draft before returning a revision", async () => {
    const state = dependencies();
    const value = payload("First");
    const persisted = await persistBrainDraftRevision({
      actorId: ACTOR,
      contentHash: contentHashForPayload(value),
      payload: value,
    }, state.deps);
    expect(persisted).toMatchObject({ id: "draft-1", createdBy: ACTOR, contentHash: contentHashForPayload(value) });
  });

  it("creates no publish call for a no-op instead of inflating the version", async () => {
    const first = snapshot(1, "First");
    const state = dependencies([first]);
    const result = await publishBrainDraft({
      actorId: ACTOR,
      draft: { id: "draft-noop", contentHash: first.contentHash, payload: first.payload, createdBy: ACTOR },
      evalRunId: "eval-1",
      expectedCurrentVersion: 1,
      reason: "No-op probe",
    }, state.deps);
    expect(result.status).toBe("nothing_changed");
    expect(state.calls.publish).toBe(0);
  });

  it("returns Published only after snapshot version and audit id read back", async () => {
    const state = dependencies([snapshot(1, "First")]);
    const value = payload("Second");
    const draft = await persistBrainDraftRevision({
      actorId: ACTOR,
      contentHash: contentHashForPayload(value),
      payload: value,
    }, state.deps);
    const result = await publishBrainDraft({
      actorId: ACTOR,
      draft,
      evalRunId: "eval-2",
      expectedCurrentVersion: 1,
      reason: "Publish synthetic edit",
    }, state.deps);
    expect(result.status).toBe("published");
    if (result.status !== "published") throw new Error("expected publish receipt");
    expect(result.receipt.snapshot.version).toBe(2);
    expect(result.receipt.audit).toEqual({
      id: 41,
      action: "brain.published",
      payload: { prior: 1, new: 2 },
    });
  });

  it("rechecks the selected payload and appends N+1 without changing prior snapshots", async () => {
    const first = snapshot(1, "First");
    const second = snapshot(2, "Second");
    const state = dependencies([first, second]);
    const before = state.snapshots.map((item) => structuredClone(item));
    const checked: string[] = [];
    const result = await rollbackBrainSnapshot({
      actorId: ACTOR,
      expectedCurrentVersion: 2,
      selectedVersion: 1,
      reason: "Restore the first synthetic version",
      checkHistoricalPayload: async (value) => {
        checked.push(String(value.compiledPlatform));
        return { passed: true, failures: [] };
      },
    }, state.deps);
    expect(checked).toEqual(["First"]);
    expect(result).toMatchObject({ status: "rolled_back", from: 2, selected: 1 });
    expect(result.receipt.snapshot).toMatchObject({ version: 3, rollbackOfSnapshotId: first.id });
    expect(result.receipt.audit.payload).toEqual({ prior: 2, new: 3, selected_version: 1 });
    expect(state.snapshots.slice(0, 2)).toEqual(before);
  });
});
