/**
 * Service-role boundary for immutable Brain draft, publish, and rollback transitions.
 *
 * RPC success is never the receipt. Every transition is followed by exact snapshot and audit
 * reads, because a route may render Published or Logged only from committed database evidence.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type BrainDraftRevision = {
  id: string;
  contentHash: string;
  payload: Readonly<Record<string, unknown>>;
  createdBy: string;
};

export type BrainSnapshotRecord = {
  id: string;
  version: number;
  contentHash: string;
  sourceHash: string;
  payload: Readonly<Record<string, unknown>>;
  compiledPlatform: string;
  platformTokens: number;
  knowledgeMode: "inline" | "retrieved";
  evalRunId: string | null;
  rollbackOfSnapshotId: string | null;
};

export type BrainAuditReceipt = {
  id: number;
  action: "brain.published" | "brain.rolled_back";
  payload: Readonly<Record<string, unknown>>;
};

export type BrainTransitionReceipt = {
  snapshot: BrainSnapshotRecord;
  audit: BrainAuditReceipt;
};

type TransitionRow = { snapshot_id: string; brain_version: number; audit_id: number };

export type BrainPublishDependencies = {
  createDraft: (args: Record<string, unknown>) => Promise<string>;
  loadDraft: (id: string) => Promise<BrainDraftRevision | null>;
  publish: (args: Record<string, unknown>) => Promise<TransitionRow>;
  rollback: (args: Record<string, unknown>) => Promise<TransitionRow>;
  loadSnapshotById: (id: string) => Promise<BrainSnapshotRecord | null>;
  loadSnapshotByVersion: (version: number) => Promise<BrainSnapshotRecord | null>;
  loadCurrentSnapshot: () => Promise<BrainSnapshotRecord | null>;
  loadAudit: (id: number) => Promise<BrainAuditReceipt | null>;
};

function snapshotRow(row: Record<string, unknown>): BrainSnapshotRecord {
  return {
    id: String(row.id),
    version: Number(row.version),
    contentHash: String(row.content_hash),
    sourceHash: String(row.source_hash),
    payload: row.payload as Readonly<Record<string, unknown>>,
    compiledPlatform: String(row.compiled_platform),
    platformTokens: Number(row.platform_tokens),
    knowledgeMode: row.knowledge_mode as BrainSnapshotRecord["knowledgeMode"],
    evalRunId: typeof row.eval_run_id === "string" ? row.eval_run_id : null,
    rollbackOfSnapshotId: typeof row.rollback_of_snapshot_id === "string"
      ? row.rollback_of_snapshot_id
      : null,
  };
}

function singleTransition(data: unknown, operation: string): TransitionRow {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object") throw new Error(`${operation}_EMPTY`);
  const value = row as Record<string, unknown>;
  if (typeof value.snapshot_id !== "string" || typeof value.audit_id !== "number" ||
    !Number.isInteger(value.brain_version)) {
    throw new Error(`${operation}_INVALID_RECEIPT`);
  }
  return {
    snapshot_id: value.snapshot_id,
    brain_version: value.brain_version as number,
    audit_id: value.audit_id,
  };
}

async function liveDependencies(): Promise<BrainPublishDependencies> {
  const client = createSupabaseServiceClient();
  const loadSnapshot = async (column: "id" | "version", value: string | number) => {
    const { data, error } = await client.from("brain_snapshots").select(
      "id,version,content_hash,source_hash,payload,compiled_platform,platform_tokens,knowledge_mode,eval_run_id,rollback_of_snapshot_id",
    ).eq(column, value).single();
    if (error || !data) return null;
    return snapshotRow(data as Record<string, unknown>);
  };
  return {
    createDraft: async (args) => {
      const { data, error } = await client.rpc("create_brain_draft_version", args);
      if (error || typeof data !== "string") throw new Error(`BRAIN_DRAFT_CREATE_FAILED:${error?.message ?? "empty"}`);
      return data;
    },
    loadDraft: async (id) => {
      const { data, error } = await client.from("brain_draft_versions")
        .select("id,content_hash,payload,created_by").eq("id", id).single();
      if (error || !data) return null;
      return {
        id: data.id,
        contentHash: data.content_hash,
        payload: data.payload as Readonly<Record<string, unknown>>,
        createdBy: data.created_by,
      };
    },
    publish: async (args) => {
      const { data, error } = await client.rpc("publish_brain_draft", args);
      if (error) throw new Error(`BRAIN_PUBLISH_FAILED:${error.message}`);
      return singleTransition(data, "BRAIN_PUBLISH");
    },
    rollback: async (args) => {
      const { data, error } = await client.rpc("rollback_brain_snapshot", args);
      if (error) throw new Error(`BRAIN_ROLLBACK_FAILED:${error.message}`);
      return singleTransition(data, "BRAIN_ROLLBACK");
    },
    loadSnapshotById: (id) => loadSnapshot("id", id),
    loadSnapshotByVersion: (version) => loadSnapshot("version", version),
    loadCurrentSnapshot: async () => {
      const { data, error } = await client.from("brain_snapshots").select(
        "id,version,content_hash,source_hash,payload,compiled_platform,platform_tokens,knowledge_mode,eval_run_id,rollback_of_snapshot_id",
      ).order("version", { ascending: false }).limit(1).maybeSingle();
      if (error || !data) return null;
      return snapshotRow(data as Record<string, unknown>);
    },
    loadAudit: async (id) => {
      const { data, error } = await client.from("audit_log").select("id,action,payload").eq("id", id).single();
      if (error || !data) return null;
      if (data.action !== "brain.published" && data.action !== "brain.rolled_back") return null;
      return { id: Number(data.id), action: data.action, payload: data.payload as Readonly<Record<string, unknown>> };
    },
  };
}

export async function persistBrainDraftRevision(
  input: { actorId: string; contentHash: string; payload: Readonly<Record<string, unknown>> },
  dependencies?: BrainPublishDependencies,
): Promise<BrainDraftRevision> {
  const deps = dependencies ?? (await liveDependencies());
  const id = await deps.createDraft({
    p_actor_id: input.actorId,
    p_expected_content_hash: input.contentHash,
    p_payload: input.payload,
  });
  const persisted = await deps.loadDraft(id);
  if (!persisted || persisted.contentHash !== input.contentHash || persisted.createdBy !== input.actorId) {
    throw new Error("BRAIN_DRAFT_READBACK_MISMATCH");
  }
  return persisted;
}

async function readTransition(
  row: TransitionRow,
  expected: { version: number; action: BrainAuditReceipt["action"] },
  deps: BrainPublishDependencies,
) {
  const [snapshot, audit] = await Promise.all([
    deps.loadSnapshotById(row.snapshot_id),
    deps.loadAudit(row.audit_id),
  ]);
  if (!snapshot || snapshot.version !== row.brain_version || snapshot.version !== expected.version) {
    throw new Error("BRAIN_SNAPSHOT_READBACK_MISMATCH");
  }
  if (!audit || audit.id !== row.audit_id || audit.action !== expected.action) {
    throw new Error("BRAIN_AUDIT_READBACK_MISMATCH");
  }
  return { snapshot, audit };
}

export async function persistBrainPublish(
  input: {
    actorId: string;
    draftId: string;
    contentHash: string;
    evalRunId: string;
    expectedCurrentVersion: number;
    reason: string;
  },
  dependencies?: BrainPublishDependencies,
): Promise<BrainTransitionReceipt> {
  const deps = dependencies ?? (await liveDependencies());
  const current = await deps.loadCurrentSnapshot();
  if ((current?.version ?? 0) !== input.expectedCurrentVersion) {
    throw new Error("BRAIN_PUBLISH_CURRENT_VERSION_STALE");
  }
  const row = await deps.publish({
    p_actor_id: input.actorId,
    p_expected_draft_id: input.draftId,
    p_expected_content_hash: input.contentHash,
    p_eval_run_id: input.evalRunId,
    p_reason: input.reason,
  });
  return readTransition(row, {
    version: input.expectedCurrentVersion + 1,
    action: "brain.published",
  }, deps);
}

export async function persistBrainRollback(
  input: { actorId: string; expectedCurrentVersion: number; selectedVersion: number; reason: string },
  dependencies?: BrainPublishDependencies,
): Promise<BrainTransitionReceipt> {
  const deps = dependencies ?? (await liveDependencies());
  const row = await deps.rollback({
    p_actor_id: input.actorId,
    p_expected_current_version: input.expectedCurrentVersion,
    p_selected_version: input.selectedVersion,
    p_reason: input.reason,
  });
  return readTransition(row, {
    version: input.expectedCurrentVersion + 1,
    action: "brain.rolled_back",
  }, deps);
}

export async function loadCurrentBrainSnapshot(dependencies?: BrainPublishDependencies) {
  return (dependencies ?? (await liveDependencies())).loadCurrentSnapshot();
}

export async function loadBrainSnapshotVersion(version: number, dependencies?: BrainPublishDependencies) {
  return (dependencies ?? (await liveDependencies())).loadSnapshotByVersion(version);
}
