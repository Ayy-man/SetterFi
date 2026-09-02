import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPhase6SubscriptionReadinessPort } from "@/lib/billing/onboarding-port";

describe("Phase 6 subscription readiness port", () => {
  it("implements the merged Phase 5 contract and reads only persisted mirror evidence", async () => {
    const source = readFileSync(new URL("../onboarding/contracts.ts", import.meta.url), "utf8");
    expect(source, "PHASE5_SUBSCRIPTION_READINESS_PORT_MISSING").toContain("export type SubscriptionReadinessPort");
    const port = createPhase6SubscriptionReadinessPort({
      loadSubscription: async () => ({
        tenantId: "tenant-1", status: "active", evidenceAt: "2026-08-18T00:00:00.000Z", isDemo: false,
      }),
    });
    await expect(port("tenant-1")).resolves.toEqual({
      state: "active", evidenceAt: "2026-08-18T00:00:00.000Z", isDemo: false,
    });
  });

  it("does not claim readiness without a subscription row or readable evidence", async () => {
    await expect(createPhase6SubscriptionReadinessPort({ loadSubscription: async () => null })("tenant-1"))
      .resolves.toEqual({ state: "absent", evidenceAt: null, isDemo: false });
    await expect(createPhase6SubscriptionReadinessPort({ loadSubscription: async () => { throw new Error("down"); } })("tenant-1"))
      .resolves.toEqual({ state: "unavailable", evidenceAt: null, isDemo: false });
  });

  it("keeps terminal provider states incomplete", async () => {
    const port = createPhase6SubscriptionReadinessPort({
      loadSubscription: async () => ({ tenantId: "tenant-1", status: "canceled", evidenceAt: "now", isDemo: false }),
    });
    await expect(port("tenant-1")).resolves.toMatchObject({ state: "incomplete" });
  });
});
