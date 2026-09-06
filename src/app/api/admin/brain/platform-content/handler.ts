/**
 * Owner read and draft-save of the platform agent content the pipeline sends verbatim.
 *
 * GET returns what the pipeline reads today, the saved draft if any, the Brain-owned mission and
 * qualification read-only, and the slots that would block approval. PUT stores a draft and nothing
 * else: the approved row the pipeline reads is untouched until `/approve` runs.
 */

import { loadPlatformActor, type PlatformActor } from "@/lib/auth/actors";
import { phase2Live } from "@/lib/env-contract";
import {
  loadPlatformAgentContentView,
  parsePlatformAgentContentDraft,
  PlatformAgentContentError,
  savePlatformAgentContentDraft,
  type PlatformAgentContentAudit,
  type PlatformAgentContentDraftInput,
  type PlatformAgentContentView,
} from "@/lib/repositories/platform-agent-content";

import { isBrainAdmin, PHASE2_NO_STORE_HEADERS } from "../import/handler";

export type PlatformContentDependencies = {
  enabled(): boolean;
  session(): Promise<PlatformActor | null>;
  load(): Promise<PlatformAgentContentView>;
  save(input: { actorId: string; draft: PlatformAgentContentDraftInput }): Promise<{
    view: PlatformAgentContentView;
    audit: PlatformAgentContentAudit;
  }>;
};

const CONFLICT_CODES = new Set([
  "PLATFORM_CONTENT_DRAFT_STALE",
  "PLATFORM_CONTENT_DRAFT_REQUIRED",
  "PLATFORM_CONTENT_NOT_APPROVABLE",
  "PLATFORM_SETTINGS_ROW_REQUIRED",
]);

/** Shared by the read, save and approve routes so a refusal reads the same everywhere. */
export function platformContentErrorResponse(error: unknown, fallbackCode: string) {
  if (error instanceof PlatformAgentContentError) {
    if (error.code === "PLATFORM_CONTENT_ADMIN_REQUIRED") {
      return Response.json({ state: "refused", code: error.code }, { status: 403, headers: PHASE2_NO_STORE_HEADERS });
    }
    if (CONFLICT_CODES.has(error.code)) {
      return Response.json({
        state: "blocked",
        code: error.code,
        ...(error.code === "PLATFORM_CONTENT_NOT_APPROVABLE" && error.detail
          ? { blockers: error.detail.split(",").filter(Boolean) }
          : {}),
      }, { status: 409, headers: PHASE2_NO_STORE_HEADERS });
    }
    return Response.json({ state: "refused", code: error.code }, { status: 400, headers: PHASE2_NO_STORE_HEADERS });
  }
  console.error("[platform-content] refused", error instanceof Error ? error.message : error);
  return Response.json({ state: "refused", code: fallbackCode }, { status: 400, headers: PHASE2_NO_STORE_HEADERS });
}

export function createPlatformContentReadHandler(dependencies: Pick<PlatformContentDependencies, "enabled" | "session" | "load">) {
  return async function GET() {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: PHASE2_NO_STORE_HEADERS });
    }
    const actor = await dependencies.session();
    if (!isBrainAdmin(actor)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: PHASE2_NO_STORE_HEADERS });
    }
    try {
      return Response.json(await dependencies.load(), { headers: PHASE2_NO_STORE_HEADERS });
    } catch (error) {
      return platformContentErrorResponse(error, "PLATFORM_CONTENT_READ_REFUSED");
    }
  };
}

export function createPlatformContentSaveHandler(dependencies: Pick<PlatformContentDependencies, "enabled" | "session" | "save">) {
  return async function PUT(request: Request) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: PHASE2_NO_STORE_HEADERS });
    }
    const actor = await dependencies.session();
    if (!isBrainAdmin(actor)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: PHASE2_NO_STORE_HEADERS });
    }
    let draft: PlatformAgentContentDraftInput | null;
    try {
      draft = parsePlatformAgentContentDraft(await request.json());
    } catch {
      draft = null;
    }
    if (!draft) {
      return Response.json(
        { state: "refused", code: "PLATFORM_CONTENT_DRAFT_BODY_INVALID" },
        { status: 400, headers: PHASE2_NO_STORE_HEADERS },
      );
    }
    try {
      const saved = await dependencies.save({ actorId: actor.userId, draft });
      return Response.json({ state: "draft", ...saved }, { headers: PHASE2_NO_STORE_HEADERS });
    } catch (error) {
      return platformContentErrorResponse(error, "PLATFORM_CONTENT_DRAFT_REFUSED");
    }
  };
}

const live: PlatformContentDependencies = {
  enabled: phase2Live,
  session: loadPlatformActor,
  load: () => loadPlatformAgentContentView(),
  save: (input) => savePlatformAgentContentDraft(input),
};

export const GET = createPlatformContentReadHandler(live);
export const PUT = createPlatformContentSaveHandler(live);
