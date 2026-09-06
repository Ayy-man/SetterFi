/**
 * Approves the saved platform content draft: one RPC copies it over the row the pipeline reads,
 * flips `approved`, and writes the audit row, and the response is read back from those rows.
 */

import { loadPlatformActor, type PlatformActor } from "@/lib/auth/actors";
import { phase2Live } from "@/lib/env-contract";
import {
  approvePlatformAgentContent,
  PLATFORM_CONTENT_LIMITS,
  type PlatformAgentContentAudit,
  type PlatformAgentContentView,
} from "@/lib/repositories/platform-agent-content";

import { hasExactKeys, isBrainAdmin, isRouteRecord, nonBlank, PHASE2_NO_STORE_HEADERS } from "../../import/handler";
import { platformContentErrorResponse } from "../handler";

export type PlatformContentApproveDependencies = {
  enabled(): boolean;
  session(): Promise<PlatformActor | null>;
  approve(input: { actorId: string; expectedDraftHash: string; reason: string }): Promise<{
    view: PlatformAgentContentView;
    audit: PlatformAgentContentAudit;
    contentHash: string;
  }>;
};

export function createPlatformContentApproveHandler(dependencies: PlatformContentApproveDependencies) {
  return async function POST(request: Request) {
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
    if (!isRouteRecord(raw) || !hasExactKeys(raw, ["expectedDraftHash", "reason"]) ||
      typeof raw.expectedDraftHash !== "string" || !/^[0-9a-f]{64}$/.test(raw.expectedDraftHash) ||
      !nonBlank(raw.reason) || raw.reason.trim().length > PLATFORM_CONTENT_LIMITS.reason) {
      return Response.json(
        { state: "refused", code: "PLATFORM_CONTENT_APPROVE_BODY_INVALID" },
        { status: 400, headers: PHASE2_NO_STORE_HEADERS },
      );
    }
    try {
      const approved = await dependencies.approve({
        actorId: actor.userId,
        expectedDraftHash: raw.expectedDraftHash,
        reason: raw.reason.trim(),
      });
      return Response.json({ state: "approved", ...approved }, { headers: PHASE2_NO_STORE_HEADERS });
    } catch (error) {
      return platformContentErrorResponse(error, "PLATFORM_CONTENT_APPROVE_REFUSED");
    }
  };
}

export const POST = createPlatformContentApproveHandler({
  enabled: phase2Live,
  session: loadPlatformActor,
  approve: (input) => approvePlatformAgentContent(input),
});
