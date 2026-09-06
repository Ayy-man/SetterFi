/**
 * Question variants on knowledge entries: the admin write.
 *
 * A variant is an alternative phrasing of an entry's inbound question. It is embedded exactly the
 * way the import path embeds the question (the variant text only, never the answer), and the
 * `add_brain_knowledge_entry_variant` RPC inserts the row and its audit row in one transaction.
 * Rows are immutable at the table, so this module has no edit and no delete. The read lives with
 * the Brain page, which loads every entry's variants in one query beside the entries themselves.
 */

import { resolveEmbeddingsDriver } from "@/lib/integrations/embeddings/selector";
import { EMBEDDING_DIMENSIONS, type EmbeddingsDriver } from "@/lib/integrations/embeddings/types";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const BRAIN_VARIANT_MAX_LENGTH = 500;
export const BRAIN_VARIANT_AUDIT_ACTION = "brain.knowledge.variant_added" as const;

export type BrainKnowledgeVariant = {
  id: string;
  entryId: string;
  variant: string;
  createdAt: string;
};

export type BrainKnowledgeVariantReceipt = {
  variant: BrainKnowledgeVariant;
  auditId: number;
  auditAction: typeof BRAIN_VARIANT_AUDIT_ACTION;
};

export class BrainKnowledgeVariantError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BrainKnowledgeVariantError";
  }
}

type StoredEntry = { id: string; question: string; variants: readonly string[] };
type AddRpcRow = { variant_id: string; audit_id: number };

export type BrainKnowledgeVariantDependencies = {
  loadEntry(entryId: string): Promise<StoredEntry | null>;
  embeddings(): EmbeddingsDriver;
  callAdd(args: {
    p_actor_id: string;
    p_entry_id: string;
    p_variant: string;
    p_embedding: readonly number[];
  }): Promise<AddRpcRow>;
  readVariant(variantId: string): Promise<BrainKnowledgeVariant | null>;
};

function sameText(left: string, right: string) {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * The text rule, applied before any provider call so a refused phrasing costs nothing: trimmed,
 * non-empty, at most 500 characters, and not a restatement of the question or of a variant the
 * entry already carries. The RPC applies the same rule again inside its transaction.
 */
export function validateBrainVariantText(
  raw: string,
  against: { question: string; variants: readonly string[] },
) {
  const variant = raw.trim();
  if (!variant) throw new BrainKnowledgeVariantError("BRAIN_VARIANT_TEXT_REQUIRED");
  if (variant.length > BRAIN_VARIANT_MAX_LENGTH) throw new BrainKnowledgeVariantError("BRAIN_VARIANT_TOO_LONG");
  if (sameText(variant, against.question)) throw new BrainKnowledgeVariantError("BRAIN_VARIANT_MATCHES_QUESTION");
  if (against.variants.some((existing) => sameText(existing, variant))) {
    throw new BrainKnowledgeVariantError("BRAIN_VARIANT_DUPLICATE");
  }
  return variant;
}

function liveDependencies(): BrainKnowledgeVariantDependencies {
  const client = createSupabaseServiceClient();
  return {
    loadEntry: async (entryId) => {
      const [{ data: entry, error: entryError }, { data: rows, error: rowsError }] = await Promise.all([
        client.from("brain_knowledge_entries").select("id,question").eq("id", entryId).maybeSingle(),
        client.from("brain_knowledge_entry_variants").select("variant").eq("entry_id", entryId),
      ]);
      if (entryError || rowsError) throw new Error("BRAIN_VARIANT_ENTRY_READ_FAILED");
      if (!entry) return null;
      return {
        id: String(entry.id),
        question: typeof entry.question === "string" ? entry.question : "",
        variants: (rows ?? []).map((row) => String(row.variant)),
      };
    },
    embeddings: () => resolveEmbeddingsDriver(),
    callAdd: async (args) => {
      const { data, error } = await client.rpc("add_brain_knowledge_entry_variant", args);
      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row || typeof row !== "object") throw new Error("BRAIN_VARIANT_RPC_SHAPE_INVALID");
      const value = row as Record<string, unknown>;
      return { variant_id: String(value.variant_id), audit_id: Number(value.audit_id) };
    },
    readVariant: async (variantId) => {
      const { data, error } = await client
        .from("brain_knowledge_entry_variants")
        .select("id,entry_id,variant,created_at")
        .eq("id", variantId)
        .maybeSingle();
      if (error || !data) return null;
      return { id: String(data.id), entryId: String(data.entry_id), variant: String(data.variant), createdAt: String(data.created_at) };
    },
  };
}

/** Maps a Postgres refusal from the RPC onto the typed code the route answers with. */
function rpcRefusal(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = [
    "BRAIN_VARIANT_TEXT_REQUIRED",
    "BRAIN_VARIANT_TOO_LONG",
    "BRAIN_VARIANT_MATCHES_QUESTION",
    "BRAIN_VARIANT_DUPLICATE",
    "BRAIN_KNOWLEDGE_ENTRY_NOT_FOUND",
    "PHASE2_PLATFORM_ACTOR_FORBIDDEN",
    "IMPERSONATION_WRITE_FORBIDDEN",
  ].find((known) => message.includes(known));
  return code ? new BrainKnowledgeVariantError(code) : cause;
}

export async function addBrainKnowledgeEntryVariant(
  input: { entryId: string; variant: string; actorId: string },
  provided?: BrainKnowledgeVariantDependencies,
): Promise<BrainKnowledgeVariantReceipt> {
  const deps = provided ?? liveDependencies();
  const entryId = input.entryId.trim();
  if (!entryId) throw new BrainKnowledgeVariantError("BRAIN_KNOWLEDGE_ENTRY_NOT_FOUND");
  if (!input.actorId.trim()) throw new BrainKnowledgeVariantError("BRAIN_VARIANT_ACTOR_REQUIRED");
  const entry = await deps.loadEntry(entryId);
  if (!entry) throw new BrainKnowledgeVariantError("BRAIN_KNOWLEDGE_ENTRY_NOT_FOUND");
  const variant = validateBrainVariantText(input.variant, entry);

  const embedded = await deps.embeddings().embed([{ id: "variant", text: variant }]);
  const vector = embedded.length === 1 && embedded[0].id === "variant" ? embedded[0].vector : null;
  if (!vector || vector.length !== EMBEDDING_DIMENSIONS || vector.some((value) => !Number.isFinite(value))) {
    throw new BrainKnowledgeVariantError("BRAIN_VARIANT_EMBEDDING_INVALID");
  }

  let rpc: AddRpcRow;
  try {
    rpc = await deps.callAdd({
      p_actor_id: input.actorId,
      p_entry_id: entry.id,
      p_variant: variant,
      p_embedding: vector,
    });
  } catch (cause) {
    throw rpcRefusal(cause);
  }
  if (!rpc.variant_id || !Number.isSafeInteger(rpc.audit_id)) {
    throw new BrainKnowledgeVariantError("BRAIN_VARIANT_RECEIPT_INVALID");
  }
  const stored = await deps.readVariant(rpc.variant_id);
  if (!stored || stored.entryId !== entry.id || stored.variant !== variant) {
    throw new BrainKnowledgeVariantError("BRAIN_VARIANT_READBACK_MISMATCH");
  }
  return { variant: stored, auditId: rpc.audit_id, auditAction: BRAIN_VARIANT_AUDIT_ACTION };
}
