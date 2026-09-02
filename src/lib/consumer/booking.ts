import { createBookingService } from "@/lib/booking/service";
import type { BookingRepository, ProposedSlotSet } from "@/lib/booking/types";
import { createMockCalendarDriver, createRealCalendarDriver } from "@/lib/integrations/calendar";
import { resolveGhlLocationAccessToken } from "@/lib/integrations/ghl-oauth-store";
import { selectCalendarDriver } from "@/lib/integrations/selector";
import { createBookingEventEmitter, createNotificationRepository } from "@/lib/notifications/events";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

function proposal(value: unknown): ProposedSlotSet | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.calendarConnectionId !== "string" || typeof row.rangeStartAt !== "string" ||
    typeof row.rangeEndAt !== "string" || typeof row.proposedAt !== "string" ||
    typeof row.presentationTimezone !== "string" || !Array.isArray(row.slots)) return null;
  const slots = row.slots.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const slot = candidate as Record<string, unknown>;
    return typeof slot.id === "string" && typeof slot.startAt === "string" &&
      typeof slot.endAt === "string" && typeof slot.timezone === "string" && typeof slot.display === "string"
      ? [{ id: slot.id, startAt: slot.startAt, endAt: slot.endAt, timezone: slot.timezone, display: slot.display }]
      : [];
  });
  return slots.length === row.slots.length ? { ...row, slots } as ProposedSlotSet : null;
}

/** The lead-facing confirmation deliberately uses the same provider-first booking service as inbound. */
export function createConsumerBookingService() {
  const client = createSupabaseServiceClient();
  const repository: BookingRepository = {
    getBookingContext: async (tenantId, conversationId) => {
      const { data: conversation, error } = await client.from("conversations")
        .select("tenant_id,contact_id,channel,is_test").eq("tenant_id", tenantId).eq("id", conversationId).single();
      if (error || !conversation || conversation.channel !== "webchat") throw new Error("CONSUMER_BOOKING_CONTEXT_REQUIRED");
      const [{ data: contact, error: contactError }, { data: identity, error: identityError }] = await Promise.all([
        client.from("contacts").select("id,tenant_id,name,timezone,credit_range,funding_goal,timeline,is_test")
          .eq("tenant_id", tenantId).eq("id", conversation.contact_id).single(),
        client.from("contact_identities").select("provider_identity_id")
          .eq("tenant_id", tenantId).eq("contact_id", conversation.contact_id).eq("provider", "ghl").limit(1).maybeSingle(),
      ]);
      if (contactError || identityError || !contact || !identity?.provider_identity_id) {
        throw new Error("CONSUMER_BOOKING_PROVIDER_CONTACT_REQUIRED");
      }
      return {
        tenantId, conversationId, contactId: contact.id, providerContactId: identity.provider_identity_id,
        leadName: contact.name ?? "Lead", channel: "sms" as const, leadTimezone: contact.timezone,
        qualification: { creditBand: contact.credit_range, fundingGoal: contact.funding_goal, timeline: contact.timeline },
        isTest: contact.is_test || conversation.is_test,
      };
    },
    getPrimaryCalendar: async (tenantId) => {
      const { data, error } = await client.from("calendar_connections")
        .select("id,tenant_id,provider,external_calendar_id,external_location_id,timezone,booking_url")
        .eq("tenant_id", tenantId).eq("is_primary", true).eq("state", "ready").maybeSingle();
      if (error) throw new Error("CONSUMER_BOOKING_CALENDAR_READ_FAILED");
      if (!data || !data.external_location_id) return null;
      return { id: data.id, tenantId: data.tenant_id, provider: data.provider, externalCalendarId: data.external_calendar_id,
        externalLocationId: data.external_location_id, timezone: data.timezone, bookingUrl: data.booking_url } as never;
    },
    getProposedSlots: async (tenantId, conversationId) => {
      const { data, error } = await client.from("conversations").select("proposed_slots")
        .eq("tenant_id", tenantId).eq("id", conversationId).single();
      const result = proposal(data?.proposed_slots);
      if (error || (data?.proposed_slots && !result)) throw new Error("CONSUMER_BOOKING_PROPOSAL_REQUIRED");
      return result;
    },
    recordProposedSlots: async ({ tenantId, conversationId, proposal: slotSet }) => {
      const { data, error } = await client.rpc("record_booking_proposed_slots", {
        p_expected_tenant: tenantId, p_conversation_id: conversationId, p_proposal: slotSet, p_proposed_at: slotSet.proposedAt,
      });
      const result = proposal(data);
      if (error || !result) throw new Error("CONSUMER_BOOKING_PROPOSAL_WRITE_FAILED");
      return result;
    },
    recordCalendarSlotFetch: async (input) => {
      const { error } = await client.from("calendar_connections").update({ last_slot_fetch_at: input.fetchedAt,
        last_slot_fetch_ok: input.ok, last_error: input.error }).eq("tenant_id", input.tenantId)
        .eq("id", input.calendarConnectionId);
      if (error) throw new Error("CONSUMER_BOOKING_CALENDAR_HEALTH_WRITE_FAILED");
    },
    recordProviderAppointment: async (input) => {
      const { data, error } = await client.rpc("record_provider_appointment", {
        p_expected_tenant: input.tenantId, p_contact_id: input.contactId, p_conversation_id: input.conversationId,
        p_calendar_connection_id: input.calendarConnectionId, p_provider: input.provider, p_external_id: input.externalId,
        p_start_at: input.startAt, p_end_at: input.endAt, p_timezone: input.timezone, p_created_source: input.source,
        p_attributed_to_agent: input.attributedToAgent,
      });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row?.appointment_id) throw new Error("CONSUMER_BOOKING_APPOINTMENT_WRITE_FAILED");
      return { appointmentId: row.appointment_id, billableEventId: row.billable_event_id ?? null,
        auditId: row.audit_id === null ? null : Number(row.audit_id) };
    },
    claimBookingIntent: async (input) => {
      const { data, error } = await client.rpc("claim_booking_intent", { p_idempotency_key: input.idempotencyKey,
        p_expected_tenant: input.tenantId, p_conversation_id: input.conversationId, p_contact_id: input.contactId,
        p_calendar_connection_id: input.calendarConnectionId, p_selected_slot_id: input.selectedSlotId, p_start_at: input.startAt,
        p_end_at: input.endAt, p_timezone: input.timezone, p_now: input.now });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row?.intent_id) throw new Error("CONSUMER_BOOKING_INTENT_CLAIM_FAILED");
      if (row.intent_state === "busy") return { kind: "busy" as const, intentId: row.intent_id };
      if (row.intent_state === "provider_created" && row.provider_external_id) return { kind: "provider_created" as const, intentId: row.intent_id, providerExternalId: row.provider_external_id };
      if (row.intent_state === "completed" && row.provider_external_id && row.appointment_id) return { kind: "completed" as const, intentId: row.intent_id, providerExternalId: row.provider_external_id, appointment: { appointmentId: row.appointment_id, billableEventId: row.billable_event_id ?? null, auditId: row.appointment_audit_id === null ? null : Number(row.appointment_audit_id) } };
      if (row.intent_state !== "claimed" || !row.claim_token) throw new Error("CONSUMER_BOOKING_INTENT_CLAIM_INVALID");
      return { kind: "claimed" as const, intentId: row.intent_id, claimToken: row.claim_token, recoveryRequired: row.recovery_required === true };
    },
    renewBookingIntentLease: async (input) => rpcBoolean(client, "renew_booking_intent_lease", { p_intent_id: input.intentId, p_claim_token: input.claimToken, p_expected_tenant: input.tenantId, p_now: input.now }),
    recordBookingIntentProvider: async (input) => rpcVoid(client, "record_booking_intent_provider", { p_intent_id: input.intentId, p_claim_token: input.claimToken, p_expected_tenant: input.tenantId, p_provider_external_id: input.providerExternalId, p_recovered: input.recovered }),
    completeBookingIntent: async (input) => rpcVoid(client, "complete_booking_intent", { p_intent_id: input.intentId, p_expected_tenant: input.tenantId, p_provider_external_id: input.providerExternalId, p_appointment_id: input.appointment.appointmentId, p_billable_event_id: input.appointment.billableEventId, p_appointment_audit_id: input.appointment.auditId }),
    releaseBookingIntent: async (input) => rpcVoid(client, "release_booking_intent", { p_intent_id: input.intentId, p_claim_token: input.claimToken, p_expected_tenant: input.tenantId, p_error: input.error }),
    checkpointBookingConflict: async (input) => rpcVoid(client, "checkpoint_booking_slot_conflict", { p_expected_tenant: input.tenantId, p_emission_id: input.emissionId, p_inbound_message_id: input.inboundMessageId, p_booking_intent_id: input.intentId, p_claim_token: input.claimToken, p_error: input.error, p_now: input.now }),
    recordBookingLinkSent: async () => { throw new Error("CONSUMER_BOOKING_LINK_UNSUPPORTED"); },
  };
  return createBookingService({
    calendar: selectCalendarDriver({
      factories: {
        mock: createMockCalendarDriver,
        real: () => createRealCalendarDriver({ getLocationAccessToken: resolveGhlLocationAccessToken }),
      },
    }),
    repository,
    emitDomainEvent: async (event) => {
      await createBookingEventEmitter(createNotificationRepository())(event);
    },
  });
}

async function rpcVoid(client: ReturnType<typeof createSupabaseServiceClient>, name: string, args: Record<string, unknown>) {
  const { error } = await client.rpc(name, args); if (error) throw new Error(`CONSUMER_BOOKING_${name.toUpperCase()}_FAILED`);
}
async function rpcBoolean(client: ReturnType<typeof createSupabaseServiceClient>, name: string, args: Record<string, unknown>) {
  const { data, error } = await client.rpc(name, args); if (error || typeof data !== "boolean") throw new Error(`CONSUMER_BOOKING_${name.toUpperCase()}_FAILED`); return data;
}
