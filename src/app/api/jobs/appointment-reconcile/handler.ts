import { accessToken, safeEqual } from "@/lib/access";
import { createAppointmentLifecycleService } from "@/lib/booking/reconcile";
import type {
  AppointmentLifecycleRepository,
  BookingDomainEvent,
  CalendarConnection,
} from "@/lib/booking/types";
import { phase1Live } from "@/lib/env-contract";
import { createMockCalendarDriver, createRealCalendarDriver } from "@/lib/integrations/calendar";
import { resolveGhlLocationAccessToken } from "@/lib/integrations/ghl-oauth-store";
import { selectCalendarDriver } from "@/lib/integrations/selector";
import { runJobWithReceipt, type JobReceiptExecution } from "@/lib/jobs/job-receipts";
import { createBookingEventEmitter, createNotificationRepository } from "@/lib/notifications/events";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const CONNECTION_LIMIT = 25;
const OUTBOX_LIMIT = 25;
const noStoreHeaders = { "Cache-Control": "no-store" };

export const APPOINTMENT_RECONCILE_JOB = "phase1-appointment-reconcile-daily";

type AppointmentJobDependencies = {
  secret: string | null;
  execute?: JobReceiptExecution;
  reconcile(limit: number): Promise<{
    connections: number;
    checked: number;
    canceled: number;
    failed: number;
    outboxDispatched: number;
    outboxFailed: number;
  }>;
};

async function authorized(request: Request, secret: string | null) {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [candidateHash, secretHash] = await Promise.all([
    accessToken(candidate),
    accessToken(secret),
  ]);
  return safeEqual(candidateHash, secretHash);
}

export function createAppointmentReconcileHandler(dependencies: AppointmentJobDependencies) {
  return async function GET(request: Request) {
    if (!phase1Live()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    if (!(await authorized(request, dependencies.secret))) {
      return Response.json({ error: "Unauthorized." }, { status: 401, headers: noStoreHeaders });
    }
    const work = () => dependencies.reconcile(CONNECTION_LIMIT);
    return Response.json(
      await (dependencies.execute ? dependencies.execute("appointment-reconcile", work) : work()),
      { headers: noStoreHeaders },
    );
  };
}

async function reconcileAppointments(limit: number) {
  const client = createSupabaseServiceClient();
  const emitDomainEvent = createBookingEventEmitter(createNotificationRepository());
  async function dispatchOutbox() {
    const { data: events, error: claimError } = await client.rpc(
      "claim_booking_lifecycle_outbox",
      { p_limit: OUTBOX_LIMIT, p_now: new Date().toISOString() },
    );
    if (claimError) throw new Error(`BOOKING_OUTBOX_CLAIM_FAILED:${claimError.message}`);
    let dispatched = 0;
    let failed = 0;
    for (const event of events ?? []) {
      let succeeded = false;
      let dispatchError: string | null = null;
      try {
        if (event.event_payload?.key !== "appointment.canceled") {
          throw new Error("BOOKING_OUTBOX_EVENT_INVALID");
        }
        await emitDomainEvent(event.event_payload as BookingDomainEvent);
        succeeded = true;
        dispatched += 1;
      } catch (cause) {
        failed += 1;
        dispatchError = cause instanceof Error ? cause.message : String(cause);
      }
      const { error: finishError } = await client.rpc("finish_booking_lifecycle_outbox", {
        p_event_id: event.event_id,
        p_claim_token: event.event_claim_token,
        p_succeeded: succeeded,
        p_error: dispatchError?.slice(0, 240) ?? null,
        p_now: new Date().toISOString(),
      });
      if (finishError) throw new Error(`BOOKING_OUTBOX_FINISH_FAILED:${finishError.message}`);
    }
    return { dispatched, failed };
  }
  const priorOutbox = await dispatchOutbox();
  const claimedAt = new Date().toISOString();
  const { data, error } = await client.rpc("claim_calendar_reconciliation", {
    p_limit: limit,
    p_now: claimedAt,
  });
  if (error) throw new Error(`CALENDAR_CONNECTION_CLAIM_FAILED:${error.message}`);
  const calendar = selectCalendarDriver({
    factories: {
      mock: createMockCalendarDriver,
      real: () => createRealCalendarDriver({
        getLocationAccessToken: resolveGhlLocationAccessToken,
      }),
    },
  });
  let checked = 0;
  let canceled = 0;
  let failed = 0;

  for (const row of data ?? []) {
    const connection: CalendarConnection = {
      id: row.id,
      tenantId: row.tenant_id,
      provider: row.provider,
      externalCalendarId: row.external_calendar_id,
      externalLocationId: row.external_location_id,
      timezone: row.timezone,
      bookingUrl: row.booking_url,
    };
    const repository: AppointmentLifecycleRepository = {
      getAppointment: async () => null,
      rescheduleAppointment: async (input) => {
        const { error: rpcError } = await client.rpc("reschedule_appointment", {
          p_expected_tenant: input.tenantId,
          p_appointment_id: input.appointmentId,
          p_to_start_at: input.startAt,
          p_to_end_at: input.endAt,
          // The provider has already moved this event; reconciliation records its
          // authoritative read-back directly instead of creating a pending coach intent.
          p_initiated_by: input.initiatedBy,
          p_actor_id: input.actorId,
        });
        if (rpcError) throw new Error(`RESCHEDULE_APPOINTMENT_FAILED:${rpcError.message}`);
      },
      recordAttendance: async (input) => {
        const functionName = input.source === "coach"
          ? "record_appointment_attendance"
          : "record_appointment_attendance_system";
        const args = input.source === "coach"
          ? {
              p_expected_tenant: input.tenantId,
              p_appointment_id: input.appointmentId,
              p_status: input.status,
              p_source: input.source,
              p_actor_id: input.actorId,
            }
          : {
              p_expected_tenant: input.tenantId,
              p_appointment_id: input.appointmentId,
              p_status: input.status,
              p_source: input.source,
            };
        const { error: rpcError } = await client.rpc(functionName, args);
        if (rpcError) throw new Error(`RECORD_ATTENDANCE_FAILED:${rpcError.message}`);
      },
      cancelAppointment: async (input) => {
        const { data: result, error: rpcError } = await client.rpc("cancel_appointment_with_outbox", {
          p_expected_tenant: input.tenantId,
          p_appointment_id: input.appointmentId,
          p_cancel_source: input.source,
          p_actor_id: input.actorId,
        });
        if (rpcError) throw new Error(`CANCEL_APPOINTMENT_FAILED:${rpcError.message}`);
        const persisted = Array.isArray(result) ? result[0] : result;
        return { eventEnqueued: Boolean(persisted?.outbox_event_id) };
      },
      listReconciliationCandidates: async (input) => {
        const { data: appointments, error: appointmentError } = await client
          .from("appointments")
          .select(`
            id, tenant_id, conversation_id, contact_id, provider, external_id, start_at, end_at,
            timezone, created_source, attributed_to_agent, is_test, status, attendance_source,
            billable_events(id), contacts!inner(
              name, last_channel, timezone, ghl_contact_id, credit_range, funding_goal, timeline
            ),
            calendar_connections!inner(id, external_location_id, timezone)
          `)
          .eq("tenant_id", input.tenantId)
          .eq("calendar_connection_id", input.calendarConnectionId)
          .neq("status", "canceled")
          .gte("start_at", input.startAt)
          .lte("start_at", input.endAt);
        if (appointmentError) throw new Error(`APPOINTMENT_RECONCILE_READ_FAILED:${appointmentError.message}`);
        return (appointments ?? []).map((appointment) => {
          const contact = appointment.contacts as unknown as {
            name: string | null; last_channel: "sms" | "instagram" | "messenger" | "whatsapp";
            timezone: string | null; ghl_contact_id: string | null;
            credit_range: string | null; funding_goal: string | null; timeline: string | null;
          };
          const calendarConnection = appointment.calendar_connections as unknown as {
            id: string; external_location_id: string; timezone: string;
          };
          if (appointment.provider === "ghl" && !contact.ghl_contact_id) {
            throw new Error("APPOINTMENT_PROVIDER_CONTACT_MISSING");
          }
          return {
            tenantId: appointment.tenant_id,
            conversationId: appointment.conversation_id,
            contactId: appointment.contact_id,
            providerContactId: contact.ghl_contact_id ?? appointment.contact_id,
            leadName: contact.name ?? "Unknown lead",
            channel: contact.last_channel,
            leadTimezone: contact.timezone,
            qualification: {
              creditBand: contact.credit_range,
              fundingGoal: contact.funding_goal,
              timeline: contact.timeline,
            },
            isTest: appointment.is_test,
            appointmentId: appointment.id,
            calendarConnectionId: calendarConnection.id,
            calendarTimezone: calendarConnection.timezone,
            startAt: appointment.start_at,
            endAt: appointment.end_at,
            attributedToAgent: appointment.attributed_to_agent,
            provider: appointment.provider,
            externalId: appointment.external_id,
            externalLocationId: calendarConnection.external_location_id,
            createdSource: appointment.created_source,
            billableEventId: appointment.billable_events?.[0]?.id ?? null,
            status: appointment.status,
            attendanceSource: appointment.attendance_source,
          };
        });
      },
    };
    const lifecycle = createAppointmentLifecycleService({
      calendar,
      repository,
      emitDomainEvent,
    });
    try {
      const result = await lifecycle.reconcileCalendar({ tenantId: connection.tenantId, connection });
      checked += result.checked;
      canceled += result.canceledAppointmentIds.length;
      const { error: finishError } = await client.rpc("finish_calendar_reconciliation", {
        p_connection_id: connection.id,
        p_claim_token: row.reconcile_claim_token,
        p_succeeded: true,
        p_error: null,
        p_now: new Date().toISOString(),
      });
      if (finishError) throw new Error(`CALENDAR_RECONCILIATION_FINISH_FAILED:${finishError.message}`);
    } catch (cause) {
      failed += 1;
      const message = cause instanceof Error ? cause.message : String(cause);
      const { error: finishError } = await client.rpc("finish_calendar_reconciliation", {
        p_connection_id: connection.id,
        p_claim_token: row.reconcile_claim_token,
        p_succeeded: false,
        p_error: message.slice(0, 240),
        p_now: new Date().toISOString(),
      });
      if (finishError) throw new Error(`CALENDAR_RECONCILIATION_FINISH_FAILED:${finishError.message}`);
    }
  }
  const currentOutbox = await dispatchOutbox();
  return {
    connections: data?.length ?? 0,
    checked,
    canceled,
    failed,
    outboxDispatched: priorOutbox.dispatched + currentOutbox.dispatched,
    outboxFailed: priorOutbox.failed + currentOutbox.failed,
  };
}

export const GET = createAppointmentReconcileHandler({
  secret: process.env.CRON_SECRET?.trim() || null,
  execute: runJobWithReceipt,
  reconcile: reconcileAppointments,
});
