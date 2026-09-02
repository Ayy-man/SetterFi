/**
 * Meta OAuth owns single-use state, server-side token exchange, and server-discovered assets.
 *
 * The service returns only safe asset metadata. Access tokens and PKCE verifiers cross the
 * persistence boundary exclusively as Wave-1 credential envelopes.
 */

import { createHash, randomBytes } from "node:crypto";

import {
  driverSelection,
  requireEnvironment,
  type EnvironmentSource,
} from "@/lib/env-contract";

import { decryptCredential, encryptCredential, type CredentialEnvelopeV1 } from "./credential-envelope";
import { META_GRAPH_VERSION } from "./meta";
import { META_OAUTH_CONFIGURATION_NAMES } from "./selector";

type JsonObject = Record<string, unknown>;
type FetchLike = typeof fetch;
type OAuthChannel = "instagram" | "messenger";
type RandomBytes = (size: number) => Buffer;

export const META_OAUTH_SCOPES = [
  "business_management",
  "instagram_basic",
  "instagram_manage_messages",
  "pages_manage_metadata",
  "pages_messaging",
  "pages_read_engagement",
  "pages_show_list",
] as const;

export type MetaOAuthConfiguration = {
  appBaseUrl: string;
  appId: string;
  appSecret: string;
  loginConfigId: string;
};

export type MetaOAuthStateRecord = {
  tenantId: string;
  actorId: string;
  channel: OAuthChannel;
  stateHash: string;
  pkceVerifierEnvelope: CredentialEnvelopeV1;
  returnPath: string;
  expiresAt: string;
  /** Existing connection for reauthorization; its secret is never replaced during begin/complete. */
  connectionId?: string;
};

export type MetaOAuthAsset = {
  assetId: string;
  channel: OAuthChannel;
  label: string;
  eligible: boolean;
};

export type StoredMetaOAuthAsset = MetaOAuthAsset & {
  subscriptionTargetId: string;
  credentialEnvelope: CredentialEnvelopeV1;
};

export type MetaOAuthSessionRecord = {
  tenantId: string;
  actorId: string;
  channel: OAuthChannel;
  returnPath: string;
  tokenExpiresAt: string | null;
  scopes: readonly string[];
  assets: readonly StoredMetaOAuthAsset[];
  connectionId?: string;
};

export type MetaOAuthRepositories = {
  saveState(record: MetaOAuthStateRecord): Promise<void>;
  consumeState(stateHash: string, consumedAt: string): Promise<MetaOAuthStateRecord | null>;
  saveSession(record: MetaOAuthSessionRecord): Promise<{ sessionId: string }>;
  loadSession(sessionId: string): Promise<MetaOAuthSessionRecord | null>;
  markSubscribed(input: {
    sessionId: string;
    assetId: string;
    subscribedAt: string;
  }): Promise<{ connectionId: string }>;
};

export type MetaOAuthService = {
  begin(input: {
    tenantId: string;
    actorId: string;
    channel: OAuthChannel;
    returnPath: string;
    connectionId?: string;
  }): Promise<{ authorizationUrl: string; expiresAt: string; state: "connecting"; oauthState: string }>;
  complete(input: {
    tenantId: string;
    actorId: string;
    channel: OAuthChannel;
    code: string;
    oauthState: string;
  }): Promise<{
    sessionId: string;
    returnPath: string;
    assets: readonly MetaOAuthAsset[];
  }>;
  subscribe(input: {
    tenantId: string;
    actorId: string;
    sessionId: string;
    assetId: string;
  }): Promise<{ connectionId: string; state: "ready" }>;
};

export type MetaOAuthDependencies = {
  repositories: MetaOAuthRepositories;
  fetch?: FetchLike;
  now?: () => Date;
  randomBytes?: RandomBytes;
  encryptCredential?: typeof encryptCredential;
  decryptCredential?: typeof decryptCredential;
  environment?: EnvironmentSource;
};

export class MetaOAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
    readonly bodyShape: string | null = null,
  ) {
    super(status === null ? code : `${code} (HTTP ${status})`);
    this.name = "MetaOAuthError";
  }
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function objects(value: unknown) {
  return Array.isArray(value)
    ? value.map(object).filter((row): row is JsonObject => row !== null)
    : [];
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function shape(value: unknown) {
  const row = object(value);
  return row ? Object.keys(row).sort().join(",") : Array.isArray(value) ? "array" : typeof value;
}

function required(value: string, code: string) {
  const normalized = value.trim();
  if (!normalized) throw new MetaOAuthError(code);
  return normalized;
}

function appBaseUrl(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new MetaOAuthError("META_OAUTH_APP_BASE_URL_INVALID");
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost") {
    throw new MetaOAuthError("META_OAUTH_APP_BASE_URL_INVALID");
  }
  return parsed.origin;
}

export function validateMetaReturnPath(value: string, configuredBaseUrl: string) {
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new MetaOAuthError("META_OAUTH_RETURN_PATH_INVALID");
  }
  const base = appBaseUrl(configuredBaseUrl);
  const parsed = new URL(value, base);
  if (parsed.origin !== base) throw new MetaOAuthError("META_OAUTH_RETURN_PATH_INVALID");
  return `${parsed.pathname}${parsed.search}`;
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function responseJson(response: Response, code: string) {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new MetaOAuthError(`${code}_MALFORMED_JSON`, response.status, "non-json");
  }
  if (!response.ok) throw new MetaOAuthError(code, response.status, shape(payload));
  return payload;
}

async function requestJson(
  fetcher: FetchLike,
  input: string | URL,
  init: RequestInit,
  code: string,
) {
  let response: Response;
  try {
    response = await fetcher(input, init);
  } catch {
    // Fetch errors may include the requested URL, whose query carries OAuth material.
    throw new MetaOAuthError(`${code}_NETWORK`);
  }
  return responseJson(response, code);
}

function tokenExpiry(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1_000).toISOString();
}

function scopes(value: unknown) {
  return Array.isArray(value)
    ? value.map(text).filter((scope): scope is string => scope !== null).sort()
    : [];
}

function mockConfiguration(): MetaOAuthConfiguration {
  const synthetic = (name: string) => createHash("sha256").update(name).digest("hex");
  return {
    appBaseUrl: "https://setterfi.test",
    appId: "setterfi-meta-mock-app",
    appSecret: synthetic("setterfi-meta-oauth-mock-app-secret"),
    loginConfigId: "setterfi-meta-mock-login-config",
  };
}

function mockFetch(configuration: MetaOAuthConfiguration): FetchLike {
  const synthetic = (name: string) => createHash("sha256").update(name).digest("base64url");
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/oauth/access_token")) {
      return Response.json({ access_token: synthetic("meta-oauth-user-token"), token_type: "bearer" });
    }
    if (url.pathname.endsWith("/debug_token")) {
      return Response.json({
        data: {
          app_id: configuration.appId,
          is_valid: true,
          expires_at: 1_789_516_800,
          scopes: [...META_OAUTH_SCOPES],
        },
      });
    }
    if (url.pathname.endsWith("/me/accounts")) {
      return Response.json({
        data: [{
          id: "mock-page-1",
          name: "Demo Page",
          access_token: synthetic("meta-oauth-page-token"),
          instagram_business_account: { id: "mock-instagram-1", name: "Demo Instagram" },
        }],
      });
    }
    if (url.pathname.endsWith("/subscribed_apps") && init?.method === "POST") {
      return Response.json({ success: true });
    }
    return Response.json({ error: { type: "unsupported_mock_request" } }, { status: 400 });
  };
}

function graphUrl(path: string) {
  return `https://graph.facebook.com/${META_GRAPH_VERSION}/${path}`;
}

export function createMetaOAuthService(
  configuration: MetaOAuthConfiguration,
  {
    repositories,
    fetch: fetcher = fetch,
    now = () => new Date(),
    randomBytes: generateRandomBytes = randomBytes,
    encryptCredential: encrypt = encryptCredential,
    decryptCredential: decrypt = decryptCredential,
    environment = process.env,
  }: MetaOAuthDependencies,
): MetaOAuthService {
  const baseUrl = appBaseUrl(configuration.appBaseUrl);
  const redirectUri = `${baseUrl}/api/channels/meta/callback`;

  return {
    begin: async ({ tenantId, actorId, channel, returnPath, connectionId }) => {
      const expectedTenant = required(tenantId, "EXPECTED_TENANT_REQUIRED");
      const expectedActor = required(actorId, "META_OAUTH_ACTOR_REQUIRED");
      const safeReturnPath = validateMetaReturnPath(returnPath, baseUrl);
      const oauthState = generateRandomBytes(32).toString("base64url");
      const verifier = generateRandomBytes(32).toString("base64url");
      if (!oauthState || !verifier) throw new MetaOAuthError("META_OAUTH_RANDOMNESS_INVALID");
      const expiresAt = new Date(now().getTime() + 10 * 60 * 1_000).toISOString();
      await repositories.saveState({
        tenantId: expectedTenant,
        actorId: expectedActor,
        channel,
        stateHash: sha256Hex(oauthState),
        pkceVerifierEnvelope: encrypt(verifier, environment),
        returnPath: safeReturnPath,
        expiresAt,
        ...(connectionId ? { connectionId } : {}),
      });
      const authorization = new URL(`https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`);
      authorization.searchParams.set("client_id", configuration.appId);
      authorization.searchParams.set("config_id", configuration.loginConfigId);
      authorization.searchParams.set("redirect_uri", redirectUri);
      authorization.searchParams.set("response_type", "code");
      authorization.searchParams.set("state", oauthState);
      authorization.searchParams.set("scope", META_OAUTH_SCOPES.join(","));
      authorization.searchParams.set("code_challenge", pkceChallenge(verifier));
      authorization.searchParams.set("code_challenge_method", "S256");
      return {
        authorizationUrl: authorization.toString(),
        expiresAt,
        state: "connecting",
        oauthState,
      };
    },

    complete: async ({ tenantId, actorId, channel, code, oauthState }) => {
      const expectedTenant = required(tenantId, "EXPECTED_TENANT_REQUIRED");
      const expectedActor = required(actorId, "META_OAUTH_ACTOR_REQUIRED");
      const expectedCode = required(code, "META_OAUTH_CODE_REQUIRED");
      const expectedState = required(oauthState, "META_OAUTH_STATE_REQUIRED");
      const consumedAt = now();
      const state = await repositories.consumeState(
        sha256Hex(expectedState),
        consumedAt.toISOString(),
      );
      if (!state) throw new MetaOAuthError("META_OAUTH_STATE_INVALID_OR_REPLAYED");
      if (
        state.tenantId !== expectedTenant || state.actorId !== expectedActor || state.channel !== channel
      ) {
        throw new MetaOAuthError("META_OAUTH_STATE_BINDING_MISMATCH");
      }
      if (new Date(state.expiresAt).getTime() <= consumedAt.getTime()) {
        throw new MetaOAuthError("META_OAUTH_STATE_EXPIRED");
      }
      const verifier = decrypt(state.pkceVerifierEnvelope, environment);
      const exchange = new URL(graphUrl("oauth/access_token"));
      exchange.searchParams.set("client_id", configuration.appId);
      exchange.searchParams.set("client_secret", configuration.appSecret);
      exchange.searchParams.set("redirect_uri", redirectUri);
      exchange.searchParams.set("code", expectedCode);
      exchange.searchParams.set("code_verifier", verifier);
      const exchangePayload = object(await requestJson(
        fetcher,
        exchange,
        { method: "GET" },
        "META_OAUTH_CODE_EXCHANGE_FAILED",
      ));
      const accessToken = text(exchangePayload?.access_token);
      if (!accessToken) throw new MetaOAuthError("META_OAUTH_TOKEN_ENVELOPE_INVALID");

      const inspection = new URL(graphUrl("debug_token"));
      inspection.searchParams.set("input_token", accessToken);
      inspection.searchParams.set("access_token", `${configuration.appId}|${configuration.appSecret}`);
      const inspectionPayload = object(await requestJson(
        fetcher,
        inspection,
        { method: "GET" },
        "META_OAUTH_TOKEN_INSPECTION_FAILED",
      ));
      const inspectionData = object(inspectionPayload?.data);
      if (inspectionData?.is_valid !== true || text(inspectionData.app_id) !== configuration.appId) {
        throw new MetaOAuthError("META_OAUTH_TOKEN_INVALID");
      }

      const accounts = new URL(graphUrl("me/accounts"));
      accounts.searchParams.set(
        "fields",
        "id,name,access_token,instagram_business_account{id,name}",
      );
      accounts.searchParams.set("access_token", accessToken);
      const accountsPayload = object(await requestJson(
        fetcher,
        accounts,
        { method: "GET" },
        "META_OAUTH_ASSET_DISCOVERY_FAILED",
      ));
      const discovered: StoredMetaOAuthAsset[] = [];
      for (const page of objects(accountsPayload?.data)) {
        const pageId = text(page.id);
        const pageToken = text(page.access_token);
        if (!pageId || !pageToken) continue;
        if (channel === "messenger") {
          discovered.push({
            assetId: pageId,
            channel,
            label: text(page.name) ?? "Facebook Page",
            eligible: true,
            subscriptionTargetId: pageId,
            credentialEnvelope: encrypt(pageToken, environment),
          });
        } else {
          const instagram = object(page.instagram_business_account);
          const instagramId = text(instagram?.id);
          if (!instagramId) continue;
          discovered.push({
            assetId: instagramId,
            channel,
            label: text(instagram?.name) ?? "Instagram account",
            eligible: true,
            subscriptionTargetId: pageId,
            credentialEnvelope: encrypt(pageToken, environment),
          });
        }
      }
      const saved = await repositories.saveSession({
        tenantId: expectedTenant,
        actorId: expectedActor,
        channel,
        returnPath: state.returnPath,
        tokenExpiresAt: tokenExpiry(inspectionData.expires_at),
        scopes: scopes(inspectionData.scopes),
        assets: discovered,
        ...(state.connectionId ? { connectionId: state.connectionId } : {}),
      });
      return {
        sessionId: saved.sessionId,
        returnPath: state.returnPath,
        assets: discovered.map(({ assetId, channel: assetChannel, label, eligible }) => ({
          assetId,
          channel: assetChannel,
          label,
          eligible,
        })),
      };
    },

    subscribe: async ({ tenantId, actorId, sessionId, assetId }) => {
      const expectedTenant = required(tenantId, "EXPECTED_TENANT_REQUIRED");
      const expectedActor = required(actorId, "META_OAUTH_ACTOR_REQUIRED");
      const expectedSession = required(sessionId, "META_OAUTH_SESSION_REQUIRED");
      const expectedAsset = required(assetId, "META_OAUTH_ASSET_REQUIRED");
      const session = await repositories.loadSession(expectedSession);
      if (!session || session.tenantId !== expectedTenant || session.actorId !== expectedActor) {
        throw new MetaOAuthError("META_OAUTH_SESSION_SCOPE_MISMATCH");
      }
      const asset = session.assets.find((candidate) => candidate.assetId === expectedAsset);
      if (!asset || asset.channel !== session.channel || !asset.eligible) {
        throw new MetaOAuthError("META_OAUTH_ASSET_NOT_DISCOVERED");
      }
      const accessToken = decrypt(asset.credentialEnvelope, environment);
      const subscription = new URL(graphUrl(
        `${encodeURIComponent(asset.subscriptionTargetId)}/subscribed_apps`,
      ));
      subscription.searchParams.set(
        "subscribed_fields",
        "messages,messaging_postbacks,message_reactions,messaging_seen,standby",
      );
      const payload = object(await requestJson(
        fetcher,
        subscription,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
        },
        "META_OAUTH_WEBHOOK_SUBSCRIPTION_FAILED",
      ));
      if (payload?.success !== true) {
        throw new MetaOAuthError("META_OAUTH_WEBHOOK_SUBSCRIPTION_ENVELOPE_INVALID");
      }
      const saved = await repositories.markSubscribed({
        sessionId: expectedSession,
        assetId: expectedAsset,
        subscribedAt: now().toISOString(),
      });
      return { connectionId: saved.connectionId, state: "ready" };
    },
  };
}

export function createMockMetaOAuthService(dependencies: MetaOAuthDependencies) {
  const configuration = mockConfiguration();
  return createMetaOAuthService(configuration, {
    ...dependencies,
    fetch: mockFetch(configuration),
  });
}

export function selectMetaOAuthService({
  environment = process.env,
  dependencies,
}: {
  environment?: EnvironmentSource;
  dependencies: Omit<MetaOAuthDependencies, "environment">;
}) {
  if (driverSelection("meta", "SETTERFI_META_DRIVER", environment) === "mock") {
    return createMockMetaOAuthService({ ...dependencies, environment });
  }
  const values = requireEnvironment("meta", META_OAUTH_CONFIGURATION_NAMES, environment);
  return createMetaOAuthService({
    appBaseUrl: values.APP_BASE_URL,
    appId: values.META_APP_ID,
    appSecret: values.META_APP_SECRET,
    loginConfigId: values.META_LOGIN_CONFIG_ID,
  }, { ...dependencies, environment });
}
