/**
 * The `knowledge_entry` draft-payload contract.
 *
 * A knowledge entry's retrieval behaviour is more than its question and answer: the reviewed
 * `number_bindings` decide which figures in the answer the runtime may say, `rewrite_hash` decides
 * whether those bindings still apply to the current text, and the question variants decide which
 * lead phrasings rank the entry. All three change what a publish does, so all three ride inside
 * the entity value that `canonicalizeBrainDraft` hashes and `diffBrainPayloads` walks. Left out,
 * an admin could rebind a figure or add a variant and see "nothing changed".
 *
 * Bindings and variants are sorted here so that reordering (the import detector emits bindings in
 * offset order; variants arrive in insertion order) does not mint a Brain version, while adding,
 * removing or rebinding one does. `publish_brain_draft` copies bindings and variants from the
 * authoring tables, not from this payload, so the payload is the hash record of what the
 * authoring rows held when the draft was saved, exactly as it is for the response text.
 */

import type { KnowledgeNumberBinding } from "@/lib/brain/contracts";
import { knowledgeNumberBindings } from "@/lib/brain/provenance";

export const BRAIN_KNOWLEDGE_ENTITY_TYPE = "knowledge_entry" as const;

export const BRAIN_KNOWLEDGE_PAYLOAD_KEYS = [
  "category",
  "inboundMessage",
  "responseTemplate",
  "status",
  "numberBindings",
  "rewriteHash",
  "variants",
] as const;

/** An immutable question variant: `brain_knowledge_entry_variants.id` and its text, never edited. */
export type BrainKnowledgeVariant = { id: string; text: string };

export type BrainKnowledgeDraftValue = {
  category: string;
  inboundMessage: string;
  responseTemplate: string;
  status: string;
  numberBindings: KnowledgeNumberBinding[];
  rewriteHash: string | null;
  variants: BrainKnowledgeVariant[];
};

export type BrainKnowledgeDraftInput = {
  id: string;
  category: string;
  inboundMessage: string;
  responseTemplate: string;
  status: string;
  numberBindings: readonly unknown[];
  rewriteHash: string | null;
  variants: readonly BrainKnowledgeVariant[];
};

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Narrows and sorts persisted bindings. Sort order is binding, kind, value, then offset, with an
 * offset-less binding first; the offset is kept because it is part of the review record even
 * though the runtime matches on kind and value alone.
 */
export function normalizeKnowledgeNumberBindings(value: readonly unknown[]): KnowledgeNumberBinding[] {
  return knowledgeNumberBindings([...value]).sort((left, right) =>
    compareText(left.binding, right.binding) ||
    compareText(left.kind, right.kind) ||
    left.value - right.value ||
    (left.offset ?? -1) - (right.offset ?? -1),
  );
}

/** Sorted by text then id; a blank text, blank id or repeated id is refused rather than hashed. */
export function normalizeKnowledgeVariants(
  entryId: string,
  variants: readonly BrainKnowledgeVariant[],
): BrainKnowledgeVariant[] {
  const seen = new Set<string>();
  return variants.map((variant) => {
    const id = variant.id.trim();
    const text = variant.text;
    if (!id || !text.trim()) throw new Error(`BRAIN_KNOWLEDGE_VARIANT_INVALID:${entryId}`);
    if (seen.has(id)) throw new Error(`BRAIN_KNOWLEDGE_VARIANT_DUPLICATE:${entryId}:${id}`);
    seen.add(id);
    return { id, text };
  }).sort((left, right) => compareText(left.text, right.text) || compareText(left.id, right.id));
}

export function brainKnowledgeDraftEntity(input: BrainKnowledgeDraftInput): {
  type: typeof BRAIN_KNOWLEDGE_ENTITY_TYPE;
  id: string;
  value: BrainKnowledgeDraftValue;
} {
  const id = input.id.trim();
  if (!id) throw new Error("BRAIN_KNOWLEDGE_ID_REQUIRED");
  return {
    type: BRAIN_KNOWLEDGE_ENTITY_TYPE,
    id,
    value: {
      category: input.category,
      inboundMessage: input.inboundMessage,
      responseTemplate: input.responseTemplate,
      status: input.status,
      numberBindings: normalizeKnowledgeNumberBindings(input.numberBindings),
      rewriteHash: input.rewriteHash,
      variants: normalizeKnowledgeVariants(id, input.variants),
    },
  };
}
