import { createHash } from "node:crypto";

import { resolveGhlLocationAccessToken } from "@/lib/integrations/ghl-oauth-store";
import type {
  SuppressionMutationReceipt,
  SuppressionProviderInput,
  SuppressionProviderPort,
} from "@/lib/sends/contracts";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const GHL_BASE_URL = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "v3";

type FetchLike = typeof fetch;
type JsonObject = Record<string, unknown>;

export type GhlSuppressionProviderDependencies = {
  fetch?: FetchLike;
  now?: () => Date;
  loadLocationId(tenantId: string): Promise<string>;
  getLocationAccessToken(locationId: string): Promise<string>;
};

export class GhlSuppressionProviderError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "GhlSuppressionProviderError";
  }
}

function channelKey(input: SuppressionProviderInput) {
  if (input.provider !== "ghl") {
    throw new GhlSuppressionProviderError("SUPPRESSION_PROVIDER_UNSUPPORTED");
  }
  if (input.channel === "sms") return "SMS";
  if (input.channel === "whatsapp") return "WhatsApp";
  if (input.channel === "messenger") return "FB";
  throw new GhlSuppressionProviderError("GHL_SUPPRESSION_CHANNEL_UNSUPPORTED");
}

function operationId(input: SuppressionProviderInput) {
  return createHash("sha256")
    .update(`${input.tenantId}:${input.identityId}:${input.providerIdentityId}:${input.idempotencyKey}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

async function json(response: Response, code: string) {
  try {
    const payload: unknown = await response.json();
    const row = object(payload);
    if (!row) throw new GhlSuppressionProviderError(code);
    return row;
  } catch (error) {
    if (error instanceof GhlSuppressionProviderError) throw error;
    throw new GhlSuppressionProviderError(code);
  }
}

async function request(
  input: SuppressionProviderInput,
  dependencies: GhlSuppressionProviderDependencies,
  method: "GET" | "PUT",
  body?: JsonObject,
) {
  channelKey(input);
  const locationId = await dependencies.loadLocationId(input.tenantId);
  const accessToken = await dependencies.getLocationAccessToken(locationId);
  try {
    return await (dependencies.fetch ?? fetch)(
      `${GHL_BASE_URL}/contacts/${encodeURIComponent(input.providerIdentityId)}`,
      {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          Version: GHL_API_VERSION,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        cache: "no-store",
      },
    );
  } catch {
    throw new GhlSuppressionProviderError(`GHL_SUPPRESSION_${method}_NETWORK_FAILED`);
  }
}

async function mutate(
  input: SuppressionProviderInput,
  suppressed: boolean,
  dependencies: GhlSuppressionProviderDependencies,
): Promise<SuppressionMutationReceipt> {
  const response = await request(input, dependencies, "PUT", {
    dndSettings: {
      [channelKey(input)]: {
        status: suppressed ? "active" : "inactive",
        message: suppressed ? "SetterFi opt-out" : "SetterFi opt-in",
      },
    },
  });
  if (!response.ok) throw new GhlSuppressionProviderError("GHL_SUPPRESSION_MUTATION_FAILED");
  const payload = await json(response, "GHL_SUPPRESSION_MUTATION_ENVELOPE_INVALID");
  const contact = object(payload.contact);
  if ((payload.succeeded !== true && payload.succeded !== true)
    || contact?.id !== input.providerIdentityId) {
    throw new GhlSuppressionProviderError("GHL_SUPPRESSION_MUTATION_UNCONFIRMED");
  }
  return {
    providerOperationId: operationId(input),
    acceptedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
  };
}

export function createGhlSuppressionProviderPort(
  dependencies: GhlSuppressionProviderDependencies,
): SuppressionProviderPort {
  return {
    suppress: (input) => mutate(input, true, dependencies),
    clear: (input) => mutate(input, false, dependencies),
    readBack: async (input) => {
      const response = await request(input, dependencies, "GET");
      if (!response.ok) throw new GhlSuppressionProviderError("GHL_SUPPRESSION_READBACK_FAILED");
      const payload = await json(response, "GHL_SUPPRESSION_READBACK_ENVELOPE_INVALID");
      const contact = object(payload.contact);
      const dndSettings = object(contact?.dndSettings);
      const setting = object(dndSettings?.[channelKey(input)]);
      if (contact?.id !== input.providerIdentityId
        || (setting?.status !== "active" && setting?.status !== "inactive")) {
        throw new GhlSuppressionProviderError("GHL_SUPPRESSION_READBACK_ENVELOPE_INVALID");
      }
      return {
        providerOperationId: operationId(input),
        suppressed: setting.status === "active",
        observedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
      };
    },
  };
}

export function createLiveGhlSuppressionProviderPort(): SuppressionProviderPort {
  const client = createSupabaseServiceClient();
  return createGhlSuppressionProviderPort({
    loadLocationId: async (tenantId) => {
      const { data, error } = await client.from("ghl_installs")
        .select("location_id")
        .eq("tenant_id", tenantId)
        .neq("install_state", "uninstalled")
        .order("updated_at", { ascending: false })
        .limit(2);
      if (error) throw new GhlSuppressionProviderError("GHL_SUPPRESSION_INSTALL_LOOKUP_FAILED");
      if (!data || data.length === 0) {
        throw new GhlSuppressionProviderError("GHL_SUPPRESSION_INSTALL_UNAVAILABLE");
      }
      if (data.length !== 1 || typeof data[0].location_id !== "string" || !data[0].location_id.trim()) {
        throw new GhlSuppressionProviderError("GHL_SUPPRESSION_INSTALL_AMBIGUOUS");
      }
      return data[0].location_id;
    },
    getLocationAccessToken: resolveGhlLocationAccessToken,
  });
}
