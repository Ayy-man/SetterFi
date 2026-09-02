import { describe, expect, it, vi } from "vitest";

import {
  runTierChangeReconciliation,
  type TierChangeCandidate,
  type TierChangeDependencies,
} from "./tier-changes";

const scheduled: TierChangeCandidate = {
  actionId: "action", tenantId: "tenant", isDemo: false, scheduleId: "schedule",
  subscriptionId: "subscription", targetTierId: "tier-2", targetPriceId: "price-2",
  effectiveAt: "2026-09-01T00:00:00.000Z", state: "scheduled", completionNoticeEventId: null,
};

function dependencies(overrides: Partial<TierChangeDependencies> = {}): TierChangeDependencies {
  return {
    repository: {
      due: vi.fn().mockResolvedValue([scheduled]),
      complete: vi.fn().mockResolvedValue({ ...scheduled, state: "completed" }),
      fail: vi.fn().mockResolvedValue(undefined),
      recordNotification: vi.fn().mockResolvedValue(undefined),
    },
    provider: vi.fn().mockResolvedValue({ state: "released", subscription: {
      subscriptionId: "subscription", priceId: "price-2", status: "active",
      currentPeriodStart: "2026-09-01T00:00:00.000Z", currentPeriodEnd: "2026-10-01T00:00:00.000Z",
      cancelAtPeriodEnd: false, providerUpdatedAt: "2026-09-01T00:01:00.000Z",
    } }),
    notifications: { emit: vi.fn().mockResolvedValue({ notificationId: "notification" }) },
    now: () => new Date("2026-09-01T00:05:00.000Z"),
    ...overrides,
  };
}

describe("tier change reconciliation", () => {
  it("keeps a past-effective schedule pending until the provider releases it", async () => {
    const deps = dependencies({ provider: vi.fn().mockResolvedValue({ state: "pending" }) });
    await expect(runTierChangeReconciliation(deps)).resolves.toMatchObject({ pending: 1, completed: 0, notified: 0 });
    expect(deps.repository.complete).not.toHaveBeenCalled();
    expect(deps.notifications.emit).not.toHaveBeenCalled();
  });

  it("records a provider cancellation as terminal without moving the tier or notifying", async () => {
    const deps = dependencies({ provider: vi.fn().mockResolvedValue({ state: "failed", reason: "provider_cancelled" }) });
    await expect(runTierChangeReconciliation(deps)).resolves.toMatchObject({ terminalFailed: 1, completed: 0, notified: 0 });
    expect(deps.repository.fail).toHaveBeenCalledWith(expect.objectContaining({ reason: "provider_cancelled" }));
    expect(deps.repository.complete).not.toHaveBeenCalled();
    expect(deps.notifications.emit).not.toHaveBeenCalled();
  });

  it("moves the tier only after released provider evidence and then persists its notification receipt", async () => {
    const deps = dependencies();
    await expect(runTierChangeReconciliation(deps)).resolves.toMatchObject({ completed: 1, notified: 1, errors: 0 });
    expect(deps.repository.complete).toHaveBeenCalledWith(expect.objectContaining({
      candidate: scheduled,
      subscription: expect.objectContaining({ priceId: "price-2", subscriptionId: "subscription" }),
    }));
    expect(deps.notifications.emit).toHaveBeenCalledWith(expect.objectContaining({
      key: "billing.tier_upgraded", allowanceActionId: "action", targetTierId: "tier-2",
    }));
    expect(deps.repository.recordNotification).toHaveBeenCalledWith({ actionId: "action", notificationId: "notification" });
  });

  it("retries only the durable notification for an already-completed transition", async () => {
    const completed = { ...scheduled, state: "completed" as const, completionNoticeEventId: null };
    const deps = dependencies({ repository: { ...dependencies().repository, due: vi.fn().mockResolvedValue([completed]) } });
    await expect(runTierChangeReconciliation(deps)).resolves.toMatchObject({ completed: 0, notified: 1, errors: 0 });
    expect(deps.provider).not.toHaveBeenCalled();
    expect(deps.repository.complete).not.toHaveBeenCalled();
  });

  it("does not re-emit once the state owner recorded the notification receipt", async () => {
    const completed = { ...scheduled, state: "completed" as const, completionNoticeEventId: "notification" };
    const deps = dependencies({ repository: { ...dependencies().repository, due: vi.fn().mockResolvedValue([completed]) } });
    await expect(runTierChangeReconciliation(deps)).resolves.toMatchObject({ notified: 0, errors: 0 });
    expect(deps.notifications.emit).not.toHaveBeenCalled();
  });
});
