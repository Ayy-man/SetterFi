import { createHash } from "node:crypto";

import { CAPI_DATASET_AUDIT_ACTION } from "@/lib/audit/actions";
import { capiLive } from "@/lib/env-contract";
import { decryptCredential } from "@/lib/integrations/credential-envelope";
import {
  type CapiDatasetChannel,
  type CapiDatasetSnapshot,
} from "@/lib/repositories/capi-datasets";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type ConnectionRow = {
  id: string;
  tenantId: string;
  channel: CapiDatasetChannel;
  provider: string;
  state: string;
  externalAccountId: string | null;
  externalRef: Record<string, unknown>;
};

export type CapiDatasetReceipt = {
  provider: "meta";
  mode: "mock" | "real";
  operation: "get_or_create";
  receiptId: string;
  accepted: true;
};

export type CapiDatasetDriver = {
  mode: "mock" | "real";
  getOrCreate(input: {
    channel: CapiDatasetChannel;
    sourceAssetId: string;
  }): Promise<{ datasetId: string; receipt: CapiDatasetReceipt }>;
};

export type CapiDatasetAuditReceipt = {
  auditId: string;
  actionKey: typeof CAPI_DATASET_AUDIT_ACTION.key;
  label: string;
  ariaLabel: string;
};

export type ProvisionedCapiDataset = {
  dataset: CapiDatasetSnapshot;
  audit: CapiDatasetAuditReceipt;
  providerCalled: boolean;
};

export type CapiDatasetDependencies = {
  loadConnections(input: {
    tenantId: string;
    channel: CapiDatasetChannel;
  }): Promise<readonly ConnectionRow[]>;
  loadCredentialEnvelope(connectionId: string): Promise<unknown | null>;
  loadDataset(input: {
    tenantId: string;
    channel: CapiDatasetChannel;
  }): Promise<CapiDatasetSnapshot | null>;
  persist(input: {
    tenantId: string;
    actorId: string;
    channel: CapiDatasetChannel;
    connectionId: string;
    sourceAssetId: string;
    datasetId: string;
    receipt: CapiDatasetReceipt;
    isMock: boolean;
    now: string;
  }): Promise<{ dataset: CapiDatasetSnapshot; audit: CapiDatasetAuditReceipt }>;
  decrypt(value: unknown): string;
  liveEnabled(): boolean;
  createMock(): CapiDatasetDriver;
  createReal(accessToken: string): CapiDatasetDriver;
  now(): Date;
};

export class CapiDatasetError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CapiDatasetError";
  }
}

function required(value: string, code: string) {
  const normalized = value.trim();
  if (!normalized) throw new CapiDatasetError(code);
  return normalized;
}

function sourceAssetId(connection: ConnectionRow) {
  if (connection.channel !== "whatsapp") {
    return required(connection.externalAccountId ?? "", "CAPI_SOURCE_ASSET_ID_REQUIRED");
  }
  const wabaId = connection.externalRef.waba_id ?? connection.externalRef.wabaId;
  return required(typeof wabaId === "string" ? wabaId : "", "CAPI_WABA_ID_REQUIRED");
}

function eligibleConnection(
  rows: readonly ConnectionRow[],
  tenantId: string,
  channel: CapiDatasetChannel,
) {
  const scoped = rows.filter((row) =>
    row.tenantId === tenantId && row.channel === channel &&
    row.provider === "meta_direct" && ["ready", "live"].includes(row.state)
  );
  if (scoped.length === 0) throw new CapiDatasetError("CAPI_CONNECTION_UNAVAILABLE");
  if (scoped.length !== 1) throw new CapiDatasetError("CAPI_CONNECTION_AMBIGUOUS");
  return scoped[0];
}

function validStoredReceipt(dataset: CapiDatasetSnapshot) {
  const receipt = dataset.providerReceipt;
  return dataset.status === "connected" && Boolean(dataset.datasetId) &&
    receipt.provider === "meta" && receipt.operation === "get_or_create" &&
    (receipt.mode === "mock" || receipt.mode === "real") && receipt.accepted === true &&
    typeof receipt.receiptId === "string" && Boolean(receipt.receiptId.trim()) &&
    dataset.isMock === (receipt.mode === "mock");
}

export function createMockCapiDatasetDriver(): CapiDatasetDriver {
  return {
    mode: "mock",
    async getOrCreate(input) {
      const canonical = `${input.channel}:${required(input.sourceAssetId, "CAPI_SOURCE_ASSET_ID_REQUIRED")}`;
      const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 20);
      return {
        datasetId: `mock-dataset-${digest}`,
        receipt: {
          provider: "meta",
          mode: "mock",
          operation: "get_or_create",
          receiptId: `mock-dataset-receipt-${digest}`,
          accepted: true,
        },
      };
    },
  };
}

export function createRealCapiDatasetDriver(
  accessToken: string,
  dependencies: { fetch?: typeof fetch } = {},
): CapiDatasetDriver {
  const token = required(accessToken, "CAPI_ACCESS_TOKEN_REQUIRED");
  const fetcher = dependencies.fetch ?? fetch;
  return {
    mode: "real",
    async getOrCreate(input) {
      const assetId = required(input.sourceAssetId, "CAPI_SOURCE_ASSET_ID_REQUIRED");
      let response: Response;
      try {
        response = await fetcher(
          `https://graph.facebook.com/${encodeURIComponent(assetId)}/dataset`,
          { method: "POST", headers: { Authorization: `Bearer ${token}` } },
        );
      } catch {
        throw new CapiDatasetError("CAPI_DATASET_PROVIDER_NETWORK_FAILED");
      }
      if (!response.ok) throw new CapiDatasetError("CAPI_DATASET_PROVIDER_REQUEST_FAILED");
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new CapiDatasetError("CAPI_DATASET_PROVIDER_RECEIPT_INVALID");
      }
      const datasetId = body && typeof body === "object" && !Array.isArray(body)
        ? (body as { id?: unknown }).id
        : null;
      if (typeof datasetId !== "string" || !datasetId.trim()) {
        throw new CapiDatasetError("CAPI_DATASET_PROVIDER_RECEIPT_INVALID");
      }
      return {
        datasetId: datasetId.trim(),
        receipt: {
          provider: "meta",
          mode: "real",
          operation: "get_or_create",
          receiptId: response.headers.get("x-fb-trace-id")?.slice(0, 200) || "meta-dataset-accepted",
          accepted: true,
        },
      };
    },
  };
}

function row(value: Record<string, unknown>): CapiDatasetSnapshot {
  const providerReceipt = value.provider_receipt;
  if (
    typeof value.dataset_row_id !== "string" || typeof value.tenant_id !== "string" ||
    !["messenger", "instagram", "whatsapp"].includes(String(value.channel)) ||
    typeof value.channel_connection_id !== "string" || typeof value.source_asset_id !== "string" ||
    typeof value.dataset_id !== "string" || value.status !== "connected" ||
    !providerReceipt || typeof providerReceipt !== "object" || Array.isArray(providerReceipt) ||
    typeof value.is_mock !== "boolean" || typeof value.provisioned_at !== "string" ||
    typeof value.updated_at !== "string"
  ) throw new CapiDatasetError("CAPI_DATASET_WRITE_READBACK_INVALID");
  return {
    id: value.dataset_row_id,
    tenantId: value.tenant_id,
    channel: value.channel as CapiDatasetChannel,
    channelConnectionId: value.channel_connection_id,
    sourceAssetId: value.source_asset_id,
    datasetId: value.dataset_id,
    status: "connected",
    providerReceipt: providerReceipt as Record<string, unknown>,
    isMock: value.is_mock,
    lastError: null,
    provisionedAt: value.provisioned_at,
    updatedAt: value.updated_at,
  };
}

function liveDependencies(): CapiDatasetDependencies {
  const client = createSupabaseServiceClient();
  return {
    loadConnections: async ({ tenantId, channel }) => {
      const { data, error } = await client.from("channel_connections")
        .select("id,tenant_id,channel,provider,state,external_account_id,external_ref")
        .eq("tenant_id", tenantId).eq("channel", channel);
      if (error) throw new CapiDatasetError("CAPI_CONNECTION_LOOKUP_FAILED");
      return (data ?? []).map((connection) => ({
        id: connection.id,
        tenantId: connection.tenant_id,
        channel: connection.channel as CapiDatasetChannel,
        provider: connection.provider,
        state: connection.state,
        externalAccountId: connection.external_account_id,
        externalRef: connection.external_ref && typeof connection.external_ref === "object" &&
          !Array.isArray(connection.external_ref)
          ? connection.external_ref as Record<string, unknown>
          : {},
      }));
    },
    loadCredentialEnvelope: async (connectionId) => {
      const { data, error } = await client.from("channel_connection_secrets")
        .select("credential_envelope").eq("channel_connection_id", connectionId).maybeSingle();
      if (error) throw new CapiDatasetError("CAPI_CREDENTIAL_LOOKUP_FAILED");
      return data?.credential_envelope ?? null;
    },
    loadDataset: async ({ tenantId, channel }) => {
      const { data, error } = await client.from("capi_datasets")
        .select("id,tenant_id,channel,channel_connection_id,source_asset_id,dataset_id,status,provider_receipt,is_mock,last_error,provisioned_at,updated_at")
        .eq("tenant_id", tenantId).eq("channel", channel).maybeSingle();
      if (error) throw new CapiDatasetError("CAPI_DATASET_LOOKUP_FAILED");
      if (!data) return null;
      return {
        id: data.id,
        tenantId: data.tenant_id,
        channel: data.channel as CapiDatasetChannel,
        channelConnectionId: data.channel_connection_id,
        sourceAssetId: data.source_asset_id,
        datasetId: data.dataset_id,
        status: data.status as CapiDatasetSnapshot["status"],
        providerReceipt: data.provider_receipt as Record<string, unknown>,
        isMock: data.is_mock,
        lastError: data.last_error,
        provisionedAt: data.provisioned_at,
        updatedAt: data.updated_at,
      };
    },
    persist: async (input) => {
      const { data, error } = await client.rpc("provision_capi_dataset", {
        p_expected_tenant: input.tenantId,
        p_actor_id: input.actorId,
        p_channel: input.channel,
        p_channel_connection_id: input.connectionId,
        p_source_asset_id: input.sourceAssetId,
        p_dataset_id: input.datasetId,
        p_provider_receipt: input.receipt,
        p_is_mock: input.isMock,
        p_now: input.now,
      });
      const result = Array.isArray(data) ? data[0] : data;
      if (error || !result || typeof result !== "object") {
        throw new CapiDatasetError("CAPI_DATASET_WRITE_FAILED");
      }
      const values = result as Record<string, unknown>;
      const dataset = row(values);
      const auditId = values.audit_id;
      if ((typeof auditId !== "number" && typeof auditId !== "string") || !String(auditId)) {
        throw new CapiDatasetError("CAPI_DATASET_AUDIT_READBACK_INVALID");
      }
      const { data: audit, error: auditError } = await client.from("audit_log")
        .select("id,tenant_id,action").eq("id", auditId).single();
      const { data: action, error: actionError } = await client.from("audit_actions")
        .select("key,microcopy,aria_label").eq("key", CAPI_DATASET_AUDIT_ACTION.key).single();
      if (
        auditError || actionError || !audit || !action || audit.tenant_id !== input.tenantId ||
        audit.action !== CAPI_DATASET_AUDIT_ACTION.key || action.key !== CAPI_DATASET_AUDIT_ACTION.key ||
        action.microcopy !== CAPI_DATASET_AUDIT_ACTION.microcopy ||
        action.aria_label !== CAPI_DATASET_AUDIT_ACTION.ariaLabel
      ) throw new CapiDatasetError("CAPI_DATASET_AUDIT_READBACK_INVALID");
      return {
        dataset,
        audit: {
          auditId: String(audit.id),
          actionKey: CAPI_DATASET_AUDIT_ACTION.key,
          label: action.microcopy,
          ariaLabel: action.aria_label,
        },
      };
    },
    decrypt: decryptCredential,
    liveEnabled: capiLive,
    createMock: createMockCapiDatasetDriver,
    createReal: (token) => createRealCapiDatasetDriver(token),
    now: () => new Date(),
  };
}

export async function provisionCapiDataset(
  tenantId: string,
  input: { actorId: string; channel: CapiDatasetChannel },
  dependencies: CapiDatasetDependencies = liveDependencies(),
): Promise<ProvisionedCapiDataset> {
  const expectedTenant = required(tenantId, "EXPECTED_TENANT_REQUIRED");
  const actorId = required(input.actorId, "ACTOR_ID_REQUIRED");
  const connection = eligibleConnection(
    await dependencies.loadConnections({ tenantId: expectedTenant, channel: input.channel }),
    expectedTenant,
    input.channel,
  );
  const assetId = sourceAssetId(connection);
  const existing = await dependencies.loadDataset({ tenantId: expectedTenant, channel: input.channel });
  if (existing && (
    existing.tenantId !== expectedTenant || existing.channel !== input.channel ||
    existing.channelConnectionId !== connection.id || existing.sourceAssetId !== assetId
  )) throw new CapiDatasetError("CAPI_DATASET_ASSET_MISMATCH");

  let providerCalled = false;
  let provisioned: { datasetId: string; receipt: CapiDatasetReceipt };
  if (existing && validStoredReceipt(existing) && (!dependencies.liveEnabled() || !existing.isMock)) {
    provisioned = {
      datasetId: required(existing.datasetId ?? "", "CAPI_DATASET_ID_REQUIRED"),
      receipt: existing.providerReceipt as CapiDatasetReceipt,
    };
  } else {
    let driver: CapiDatasetDriver;
    if (dependencies.liveEnabled()) {
      const envelope = await dependencies.loadCredentialEnvelope(connection.id);
      if (!envelope) throw new CapiDatasetError("CAPI_CREDENTIAL_UNAVAILABLE");
      driver = dependencies.createReal(dependencies.decrypt(envelope));
    } else {
      driver = dependencies.createMock();
    }
    providerCalled = true;
    provisioned = await driver.getOrCreate({ channel: input.channel, sourceAssetId: assetId });
    if (provisioned.receipt.mode !== driver.mode) {
      throw new CapiDatasetError("CAPI_DATASET_PROVIDER_MODE_MISMATCH");
    }
  }
  const persisted = await dependencies.persist({
    tenantId: expectedTenant,
    actorId,
    channel: input.channel,
    connectionId: connection.id,
    sourceAssetId: assetId,
    datasetId: provisioned.datasetId,
    receipt: provisioned.receipt,
    isMock: provisioned.receipt.mode === "mock",
    now: dependencies.now().toISOString(),
  });
  if (
    persisted.dataset.tenantId !== expectedTenant || persisted.dataset.channel !== input.channel ||
    persisted.dataset.channelConnectionId !== connection.id ||
    persisted.dataset.sourceAssetId !== assetId || persisted.dataset.datasetId !== provisioned.datasetId ||
    persisted.dataset.isMock !== (provisioned.receipt.mode === "mock")
  ) throw new CapiDatasetError("CAPI_DATASET_WRITE_READBACK_INVALID");
  return { ...persisted, providerCalled };
}
