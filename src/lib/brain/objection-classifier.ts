/**
 * Advisory objection classification hook.
 *
 * A classifier may look at an unmatched objection's body and suggest which `brain_objections` row
 * it best matches. The suggestion is written to `unmatched_objections.suggested_brain_objection_id`
 * (`supabase/migrations/20261012000008_unmatched_objection_suggestion.sql`) and never to
 * `brain_objection_id`, the confirmed field an admin sets on resolving the row. Every objection
 * stat counted anywhere reads only the confirmed field, so this stays advisory: a wrong or
 * low-confidence suggestion can never move a number, only prompt a person to look.
 *
 * No model call exists yet. `noopObjectionClassifier` is the default provider and always declines
 * -- this module is the interface and the storage write path a future classifier plugs into, not
 * a working classifier.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type ObjectionClassificationInput = {
  tenantId: string;
  conversationId: string | null;
  unmatchedObjectionId: string;
  body: string;
};

export type ObjectionClassificationSuggestion = {
  brainObjectionId: string;
  /** 0 to 1. A confidence outside that range is rejected by the write path, not clamped. */
  confidence: number;
  /** Identifies the classifier/model version that produced the suggestion, for later audit. */
  modelVersion: string;
};

export interface ObjectionClassifier {
  /**
   * Returns a suggestion, or `null` to decline (no match found, model unavailable, etc). Declining
   * is always safe: the unmatched objection simply carries no suggestion, same as before this hook
   * existed.
   */
  classify(
    input: ObjectionClassificationInput,
  ): Promise<ObjectionClassificationSuggestion | null>;
}

/** Default provider. Always declines. Swap for a real provider once one exists. */
export const noopObjectionClassifier: ObjectionClassifier = {
  async classify() {
    return null;
  },
};

export class ObjectionClassificationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ObjectionClassificationError";
  }
}

export type WriteObjectionSuggestionClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

/**
 * Runs the given classifier over an unmatched objection and, if it returns a suggestion, writes
 * it through `write_unmatched_objection_suggestion`. Intended to be called at conversation close
 * once a caller exists that owns that moment; nothing in this repository invokes it yet.
 */
export async function suggestObjectionMatch(
  input: ObjectionClassificationInput,
  classifier: ObjectionClassifier = noopObjectionClassifier,
  client: WriteObjectionSuggestionClient = createSupabaseServiceClient(),
): Promise<ObjectionClassificationSuggestion | null> {
  const tenantId = input.tenantId?.trim();
  const unmatchedObjectionId = input.unmatchedObjectionId?.trim();
  if (!tenantId || !unmatchedObjectionId) {
    throw new ObjectionClassificationError("OBJECTION_SUGGESTION_INPUT_INVALID");
  }
  const suggestion = await classifier.classify(input);
  if (suggestion === null) return null;
  if (
    typeof suggestion.confidence !== "number"
    || !Number.isFinite(suggestion.confidence)
    || suggestion.confidence < 0
    || suggestion.confidence > 1
    || !suggestion.brainObjectionId?.trim()
    || !suggestion.modelVersion?.trim()
  ) {
    throw new ObjectionClassificationError("OBJECTION_SUGGESTION_SHAPE_INVALID");
  }
  const { error } = await client.rpc("write_unmatched_objection_suggestion", {
    p_expected_tenant: tenantId,
    p_unmatched_objection_id: unmatchedObjectionId,
    p_brain_objection_id: suggestion.brainObjectionId,
    p_confidence: suggestion.confidence,
    p_model_version: suggestion.modelVersion,
  });
  if (error) throw new ObjectionClassificationError("OBJECTION_SUGGESTION_WRITE_FAILED");
  return suggestion;
}
