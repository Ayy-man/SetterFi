import { describe, expect, it, vi } from "vitest";

import {
  createCapiDatasetHandler,
  type CapiDatasetRouteDependencies,
} from "@/app/api/channels/capi/datasets/handler";
import { NO_CLAIMS } from "@/lib/auth/claims";
import { CAPI_DATASET_AUDIT_ACTION } from "@/lib/audit/actions";
import type { RouteActor } from "@/lib/auth/actors";

const coach: RouteActor = {
  ...NO_CLAIMS,
  userId: "actor-1",
  tenantId: "tenant-1",
  role: "coach",
};

function request(body: unknown) {
  return new Request("https://setterfi.test/api/channels/capi/datasets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function dependencies(actor: RouteActor | null = coach): CapiDatasetRouteDependencies {
  return {
    enabled: () => true,
    session: async () => actor,
    provision: vi.fn(async ({ tenantId, channel }) => ({
      dataset: {
        id: "dataset-row-1",
        tenantId,
        channel,
        channelConnectionId: "connection-1",
        sourceAssetId: "page-1",
        datasetId: "dataset-1",
        status: "connected" as const,
        providerReceipt: {
          provider: "meta", mode: "real", operation: "get_or_create",
          receiptId: "trace-1", accepted: true,
        },
        isMock: false,
        lastError: null,
        provisionedAt: "2026-09-01T10:00:00.000Z",
        updatedAt: "2026-09-01T10:00:00.000Z",
      },
      audit: {
        auditId: "91",
        actionKey: CAPI_DATASET_AUDIT_ACTION.key,
        label: CAPI_DATASET_AUDIT_ACTION.microcopy,
        ariaLabel: CAPI_DATASET_AUDIT_ACTION.ariaLabel,
      },
      providerCalled: true,
    })),
  };
}

describe("CAPI dataset setup route", () => {
  it("returns only receipt-backed setup state and the persisted audit read-back", async () => {
    const deps = dependencies();
    const response = await createCapiDatasetHandler(deps)(request({ channel: "messenger" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      dataset: {
        channel: "messenger",
        status: "connected",
        isMock: false,
        provisionedAt: "2026-09-01T10:00:00.000Z",
      },
      audit: {
        auditId: "91",
        actionKey: "capi.dataset.provisioned",
        label: "Conversion tracking setup logged",
        ariaLabel: "Conversion tracking dataset setup recorded in the audit log",
      },
    });
    expect(deps.provision).toHaveBeenCalledWith({
      tenantId: "tenant-1", actorId: "actor-1", channel: "messenger",
    });
    expect(JSON.stringify(await (await createCapiDatasetHandler(deps)(request({ channel: "messenger" }))).json()))
      .not.toMatch(/token|secret|credential|datasetId|sourceAssetId/i);
  });

  it("rejects unauthenticated, non-coach, and impersonated sessions before provisioning", async () => {
    const unauthenticated = dependencies(null);
    expect((await createCapiDatasetHandler(unauthenticated)(request({ channel: "instagram" }))).status)
      .toBe(401);
    expect(unauthenticated.provision).not.toHaveBeenCalled();

    const admin = dependencies({ ...coach, role: "admin" });
    expect((await createCapiDatasetHandler(admin)(request({ channel: "instagram" }))).status)
      .toBe(403);
    expect(admin.provision).not.toHaveBeenCalled();

    const impersonated = dependencies({ ...coach, impersonatingTenant: "tenant-1" });
    expect((await createCapiDatasetHandler(impersonated)(request({ channel: "instagram" }))).status)
      .toBe(403);
    expect(impersonated.provision).not.toHaveBeenCalled();
  });

  it("accepts only one fixed channel key and stays hidden when the phase is off", async () => {
    const deps = dependencies();
    expect((await createCapiDatasetHandler(deps)(request({ channel: "sms" }))).status).toBe(400);
    expect((await createCapiDatasetHandler(deps)(request({ channel: "messenger", extra: true }))).status)
      .toBe(400);
    expect(deps.provision).not.toHaveBeenCalled();

    deps.enabled = () => false;
    expect((await createCapiDatasetHandler(deps)(request({ channel: "messenger" }))).status).toBe(404);
  });
});
