import { capiLive } from "@/lib/env-contract";
import { decryptCredential } from "@/lib/integrations/credential-envelope";
import {
  CapiContractError,
  CapiProviderError,
  createMockCapiDriver,
  createRealCapiDriver,
  type CapiDriver,
  type CapiEvent,
  type CapiProviderReceipt,
  type CapiUserIdentity,
} from "@/lib/integrations/capi";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type ClaimedCapiEvent = {
  eventId: string;
  tenantId: string;
  conversationId: string;
  datasetRowId: string | null;
  channel: "messenger" | "instagram" | "whatsapp";
  eventName: "QualifiedLead" | "Purchase";
  eventTime: string;
  currency: string | null;
  value: number | null;
  isTest: boolean;
  isDemo: boolean;
  attemptNumber: number;
  maxAttempts: number;
  claimToken: string;
};

export type ResolvedCapiEvent = {
  event: CapiEvent;
  connectionId: string;
};

export function capiDatasetLookup(event: ClaimedCapiEvent) {
  return event.datasetRowId
    ? { tenantId: event.tenantId, datasetRowId: event.datasetRowId, channel: null }
    : { tenantId: event.tenantId, datasetRowId: null, channel: event.channel };
}

type FinishInput = {
  eventId: string;
  claimToken: string;
  status: "sent" | "mock_sent" | "retry" | "terminal_failed" | "excluded_test";
  providerMode: "none" | "mock" | "real";
  providerReceipt: Record<string, unknown>;
  error: string | null;
  retryAt: string | null;
  now: string;
};

export type CapiWorkerDependencies = {
  claim(limit: number, now: string): Promise<readonly ClaimedCapiEvent[]>;
  resolve(row: ClaimedCapiEvent): Promise<ResolvedCapiEvent>;
  liveEnabled(): boolean;
  createMock(): CapiDriver;
  createReal(resolved: ResolvedCapiEvent): Promise<CapiDriver>;
  dispatch(driver: CapiDriver, event: CapiEvent): Promise<CapiProviderReceipt>;
  finish(input: FinishInput): Promise<boolean>;
  now(): Date;
};

class CapiWorkerContractError extends Error {
  readonly retryable = false;
  constructor(readonly code: string) {
    super(code);
    this.name = "CapiWorkerContractError";
  }
}

function row(value: Record<string, unknown>): ClaimedCapiEvent {
  const channel = value.channel;
  const eventName = value.event_name;
  if (
    typeof value.event_id !== "string" || typeof value.tenant_id !== "string" ||
    typeof value.conversation_id !== "string" ||
    (value.dataset_row_id !== null && typeof value.dataset_row_id !== "string") ||
    !["messenger", "instagram", "whatsapp"].includes(String(channel)) ||
    !["QualifiedLead", "Purchase"].includes(String(eventName)) ||
    typeof value.event_time !== "string" || typeof value.is_test !== "boolean" ||
    typeof value.is_demo !== "boolean" || typeof value.attempt_number !== "number" ||
    typeof value.max_attempts !== "number" || typeof value.claim_token !== "string"
  ) throw new CapiWorkerContractError("CAPI_CLAIM_ROW_INVALID");
  return {
    eventId: value.event_id,
    tenantId: value.tenant_id,
    conversationId: value.conversation_id,
    datasetRowId: value.dataset_row_id as string | null,
    channel: channel as ClaimedCapiEvent["channel"],
    eventName: eventName as ClaimedCapiEvent["eventName"],
    eventTime: value.event_time,
    currency: typeof value.currency === "string" ? value.currency : null,
    value: typeof value.value === "number" ? value.value : value.value === null ? null : Number(value.value),
    isTest: value.is_test,
    isDemo: value.is_demo,
    attemptNumber: value.attempt_number,
    maxAttempts: value.max_attempts,
    claimToken: value.claim_token,
  };
}

function stableFailure(error: unknown) {
  if (error instanceof CapiProviderError) {
    return { code: error.code, status: error.status, retryable: error.retryable };
  }
  if (error instanceof CapiContractError || error instanceof CapiWorkerContractError) {
    return { code: error.code, status: null, retryable: false };
  }
  return { code: "CAPI_EVENT_DISPATCH_FAILED", status: null, retryable: false };
}

function retryAt(attemptNumber: number, now: Date) {
  const delay = Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attemptNumber - 1));
  return new Date(now.valueOf() + delay).toISOString();
}

export async function dispatchCapiEvents(
  limit: number,
  dependencies: CapiWorkerDependencies = liveDependencies(),
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new CapiWorkerContractError("CAPI_WORKER_LIMIT_INVALID");
  }
  const claimedAt = dependencies.now();
  const events = await dependencies.claim(limit, claimedAt.toISOString());
  let sent = 0;
  let mockSent = 0;
  let excluded = 0;
  let retried = 0;
  let terminalFailed = 0;

  for (const event of events) {
    const finishedAt = dependencies.now();
    if (event.isTest || event.isDemo) {
      const finished = await dependencies.finish({
        eventId: event.eventId,
        claimToken: event.claimToken,
        status: "excluded_test",
        providerMode: "none",
        providerReceipt: { exclusion: "test_or_demo" },
        error: null,
        retryAt: null,
        now: finishedAt.toISOString(),
      });
      if (!finished) throw new CapiWorkerContractError("CAPI_EVENT_LEASE_LOST");
      excluded += 1;
      continue;
    }

    let providerMode: "none" | "mock" | "real" = "none";
    try {
      const resolved = await dependencies.resolve(event);
      const driver = dependencies.liveEnabled()
        ? await dependencies.createReal(resolved)
        : dependencies.createMock();
      providerMode = driver.mode;
      const receipt = await dependencies.dispatch(driver, resolved.event);
      const status = driver.mode === "real" ? "sent" : "mock_sent";
      const finished = await dependencies.finish({
        eventId: event.eventId,
        claimToken: event.claimToken,
        status,
        providerMode: driver.mode,
        providerReceipt: receipt,
        error: null,
        retryAt: null,
        now: finishedAt.toISOString(),
      });
      if (!finished) throw new CapiWorkerContractError("CAPI_EVENT_LEASE_LOST");
      if (status === "sent") sent += 1;
      else mockSent += 1;
    } catch (error) {
      const failure = stableFailure(error);
      const exhausted = event.attemptNumber >= event.maxAttempts;
      const shouldRetry = failure.retryable && !exhausted;
      const status = shouldRetry ? "retry" : "terminal_failed";
      const code = exhausted && failure.retryable
        ? `CAPI_ATTEMPT_BUDGET_EXHAUSTED:${failure.code}`
        : failure.code;
      const finished = await dependencies.finish({
        eventId: event.eventId,
        claimToken: event.claimToken,
        status,
        providerMode,
        providerReceipt: { failure },
        error: code,
        retryAt: shouldRetry ? retryAt(event.attemptNumber, finishedAt) : null,
        now: finishedAt.toISOString(),
      });
      if (!finished) throw new CapiWorkerContractError("CAPI_EVENT_LEASE_LOST");
      if (shouldRetry) retried += 1;
      else terminalFailed += 1;
    }
  }
  return { claimed: events.length, sent, mockSent, excluded, retried, terminalFailed };
}

function liveDependencies(): CapiWorkerDependencies {
  const client = createSupabaseServiceClient();
  return {
    claim: async (limit, now) => {
      const { data, error } = await client.rpc("claim_capi_events", { p_limit: limit, p_now: now });
      if (error || !Array.isArray(data)) throw new Error("CAPI_EVENT_CLAIM_FAILED");
      return data.map((value) => row(value as Record<string, unknown>));
    },
    resolve: async (event) => {
      const lookup = capiDatasetLookup(event);
      let datasetQuery = client.from("capi_datasets")
        .select("id,tenant_id,channel,channel_connection_id,source_asset_id,dataset_id,status")
        .eq("tenant_id", lookup.tenantId);
      datasetQuery = lookup.datasetRowId
        ? datasetQuery.eq("id", lookup.datasetRowId)
        : datasetQuery.eq("channel", event.channel).eq("status", "connected");
      const [datasetResult, conversationResult, tenantResult] = await Promise.all([
        datasetQuery.maybeSingle(),
        client.from("conversations")
          .select("id,tenant_id,contact_id,channel,ctwa_clid,is_test")
          .eq("id", event.conversationId).eq("tenant_id", event.tenantId).single(),
        client.from("tenants").select("id,is_demo").eq("id", event.tenantId).single(),
      ]);
      const dataset = datasetResult.data;
      const conversation = conversationResult.data;
      if (datasetResult.error || !dataset || dataset.status !== "connected" || !dataset.dataset_id) {
        throw new CapiWorkerContractError("CAPI_DATASET_NOT_CONNECTED");
      }
      if (conversationResult.error || !conversation || conversation.channel !== event.channel ||
        tenantResult.error || !tenantResult.data) {
        throw new CapiWorkerContractError("CAPI_EVENT_SCOPE_INVALID");
      }
      if (conversation.is_test || tenantResult.data.is_demo) {
        throw new CapiWorkerContractError("CAPI_EXCLUSION_INHERITANCE_MISMATCH");
      }
      const { data: identity, error: identityError } = await client.from("contact_identities")
        .select("provider_identity_id")
        .eq("tenant_id", event.tenantId).eq("contact_id", conversation.contact_id)
        .eq("provider", "meta_direct").eq("channel", event.channel).maybeSingle();
      if (identityError || !identity?.provider_identity_id) {
        throw new CapiWorkerContractError("CAPI_USER_IDENTITY_MISSING");
      }
      let userIdentity: CapiUserIdentity;
      if (event.channel === "messenger") {
        userIdentity = {
          channel: "messenger", pageId: dataset.source_asset_id,
          pageScopedUserId: identity.provider_identity_id,
        };
      } else if (event.channel === "instagram") {
        userIdentity = {
          channel: "instagram", instagramBusinessAccountId: dataset.source_asset_id,
          igSid: identity.provider_identity_id,
        };
      } else {
        if (!conversation.ctwa_clid) throw new CapiWorkerContractError("CAPI_CTWA_CLID_REQUIRED");
        userIdentity = {
          channel: "whatsapp", whatsappBusinessAccountId: dataset.source_asset_id,
          ctwaClid: conversation.ctwa_clid,
        };
      }
      return {
        connectionId: dataset.channel_connection_id,
        event: {
          datasetId: dataset.dataset_id,
          eventName: event.eventName,
          eventTime: event.eventTime,
          identity: userIdentity,
          currency: event.currency,
          value: event.value,
        },
      };
    },
    liveEnabled: () => capiLive(),
    createMock: createMockCapiDriver,
    createReal: async (resolved) => {
      const { data, error } = await client.from("channel_connection_secrets")
        .select("credential_envelope")
        .eq("channel_connection_id", resolved.connectionId).single();
      if (error || !data?.credential_envelope) {
        throw new CapiWorkerContractError("CAPI_CREDENTIAL_UNAVAILABLE");
      }
      return createRealCapiDriver({ accessToken: decryptCredential(data.credential_envelope) });
    },
    dispatch: (driver, event) => driver.dispatchEvent(event),
    finish: async (input) => {
      const { data, error } = await client.rpc("finish_capi_event", {
        p_event_id: input.eventId,
        p_claim_token: input.claimToken,
        p_status: input.status,
        p_provider_mode: input.providerMode,
        p_provider_receipt: input.providerReceipt,
        p_error: input.error,
        p_retry_at: input.retryAt,
        p_now: input.now,
      });
      if (error || typeof data !== "boolean") throw new Error("CAPI_EVENT_FINISH_FAILED");
      return data;
    },
    now: () => new Date(),
  };
}
