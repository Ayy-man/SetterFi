/** Explicit contact merge route; candidate evidence never invokes this handler by itself. */

import type { AuditActionKey } from "@/lib/audit/actions";
import { phase4Live } from "@/lib/env-contract";
import {
  CONTACT_MERGE_SOURCES,
  ContactMergeError,
  mergeContacts,
  type ContactMergeSource,
  type MergeResult,
} from "@/lib/services/contact-merge";
import {
  loadRouteActor,
  type RouteActor,
} from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";

const noStoreHeaders = { "Cache-Control": "no-store" };
const CONTACT_MERGED_ACTION = "contact.merged" satisfies AuditActionKey;

type MergeRouteDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  merge(input: Parameters<typeof mergeContacts>[0]): Promise<MergeResult>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isMergeSource(value: unknown): value is ContactMergeSource {
  return typeof value === "string" && CONTACT_MERGE_SOURCES.includes(value as ContactMergeSource);
}

export function createContactMergeHandler(dependencies: MergeRouteDependencies) {
  return async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    const actor = await dependencies.session();
    if (!actor) {
      return Response.json(
        { error: "Authentication required." },
        { status: 401, headers: noStoreHeaders },
      );
    }
    if (hasImpersonationMarker(actor)) {
      return Response.json(
        { error: "Contact merge is unavailable while viewing as a coach." },
        { status: 403, headers: noStoreHeaders },
      );
    }

    try {
      const winnerId = (await context.params).id.trim();
      const body: unknown = await request.json();
      if (!winnerId || !isRecord(body) || !hasExactKeys(body, [
        "loserId",
        "source",
        "evidenceId",
        "reason",
        "idempotencyKey",
      ]) || !nonBlank(body.loserId) || !isMergeSource(body.source) ||
        (body.evidenceId !== null && !nonBlank(body.evidenceId)) || !nonBlank(body.reason) ||
        !nonBlank(body.idempotencyKey)) {
        throw new Error("CONTACT_MERGE_BODY_INVALID");
      }
      const result = await dependencies.merge({
        expectedTenantId: actor.tenantId,
        winnerId,
        loserId: body.loserId.trim(),
        source: body.source,
        evidenceId: body.evidenceId === null ? null : body.evidenceId.trim(),
        actorUserId: actor.userId,
        reason: body.reason.trim(),
        idempotencyKey: body.idempotencyKey.trim(),
      });
      return Response.json({
        winnerId: result.winnerId,
        loserId: result.loserId,
        movedIdentityCount: result.movedIdentityCount,
        movedConversationCount: result.movedConversationCount,
        audit: { id: result.mergeAuditId, action: CONTACT_MERGED_ACTION },
      }, { headers: noStoreHeaders });
    } catch (error) {
      const code = error instanceof ContactMergeError ? error.code : "MERGE_CONFLICT";
      return Response.json(
        { error: "Contact merge was refused.", code },
        { status: 409, headers: noStoreHeaders },
      );
    }
  };
}

export const POST = createContactMergeHandler({
  enabled: phase4Live,
  session: loadRouteActor,
  merge: mergeContacts,
});
