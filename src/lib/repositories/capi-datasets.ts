import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type CapiDatasetChannel = "messenger" | "instagram" | "whatsapp";

export type CapiDatasetSnapshot = {
  id: string;
  tenantId: string;
  channel: CapiDatasetChannel;
  channelConnectionId: string;
  sourceAssetId: string;
  datasetId: string | null;
  status: "not_set_up" | "provisioning" | "connected" | "failed";
  providerReceipt: Record<string, unknown>;
  isMock: boolean;
  lastError: string | null;
  provisionedAt: string | null;
  updatedAt: string;
};

type CapiDatasetRow = {
  id: string;
  tenant_id: string;
  channel: CapiDatasetChannel;
  channel_connection_id: string;
  source_asset_id: string;
  dataset_id: string | null;
  status: CapiDatasetSnapshot["status"];
  provider_receipt: unknown;
  is_mock: boolean;
  last_error: string | null;
  provisioned_at: string | null;
  updated_at: string;
};

export type CapiDatasetReadSource = (
  tenantId: string,
) => Promise<readonly CapiDatasetRow[]>;

function safeReceipt(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function snapshot(row: CapiDatasetRow): CapiDatasetSnapshot {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    channel: row.channel,
    channelConnectionId: row.channel_connection_id,
    sourceAssetId: row.source_asset_id,
    datasetId: row.dataset_id,
    status: row.status,
    providerReceipt: safeReceipt(row.provider_receipt),
    isMock: row.is_mock,
    lastError: row.last_error,
    provisionedAt: row.provisioned_at,
    updatedAt: row.updated_at,
  };
}

async function liveSource(tenantId: string): Promise<readonly CapiDatasetRow[]> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.from("capi_datasets")
    .select("id,tenant_id,channel,channel_connection_id,source_asset_id,dataset_id,status,provider_receipt,is_mock,last_error,provisioned_at,updated_at")
    .eq("tenant_id", tenantId)
    .order("channel", { ascending: true });
  if (error) throw new Error("CAPI_DATASET_READ_FAILED");
  return (data ?? []) as CapiDatasetRow[];
}

export async function listCapiDatasets(
  tenantId: string,
  source: CapiDatasetReadSource = liveSource,
): Promise<CapiDatasetSnapshot[]> {
  const expectedTenant = tenantId.trim();
  if (!expectedTenant) throw new Error("EXPECTED_TENANT_REQUIRED");
  const rows = await source(expectedTenant);
  if (rows.some((row) => row.tenant_id !== expectedTenant)) {
    throw new Error("CAPI_DATASET_TENANT_MISMATCH");
  }
  return rows.map(snapshot);
}
