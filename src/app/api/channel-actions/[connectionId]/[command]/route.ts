import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { phase4Live } from "@/lib/env-contract";
import { decryptCredential } from "@/lib/integrations/credential-envelope";
import { ghlOAuthConfiguration, createGhlOAuthStateStore } from "@/lib/integrations/ghl-oauth-store";
import { issueGhlOAuthState } from "@/lib/integrations/ghl-oauth";
import { createLiveMetaOAuth } from "@/app/api/channels/meta/connect/handler";
import {
  createProviderConnectionCommandService,
  ProviderConnectionCommandError,
  type ProviderCommandResult,
  type ProviderConnection,
  type ProviderConnectionCommand,
} from "@/lib/integrations/provider-connection-commands";
import { resolveGhlInstallAccessToken } from "@/lib/integrations/ghl";
import { processLiveWebhookReceipt, type WebhookReceiptRead } from "@/lib/webhooks/process-inbound";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };
const GHL_BASE_URL = "https://services.leadconnectorhq.com";
const META_BASE_URL = "https://graph.facebook.com/v25.0";

type ConnectionRow = {
  id: string;
  tenant_id: string;
  provider: "ghl" | "meta_direct";
  channel: ProviderConnection["channel"];
  external_account_id: string | null;
  external_ref: Record<string, unknown> | null;
  is_demo: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function command(value: string): ProviderConnectionCommand | null {
  return ["test", "reconnect", "disconnect", "template_sync", "replay"].includes(value)
    ? value as ProviderConnectionCommand
    : null;
}

async function loadConnection(tenantId: string, connectionId: string) {
  const client = createSupabaseServiceClient();
  const { data, error } = await client
    .from("channel_connections")
    .select("id, tenant_id, provider, channel, external_account_id, external_ref, tenants!inner(is_demo)")
    .eq("id", connectionId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error || !data || (data.provider !== "ghl" && data.provider !== "meta_direct")) return null;
  const tenant = (data as unknown as { tenants: { is_demo: boolean } | { is_demo: boolean }[] }).tenants;
  const isDemo = Array.isArray(tenant) ? tenant[0]?.is_demo : tenant?.is_demo;
  return {
    id: data.id,
    tenantId: data.tenant_id,
    provider: data.provider,
    channel: data.channel as ProviderConnection["channel"],
    isDemo: isDemo === true,
  } satisfies ProviderConnection;
}

async function connectionRow(tenantId: string, connectionId: string) {
  const client = createSupabaseServiceClient();
  const { data, error } = await client
    .from("channel_connections")
    .select("id, tenant_id, provider, channel, external_account_id, external_ref, tenants!inner(is_demo)")
    .eq("id", connectionId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error || !data || (data.provider !== "ghl" && data.provider !== "meta_direct")) {
    throw new ProviderConnectionCommandError("CHANNEL_CONNECTION_NOT_FOUND");
  }
  const tenant = (data as unknown as { tenants: { is_demo: boolean } | { is_demo: boolean }[] }).tenants;
  return { ...data, is_demo: (Array.isArray(tenant) ? tenant[0]?.is_demo : tenant?.is_demo) === true } as ConnectionRow;
}

async function connectionToken(connection: ConnectionRow) {
  if (connection.provider === "ghl") {
    if (!connection.external_account_id) throw new ProviderConnectionCommandError("PROVIDER_ACCOUNT_UNAVAILABLE");
    return resolveGhlInstallAccessToken(connection.external_account_id);
  }
  const client = createSupabaseServiceClient();
  const { data, error } = await client.from("channel_connection_secrets")
    .select("credential_envelope")
    .eq("channel_connection_id", connection.id).maybeSingle();
  if (error || !data?.credential_envelope) throw new ProviderConnectionCommandError("PROVIDER_CREDENTIAL_UNAVAILABLE");
  return decryptCredential(data.credential_envelope);
}

async function providerResponse(url: string, init: RequestInit, code: string) {
  const response = await fetch(url, init);
  if (!response.ok) throw new ProviderConnectionCommandError(code);
  return response.json().catch(() => ({}));
}

function approvalState(value: unknown): "approved" | "submitted" | "rejected" | "paused" | "disabled" | "unknown" {
  const state = typeof value === "string" ? value.toLowerCase() : "";
  if (state === "approved") return "approved";
  if (["pending", "submitted", "in_review"].includes(state)) return "submitted";
  if (state === "rejected") return "rejected";
  if (state === "paused") return "paused";
  if (["disabled", "deleted"].includes(state)) return "disabled";
  return "unknown";
}

async function execute(input: { connection: ProviderConnection; command: Exclude<ProviderConnectionCommand, "reconnect">; sourceReceiptId?: string }): Promise<ProviderCommandResult> {
  const row = await connectionRow(input.connection.tenantId, input.connection.id);
  if (input.command === "replay") {
    const client = createSupabaseServiceClient();
    const { data, error } = await client.from("webhook_events")
      .select("id, provider, provider_event_id, tenant_id, event_type, payload, status")
      .eq("id", input.sourceReceiptId!).eq("tenant_id", row.tenant_id).maybeSingle();
    if (error || !data || data.status !== "failed") throw new ProviderConnectionCommandError("FAILED_WEBHOOK_RECEIPT_NOT_FOUND");
    const provider = row.provider === "ghl" ? "ghl" : "meta";
    if (data.provider !== provider) throw new ProviderConnectionCommandError("WEBHOOK_RECEIPT_PROVIDER_MISMATCH");
    await processLiveWebhookReceipt({
      id: data.id,
      provider: data.provider,
      providerEventId: data.provider_event_id,
      tenantId: data.tenant_id,
      eventType: data.event_type,
      payload: data.payload,
      status: data.status,
      inserted: false,
    } as WebhookReceiptRead);
    return { outcome: "replayed", code: "WEBHOOK_REPLAY_DISPATCHED", evidence: { sourceReceiptId: data.id } };
  }

  const token = await connectionToken(row);
  const headers: HeadersInit = row.provider === "ghl"
    ? { Authorization: `Bearer ${token}`, Version: "2021-07-28" }
    : { Authorization: `Bearer ${token}` };
  if (!row.external_account_id) throw new ProviderConnectionCommandError("PROVIDER_ACCOUNT_UNAVAILABLE");

  if (input.command === "test") {
    const url = row.provider === "ghl"
      ? `${GHL_BASE_URL}/locations/${encodeURIComponent(row.external_account_id)}`
      : `${META_BASE_URL}/${encodeURIComponent(row.external_account_id)}?fields=id`;
    await providerResponse(url, { method: "GET", headers }, "PROVIDER_PROBE_FAILED");
    return { outcome: "verified", code: "PROVIDER_READ_VERIFIED", evidence: { safeRead: true } };
  }

  if (input.command === "template_sync") {
    if (!["sms", "instagram", "messenger", "whatsapp"].includes(row.channel)) {
      throw new ProviderConnectionCommandError("TEMPLATE_SYNC_CHANNEL_UNSUPPORTED");
    }
    const url = row.provider === "ghl"
      ? `${GHL_BASE_URL}/locations/${encodeURIComponent(row.external_account_id)}/templates?originId=${encodeURIComponent(row.external_account_id)}&type=whatsapp`
      : `${META_BASE_URL}/${encodeURIComponent(row.external_account_id)}/message_templates?fields=id,name,status`;
    const payload = await providerResponse(url, { method: "GET", headers }, "TEMPLATE_SYNC_FAILED");
    const items = isRecord(payload) && Array.isArray(payload.templates) ? payload.templates
      : isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
    const templates = items.filter(isRecord).slice(0, 250).map((item) => ({
      id: nonBlank(item.id) ? item.id : null,
      name: nonBlank(item.name) ? item.name.trim() : null,
      approvalState: approvalState(item.status),
    })).filter((item): item is { id: string; name: string; approvalState: ReturnType<typeof approvalState> } => item.id !== null && item.name !== null);
    return { outcome: "verified", code: "TEMPLATE_SYNC_VERIFIED", evidence: { templateCount: templates.length, templates } };
  }

  // Meta can revoke the webhook subscription with the page token stored for this connection.  A
  // GHL location credential has no safe per-location revoke endpoint in the current env contract,
  // so it refuses rather than uninstalling the app for another tenant or marking locally first.
  if (row.provider === "ghl") throw new ProviderConnectionCommandError("PROVIDER_REVOKE_UNAVAILABLE");
  const target = isRecord(row.external_ref) && nonBlank(row.external_ref.subscription_target_id)
    ? row.external_ref.subscription_target_id : null;
  if (!target) throw new ProviderConnectionCommandError("PROVIDER_SUBSCRIPTION_TARGET_UNAVAILABLE");
  await providerResponse(`${META_BASE_URL}/${encodeURIComponent(target)}/subscribed_apps`, {
    method: "DELETE", headers,
  }, "PROVIDER_REVOKE_FAILED");
  return { outcome: "verified", code: "PROVIDER_REVOKED", evidence: { providerRevoked: true }, providerRevoked: true };
}

async function beginReauthorization(input: { connection: ProviderConnection; actorId: string; idempotencyKey: string }): Promise<ProviderCommandResult> {
  if (input.connection.provider === "ghl") {
    const configuration = ghlOAuthConfiguration("agent");
    const result = await issueGhlOAuthState({
      app: "agent", actorId: input.actorId, tenantId: input.connection.tenantId, returnPath: "/coach/integrations",
      appBaseUrl: configuration.appBaseUrl, installUrl: configuration.installUrl,
    }, { states: createGhlOAuthStateStore() });
    return { outcome: "started", code: "REAUTHORIZATION_STARTED", evidence: { authorizationUrl: result.authorizationUrl, expiresAt: result.expiresAt } };
  }
  if (input.connection.channel !== "instagram" && input.connection.channel !== "messenger") {
    throw new ProviderConnectionCommandError("PROVIDER_REAUTHORIZATION_UNAVAILABLE");
  }
  const oauth = createLiveMetaOAuth();
  const result = await oauth.service.begin({
    tenantId: input.connection.tenantId,
    actorId: input.actorId,
    channel: input.connection.channel,
    connectionId: input.connection.id,
    returnPath: "/coach/integrations",
  });
  return { outcome: "started", code: "REAUTHORIZATION_STARTED", evidence: { authorizationUrl: result.authorizationUrl, expiresAt: result.expiresAt } };
}

async function record(input: {
  tenantId: string; connectionId: string; command: ProviderConnectionCommand; actorId: string; idempotencyKey: string; result: ProviderCommandResult;
}) {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.rpc("record_provider_connection_command", {
    p_expected_tenant: input.tenantId, p_connection_id: input.connectionId, p_command: input.command,
    p_actor_id: input.actorId, p_idempotency_key: input.idempotencyKey, p_outcome: input.result.outcome,
    p_outcome_code: input.result.code, p_evidence: input.result.evidence,
    p_provider_revoked: input.result.providerRevoked === true,
  });
  const row = Array.isArray(data) ? data[0] : null;
  if (error || !row) throw new ProviderConnectionCommandError("PROVIDER_COMMAND_RECEIPT_WRITE_FAILED");
  return { receiptId: String(row.receipt_id), auditId: Number(row.audit_id), replayed: row.replayed === true, outcome: row.outcome as ProviderCommandResult["outcome"] };
}

const service = createProviderConnectionCommandService({
  loadConnection,
  execute,
  beginReauthorization,
  // The durable webhook processor takes the actual one-at-a-time claim.  This preflight is kept
  // intentionally side-effect-free so a stale browser retry cannot consume a failed receipt.
  claimReplay: async () => ({ replayed: true, alreadyCompleted: false }),
  record,
});

export async function POST(request: Request, context: { params: Promise<{ connectionId: string; command: string }> }) {
  if (!phase4Live()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
  const actor = await loadRouteActor();
  if (!actor) return Response.json({ error: "Authentication required." }, { status: 401, headers: NO_STORE });
  if (hasImpersonationMarker(actor)) return Response.json({ error: "Connection commands are unavailable while viewing as a coach." }, { status: 403, headers: NO_STORE });
  const params = await context.params;
  const action = command(params.command);
  const body = await request.json().catch(() => null);
  if (!action || !isRecord(body) || !nonBlank(body.idempotencyKey) ||
    (action === "replay" && !nonBlank(body.sourceReceiptId))) {
    return Response.json({ error: "Connection command was refused.", code: "PROVIDER_COMMAND_BODY_INVALID" }, { status: 400, headers: NO_STORE });
  }
  const sourceReceiptId = action === "replay" && nonBlank(body.sourceReceiptId)
    ? body.sourceReceiptId.trim()
    : undefined;
  const result = await service.run({
    tenantId: actor.tenantId, connectionId: params.connectionId, actorId: actor.userId,
    command: action, idempotencyKey: body.idempotencyKey.trim(),
    ...(sourceReceiptId ? { sourceReceiptId } : {}),
  }).catch((error) => error instanceof ProviderConnectionCommandError
    ? { error: error.code } : { error: "PROVIDER_COMMAND_UNAVAILABLE" });
  if ("error" in result) return Response.json({ error: "Connection command could not be completed.", code: result.error }, { status: 409, headers: NO_STORE });
  return Response.json({ receipt: result }, { headers: NO_STORE });
}
