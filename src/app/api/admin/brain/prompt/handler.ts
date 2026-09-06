/**
 * The assembled system prompt for a coach and Brain revision, block by block.
 *
 * Built by the same `assemblePrompt` the test turn and every production turn run through, so the
 * blocks shown here are the blocks the model sees. The tenant tag nonce is redacted the way the
 * prompt hash canonicalizes it.
 */

import { loadPlatformActor, type PlatformActor } from "@/lib/auth/actors";
import { phase2Live } from "@/lib/env-contract";
import {
  loadPromptInspection,
  type PromptInspection,
} from "@/lib/repositories/brain-prompt-inspection";
import { BRAIN_REVISIONS, type BrainRevision } from "@/lib/repositories/brain-revision-runtime";

import { isBrainAdmin, PHASE2_NO_STORE_HEADERS } from "../import/handler";
import { notReadyCode } from "../test-turn/handler";

export type PromptInspectionDependencies = {
  enabled(): boolean;
  session(): Promise<PlatformActor | null>;
  inspect(input: { tenantId: string; revision: BrainRevision }): Promise<PromptInspection>;
};

export function parsePromptQuery(url: URL): { tenantId: string; revision: BrainRevision } | null {
  const keys = [...url.searchParams.keys()].sort().join(",");
  if (keys !== "coachTenantId,revision") return null;
  const tenantId = url.searchParams.get("coachTenantId")?.trim() ?? "";
  const revision = url.searchParams.get("revision");
  if (!tenantId || !(BRAIN_REVISIONS as readonly unknown[]).includes(revision)) return null;
  return { tenantId, revision: revision as BrainRevision };
}

export function createBrainPromptHandler(dependencies: PromptInspectionDependencies) {
  return async function GET(request: Request) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: PHASE2_NO_STORE_HEADERS });
    }
    const actor = await dependencies.session();
    if (!isBrainAdmin(actor)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: PHASE2_NO_STORE_HEADERS });
    }
    const query = parsePromptQuery(new URL(request.url));
    if (!query) {
      return Response.json(
        { state: "refused", code: "BRAIN_PROMPT_QUERY_INVALID" },
        { status: 400, headers: PHASE2_NO_STORE_HEADERS },
      );
    }
    try {
      return Response.json({ state: "assembled", ...(await dependencies.inspect(query)) }, { headers: PHASE2_NO_STORE_HEADERS });
    } catch (error) {
      const code = notReadyCode(error);
      if (code) {
        return Response.json({ state: "not_ready", code }, { status: 409, headers: PHASE2_NO_STORE_HEADERS });
      }
      console.error("[brain-prompt] inspection refused", error instanceof Error ? error.message : error);
      return Response.json(
        { state: "refused", code: "BRAIN_PROMPT_REFUSED" },
        { status: 400, headers: PHASE2_NO_STORE_HEADERS },
      );
    }
  };
}

export const GET = createBrainPromptHandler({
  enabled: phase2Live,
  session: loadPlatformActor,
  inspect: (input) => loadPromptInspection(input),
});
