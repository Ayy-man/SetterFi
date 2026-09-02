import { createHash } from "node:crypto";

import { resolveGhlLocationAccessToken } from "@/lib/integrations/ghl-oauth-store";
import type {
  DeletionProviderInput,
  DeletionProviderPort,
} from "@/lib/sends/contracts";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const GHL_BASE_URL = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "v3";
const GHL_REQUEST_TIMEOUT_MS = 15_000;

type FetchLike = typeof fetch;

export type GhlDeletionProviderDependencies = {
  fetch?: FetchLike;
  now?: () => Date;
  requestTimeoutMs?: number;
  loadLocationId(tenantId: string, ghlInstallId: string, providerAccountId: string): Promise<string>;
  getLocationAccessToken(locationId: string): Promise<string>;
};

export class GhlDeletionProviderError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "GhlDeletionProviderError";
  }
}

function operationId(input: DeletionProviderInput) {
  const frame = [
    input.tenantId,
    input.contactId,
    input.ghlInstallId,
    input.providerAccountId,
    input.providerContactId,
    input.idempotencyKey,
  ].map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`).join("");
  return createHash("sha256")
    .update(frame, "utf8")
    .digest("hex")
    .slice(0, 32);
}

async function request(
  input: DeletionProviderInput,
  dependencies: GhlDeletionProviderDependencies,
  method: "GET" | "DELETE",
) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    dependencies.requestTimeoutMs ?? GHL_REQUEST_TIMEOUT_MS,
  );
  try {
    const locationId = await dependencies.loadLocationId(
      input.tenantId, input.ghlInstallId, input.providerAccountId,
    );
    if (locationId !== input.providerAccountId) {
      throw new GhlDeletionProviderError("GHL_CONTACT_INSTALL_ACCOUNT_MISMATCH");
    }
    const accessToken = await dependencies.getLocationAccessToken(locationId);
    controller.signal.throwIfAborted();
    let response: Response;
    try {
      response = await (dependencies.fetch ?? fetch)(
        `${GHL_BASE_URL}/contacts/${encodeURIComponent(input.providerContactId)}`,
        {
          method,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`,
            Version: GHL_API_VERSION,
          },
          cache: "no-store",
          signal: controller.signal,
        },
      );
    } catch {
      throw new GhlDeletionProviderError(`GHL_CONTACT_${method}_NETWORK_FAILED`);
    }
    return { response, finish: () => clearTimeout(timeout) };
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

async function responseObject(response: Response, code: string) {
  try {
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new GhlDeletionProviderError(code);
    }
    return payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof GhlDeletionProviderError) throw error;
    throw new GhlDeletionProviderError(code);
  }
}

export function createGhlDeletionProviderPort(
  dependencies: GhlDeletionProviderDependencies,
): DeletionProviderPort {
  return {
    deleteContact: async (input) => {
      const pending = await request(input, dependencies, "DELETE");
      try {
        if (pending.response.status !== 404) {
          if (!pending.response.ok) throw new GhlDeletionProviderError("GHL_CONTACT_DELETE_FAILED");
          const payload = await responseObject(
            pending.response, "GHL_CONTACT_DELETE_ENVELOPE_INVALID",
          );
          if (payload.succeeded !== true && payload.succeded !== true) {
            throw new GhlDeletionProviderError("GHL_CONTACT_DELETE_UNCONFIRMED");
          }
        }
      } finally {
        pending.finish();
      }
      return {
        providerOperationId: operationId(input),
        acceptedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
      };
    },

    readAbsent: async (input) => {
      const pending = await request(input, dependencies, "GET");
      try {
        if (pending.response.status === 404) {
          return {
            providerOperationId: operationId(input),
            absent: true,
            observedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
          };
        }
        if (!pending.response.ok) {
          throw new GhlDeletionProviderError("GHL_CONTACT_READBACK_FAILED");
        }
        const payload = await responseObject(
          pending.response, "GHL_CONTACT_READBACK_ENVELOPE_INVALID",
        );
        const contact = payload.contact;
        if (!contact || typeof contact !== "object" || Array.isArray(contact)
          || (contact as Record<string, unknown>).id !== input.providerContactId) {
          throw new GhlDeletionProviderError("GHL_CONTACT_READBACK_ENVELOPE_INVALID");
        }
        return {
          providerOperationId: operationId(input),
          absent: false,
          observedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
        };
      } finally {
        pending.finish();
      }
    },
  };
}

export function createLiveGhlDeletionProviderPort(): DeletionProviderPort {
  const client = createSupabaseServiceClient();
  return createGhlDeletionProviderPort({
    loadLocationId: async (tenantId, ghlInstallId, providerAccountId) => {
      const { data, error } = await client.from("ghl_installs")
        .select("id, location_id, install_state")
        .eq("tenant_id", tenantId)
        .eq("id", ghlInstallId)
        .maybeSingle();
      if (error) throw new GhlDeletionProviderError("GHL_CONTACT_INSTALL_LOOKUP_FAILED");
      if (!data || data.location_id !== providerAccountId ||
        (data.install_state !== "installed" && data.install_state !== "token_ok")) {
        // An uninstalled/failed historical location cannot be replaced with the tenant's current
        // install: a 404 from that other account is not evidence that this contact is absent.
        throw new GhlDeletionProviderError("GHL_CONTACT_INSTALL_CREDENTIAL_UNAVAILABLE");
      }
      return data.location_id;
    },
    getLocationAccessToken: resolveGhlLocationAccessToken,
  });
}
