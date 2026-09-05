/**
 * GHL messaging owns provider-shaped verification, install reconciliation, and message payloads.
 *
 * Tenant resolution remains outside this module because a platform-wide webhook signature proves
 * provider origin, not which SetterFi tenant owns the payload's location identifier.
 */

import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";

import {
  DriverConfigurationError,
  environmentValue,
  type EnvironmentSource,
} from "@/lib/env-contract";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

import type { A2pProbeResult } from "@/lib/onboarding/contracts";
import type {
  A2pSubmission,
  GhlLocation,
  GhlLocationRequest,
  GhlNumberRequest,
  GhlProvisioningDriver,
  GhlSnapshotStatus,
  ProvisioningContext,
  PurchasedNumber,
} from "@/lib/onboarding/provider-contracts";

import { decryptCredential } from "./credential-envelope";
import { GhlOAuthError } from "./ghl-oauth";
import {
  resolveGhlAgencyAccessToken,
  resolveGhlLocationAccessToken,
  resolveGhlProvisioningAccessToken,
} from "./ghl-oauth-store";
import {
  GHL_MESSAGING_CAPABILITIES,
  type AuthorizedOutboundCommand,
  type GhlMessagingAdapter,
  type MessagingChannel,
  type NormalizedInboundEvent,
} from "./types";

const GHL_BASE_URL = "https://services.leadconnectorhq.com";
/** Refresh this far ahead of expiry so an in-flight request never straddles the boundary. */
const GHL_TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1_000;

export class GhlProviderError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
    readonly bodyShape: string | null = null,
  ) {
    super(status === null ? code : `${code} (HTTP ${status})`);
    this.name = "GhlProviderError";
  }
}

type FetchLike = typeof fetch;
type JsonObject = Record<string, unknown>;

export type GhlDriverDependencies = {
  fetch?: FetchLike;
  now?: () => number;
  locationId?: string;
  getLocationAccessToken?: (locationId: string) => Promise<string>;
  getCompanyInstall?: (locationId: string) => Promise<{ companyId: string; accessToken: string }>;
};

type GhlInstallCredentialRow = {
  id: string;
  installState: string;
  accessCredentialEnvelope: unknown;
  /** Absent when the caller's port does not model expiry; null when the row never recorded one. */
  tokenExpiresAt?: string | null;
  reauthorizationRequiredAt?: string | null;
};

export type GhlCredentialResolverDependencies = {
  loadInstall(locationId: string): Promise<GhlInstallCredentialRow | null>;
  decryptCredential(value: unknown): string;
  /** Refreshes and persists a rotated grant. Absent means this resolver cannot refresh at all. */
  resolveRefreshed?(locationId: string): Promise<string>;
  now?: () => number;
};

export type GhlDriverConfiguration = {
  clientId: string;
  clientSecret: string;
  webhookPublicKey: string;
};

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function bodyShape(value: unknown) {
  const record = object(value);
  return record ? Object.keys(record).sort().join(",") : Array.isArray(value) ? "array" : typeof value;
}

async function responseJson(
  response: Response,
  code: string,
  classify?: (status: number, payload: unknown) => string | null,
) {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new GhlProviderError(`${code}_MALFORMED_JSON`, response.status, "non-json");
  }
  if (!response.ok) {
    throw new GhlProviderError(
      classify?.(response.status, payload) ?? code,
      response.status,
      bodyShape(payload),
    );
  }
  return payload;
}

/**
 * The one location-token refusal worth a name of its own. A bulk agency install fires an INSTALL
 * webhook for every sub-account the agency has, including the paused and deleted ones, and the
 * provider then refuses to mint a token for those with a 400 whose body says exactly this. It is a
 * fact about the sub-account, not about our request, so retrying it changes nothing until someone
 * reactivates the location in the agency. Matched on the message because the status alone is the
 * same 400 the endpoint uses for a malformed request.
 */
function classifyLocationTokenRefusal(status: number, payload: unknown) {
  if (status !== 400) return null;
  const message = text(object(payload)?.message)?.toLowerCase() ?? "";
  return message.includes("location is not active") ? "GHL_INSTALL_LOCATION_INACTIVE" : null;
}

function stableId(prefix: string, values: readonly string[]) {
  let hash = 2_166_136_261;
  for (const character of values.join("|")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function ghlChannel(value: unknown) {
  const normalized = text(value)?.toUpperCase();
  if (normalized === "SMS") return "sms" as const;
  if (normalized === "IG") return "instagram" as const;
  if (normalized === "FB") return "messenger" as const;
  if (normalized === "WHATSAPP") return "whatsapp" as const;
  throw new GhlProviderError("GHL_INBOUND_CHANNEL_UNSUPPORTED");
}

function normalizedPhone(value: unknown) {
  const candidate = text(value)?.replace(/[\s().-]/g, "") ?? null;
  return candidate && /^\+[1-9]\d{7,14}$/.test(candidate) ? candidate : null;
}

function normalizedEmail(value: unknown) {
  const candidate = text(value)?.toLowerCase() ?? null;
  return candidate && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : null;
}

function normalizeGhlEvent(payload: unknown): NormalizedInboundEvent {
  const row = object(payload);
  const eventId = text(row?.webhookId) ?? text(row?.eventId) ?? text(row?.id);
  const locationId = text(row?.locationId);
  if (!eventId || !locationId) throw new GhlProviderError("GHL_INBOUND_ENVELOPE_INVALID");

  if (row?.isEcho === true) {
    return {
      kind: "ignored",
      eventId,
      externalAccountId: locationId,
      reason: "echo",
    };
  }

  const eventType = text(row?.type) ?? text(row?.eventType);
  const status = text(row?.status);
  if (status && (eventType?.toLowerCase().includes("status") || !text(row?.body))) {
    return {
      kind: "status",
      eventId,
      externalAccountId: locationId,
      status,
    };
  }

  const providerIdentityId = text(row?.contactId);
  const providerMessageId = text(row?.messageId);
  const body = text(row?.body);
  if (!providerIdentityId || !providerMessageId || !body) {
    throw new GhlProviderError("GHL_INBOUND_ENVELOPE_INVALID");
  }
  return {
    kind: "message" as const,
    eventId,
    providerMessageId,
    body,
    externalAccountId: locationId,
    identity: {
      channel: ghlChannel(row?.messageType),
      provider: "ghl" as const,
      externalId: providerIdentityId,
      normalizedPhone: normalizedPhone(row?.phone),
      normalizedEmail: normalizedEmail(row?.email),
    },
    providerWindow: null,
  };
}

export function normalizeGhlInbound(payload: unknown) {
  const events = Array.isArray(payload) ? payload : [payload];
  if (events.length === 0) throw new GhlProviderError("GHL_INBOUND_BATCH_EMPTY");
  return { events: events.map(normalizeGhlEvent) };
}

export function normalizeGhlInstall(payload: unknown) {
  const row = object(payload);
  const eventId = text(row?.webhookId) ?? text(row?.eventId) ?? text(row?.id);
  const locationId = text(row?.locationId);
  const companyId = text(row?.companyId);
  if (!eventId || (!locationId && !companyId)) {
    throw new GhlProviderError("GHL_INSTALL_ENVELOPE_INVALID");
  }
  return { eventId, locationId, companyId };
}

function signatureBytes(signature: string) {
  const encoded = signature.replace(/^(?:ed25519|rsa|sha256)=/i, "").trim();
  if (!encoded) return null;
  try {
    return Buffer.from(encoded, "base64");
  } catch {
    return null;
  }
}

function verifyGhlWebhook(rawBody: Uint8Array, signature: string, publicKey: string) {
  const decoded = signatureBytes(signature);
  if (!decoded) return false;
  try {
    const key = createPublicKey(publicKey);
    const algorithm = key.asymmetricKeyType === "ed25519" ? null : "RSA-SHA256";
    return verify(algorithm, rawBody, key, decoded);
  } catch {
    return false;
  }
}

/**
 * The agency install, resolved from storage and refreshed if stale.
 *
 * This replaces a default that unconditionally threw, which meant that with real drivers on, no
 * install could ever be reconciled. Provider failures keep the provider error class so the caller's
 * classification does not change shape.
 */
async function liveCompanyInstall(locationId: string) {
  try {
    return await resolveGhlAgencyAccessToken();
  } catch (error) {
    if (error instanceof GhlOAuthError) {
      throw new GhlProviderError(`${error.code}:${locationId}`, error.status, error.bodyShape);
    }
    throw error;
  }
}

async function liveCredentialResolverDependencies(): Promise<GhlCredentialResolverDependencies> {
  const client = createSupabaseServiceClient();
  return {
    loadInstall: async (locationId) => {
      const { data: install, error: installError } = await client
        .from("ghl_installs")
        .select("id, install_state, token_expires_at, reauthorization_required_at")
        .eq("location_id", locationId)
        .maybeSingle();
      if (installError) throw new GhlProviderError("GHL_INSTALL_LOOKUP_FAILED");
      if (!install) return null;
      const { data: secret, error: secretError } = await client
        .from("ghl_install_secrets")
        .select("access_credential_envelope")
        .eq("ghl_install_id", install.id)
        .maybeSingle();
      if (secretError) throw new GhlProviderError("GHL_INSTALL_SECRET_LOOKUP_FAILED");
      return {
        id: install.id,
        installState: install.install_state,
        accessCredentialEnvelope: secret?.access_credential_envelope ?? null,
        tokenExpiresAt: install.token_expires_at ?? null,
        reauthorizationRequiredAt: install.reauthorization_required_at ?? null,
      };
    },
    decryptCredential,
    resolveRefreshed: (locationId) => resolveGhlLocationAccessToken(locationId),
  };
}

/**
 * Returns a location access token that is actually still valid.
 *
 * Provider access tokens live about a day, so a stored one is only usable while it is comfortably
 * short of expiry. Past that the resolver refreshes through the injected port; if the caller gave
 * it no port it refuses rather than handing back a token the provider will reject.
 */
export async function resolveGhlInstallAccessToken(
  locationId: string,
  dependencies?: GhlCredentialResolverDependencies,
) {
  const normalizedLocationId = locationId.trim();
  if (!normalizedLocationId) throw new GhlProviderError("GHL_LOCATION_REQUIRED");
  const deps = dependencies ?? (await liveCredentialResolverDependencies());
  const now = deps.now ?? Date.now;
  const row = await deps.loadInstall(normalizedLocationId);
  if (!row || row.installState === "uninstalled") {
    throw new GhlProviderError("GHL_INSTALL_UNAVAILABLE");
  }
  if (row.reauthorizationRequiredAt) {
    throw new GhlProviderError("GHL_INSTALL_REAUTHORIZATION_REQUIRED");
  }
  if (!row.accessCredentialEnvelope) throw new GhlProviderError("GHL_INSTALL_CREDENTIAL_UNAVAILABLE");
  if (row.tokenExpiresAt !== undefined) {
    const expiry = row.tokenExpiresAt === null ? null : Date.parse(row.tokenExpiresAt);
    const live = expiry !== null
      && Number.isFinite(expiry)
      && expiry - GHL_TOKEN_SAFETY_MARGIN_MS > now();
    if (!live) {
      if (!deps.resolveRefreshed) throw new GhlProviderError("GHL_INSTALL_TOKEN_EXPIRED");
      return deps.resolveRefreshed(normalizedLocationId);
    }
  }
  return deps.decryptCredential(row.accessCredentialEnvelope);
}

function freeformBody(command: AuthorizedOutboundCommand) {
  if (command.kind !== "freeform") throw new GhlProviderError("GHL_OUTBOUND_COMMAND_UNSUPPORTED");
  return command.body;
}

function ghlSendType(channel: MessagingChannel) {
  if (channel === "sms") return "SMS";
  if (channel === "instagram") return "IG";
  if (channel === "messenger") return "FB";
  if (channel === "whatsapp") return "WhatsApp";
  throw new GhlProviderError("GHL_OUTBOUND_CHANNEL_UNSUPPORTED");
}

export function createMockGhlDriver(): GhlMessagingAdapter {
  return {
    provider: "ghl",
    verifyWebhook: async (_rawBody, signature) => signature === "mock-signature",
    normalizeInbound: async (payload) => normalizeGhlInbound(payload),
    capabilities: (channel) => GHL_MESSAGING_CAPABILITIES[channel],
    send: async (command) => ({
      providerMessageId: stableId("mock-ghl-message", [
        command.recipientExternalId,
        command.channel,
        freeformBody(command),
      ]),
    }),
    reconcileInstall: async ({ eventId, locationId }) => ({
      companyId: stableId("mock-company", [locationId]),
      accessToken: stableId("mock-access", [eventId, locationId]),
      refreshToken: stableId("mock-refresh", [eventId, locationId]),
      tokenExpiresAt: "2030-01-01T00:00:00.000Z",
    }),
  };
}

export function createRealGhlDriver(
  configuration: GhlDriverConfiguration,
  {
    fetch: fetcher = fetch,
    now = Date.now,
    locationId,
    getLocationAccessToken = resolveGhlInstallAccessToken,
    getCompanyInstall = liveCompanyInstall,
  }: GhlDriverDependencies = {},
): GhlMessagingAdapter {
  return {
    provider: "ghl",
    verifyWebhook: async (rawBody, signature) =>
      verifyGhlWebhook(rawBody, signature, configuration.webhookPublicKey),
    normalizeInbound: async (payload) => normalizeGhlInbound(payload),
    capabilities: (channel: MessagingChannel) => GHL_MESSAGING_CAPABILITIES[channel],
    send: async (command) => {
      if (!locationId?.trim()) throw new GhlProviderError("GHL_LOCATION_REQUIRED");
      const accessToken = await getLocationAccessToken(locationId);
      const body = freeformBody(command);
      const response = await fetcher(`${GHL_BASE_URL}/conversations/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Version: "2021-04-15",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: ghlSendType(command.channel),
          contactId: command.recipientExternalId,
          message: body,
        }),
      });
      const payload = object(await responseJson(response, "GHL_SEND_FAILED"));
      const providerMessageId = text(payload?.messageId) ?? text(payload?.id);
      if (!providerMessageId) {
        throw new GhlProviderError("GHL_SEND_SUCCESS_ENVELOPE_INVALID", response.status, bodyShape(payload));
      }
      return { providerMessageId };
    },
    reconcileInstall: async ({ locationId }) => {
      const install = await getCompanyInstall(locationId);
      const body = new URLSearchParams({ companyId: install.companyId, locationId });
      const response = await fetcher(`${GHL_BASE_URL}/oauth/locationToken`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${install.accessToken}`,
          Version: "2021-07-28",
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Client-Id": configuration.clientId,
        },
        body,
      });
      const payload = object(await responseJson(
        response,
        "GHL_INSTALL_RECONCILE_FAILED",
        classifyLocationTokenRefusal,
      ));
      const accessToken = text(payload?.access_token) ?? text(payload?.accessToken);
      const refreshToken = text(payload?.refresh_token) ?? text(payload?.refreshToken);
      const companyId = text(payload?.companyId) ?? install.companyId;
      const expiresIn = typeof payload?.expires_in === "number" ? payload.expires_in : null;
      if (!accessToken || !refreshToken || !companyId || expiresIn === null || expiresIn <= 0) {
        throw new GhlProviderError(
          "GHL_INSTALL_SUCCESS_ENVELOPE_INVALID",
          response.status,
          bodyShape(payload),
        );
      }
      return {
        companyId,
        accessToken,
        refreshToken,
        tokenExpiresAt: new Date(now() + expiresIn * 1000).toISOString(),
      };
    },
  };
}

// Phase 5
export type GhlProvisioningConfiguration = {
  /**
   * Bootstrap only. The durable credential is the stored `app='provisioning'` install, which
   * renews itself under a row lease; this pasted value answers only until one exists.
   */
  agencyAccessToken?: string;
  agencyCompanyId: string;
  snapshotId: string;
  numberPoolId: string;
};

export type GhlProvisioningContractEvidence = {
  location: boolean;
  snapshot: boolean;
  number: boolean;
};

export type GhlProvisioningDependencies = {
  fetch?: FetchLike;
  now?: () => number;
  contractEvidence?: Partial<GhlProvisioningContractEvidence>;
  environment?: EnvironmentSource;
  /** The port that answers with the agency app's live Bearer, resolved once per outbound call. */
  resolveAgencyAccessToken?: () => Promise<string>;
};

export type GhlProvisioningOperation =
  | "location"
  | "snapshot"
  | "number"
  | "brand"
  | "campaign"
  | "probe";

export type MockGhlProvisioningOptions = {
  outcomeByOperation?: Partial<
    Record<GhlProvisioningOperation, "success" | "retryable_failure" | "terminal_refusal">
  >;
  now?: () => number;
};

export class GhlProvisioningError extends Error {
  constructor(
    readonly code: string,
    readonly classification: "retryable" | "terminal" | "contract_unverified",
  ) {
    super(code);
    this.name = "GhlProvisioningError";
  }
}

function strictText(record: JsonObject | null, key: string, code: string) {
  const value = text(record?.[key]);
  if (!value) throw new GhlProvisioningError(code, "contract_unverified");
  return value;
}

function stringArray(value: unknown, code: string) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new GhlProvisioningError(code, "contract_unverified");
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
}

export function normalizeGhlLocationResponse(payload: unknown): GhlLocation {
  const row = object(payload);
  const locationId = strictText(row, "id", "GHL_LOCATION_SUCCESS_ENVELOPE_INVALID");
  return {
    locationId,
    companyId: strictText(row, "companyId", "GHL_LOCATION_SUCCESS_ENVELOPE_INVALID"),
    rawReference: locationId,
  };
}

export function normalizeGhlSnapshotResponse(payload: unknown): GhlSnapshotStatus {
  const row = object(payload);
  if (typeof row?.processing !== "boolean") {
    throw new GhlProvisioningError(
      "GHL_SNAPSHOT_SUCCESS_ENVELOPE_INVALID",
      "contract_unverified",
    );
  }
  return {
    pending: stringArray(row.pending, "GHL_SNAPSHOT_SUCCESS_ENVELOPE_INVALID"),
    completed: stringArray(row.completed, "GHL_SNAPSHOT_SUCCESS_ENVELOPE_INVALID"),
    providerStatus: row.processing ? "processing" : "settled",
  };
}

/**
 * The live `snapshot-status` body is NOT verified against GoHighLevel documentation anywhere in
 * this repo — only the pinned mock shape is. Anything else fails closed under its own name so a
 * guessed envelope surfaces at cutover instead of normalising into a false "snapshot is ready".
 */
export function normalizeGhlSnapshotStatusResponse(payload: unknown): GhlSnapshotStatus {
  try {
    return normalizeGhlSnapshotResponse(payload);
  } catch (error) {
    if (error instanceof GhlProvisioningError) {
      throw new GhlProvisioningError(
        "GHL_SNAPSHOT_STATUS_RESPONSE_UNVERIFIED",
        "contract_unverified",
      );
    }
    throw error;
  }
}

export function normalizeGhlPurchasedNumberResponse(payload: unknown): PurchasedNumber {
  const envelope = object(payload);
  const data = object(envelope?.data);
  if (envelope?.status !== true || typeof envelope?.statusCode !== "number") {
    throw new GhlProvisioningError(
      "GHL_NUMBER_PURCHASE_SUCCESS_ENVELOPE_INVALID",
      "contract_unverified",
    );
  }
  const numberRef = strictText(data, "id", "GHL_NUMBER_PURCHASE_SUCCESS_ENVELOPE_INVALID");
  const phone = strictText(data, "number", "GHL_NUMBER_PURCHASE_SUCCESS_ENVELOPE_INVALID");
  if (typeof data?.underLcAccount !== "boolean") {
    throw new GhlProvisioningError(
      "GHL_NUMBER_PURCHASE_SUCCESS_ENVELOPE_INVALID",
      "contract_unverified",
    );
  }
  return {
    numberRef,
    maskedNumber: phone.length > 4 ? `${"*".repeat(phone.length - 4)}${phone.slice(-4)}` : phone,
    locationId: strictText(
      data,
      "locationId",
      "GHL_NUMBER_PURCHASE_SUCCESS_ENVELOPE_INVALID",
    ),
    underLcAccount: data.underLcAccount,
  };
}

function mockFailure(operation: GhlProvisioningOperation, options: MockGhlProvisioningOptions) {
  const outcome = options.outcomeByOperation?.[operation] ?? "success";
  if (outcome === "retryable_failure") {
    throw new GhlProvisioningError(`GHL_${operation.toUpperCase()}_RETRYABLE`, "retryable");
  }
  if (outcome === "terminal_refusal") {
    throw new GhlProvisioningError(`GHL_${operation.toUpperCase()}_TERMINAL`, "terminal");
  }
}

function mockSubmission(
  operation: Extract<GhlProvisioningOperation, "brand" | "campaign">,
  context: ProvisioningContext,
  now: () => number,
): A2pSubmission {
  return {
    submissionRef: stableId(`mock-ghl-${operation}`, [context.idempotencyKey]),
    submittedAt: new Date(now()).toISOString(),
    state: "submitted",
  };
}

export function createMockGhlProvisioningDriver(
  options: MockGhlProvisioningOptions = {},
): GhlProvisioningDriver {
  const now = options.now ?? (() => Date.parse("2030-01-01T00:00:00.000Z"));
  return {
    createOrFindLocation: async (context, request) => {
      mockFailure("location", options);
      const locationId = stableId("mock-ghl-location", [context.idempotencyKey]);
      return { locationId, companyId: request.companyId, rawReference: locationId };
    },
    getSnapshotStatus: async (context) => {
      mockFailure("snapshot", options);
      return {
        pending: [],
        completed: [stableId("mock-ghl-snapshot", [context.idempotencyKey])],
        providerStatus: "settled",
      };
    },
    purchaseOrFindNumber: async (context, request) => {
      mockFailure("number", options);
      return {
        numberRef: stableId("mock-ghl-number", [context.idempotencyKey]),
        maskedNumber: "*******0100",
        locationId: request.locationId,
        underLcAccount: true,
      };
    },
    submitBrand: async (context) => {
      mockFailure("brand", options);
      return mockSubmission("brand", context, now);
    },
    submitCampaign: async (context) => {
      mockFailure("campaign", options);
      return mockSubmission("campaign", context, now);
    },
    probeOwnedTarget: async (_context, input): Promise<A2pProbeResult> => {
      const outcome = options.outcomeByOperation?.probe ?? "success";
      if (outcome === "terminal_refusal") {
        return {
          kind: "terminal_refusal",
          probedAt: new Date(now()).toISOString(),
          code: "MOCK_CARRIER_TERMINAL",
          safeMessage: "Carrier registration was permanently refused.",
          targetHash: input.targetHash,
        };
      }
      if (outcome === "retryable_failure") {
        return {
          kind: "retryable_failure",
          probedAt: new Date(now()).toISOString(),
          code: "MOCK_PROBE_RETRYABLE",
          targetHash: input.targetHash,
        };
      }
      return {
        kind: "delivered",
        probedAt: new Date(now()).toISOString(),
        providerReference: stableId("mock-ghl-probe", [input.probeKey]),
        targetHash: input.targetHash,
      };
    },
  };
}

function requireContractEvidence(
  operation: keyof GhlProvisioningContractEvidence,
  evidence: Partial<GhlProvisioningContractEvidence>,
): void {
  if (!evidence[operation]) {
    const codes = {
      location: "GHL_LOCATION_CONTRACT_UNVERIFIED",
      snapshot: "GHL_SNAPSHOT_CONTRACT_UNVERIFIED",
      number: "GHL_NUMBER_PURCHASE_CONTRACT_UNVERIFIED",
    } as const;
    throw new GhlProvisioningError(codes[operation], "contract_unverified");
  }
}

function requireConfiguredReference(actual: string | undefined, expected: string, code: string) {
  if (actual !== undefined && actual !== expected) {
    throw new GhlProvisioningError(code, "terminal");
  }
  return expected;
}

function probeTargetHash(target: string) {
  return createHash("sha256").update(target).digest("hex");
}

function equalHash(left: string, right: string) {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

/**
 * The stored `app='provisioning'` grant, with the pasted env var as a bootstrap and nothing else.
 *
 * The fallback covers exactly two situations and rethrows every other one. `GHL_AGENCY_INSTALL_UNAVAILABLE`
 * means no install has been stored yet, and a Supabase client that cannot be constructed means this
 * process has no store to ask — in both, the pasted token is the only credential that exists and
 * using it is the honest answer. Everything else the store can raise — a grant the provider revoked,
 * a row with no recorded expiry, a lease whose holder never published — names a condition an
 * operator has to see and act on. Papering those over with a stale hand-pasted token converts a
 * refusal that says what is wrong into an unexplained 401 from HighLevel.
 */
function defaultAgencyTokenPort(
  configuration: GhlProvisioningConfiguration,
  environment: EnvironmentSource,
): () => Promise<string> {
  return async () => {
    let client: ReturnType<typeof createSupabaseServiceClient>;
    try {
      client = createSupabaseServiceClient();
    } catch (error) {
      if (configuration.agencyAccessToken) return configuration.agencyAccessToken;
      throw error;
    }
    try {
      const { accessToken } = await resolveGhlProvisioningAccessToken(environment, client);
      return accessToken;
    } catch (error) {
      if (
        configuration.agencyAccessToken
        && error instanceof GhlOAuthError
        && error.code === "GHL_AGENCY_INSTALL_UNAVAILABLE"
      ) {
        return configuration.agencyAccessToken;
      }
      throw error;
    }
  };
}

export function createRealGhlProvisioningDriver(
  configuration: GhlProvisioningConfiguration,
  dependencies: GhlProvisioningDependencies = {},
): GhlProvisioningDriver {
  const fetcher = dependencies.fetch ?? fetch;
  const evidence = dependencies.contractEvidence ?? {};
  const environment = dependencies.environment ?? process.env;
  const resolveAgencyAccessToken =
    dependencies.resolveAgencyAccessToken ?? defaultAgencyTokenPort(configuration, environment);
  /**
   * Built per call, not once at construction. The stored grant rotates under its row lease, so a
   * header captured when the driver was made would pin every later call to a token the provider
   * has already expired.
   */
  const authorizedHeaders = async () => ({
    Authorization: `Bearer ${await resolveAgencyAccessToken()}`,
    Version: "2021-07-28",
    "Content-Type": "application/json",
  });
  return {
    createOrFindLocation: async (_context, request: GhlLocationRequest) => {
      requireContractEvidence("location", evidence);
      requireConfiguredReference(
        request.companyId,
        configuration.agencyCompanyId,
        "GHL_AGENCY_COMPANY_MISMATCH",
      );
      requireConfiguredReference(
        request.snapshotId,
        configuration.snapshotId,
        "GHL_SNAPSHOT_ID_MISMATCH",
      );
      const response = await fetcher(`${GHL_BASE_URL}/locations/`, {
        method: "POST",
        headers: await authorizedHeaders(),
        body: JSON.stringify({
          companyId: request.companyId,
          name: request.name,
          timezone: request.timezone,
          country: request.country,
          address: request.address,
          snapshotId: request.snapshotId,
        }),
      });
      return normalizeGhlLocationResponse(await responseJson(response, "GHL_LOCATION_CREATE_FAILED"));
    },
    getSnapshotStatus: async (_context, request) => {
      requireContractEvidence("snapshot", evidence);
      requireConfiguredReference(
        request.companyId,
        configuration.agencyCompanyId,
        "GHL_AGENCY_COMPANY_MISMATCH",
      );
      requireConfiguredReference(
        request.snapshotId,
        configuration.snapshotId,
        "GHL_SNAPSHOT_ID_MISMATCH",
      );
      // GHL v2 puts the snapshot and location in the path, not the query string; only companyId
      // is a parameter. /snapshots/status never existed and would have 404'd at cutover.
      const query = new URLSearchParams({ companyId: request.companyId });
      const response = await fetcher(
        `${GHL_BASE_URL}/snapshots/snapshot-status/${encodeURIComponent(request.snapshotId)}`
        + `/location/${encodeURIComponent(request.locationId)}?${query}`,
        { headers: await authorizedHeaders() },
      );
      return normalizeGhlSnapshotStatusResponse(
        await responseJson(response, "GHL_SNAPSHOT_STATUS_FAILED"),
      );
    },
    purchaseOrFindNumber: async (_context, request: GhlNumberRequest) => {
      requireContractEvidence("number", evidence);
      const poolId = requireConfiguredReference(
        request.poolId,
        configuration.numberPoolId,
        "GHL_NUMBER_POOL_MISMATCH",
      );
      const response = await fetcher(
        `${GHL_BASE_URL}/phone-system/numbers/location/${encodeURIComponent(request.locationId)}/purchase`,
        {
          method: "POST",
          headers: await authorizedHeaders(),
          body: JSON.stringify({ poolId, areaCode: request.areaCode }),
        },
      );
      return normalizeGhlPurchasedNumberResponse(
        await responseJson(response, "GHL_NUMBER_PURCHASE_FAILED"),
      );
    },
    submitBrand: async () => {
      throw new GhlProvisioningError(
        "GHL_A2P_SUBMISSION_API_UNVERIFIED",
        "contract_unverified",
      );
    },
    submitCampaign: async () => {
      throw new GhlProvisioningError(
        "GHL_A2P_SUBMISSION_API_UNVERIFIED",
        "contract_unverified",
      );
    },
    probeOwnedTarget: async (_context, input) => {
      // The plaintext target exists only for the duration of the provider call; durable evidence
      // compares and stores the configured digest so a probe can never become a lead-number path.
      const target = environmentValue("SETTERFI_A2P_PROBE_TARGET", environment);
      const configuredHash = environmentValue("SETTERFI_A2P_PROBE_TARGET_HASH", environment);
      if (!target || !configuredHash) {
        const missing = [
          !target ? "SETTERFI_A2P_PROBE_TARGET" : null,
          !configuredHash ? "SETTERFI_A2P_PROBE_TARGET_HASH" : null,
        ].filter((name): name is
          | "SETTERFI_A2P_PROBE_TARGET"
          | "SETTERFI_A2P_PROBE_TARGET_HASH" => name !== null);
        throw new DriverConfigurationError("ghl_provisioning", missing);
      }
      if (
        !equalHash(probeTargetHash(target), configuredHash)
        || !equalHash(input.targetHash, configuredHash)
      ) {
        throw new GhlProvisioningError("GHL_A2P_PROBE_TARGET_MISMATCH", "terminal");
      }
      throw new GhlProvisioningError(
        "GHL_A2P_PROBE_CONTRACT_UNVERIFIED",
        "contract_unverified",
      );
    },
  };
}
