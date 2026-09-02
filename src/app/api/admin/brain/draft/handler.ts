/** Immutable Brain draft revisions accept only the reviewed canonical payload shape. */

import type { BrainDraftPayloadInput } from "@/lib/brain/snapshot/canonicalize";
import { createBrainDraftRevision } from "@/lib/brain/snapshot/publish";
import { phase2Live } from "@/lib/env-contract";
import {
  loadPlatformActor,
  type PlatformActor,
} from "@/lib/auth/actors";

import {
  hasExactKeys,
  isBrainAdmin,
  isRouteRecord,
  PHASE2_NO_STORE_HEADERS,
} from "../import/handler";

type DraftDependencies = {
  enabled(): boolean;
  session(): Promise<PlatformActor | null>;
  create(input: { actorId: string; draft: BrainDraftPayloadInput }): ReturnType<typeof createBrainDraftRevision>;
};

function draftPayload(value: unknown): BrainDraftPayloadInput | null {
  if (!isRouteRecord(value)) return null;
  const allowed = [
    "compiledPlatform",
    "entities",
    "knowledgeMode",
    "placeholderResolutionHash",
    "placeholderSchemaHash",
    "platformTokens",
    "sourceHash",
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key)) || !Array.isArray(value.entities) ||
    typeof value.compiledPlatform !== "string" || !Number.isSafeInteger(value.platformTokens) ||
    (value.knowledgeMode !== "inline" && value.knowledgeMode !== "retrieved")) return null;
  for (const entity of value.entities) {
    if (!isRouteRecord(entity) || !hasExactKeys(entity, ["id", "type", "value"]) ||
      typeof entity.id !== "string" || typeof entity.type !== "string" || !isRouteRecord(entity.value)) return null;
  }
  for (const key of ["sourceHash", "placeholderSchemaHash", "placeholderResolutionHash"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") return null;
  }
  return value as unknown as BrainDraftPayloadInput;
}

export function createBrainDraftHandler(dependencies: DraftDependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: PHASE2_NO_STORE_HEADERS });
    }
    const actor = await dependencies.session();
    if (!isBrainAdmin(actor)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: PHASE2_NO_STORE_HEADERS });
    }
    try {
      const raw: unknown = await request.json();
      if (!isRouteRecord(raw) || !hasExactKeys(raw, ["draft"])) throw new Error("BRAIN_DRAFT_BODY_INVALID");
      const draft = draftPayload(raw.draft);
      if (!draft) throw new Error("BRAIN_DRAFT_BODY_INVALID");
      const revision = await dependencies.create({ actorId: actor.userId, draft });
      return Response.json({ state: "draft", revision }, { headers: PHASE2_NO_STORE_HEADERS });
    } catch {
      return Response.json(
        { state: "refused", code: "BRAIN_DRAFT_REFUSED" },
        { status: 400, headers: PHASE2_NO_STORE_HEADERS },
      );
    }
  };
}

export const POST = createBrainDraftHandler({
  enabled: phase2Live,
  session: loadPlatformActor,
  create: createBrainDraftRevision,
});
