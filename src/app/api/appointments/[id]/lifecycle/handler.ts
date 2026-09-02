import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import {
  AppointmentProviderCommandError,
  createAppointmentLifecycleService,
} from "@/lib/booking/reconcile";
import type { AppointmentLifecycleRepository, AppointmentRecord } from "@/lib/booking/types";
import { appointmentLifecycleLive } from "@/lib/env-contract";
import { createMockCalendarDriver, createRealCalendarDriver } from "@/lib/integrations/calendar";
import { resolveGhlLocationAccessToken } from "@/lib/integrations/ghl-oauth-store";
import { selectCalendarDriver } from "@/lib/integrations/selector";
import { createBookingEventEmitter, createNotificationRepository } from "@/lib/notifications/events";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };
const ACTIONS = ["cancel", "reschedule"] as const;

type Action = typeof ACTIONS[number];
type CommandReceipt = {
  commandId: string;
  tenantId: string;
  appointmentId: string;
  action: Action;
  state: "pending" | "confirmed" | "failed";
  auditId: number;
  outboxEventId?: string | null;
};
type CommandBody =
  | { action: "cancel"; reason: string; idempotencyKey: string; expectedVersion: string }
  | { action: "reschedule"; reason: string; idempotencyKey: string; expectedVersion: string; startAt: string; endAt: string };
type CommandRpcRow = {
  command_id: string;
  tenant_id: string;
  appointment_id: string;
  action: Action;
  state: CommandReceipt["state"];
  audit_id: number;
  outbox_event_id?: string | null;
};

export type AppointmentLifecycleCommandDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  record(input: CommandBody & { tenantId: string; appointmentId: string; actorId: string }): Promise<CommandReceipt>;
  dispatch(input: CommandBody & { tenantId: string; appointmentId: string; actorId: string; commandId: string }): Promise<CommandReceipt>;
  fail(input: { tenantId: string; commandId: string; actorId: string; failureCode: string }): Promise<CommandReceipt>;
};

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validInstant(value: string) {
  return Number.isFinite(new Date(value).getTime());
}

function parse(value: unknown): CommandBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const action = text(body.action);
  const reason = text(body.reason);
  const idempotencyKey = text(body.idempotencyKey);
  const expectedVersion = text(body.expectedVersion);
  if (!action || !ACTIONS.includes(action as Action) || !reason || reason.length > 500
    || !idempotencyKey || idempotencyKey.length > 128
    || !expectedVersion || !validInstant(expectedVersion)) return null;
  if (action === "cancel" && Object.keys(body).sort().join(",") === "action,expectedVersion,idempotencyKey,reason") {
    return { action, reason, idempotencyKey, expectedVersion };
  }
  const startAt = text(body.startAt);
  const endAt = text(body.endAt);
  if (action !== "reschedule" || Object.keys(body).sort().join(",") !== "action,endAt,expectedVersion,idempotencyKey,reason,startAt"
    || !startAt || !endAt || !validInstant(startAt) || !validInstant(endAt)
    || new Date(endAt).getTime() <= new Date(startAt).getTime()) return null;
  return { action, reason, idempotencyKey, expectedVersion, startAt, endAt };
}

function response(receipt: CommandReceipt, status = 200) {
  return json({
    command: { id: receipt.commandId, action: receipt.action, state: receipt.state },
    effect: {
      status: receipt.state,
      providerConfirmation: receipt.state === "confirmed" ? "confirmed" : receipt.state === "failed" ? "rejected" : "pending",
    },
    audit: { id: receipt.auditId },
  }, status);
}

function validReceipt(value: unknown): value is CommandRpcRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.command_id === "string" && typeof row.tenant_id === "string"
    && typeof row.appointment_id === "string" && ACTIONS.includes(row.action as Action)
    && (row.state === "pending" || row.state === "confirmed" || row.state === "failed")
    && Number.isSafeInteger(row.audit_id) && Number(row.audit_id) > 0;
}

function receipt(value: unknown): CommandReceipt {
  const row = Array.isArray(value) ? value[0] : value;
  if (!validReceipt(row)) throw new Error("APPOINTMENT_LIFECYCLE_READBACK_INVALID");
  return {
    commandId: row.command_id,
    tenantId: row.tenant_id,
    appointmentId: row.appointment_id,
    action: row.action as Action,
    state: row.state,
    auditId: Number(row.audit_id),
    outboxEventId: typeof row.outbox_event_id === "string" ? row.outbox_event_id : null,
  };
}

function mapAppointment(row: Record<string, unknown>): AppointmentRecord {
  const contact = row.contacts as Record<string, unknown> | null;
  const connection = row.calendar_connections as Record<string, unknown> | null;
  if (!contact || !connection || typeof row.id !== "string" || typeof row.tenant_id !== "string"
    || typeof row.contact_id !== "string" || typeof row.external_id !== "string"
    || typeof connection.external_location_id !== "string" || typeof connection.timezone !== "string") {
    throw new Error("APPOINTMENT_LIFECYCLE_CONTEXT_INCOMPLETE");
  }
  if (row.provider === "ghl" && typeof contact.ghl_contact_id !== "string") {
    throw new Error("APPOINTMENT_PROVIDER_CONTACT_MISSING");
  }
  return {
    tenantId: row.tenant_id,
    conversationId: typeof row.conversation_id === "string" ? row.conversation_id : "",
    contactId: row.contact_id,
    providerContactId: row.provider === "ghl" ? contact.ghl_contact_id as string : row.contact_id,
    leadName: typeof contact.name === "string" ? contact.name : "Unknown lead",
    channel: contact.last_channel as AppointmentRecord["channel"],
    leadTimezone: typeof contact.timezone === "string" ? contact.timezone : null,
    qualification: {
      creditBand: typeof contact.credit_range === "string" ? contact.credit_range : null,
      fundingGoal: typeof contact.funding_goal === "string" ? contact.funding_goal : null,
      timeline: typeof contact.timeline === "string" ? contact.timeline : null,
    },
    isTest: row.is_test === true,
    appointmentId: row.id,
    calendarConnectionId: connection.id as string,
    calendarTimezone: connection.timezone,
    startAt: row.start_at as string,
    endAt: row.end_at as string,
    attributedToAgent: row.attributed_to_agent === true,
    provider: row.provider as AppointmentRecord["provider"],
    externalId: row.external_id,
    externalLocationId: connection.external_location_id,
    createdSource: row.created_source as AppointmentRecord["createdSource"],
    billableEventId: Array.isArray(row.billable_events) && typeof row.billable_events[0]?.id === "string"
      ? row.billable_events[0].id : null,
    status: row.status as AppointmentRecord["status"],
    attendanceSource: row.attendance_source as AppointmentRecord["attendanceSource"],
  };
}

export function createAppointmentLifecycleCommandHandler(dependencies: AppointmentLifecycleCommandDependencies) {
  return async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    if (!dependencies.enabled()) return json({ error: "Not found." }, 404);
    const actor = await dependencies.session();
    if (!actor) return json({ error: "Authentication required." }, 401);
    if (hasImpersonationMarker(actor) || actor.role !== "coach") return json({ error: "Forbidden." }, 403);
    const body = parse(await request.json().catch(() => null));
    const appointmentId = (await context.params).id.trim();
    if (!body || !appointmentId) return json({ error: "Appointment lifecycle command is invalid." }, 400);

    let command: CommandReceipt | null = null;
    try {
      command = await dependencies.record({ ...body, tenantId: actor.tenantId, appointmentId, actorId: actor.userId });
      if (command.tenantId !== actor.tenantId || command.appointmentId !== appointmentId || command.action !== body.action) {
        throw new Error("APPOINTMENT_LIFECYCLE_SCOPE_READBACK_INVALID");
      }
      if (command.state === "confirmed") return response(command);
      if (command.state === "failed") return response(command, 409);
      const confirmed = await dependencies.dispatch({ ...body, tenantId: actor.tenantId, appointmentId, actorId: actor.userId, commandId: command.commandId });
      if (confirmed.state !== "confirmed") throw new Error("APPOINTMENT_LIFECYCLE_CONFIRMATION_PENDING");
      return response(confirmed);
    } catch (error) {
      if (!command && error instanceof Error && error.message.includes("APPOINTMENT_LIFECYCLE_STALE_VERSION")) {
        return json({
          code: "APPOINTMENT_LIFECYCLE_STALE_VERSION",
          error: "The appointment changed after this page loaded. Refresh it before trying again.",
        }, 409);
      }
      if (error instanceof AppointmentProviderCommandError) {
        if (!command) return json({ error: "The calendar rejected this command before it could be recorded." }, 503);
        try {
          const failed = await dependencies.fail({
            tenantId: actor.tenantId,
            commandId: command.commandId,
            actorId: actor.userId,
            failureCode: error.message,
          });
          return response(failed, 409);
        } catch {
          return json({ error: "The calendar rejected this command, and its failure receipt is unavailable." }, 503);
        }
      }
      return json({ error: "The request is pending provider confirmation. Refresh before retrying." }, 503);
    }
  };
}

async function recordCommand(input: CommandBody & { tenantId: string; appointmentId: string; actorId: string }) {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.rpc("record_appointment_lifecycle_command", {
    p_expected_tenant: input.tenantId, p_appointment_id: input.appointmentId, p_actor_id: input.actorId,
    p_action: input.action, p_reason: input.reason, p_idempotency_key: input.idempotencyKey,
    p_expected_appointment_updated_at: input.expectedVersion,
    p_requested_start_at: input.action === "reschedule" ? input.startAt : null,
    p_requested_end_at: input.action === "reschedule" ? input.endAt : null,
  });
  if (error) throw new Error(`APPOINTMENT_LIFECYCLE_COMMAND_REFUSED:${error.message}`);
  return receipt(data);
}

async function dispatchCommand(input: CommandBody & { tenantId: string; appointmentId: string; actorId: string; commandId: string }) {
  const client = createSupabaseServiceClient();
  let confirmed: CommandReceipt | null = null;
  const repository: AppointmentLifecycleRepository = {
    getAppointment: async (tenantId, appointmentId) => {
      const { data, error } = await client.from("appointments").select(`
        id, tenant_id, conversation_id, contact_id, provider, external_id, start_at, end_at,
        created_source, attributed_to_agent, is_test, status, attendance_source,
        billable_events(id), contacts!inner(name, last_channel, timezone, ghl_contact_id, credit_range, funding_goal, timeline),
        calendar_connections!inner(id, external_location_id, timezone)
      `).eq("tenant_id", tenantId).eq("id", appointmentId).maybeSingle();
      if (error) throw new Error("APPOINTMENT_LIFECYCLE_READ_FAILED");
      return data ? mapAppointment(data as Record<string, unknown>) : null;
    },
    rescheduleAppointment: async () => { throw new Error("COACH_LIFECYCLE_CONFIRMATION_REQUIRED"); },
    cancelAppointment: async () => { throw new Error("COACH_LIFECYCLE_CONFIRMATION_REQUIRED"); },
    recordAttendance: async () => undefined,
    listReconciliationCandidates: async () => [],
  };
  const lifecycle = createAppointmentLifecycleService({
    calendar: selectCalendarDriver({ factories: {
      mock: createMockCalendarDriver,
      real: () => createRealCalendarDriver({ getLocationAccessToken: resolveGhlLocationAccessToken }),
    } }),
    repository,
    emitDomainEvent: createBookingEventEmitter(createNotificationRepository()),
    confirmCoachCommand: async () => {
      const { data, error } = await client.rpc("confirm_appointment_lifecycle_command", {
        p_expected_tenant: input.tenantId, p_command_id: input.commandId, p_actor_id: input.actorId,
      });
      if (error) throw new Error(`APPOINTMENT_LIFECYCLE_CONFIRMATION_REFUSED:${error.message}`);
      confirmed = receipt(data);
      return { eventEnqueued: Boolean(confirmed.outboxEventId) };
    },
  });
  if (input.action === "cancel") {
    await lifecycle.cancel({ tenantId: input.tenantId, appointmentId: input.appointmentId, source: "coach", actorId: input.actorId, commandId: input.commandId });
  } else {
    await lifecycle.reschedule({ tenantId: input.tenantId, appointmentId: input.appointmentId, startAt: input.startAt, endAt: input.endAt, initiatedBy: "coach", actorId: input.actorId, commandId: input.commandId });
  }
  if (!confirmed) throw new Error("APPOINTMENT_LIFECYCLE_CONFIRMATION_MISSING");
  return confirmed;
}

async function failCommand(input: { tenantId: string; commandId: string; actorId: string; failureCode: string }) {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.rpc("fail_appointment_lifecycle_command", {
    p_expected_tenant: input.tenantId, p_command_id: input.commandId, p_actor_id: input.actorId, p_failure_code: input.failureCode,
  });
  if (error) throw new Error("APPOINTMENT_LIFECYCLE_FAILURE_REFUSED");
  return receipt(data);
}

export const POST = createAppointmentLifecycleCommandHandler({
  enabled: appointmentLifecycleLive,
  session: loadRouteActor,
  record: recordCommand,
  dispatch: dispatchCommand,
  fail: failCommand,
});
