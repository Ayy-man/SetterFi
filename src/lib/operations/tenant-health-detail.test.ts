import { describe, expect, it } from "vitest";

import {
  TenantHealthDetailError,
  loadTenantHealthDetail,
  type TenantHealthSignalKey,
} from "@/lib/operations/tenant-health-detail";

const tenantId = "tenant-a";
const now = new Date("2026-08-30T12:00:00.000Z");

function row(key: TenantHealthSignalKey, overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: tenantId,
    snapshot_day: "2026-08-30",
    overall_state: "healthy",
    signal_key: key,
    signal_state: "healthy",
    observed_value: { measured: key },
    threshold: { freshWithinHours: 24 },
    observed_at: "2026-08-30T11:00:00.000Z",
    stale_after_at: "2026-08-31T11:00:00.000Z",
    calculated_at: "2026-08-30T11:05:00.000Z",
    ...overrides,
  };
}

function rows(overrides: Partial<Record<TenantHealthSignalKey, Record<string, unknown>>> = {}) {
  return (["carrier", "channel", "provisioning", "subscription"] as const)
    .map((key) => row(key, overrides[key]));
}

describe("tenant health detail", () => {
  it("keeps a healthy tenant healthy only when every signal has current evidence", async () => {
    const detail = await loadTenantHealthDetail({
      expectedTenant: tenantId,
      actorId: "operator-a",
      source: { read: async () => rows() },
      now,
    });

    expect(detail.state).toBe("healthy");
    expect(detail.signals).toHaveLength(4);
    expect(detail.signals[0]).toMatchObject({
      key: "carrier", state: "healthy", freshness: "current",
      observedValue: { measured: "carrier" }, threshold: { freshWithinHours: 24 },
    });
  });

  it("makes missing and stale observations indeterminate instead of healthy", async () => {
    const detail = await loadTenantHealthDetail({
      expectedTenant: tenantId,
      actorId: "operator-a",
      source: {
        read: async () => rows({
          provisioning: { observed_value: null, observed_at: null, stale_after_at: null },
          subscription: {
            signal_state: "unhealthy",
            stale_after_at: "2026-08-30T11:59:59.000Z",
          },
        }),
      },
      now,
    });

    expect(detail.state).toBe("indeterminate");
    expect(detail.signals.find((signal) => signal.key === "provisioning")).toMatchObject({
      state: "indeterminate", freshness: "not-measured",
      reason: "No observation has been recorded for this signal.",
      action: {
        availability: "available", command: "nudge_onboarding",
        endpoint: "/api/platform/clients/tenant-a/commands",
      },
    });
    expect(detail.signals.find((signal) => signal.key === "subscription")).toMatchObject({
      state: "indeterminate", freshness: "stale",
      reason: "The latest observation is outside its expected window.",
    });
  });

  it("exposes an unhealthy current signal and does not offer a command that does not exist", async () => {
    const detail = await loadTenantHealthDetail({
      expectedTenant: tenantId,
      actorId: "operator-a",
      source: { read: async () => rows({ carrier: { signal_state: "unhealthy" } }) },
      now,
    });

    expect(detail.state).toBe("unhealthy");
    expect(detail.signals.find((signal) => signal.key === "carrier")).toMatchObject({
      state: "unhealthy", freshness: "current",
      action: {
        availability: "not-available", command: null, endpoint: null,
        reason: "No implemented client command directly addresses this signal.",
      },
    });
  });

  it("rejects malformed, duplicate, and cross-tenant projections before returning a state", async () => {
    await expect(loadTenantHealthDetail({
      expectedTenant: tenantId,
      actorId: "operator-a",
      source: { read: async () => [...rows().slice(0, 3), row("carrier")] },
      now,
    })).rejects.toMatchObject({ code: "INVALID_PROJECTION" } satisfies Partial<TenantHealthDetailError>);
    await expect(loadTenantHealthDetail({
      expectedTenant: tenantId,
      actorId: "operator-a",
      source: { read: async () => rows({ channel: { tenant_id: "tenant-b" } }) },
      now,
    })).rejects.toMatchObject({ code: "INVALID_PROJECTION" } satisfies Partial<TenantHealthDetailError>);
  });
});
