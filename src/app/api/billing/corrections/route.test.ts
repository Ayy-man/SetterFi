import { describe, expect, it, vi } from "vitest";
import {
  createBillingCorrectionsHandler,
  createCoachBillingSnapshotHandler,
} from "@/app/api/billing/corrections/handler";
import {
  createBillingRepository,
  type BillingRepositoryDependencies,
} from "@/lib/repositories/billing";

const request = (body: unknown) => new Request("https://app.test/api/billing/corrections", { method: "POST", body: JSON.stringify(body) });
const coach = {
  userId: "coach",
  tenantId: "tenant",
  role: "coach" as const,
  impersonatingTenant: null,
  impersonationSessionId: null,
};

function repositoryDependencies(
  overrides: Partial<BillingRepositoryDependencies>,
): BillingRepositoryDependencies {
  return {
    serviceRpc: vi.fn(),
    userRpc: vi.fn(),
    readTierVersion: vi.fn(),
    readOverride: vi.fn(),
    readCorrectionRequest: vi.fn(),
    readCorrectionDecision: vi.fn(),
    readTenantStatus: vi.fn(),
    readAttendance: vi.fn(),
    projectCorrections: vi.fn(),
    projectOwnBilling: vi.fn(),
    readMovementSources: vi.fn(),
    readSubscription: vi.fn(),
    readSubscriptionRows: vi.fn(),
    readCostRollupRows: vi.fn(),
    readCheckoutTenant: vi.fn(),
    readCheckoutTierPrices: vi.fn(),
    readAllowedPrices: vi.fn(),
    readCheckoutSession: vi.fn(),
    readMoneyBilling: vi.fn(),
    ...overrides,
  };
}

describe("coach billing corrections route", () => {
  it("derives the tenant from the coach session", async () => {
    const requestCorrection = vi.fn().mockResolvedValue({ state: "requested", requestId: "r", requestAuditId: 1 });
    const response = await createBillingCorrectionsHandler({
      enabled: () => true,
      session: async () => coach,
      operations: {
        requestCorrection,
        requestPeriodCorrection: vi.fn(),
        recordAttendance: vi.fn(),
        skipAttendance: vi.fn(),
      },
    })(request({ action: "request_correction", eventId: "event", quantityDelta: -1, reason: "duplicate" }));
    expect(response.status).toBe(200);
    expect(requestCorrection).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant" }));
  });

  it("files a period-level correction with a reason only, no event and no quantity delta", async () => {
    const requestPeriodCorrection = vi.fn()
      .mockResolvedValue({ state: "requested", requestId: "period-r", requestAuditId: 1 });
    const response = await createBillingCorrectionsHandler({
      enabled: () => true,
      session: async () => coach,
      operations: {
        requestCorrection: vi.fn(),
        requestPeriodCorrection,
        recordAttendance: vi.fn(),
        skipAttendance: vi.fn(),
      },
    })(request({ action: "request_period_correction", reason: "this period looks wrong" }));
    expect(response.status).toBe(200);
    expect(requestPeriodCorrection).toHaveBeenCalledWith({
      tenantId: "tenant", reason: "this period looks wrong",
    });

    const refused = await createBillingCorrectionsHandler({
      enabled: () => true,
      session: async () => coach,
      operations: {
        requestCorrection: vi.fn(),
        requestPeriodCorrection: vi.fn(),
        recordAttendance: vi.fn(),
        skipAttendance: vi.fn(),
      },
    })(request({ action: "request_period_correction", reason: "  " }));
    expect(refused.status).toBe(409);
  });

  it("is neither public nor tenant-selectable", async () => {
    const handler = createBillingCorrectionsHandler({
      enabled: () => true,
      session: async () => null,
      operations: {
        requestCorrection: vi.fn(),
        requestPeriodCorrection: vi.fn(),
        recordAttendance: vi.fn(),
        skipAttendance: vi.fn(),
      },
    });
    expect((await handler(request({ action: "request_correction" }))).status).toBe(403);
  });

  it("persists a skipped attendance choice in the coach tenant", async () => {
    const skipAttendance = vi.fn().mockResolvedValue({
      appointment: { id: "appointment-one", attendanceState: "skipped" },
      auditId: 41,
    });
    const handler = createBillingCorrectionsHandler({
      enabled: () => true,
      session: async () => coach,
      operations: {
        requestCorrection: vi.fn(),
        requestPeriodCorrection: vi.fn(),
        recordAttendance: vi.fn(),
        skipAttendance,
      },
    });

    const response = await handler(request({
      action: "skip_attendance",
      appointmentId: "appointment-one",
      idempotencyKey: "skip-one",
    }));

    expect(response.status).toBe(200);
    expect(skipAttendance).toHaveBeenCalledWith({
      actorId: "coach",
      tenantId: "tenant",
      appointmentId: "appointment-one",
      idempotencyKey: "skip-one",
    });
    await expect(response.json()).resolves.toEqual({
      appointment: { id: "appointment-one", attendanceState: "skipped" },
    });
  });

  it("returns the same skipped appointment when an idempotency key is replayed", async () => {
    const claims = new Set<string>();
    let persisted: Record<string, unknown> | null = null;
    let writes = 0;
    const serviceRpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      expect(name).toBe("consume_rate_limit");
      const claim = String(args.p_key);
      const allowed = !claims.has(claim);
      claims.add(claim);
      return [{ allowed, remaining: 0, retry_after: allowed ? 0 : 2_147_483_647 }];
    });
    const repository = createBillingRepository(repositoryDependencies({
      serviceRpc,
      findSkippedAttendance: vi.fn(async () => persisted),
      validateSkippedAttendance: vi.fn(async () => undefined),
      releaseSkippedAttendanceClaim: vi.fn(async () => undefined),
      writeSkippedAttendance: vi.fn(async (input) => {
        writes += 1;
        await Promise.resolve();
        persisted = {
          id: 42,
          tenant_id: input.tenantId,
          action: "appointment.attendance_set",
          target_type: "appointment",
          target_id: input.appointmentId,
          payload: {
            attendance_state: "skipped",
            value: "skipped",
            idempotency_key: input.idempotencyKey,
          },
        };
        return persisted;
      }),
    }));
    const handler = createBillingCorrectionsHandler({
      enabled: () => true,
      session: async () => coach,
      operations: {
        requestCorrection: vi.fn(),
        requestPeriodCorrection: vi.fn(),
        recordAttendance: vi.fn(),
        skipAttendance: repository.skipAttendance,
      },
    });
    const body = {
      action: "skip_attendance",
      appointmentId: "appointment-one",
      idempotencyKey: "same-skip",
    };

    const [first, replay] = await Promise.all([
      handler(request(body)),
      handler(request(body)),
    ]);

    expect(writes).toBe(1);
    expect(serviceRpc).toHaveBeenCalledTimes(2);
    expect(serviceRpc).toHaveBeenCalledWith("consume_rate_limit", expect.objectContaining({
      p_key: expect.stringContaining("billing-attendance-skip"),
      p_limit: 1,
      p_window_seconds: 2_147_483_647,
    }));
    await expect(first.json()).resolves.toEqual({
      appointment: { id: "appointment-one", attendanceState: "skipped" },
    });
    await expect(replay.json()).resolves.toEqual({
      appointment: { id: "appointment-one", attendanceState: "skipped" },
    });
  });

  it("returns the generic conflict response when a skip is refused", async () => {
    const handler = createBillingCorrectionsHandler({
      enabled: () => true,
      session: async () => coach,
      operations: {
        requestCorrection: vi.fn(),
        requestPeriodCorrection: vi.fn(),
        recordAttendance: vi.fn(),
        skipAttendance: vi.fn().mockRejectedValue(new Error("ATTENDANCE_SKIP_REFUSED")),
      },
    });

    const response = await handler(request({
      action: "skip_attendance",
      appointmentId: "appointment-one",
      idempotencyKey: "skip-one",
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Billing correction was refused.",
    });
  });
});

describe("coach billing snapshot route", () => {
  const get = (query = "") => new Request(
    `https://app.test/api/billing/corrections${query}`,
  );
  it("derives the only billing tenant from the coach session", async () => {
    const load = vi.fn().mockResolvedValue({
      tierName: "Synthetic Growth",
      bookedCount: 18,
      callAllowance: 25,
    });
    const response = await createCoachBillingSnapshotHandler({
      enabled: () => true,
      session: async () => coach,
      load,
    })(get());

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(load).toHaveBeenCalledWith("tenant");
    await expect(response.json()).resolves.toMatchObject({
      snapshot: { tierName: "Synthetic Growth", bookedCount: 18, callAllowance: 25 },
    });
  });

  it("rejects caller scope selectors before billing projection work", async () => {
    const load = vi.fn();
    const handler = createCoachBillingSnapshotHandler({
      enabled: () => true,
      session: async () => coach,
      load,
    });

    expect((await handler(get("?tenantId=other"))).status).toBe(400);
    expect(load).not.toHaveBeenCalled();
  });

  it("keeps disabled, unauthorized, empty, and unavailable states distinct", async () => {
    const load = vi.fn().mockResolvedValue(null);
    const disabled = await createCoachBillingSnapshotHandler({
      enabled: () => false,
      session: async () => coach,
      load,
    })(get());
    const forbidden = await createCoachBillingSnapshotHandler({
      enabled: () => true,
      session: async () => null,
      load,
    })(get());
    const empty = await createCoachBillingSnapshotHandler({
      enabled: () => true,
      session: async () => coach,
      load,
    })(get());
    const unavailable = await createCoachBillingSnapshotHandler({
      enabled: () => true,
      session: async () => coach,
      load: async () => { throw new Error("COACH_BILLING_PROJECTION_FAILED"); },
    })(get());

    expect([disabled.status, forbidden.status, empty.status, unavailable.status])
      .toEqual([404, 403, 200, 503]);
    await expect(empty.json()).resolves.toEqual({ snapshot: null });
  });
});
