/** Contact merge undo is audit-row driven, so the route accepts no reconstructed before-image. */

import type { AuditActionKey } from "@/lib/audit/actions";
import { phase4Live } from "@/lib/env-contract";
import {
  ContactMergeError,
  unmergeContact,
  type UnmergeResult,
} from "@/lib/services/contact-merge";
import {
  loadRouteActor,
  type RouteActor,
} from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";

const noStoreHeaders = { "Cache-Control": "no-store" };
const CONTACT_UNMERGED_ACTION = "contact.unmerged" satisfies AuditActionKey;

type UnmergeRouteDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  unmerge(input: Parameters<typeof unmergeContact>[0]): Promise<UnmergeResult>;
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

export function createContactUnmergeHandler(dependencies: UnmergeRouteDependencies) {
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
        { error: "Contact merge undo is unavailable while viewing as a coach." },
        { status: 403, headers: noStoreHeaders },
      );
    }

    try {
      const contactId = (await context.params).id.trim();
      const body: unknown = await request.json();
      if (!contactId || !isRecord(body) ||
        !hasExactKeys(body, ["mergeAuditId", "reason", "idempotencyKey"]) ||
        !Number.isSafeInteger(body.mergeAuditId) || Number(body.mergeAuditId) <= 0 ||
        !nonBlank(body.reason) || !nonBlank(body.idempotencyKey)) {
        throw new Error("CONTACT_UNMERGE_BODY_INVALID");
      }
      const result = await dependencies.unmerge({
        expectedTenantId: actor.tenantId,
        mergeAuditId: Number(body.mergeAuditId),
        actorUserId: actor.userId,
        reason: body.reason.trim(),
        idempotencyKey: body.idempotencyKey.trim(),
      });
      if (result.loserId !== contactId) throw new ContactMergeError("UNMERGE_CONFLICT");
      return Response.json({
        winnerId: result.winnerId,
        loserId: result.loserId,
        restoredIdentityCount: result.restoredIdentityCount,
        restoredConversationCount: result.restoredConversationCount,
        audit: { id: result.unmergeAuditId, action: CONTACT_UNMERGED_ACTION },
      }, { headers: noStoreHeaders });
    } catch (error) {
      const code = error instanceof ContactMergeError ? error.code : "UNMERGE_CONFLICT";
      return Response.json(
        { error: "Contact merge undo was refused.", code },
        { status: 409, headers: noStoreHeaders },
      );
    }
  };
}

export const POST = createContactUnmergeHandler({
  enabled: phase4Live,
  session: loadRouteActor,
  unmerge: unmergeContact,
});
