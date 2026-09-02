/**
 * WhatsApp Embedded Signup owns its gated server exchange and provider readiness checks.
 *
 * Browser completion is never a live-channel receipt. The service persists only an encrypted
 * credential and returns ready or pending_review after WABA subscription and phone readback.
 */

import { createHash } from "node:crypto";

import {
  driverSelection,
  requireEnvironment,
  whatsappEmbeddedSignupEnabled,
  type EnvironmentName,
  type EnvironmentSource,
} from "@/lib/env-contract";

import { encryptCredential, type CredentialEnvelopeV1 } from "./credential-envelope";
import { META_GRAPH_VERSION } from "./meta";

type JsonObject = Record<string, unknown>;
type FetchLike = typeof fetch;

export const META_WHATSAPP_EMBEDDED_SIGNUP_CONFIGURATION_NAMES = [
  "APP_BASE_URL",
  "META_APP_ID",
  "META_APP_SECRET",
  "META_LOGIN_CONFIG_ID",
  "SETTERFI_CREDENTIAL_ENCRYPTION_KEY",
] as const satisfies readonly EnvironmentName[];

export type WhatsAppEmbeddedSignupConfiguration = {
  appBaseUrl: string;
  appId: string;
  appSecret: string;
  loginConfigId: string;
};

export type WhatsAppEmbeddedSignupRepository = {
  persistConnection(input: {
    tenantId: string;
    actorId: string;
    wabaId: string;
    phoneNumberId: string;
    credentialEnvelope: CredentialEnvelopeV1;
    tokenExpiresAt: string | null;
    scopes: readonly string[];
    webhookSubscribedAt: string;
    phoneVerifiedAt: string | null;
    state: "pending_review" | "ready";
  }): Promise<{ connectionId: string }>;
};

export type WhatsAppEmbeddedSignupDependencies = {
  repository: WhatsAppEmbeddedSignupRepository;
  fetch?: FetchLike;
  now?: () => Date;
  encryptCredential?: typeof encryptCredential;
  environment?: EnvironmentSource;
};

export type WhatsAppEmbeddedSignupService = {
  launcher(): {
    appId: string;
    configurationId: string;
    sessionInfoVersion: "4";
  };
  complete(input: {
    tenantId: string;
    actorId: string;
    code: string;
    wabaId: string;
    phoneNumberId: string;
  }): Promise<{ connectionId: string; state: "pending_review" | "ready" }>;
};

export class WhatsAppEmbeddedSignupError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
    readonly bodyShape: string | null = null,
  ) {
    super(status === null ? code : `${code} (HTTP ${status})`);
    this.name = "WhatsAppEmbeddedSignupError";
  }
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
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
  if (!normalized) throw new WhatsAppEmbeddedSignupError(code);
  return normalized;
}

function scopes(value: unknown) {
  return Array.isArray(value)
    ? value.map(text).filter((scope): scope is string => scope !== null).sort()
    : [];
}

function scopedTargets(value: unknown, scope: string) {
  if (!Array.isArray(value)) return [];
  const targetIds = value.flatMap((entry) => {
    const row = object(entry);
    if (text(row?.scope) !== scope || !Array.isArray(row?.target_ids)) return [];
    return row.target_ids.map(text).filter((target): target is string => target !== null);
  });
  return [...new Set(targetIds)];
}

function tokenExpiry(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return new Date(value * 1_000).toISOString();
}

function graphUrl(path: string) {
  return `https://graph.facebook.com/${META_GRAPH_VERSION}/${path}`;
}

async function responseJson(response: Response, code: string) {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new WhatsAppEmbeddedSignupError(`${code}_MALFORMED_JSON`, response.status, "non-json");
  }
  if (!response.ok) {
    throw new WhatsAppEmbeddedSignupError(code, response.status, shape(payload));
  }
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
    // Provider fetch errors can echo token-bearing URLs or headers; collapse them to a stable code.
    throw new WhatsAppEmbeddedSignupError(`${code}_NETWORK`);
  }
  return responseJson(response, code);
}

function mockConfiguration(): WhatsAppEmbeddedSignupConfiguration {
  const synthetic = (name: string) => createHash("sha256").update(name).digest("base64url");
  return {
    appBaseUrl: "https://setterfi.test",
    appId: "setterfi-whatsapp-mock-app",
    appSecret: synthetic("setterfi-whatsapp-mock-app-secret"),
    loginConfigId: "setterfi-whatsapp-mock-login-config",
  };
}

function mockFetch(configuration: WhatsAppEmbeddedSignupConfiguration): FetchLike {
  const synthetic = (name: string) => createHash("sha256").update(name).digest("base64url");
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/oauth/access_token")) {
      return Response.json({ access_token: synthetic("embedded-signup-exchanged-token") });
    }
    if (url.pathname.endsWith("/debug_token")) {
      return Response.json({
        data: {
          app_id: configuration.appId,
          is_valid: true,
          expires_at: 1_789_516_800,
          scopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
          granular_scopes: [{
            scope: "whatsapp_business_management",
            target_ids: ["mock-waba-1"],
          }],
        },
      });
    }
    if (url.pathname.endsWith("/mock-waba-1/phone_numbers")) {
      return Response.json({ data: [{ id: "mock-phone-1" }] });
    }
    if (url.pathname.endsWith("/mock-waba-1/subscribed_apps") && init?.method === "POST") {
      return Response.json({ success: true });
    }
    if (url.pathname.endsWith("/mock-phone-1")) {
      return Response.json({
        id: "mock-phone-1",
        code_verification_status: "VERIFIED",
        status: "CONNECTED",
      });
    }
    return Response.json({ error: { type: "unsupported_mock_request" } }, { status: 400 });
  };
}

export function createWhatsAppEmbeddedSignupService(
  configuration: WhatsAppEmbeddedSignupConfiguration,
  {
    repository,
    fetch: fetcher = fetch,
    now = () => new Date(),
    encryptCredential: encrypt = encryptCredential,
    environment = process.env,
  }: WhatsAppEmbeddedSignupDependencies,
): WhatsAppEmbeddedSignupService {
  return {
    launcher: () => {
      if (!whatsappEmbeddedSignupEnabled(environment)) {
        throw new WhatsAppEmbeddedSignupError("WHATSAPP_EMBEDDED_SIGNUP_DISABLED");
      }
      return {
        appId: configuration.appId,
        configurationId: configuration.loginConfigId,
        sessionInfoVersion: "4",
      };
    },

    complete: async ({ tenantId, actorId, code, wabaId, phoneNumberId }) => {
      if (!whatsappEmbeddedSignupEnabled(environment)) {
        throw new WhatsAppEmbeddedSignupError("WHATSAPP_EMBEDDED_SIGNUP_DISABLED");
      }
      const expectedTenant = required(tenantId, "EXPECTED_TENANT_REQUIRED");
      const expectedActor = required(actorId, "WHATSAPP_SIGNUP_ACTOR_REQUIRED");
      const expectedCode = required(code, "WHATSAPP_SIGNUP_CODE_REQUIRED");
      const expectedWaba = required(wabaId, "WHATSAPP_SIGNUP_WABA_REQUIRED");
      const expectedPhone = required(phoneNumberId, "WHATSAPP_SIGNUP_PHONE_REQUIRED");

      const exchange = new URL(graphUrl("oauth/access_token"));
      exchange.searchParams.set("client_id", configuration.appId);
      exchange.searchParams.set("client_secret", configuration.appSecret);
      exchange.searchParams.set("code", expectedCode);
      exchange.searchParams.set(
        "redirect_uri",
        `${new URL(configuration.appBaseUrl).origin}/api/channels/meta/embedded-signup`,
      );
      const exchanged = object(await requestJson(
        fetcher,
        exchange,
        { method: "GET" },
        "WHATSAPP_SIGNUP_CODE_EXCHANGE_FAILED",
      ));
      const exchangedToken = text(exchanged?.access_token);
      if (!exchangedToken) {
        throw new WhatsAppEmbeddedSignupError("WHATSAPP_SIGNUP_CODE_ENVELOPE_INVALID");
      }

      const inspection = new URL(graphUrl("debug_token"));
      inspection.searchParams.set("input_token", exchangedToken);
      inspection.searchParams.set("access_token", `${configuration.appId}|${configuration.appSecret}`);
      const inspected = object(await requestJson(
        fetcher,
        inspection,
        { method: "GET" },
        "WHATSAPP_SIGNUP_TOKEN_INSPECTION_FAILED",
      ));
      const data = object(inspected?.data);
      const grantedScopes = scopes(data?.scopes);
      const grantedWabas = scopedTargets(data?.granular_scopes, "whatsapp_business_management");
      if (
        data?.is_valid !== true || text(data.app_id) !== configuration.appId
        || !grantedScopes.includes("whatsapp_business_messaging")
        || !grantedScopes.includes("whatsapp_business_management")
      ) {
        throw new WhatsAppEmbeddedSignupError("WHATSAPP_CAPABLE_TOKEN_REQUIRED");
      }
      if (!grantedWabas.includes(expectedWaba)) {
        throw new WhatsAppEmbeddedSignupError("WHATSAPP_SIGNUP_ASSET_MISMATCH");
      }

      const phones = new URL(graphUrl(`${encodeURIComponent(expectedWaba)}/phone_numbers`));
      phones.searchParams.set("fields", "id");
      const phoneList = object(await requestJson(
        fetcher,
        phones,
        { method: "GET", headers: { Authorization: `Bearer ${exchangedToken}` } },
        "WHATSAPP_WABA_PHONE_LIST_FAILED",
      ));
      const phoneIds = Array.isArray(phoneList?.data)
        ? phoneList.data.map((entry) => text(object(entry)?.id)).filter((id): id is string => id !== null)
        : [];
      if (!phoneIds.includes(expectedPhone)) {
        throw new WhatsAppEmbeddedSignupError("WHATSAPP_SIGNUP_ASSET_MISMATCH");
      }

      const subscription = new URL(graphUrl(`${encodeURIComponent(expectedWaba)}/subscribed_apps`));
      const subscribed = object(await requestJson(
        fetcher,
        subscription,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${exchangedToken}` },
        },
        "WHATSAPP_WABA_SUBSCRIPTION_FAILED",
      ));
      if (subscribed?.success !== true) {
        throw new WhatsAppEmbeddedSignupError("WHATSAPP_WABA_SUBSCRIPTION_ENVELOPE_INVALID");
      }

      const phone = new URL(graphUrl(encodeURIComponent(expectedPhone)));
      phone.searchParams.set(
        "fields",
        "id,display_phone_number,verified_name,code_verification_status,quality_rating,status",
      );
      const phonePayload = object(await requestJson(
        fetcher,
        phone,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${exchangedToken}` },
        },
        "WHATSAPP_PHONE_READBACK_FAILED",
      ));
      if (text(phonePayload?.id) !== expectedPhone) {
        throw new WhatsAppEmbeddedSignupError("WHATSAPP_PHONE_READBACK_MISMATCH");
      }
      const phoneVerified = text(phonePayload?.code_verification_status) === "VERIFIED"
        && text(phonePayload?.status) === "CONNECTED";
      const completedAt = now().toISOString();
      const state = phoneVerified ? "ready" as const : "pending_review" as const;
      const saved = await repository.persistConnection({
        tenantId: expectedTenant,
        actorId: expectedActor,
        wabaId: expectedWaba,
        phoneNumberId: expectedPhone,
        credentialEnvelope: encrypt(exchangedToken, environment),
        tokenExpiresAt: tokenExpiry(data.expires_at),
        scopes: grantedScopes,
        webhookSubscribedAt: completedAt,
        phoneVerifiedAt: phoneVerified ? completedAt : null,
        state,
      });
      return { connectionId: saved.connectionId, state };
    },
  };
}

export function createMockWhatsAppEmbeddedSignupService(
  dependencies: WhatsAppEmbeddedSignupDependencies,
) {
  const configuration = mockConfiguration();
  return createWhatsAppEmbeddedSignupService(configuration, {
    ...dependencies,
    fetch: mockFetch(configuration),
  });
}

export function selectWhatsAppEmbeddedSignupService({
  environment = process.env,
  dependencies,
}: {
  environment?: EnvironmentSource;
  dependencies: Omit<WhatsAppEmbeddedSignupDependencies, "environment">;
}) {
  if (
    !whatsappEmbeddedSignupEnabled(environment)
    || driverSelection("meta", "SETTERFI_META_DRIVER", environment) === "mock"
  ) {
    return createMockWhatsAppEmbeddedSignupService({ ...dependencies, environment });
  }
  const values = requireEnvironment(
    "meta",
    META_WHATSAPP_EMBEDDED_SIGNUP_CONFIGURATION_NAMES,
    environment,
  );
  return createWhatsAppEmbeddedSignupService({
    appBaseUrl: values.APP_BASE_URL,
    appId: values.META_APP_ID,
    appSecret: values.META_APP_SECRET,
    loginConfigId: values.META_LOGIN_CONFIG_ID,
  }, { ...dependencies, environment });
}
