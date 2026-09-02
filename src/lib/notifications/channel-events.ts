/**
 * Registered channel-domain notifications.
 *
 * Channel state owners emit typed facts and never call a delivery provider. Test facts stop before
 * registry resolution so a demo cannot page the success team or create outbound delivery intent.
 */

import type { ChannelDomainEvent, MessagingChannel } from "@/lib/booking/types";
import {
  type NotificationDestination,
  type NotificationRecipient,
} from "@/lib/notifications/events";
import {
  createAlertDestinationRepository,
  resolveAlertDestinations,
} from "@/lib/notifications/resolver";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { notificationDestination } from "@/lib/notifications/destinations";

export const CHANNEL_EVENT_KEYS = [
  // Phase 4
  "send.refused.window_expired",
  "message_template.rejected",
  "conversation.needs_human",
  // Phase 8
  "conversation.channel_continuation_unavailable",
  "channel.disconnected",
  "onboarding.a2p_cleared",
  "onboarding.stalled",
] as const;

export type ChannelEventKey = (typeof CHANNEL_EVENT_KEYS)[number];

export type ChannelNotificationRule = {
  id: string;
  eventKey: ChannelEventKey;
  defaultEnabled: boolean;
  audienceRoles: readonly string[];
  defaultDestinations: readonly NotificationDestination[];
  suppressible?: boolean;
  includeSuccessOwner?: boolean;
  includeBillingContact?: boolean;
};

export type ChannelNotificationRepository = {
  resolveRule(eventKey: ChannelEventKey): Promise<ChannelNotificationRule | null>;
  resolveRecipients(
    rule: ChannelNotificationRule,
    event: ChannelDomainEvent,
  ): Promise<NotificationRecipient[]>;
  insertNotification(input: {
    tenantId: string;
    userId: string | null;
    recipientEmail?: string | null;
    ruleId: string;
    eventKey: ChannelEventKey;
    sourceEventId?: string;
    title: string;
    body: string;
    link: string;
    visibleInBell: boolean;
    isTest?: boolean;
  }): Promise<{ notificationId: string }>;
  insertDeliveryIntent(input: {
    notificationId: string;
    destination: NotificationDestination;
  }): Promise<void>;
};

function fields(event: ChannelDomainEvent) {
  if (event.key === "send.refused.window_expired") {
    return {
      title: "Message window expired",
      body: "A channel reply was refused because its provider window had closed.",
      link: notificationDestination({ key: "coach.conversation", conversationId: event.conversationId }),
    };
  }
  if (event.key === "message_template.rejected") {
    return {
      title: "Message template rejected",
      body: "A submitted WhatsApp message template was rejected.",
      link: notificationDestination({ key: "coach.integrations" }),
    };
  }
  if (event.key === "conversation.channel_continuation_unavailable") {
    return {
      title: "Channel continuation unavailable",
      body: "No eligible identity can continue the conversation on another channel.",
      link: notificationDestination({ key: "coach.conversation", conversationId: event.conversationId }),
    };
  }
  if (event.key === "channel.disconnected") {
    return {
      title: `${event.channel} channel disconnected`,
      body: `Channel connection ${event.connectionId} was disconnected after the provider confirmed revocation.`,
      link: notificationDestination({ key: "coach.integration", connectionId: event.connectionId }),
    };
  }
  if (event.key === "onboarding.a2p_cleared") {
    return {
      title: "A2P cleared for SMS setup",
      body: `Carrier clearance was confirmed by A2P probe receipt ${event.probeReceiptId}.`,
      link: notificationDestination({ key: "coach.get-started" }),
    };
  }
  if (event.key === "onboarding.stalled") {
    return {
      title: `Onboarding stalled at ${event.stepKey}`,
      body: `Setup step ${event.stepKey} exhausted its automatic retries and needs review.`,
      link: notificationDestination({ key: "coach.get-started" }),
    };
  }
  return {
    title: "Conversation needs a person",
    body: "A conversation entered the needs-human state.",
    link: notificationDestination({ key: "coach.conversation", conversationId: event.conversationId }),
  };
}

function sourceEventId(event: ChannelDomainEvent) {
  if (event.key === "message_template.rejected") return `${event.templateId}:${event.occurredAt}`;
  if (event.key === "channel.disconnected") return `${event.connectionId}:${event.commandReceiptId}`;
  if (event.key === "onboarding.a2p_cleared") return event.probeReceiptId;
  if (event.key === "onboarding.stalled") return `${event.stepKey}:${event.attemptId}`;
  return `${event.conversationId}:${event.occurredAt}`;
}

export type ChannelNotificationPort = Readonly<{
  emit(event: ChannelDomainEvent): Promise<{ notificationIds: string[] }>;
}>;

export function createChannelEventEmitter(repository: ChannelNotificationRepository) {
  return async function emitChannelEvent(event: ChannelDomainEvent) {
    const rule = await repository.resolveRule(event.key);
    if (!rule) throw new Error(`NOTIFICATION_RULE_NOT_REGISTERED:${event.key}`);
    if (!rule.defaultEnabled) return { notificationIds: [] as string[] };

    const recipients = await repository.resolveRecipients(rule, event);
    const content = fields(event);
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
        eventKey: event.key,
        sourceEventId: sourceEventId(event),
        title: event.isTest ? `Test · ${content.title}` : content.title,
        body: content.body,
        link: content.link,
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

export function windowExpiredEvent(input: {
  tenantId: string;
  conversationId: string;
  channel: MessagingChannel;
  isTest: boolean;
  occurredAt?: string;
}): Extract<ChannelDomainEvent, { key: "send.refused.window_expired" }> {
  return {
    key: "send.refused.window_expired",
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    channel: input.channel,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    isTest: input.isTest,
  };
}

export function templateRejectedEvent(input: {
  tenantId: string;
  templateId: string;
  channel: "whatsapp";
  rejectionReason: string | null;
  isTest: boolean;
  occurredAt?: string;
}): Extract<ChannelDomainEvent, { key: "message_template.rejected" }> {
  return {
    key: "message_template.rejected",
    tenantId: input.tenantId,
    templateId: input.templateId,
    channel: input.channel,
    rejectionReason: input.rejectionReason,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    isTest: input.isTest,
  };
}

export function needsHumanEvent(input: {
  tenantId: string;
  conversationId: string;
  isTest: boolean;
  occurredAt?: string;
}): Extract<ChannelDomainEvent, { key: "conversation.needs_human" }> {
  return {
    key: "conversation.needs_human",
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    isTest: input.isTest,
  };
}

export function continuationUnavailableEvent(input: {
  tenantId: string;
  conversationId: string;
  channel: MessagingChannel;
  reason: string;
  isTest: boolean;
  occurredAt?: string;
}): Extract<ChannelDomainEvent, { key: "conversation.channel_continuation_unavailable" }> {
  return {
    key: "conversation.channel_continuation_unavailable",
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    channel: input.channel,
    reason: input.reason,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    isTest: input.isTest,
  };
}

export function channelDisconnectedEvent(input: {
  tenantId: string;
  connectionId: string;
  channel: MessagingChannel;
  commandReceiptId: string;
  isTest: boolean;
  occurredAt?: string;
}): Extract<ChannelDomainEvent, { key: "channel.disconnected" }> {
  return {
    key: "channel.disconnected",
    tenantId: input.tenantId,
    connectionId: input.connectionId,
    channel: input.channel,
    commandReceiptId: input.commandReceiptId,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    isTest: input.isTest,
  };
}

export function a2pClearedEvent(input: {
  tenantId: string;
  probeReceiptId: string;
  isTest: boolean;
  occurredAt?: string;
}): Extract<ChannelDomainEvent, { key: "onboarding.a2p_cleared" }> {
  return {
    key: "onboarding.a2p_cleared",
    tenantId: input.tenantId,
    probeReceiptId: input.probeReceiptId,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    isTest: input.isTest,
  };
}

export function onboardingStalledEvent(input: {
  tenantId: string;
  stepKey: string;
  attemptId: string;
  isTest: boolean;
  occurredAt?: string;
}): Extract<ChannelDomainEvent, { key: "onboarding.stalled" }> {
  return {
    key: "onboarding.stalled",
    tenantId: input.tenantId,
    stepKey: input.stepKey,
    attemptId: input.attemptId,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    isTest: input.isTest,
  };
}

/** Live registry adapter; delivery rows remain pending until their provider worker records receipt. */
export function createChannelNotificationRepository(): ChannelNotificationRepository {
  const client = createSupabaseServiceClient();
  const destinationRepository = createAlertDestinationRepository();
  return {
    resolveRule: async (eventKey) => {
      const { data, error } = await client
        .from("alert_rules")
        .select("id,event_key,default_enabled,audience_roles,default_destinations,suppressible,include_success_owner,include_billing_contact")
        .eq("event_key", eventKey)
        .eq("scope", "tenant")
        .single();
      if (error || !data) return null;
      return {
        id: data.id,
        eventKey: data.event_key as ChannelEventKey,
        defaultEnabled: data.default_enabled,
        audienceRoles: Array.isArray(data.audience_roles) ? data.audience_roles : [],
        defaultDestinations: Array.isArray(data.default_destinations)
          ? data.default_destinations as NotificationDestination[]
          : [],
        suppressible: data.suppressible,
        includeSuccessOwner: data.include_success_owner,
        includeBillingContact: data.include_billing_contact,
      };
    },
    resolveRecipients: (rule, event) => resolveAlertDestinations({
      id: rule.id,
      scope: "tenant",
      audienceRoles: rule.audienceRoles,
      includeSuccessOwner: rule.includeSuccessOwner ?? false,
      includeBillingContact: rule.includeBillingContact ?? false,
      defaultDestinations: rule.defaultDestinations,
      suppressible: rule.suppressible ?? true,
    }, event, destinationRepository),
    insertNotification: async (input) => {
      if (!input.sourceEventId) throw new Error("NOTIFICATION_SOURCE_EVENT_REQUIRED");
      const { data, error } = await client.rpc("record_alert_rule_notification", {
        p_notification_id: null,
        p_tenant_id: input.tenantId,
        p_user_id: input.userId,
        p_recipient_email: input.recipientEmail ?? null,
        p_rule_id: input.ruleId,
        p_source_event_id: input.sourceEventId,
        p_event_key: input.eventKey,
        p_title: input.title,
        p_body: input.body,
        p_link: input.link,
        p_is_test: input.isTest ?? false,
      });
      if (error || typeof data !== "string" || !data.trim()) {
        throw new Error("NOTIFICATION_WRITE_FAILED");
      }
      return { notificationId: data };
    },
    insertDeliveryIntent: async (input) => {
      const bell = input.destination === "bell";
      const now = new Date().toISOString();
      const { error } = await client.from("notification_deliveries").upsert({
        notification_id: input.notificationId,
        destination: input.destination,
        ...(bell ? {
          status: "delivered",
          provider_reference: `bell:${input.notificationId}`,
          delivered_at: now,
          terminal_at: now,
        } : { next_attempt_at: now }),
      }, { onConflict: "notification_id,destination", ignoreDuplicates: true });
      if (error) throw new Error(`NOTIFICATION_DELIVERY_WRITE_FAILED:${error.message}`);
    },
  };
}

/** The producer-facing adapter keeps source owners on the registered channel-event path. */
export function createLiveChannelNotificationPort(): ChannelNotificationPort {
  let emit: ReturnType<typeof createChannelEventEmitter> | null = null;
  return {
    emit: async (event) => {
      emit ??= createChannelEventEmitter(createChannelNotificationRepository());
      return emit(event);
    },
  };
}
