/**
 * Number provenance for published knowledge entries.
 *
 * A figure in a reviewed answer is bound to the offer-layer field that supplies it or declared a
 * platform constant at import review. The binding is only authoritative for the exact response
 * text it was reviewed against, so the hash of that text travels with the bindings and is checked
 * here before any binding is trusted. `app.brain_rewrite_hash` computes the same value in SQL.
 */

import { createHash } from "node:crypto";

import type { KnowledgeNumberBinding } from "@/lib/brain/contracts";
import type { NumberKind } from "@/lib/engine/types";

export const NUMBER_BINDING_FIELDS = [
  "credit_min",
  "funding_goal_min_cents",
  "funding_goal_max_cents",
  "monthly_revenue_min_cents",
  "results_timeline_min_days",
  "results_timeline_max_days",
  "offer_prices",
  "booking_horizon_days",
  "platform_constant",
] as const;

const NUMBER_KINDS: readonly NumberKind[] = ["currency", "percentage", "score"];

export function rewriteHash(responseTemplate: string) {
  return createHash("sha256").update(responseTemplate, "utf8").digest("hex");
}

/**
 * Narrows a persisted `number_bindings` array. A malformed element is refused rather than
 * skipped, because a binding that cannot be read is a review record that cannot be trusted.
 */
export function knowledgeNumberBindings(value: unknown): KnowledgeNumberBinding[] {
  if (!Array.isArray(value)) throw new Error("BRAIN_NUMBER_BINDINGS_INVALID");
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("BRAIN_NUMBER_BINDINGS_INVALID");
    }
    const row = candidate as Record<string, unknown>;
    if (
      !NUMBER_KINDS.includes(row.kind as NumberKind) ||
      typeof row.value !== "number" || !Number.isFinite(row.value) ||
      typeof row.binding !== "string" ||
      !NUMBER_BINDING_FIELDS.includes(row.binding as (typeof NUMBER_BINDING_FIELDS)[number])
    ) throw new Error("BRAIN_NUMBER_BINDINGS_INVALID");
    return {
      kind: row.kind as NumberKind,
      value: row.value,
      binding: row.binding as (typeof NUMBER_BINDING_FIELDS)[number],
      ...(Number.isInteger(row.offset) ? { offset: row.offset as number } : {}),
    };
  });
}

/**
 * The bindings that may ground numbers for this entry, or none when the response text is no
 * longer the text that was reviewed. Absent hash means the entry was never reviewed for figures.
 */
export function authoritativeBindings(entry: {
  responseTemplate: string;
  numberBindings: readonly KnowledgeNumberBinding[];
  rewriteHash: string | null;
}): readonly KnowledgeNumberBinding[] {
  if (!entry.rewriteHash) return [];
  return rewriteHash(entry.responseTemplate) === entry.rewriteHash ? entry.numberBindings : [];
}
