import { describe, expect, it, vi } from "vitest";

import {
  createAppointmentLifecycleCommandHandler,
  type AppointmentLifecycleCommandDependencies,
} from "./handler";
import { AppointmentProviderCommandError } from "@/lib/booking/reconcile";
import type { RouteActor } from "@/lib/auth/actors";

const actor: RouteActor = {
  userId: "coach-1",
  tenantId: "tenant-1",
  role: "coach",
  impersonatingTenant: null,
  impersonationSessionId: null,
};

const reschedule = {
  action: "reschedule" as const,
  reason: "The lead requested a later time.",
  idempotencyKey: "appointment-1-reschedule-1",
  expectedVersion: "2026-09-22T12:00:00.000Z",
  startAt: "2026-09-22T15:00:00.000Z",
  endAt: "2026-09-22T15:30:00.000Z",
};

const pending = {
  commandId: "command-1", tenantId: "tenant-1", appointmentId: "appointment-1",
  action: "reschedule" as const, state: "pending" as const, auditId: 41,
};
const confirmed = { ...pending, state: "confirmed" as const, auditId: 42 };
const failed = { ...pending, state: "failed" as const, auditId: 43 };

function request(body: unknown) {
  return new Request("http://localhost/api/appointments/appointment-1/lifecycle", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

function context() { return { params: Promise.resolve({ id: "appointment-1" }) }; }

function dependencies(overrides: Partial<AppointmentLifecycleCommandDependencies> = {}): AppointmentLifecycleCommandDependencies {
  return {
    enabled: () => true,
    session: async () => actor,
    record: async () => pending,
    dispatch: async () => confirmed,
    fail: async () => failed,
    ...overrides,
  };
}

describe("appointment lifecycle command route", () => {
  it("returns 404 before loading a session while the booking rollout gate is off", async () => {
    const session = vi.fn(async () => actor);
    const response = await createAppointmentLifecycleCommandHandler(dependencies({ enabled: () => false, session }))(request(reschedule), context());

    expect(response.status).toBe(404);
    expect(session).not.toHaveBeenCalled();
  });

  it("refuses non-coach and impersonated callers before writing an intent", async () => {
    const record = vi.fn(dependencies().record);
    const handler = createAppointmentLifecycleCommandHandler(dependencies({
      session: async () => ({ ...actor, impersonatingTenant: "tenant-2" }), record,
    }));

    expect((await handler(request(reschedule), context())).status).toBe(403);
    expect(record).not.toHaveBeenCalled();
  });

  it("requires a reason, exact body shape, and an ordered reschedule interval", async () => {
    const record = vi.fn(dependencies().record);
    const handler = createAppointmentLifecycleCommandHandler(dependencies({ record }));

    expect((await handler(request({ ...reschedule, reason: "", extra: true }), context())).status).toBe(400);
    expect((await handler(request({ ...reschedule, endAt: reschedule.startAt }), context())).status).toBe(400);
    expect(record).not.toHaveBeenCalled();
  });

  it("reports confirmed only after dispatch returns a provider-backed confirmation", async () => {
    const record = vi.fn(dependencies().record);
    const dispatch = vi.fn(dependencies().dispatch);
    const response = await createAppointmentLifecycleCommandHandler(dependencies({ record, dispatch }))(request(reschedule), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      command: { id: "command-1", action: "reschedule", state: "confirmed" },
      effect: { status: "confirmed", providerConfirmation: "confirmed" },
      audit: { id: 42 },
    });
    expect(record).toHaveBeenCalledWith({ ...reschedule, tenantId: "tenant-1", appointmentId: "appointment-1", actorId: "coach-1" });
    expect(dispatch).toHaveBeenCalledWith({ ...reschedule, tenantId: "tenant-1", appointmentId: "appointment-1", actorId: "coach-1", commandId: "command-1" });
  });

  it("records a visible failed receipt when the provider rejects a cancel without claiming a local cancellation", async () => {
    const cancel = {
      action: "cancel" as const,
      reason: "Lead asked to cancel.",
      idempotencyKey: "appointment-1-cancel-1",
      expectedVersion: "2026-09-22T12:00:00.000Z",
    };
    const fail = vi.fn(async () => ({ ...failed, action: "cancel" as const }));
    const response = await createAppointmentLifecycleCommandHandler(dependencies({
      record: async () => ({ ...pending, action: "cancel" as const }),
      dispatch: async () => { throw new AppointmentProviderCommandError("CALENDAR_CANCEL_REJECTED"); },
      fail,
    }))(request(cancel), context());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      command: { id: "command-1", action: "cancel", state: "failed" },
      effect: { status: "failed", providerConfirmation: "rejected" },
    });
    expect(fail).toHaveBeenCalledWith({ tenantId: "tenant-1", commandId: "command-1", actorId: "coach-1", failureCode: "CALENDAR_CANCEL_REJECTED" });
  });

  it("keeps an uncertain confirmation visibly pending instead of calling it complete", async () => {
    const response = await createAppointmentLifecycleCommandHandler(dependencies({
      dispatch: async () => { throw new Error("DATABASE_READBACK_TIMEOUT"); },
    }))(request(reschedule), context());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "The request is pending provider confirmation. Refresh before retrying." });
  });

  it("returns a refreshable conflict when the reviewed version is stale before provider dispatch", async () => {
    const dispatch = vi.fn(dependencies().dispatch);
    const response = await createAppointmentLifecycleCommandHandler(dependencies({
      record: async () => { throw new Error("APPOINTMENT_LIFECYCLE_COMMAND_REFUSED:APPOINTMENT_LIFECYCLE_STALE_VERSION"); },
      dispatch,
    }))(request(reschedule), context());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "APPOINTMENT_LIFECYCLE_STALE_VERSION",
      error: "The appointment changed after this page loaded. Refresh it before trying again.",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
