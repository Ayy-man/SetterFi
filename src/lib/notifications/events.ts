/**
 * Registry-backed persistence for booking and calendar domain events.
 *
 * State owners emit typed events; this module resolves the seeded rule and persists a bell row plus
 * delivery intents. No provider is called here, so an email destination remains pending rather than
 * being presented as delivered without a provider receipt.
 */

import {
  ALERT_EVENT_KEYS,
  BOOKING_EVENT_KEYS,
  type AppointmentEventDetails,
  type AlertEventKey,
  type BookingDomainEvent,
  type BookingEventKey,
} from "@/lib/booking/types";
import {
  createAlertDestinationRepository,
  resolveAlertDestinations,
} from "@/lib/notifications/resolver";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { notificationDestination } from "@/lib/notifications/destinations";

export { ALERT_EVENT_KEYS, BOOKING_EVENT_KEYS } from "@/lib/booking/types";

export type NotificationDestination = "bell" | "email";

export type NotificationRule = {
  id: string;
  eventKey: AlertEventKey;
  name: string;
  defaultEnabled: boolean;
  suppressible: boolean;
  includeBillingContact: boolean;
  includeSuccessOwner?: boolean;
  scope?: "tenant" | "platform";
  audienceRoles?: readonly string[];
  defaultDestinations?: readonly NotificationDestination[];
};

const NOTIFICATION_RULE_SELECT =
  "id,event_key,name,default_enabled,suppressible,include_billing_contact,scope,audience_roles,default_destinations";

export type NotificationRecipient = {
  userId: string | null;
  recipientEmail?: string | null;
  destinations: NotificationDestination[];
};

export type BookingNotificationContent = {
  leadName: string;
  channel: string;
  slot: string;
  qualification: string;
  conversationDeepLink: string;
  agentBooked: boolean;
};

export type ComplianceNotificationEvent = Extract<
  BookingDomainEvent,
  { key: "suppression.provider_unconfirmed" | "conversation.tripwire_escalated" | "conversation.outbound_send_unconfirmed" | "contact.deleted" }
>;

type NotificationDomainEvent = BookingDomainEvent;

export type NotificationRepository = {
  resolveRule(eventKey: AlertEventKey, scope?: "tenant" | "platform"): Promise<NotificationRule | null>;
  resolveRecipients(
    rule: NotificationRule,
    event: NotificationDomainEvent,
  ): Promise<NotificationRecipient[]>;
  insertNotification(input: {
    tenantId: string | null;
    userId: string | null;
    recipientEmail?: string | null;
    ruleId: string;
    sourceEventId?: string;
    eventKey: AlertEventKey;
    title: string;
    body: string;
    link: string | null;
    content: Record<string, unknown>;
    visibleInBell: boolean;
    isTest?: boolean;
  }): Promise<{ notificationId: string }>;
  insertDeliveryIntent(input: {
    notificationId: string;
    destination: NotificationDestination;
  }): Promise<void>;
};

function sourceEventId(event: NotificationDomainEvent) {
  if (event.key === "appointment.booked"
    || event.key === "appointment.rescheduled"
    || event.key === "appointment.canceled") return event.appointmentId;
  if (event.key === "calendar.connection_unhealthy") {
    return `${event.calendarConnectionId}:${event.occurredAt}`;
  }
  if (event.key === "brain.publish_failed") return `${event.draftId}:${event.occurredAt}`;
  if (event.key === "suppression.provider_unconfirmed") return event.suppressionId;
  if (event.key === "conversation.outbound_send_unconfirmed") return event.outboundAttemptId;
  if (event.key === "conversation.tripwire_escalated") {
    return `${event.conversationId}:${event.occurredAt}`;
  }
  if (event.key === "contact.deleted") return `${event.contactId}:${event.auditId}`;
  throw new Error(`NOTIFICATION_SOURCE_EVENT_UNSUPPORTED:${event satisfies never}`);
}

function formatInTimezone(instant: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day} ${byType.hour}:${byType.minute} ${timezone}`;
}

export function formatNotificationSlot(event: AppointmentEventDetails) {
  const coachTime = formatInTimezone(event.startAt, event.calendarTimezone);
  if (!event.leadTimezone || event.leadTimezone === event.calendarTimezone) return coachTime;
  return `${coachTime} (${formatInTimezone(event.startAt, event.leadTimezone)})`;
}

function qualificationValue(value: string | null) {
  return value ?? "Not captured";
}

export function buildBookingNotificationContent(
  event: AppointmentEventDetails,
): BookingNotificationContent {
  return {
    leadName: event.leadName,
    channel: event.channel,
    slot: formatNotificationSlot(event),
    qualification:
      `Credit: ${qualificationValue(event.qualification.creditBand)}; ` +
      `Funding goal: ${qualificationValue(event.qualification.fundingGoal)}; ` +
      `Timeline: ${qualificationValue(event.qualification.timeline)}`,
    conversationDeepLink: notificationDestination({
      key: "coach.conversation",
      conversationId: event.conversationId,
    }),
    agentBooked: event.attributedToAgent,
  };
}

function notificationFields(event: NotificationDomainEvent) {
  if (event.key === "suppression.provider_unconfirmed") {
    return {
      title: "Provider suppression unconfirmed",
      body: "A provider has not confirmed a local suppression.",
      link: notificationDestination({ key: "admin.channel-health" }),
      content: { suppressionId: event.suppressionId },
    };
  }
  if (event.key === "conversation.outbound_send_unconfirmed") {
    return {
      title: "Outbound send needs reconciliation",
      body: "Provider acceptance is uncertain, so automatic resend is blocked until the attempt is reconciled.",
      link: notificationDestination({ key: "coach.conversation", conversationId: event.conversationId }),
      content: {
        outboundAttemptId: event.outboundAttemptId,
        conversationId: event.conversationId,
        idempotencyKey: event.idempotencyKey,
        errorCode: event.errorCode,
      },
    };
  }
  if (event.key === "conversation.tripwire_escalated") {
    return {
      title: "Conversation escalated",
      body: "A tripwire escalated a conversation.",
      link: notificationDestination({ key: "coach.conversation", conversationId: event.conversationId }),
      content: { conversationId: event.conversationId, tripwireClass: event.tripwireClass },
    };
  }
  if (event.key === "contact.deleted") {
    return {
      title: "Contact deleted",
      body: "A privacy deletion completed and its suppression tombstone was retained.",
      link: null,
      content: { contactId: event.contactId, auditId: event.auditId },
    };
  }
  if (event.key === "brain.publish_failed") {
    return {
      title: "Brain publish failed",
      body: "A Brain publish transaction was refused.",
      link: notificationDestination({ key: "admin.brain" }),
      content: {
        actorId: event.actorId,
        draftId: event.draftId,
        errorCode: event.errorCode,
      },
    };
  }
  if (event.key === "calendar.connection_unhealthy") {
    return {
      title: "Calendar needs attention",
      body: "The primary calendar failed its latest slot fetch.",
      link: notificationDestination({
        key: "coach.integration",
        connectionId: event.calendarConnectionId,
      }),
      content: {
        calendarConnectionId: event.calendarConnectionId,
        error: event.error,
      },
    };
  }

  const content = buildBookingNotificationContent(event);
  const labels = {
    "appointment.booked": "Appointment booked",
    "appointment.rescheduled": "Appointment rescheduled",
    "appointment.canceled": "Appointment canceled",
  } as const;
  return {
    title: labels[event.key],
    body:
      `${content.leadName} · ${content.channel} · ${content.slot} · ` +
      `${content.qualification} · Agent booked: ${content.agentBooked ? "Yes" : "No"}`,
    link: content.conversationDeepLink,
    content: { ...content },
  };
}

export function domainEventFromCalendarHealth(input: {
  kind: "unhealthy";
  tenantId: string;
  calendarConnectionId: string;
  fetchedAt: string;
  error: string;
  isTest: boolean;
}): BookingDomainEvent {
  return {
    key: "calendar.connection_unhealthy",
    tenantId: input.tenantId,
    calendarConnectionId: input.calendarConnectionId,
    occurredAt: input.fetchedAt,
    error: input.error,
    isTest: input.isTest,
  };
}

export function createBookingEventEmitter(repository: NotificationRepository) {
  return async function emitDomainEvent(event: BookingDomainEvent) {
    const rule = await repository.resolveRule(event.key);
    if (!rule) throw new Error(`NOTIFICATION_RULE_NOT_REGISTERED:${event.key}`);
    if (!rule.defaultEnabled) return { notificationIds: [] as string[] };

    const recipients = await repository.resolveRecipients(rule, event);
    const fields = notificationFields(event);
    const notificationIds: string[] = [];
    for (const recipient of recipients) {
      const destinations = event.isTest
        ? ["bell" as const]
        : [...new Set(recipient.destinations)];
      if (destinations.length === 0) continue;
      const notification = await repository.insertNotification({
        tenantId: event.tenantId,
        userId: recipient.userId,
        recipientEmail: recipient.recipientEmail,
        ruleId: rule.id,
        sourceEventId: sourceEventId(event),
        eventKey: event.key,
        title: event.isTest ? `Test · ${fields.title}` : fields.title,
        body: fields.body,
        link: fields.link,
        content: fields.content,
        visibleInBell: destinations.includes("bell"),
        isTest: event.isTest,
      });
      notificationIds.push(notification.notificationId);
      for (const destination of destinations) {
        await repository.insertDeliveryIntent({
          notificationId: notification.notificationId,
          destination,
        });
      }
    }
    return { notificationIds };
  };
}

export function createComplianceEventEmitter(repository: NotificationRepository) {
  return async function emitComplianceEvent(event: ComplianceNotificationEvent) {
    const scopes: Array<"tenant" | "platform"> = event.isTest || event.key === "contact.deleted"
      ? ["tenant"]
      : ["tenant", "platform"];
    const notificationIds: string[] = [];
    for (const scope of scopes) {
      const rule = await repository.resolveRule(event.key, scope);
      if (!rule) throw new Error(`NOTIFICATION_RULE_NOT_REGISTERED:${event.key}:${scope}`);
      if (!rule.defaultEnabled) continue;
      const scopedEvent = scope === "platform" ? { ...event, tenantId: null } : event;
      const recipients = await repository.resolveRecipients(rule, scopedEvent as NotificationDomainEvent);
      const fields = notificationFields(event);
      for (const recipient of recipients) {
        const destinations = event.isTest
          ? ["bell" as const]
          : [...new Set(recipient.destinations)];
        if (destinations.length === 0) continue;
        const notification = await repository.insertNotification({
          tenantId: scope === "platform" ? null : event.tenantId,
          userId: recipient.userId,
          recipientEmail: recipient.recipientEmail,
          ruleId: rule.id,
          sourceEventId: sourceEventId(event),
          eventKey: event.key,
          title: event.isTest ? `Test · ${fields.title}` : fields.title,
          body: fields.body,
          link: fields.link,
          content: fields.content,
          visibleInBell: destinations.includes("bell"),
          isTest: event.isTest,
        });
        notificationIds.push(notification.notificationId);
        for (const destination of destinations) {
          await repository.insertDeliveryIntent({
            notificationId: notification.notificationId,
            destination,
          });
        }
      }
    }
    return { notificationIds };
  };
}

export function suppressionProviderUnconfirmedEvent(input: Omit<
  Extract<ComplianceNotificationEvent, { key: "suppression.provider_unconfirmed" }>,
  "key"
>) {
  return { key: "suppression.provider_unconfirmed" as const, ...input };
}

export function conversationTripwireEscalatedEvent(input: Omit<
  Extract<ComplianceNotificationEvent, { key: "conversation.tripwire_escalated" }>,
  "key"
>) {
  return { key: "conversation.tripwire_escalated" as const, ...input };
}

export function outboundSendUnconfirmedEvent(input: Omit<
  Extract<ComplianceNotificationEvent, { key: "conversation.outbound_send_unconfirmed" }>,
  "key"
>) {
  return { key: "conversation.outbound_send_unconfirmed" as const, ...input };
}

export function contactDeletedEvent(input: Omit<
  Extract<ComplianceNotificationEvent, { key: "contact.deleted" }>,
  "key"
>) {
  return { key: "contact.deleted" as const, ...input };
}

/** Platform publish failures are system state, so their event carries no tenant identifier. */
export function brainPublishFailedEvent(input: {
  actorId: string;
  draftId: string;
  errorCode: string;
  occurredAt?: string;
}): Extract<BookingDomainEvent, { key: "brain.publish_failed" }> {
  return {
    key: "brain.publish_failed",
    tenantId: null,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    actorId: input.actorId,
    draftId: input.draftId,
    errorCode: input.errorCode,
    isTest: false,
  };
}

/** Live registry adapter used by state owners that need a durable bell receipt. */
export function createNotificationRepository(): NotificationRepository {
  const client = createSupabaseServiceClient();
  const destinationRepository = createAlertDestinationRepository();
  return {
    resolveRule: async (eventKey, requestedScope) => {
      const scope = requestedScope ?? (eventKey === "brain.publish_failed" ? "platform" : "tenant");
      const { data, error } = await client
        .from("alert_rules")
        .select(`${NOTIFICATION_RULE_SELECT},include_success_owner`)
        .eq("event_key", eventKey)
        .eq("scope", scope)
        .single();
      if (error || !data) return null;
      return {
        id: data.id,
        eventKey: data.event_key as AlertEventKey,
        name: data.name,
        defaultEnabled: data.default_enabled,
        suppressible: data.suppressible,
        includeBillingContact: data.include_billing_contact,
        includeSuccessOwner: data.include_success_owner,
        scope: data.scope as "tenant" | "platform",
        audienceRoles: Array.isArray(data.audience_roles) ? data.audience_roles : [],
        defaultDestinations: Array.isArray(data.default_destinations)
          ? data.default_destinations as NotificationDestination[]
          : [],
      };
    },
    resolveRecipients: (rule, event) => resolveAlertDestinations({
      id: rule.id,
      scope: rule.scope ?? (event.tenantId === null ? "platform" : "tenant"),
      audienceRoles: rule.audienceRoles ?? [],
      includeSuccessOwner: rule.includeSuccessOwner ?? false,
      includeBillingContact: rule.includeBillingContact,
      defaultDestinations: rule.defaultDestinations ?? ["bell"],
      suppressible: rule.suppressible,
    }, event, destinationRepository),
    insertNotification: async (input) => {
      const { data, error } = await client.from("notifications").insert({
        tenant_id: input.tenantId,
        user_id: input.userId,
        recipient_email: input.recipientEmail ?? null,
        rule_id: input.ruleId,
        source_event_id: input.sourceEventId ?? null,
        kind: input.eventKey,
        title: input.title,
        body: input.body,
        link: input.link,
        content: input.content,
        is_test: input.isTest ?? false,
      }).select("id").single();
      if (!error && data) return { notificationId: data.id };
      if (error?.code !== "23505" || !input.sourceEventId) {
        throw new Error(`NOTIFICATION_WRITE_FAILED:${error?.message ?? "empty"}`);
      }
      let existing = client.from("notifications").select("id")
        .eq("rule_id", input.ruleId).eq("source_event_id", input.sourceEventId);
      existing = input.userId === null
        ? existing.is("user_id", null) : existing.eq("user_id", input.userId);
      existing = input.recipientEmail == null
        ? existing.is("recipient_email", null) : existing.eq("recipient_email", input.recipientEmail);
      const persisted = await existing.single();
      if (persisted.error || !persisted.data) throw new Error("NOTIFICATION_DEDUPE_READ_FAILED");
      return { notificationId: persisted.data.id };
    },
    insertDeliveryIntent: async (input) => {
      const bell = input.destination === "bell";
      const { error } = await client.from("notification_deliveries").upsert({
        notification_id: input.notificationId,
        destination: input.destination,
        ...(bell ? {
          status: "delivered",
          provider_reference: `bell:${input.notificationId}`,
          delivered_at: new Date().toISOString(),
          terminal_at: new Date().toISOString(),
        } : { next_attempt_at: new Date().toISOString() }),
      }, { onConflict: "notification_id,destination", ignoreDuplicates: true });
      if (error) throw new Error(`NOTIFICATION_DELIVERY_WRITE_FAILED:${error.message}`);
    },
  };
}

export function isBookingEventKey(value: string): value is BookingEventKey {
  return BOOKING_EVENT_KEYS.some((key) => key === value);
}

export function isAlertEventKey(value: string): value is AlertEventKey {
  return ALERT_EVENT_KEYS.some((key) => key === value);
}

// Phase 4
export { DOMAIN_EVENT_KEYS } from "@/lib/booking/types";
export type { ChannelDomainEvent, DomainEvent, DomainEventKey } from "@/lib/booking/types";
