import { describe, expect, it, vi } from "vitest";

import { CAPI_DATASET_AUDIT_ACTION } from "@/lib/audit/actions";
import {
  CapiDatasetError,
  createRealCapiDatasetDriver,
  provisionCapiDataset,
  type CapiDatasetDependencies,
  type CapiDatasetReceipt,
} from "@/lib/capi/datasets";
import type { CapiDatasetChannel, CapiDatasetSnapshot } from "@/lib/repositories/capi-datasets";

function connectedDataset(
  channel: CapiDatasetChannel,
  overrides: Partial<CapiDatasetSnapshot> = {},
): CapiDatasetSnapshot {
  return {
    id: `dataset-row-${channel}`,
    tenantId: "tenant-1",
    channel,
    channelConnectionId: `connection-${channel}`,
    sourceAssetId: channel === "whatsapp" ? "waba-1" : `asset-${channel}`,
    datasetId: `dataset-${channel}`,
    status: "connected",
    providerReceipt: {
      provider: "meta",
      mode: "real",
      operation: "get_or_create",
      receiptId: `receipt-${channel}`,
      accepted: true,
    },
    isMock: false,
    lastError: null,
    provisionedAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

function harness(channel: CapiDatasetChannel, liveEnabled = false) {
  let stored: CapiDatasetSnapshot | null = null;
  const providerReceipt: CapiDatasetReceipt = {
    provider: "meta",
    mode: liveEnabled ? "real" : "mock",
    operation: "get_or_create",
    receiptId: `${liveEnabled ? "real" : "mock"}-receipt`,
    accepted: true,
  };
  const getOrCreate = vi.fn(async ({ sourceAssetId }: { sourceAssetId: string }) => ({
    datasetId: `${liveEnabled ? "real" : "mock"}-dataset-${sourceAssetId}`,
    receipt: providerReceipt,
  }));
  const persist = vi.fn(async (input: Parameters<CapiDatasetDependencies["persist"]>[0]) => {
    stored = connectedDataset(channel, {
      datasetId: input.datasetId,
      providerReceipt: input.receipt,
      isMock: input.isMock,
      provisionedAt: input.now,
      updatedAt: input.now,
    });
    return {
      dataset: stored,
      audit: {
        auditId: "91",
        actionKey: CAPI_DATASET_AUDIT_ACTION.key,
        label: CAPI_DATASET_AUDIT_ACTION.microcopy,
        ariaLabel: CAPI_DATASET_AUDIT_ACTION.ariaLabel,
      },
    };
  });
  const dependencies: CapiDatasetDependencies = {
    loadConnections: vi.fn(async () => [{
      id: `connection-${channel}`,
      tenantId: "tenant-1",
      channel,
      provider: "meta_direct",
      state: "ready",
      externalAccountId: channel === "whatsapp" ? "phone-1" : `asset-${channel}`,
      externalRef: channel === "whatsapp" ? { waba_id: "waba-1" } : {},
    }]),
    loadCredentialEnvelope: vi.fn(async () => ({ ciphertext: "sealed" })),
    loadDataset: vi.fn(async () => stored),
    persist,
    decrypt: vi.fn(() => "decrypted-token"),
    liveEnabled: () => liveEnabled,
    createMock: () => ({ mode: "mock", getOrCreate }),
    createReal: vi.fn(() => ({ mode: "real" as const, getOrCreate })),
    now: () => new Date("2026-09-01T10:00:00.000Z"),
  };
  return { dependencies, getOrCreate, persist, stored: () => stored, setStored: (row: CapiDatasetSnapshot) => { stored = row; } };
}

describe("CAPI dataset provisioning", () => {
  it.each([
    ["messenger", "asset-messenger"],
    ["instagram", "asset-instagram"],
    ["whatsapp", "waba-1"],
  ] as const)("uses the connected %s business asset without exposing credential custody", async (channel, assetId) => {
    const h = harness(channel, true);
    const result = await provisionCapiDataset("tenant-1", { actorId: "actor-1", channel }, h.dependencies);

    expect(h.getOrCreate).toHaveBeenCalledWith({ channel, sourceAssetId: assetId });
    expect(h.dependencies.loadCredentialEnvelope).toHaveBeenCalledWith(`connection-${channel}`);
    expect(h.dependencies.decrypt).toHaveBeenCalledWith({ ciphertext: "sealed" });
    expect(result.dataset).toMatchObject({ sourceAssetId: assetId, isMock: false, status: "connected" });
    expect(result.audit).toEqual({
      auditId: "91",
      actionKey: "capi.dataset.provisioned",
      label: "Conversion tracking setup logged",
      ariaLabel: "Conversion tracking dataset setup recorded in the audit log",
    });
    expect(JSON.stringify(result)).not.toContain("decrypted-token");
  });

  it("reuses a stored real dataset without a second provider call but records the human action", async () => {
    const h = harness("messenger", true);
    h.setStored(connectedDataset("messenger"));

    const result = await provisionCapiDataset(
      "tenant-1", { actorId: "actor-1", channel: "messenger" }, h.dependencies,
    );

    expect(result.providerCalled).toBe(false);
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(h.persist).toHaveBeenCalledOnce();
  });

  it("upgrades a mock receipt through the real driver instead of presenting it as connected", async () => {
    const h = harness("instagram", true);
    h.setStored(connectedDataset("instagram", {
      datasetId: "mock-dataset-old",
      isMock: true,
      providerReceipt: {
        provider: "meta", mode: "mock", operation: "get_or_create",
        receiptId: "mock-receipt-old", accepted: true,
      },
    }));

    const result = await provisionCapiDataset(
      "tenant-1", { actorId: "actor-1", channel: "instagram" }, h.dependencies,
    );

    expect(result.providerCalled).toBe(true);
    expect(result.dataset.isMock).toBe(false);
    expect(result.dataset.providerReceipt.mode).toBe("real");
  });

  it("selects the mock arm without loading or decrypting credentials when the live flag is off", async () => {
    const h = harness("whatsapp", false);
    const result = await provisionCapiDataset(
      "tenant-1", { actorId: "actor-1", channel: "whatsapp" }, h.dependencies,
    );

    expect(result.dataset.isMock).toBe(true);
    expect(result.dataset.providerReceipt.mode).toBe("mock");
    expect(h.dependencies.loadCredentialEnvelope).not.toHaveBeenCalled();
    expect(h.dependencies.decrypt).not.toHaveBeenCalled();
  });

  it("fails closed on ambiguous, cross-tenant, changed-asset, and missing-custody inputs", async () => {
    const ambiguous = harness("messenger", true);
    vi.mocked(ambiguous.dependencies.loadConnections).mockResolvedValue([
      ...await ambiguous.dependencies.loadConnections({ tenantId: "tenant-1", channel: "messenger" }),
      {
        id: "connection-other", tenantId: "tenant-1", channel: "messenger",
        provider: "meta_direct", state: "live", externalAccountId: "asset-other", externalRef: {},
      },
    ]);
    await expect(provisionCapiDataset(
      "tenant-1", { actorId: "actor-1", channel: "messenger" }, ambiguous.dependencies,
    )).rejects.toMatchObject({ code: "CAPI_CONNECTION_AMBIGUOUS" });

    const crossTenant = harness("messenger", true);
    vi.mocked(crossTenant.dependencies.loadConnections).mockResolvedValue([{
      id: "connection-messenger", tenantId: "tenant-2", channel: "messenger",
      provider: "meta_direct", state: "ready", externalAccountId: "asset-messenger", externalRef: {},
    }]);
    await expect(provisionCapiDataset(
      "tenant-1", { actorId: "actor-1", channel: "messenger" }, crossTenant.dependencies,
    )).rejects.toMatchObject({ code: "CAPI_CONNECTION_UNAVAILABLE" });

    const changed = harness("messenger", true);
    changed.setStored(connectedDataset("messenger", { sourceAssetId: "another-page" }));
    await expect(provisionCapiDataset(
      "tenant-1", { actorId: "actor-1", channel: "messenger" }, changed.dependencies,
    )).rejects.toMatchObject({ code: "CAPI_DATASET_ASSET_MISMATCH" });

    const missing = harness("messenger", true);
    vi.mocked(missing.dependencies.loadCredentialEnvelope).mockResolvedValue(null);
    await expect(provisionCapiDataset(
      "tenant-1", { actorId: "actor-1", channel: "messenger" }, missing.dependencies,
    )).rejects.toMatchObject({ code: "CAPI_CREDENTIAL_UNAVAILABLE" });
  });

  it("uses the locked asset dataset endpoint and stores only safe response metadata", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "dataset-123", ignored: "raw" }), {
      status: 200,
      headers: { "x-fb-trace-id": "trace-123" },
    }));
    const driver = createRealCapiDatasetDriver("server-secret", { fetch: fetcher });
    const result = await driver.getOrCreate({ channel: "messenger", sourceAssetId: "page/123" });

    expect(fetcher).toHaveBeenCalledWith("https://graph.facebook.com/page%2F123/dataset", {
      method: "POST",
      headers: { Authorization: "Bearer server-secret" },
    });
    expect(result).toEqual({
      datasetId: "dataset-123",
      receipt: {
        provider: "meta", mode: "real", operation: "get_or_create",
        receiptId: "trace-123", accepted: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("server-secret");
    expect(JSON.stringify(result)).not.toContain("raw");
  });

  it("rejects a malformed successful provider body", async () => {
    const driver = createRealCapiDatasetDriver("server-secret", {
      fetch: async () => new Response(JSON.stringify({ success: true }), { status: 200 }),
    });
    await expect(driver.getOrCreate({ channel: "instagram", sourceAssetId: "ig-1" }))
      .rejects.toEqual(new CapiDatasetError("CAPI_DATASET_PROVIDER_RECEIPT_INVALID"));
  });
});
