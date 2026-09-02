import { contactDeleteLive, phase1Live, phase3Live } from "@/lib/env-contract";
import { deleteLead } from "@/lib/deletion/service";
import type { DeletionRetryReceipt } from "@/lib/deletion/contracts";
import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import {
  contactDeletedEvent,
  createComplianceEventEmitter,
  createNotificationRepository,
} from "@/lib/notifications/events";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const noStoreHeaders = { "Cache-Control": "no-store" };

type Dependencies = {
  session(): Promise<RouteActor | null>;
  remove: typeof deleteLead;
  isTestContact?(tenantId: string, contactId: string): Promise<boolean>;
  emitDeleted?(input: { tenantId: string; contactId: string; auditId: number; isTest: boolean }): Promise<void>;
};

function enabled() {
  return phase1Live() && phase3Live() && contactDeleteLive();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createContactDeleteHandler(dependencies: Dependencies) {
  return async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
    if (!enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    const actor = await dependencies.session();
    if (!actor) return Response.json({ error: "Authentication required." }, { status: 401, headers: noStoreHeaders });
    if (!["owner", "admin", "success", "coach"].includes(actor.role ?? "")) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: noStoreHeaders });
    }
    try {
      const body: unknown = await request.json();
      if (!isRecord(body) || Object.keys(body).some((key) =>
        !["reason", "previewToken", "idempotencyKey", "retry"].includes(key)
      ) || typeof body.reason !== "string" || typeof body.previewToken !== "string" ||
        typeof body.idempotencyKey !== "string" ||
        (body.retry !== undefined && body.retry !== null && !isRecord(body.retry))) {
        throw new Error("CONTACT_DELETE_BODY_INVALID");
      }
      const { id } = await context.params;
      const isTest = dependencies.isTestContact
        ? await dependencies.isTestContact(actor.tenantId, id)
        : false;
      const result = await dependencies.remove({
        tenantId: actor.tenantId,
        contactId: id,
        actorId: actor.userId,
        reason: body.reason,
        previewToken: body.previewToken,
        idempotencyKey: body.idempotencyKey,
        retry: (body.retry ?? null) as DeletionRetryReceipt | null,
      });
      if (result.kind === "deleted" && !result.replayed && dependencies.emitDeleted) {
        await dependencies.emitDeleted({
          tenantId: actor.tenantId,
          contactId: id,
          auditId: result.auditId,
          isTest,
        });
      }
      return Response.json({ result }, {
        status: result.kind === "deleted" ? 200 : 409,
        headers: noStoreHeaders,
      });
    } catch {
      return Response.json({ error: "Contact deletion was refused." }, { status: 409, headers: noStoreHeaders });
    }
  };
}

export const DELETE = createContactDeleteHandler({
  session: loadRouteActor,
  remove: deleteLead,
  isTestContact: async (tenantId, contactId) => {
    const client = createSupabaseServiceClient();
    const { data, error } = await client.from("contacts").select("is_test")
      .eq("tenant_id", tenantId).eq("id", contactId).single();
    if (error || !data) throw new Error("CONTACT_DELETE_SCOPE_FAILED");
    return data.is_test;
  },
  emitDeleted: async (input) => {
    const emitComplianceEvent = createComplianceEventEmitter(createNotificationRepository());
    await emitComplianceEvent(contactDeletedEvent({
      ...input,
      occurredAt: new Date().toISOString(),
    }));
  },
});
