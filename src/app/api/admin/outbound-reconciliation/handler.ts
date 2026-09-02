import { loadPlatformActor, type PlatformActor } from "@/lib/auth/actors";
import { hasImpersonationMarker, type UserRole } from "@/lib/auth/claims";
import { phase3Live } from "@/lib/env-contract";
import {
  IDENTITY_PROVIDERS,
  MESSAGING_CHANNELS,
  type IdentityProvider,
  type MessagingChannel,
} from "@/lib/integrations/types";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const HEADERS = { "Cache-Control": "no-store" };
const ROLES: readonly UserRole[] = ["owner", "admin", "success"];

type AdminActor = PlatformActor & {
  impersonatingTenant?: string | null;
  impersonationSessionId?: string | null;
};

type Resolution = {
  tenantId: string;
  idempotencyKey: string;
  resolution: "accepted" | "not_accepted";
  providerMessageId: string | null;
  acceptedAt: string | null;
  evidence: ProviderEvidence;
  reason: string;
};

type ProviderEvidence = {
  provider: IdentityProvider;
  channel: MessagingChannel;
  kind: "provider_receipt" | "provider_readback";
  evidenceId: string;
  result: "accepted" | "not_found";
  providerMessageId: string | null;
  observedAt: string;
};

type Dependencies = {
  enabled(): boolean;
  session(): Promise<AdminActor | null>;
  reconcile(input: Resolution & { actorId: string }): Promise<string>;
};

function text(value: unknown, max = 500) {
  return typeof value === "string" && value.trim() && value.trim().length <= max
    ? value.trim()
    : null;
}

function parse(value: unknown): Resolution | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => ![
    "tenantId", "idempotencyKey", "resolution", "providerMessageId", "acceptedAt", "evidence", "reason",
  ].includes(key))) return null;
  const tenantId = text(row.tenantId, 100);
  const idempotencyKey = text(row.idempotencyKey, 200);
  const reason = text(row.reason, 500);
  const evidenceRow = row.evidence && typeof row.evidence === "object" && !Array.isArray(row.evidence)
    ? row.evidence as Record<string, unknown> : null;
  const resolution = row.resolution === "accepted" || row.resolution === "not_accepted"
    ? row.resolution
    : null;
  if (!tenantId || !idempotencyKey || !reason || !resolution || !evidenceRow
    || Object.keys(evidenceRow).length !== 7
    || Object.keys(evidenceRow).some((key) => ![
      "provider", "channel", "kind", "evidenceId", "result", "providerMessageId", "observedAt",
    ].includes(key))) {
    return null;
  }
  const providerMessageId = text(row.providerMessageId, 500);
  const acceptedAt = text(row.acceptedAt, 100);
  const evidenceId = text(evidenceRow.evidenceId, 500);
  const observedAt = text(evidenceRow.observedAt, 100);
  const evidenceProviderMessageId = text(evidenceRow.providerMessageId, 500);
  const provider = IDENTITY_PROVIDERS.includes(evidenceRow.provider as IdentityProvider)
    ? evidenceRow.provider as IdentityProvider : null;
  const channel = MESSAGING_CHANNELS.includes(evidenceRow.channel as MessagingChannel)
    ? evidenceRow.channel as MessagingChannel : null;
  const kind = evidenceRow.kind === "provider_receipt" || evidenceRow.kind === "provider_readback"
    ? evidenceRow.kind : null;
  const evidenceResult = evidenceRow.result === "accepted" || evidenceRow.result === "not_found"
    ? evidenceRow.result : null;
  if (!evidenceId || !observedAt || !Number.isFinite(Date.parse(observedAt))
    || !provider || !channel || !kind || !evidenceResult) return null;
  if (resolution === "accepted" && (
    !providerMessageId || !acceptedAt || !Number.isFinite(Date.parse(acceptedAt))
    || evidenceResult !== "accepted" || evidenceProviderMessageId !== providerMessageId
  )) return null;
  if (resolution === "not_accepted" && (
    row.providerMessageId != null || row.acceptedAt != null
    || kind !== "provider_readback" || evidenceResult !== "not_found"
    || evidenceRow.providerMessageId !== null
  )) return null;
  const evidence: ProviderEvidence = {
    provider, channel, kind, evidenceId, result: evidenceResult,
    providerMessageId: evidenceProviderMessageId, observedAt,
  };
  return { tenantId, idempotencyKey, resolution, providerMessageId, acceptedAt, evidence, reason };
}

export function createOutboundReconciliationAdminHandler(dependencies: Dependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: HEADERS });
    }
    const actor = await dependencies.session();
    if (!actor) return Response.json({ error: "Authentication required." }, { status: 401, headers: HEADERS });
    if (hasImpersonationMarker(actor) || !ROLES.includes(actor.role)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: HEADERS });
    }
    let resolution: Resolution | null = null;
    try {
      resolution = parse(await request.json());
    } catch {
      // Invalid JSON follows the same closed validation path as an invalid evidence envelope.
    }
    if (!resolution) {
      return Response.json({ error: "Reconciliation evidence is invalid." }, { status: 400, headers: HEADERS });
    }
    try {
      const auditId = await dependencies.reconcile({ ...resolution, actorId: actor.userId });
      return Response.json({
        resolution: resolution.resolution,
        receipt: { auditId, actionKey: "conversation.outbound_send.reconciled" },
      }, { headers: HEADERS });
    } catch {
      return Response.json({ error: "Outbound reconciliation was refused." }, { status: 409, headers: HEADERS });
    }
  };
}

async function reconcile(input: Resolution & { actorId: string }) {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.rpc("reconcile_indeterminate_outbound_send", {
    p_expected_tenant: input.tenantId,
    p_idempotency_key: input.idempotencyKey,
    p_resolution: input.resolution,
    p_provider_message_id: input.providerMessageId,
    p_accepted_at: input.acceptedAt,
    p_evidence: input.evidence,
    p_actor_id: input.actorId,
    p_reason: input.reason,
  });
  if (error || (typeof data !== "string" && typeof data !== "number")) {
    throw new Error("OUTBOUND_RECONCILIATION_REFUSED");
  }
  return String(data);
}

export const POST = createOutboundReconciliationAdminHandler({
  enabled: phase3Live,
  session: loadPlatformActor,
  reconcile,
});
