/** Nightly alert facts derived from durable platform and conversation state. */

import type { NotificationDestination } from "@/lib/notifications/events";
import {
  createAlertDestinationRepository,
  resolveAlertDestinations,
} from "@/lib/notifications/resolver";
import { claimFairNeedsHumanIds } from "@/lib/jobs/fair-scan";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { notificationDestination } from "@/lib/notifications/destinations";

export const SCHEDULED_ALERT_EVENT_KEYS = [
  "brain.no_published_snapshot:platform",
  "conversation.needs_human.unclaimed_4h:tenant",
  "conversation.needs_human.unclaimed_24h:tenant",
] as const;

export type ScheduledAlertEvent = {
  key: "brain.no_published_snapshot" | "conversation.needs_human.unclaimed_4h" | "conversation.needs_human.unclaimed_24h";
  scope: "tenant" | "platform";
  tenantId: string | null;
  sourceEventId: string;
  title: string;
  body: string;
  link: string | null;
  isTest: boolean;
};

export type NeedsHumanFact = {
  conversationId: string;
  tenantId: string;
  needsHumanAt: string;
  isTest: boolean;
  isDemo: boolean;
};

export function selectScheduledAlertEvents(input: {
  hasPublishedSnapshot: boolean;
  conversations: readonly NeedsHumanFact[];
  now: Date;
}): ScheduledAlertEvent[] {
  const events: ScheduledAlertEvent[] = [];
  if (!input.hasPublishedSnapshot) events.push({
    key: "brain.no_published_snapshot",
    scope: "platform",
    tenantId: null,
    sourceEventId: "brain:no-published-snapshot",
    title: "The Brain has no published snapshot",
    body: "The nightly check found no published Brain snapshot.",
    link: notificationDestination({ key: "admin.brain" }),
    isTest: false,
  });
  for (const conversation of input.conversations) {
    const ageMs = input.now.getTime() - Date.parse(conversation.needsHumanAt);
    const thresholds = [
      { hours: 4, key: "conversation.needs_human.unclaimed_4h" as const },
      { hours: 24, key: "conversation.needs_human.unclaimed_24h" as const },
    ];
    for (const threshold of thresholds) {
      if (ageMs < threshold.hours * 60 * 60 * 1_000) continue;
      events.push({
        key: threshold.key,
        scope: "tenant",
        tenantId: conversation.tenantId,
        sourceEventId: `${conversation.conversationId}:unclaimed:${threshold.hours}h`,
        title: `${threshold.hours}-hour needs-human alert`,
        body: `A conversation has remained unclaimed for ${threshold.hours} hours.`,
        link: notificationDestination({
          key: "coach.conversation",
          conversationId: conversation.conversationId,
        }),
        isTest: conversation.isTest || conversation.isDemo,
      });
    }
  }
  return events;
}

export type ScheduledCheckRepository = {
  hasPublishedSnapshot(): Promise<boolean>;
  listUnclaimedNeedsHuman(): Promise<NeedsHumanFact[]>;
  persist(event: ScheduledAlertEvent): Promise<void>;
};

export async function runScheduledAlertChecks(
  repository: ScheduledCheckRepository,
  now = new Date(),
) {
  const [hasPublishedSnapshot, conversations] = await Promise.all([
    repository.hasPublishedSnapshot(),
    repository.listUnclaimedNeedsHuman(),
  ]);
  const events = selectScheduledAlertEvents({ hasPublishedSnapshot, conversations, now });
  for (const event of events) await repository.persist(event);
  return { selected: events.length };
}

export function createLiveScheduledCheckRepository(): ScheduledCheckRepository {
  const client = createSupabaseServiceClient();
  const destinations = createAlertDestinationRepository();
  return {
    hasPublishedSnapshot: async () => {
      const { data, error } = await client.from("brain_snapshots").select("id").limit(1).maybeSingle();
      if (error) throw new Error("SCHEDULED_BRAIN_READ_FAILED");
      return Boolean(data);
    },
    listUnclaimedNeedsHuman: async () => {
      const conversationIds = await claimFairNeedsHumanIds(client, 100);
      if (conversationIds.length === 0) return [];
      const { data, error } = await client.from("conversations")
        .select("id,tenant_id,needs_human_at,is_test,tenant:tenants!inner(is_demo)")
        .in("id", conversationIds)
        .eq("status", "needs_human").is("taken_over_by", null).not("needs_human_at", "is", null);
      if (error) throw new Error("SCHEDULED_NEEDS_HUMAN_READ_FAILED");
      return (data ?? []).map((row) => ({
        conversationId: row.id,
        tenantId: row.tenant_id,
        needsHumanAt: row.needs_human_at as string,
        isTest: row.is_test,
        isDemo: Boolean((row.tenant as unknown as { is_demo: boolean }).is_demo),
      }));
    },
    persist: async (event) => {
      const { data: rule, error: ruleError } = await client.from("alert_rules")
        .select("id,default_enabled,suppressible,include_billing_contact,include_success_owner,audience_roles,default_destinations")
        .eq("event_key", event.key).eq("scope", event.scope).single();
      if (ruleError || !rule) throw new Error(`NOTIFICATION_RULE_NOT_REGISTERED:${event.key}:${event.scope}`);
      if (!rule.default_enabled) return;
      const recipients = await resolveAlertDestinations({
        id: rule.id,
        scope: event.scope,
        audienceRoles: Array.isArray(rule.audience_roles) ? rule.audience_roles : [],
        includeSuccessOwner: rule.include_success_owner,
        includeBillingContact: rule.include_billing_contact,
        defaultDestinations: Array.isArray(rule.default_destinations)
          ? rule.default_destinations as NotificationDestination[] : [],
        suppressible: rule.suppressible,
      }, event, destinations);
      for (const recipient of recipients) {
        const selected = event.isTest ? ["bell" as const] : recipient.destinations;
        if (selected.length === 0) continue;
        const row = {
          tenant_id: event.tenantId,
          user_id: recipient.userId,
          recipient_email: recipient.recipientEmail,
          rule_id: rule.id,
          source_event_id: event.sourceEventId,
          kind: event.key,
          title: event.isTest ? `Test · ${event.title}` : event.title,
          body: event.body,
          link: event.link,
          content: {},
          is_test: event.isTest,
        };
        let notificationId: string;
        const inserted = await client.from("notifications").insert(row).select("id").single();
        if (!inserted.error && inserted.data) notificationId = inserted.data.id;
        else if (inserted.error?.code === "23505") {
          let query = client.from("notifications").select("id")
            .eq("rule_id", rule.id).eq("source_event_id", event.sourceEventId);
          query = recipient.userId === null ? query.is("user_id", null) : query.eq("user_id", recipient.userId);
          query = recipient.recipientEmail === null
            ? query.is("recipient_email", null) : query.eq("recipient_email", recipient.recipientEmail);
          const existing = await query.single();
          if (existing.error || !existing.data) throw new Error("SCHEDULED_NOTIFICATION_DEDUPE_READ_FAILED");
          notificationId = existing.data.id;
        } else throw new Error("SCHEDULED_NOTIFICATION_WRITE_FAILED");
        const now = new Date().toISOString();
        for (const destination of selected) {
          const bell = destination === "bell";
          const delivery = await client.from("notification_deliveries").upsert({
            notification_id: notificationId,
            destination,
            ...(bell ? {
              status: "delivered", provider_reference: `bell:${notificationId}`,
              delivered_at: now, terminal_at: now,
            } : { next_attempt_at: now }),
          }, { onConflict: "notification_id,destination", ignoreDuplicates: true });
          if (delivery.error) throw new Error("SCHEDULED_DELIVERY_WRITE_FAILED");
        }
      }
    },
  };
}
