/**
 * Durable agent-inactivity notifications.
 *
 * Activity means a persisted production `messages` row written by the agent (`direction = out`,
 * `author = agent`). A tenant with no such row is deliberately absent from the sweep: it has not
 * gone quiet after agent activity, so it is not an inactivity episode. The last agent message ID
 * is the episode identity. `notifications_rule_recipient_source_uidx` therefore makes the durable
 * notification one-per-recipient-per-episode; a later agent message starts a new possible episode.
 */

import type { NotificationDestination, NotificationRecipient } from "@/lib/notifications/events";
import {
  createAlertDestinationRepository,
  resolveAlertDestinations,
} from "@/lib/notifications/resolver";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { notificationDestination } from "@/lib/notifications/destinations";

export const AGENT_INACTIVITY_EVENT_KEY = "agent.inactive_72h" as const;
export const AGENT_INACTIVITY_ALERT_EVENT_KEYS = [
  `${AGENT_INACTIVITY_EVENT_KEY}:tenant`,
] as const;
export const AGENT_INACTIVITY_THRESHOLD_MS = 72 * 60 * 60 * 1_000;

export type AgentInactivityFact = {
  tenantId: string;
  lastAgentMessageId: string;
  lastAgentMessageAt: string;
  isTest: boolean;
};

type AgentInactivityCandidateRow = {
  tenant_id: string;
  last_agent_message_id: string;
  last_agent_message_at: string;
  is_test: boolean;
};

export type AgentInactivityEvent = AgentInactivityFact & {
  key: typeof AGENT_INACTIVITY_EVENT_KEY;
};

export type AgentInactivityNotificationRule = {
  id: string;
  defaultEnabled: boolean;
  audienceRoles: readonly string[];
  defaultDestinations: readonly NotificationDestination[];
  suppressible: boolean;
  includeSuccessOwner: boolean;
  includeBillingContact: boolean;
};

export type AgentInactivityRepository = {
  listInactiveAgents(before: string): Promise<readonly AgentInactivityFact[]>;
  resolveRule(): Promise<AgentInactivityNotificationRule | null>;
  resolveRecipients(
    rule: AgentInactivityNotificationRule,
    event: AgentInactivityEvent,
  ): Promise<NotificationRecipient[]>;
  insertNotification(input: {
    tenantId: string;
    userId: string | null;
    recipientEmail: string | null;
    ruleId: string;
    sourceEventId: string;
    title: string;
    body: string;
    link: string;
    isTest: boolean;
  }): Promise<{ notificationId: string }>;
  insertDeliveryIntent(input: {
    notificationId: string;
    destination: NotificationDestination;
  }): Promise<void>;
};

export function selectAgentInactivityEvents(
  facts: readonly AgentInactivityFact[],
  now: Date,
): AgentInactivityEvent[] {
  return facts.filter((fact) => {
    const at = Date.parse(fact.lastAgentMessageAt);
    return Number.isFinite(at) && now.getTime() - at >= AGENT_INACTIVITY_THRESHOLD_MS;
  }).map((fact) => ({ ...fact, key: AGENT_INACTIVITY_EVENT_KEY }));
}

export function createAgentInactivityEmitter(repository: AgentInactivityRepository) {
  return async function emit(event: AgentInactivityEvent) {
    const rule = await repository.resolveRule();
    if (!rule) throw new Error(`NOTIFICATION_RULE_NOT_REGISTERED:${event.key}`);
    if (!rule.defaultEnabled) return { notificationIds: [] as string[] };

    const recipients = await repository.resolveRecipients(rule, event);
    const notificationIds: string[] = [];
    for (const recipient of recipients) {
      const destinations = event.isTest ? ["bell" as const] : [...new Set(recipient.destinations)];
      if (destinations.length === 0) continue;
      const notification = await repository.insertNotification({
        tenantId: event.tenantId,
        userId: recipient.userId,
        recipientEmail: recipient.recipientEmail ?? null,
        ruleId: rule.id,
        sourceEventId: event.lastAgentMessageId,
        title: event.isTest ? "Test · Agent inactive for 72 hours" : "Agent inactive for 72 hours",
        body: `The agent has not sent a message since ${event.lastAgentMessageAt}.`,
        link: notificationDestination({ key: "coach.conversations" }),
        isTest: event.isTest,
      });
      if (!notification.notificationId.trim()) throw new Error("AGENT_INACTIVITY_NOTIFICATION_RECEIPT_INVALID");
      notificationIds.push(notification.notificationId);
      for (const destination of destinations) {
        await repository.insertDeliveryIntent({ notificationId: notification.notificationId, destination });
      }
    }
    if (notificationIds.length === 0) throw new Error("AGENT_INACTIVITY_NOTIFICATION_RECIPIENT_REQUIRED");
    return { notificationIds };
  };
}

export async function runAgentInactivitySweep(
  repository: AgentInactivityRepository,
  now = new Date(),
) {
  const events = selectAgentInactivityEvents(
    await repository.listInactiveAgents(new Date(now.getTime() - AGENT_INACTIVITY_THRESHOLD_MS).toISOString()),
    now,
  );
  const emit = createAgentInactivityEmitter(repository);
  let emitted = 0;
  for (const event of events) emitted += (await emit(event)).notificationIds.length;
  return { selected: events.length, emitted };
}

export function createLiveAgentInactivityRepository(): AgentInactivityRepository {
  const client = createSupabaseServiceClient();
  const destinations = createAlertDestinationRepository();
  return {
    listInactiveAgents: async (before) => {
      const { data, error } = await client.rpc("list_agent_inactivity_candidates", {
        p_inactive_before: before,
      });
      if (error) throw new Error("AGENT_INACTIVITY_CANDIDATE_READ_FAILED");
      return ((data ?? []) as AgentInactivityCandidateRow[]).map((row) => ({
        tenantId: row.tenant_id,
        lastAgentMessageId: row.last_agent_message_id,
        lastAgentMessageAt: row.last_agent_message_at,
        isTest: row.is_test === true,
      }));
    },
    resolveRule: async () => {
      const { data, error } = await client.from("alert_rules")
        .select("id,default_enabled,audience_roles,default_destinations,suppressible,include_success_owner,include_billing_contact")
        .eq("event_key", AGENT_INACTIVITY_EVENT_KEY).eq("scope", "tenant").single();
      if (error || !data) return null;
      return {
        id: data.id,
        defaultEnabled: data.default_enabled,
        audienceRoles: Array.isArray(data.audience_roles) ? data.audience_roles : [],
        defaultDestinations: Array.isArray(data.default_destinations)
          ? data.default_destinations as NotificationDestination[] : [],
        suppressible: data.suppressible,
        includeSuccessOwner: data.include_success_owner,
        includeBillingContact: data.include_billing_contact,
      };
    },
    resolveRecipients: (rule, event) => resolveAlertDestinations({
      id: rule.id,
      scope: "tenant",
      audienceRoles: rule.audienceRoles,
      includeSuccessOwner: rule.includeSuccessOwner,
      includeBillingContact: rule.includeBillingContact,
      defaultDestinations: rule.defaultDestinations,
      suppressible: rule.suppressible,
    }, event, destinations),
    insertNotification: async (input) => {
      const { data, error } = await client.rpc("record_alert_rule_notification", {
        p_notification_id: null,
        p_tenant_id: input.tenantId,
        p_user_id: input.userId,
        p_recipient_email: input.recipientEmail,
        p_rule_id: input.ruleId,
        p_source_event_id: input.sourceEventId,
        p_event_key: AGENT_INACTIVITY_EVENT_KEY,
        p_title: input.title,
        p_body: input.body,
        p_link: input.link,
        p_is_test: input.isTest,
      });
      if (error || typeof data !== "string" || !data.trim()) {
        throw new Error("AGENT_INACTIVITY_NOTIFICATION_WRITE_FAILED");
      }
      return { notificationId: data };
    },
    insertDeliveryIntent: async (input) => {
      const now = new Date().toISOString();
      const bell = input.destination === "bell";
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
      if (error) throw new Error("AGENT_INACTIVITY_DELIVERY_WRITE_FAILED");
    },
  };
}
