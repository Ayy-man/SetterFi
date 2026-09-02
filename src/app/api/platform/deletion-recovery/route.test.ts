import { afterEach, describe, expect, it, vi } from "vitest";

import { createDeletionRecoveryHandler } from "./handler";

afterEach(() => vi.unstubAllEnvs());

describe("platform deletion recovery route", () => {
  it("lists and adopts a tenant-scoped recovery only for owner/admin actors", async () => {
    vi.stubEnv("SETTERFI_PHASE1_LIVE", "true");
    const list = vi.fn(async () => [{
      intentId: "intent-a", contactId: "contact-a", status: "claimed",
      operatorRequired: true, lastError: "actor required", attemptCount: 2,
      updatedAt: "2026-08-27T12:00:00.000Z",
    }]);
    const adopt = vi.fn(async () => undefined);
    const resume = vi.fn(async () => "completed");
    const handlers = createDeletionRecoveryHandler({
      session: async () => ({ userId: "admin-a", role: "admin" }), list, adopt, resume,
    });
    const listed = await handlers.GET(new Request(
      "https://setterfi.test/api/platform/deletion-recovery?tenantId=tenant-a",
    ));
    expect(listed.status).toBe(200);
    expect(list).toHaveBeenCalledWith("tenant-a", "admin-a");

    const recovered = await handlers.POST(new Request(
      "https://setterfi.test/api/platform/deletion-recovery",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        tenantId: "tenant-a", intentId: "intent-a", reason: "Approved recovery",
      }) },
    ));
    expect(await recovered.json()).toEqual({ intentId: "intent-a", outcome: "completed" });
    expect(adopt).toHaveBeenCalledBefore(resume);
  });

  it("refuses coaches before listing or adopting recovery custody", async () => {
    vi.stubEnv("SETTERFI_PHASE1_LIVE", "true");
    const list = vi.fn();
    const adopt = vi.fn();
    const resume = vi.fn();
    const handlers = createDeletionRecoveryHandler({
      session: async () => ({ userId: "coach-a", role: "coach" }), list, adopt, resume,
    });
    expect((await handlers.GET(new Request(
      "https://setterfi.test/api/platform/deletion-recovery?tenantId=tenant-a",
    ))).status).toBe(403);
    expect(list).not.toHaveBeenCalled();
  });
});
