import { describe, expect, it, vi } from "vitest";
import { createBillingRepository, type BillingRepositoryDependencies } from "@/lib/repositories/billing";

function moneyBillingFixture(rows: readonly Record<string, unknown>[] = []) {
  return {
    mrrByPeriod: Array.from({ length: 12 }, (_, index) => ({
      periodStart: new Date(Date.UTC(2025, index, 1)).toISOString(),
      periodEnd: new Date(Date.UTC(2025, index + 1, 1)).toISOString(),
      mrrCents: index === 11 ? 30_000 : 0,
    })),
    rows,
  };
}

function dependencies(overrides: Partial<BillingRepositoryDependencies> = {}): BillingRepositoryDependencies {
  return {
    serviceRpc: vi.fn(), userRpc: vi.fn(), readTierVersion: vi.fn(), readOverride: vi.fn(),
    readCorrectionRequest: vi.fn(), readCorrectionDecision: vi.fn(), readTenantStatus: vi.fn(),
    readAttendance: vi.fn(), projectCorrections: vi.fn(), projectOwnBilling: vi.fn(),
    readSubscription: vi.fn(), readMovementSources: vi.fn(), readMoneyBilling: vi.fn().mockResolvedValue(moneyBillingFixture()),
    readCheckoutTenant: vi.fn(), readCheckoutTierPrices: vi.fn(), readAllowedPrices: vi.fn(),
    readCheckoutSession: vi.fn(), readSubscriptionRows: vi.fn(), readCostRollupRows: vi.fn(),
    ...overrides,
  };
}

describe("billing repository", () => {
  describe("subscription rows", () => {
    const tenant = (overrides: Record<string, unknown> = {}) => ({
      id: "tenant-reid",
      name: "Reid Funding Group (demo)",
      status: "active",
      is_demo: true,
      billing_subscriptions: {
        status: "past_due",
        provider_updated_at: "2026-09-03T07:00:00.000Z",
        current_period_end: "2026-09-28T00:00:00.000Z",
        cancel_at_period_end: false,
      },
      allowance_actions: [
        { pending_tier_id: "tier-old", effective_at: "2026-07-01T00:00:00.000Z", state: "applied" },
        { pending_tier_id: "tier-growth", effective_at: "2026-10-01T00:00:00.000Z", state: "scheduled" },
      ],
      ...overrides,
    });

    it("projects the row the Subscriptions table reads, taking only the change that has not landed", async () => {
      const repository = createBillingRepository(dependencies({
        readSubscriptionRows: vi.fn().mockResolvedValue([tenant()]),
      }));

      expect(await repository.loadSubscriptionRows()).toEqual([{
        tenantId: "tenant-reid",
        businessName: "Reid Funding Group (demo)",
        accountStatus: "active",
        subscriptionStatus: "past_due",
        providerUpdatedAt: "2026-09-03T07:00:00.000Z",
        currentPeriodEnd: "2026-09-28T00:00:00.000Z",
        cancelAtPeriodEnd: false,
        // The applied action is history, not a pending change, so the scheduled one is the answer.
        pendingTierId: "tier-growth",
        pendingEffectiveAt: "2026-10-01T00:00:00.000Z",
        // The marker stays on the stored name; the label is what the screen strips it in favour of.
        dataLabel: "Demo",
      }]);
    });

    it("carries a tenant that has no subscription and no pending change, rather than dropping it", async () => {
      const repository = createBillingRepository(dependencies({
        readSubscriptionRows: vi.fn().mockResolvedValue([tenant({
          allowance_actions: [],
          billing_subscriptions: [],
          is_demo: false,
          name: "Cedar Ridge Credit Coaching",
        })]),
      }));

      expect(await repository.loadSubscriptionRows()).toEqual([{
        tenantId: "tenant-reid",
        businessName: "Cedar Ridge Credit Coaching",
        accountStatus: "active",
        subscriptionStatus: null,
        providerUpdatedAt: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        pendingTierId: null,
        pendingEffectiveAt: null,
        dataLabel: null,
      }]);
    });

    it("refuses a row with no account reference rather than drawing a nameless one", async () => {
      const repository = createBillingRepository(dependencies({
        readSubscriptionRows: vi.fn().mockResolvedValue([tenant({ id: "" })]),
      }));

      await expect(repository.loadSubscriptionRows())
        .rejects.toThrow("BILLING_SUBSCRIPTION_ROWS_READ_INVALID");
    });
  });

  describe("cost rollup rows", () => {
    const rollup = (overrides: Record<string, unknown> = {}) => ({
      id: "rollup-august",
      tenant_id: "tenant-reid",
      window_start: "2026-08-01T00:00:00.000Z",
      window_end: "2026-09-01T00:00:00.000Z",
      recognized_subscription_cents: 149_700,
      model_cents: 4_210,
      messaging_cents: 1_980,
      embedding_cents: 640,
      complete: true,
      missing_sources: [],
      computed_at: "2026-09-01T02:00:00.000Z",
      tenant: { name: "Reid Funding Group (demo)", is_demo: true },
      ...overrides,
    });

    it("projects the row the Costs table reads, without going through the export route", async () => {
      const repository = createBillingRepository(dependencies({
        readCostRollupRows: vi.fn().mockResolvedValue([rollup()]),
      }));

      expect(await repository.loadCostRollupRows()).toEqual([{
        rollupId: "rollup-august",
        tenantId: "tenant-reid",
        businessName: "Reid Funding Group (demo)",
        windowStart: "2026-08-01T00:00:00.000Z",
        windowEnd: "2026-09-01T00:00:00.000Z",
        revenueCents: 149_700,
        modelCostCents: 4_210,
        messagingCostCents: 1_980,
        embeddingCostCents: 640,
        complete: true,
        // A period missing nothing carries no string, because "" would read on screen as a value.
        missingSources: null,
        sourceEvidenceAt: "2026-09-01T02:00:00.000Z",
        dataLabel: "Demo",
      }]);
    });

    it("keeps an absent cost source absent and joins the missing ones the way the screen prints them", async () => {
      const repository = createBillingRepository(dependencies({
        readCostRollupRows: vi.fn().mockResolvedValue([rollup({
          complete: false,
          embedding_cents: null,
          messaging_cents: null,
          missing_sources: ["messaging", "embedding"],
          recognized_subscription_cents: null,
          tenant: { name: "Cedar Ridge Credit Coaching", is_demo: false },
        })]),
      }));

      const [row] = await repository.loadCostRollupRows();
      expect(row).toMatchObject({
        businessName: "Cedar Ridge Credit Coaching",
        // Absent, never zero: a source that was never recorded is not a cost of nothing.
        revenueCents: null,
        messagingCostCents: null,
        embeddingCostCents: null,
        complete: false,
        missingSources: "messaging; embedding",
        dataLabel: null,
      });
    });

    it("refuses a rollup whose tenant carries no name rather than drawing a nameless period", async () => {
      const repository = createBillingRepository(dependencies({
        readCostRollupRows: vi.fn().mockResolvedValue([rollup({ tenant: null })]),
      }));

      await expect(repository.loadCostRollupRows())
        .rejects.toThrow("BILLING_COST_ROLLUP_ROWS_READ_INVALID");
    });
  });

  it("keeps twelve receipt-backed MRR periods and only real client rows, with raw status distinct from live MRR", async () => {
    const row = (overrides: Record<string, unknown> = {}) => ({
      tenantId: "tenant-active",
      businessName: "Northstar Fitness",
      accountStatus: "active",
      subscriptionStatus: "active",
      providerUpdatedAt: "2025-12-15T00:00:00.000Z",
      currentPeriodEnd: "2026-01-01T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      pendingTierId: null,
      pendingEffectiveAt: null,
      dataLabel: null,
      plan: "Growth",
      monthlyAmountCents: 30_000,
      status: "active",
      countsAsLive: true,
      isTest: false,
      isDemo: false,
      ...overrides,
    });
    const repository = createBillingRepository(dependencies({
      readMoneyBilling: vi.fn().mockResolvedValue(moneyBillingFixture([
        row(),
        row({ tenantId: "tenant-trial", subscriptionStatus: "trialing", status: "trialing", countsAsLive: false }),
        row({ tenantId: "tenant-due", subscriptionStatus: "past_due", status: "past_due", countsAsLive: false }),
        row({ tenantId: "tenant-cancelling", cancelAtPeriodEnd: true }),
        row({ tenantId: "tenant-cancelled", subscriptionStatus: "canceled", status: "canceled", countsAsLive: false }),
        row({ tenantId: "tenant-test", isTest: true }),
        // A demo tenant's row only reaches the RPC output when the database's demo switch admitted
        // it, so it is kept and labelled; the inherited test flag on it is not a reason to drop it.
        row({ tenantId: "tenant-demo", isTest: true, isDemo: true }),
      ])),
    }));

    const billing = await repository.loadMoneyBilling("2026-01-15T00:00:00.000Z");

    expect(billing.rows.find((client) => client.tenantId === "tenant-demo")?.dataLabel).toBe("Demo");
    expect(billing.rows.find((client) => client.tenantId === "tenant-test")).toBeUndefined();

    expect(billing.mrrByPeriod).toHaveLength(12);
    expect(billing.mrrByPeriod.at(-1)).toEqual({
      periodStart: "2025-12-01T00:00:00.000Z",
      periodEnd: "2026-01-01T00:00:00.000Z",
      mrrCents: 30_000,
    });
    expect(billing.rows).toHaveLength(6);
    expect(billing.rows.map((client) => client.plan)).toEqual([
      "Growth", "Growth", "Growth", "Growth", "Growth", "Growth",
    ]);
    expect(billing.rows.map((client) => client.monthlyAmountCents)).toEqual([
      30_000, 30_000, 30_000, 30_000, 30_000, 30_000,
    ]);
    expect(billing.rows.map((client) => [client.status, client.countsAsLive])).toEqual([
      ["active", true], ["trialing", false], ["past_due", false], ["active", true], ["canceled", false],
      ["active", true],
    ]);
    expect(billing.rows.map((client) => client.tenantId)).not.toContain("tenant-test");
  });

  it("accepts only the exact coach-own billing projection and maps its rendered state", async () => {
    const projection = {
      tier_name: "Synthetic Growth",
      price_cents: 30_000,
      period_start: "2026-08-01T00:00:00.000Z",
      period_end: "2026-09-01T00:00:00.000Z",
      timezone: "America/New_York",
      booked_count: 18,
      call_allowance: 25,
      subscription_state: "active",
      invoice_state: "active",
      account_state: "active",
      pending_tier_name: "Synthetic Scale",
      pending_price_cents: 60_000,
      pending_effective_at: "2026-09-01T00:00:00.000Z",
      notices: [{
        id: "notice-1",
        kind: "crossing",
        state: "sent",
        deliveryReceiptId: "receipt-1",
        billingContactSource: "login email",
      }],
      correction_candidates: [{ eventId: "event-1", label: "Synthetic booked call" }],
      outcome_prompts: [{
        appointmentId: "appointment-1",
        label: "Synthetic booked call",
        occurredAt: "2026-08-20T00:00:00.000Z",
      }],
      is_demo: true,
    };
    const repository = createBillingRepository(dependencies({
      projectOwnBilling: vi.fn().mockResolvedValue([projection]),
    }));

    const inside = new Date("2026-08-17T12:00:00.000Z");
    await expect(repository.loadOwnBilling("tenant-1", inside)).resolves.toMatchObject({
      tierName: "Synthetic Growth",
      bookedCount: 18,
      callAllowance: 25,
      subscriptionState: "active",
      pendingMovement: { tierName: "Synthetic Scale", priceCents: 60_000 },
      notices: [{ state: "sent", deliveryReceiptId: "receipt-1" }],
      isDemo: true,
    });

    const widened = createBillingRepository(dependencies({
      projectOwnBilling: vi.fn().mockResolvedValue([{
        ...projection,
        margin_cents: 99_999,
      }]),
    }));
    await expect(widened.loadOwnBilling("tenant-1", inside)).rejects.toThrow(
      "COACH_BILLING_PROJECTION_INVALID",
    );
  });

  /**
   * The disagreement this closes. `coach_billing_projection` joins `billing_subscriptions` with no
   * status filter and no window, so it kept handing back the August period after August ended and
   * /coach/billing kept drawing it as current -- "25 booked calls this billing period", "your
   * month resets on Aug 31" -- while /coach/home, reading the bounded lookup inside
   * `read_coach_measurement_for_actor`, correctly said there was no active billing period to count
   * an allowance against. Same tenant, same instant, two answers.
   *
   * Null is the right answer rather than a thrown error: the row is real, it is simply not a
   * current period, and `coach-billing.tsx` already renders that absence honestly.
   */
  it("refuses to present a subscription whose period has ended as the current one", async () => {
    const projection = {
      tier_name: "Synthetic Growth", price_cents: 30_000,
      period_start: "2026-08-01T00:00:00.000Z", period_end: "2026-09-01T00:00:00.000Z",
      timezone: "America/New_York", booked_count: 18, call_allowance: 25,
      subscription_state: "active", invoice_state: "active", account_state: "active",
      pending_tier_name: null, pending_price_cents: null, pending_effective_at: null,
      notices: [], correction_candidates: [], outcome_prompts: [], is_demo: true,
    };
    const repository = () => createBillingRepository(dependencies({
      projectOwnBilling: vi.fn().mockResolvedValue([projection]),
    }));

    await expect(
      repository().loadOwnBilling("tenant-1", new Date("2026-08-31T23:59:59.000Z")),
    ).resolves.toMatchObject({ callAllowance: 25 });
    await expect(
      repository().loadOwnBilling("tenant-1", new Date("2026-09-01T06:00:00.000Z")),
    ).resolves.toBeNull();
    await expect(
      repository().loadOwnBilling("tenant-1", new Date("2026-07-15T00:00:00.000Z")),
    ).resolves.toBeNull();
  });

  /**
   * A canceled subscription can still carry a period that contains today -- Stripe leaves the
   * final period on the row -- and the measurement RPC does not count an allowance against it.
   * Neither may this.
   */
  it("refuses a subscription state the allowance lookup does not recognise", async () => {
    const projection = {
      tier_name: "Synthetic Growth", price_cents: 30_000,
      period_start: "2026-08-01T00:00:00.000Z", period_end: "2026-09-01T00:00:00.000Z",
      timezone: "America/New_York", booked_count: 4, call_allowance: 25,
      subscription_state: "canceled", invoice_state: "canceled", account_state: "churned",
      pending_tier_name: null, pending_price_cents: null, pending_effective_at: null,
      notices: [], correction_candidates: [], outcome_prompts: [], is_demo: true,
    };
    const repository = createBillingRepository(dependencies({
      projectOwnBilling: vi.fn().mockResolvedValue([projection]),
    }));

    await expect(
      repository.loadOwnBilling("tenant-1", new Date("2026-08-17T12:00:00.000Z")),
    ).resolves.toBeNull();
  });

  it("passes the verified actor and accepts a checkout only after exact persisted readback", async () => {
    const serviceRpc = vi.fn().mockResolvedValue([{ checkout_session_id: "checkout-row", state: "open" }]);
    const readCheckoutSession = vi.fn().mockResolvedValue({
      id: "checkout-row", tenant_id: "tenant-1", tier_id: "tier-1", idempotency_key: "checkout:tenant-1:tier-1:price-1",
      stripe_session_id: "cs_1", stripe_customer_id: "cus_1", stripe_subscription_id: null,
      state: "open", expires_at: "2026-08-19T00:00:00.000Z",
    });
    const repository = createBillingRepository(dependencies({ serviceRpc, readCheckoutSession }));
    await expect(repository.persistCheckout({
      actorId: "actor-1", tenantId: "tenant-1", tierId: "tier-1", priceId: "price-1",
      idempotencyKey: "checkout:tenant-1:tier-1:price-1",
      provider: { sessionId: "cs_1", customerId: "cus_1", subscriptionId: null, state: "open", expiresAt: "2026-08-19T00:00:00.000Z" },
    })).resolves.toMatchObject({ checkoutSessionId: "checkout-row", sessionId: "cs_1" });
    expect(serviceRpc).toHaveBeenCalledWith("record_stripe_checkout_session", expect.objectContaining({ p_actor_id: "actor-1" }));
  });

  it("fails a provider-only checkout receipt without a persisted row", async () => {
    const repository = createBillingRepository(dependencies({
      serviceRpc: vi.fn().mockResolvedValue([{ checkout_session_id: "missing", state: "open" }]),
      readCheckoutSession: vi.fn().mockResolvedValue(null),
    }));
    await expect(repository.persistCheckout({
      actorId: "actor", tenantId: "tenant", tierId: "tier", priceId: "price", idempotencyKey: "key",
      provider: { sessionId: "session", customerId: "customer", subscriptionId: null, state: "open", expiresAt: "later" },
    })).resolves.toBeNull();
  });

  it("returns correction request, decision, offset and both persisted audit ids", async () => {
    const repository = createBillingRepository(dependencies({
      serviceRpc: vi.fn().mockResolvedValue([{ decision_id: "decision", offset_event_id: "offset", audit_id: 22 }]),
      readCorrectionRequest: vi.fn().mockResolvedValue({ id: "request", audit_id: 11 }),
      readCorrectionDecision: vi.fn().mockResolvedValue({ id: "decision", request_id: "request", decision: "approved", offset_event_id: "offset", audit_id: 22 }),
    }));
    await expect(repository.decideCorrection({ actorId: "owner", tenantId: "tenant", requestId: "request", decision: "approved", reason: "verified" }))
      .resolves.toEqual({ decisionId: "decision", offsetEventId: "offset", requestAuditId: 11, decisionAuditId: 22 });
  });

  it("proves every attendance choice leaves the persisted billable sum unchanged", async () => {
    for (const status of ["completed", "no_show"] as const) {
      const userRpc = vi.fn().mockResolvedValue(31);
      const readAttendance = vi.fn().mockResolvedValue({
        id: "appointment", status, attendance_source: "coach", attendance_set_by: "coach",
        audit_action: "appointment.attendance_set", billable_quantity: 1,
      });
      await expect(createBillingRepository(dependencies({ userRpc, readAttendance })).recordAttendance({
        actorId: "coach", tenantId: "tenant", appointmentId: "appointment", status,
      })).resolves.toEqual({ auditId: 31, billableQuantity: 1 });
    }
  });

  const MOVEMENT_AS_OF = "2026-08-19T00:00:00.000Z";
  const GROWTH_VERSION = {
    price_version_id: "version-growth",
    tier_id: "tier-growth",
    price_cents: 30_000,
    effective_at: "2026-01-01T00:00:00.000Z",
  };

  function movementSubscription(overrides: Record<string, unknown> = {}) {
    return {
      subscription_id: "subscription-1",
      tenant_id: "tenant-1",
      tier_id: "tier-growth",
      stripe_price_id: "price_growth",
      status: "active",
      current_period_start: "2026-08-01T00:00:00.000Z",
      current_period_end: "2026-09-01T00:00:00.000Z",
      cancel_at_period_end: false,
      provider_updated_at: "2026-08-18T00:00:00.000Z",
      created_at: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  function movementRepository(sources: {
    subscriptions: readonly unknown[];
    tierPriceVersions?: readonly unknown[];
    tenantPriceOverrides?: readonly unknown[];
  }) {
    return createBillingRepository(dependencies({
      readMovementSources: vi.fn().mockResolvedValue({
        subscriptions: sources.subscriptions,
        tierPriceVersions: sources.tierPriceVersions ?? [GROWTH_VERSION],
        tenantPriceOverrides: sources.tenantPriceOverrides ?? [],
      }),
    }));
  }

  it("projects new, upgrade, churn and downgrade from persisted price history with signed cents", async () => {
    const repository = movementRepository({
      subscriptions: [
        movementSubscription({ subscription_id: "sub-a", tenant_id: "tenant-a", created_at: "2026-08-01T00:00:00.000Z" }),
        movementSubscription({
          subscription_id: "sub-b", tenant_id: "tenant-b", status: "canceled",
          provider_updated_at: "2026-08-05T00:00:00.000Z",
        }),
        movementSubscription({ subscription_id: "sub-c", tenant_id: "tenant-c" }),
        movementSubscription({ subscription_id: "sub-d", tenant_id: "tenant-d" }),
      ],
      tenantPriceOverrides: [
        { override_id: "override-c", tenant_id: "tenant-c", price_cents: 45_000, effective_at: "2026-08-01T00:00:00.000Z", ends_at: null },
        { override_id: "override-d", tenant_id: "tenant-d", price_cents: 20_000, effective_at: "2026-08-10T00:00:00.000Z", ends_at: null },
      ],
    });

    const movement = await repository.loadMrrMovement(MOVEMENT_AS_OF);

    expect(movement).toMatchObject({
      asOf: MOVEMENT_AS_OF,
      windowStart: "2026-07-20T00:00:00.000Z",
      newCents: 30_000,
      upgradeCents: 15_000,
      churnCents: -30_000,
      downgradeCents: -10_000,
      mrrCents: 95_000,
      clientCount: 3,
      scheduledCancellations: 0,
    });
    expect(movement.newCents).toBeGreaterThan(0);
    expect(movement.upgradeCents).toBeGreaterThan(0);
    expect(movement.churnCents).toBeLessThan(0);
    expect(movement.downgradeCents).toBeLessThan(0);
  });

  it("counts a scheduled cancellation without letting it move any of the four figures", async () => {
    const movement = await movementRepository({
      subscriptions: [movementSubscription({
        tenant_id: "tenant-scheduled",
        cancel_at_period_end: true,
        created_at: "2026-08-02T00:00:00.000Z",
      })],
    }).loadMrrMovement(MOVEMENT_AS_OF);

    expect(movement.mrrCents).toBe(30_000);
    expect(movement.clientCount).toBe(1);
    expect(movement.scheduledCancellations).toBe(1);
    expect([movement.newCents, movement.upgradeCents, movement.churnCents, movement.downgradeCents])
      .toEqual([0, 0, 0, 0]);
  });

  it("reports an unresolvable price as unavailable rather than a partial sum", async () => {
    const movement = await movementRepository({
      subscriptions: [
        movementSubscription({ tenant_id: "tenant-priced" }),
        movementSubscription({
          subscription_id: "sub-unmatched", tenant_id: "tenant-unmatched",
          tier_id: null, stripe_price_id: "price_retired",
        }),
      ],
    }).loadMrrMovement(MOVEMENT_AS_OF);

    expect(movement.mrrCents).toBeNull();
    expect(movement.clientCount).toBe(2);
    expect(movement.missingSources).toContain("unpriced_tenant");
  });

  it("always names tier reassignment as a missing source, even when every tenant prices cleanly", async () => {
    const movement = await movementRepository({ subscriptions: [movementSubscription()] })
      .loadMrrMovement(MOVEMENT_AS_OF);

    expect(movement.mrrCents).toBe(30_000);
    expect(movement.missingSources).toEqual(["tier_reassignment"]);
  });

  it("refuses a widened movement source row instead of summing unknown columns", async () => {
    const repository = movementRepository({
      subscriptions: [{ ...movementSubscription(), margin_cents: 99_999 }],
    });

    await expect(repository.loadMrrMovement(MOVEMENT_AS_OF)).rejects.toThrow(
      "BILLING_MOVEMENT_SOURCE_INVALID",
    );
  });
});
