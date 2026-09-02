import { describe, expect, it } from "vitest";

import type { CalendarDriver } from "@/lib/integrations/types";

import { createAppointmentLifecycleService } from "./reconcile";
import type {
  AppointmentLifecycleRepository,
  AppointmentRecord,
  BookingDomainEvent,
  CalendarConnection,
} from "./types";

const connection: CalendarConnection = {
  id: "calendar-1",
  tenantId: "tenant-1",
  provider: "ghl",
  externalCalendarId: "provider-calendar-1",
  externalLocationId: "provider-location-1",
  timezone: "America/New_York",
  bookingUrl: "https://calendar.example.test/book",
};

const baseAppointment: AppointmentRecord = {
  tenantId: "tenant-1",
  conversationId: "conversation-1",
  contactId: "contact-1",
  providerContactId: "provider-contact-1",
  leadName: "Jordan Lee",
  channel: "sms",
  leadTimezone: "America/Los_Angeles",
  qualification: {
    creditBand: "680–719",
    fundingGoal: "$50K–100K",
    timeline: "1–3 months",
  },
  isTest: false,
  appointmentId: "appointment-1",
  calendarConnectionId: connection.id,
  calendarTimezone: connection.timezone,
  startAt: "2026-08-16T14:00:00.000Z",
  endAt: "2026-08-16T14:30:00.000Z",
  attributedToAgent: true,
  provider: "ghl",
  externalId: "provider-appointment-1",
  externalLocationId: connection.externalLocationId,
  createdSource: "agent",
  billableEventId: "billable-1",
  status: "scheduled",
  attendanceSource: null,
};

function makeHarness({
  appointment = baseAppointment,
  updateAppointment,
  confirmCoachCommand,
  eventEnqueued = false,
  providerAppointments = [
    {
      externalId: baseAppointment.externalId,
      contactId: baseAppointment.providerContactId,
      startAt: baseAppointment.startAt,
      endAt: baseAppointment.endAt,
      status: "scheduled",
    },
  ],
}: {
  appointment?: AppointmentRecord | null;
  updateAppointment?: CalendarDriver["updateAppointment"];
  confirmCoachCommand?: Parameters<typeof createAppointmentLifecycleService>[0]["confirmCoachCommand"];
  eventEnqueued?: boolean;
  providerAppointments?: Awaited<ReturnType<CalendarDriver["listAppointments"]>>;
} = {}) {
  let state = appointment ? { ...appointment } : null;
  const calls = {
    order: [] as string[],
    updates: [] as Parameters<CalendarDriver["updateAppointment"]>[0][],
    providerCancels: [] as Parameters<CalendarDriver["cancelAppointment"]>[0][],
    localReschedules: [] as Parameters<AppointmentLifecycleRepository["rescheduleAppointment"]>[0][],
    localCancels: [] as Parameters<AppointmentLifecycleRepository["cancelAppointment"]>[0][],
    attendance: [] as Parameters<AppointmentLifecycleRepository["recordAttendance"]>[0][],
    reconciliationQueries: [] as Parameters<
      AppointmentLifecycleRepository["listReconciliationCandidates"]
    >[0][],
    events: [] as BookingDomainEvent[],
  };

  const calendar: CalendarDriver = {
    async fetchSlots() {
      return [];
    },
    async createAppointment() {
      return { externalId: "provider-appointment-1" };
    },
    async updateAppointment(input) {
      calls.order.push("provider:update");
      calls.updates.push(input);
      return updateAppointment
        ? updateAppointment(input)
        : { externalId: baseAppointment.externalId };
    },
    async cancelAppointment(input) {
      calls.order.push("provider:cancel");
      calls.providerCancels.push(input);
    },
    async listAppointments() {
      calls.order.push("provider:list");
      return providerAppointments;
    },
  };

  const repository: AppointmentLifecycleRepository = {
    async getAppointment() {
      return state ? { ...state } : null;
    },
    async rescheduleAppointment(input) {
      calls.order.push("repository:reschedule");
      calls.localReschedules.push(input);
      if (state) state = { ...state, startAt: input.startAt, endAt: input.endAt };
    },
    async cancelAppointment(input) {
      calls.order.push("repository:cancel");
      calls.localCancels.push(input);
      if (state) state = { ...state, status: "canceled" };
      return { eventEnqueued };
    },
    async recordAttendance(input) {
      calls.order.push("repository:attendance");
      calls.attendance.push(input);
      if (state) state = { ...state, status: input.status, attendanceSource: input.source };
    },
    async listReconciliationCandidates(input) {
      calls.reconciliationQueries.push(input);
      return state && (state.status === "scheduled" || state.status === "confirmed")
        ? [{ ...state }]
        : [];
    },
  };

  const service = createAppointmentLifecycleService({
    calendar,
    repository,
    emitDomainEvent: async (event) => void calls.events.push(event),
    confirmCoachCommand,
    now: () => new Date("2026-08-20T14:00:00.000Z"),
  });
  return { service, calls, readState: () => state };
}

describe("appointment lifecycle", () => {
  it("updates the provider before the parent row and preserves appointment and billing identity", async () => {
    const { service, calls, readState } = makeHarness();

    const result = await service.reschedule({
      tenantId: "tenant-1",
      appointmentId: "appointment-1",
      startAt: "2026-08-21T15:00:00.000Z",
      endAt: "2026-08-21T15:30:00.000Z",
      initiatedBy: "coach",
      actorId: "coach-1",
    });

    expect(result).toEqual({ kind: "updated", appointmentId: "appointment-1" });
    expect(calls.order).toEqual(["provider:update", "repository:reschedule"]);
    expect(calls.updates[0]).toEqual({
      locationId: connection.externalLocationId,
      externalId: baseAppointment.externalId,
      startAt: "2026-08-21T15:00:00.000Z",
      endAt: "2026-08-21T15:30:00.000Z",
      timezone: connection.timezone,
    });
    expect(readState()).toMatchObject({
      appointmentId: "appointment-1",
      externalId: "provider-appointment-1",
      billableEventId: "billable-1",
      startAt: "2026-08-21T15:00:00.000Z",
    });
    expect(calls.events.map((event) => event.key)).toEqual(["appointment.rescheduled"]);
  });

  it("refuses a provider response that changes appointment identity before local mutation", async () => {
    const { service, calls } = makeHarness({
      updateAppointment: async () => ({ externalId: "different-provider-id" }),
    });

    await expect(
      service.reschedule({
        tenantId: "tenant-1",
        appointmentId: "appointment-1",
        startAt: "2026-08-21T15:00:00.000Z",
        endAt: "2026-08-21T15:30:00.000Z",
        initiatedBy: "provider",
        actorId: null,
      }),
    ).rejects.toThrow("CALENDAR_RESCHEDULE_IDENTITY_CHANGED");
    expect(calls.localReschedules).toEqual([]);
    expect(calls.events).toEqual([]);
  });

  it("keeps a coach reschedule pending locally until its provider acknowledgement is atomically confirmed", async () => {
    const confirmations: unknown[] = [];
    const { service, calls, readState } = makeHarness({
      confirmCoachCommand: async (input) => {
        confirmations.push(input);
        return { eventEnqueued: false };
      },
    });

    const result = await service.reschedule({
      tenantId: "tenant-1",
      appointmentId: "appointment-1",
      startAt: "2026-08-21T15:00:00.000Z",
      endAt: "2026-08-21T15:30:00.000Z",
      initiatedBy: "coach",
      actorId: "coach-1",
      commandId: "command-1",
    });

    expect(result).toEqual({ kind: "updated", appointmentId: "appointment-1" });
    expect(calls.order).toEqual(["provider:update"]);
    expect(calls.localReschedules).toEqual([]);
    expect(readState()).toMatchObject({ startAt: baseAppointment.startAt, endAt: baseAppointment.endAt });
    expect(confirmations).toEqual([{
      commandId: "command-1", tenantId: "tenant-1", appointmentId: "appointment-1",
      actorId: "coach-1", action: "reschedule", startAt: "2026-08-21T15:00:00.000Z", endAt: "2026-08-21T15:30:00.000Z",
    }]);
  });

  it("cancels at the provider before the shared local cancellation path", async () => {
    const { service, calls } = makeHarness();

    const result = await service.cancel({
      tenantId: "tenant-1",
      appointmentId: "appointment-1",
      source: "coach",
      actorId: "coach-1",
    });

    expect(result).toEqual({ kind: "updated", appointmentId: "appointment-1" });
    expect(calls.order).toEqual(["provider:cancel", "repository:cancel"]);
    expect(calls.localCancels).toEqual([
      {
        tenantId: "tenant-1",
        appointmentId: "appointment-1",
        source: "coach",
        actorId: "coach-1",
      },
    ]);
    expect(calls.events.map((event) => event.key)).toEqual(["appointment.canceled"]);
  });

  it("keeps coach attendance authoritative over later provider evidence", async () => {
    const { service, calls } = makeHarness({
      appointment: { ...baseAppointment, status: "completed", attendanceSource: "coach" },
    });

    const result = await service.recordAttendance({
      tenantId: "tenant-1",
      appointmentId: "appointment-1",
      status: "no_show",
      source: "provider",
      actorId: null,
    });

    expect(result).toEqual({ kind: "ignored", reason: "coach_attendance_authoritative" });
    expect(calls.attendance).toEqual([]);
  });

  it("preserves a non-agent external appointment without inventing a billable row on reschedule", async () => {
    const { service, readState } = makeHarness({
      appointment: {
        ...baseAppointment,
        attributedToAgent: false,
        createdSource: "provider_webhook",
        billableEventId: null,
      },
    });

    await service.reschedule({
      tenantId: "tenant-1",
      appointmentId: "appointment-1",
      startAt: "2026-08-21T15:00:00.000Z",
      endAt: "2026-08-21T15:30:00.000Z",
      initiatedBy: "provider",
      actorId: null,
    });

    expect(readState()).toMatchObject({
      appointmentId: "appointment-1",
      createdSource: "provider_webhook",
      attributedToAgent: false,
      billableEventId: null,
    });
  });

  it("suppresses lifecycle events for test appointments", async () => {
    const { service, calls } = makeHarness({
      appointment: { ...baseAppointment, isTest: true, billableEventId: null },
    });

    await service.cancel({
      tenantId: "tenant-1",
      appointmentId: "appointment-1",
      source: "coach",
      actorId: "coach-1",
    });

    expect(calls.localCancels).toHaveLength(1);
    expect(calls.events).toEqual([]);
  });

  it("does not emit synchronously after the repository atomically enqueues cancellation", async () => {
    const { service, calls } = makeHarness({ eventEnqueued: true });

    await service.cancel({
      tenantId: "tenant-1",
      appointmentId: "appointment-1",
      source: "coach",
      actorId: "coach-1",
    });

    expect(calls.localCancels).toHaveLength(1);
    expect(calls.events).toEqual([]);
  });
});

describe("daily appointment reconciliation", () => {
  it("cancels a provider-missing row through the shared path without a second provider call", async () => {
    const { service, calls } = makeHarness({ providerAppointments: [] });

    const result = await service.reconcileCalendar({ tenantId: "tenant-1", connection });

    expect(result).toEqual({
      checked: 1,
      canceledAppointmentIds: ["appointment-1"],
      rescheduledAppointmentIds: [],
      attendanceInferred: false,
    });
    expect(calls.reconciliationQueries).toEqual([
      {
        tenantId: "tenant-1",
        calendarConnectionId: connection.id,
        startAt: "2026-08-13T14:00:00.000Z",
        endAt: "2026-11-18T14:00:00.000Z",
      },
    ]);
    expect(calls.providerCancels).toEqual([]);
    expect(calls.localCancels[0]).toMatchObject({ source: "provider_missing" });
    expect(calls.events.map((event) => event.key)).toEqual(["appointment.canceled"]);
  });

  it("leaves a past scheduled appointment unknown when the provider still has it", async () => {
    const { service, calls, readState } = makeHarness();

    const result = await service.reconcileCalendar({ tenantId: "tenant-1", connection });

    expect(result).toEqual({
      checked: 1,
      canceledAppointmentIds: [],
      rescheduledAppointmentIds: [],
      attendanceInferred: false,
    });
    expect(calls.attendance).toEqual([]);
    expect(readState()).toMatchObject({ status: "scheduled", attendanceSource: null });
  });

  it("does not accept an external-id match that belongs to another provider contact", async () => {
    const { service, calls } = makeHarness({
      providerAppointments: [{
        externalId: baseAppointment.externalId,
        contactId: "different-provider-contact",
        startAt: baseAppointment.startAt,
        endAt: baseAppointment.endAt,
        status: "scheduled",
      }],
    });

    const result = await service.reconcileCalendar({ tenantId: "tenant-1", connection });

    expect(result.canceledAppointmentIds).toEqual([baseAppointment.appointmentId]);
    expect(calls.localCancels[0]).toMatchObject({ source: "provider_missing" });
  });

  it("adopts a provider move without sending a second calendar update", async () => {
    const movedStart = "2026-08-22T15:00:00.000Z";
    const movedEnd = "2026-08-22T15:30:00.000Z";
    const { service, calls, readState } = makeHarness({
      providerAppointments: [{
        externalId: baseAppointment.externalId,
        contactId: baseAppointment.providerContactId,
        startAt: movedStart,
        endAt: movedEnd,
        status: "scheduled",
      }],
    });

    const result = await service.reconcileCalendar({ tenantId: "tenant-1", connection });

    expect(result.rescheduledAppointmentIds).toEqual(["appointment-1"]);
    expect(calls.updates).toEqual([]);
    expect(calls.localReschedules).toEqual([{
      tenantId: "tenant-1", appointmentId: "appointment-1", startAt: movedStart, endAt: movedEnd,
      initiatedBy: "provider", actorId: null,
    }]);
    expect(readState()).toMatchObject({ startAt: movedStart, endAt: movedEnd });
  });

  it("treats a provider-canceled identity match as absent", async () => {
    const { service, calls } = makeHarness({
      providerAppointments: [{
        externalId: baseAppointment.externalId,
        contactId: baseAppointment.providerContactId,
        startAt: baseAppointment.startAt,
        endAt: baseAppointment.endAt,
        status: "canceled",
      }],
    });

    const result = await service.reconcileCalendar({ tenantId: "tenant-1", connection });

    expect(result.canceledAppointmentIds).toEqual([baseAppointment.appointmentId]);
    expect(calls.localCancels[0]).toMatchObject({ source: "provider_missing" });
  });

  it("reconciles a future appointment inside the bounded ninety-day horizon", async () => {
    const future = {
      ...baseAppointment,
      startAt: "2026-10-20T14:00:00.000Z",
      endAt: "2026-10-20T14:30:00.000Z",
    };
    const { service, calls } = makeHarness({ appointment: future, providerAppointments: [] });

    const result = await service.reconcileCalendar({ tenantId: "tenant-1", connection });

    expect(result.canceledAppointmentIds).toEqual([future.appointmentId]);
    expect(calls.reconciliationQueries[0]).toMatchObject({
      startAt: "2026-08-13T14:00:00.000Z",
      endAt: "2026-11-18T14:00:00.000Z",
    });
  });
});
