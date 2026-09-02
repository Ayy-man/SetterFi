import { describe, expect, it, vi } from "vitest";
import { evaluateAllowance, type AllowanceCandidate, type AllowanceDependencies } from "@/lib/billing/allowances";

const candidate: AllowanceCandidate = {
  tenantId: "tenant", isDemo: true, periodStart: "2026-08-01T00:00:00Z", periodEnd: "2026-09-01T00:00:00Z",
  subscriptionId: "subscription", currentTierId: "tier-1", currentPriceId: "price-1", allowance: 10,
  fairUseCap: 20, isUncapped: false, nextTier: { id: "tier-2", priceId: "price-2" },
  allowedPriceIds: ["price-1", "price-2"],
};
function dependencies(overrides: Partial<AllowanceDependencies> = {}): AllowanceDependencies {
  return {
    repository: {
      candidates: vi.fn(), countUsage: vi.fn().mockResolvedValue(10), findAction: vi.fn().mockResolvedValue(null),
      record: vi.fn().mockImplementation(async (input) => ({ kind: "crossing", actionId: "action", noticeEventId: input.noticeEventId,
        scheduleId: input.scheduleId, targetTierId: input.pendingTierId, effectiveAt: input.effectiveAt, state: "scheduled" })),
    },
    notifications: { emit: vi.fn().mockResolvedValue({ notificationId: "notice" }) },
    driver: vi.fn().mockReturnValue({ createRenewalPriceSchedule: vi.fn().mockResolvedValue({ scheduleId: "schedule", state: "scheduled", subscriptionId: "subscription", currentPeriodEnd: candidate.periodEnd, targetPriceId: "price-2" }) }),
    ...overrides,
  };
}

describe("allowance automation", () => {
  /**
   * The client's top tier is "997 beyond that" (`docs/INTAKE.md:57`) and names no ceiling, so
   * `tiers.is_uncapped` marks it and `call_allowance` keeps holding the number the tier *begins*
   * at rather than a cap -- which is what lets the other sixteen readers of that column stay
   * correct. The consequence lands here and nowhere else: without the flag this job reads 75 as a
   * limit, warns the tenant at 68 booked calls and schedules them a Stripe tier change at 75,
   * against a contract that agreed to neither. That is a wrong charge, so all three outcomes are
   * asserted absent rather than just the crossing, and the counting is asserted not to happen at
   * all -- a later edit that reintroduced the count would have somewhere to go wrong again.
   */
  it("never warns, crosses or files a fair-use review for a plan with no ceiling", async () => {
    const uncapped = { ...candidate, isUncapped: true };
    const wellOver = dependencies({
      repository: { ...dependencies().repository, countUsage: vi.fn().mockResolvedValue(9_999) },
    });

    await expect(evaluateAllowance(uncapped, wellOver)).resolves.toBeNull();
    expect(wellOver.repository.countUsage).not.toHaveBeenCalled();
    expect(wellOver.repository.record).not.toHaveBeenCalled();
    expect(wellOver.notifications.emit).not.toHaveBeenCalled();
    expect(wellOver.driver).not.toHaveBeenCalled();
  });

  /**
   * The control, and the reason the flag is not just "skip tenants with a big allowance": the same
   * count against the same allowance on a capped plan still acts. Uncapped is a property of the
   * contract, not of the number.
   */
  it("still acts on a capped plan at the same count and the same allowance", async () => {
    const deps = dependencies({
      repository: { ...dependencies().repository, countUsage: vi.fn().mockResolvedValue(9_999) },
    });

    await expect(evaluateAllowance(candidate, deps)).resolves.toMatchObject({ kind: "crossing" });
    expect(deps.repository.countUsage).toHaveBeenCalled();
  });

  /**
   * An uncapped plan with no tier above it must not fall through to the fair-use branch either --
   * that branch exists for a capped tenant who has run out of ladder, which is a different tenant.
   */
  it("files no fair-use review for an uncapped plan with nothing above it", async () => {
    const topOfLadder = { ...candidate, isUncapped: true, nextTier: null };
    const deps = dependencies({
      repository: { ...dependencies().repository, countUsage: vi.fn().mockResolvedValue(9_999) },
    });

    await expect(evaluateAllowance(topOfLadder, deps)).resolves.toBeNull();
    expect(deps.repository.record).not.toHaveBeenCalled();
  });

  it("couples a crossing notice, renewal schedule, and persisted action", async () => {
    const deps = dependencies();
    await expect(evaluateAllowance(candidate, deps)).resolves.toMatchObject({ kind: "crossing", scheduleId: "schedule", noticeEventId: "notice" });
    expect(deps.notifications.emit).toHaveBeenCalledWith(expect.objectContaining({ key: "billing.allowance_crossed", targetTierId: "tier-2" }));
    expect(deps.repository.record).toHaveBeenCalledWith(expect.objectContaining({ state: "scheduled", scheduleId: "schedule", noticeEventId: "notice" }));
  });

  it("returns persisted crossing state on retry without duplicate notice or schedule", async () => {
    const existing = { kind: "crossing", actionId: "action", noticeEventId: "notice", scheduleId: "schedule", targetTierId: "tier-2", effectiveAt: candidate.periodEnd, state: "scheduled" } as const;
    const deps = dependencies({ repository: { ...dependencies().repository, countUsage: vi.fn().mockResolvedValue(10), findAction: vi.fn().mockResolvedValue(existing) } });
    await expect(evaluateAllowance(candidate, deps)).resolves.toEqual(existing);
    expect(deps.notifications.emit).not.toHaveBeenCalled();
    expect(deps.driver).not.toHaveBeenCalled();
  });

  it("does not invent an action below approved tier allowance data", async () => {
    const deps = dependencies({ repository: { ...dependencies().repository, countUsage: vi.fn().mockResolvedValue(8) } });
    await expect(evaluateAllowance(candidate, deps)).resolves.toBeNull();
    expect(deps.notifications.emit).not.toHaveBeenCalled();
  });

  it("creates a review rather than an invented upgrade at the top tier", async () => {
    const record = vi.fn().mockImplementation(async (input) => ({ kind: "fair_use_review", actionId: "review", noticeEventId: input.noticeEventId, state: "recorded" }));
    const deps = dependencies({ repository: { ...dependencies().repository, countUsage: vi.fn().mockResolvedValue(20), record } });
    await expect(evaluateAllowance({ ...candidate, nextTier: null }, deps)).resolves.toMatchObject({ kind: "fair_use_review" });
    expect(deps.driver).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ pendingTierId: null, state: "review" }));
  });
});
