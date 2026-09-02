/**
 * Provider-blind contracts for calendar booking and appointment state changes.
 *
 * Calendar calls and persistence stay behind injected ports so the booking service cannot smuggle
 * caller-selected calendars into a provider request or write local state before provider success.
 * The domain-event values are data, not notifier calls; notification delivery owns their effects.
 */

export const BOOKING_EVENT_KEYS = [
  "appointment.booked",
  "appointment.rescheduled",
  "appointment.canceled",
  "calendar.connection_unhealthy",
  "brain.publish_failed",
] as const;

export type BookingEventKey = (typeof BOOKING_EVENT_KEYS)[number];

export const ALERT_EVENT_KEYS = [
  ...BOOKING_EVENT_KEYS,
  // Phase 3
  "conversation.needs_human",
  "conversation.tripwire_escalated",
  "conversation.outbound_send_unconfirmed",
  "suppression.provider_unconfirmed",
  "contact.deleted",
  // Phase 6
  "billing.account_overdue",
  "billing.account_suspended",
  "billing.allowance_crossed",
  "billing.allowance_warning",
  "billing.payment_failed",
] as const;

export type AlertEventKey = (typeof ALERT_EVENT_KEYS)[number];

export const DOMAIN_EVENT_KEYS = [
  ...BOOKING_EVENT_KEYS,
  // Phase 3
  "conversation.tripwire_escalated",
  "conversation.outbound_send_unconfirmed",
  "suppression.provider_unconfirmed",
  "contact.deleted",
  // Phase 4
  "send.refused.window_expired",
  "message_template.rejected",
  "conversation.needs_human",
  // Phase 8
  "conversation.channel_continuation_unavailable",
] as const;

export type DomainEventKey = (typeof DOMAIN_EVENT_KEYS)[number];

export type MessagingChannel = "sms" | "instagram" | "messenger" | "whatsapp";
export type CalendarProvider = "ghl" | "google";
export type AppointmentSource = "agent" | "provider_webhook" | "system_reconcile";
export type AppointmentStatus = "scheduled" | "confirmed" | "completed" | "no_show" | "canceled";
export type AttendanceSource = "coach" | "provider" | "system";
export type CancellationSource = "lead" | "coach" | "provider_missing" | "system";

export type QualificationSummary = {
  creditBand: string | null;
  fundingGoal: string | null;
  timeline: string | null;
};

export type BookingContext = {
  tenantId: string;
  conversationId: string;
  contactId: string;
  providerContactId: string;
  leadName: string;
  channel: MessagingChannel;
  leadTimezone: string | null;
  qualification: QualificationSummary;
  isTest: boolean;
};

export type CalendarConnection = {
  id: string;
  tenantId: string;
  provider: CalendarProvider;
  externalCalendarId: string;
  externalLocationId: string;
  timezone: string;
  bookingUrl: string | null;
};

export type CalendarSlot = {
  id: string;
  startAt: string;
  endAt: string;
  timezone: string;
};

export type OfferedSlot = CalendarSlot & {
  display: string;
};

export type ProposedSlotSet = {
  calendarConnectionId: string;
  rangeStartAt: string;
  rangeEndAt: string;
  proposedAt: string;
  presentationTimezone: string;
  slots: OfferedSlot[];
};

export type CalendarHealthChange =
  | {
      kind: "healthy";
      tenantId: string;
      calendarConnectionId: string;
      fetchedAt: string;
    }
  | {
      kind: "unhealthy";
      tenantId: string;
      calendarConnectionId: string;
      fetchedAt: string;
      error: string;
    };

export type AppointmentEventDetails = BookingContext & {
  appointmentId: string;
  calendarConnectionId: string;
  calendarTimezone: string;
  startAt: string;
  endAt: string;
  attributedToAgent: boolean;
};

export type BookingDomainEvent =
  | ({ key: "appointment.booked" } & AppointmentEventDetails)
  | ({
      key: "appointment.rescheduled";
      priorStartAt: string;
      priorEndAt: string;
    } & AppointmentEventDetails)
  | ({
      key: "appointment.canceled";
      cancelSource: CancellationSource;
    } & AppointmentEventDetails)
  | {
      key: "calendar.connection_unhealthy";
      tenantId: string;
      calendarConnectionId: string;
      occurredAt: string;
      error: string;
      isTest: boolean;
    }
  | {
      key: "brain.publish_failed";
      tenantId: null;
      occurredAt: string;
      actorId: string;
      draftId: string;
      errorCode: string;
      isTest: false;
    }
  | {
      key: "conversation.outbound_send_unconfirmed";
      tenantId: string;
      outboundAttemptId: string;
      conversationId: string;
      idempotencyKey: string;
      errorCode: string;
      occurredAt: string;
      isTest: boolean;
    }
  | {
      key: "suppression.provider_unconfirmed";
      tenantId: string;
      suppressionId: string;
      occurredAt: string;
      isTest: boolean;
    }
  | {
      key: "conversation.tripwire_escalated";
      tenantId: string;
      conversationId: string;
      tripwireClass: string;
      occurredAt: string;
      isTest: boolean;
    }
  | {
      key: "contact.deleted";
      tenantId: string;
      contactId: string;
      auditId: number;
      occurredAt: string;
      isTest: boolean;
    };

// Phase 4
export type ChannelDomainEvent =
  | {
      key: "send.refused.window_expired";
      tenantId: string;
      conversationId: string;
      channel: MessagingChannel;
      occurredAt: string;
      isTest: boolean;
    }
  | {
      key: "message_template.rejected";
      tenantId: string;
      templateId: string;
      channel: MessagingChannel;
      rejectionReason: string | null;
      occurredAt: string;
      isTest: boolean;
    }
  | {
      key: "conversation.needs_human";
      tenantId: string;
      conversationId: string;
      occurredAt: string;
      isTest: boolean;
    }
  | {
      key: "conversation.channel_continuation_unavailable";
      tenantId: string;
      conversationId: string;
      channel: MessagingChannel;
      reason: string;
      occurredAt: string;
      isTest: boolean;
    }
  | {
      key: "channel.disconnected";
      tenantId: string;
      connectionId: string;
      channel: MessagingChannel;
      commandReceiptId: string;
      occurredAt: string;
      isTest: boolean;
    }
  | {
      key: "onboarding.a2p_cleared";
      tenantId: string;
      probeReceiptId: string;
      occurredAt: string;
      isTest: boolean;
    }
  | {
      key: "onboarding.stalled";
      tenantId: string;
      stepKey: string;
      attemptId: string;
      occurredAt: string;
      isTest: boolean;
    };

export type DomainEvent = BookingDomainEvent | ChannelDomainEvent;

export type AppointmentRecordResult = {
  appointmentId: string;
  billableEventId: string | null;
  auditId: number | null;
};

export type AppointmentRecordInput = {
  tenantId: string;
  contactId: string;
  conversationId: string;
  calendarConnectionId: string;
  provider: CalendarProvider;
  externalId: string;
  startAt: string;
  endAt: string;
  timezone: string;
  source: AppointmentSource;
  attributedToAgent: boolean;
};

export type BookingIntentInput = {
  idempotencyKey: string;
  tenantId: string;
  conversationId: string;
  contactId: string;
  calendarConnectionId: string;
  selectedSlotId: string;
  startAt: string;
  endAt: string;
  timezone: string;
};

export type BookingIntentClaim =
  | { kind: "claimed"; intentId: string; claimToken: string; recoveryRequired: boolean }
  | { kind: "busy"; intentId: string }
  | { kind: "provider_created"; intentId: string; providerExternalId: string }
  | {
      kind: "completed";
      intentId: string;
      providerExternalId: string;
      appointment: AppointmentRecordResult;
    };

export type SlotProposalResult =
  | { kind: "offered"; proposal: ProposedSlotSet; health: CalendarHealthChange }
  | { kind: "unavailable"; reason: "primary_calendar_missing" | "no_slots" }
  | { kind: "unhealthy"; health: Extract<CalendarHealthChange, { kind: "unhealthy" }> };

export type BookingResult =
  | {
      kind: "booked";
      appointment: AppointmentRecordResult;
      providerExternalId: string;
      slot: OfferedSlot;
    }
  | { kind: "reoffer"; reason: "slot_stale"; proposal: ProposedSlotSet }
  | { kind: "reoffer"; reason: "slot_conflict"; proposal: ProposedSlotSet; intentId: string }
  | { kind: "reoffer_pending"; intentId: string; error: string }
  | { kind: "no_slots"; conflictPending: true; intentId: string }
  | { kind: "unavailable"; reason: "primary_calendar_missing" | "slot_not_offered" }
  | { kind: "in_progress"; intentId: string }
  | { kind: "provider_error"; error: string };

export type BookingLinkResult =
  | { kind: "link"; bookingUrl: string }
  | { kind: "unavailable"; reason: "primary_calendar_missing" | "booking_url_missing" };

export type BookingRepository = {
  getBookingContext(tenantId: string, conversationId: string): Promise<BookingContext>;
  getPrimaryCalendar(tenantId: string): Promise<CalendarConnection | null>;
  getProposedSlots(tenantId: string, conversationId: string): Promise<ProposedSlotSet | null>;
  recordProposedSlots(input: {
    tenantId: string;
    conversationId: string;
    proposal: ProposedSlotSet;
  }): Promise<ProposedSlotSet>;
  recordCalendarSlotFetch(input: {
    tenantId: string;
    calendarConnectionId: string;
    ok: boolean;
    error: string | null;
    fetchedAt: string;
  }): Promise<void>;
  recordProviderAppointment(input: AppointmentRecordInput): Promise<AppointmentRecordResult>;
  claimBookingIntent(input: BookingIntentInput & { now: string }): Promise<BookingIntentClaim>;
  renewBookingIntentLease(input: {
    intentId: string;
    claimToken: string;
    tenantId: string;
    now: string;
  }): Promise<boolean>;
  recordBookingIntentProvider(input: {
    intentId: string;
    claimToken: string;
    tenantId: string;
    providerExternalId: string;
    recovered: boolean;
  }): Promise<void>;
  completeBookingIntent(input: {
    intentId: string;
    tenantId: string;
    providerExternalId: string;
    appointment: AppointmentRecordResult;
  }): Promise<void>;
  releaseBookingIntent(input: {
    intentId: string;
    claimToken: string;
    tenantId: string;
    error: string;
  }): Promise<void>;
  checkpointBookingConflict(input: {
    intentId: string;
    claimToken: string;
    tenantId: string;
    emissionId: string;
    inboundMessageId: string;
    error: string;
    now: string;
  }): Promise<void>;
  recordBookingLinkSent(input: {
    tenantId: string;
    conversationId: string;
    sentAt: string;
  }): Promise<void>;
};

export type AppointmentRecord = AppointmentEventDetails & {
  provider: CalendarProvider;
  externalId: string;
  externalLocationId: string;
  createdSource: AppointmentSource;
  billableEventId: string | null;
  status: AppointmentStatus;
  attendanceSource: AttendanceSource | null;
};

export type AppointmentLifecycleRepository = {
  getAppointment(tenantId: string, appointmentId: string): Promise<AppointmentRecord | null>;
  rescheduleAppointment(input: {
    tenantId: string;
    appointmentId: string;
    startAt: string;
    endAt: string;
    initiatedBy: "lead" | "coach" | "agent" | "provider";
    actorId: string | null;
  }): Promise<void>;
  cancelAppointment(input: {
    tenantId: string;
    appointmentId: string;
    source: CancellationSource;
    actorId: string | null;
  }): Promise<{ eventEnqueued: boolean }>;
  recordAttendance(input: {
    tenantId: string;
    appointmentId: string;
    status: "completed" | "no_show";
    source: AttendanceSource;
    actorId: string | null;
  }): Promise<void>;
  listReconciliationCandidates(input: {
    tenantId: string;
    calendarConnectionId: string;
    startAt: string;
    endAt: string;
  }): Promise<AppointmentRecord[]>;
};
