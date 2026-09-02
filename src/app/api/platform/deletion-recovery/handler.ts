import { loadPlatformActor, type PlatformActor } from "@/lib/auth/actors";
import { recoverAdoptedContactDeletion } from "@/lib/deletion/recovery";
import { phase1Live } from "@/lib/env-contract";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const noStoreHeaders = { "Cache-Control": "no-store" };

type RecoveryIntent = {
  intentId: string;
  contactId: string;
  status: string;
  operatorRequired: boolean;
  lastError: string | null;
  attemptCount: number;
  updatedAt: string;
};

type Dependencies = {
  session(): Promise<PlatformActor | null>;
  list(tenantId: string, actorId: string): Promise<RecoveryIntent[]>;
  adopt(input: { tenantId: string; intentId: string; actorId: string; reason: string }): Promise<void>;
  resume(input: { tenantId: string; intentId: string; actorId: string }): Promise<string>;
};

function authorized(actor: PlatformActor | null) {
  return actor?.role === "owner" || actor?.role === "admin";
}

export function createDeletionRecoveryHandler(dependencies: Dependencies) {
  return {
    GET: async (request: Request) => {
      if (!phase1Live()) return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
      const actor = await dependencies.session();
      if (!authorized(actor)) return Response.json({ error: "Forbidden." }, { status: 403, headers: noStoreHeaders });
      const tenantId = new URL(request.url).searchParams.get("tenantId")?.trim();
      if (!tenantId) return Response.json({ error: "Tenant is required." }, { status: 400, headers: noStoreHeaders });
      return Response.json({ intents: await dependencies.list(tenantId, actor!.userId) }, { headers: noStoreHeaders });
    },
    POST: async (request: Request) => {
      if (!phase1Live()) return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
      const actor = await dependencies.session();
      if (!authorized(actor)) return Response.json({ error: "Forbidden." }, { status: 403, headers: noStoreHeaders });
      try {
        const body = await request.json() as Record<string, unknown>;
        if (typeof body.tenantId !== "string" || !body.tenantId.trim() ||
          typeof body.intentId !== "string" || !body.intentId.trim() ||
          typeof body.reason !== "string" || !body.reason.trim()) throw new Error("INVALID_BODY");
        const input = {
          tenantId: body.tenantId.trim(), intentId: body.intentId.trim(),
          actorId: actor!.userId, reason: body.reason.trim(),
        };
        await dependencies.adopt(input);
        const outcome = await dependencies.resume(input);
        return Response.json({ intentId: input.intentId, outcome }, { headers: noStoreHeaders });
      } catch {
        return Response.json({ error: "Deletion recovery was not completed." }, {
          status: 409, headers: noStoreHeaders,
        });
      }
    },
  };
}

const handlers = createDeletionRecoveryHandler({
  session: loadPlatformActor,
  list: async (tenantId, actorId) => {
    const client = createSupabaseServiceClient();
    const { data, error } = await client.rpc("list_contact_deletion_recovery_intents", {
      p_expected_tenant: tenantId, p_actor_id: actorId,
    });
    if (error) throw new Error("CONTACT_DELETE_RECOVERY_LIST_FAILED");
    return (Array.isArray(data) ? data : []).map((row) => ({
      intentId: String(row.intent_id), contactId: String(row.contact_id), status: String(row.status),
      operatorRequired: Boolean(row.operator_required),
      lastError: typeof row.last_error === "string" ? row.last_error : null,
      attemptCount: Number(row.attempt_count), updatedAt: String(row.updated_at),
    }));
  },
  adopt: async (input) => {
    const client = createSupabaseServiceClient();
    const { error } = await client.rpc("adopt_contact_deletion_recovery", {
      p_expected_tenant: input.tenantId, p_actor_id: input.actorId,
      p_intent_id: input.intentId, p_reason: input.reason,
    });
    if (error) throw new Error("CONTACT_DELETE_RECOVERY_ADOPT_FAILED");
  },
  resume: recoverAdoptedContactDeletion,
});

export const GET = handlers.GET;
export const POST = handlers.POST;
