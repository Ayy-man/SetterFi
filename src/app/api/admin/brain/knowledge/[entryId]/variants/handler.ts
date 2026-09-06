/**
 * Adds one question variant to a knowledge entry.
 *
 * The body carries the phrasing and nothing else; the entry comes from the path. The repository
 * embeds the text the way the import path embeds a question, and the RPC writes the row and its
 * audit row together. Variants are immutable, so this route has no PUT or DELETE.
 */

import { loadPlatformActor, type PlatformActor } from "@/lib/auth/actors";
import { phase2Live } from "@/lib/env-contract";
import {
  addBrainKnowledgeEntryVariant,
  BrainKnowledgeVariantError,
  type BrainKnowledgeVariantReceipt,
} from "@/lib/repositories/brain-knowledge-variants";

import {
  hasExactKeys,
  isBrainAdmin,
  isRouteRecord,
  PHASE2_NO_STORE_HEADERS,
} from "../../../import/handler";

export const runtime = "nodejs";

type VariantDependencies = {
  enabled(): boolean;
  session(): Promise<PlatformActor | null>;
  add(input: { entryId: string; variant: string; actorId: string }): Promise<BrainKnowledgeVariantReceipt>;
};

/** Refusals the owner can act on, with the status each one answers. */
const REFUSAL_STATUS: Readonly<Record<string, number>> = {
  BRAIN_KNOWLEDGE_ENTRY_NOT_FOUND: 404,
  BRAIN_VARIANT_TEXT_REQUIRED: 400,
  BRAIN_VARIANT_TOO_LONG: 400,
  BRAIN_VARIANT_MATCHES_QUESTION: 409,
  BRAIN_VARIANT_DUPLICATE: 409,
};

export function createBrainVariantAddHandler(dependencies: VariantDependencies) {
  return async function POST(request: Request, context: { params: Promise<{ entryId: string }> }) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: PHASE2_NO_STORE_HEADERS });
    }
    const actor = await dependencies.session();
    if (!isBrainAdmin(actor)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: PHASE2_NO_STORE_HEADERS });
    }
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      raw = null;
    }
    if (!isRouteRecord(raw) || !hasExactKeys(raw, ["variant"]) || typeof raw.variant !== "string") {
      return Response.json(
        { state: "refused", code: "BRAIN_VARIANT_BODY_INVALID" },
        { status: 400, headers: PHASE2_NO_STORE_HEADERS },
      );
    }
    const { entryId } = await context.params;
    try {
      const receipt = await dependencies.add({ entryId, variant: raw.variant, actorId: actor.userId });
      return Response.json({ state: "added", ...receipt }, { headers: PHASE2_NO_STORE_HEADERS });
    } catch (error) {
      if (error instanceof BrainKnowledgeVariantError && REFUSAL_STATUS[error.code]) {
        return Response.json(
          { state: "refused", code: error.code },
          { status: REFUSAL_STATUS[error.code], headers: PHASE2_NO_STORE_HEADERS },
        );
      }
      console.error("[brain-variant] refused", error instanceof Error ? error.message : error);
      return Response.json(
        { state: "refused", code: "BRAIN_VARIANT_REFUSED" },
        { status: 400, headers: PHASE2_NO_STORE_HEADERS },
      );
    }
  };
}

export const POST = createBrainVariantAddHandler({
  enabled: phase2Live,
  session: loadPlatformActor,
  add: (input) => addBrainKnowledgeEntryVariant(input),
});
