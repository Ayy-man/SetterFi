/**
 * Admin review rejection. Like acceptance, the row identity comes from the stored batch and the
 * request may only name it; the reason is required because a rejected row leaves no knowledge
 * entry behind to explain the decision.
 */

import {
  rejectBrainImportItem,
  type BrainImportRejectionReceipt,
} from "@/lib/repositories/brain-import";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { phase2Live } from "@/lib/env-contract";
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
} from "../../../../../import/handler";

type StoredPendingItem = { sourceRef: string };

type RejectDependencies = {
  enabled(): boolean;
  session(): Promise<PlatformActor | null>;
  load(batchId: string, itemId: string): Promise<StoredPendingItem | null>;
  reject(input: Parameters<typeof rejectBrainImportItem>[0]): Promise<BrainImportRejectionReceipt>;
};

async function loadPendingItem(batchId: string, itemId: string): Promise<StoredPendingItem | null> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client
    .from("brain_import_items")
    .select("id,source_ref")
    .eq("id", itemId)
    .eq("batch_id", batchId)
    .eq("decision", "pending")
    .maybeSingle();
  if (error) throw new Error(`BRAIN_IMPORT_ITEM_READ_FAILED:${error.message}`);
  if (!data || !nonBlank(data.source_ref)) return null;
  return { sourceRef: data.source_ref };
}

export function createBrainImportRejectHandler(dependencies: RejectDependencies) {
  return async function POST(
    request: Request,
    context: { params: Promise<{ batchId: string; itemId: string }> },
  ) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: PHASE2_NO_STORE_HEADERS });
    }
    const actor = await dependencies.session();
    if (!isBrainAdmin(actor)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: PHASE2_NO_STORE_HEADERS });
    }
    try {
      const raw: unknown = await request.json();
      if (!isRouteRecord(raw) || !hasExactKeys(raw, ["reason", "sourceRef"])
        || !nonBlank(raw.sourceRef) || !nonBlank(raw.reason)) {
        throw new Error("BRAIN_IMPORT_REJECT_BODY_INVALID");
      }
      const { batchId, itemId } = await context.params;
      const stored = await dependencies.load(batchId, itemId);
      if (!stored || stored.sourceRef !== raw.sourceRef.trim()) {
        return Response.json(
          { state: "refused", code: "BRAIN_IMPORT_ITEM_NOT_FOUND" },
          { status: 404, headers: PHASE2_NO_STORE_HEADERS },
        );
      }
      const receipt = await dependencies.reject({
        batchId,
        itemId,
        sourceRef: stored.sourceRef,
        reason: raw.reason.trim(),
        actorId: actor.userId,
      });
      return Response.json({ state: "rejected", receipt }, { headers: PHASE2_NO_STORE_HEADERS });
    } catch {
      return Response.json(
        { state: "refused", code: "BRAIN_IMPORT_REJECT_REFUSED" },
        { status: 400, headers: PHASE2_NO_STORE_HEADERS },
      );
    }
  };
}

export const POST = createBrainImportRejectHandler({
  enabled: phase2Live,
  session: loadPlatformActor,
  load: loadPendingItem,
  reject: rejectBrainImportItem,
});
