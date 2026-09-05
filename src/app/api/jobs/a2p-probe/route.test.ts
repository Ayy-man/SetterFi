import { describe, expect, it, vi } from "vitest";

import { DriverConfigurationError } from "@/lib/env-contract";
import { createJobReceiptExecution, type JobReceiptExecution } from "@/lib/jobs/job-receipts";
import type { StepOutcome } from "@/lib/onboarding/contracts";

import { createA2pProbeHandler, type ProbeWorkItem } from "./handler";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const TARGET_HASH = "a".repeat(64);
function candidate(overrides: Partial<ProbeWorkItem> = {}): ProbeWorkItem {
  return {
    tenantId: "tenant-synthetic",
    state: "awaiting_provider",
    submittedAt: "2026-08-01T12:00:00.000Z",
    targetHash: TARGET_HASH,
    nextProbeAt: "2026-08-22T11:00:00.000Z",
    terminalReceiptAt: null,
    idempotencyKey: "tenant-synthetic:sms_live",
    isDemo: true,
    alreadyStalled: false,
    externalRef: {},
    ...overrides,
  };
}
function request(token = "synthetic-cron-secret") {
  return new Request("https://setterfi.test/api/jobs/a2p-probe", { headers: token ? { authorization: `Bearer ${token}` } : {} });
}
function dependencies(items: ProbeWorkItem[] = []) {
  return {
    enabled: () => true,
    secret: "synthetic-cron-secret",
    now: () => NOW,
    list: vi.fn().mockResolvedValue(items),
    loadReceipt: vi.fn().mockResolvedValue(null),
    probe: vi.fn().mockResolvedValue({ kind: "awaiting_provider", party: "carrier", externalRef: {} } satisfies StepOutcome),
    apply: vi.fn().mockResolvedValue(undefined),
    markStall: vi.fn().mockResolvedValue(true),
    rotate: vi.fn().mockResolvedValue(undefined),
  };
}

describe("GET /api/jobs/a2p-probe", () => {
  it("does no work when disabled or unauthorized", async () => {
    const disabled = dependencies([candidate()]);
    disabled.enabled = () => false;
    expect((await createA2pProbeHandler(disabled)(request())).status).toBe(404);
    expect(disabled.list).not.toHaveBeenCalled();

    const unauthorized = dependencies([candidate()]);
    expect((await createA2pProbeHandler(unauthorized)(request("wrong"))).status).toBe(401);
    expect(unauthorized.list).not.toHaveBeenCalled();
  });

  it("fails closed when the named cron secret is absent", async () => {
    const deps = dependencies();
    deps.secret = null as unknown as string;
    const response = await createA2pProbeHandler(deps)(request());
    expect(response.status).toBe(401);
    expect(deps.list).not.toHaveBeenCalled();
  });

  it("returns a zeroed safe summary for an empty batch", async () => {
    const response = await createA2pProbeHandler(dependencies())(request());
    await expect(response.json()).resolves.toEqual({ selected: 0, attempted: 0, delivered: 0, registering: 0, blocked: 0, failed: 0, stallsFlagged: 0, replayed: 0 });
  });

  it("returns 200 and records skipped when the provisioning driver is deliberately unavailable", async () => {
    const deps = dependencies();
    const finished: unknown[] = [];
    deps.list.mockRejectedValue(new DriverConfigurationError(
      "ghl_provisioning",
      ["SETTERFI_GHL_PROVISIONING_DRIVER"],
    ));
    const scheduledDeps = deps as typeof deps & { execute?: JobReceiptExecution };
    scheduledDeps.execute = createJobReceiptExecution({
      start: async () => ({ id: "receipt-1", started_at: NOW.toISOString() }),
      finish: async (input) => { finished.push(input); },
    });

    const response = await createA2pProbeHandler(scheduledDeps)(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ skipped: "driver_not_configured" });
    expect(finished).toEqual([expect.objectContaining({
      outcome: "skipped",
      errorDetail: "SETTERFI_GHL_PROVISIONING_DRIVER",
      counters: { skipped: "driver_not_configured", missing_variables: ["SETTERFI_GHL_PROVISIONING_DRIVER"] },
    })]);
  });

  it("handles mixed outcomes and continues after one tenant failure", async () => {
    const items = [
      candidate({ tenantId: "tenant-delivered" }),
      candidate({ tenantId: "tenant-registering", alreadyStalled: true }),
      candidate({ tenantId: "tenant-blocked", alreadyStalled: true }),
      candidate({ tenantId: "tenant-failed", alreadyStalled: true }),
    ];
    const deps = dependencies(items);
    deps.probe.mockImplementation(async (item: ProbeWorkItem): Promise<StepOutcome> => {
      if (item.tenantId === "tenant-delivered") return { kind: "done", externalRef: { receiptId: "receipt-1" } };
      if (item.tenantId === "tenant-blocked") return { kind: "blocked", code: "CARRIER_TERMINAL", safeMessage: "Synthetic permanent refusal." };
      if (item.tenantId === "tenant-failed") throw new Error("tenant-local failure");
      return { kind: "awaiting_provider", party: "carrier", externalRef: { receiptId: "receipt-2" } };
    });
    const response = await createA2pProbeHandler(deps)(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ selected: 4, attempted: 4, delivered: 1, registering: 1, blocked: 1, failed: 1, stallsFlagged: 1, replayed: 0 });
    expect(deps.apply).toHaveBeenCalledTimes(3);
    expect(deps.rotate).toHaveBeenCalledTimes(4);
    expect(deps.rotate).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-registering" }),
      "2026-08-23T12:00:00.000Z",
    );
  });

  it("replays a persisted receipt without a provider call or duplicate event", async () => {
    const deps = dependencies([candidate({ alreadyStalled: true })]);
    deps.loadReceipt.mockResolvedValue({ receiptId: "receipt-existing", result: "delivered", providerCode: "DELIVERED" });
    const response = await createA2pProbeHandler(deps)(request());
    await expect(response.json()).resolves.toMatchObject({ selected: 1, attempted: 0, delivered: 1, replayed: 1 });
    expect(deps.probe).not.toHaveBeenCalled();
    expect(deps.markStall).not.toHaveBeenCalled();
    expect(deps.apply).toHaveBeenCalledWith(expect.anything(), { kind: "done", externalRef: { receiptId: "receipt-existing", result: "delivered" } });
  });

  it("skips terminal, completed, future, and malformed candidates", async () => {
    const deps = dependencies([
      candidate({ tenantId: "terminal", terminalReceiptAt: "2026-08-20T00:00:00.000Z" }),
      candidate({ tenantId: "done", state: "done" }),
      candidate({ tenantId: "future", nextProbeAt: "2026-08-23T00:00:00.000Z" }),
      candidate({ tenantId: "plaintext", targetHash: "not-a-digest" }),
    ]);
    const response = await createA2pProbeHandler(deps)(request());
    await expect(response.json()).resolves.toMatchObject({ selected: 0, attempted: 0 });
    expect(deps.probe).not.toHaveBeenCalled();
  });

  it("persists the day-21 external-stall evidence only when the CAS wins", async () => {
    const deps = dependencies([candidate()]);
    deps.markStall.mockResolvedValue(false);
    const response = await createA2pProbeHandler(deps)(request());
    await expect(response.json()).resolves.toMatchObject({ stallsFlagged: 0 });
    expect(deps.markStall).toHaveBeenCalledWith(expect.anything(), [
      "onboarding.stalled_external:platform",
      "onboarding.stalled_external:tenant",
    ]);
  });

  it("fails loudly on the absent Phase 4 SMS-state owner seam", async () => {
    const deps = dependencies([candidate({ alreadyStalled: true })]);
    deps.probe.mockResolvedValue({ kind: "done", externalRef: { receiptId: "receipt-1" } });
    deps.apply.mockRejectedValue(new Error("PHASE4_SMS_CONNECTION_STATE_SEAM_MISSING"));
    const response = await createA2pProbeHandler(deps)(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "PHASE4_SMS_CONNECTION_STATE_SEAM_MISSING" });
  });

  it("never returns target identifiers, hashes, provider bodies, or tenant ids", async () => {
    const response = await createA2pProbeHandler(dependencies([candidate({ alreadyStalled: true })]))(request());
    const serialized = JSON.stringify(await response.json());
    expect(serialized).not.toContain(TARGET_HASH);
    expect(serialized).not.toMatch(/tenant-synthetic|target|phone|provider/i);
  });
});
