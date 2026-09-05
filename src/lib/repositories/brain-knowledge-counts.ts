/**
 * Read side for the Brain knowledge figures: what is live and what a publish would change.
 *
 * Sourced from `brain_snapshot_entries` for the current snapshot and from the exact eligibility
 * filter `publish_brain_draft` applies, never from `brain_knowledge_entries.status`, which no
 * publish path writes.
 */

import {
  knowledgePublishCounts,
  type BrainKnowledgePublishCounts,
  type KnowledgeEntryForCounts,
  type LiveSnapshotEntryForCounts,
} from "@/components/workspace/live/brain-view-models";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type BrainKnowledgeCountDependencies = {
  /** Rows `publish_brain_draft` would copy: shared, draft, embedding present. */
  loadEligibleEntries(): Promise<readonly KnowledgeEntryForCounts[]>;
  loadCurrentSnapshot(): Promise<{ id: string; version: number } | null>;
  loadSnapshotEntries(snapshotId: string): Promise<readonly LiveSnapshotEntryForCounts[]>;
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function liveDependencies(): BrainKnowledgeCountDependencies {
  const client = createSupabaseServiceClient();
  return {
    loadEligibleEntries: async () => {
      const { data, error } = await client
        .from("brain_knowledge_entries")
        .select("id,category,question,response_template,match_keywords")
        .eq("disposition", "shared")
        .eq("status", "draft")
        .not("embedding", "is", null);
      if (error) throw new Error(`BRAIN_KNOWLEDGE_ELIGIBLE_READ_FAILED:${error.message}`);
      return (data ?? []).map((row) => ({
        id: row.id,
        disposition: "shared",
        status: "draft",
        hasEmbedding: true,
        category: row.category,
        inboundMessage: row.question,
        responseTemplate: row.response_template,
        matchKeywords: stringArray(row.match_keywords),
      }));
    },
    loadCurrentSnapshot: async () => {
      const { data, error } = await client
        .from("brain_snapshots")
        .select("id,version")
        .order("version", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`BRAIN_SNAPSHOT_READ_FAILED:${error.message}`);
      return data ? { id: data.id, version: data.version } : null;
    },
    loadSnapshotEntries: async (snapshotId) => {
      const { data, error } = await client
        .from("brain_snapshot_entries")
        .select("entry_id,category,inbound_message,response_template,match_keywords")
        .eq("snapshot_id", snapshotId);
      if (error) throw new Error(`BRAIN_SNAPSHOT_ENTRIES_READ_FAILED:${error.message}`);
      return (data ?? []).map((row) => ({
        entryId: row.entry_id,
        category: row.category,
        inboundMessage: row.inbound_message,
        responseTemplate: row.response_template,
        matchKeywords: stringArray(row.match_keywords),
      }));
    },
  };
}

export async function loadBrainKnowledgePublishCounts(
  provided?: BrainKnowledgeCountDependencies,
): Promise<BrainKnowledgePublishCounts> {
  const deps = provided ?? liveDependencies();
  const [entries, snapshot] = await Promise.all([deps.loadEligibleEntries(), deps.loadCurrentSnapshot()]);
  const snapshotEntries = snapshot ? await deps.loadSnapshotEntries(snapshot.id) : [];
  return knowledgePublishCounts(entries, snapshot ? { version: snapshot.version, entries: snapshotEntries } : null);
}
