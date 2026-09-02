/**
 * One appointment lifecycle for human, provider, and reconciliation edits.
 *
 * Reschedules and explicit cancellations update the provider before local state. Provider absence
 * uses the same local cancellation path without pretending a second provider call can find a row
 * the authoritative list has already shown missing. Time passing never supplies attendance evidence.
 */

import type { CalendarDriver } from "@/lib/integrations/types";

import type {
  AppointmentLifecycleRepository,
  AppointmentEventDetails,
  AppointmentRecord,
  AttendanceSource,
  BookingDomainEvent,
  CalendarConnection,
  CancellationSource,
} from "./types";

export const RECONCILIATION_LOOKBACK_DAYS = 7;
export const RECONCILIATION_LOOKAHEAD_DAYS = 90;

type LifecycleDependencies = {
  calendar: CalendarDriver;
  repository: AppointmentLifecycleRepository;
  emitDomainEvent: (event: BookingDomainEvent) => Promise<unknown>;
  /**
   * Coach commands persist their intent before calling the provider. The route supplies this
   * confirmation seam so the local mutation and its audited receipt happen only after a provider
   * acknowledgement (or an authoritative reconciliation read-back) exists.
   */
  confirmCoachCommand?: (input: {
    commandId: string;
    tenantId: string;
    appointmentId: string;
    actorId: string;
    action: "cancel" | "reschedule";
    startAt?: string;
    endAt?: string;
  }) => Promise<{ eventEnqueued: boolean }>;
  now?: () => Date;
};

type LifecycleResult =
  | { kind: "updated"; appointmentId: string }
  | { kind: "ignored"; reason: "already_canceled" | "coach_attendance_authoritative" }
  | { kind: "not_found" };

/** A calendar refusal is safe to persist as a failed coach intent; local confirmation errors are not. */
export class AppointmentProviderCommandError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "AppointmentProviderCommandError";
  }
}

function appointmentEventDetails(appointment: AppointmentRecord): AppointmentEventDetails {
  return {
    tenantId: appointment.tenantId,
    conversationId: appointment.conversationId,
    contactId: appointment.contactId,
    providerContactId: appointment.providerContactId,
    leadName: appointment.leadName,
    channel: appointment.channel,
    leadTimezone: appointment.leadTimezone,
    qualification: appointment.qualification,
    isTest: appointment.isTest,
    appointmentId: appointment.appointmentId,
    calendarConnectionId: appointment.calendarConnectionId,
    calendarTimezone: appointment.calendarTimezone,
    startAt: appointment.startAt,
    endAt: appointment.endAt,
    attributedToAgent: appointment.attributedToAgent,
  };
}

export function createAppointmentLifecycleService({
  calendar,
  repository,
  emitDomainEvent,
  confirmCoachCommand,
  now = () => new Date(),
}: LifecycleDependencies) {
  async function reschedule(input: {
    tenantId: string;
    appointmentId: string;
    startAt: string;
    endAt: string;
    initiatedBy: "lead" | "coach" | "agent" | "provider";
    actorId: string | null;
    commandId?: string;
  }): Promise<LifecycleResult> {
    const appointment = await repository.getAppointment(input.tenantId, input.appointmentId);
    if (!appointment) return { kind: "not_found" };

    let providerResult: { externalId: string };
    try {
      providerResult = await calendar.updateAppointment({
        locationId: appointment.externalLocationId,
        externalId: appointment.externalId,
        startAt: input.startAt,
        endAt: input.endAt,
        timezone: appointment.calendarTimezone,
      });
    } catch {
      throw new AppointmentProviderCommandError("CALENDAR_RESCHEDULE_REJECTED");
    }
    if (providerResult.externalId !== appointment.externalId) {
      throw new AppointmentProviderCommandError("CALENDAR_RESCHEDULE_IDENTITY_CHANGED");
    }

    if (input.commandId) {
      if (input.initiatedBy !== "coach" || !input.actorId || !confirmCoachCommand) {
        throw new Error("COACH_LIFECYCLE_CONFIRMATION_REQUIRED");
      }
      await confirmCoachCommand({
        commandId: input.commandId,
        tenantId: input.tenantId,
        appointmentId: input.appointmentId,
        actorId: input.actorId,
        action: "reschedule",
        startAt: input.startAt,
        endAt: input.endAt,
      });
    } else {
      await repository.rescheduleAppointment(input);
    }
    if (!appointment.isTest) {
      await emitDomainEvent({
        key: "appointment.rescheduled",
        ...appointmentEventDetails(appointment),
        startAt: input.startAt,
        endAt: input.endAt,
        priorStartAt: appointment.startAt,
        priorEndAt: appointment.endAt,
      });
    }
    return { kind: "updated", appointmentId: appointment.appointmentId };
  }

  async function cancelLoadedAppointment(
    appointment: AppointmentRecord,
    input: { source: CancellationSource; actorId: string | null },
  ): Promise<LifecycleResult> {
    if (appointment.status === "canceled") {
      return { kind: "ignored", reason: "already_canceled" };
    }
    if (input.source !== "provider_missing") {
      try {
        await calendar.cancelAppointment({
          locationId: appointment.externalLocationId,
          externalId: appointment.externalId,
        });
      } catch {
        throw new AppointmentProviderCommandError("CALENDAR_CANCEL_REJECTED");
      }
    }
    const persistence = await repository.cancelAppointment({
      tenantId: appointment.tenantId,
      appointmentId: appointment.appointmentId,
      source: input.source,
      actorId: input.actorId,
    });
    if (!appointment.isTest && !persistence.eventEnqueued) {
      await emitDomainEvent({
        key: "appointment.canceled",
        ...appointmentEventDetails(appointment),
        cancelSource: input.source,
      });
    }
    return { kind: "updated", appointmentId: appointment.appointmentId };
  }

  async function cancel(input: {
    tenantId: string;
    appointmentId: string;
    source: Exclude<CancellationSource, "provider_missing">;
    actorId: string | null;
    commandId?: string;
  }): Promise<LifecycleResult> {
    const appointment = await repository.getAppointment(input.tenantId, input.appointmentId);
    if (!appointment) return { kind: "not_found" };
    if (input.commandId) {
      if (input.source !== "coach" || !input.actorId || !confirmCoachCommand) {
        throw new Error("COACH_LIFECYCLE_CONFIRMATION_REQUIRED");
      }
      if (appointment.status === "canceled") {
        await confirmCoachCommand({
          commandId: input.commandId,
          tenantId: input.tenantId,
          appointmentId: input.appointmentId,
          actorId: input.actorId,
          action: "cancel",
        });
        return { kind: "ignored", reason: "already_canceled" };
      }
      await calendar.cancelAppointment({
        locationId: appointment.externalLocationId,
        externalId: appointment.externalId,
      });
      const confirmation = await confirmCoachCommand({
        commandId: input.commandId,
        tenantId: input.tenantId,
        appointmentId: input.appointmentId,
        actorId: input.actorId,
        action: "cancel",
      });
      if (!appointment.isTest && !confirmation.eventEnqueued) {
        await emitDomainEvent({
          key: "appointment.canceled",
          ...appointmentEventDetails(appointment),
          cancelSource: input.source,
        });
      }
      return { kind: "updated", appointmentId: appointment.appointmentId };
    }
    return cancelLoadedAppointment(appointment, input);
  }

  async function recordAttendance(input: {
    tenantId: string;
    appointmentId: string;
    status: "completed" | "no_show";
    source: AttendanceSource;
    actorId: string | null;
  }): Promise<LifecycleResult> {
    const appointment = await repository.getAppointment(input.tenantId, input.appointmentId);
    if (!appointment) return { kind: "not_found" };
    if (appointment.attendanceSource === "coach" && input.source !== "coach") {
      return { kind: "ignored", reason: "coach_attendance_authoritative" };
    }
    await repository.recordAttendance(input);
    return { kind: "updated", appointmentId: appointment.appointmentId };
  }

  async function reconcileCalendar(input: {
    tenantId: string;
    connection: CalendarConnection;
  }) {
    if (input.connection.tenantId !== input.tenantId) {
      throw new Error("CALENDAR_CONNECTION_TENANT_MISMATCH");
    }
    const end = now();
    const start = new Date(end.getTime() - RECONCILIATION_LOOKBACK_DAYS * 24 * 60 * 60_000);
    const rangeEnd = new Date(
      end.getTime() + RECONCILIATION_LOOKAHEAD_DAYS * 24 * 60 * 60_000,
    );
    const candidates = await repository.listReconciliationCandidates({
      tenantId: input.tenantId,
      calendarConnectionId: input.connection.id,
      startAt: start.toISOString(),
      endAt: rangeEnd.toISOString(),
    });
    const providerAppointments = await calendar.listAppointments({
      locationId: input.connection.externalLocationId,
      calendarId: input.connection.externalCalendarId,
      startAt: start.toISOString(),
      endAt: rangeEnd.toISOString(),
    });
    const providerAppointmentsById = new Map(
      providerAppointments.map((appointment) => [appointment.externalId, appointment]),
    );
    const canceledAppointmentIds: string[] = [];
    const rescheduledAppointmentIds: string[] = [];

    for (const appointment of candidates) {
      if (
        appointment.tenantId !== input.tenantId ||
        appointment.calendarConnectionId !== input.connection.id
      ) {
        throw new Error("RECONCILIATION_APPOINTMENT_SCOPE_MISMATCH");
      }
      const providerAppointment = providerAppointmentsById.get(appointment.externalId);
      if (providerAppointment?.contactId === appointment.providerContactId && providerAppointment.status !== "canceled") {
        if (providerAppointment.startAt !== appointment.startAt || providerAppointment.endAt !== appointment.endAt) {
          // A provider read-back is authoritative for an external move. If it races a coach
          // command, that command's later provider acknowledgement confirms its requested time
          // through the command RPC; a provider rejection leaves this read-back intact.
          await repository.rescheduleAppointment({
            tenantId: appointment.tenantId,
            appointmentId: appointment.appointmentId,
            startAt: providerAppointment.startAt,
            endAt: providerAppointment.endAt,
            initiatedBy: "provider",
            actorId: null,
          });
          rescheduledAppointmentIds.push(appointment.appointmentId);
        }
        continue;
      }
      const result = await cancelLoadedAppointment(appointment, {
        source: "provider_missing",
        actorId: null,
      });
      if (result.kind === "updated") canceledAppointmentIds.push(appointment.appointmentId);
    }

    return {
      checked: candidates.length,
      canceledAppointmentIds,
      rescheduledAppointmentIds,
      // Provider statuses are evidence only when explicitly mapped through recordAttendance.
      attendanceInferred: false as const,
    };
  }

  return { reschedule, cancel, recordAttendance, reconcileCalendar };
}
