/** Admin review acceptance loads source content from the stored batch, never from the request. */

import {
  buildAcceptancePayload,
  type BareXResolution,
  type NormalizedImportItem,
} from "@/lib/brain/import/normalize";
import {
  FIGURE_BINDING_FIELDS,
  figuresInResponse,
  type ImportFlag,
  type NumberBinding,
} from "@/lib/brain/import/flags";
import type { ImportDisposition } from "@/lib/brain/contracts";
import {
  acceptBrainImportItem,
  type BrainImportAcceptanceReceipt,
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

type LoadedImportItem = { item: NormalizedImportItem; embedding: readonly number[] };

type AcceptDependencies = {
  enabled(): boolean;
  session(): Promise<PlatformActor | null>;
  load(batchId: string, itemId: string): Promise<LoadedImportItem | null>;
  accept(input: Parameters<typeof acceptBrainImportItem>[0]): Promise<BrainImportAcceptanceReceipt>;
};

function stringArray(value: unknown) {
  return Array.isArray(value) && value.every((item) => nonBlank(item))
    ? value.map((item) => String(item).trim())
    : null;
}

function numberBindings(value: unknown): NumberBinding[] | null {
  if (!Array.isArray(value)) return null;
  const output: NumberBinding[] = [];
  for (const candidate of value) {
    if (!isRouteRecord(candidate) || !hasExactKeys(candidate, ["binding", "field", "kind", "offset", "value"]) ||
      !["currency", "percentage", "score"].includes(String(candidate.kind)) ||
      candidate.field !== "responseTemplate" || !Number.isFinite(candidate.value) ||
      !Number.isSafeInteger(candidate.offset) || Number(candidate.offset) < 0 ||
      typeof candidate.binding !== "string" || !FIGURE_BINDING_FIELDS.includes(
        candidate.binding as (typeof FIGURE_BINDING_FIELDS)[number],
      )) return null;
    output.push(candidate as NumberBinding);
  }
  return output;
}

function bareXResolutions(value: unknown): BareXResolution[] | null {
  if (!Array.isArray(value)) return null;
  const output: BareXResolution[] = [];
  for (const candidate of value) {
    if (!isRouteRecord(candidate) || !hasExactKeys(candidate, ["offset", "token"]) ||
      !Number.isSafeInteger(candidate.offset) || Number(candidate.offset) < 0 ||
      (candidate.token !== "booking_link" &&
        !(typeof candidate.token === "string" && /^asset\.[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate.token)))) {
      return null;
    }
    output.push(candidate as BareXResolution);
  }
  return output;
}

function storedFlag(value: unknown): value is ImportFlag {
  if (!isRouteRecord(value) || typeof value.id !== "string" || typeof value.code !== "string" ||
    value.severity !== "blocking" || typeof value.field !== "string" ||
    !Number.isSafeInteger(value.offset) || typeof value.resolved !== "boolean") return false;
  return value.resolution === null || isRouteRecord(value.resolution);
}

async function loadStoredItem(batchId: string, itemId: string): Promise<LoadedImportItem | null> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client
    .from("brain_import_items")
    .select("id,batch_id,source_ref,after_payload,flags")
    .eq("id", itemId)
    .eq("batch_id", batchId)
    .eq("decision", "pending")
    .maybeSingle();
  if (error) throw new Error(`BRAIN_IMPORT_ITEM_READ_FAILED:${error.message}`);
  if (!data) return null;
  if (!isRouteRecord(data.after_payload) || !Array.isArray(data.flags) ||
    !data.flags.every(storedFlag)) throw new Error("BRAIN_IMPORT_ITEM_READBACK_INVALID");
  const payload = data.after_payload;
  if (!nonBlank(data.source_ref) || typeof payload.category !== "string" ||
    typeof payload.inboundMessage !== "string" || typeof payload.responseTemplate !== "string" ||
    !Array.isArray(payload.matchKeywords) ||
    !payload.matchKeywords.every((value) => typeof value === "string") ||
    !Array.isArray(payload.embedding) || payload.embedding.length !== 1_536 ||
    payload.embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error("BRAIN_IMPORT_ITEM_READBACK_INVALID");
  }
  const flags = data.flags as ImportFlag[];
  return {
    item: {
      sourceRef: data.source_ref,
      sourceEditedAt: null,
      categories: payload.category ? [payload.category] : [],
      category: payload.category,
      inboundMessage: payload.inboundMessage,
      responseTemplate: payload.responseTemplate,
      matchKeywords: payload.matchKeywords as string[],
      flags,
      figures: figuresInResponse(payload.responseTemplate),
      sourceShapeValid: !flags.some((flag) => flag.code === "source_shape"),
    },
    embedding: payload.embedding as number[],
  };
}

export function createBrainImportAcceptHandler(dependencies: AcceptDependencies) {
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
      if (!isRouteRecord(raw) || !hasExactKeys(raw, [
        "bareXResolutions",
        "disposition",
        "numberBindings",
        "resolvedFlagIds",
        "sourceRef",
      ])) throw new Error("BRAIN_IMPORT_ACCEPT_BODY_INVALID");
      const disposition = raw.disposition;
      const bindings = numberBindings(raw.numberBindings);
      const resolvedFlagIds = stringArray(raw.resolvedFlagIds);
      const bareResolutions = bareXResolutions(raw.bareXResolutions);
      if (!nonBlank(raw.sourceRef) ||
        !["shared", "tenant_specific", "needs_rewrite"].includes(String(disposition)) ||
        !bindings || !resolvedFlagIds || !bareResolutions) {
        throw new Error("BRAIN_IMPORT_ACCEPT_BODY_INVALID");
      }
      const { batchId, itemId } = await context.params;
      const stored = await dependencies.load(batchId, itemId);
      if (!stored || stored.item.sourceRef !== raw.sourceRef.trim()) {
        return Response.json(
          { state: "refused", code: "BRAIN_IMPORT_ITEM_NOT_FOUND" },
          { status: 404, headers: PHASE2_NO_STORE_HEADERS },
        );
      }
      const reviewed = buildAcceptancePayload(stored.item, {
        disposition: disposition as ImportDisposition,
        numberBindings: bindings,
        resolvedFlagIds,
        bareXResolutions: bareResolutions,
      });
      if (!reviewed) {
        return Response.json(
          { state: "refused", code: "BRAIN_IMPORT_BLOCKING_FLAGS_UNRESOLVED" },
          { status: 409, headers: PHASE2_NO_STORE_HEADERS },
        );
      }
      const receipt = await dependencies.accept({
        batchId,
        itemId,
        sourceRef: reviewed.sourceRef,
        disposition: reviewed.disposition,
        afterPayload: reviewed.afterPayload,
        flags: reviewed.flags,
        numberBindings: reviewed.numberBindings,
        embedding: stored.embedding,
        actorId: actor.userId,
      });
      return Response.json({ state: "accepted", receipt }, { headers: PHASE2_NO_STORE_HEADERS });
    } catch {
      return Response.json(
        { state: "refused", code: "BRAIN_IMPORT_ACCEPT_REFUSED" },
        { status: 400, headers: PHASE2_NO_STORE_HEADERS },
      );
    }
  };
}

export const POST = createBrainImportAcceptHandler({
  enabled: phase2Live,
  session: loadPlatformActor,
  load: loadStoredItem,
  accept: acceptBrainImportItem,
});
