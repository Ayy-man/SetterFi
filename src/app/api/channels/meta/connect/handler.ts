import { createHash } from "node:crypto";

import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { phase4Live } from "@/lib/env-contract";
import {
  selectMetaOAuthService,
  MetaOAuthError,
  type MetaOAuthRepositories,
  type MetaOAuthService,
  type MetaOAuthSessionRecord,
  type MetaOAuthStateRecord,
} from "@/lib/integrations/meta-oauth";
import {
  decryptCredential,
  encryptCredential,
  type CredentialEnvelopeV1,
} from "@/lib/integrations/credential-envelope";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const noStoreHeaders = { "Cache-Control": "no-store" };

type OAuthChannel = "instagram" | "messenger";
type StoredSession = {
  connectionId: string;
  session: MetaOAuthSessionRecord;
};

export type MetaConnectDependencies = {
  session(): Promise<RouteActor | null>;
  begin(input: {
    tenantId: string;
    actorId: string;
    channel: OAuthChannel;
    returnPath: string;
  }): Promise<{ authorizationUrl: string; expiresAt: string; state: "connecting" }>;
};

export type LiveMetaOAuth = {
  service: MetaOAuthService;
  channelForState(oauthState: string, tenantId: string, actorId: string): Promise<OAuthChannel | null>;
  loadSession(sessionId: string): Promise<MetaOAuthSessionRecord | null>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stateHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function parseStoredSession(value: string): StoredSession | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || typeof parsed.connectionId !== "string" || !isRecord(parsed.session)) {
      return null;
    }
    return parsed as unknown as StoredSession;
  } catch {
    return null;
  }
}

function createMetaOAuthRepositories(): MetaOAuthRepositories & {
  channelForState(
    oauthState: string,
    tenantId: string,
    actorId: string,
  ): Promise<OAuthChannel | null>;
} {
  const client = createSupabaseServiceClient();
  let consumedStateId: string | null = null;
  let consumedStateHash: string | null = null;

  return {
    saveState: async (record: MetaOAuthStateRecord) => {
      if (record.connectionId) {
        const { data: existing, error: existingError } = await client
          .from("channel_connections")
          .select("id")
          .eq("id", record.connectionId)
          .eq("tenant_id", record.tenantId)
          .eq("channel", record.channel)
          .eq("provider", "meta_direct")
          .maybeSingle();
        if (existingError || !existing) throw new Error("META_REAUTH_CONNECTION_NOT_FOUND");
        const { error: stateError } = await client.from("channel_oauth_states").insert({
          tenant_id: record.tenantId,
          actor_id: record.actorId,
          channel: record.channel,
          state_hash: record.stateHash,
          pkce_verifier_envelope: record.pkceVerifierEnvelope,
          return_path: record.returnPath,
          expires_at: record.expiresAt,
          reauthorization_connection_id: record.connectionId,
        });
        if (stateError) throw new Error("META_REAUTH_STATE_WRITE_FAILED");
        return;
      }
      const { data: connection, error: connectionError } = await client
        .from("channel_connections")
        .insert({
          tenant_id: record.tenantId,
          channel: record.channel,
          provider: "meta_direct",
          state: "connecting",
          external_ref: { oauth_state_hash: record.stateHash },
        })
        .select("id")
        .single();
      if (connectionError || !connection) throw new Error("META_CONNECTION_START_FAILED");

      const { error: stateError } = await client.from("channel_oauth_states").insert({
        tenant_id: record.tenantId,
        actor_id: record.actorId,
        channel: record.channel,
        state_hash: record.stateHash,
        pkce_verifier_envelope: record.pkceVerifierEnvelope,
        return_path: record.returnPath,
        expires_at: record.expiresAt,
      });
      if (stateError) throw new Error("META_OAUTH_STATE_WRITE_FAILED");

      const { error: auditError } = await client.from("audit_log").insert({
        actor_id: record.actorId,
        tenant_id: record.tenantId,
        action: "channel.connect.started",
        target_type: "channel_connection",
        target_id: connection.id,
        payload: {
          before: null,
          after: { channel: record.channel, state: "connecting" },
        },
      });
      if (auditError) throw new Error("META_CONNECTION_AUDIT_FAILED");
    },

    consumeState: async (hash, consumedAt) => {
      const { data, error } = await client
        .from("channel_oauth_states")
        .update({ consumed_at: consumedAt })
        .eq("state_hash", hash)
        .is("consumed_at", null)
        .select(`
          id, tenant_id, actor_id, channel, state_hash, pkce_verifier_envelope,
          return_path, expires_at, reauthorization_connection_id
        `)
        .maybeSingle();
      if (error) throw new Error("META_OAUTH_STATE_CONSUME_FAILED");
      if (!data) return null;
      consumedStateId = data.id;
      consumedStateHash = data.state_hash;
      return {
        tenantId: data.tenant_id,
        actorId: data.actor_id,
        channel: data.channel as OAuthChannel,
        stateHash: data.state_hash,
        pkceVerifierEnvelope: data.pkce_verifier_envelope as unknown as CredentialEnvelopeV1,
        returnPath: data.return_path,
        expiresAt: data.expires_at,
        ...(data.reauthorization_connection_id ? { connectionId: data.reauthorization_connection_id } : {}),
      };
    },

    saveSession: async (record) => {
      if (!consumedStateId || !consumedStateHash) throw new Error("META_OAUTH_STATE_CONTEXT_MISSING");
      const connectionQuery = client.from("channel_connections").select("id")
        .eq("tenant_id", record.tenantId)
        .eq("channel", record.channel)
        .eq("provider", "meta_direct");
      const { data: connection, error: connectionError } = record.connectionId
        ? await connectionQuery.eq("id", record.connectionId).single()
        : await connectionQuery.contains("external_ref", { oauth_state_hash: consumedStateHash }).single();
      if (connectionError || !connection) throw new Error("META_OAUTH_CONNECTION_MISSING");

      const stored = encryptCredential(JSON.stringify({
        connectionId: connection.id,
        session: record,
      } satisfies StoredSession));
      const { error: stateError } = await client
        .from("channel_oauth_states")
        .update({ pkce_verifier_envelope: stored })
        .eq("id", consumedStateId);
      if (stateError) throw new Error("META_OAUTH_SESSION_WRITE_FAILED");
      const { error: connectionUpdateError } = await client
        .from("channel_connections")
        .update({ oauth_completed_at: new Date().toISOString(), token_expires_at: record.tokenExpiresAt })
        .eq("id", connection.id)
        .eq("tenant_id", record.tenantId);
      if (connectionUpdateError) throw new Error("META_OAUTH_CONNECTION_UPDATE_FAILED");
      return { sessionId: consumedStateId };
    },

    loadSession: async (sessionId) => {
      const { data, error } = await client
        .from("channel_oauth_states")
        .select("pkce_verifier_envelope")
        .eq("id", sessionId)
        .not("consumed_at", "is", null)
        .maybeSingle();
      if (error) throw new Error("META_OAUTH_SESSION_READ_FAILED");
      if (!data?.pkce_verifier_envelope) return null;
      const stored = parseStoredSession(decryptCredential(data.pkce_verifier_envelope));
      return stored?.session ?? null;
    },

    markSubscribed: async ({ sessionId, assetId, subscribedAt }) => {
      const { data, error } = await client
        .from("channel_oauth_states")
        .select("pkce_verifier_envelope")
        .eq("id", sessionId)
        .not("consumed_at", "is", null)
        .single();
      if (error || !data?.pkce_verifier_envelope) throw new Error("META_OAUTH_SESSION_READ_FAILED");
      const stored = parseStoredSession(decryptCredential(data.pkce_verifier_envelope));
      const asset = stored?.session.assets.find((candidate) => candidate.assetId === assetId);
      if (!stored || !asset) throw new Error("META_OAUTH_ASSET_NOT_DISCOVERED");

      const { error: secretError } = await client.from("channel_connection_secrets").upsert({
        channel_connection_id: stored.connectionId,
        credential_envelope: asset.credentialEnvelope,
        updated_at: subscribedAt,
      }, { onConflict: "channel_connection_id" });
      if (secretError) throw new Error("META_CONNECTION_SECRET_WRITE_FAILED");
      const { error: connectionError } = await client
        .from("channel_connections")
        .update({
          state: "ready",
          external_account_id: asset.assetId,
          external_account_label: asset.label,
          external_ref: {
            account_id: asset.assetId,
            subscription_target_id: asset.subscriptionTargetId,
          },
          asset_verified_at: subscribedAt,
          webhook_subscribed_at: subscribedAt,
          updated_at: subscribedAt,
        })
        .eq("id", stored.connectionId)
        .eq("tenant_id", stored.session.tenantId);
      if (connectionError) throw new Error("META_CONNECTION_READY_WRITE_FAILED");
      const { error: auditError } = await client.from("audit_log").insert({
        actor_id: null,
        tenant_id: stored.session.tenantId,
        action: "channel.connect.completed",
        target_type: "channel_connection",
        target_id: stored.connectionId,
        payload: {
          before: { state: "connecting" },
          after: { channel: stored.session.channel, state: "ready" },
        },
      });
      if (auditError) throw new Error("META_CONNECTION_AUDIT_FAILED");
      return { connectionId: stored.connectionId };
    },

    channelForState: async (oauthState, tenantId, actorId) => {
      const { data, error } = await client
        .from("channel_oauth_states")
        .select("channel")
        .eq("state_hash", stateHash(oauthState))
        .eq("tenant_id", tenantId)
        .eq("actor_id", actorId)
        .is("consumed_at", null)
        .maybeSingle();
      if (error) throw new Error("META_OAUTH_STATE_READ_FAILED");
      return data?.channel === "instagram" || data?.channel === "messenger" ? data.channel : null;
    },
  };
}

export function createLiveMetaOAuth(): LiveMetaOAuth {
  const repositories = createMetaOAuthRepositories();
  return {
    service: selectMetaOAuthService({ dependencies: { repositories } }),
    channelForState: repositories.channelForState,
    loadSession: repositories.loadSession,
  };
}

export async function beginMetaConnection(
  input: Parameters<MetaConnectDependencies["begin"]>[0],
  begin: MetaConnectDependencies["begin"],
) {
  return begin(input);
}

function exactConnectBody(value: unknown): value is { channel: OAuthChannel; returnPath: string } {
  if (!isRecord(value) || Object.keys(value).some((key) => !["channel", "returnPath"].includes(key))) {
    return false;
  }
  return (value.channel === "instagram" || value.channel === "messenger")
    && typeof value.returnPath === "string";
}

export function createMetaConnectHandler(dependencies: MetaConnectDependencies) {
  return async function POST(request: Request) {
    if (!phase4Live()) return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    const actor = await dependencies.session();
    if (!actor) return Response.json({ error: "Authentication required." }, { status: 401, headers: noStoreHeaders });
    if (hasImpersonationMarker(actor)) {
      return Response.json({ error: "Impersonated sessions are read-only." }, { status: 403, headers: noStoreHeaders });
    }
    try {
      const body: unknown = await request.json();
      if (!exactConnectBody(body)) {
        return Response.json({ error: "Invalid connection request." }, { status: 400, headers: noStoreHeaders });
      }
      const result = await beginMetaConnection({
        tenantId: actor.tenantId,
        actorId: actor.userId,
        channel: body.channel,
        returnPath: body.returnPath,
      }, dependencies.begin);
      return Response.json({
        authorizationUrl: result.authorizationUrl,
        expiresAt: result.expiresAt,
        state: result.state,
      }, { status: 201, headers: noStoreHeaders });
    } catch (error) {
      if (error instanceof MetaOAuthError && error.code === "META_OAUTH_RETURN_PATH_INVALID") {
        return Response.json({ error: "Invalid connection request." }, {
          status: 400,
          headers: noStoreHeaders,
        });
      }
      return Response.json({ error: "Meta connection could not be started." }, {
        status: 503,
        headers: noStoreHeaders,
      });
    }
  };
}

export const POST = createMetaConnectHandler({
  session: loadRouteActor,
  begin: async (input) => createLiveMetaOAuth().service.begin(input),
});
