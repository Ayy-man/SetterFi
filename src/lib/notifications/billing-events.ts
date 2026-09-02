import { createHash } from "node:crypto";
import type {
  BillingNotificationEvent,
  BillingNotificationEventKey,
  BillingNotificationPort,
} from "@/lib/billing/contracts";
import type {
  NotificationDestination,
  NotificationRecipient,
  NotificationRule,
} from "@/lib/notifications/events";
import {
  createAlertDestinationRepository,
  resolveAlertDestinations,
} from "@/lib/notifications/resolver";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { notificationDestination } from "@/lib/notifications/destinations";

export type BillingNotificationRepository = {
  resolveRule(key: BillingNotificationEventKey): Promise<NotificationRule | null>;
  isDemoTenant(tenantId: string): Promise<boolean>;
  resolveRecipients(
    rule: NotificationRule,
    tenantId: string,
    isTest?: boolean,
  ): Promise<NotificationRecipient[]>;
  insertNotification(input: {
    tenantId: string;
    userId: string | null;
    recipientEmail: string | null;
    ruleId: string;
    eventKey: BillingNotificationEventKey;
    title: string;
    body: string;
    link: string;
    idempotencyKey: string;
    isTest: boolean;
  }): Promise<{ notificationId: string }>;
  insertDeliveryIntent(input: {
    notificationId: string;
    destination: NotificationDestination;
  }): Promise<void>;
};

const TITLES: Record<BillingNotificationEventKey, string> = {
  "billing.payment_completed": "Payment completed",
  "billing.payment_failed": "Payment failed",
  "billing.account_overdue": "Account overdue",
  "billing.account_suspended": "Account suspended",
  "billing.allowance_warning": "Allowance warning",
  "billing.allowance_crossed": "Allowance crossed",
  "billing.tier_upgraded": "Tier upgraded",
};

export function resolveBillingDestinations(
  rule: Pick<NotificationRule, "suppressible" | "defaultDestinations">,
  preferences: readonly { destination: NotificationDestination; enabled: boolean }[],
) {
  return (rule.defaultDestinations ?? ["bell"]).filter((destination) => {
    if (!rule.suppressible) return true;
    return preferences.find((item) => item.destination === destination)?.enabled ?? true;
  });
}

function content(event: BillingNotificationEvent, isDemo: boolean) {
  if (event.key === "billing.payment_completed") {
    return {
      title: isDemo ? "Test · Payment completed" : "Payment completed",
      body: `Invoice ${event.invoiceId} was paid.`,
      link: notificationDestination({ key: "coach.billing" }),
    };
  }
  return {
    title: isDemo ? `Test · ${TITLES[event.key]}` : TITLES[event.key],
    body: `SETTERFI_DEMO_PLACEHOLDER_${event.key.toUpperCase().replaceAll(".", "_")}`,
    link: notificationDestination({ key: "coach.billing" }),
  };
}

function eventIdentity(event: BillingNotificationEvent) {
  if (event.key === "billing.payment_completed" || event.key === "billing.payment_failed" || event.key === "billing.account_overdue") return event.invoiceId;
  if (event.key === "billing.account_suspended") return String(event.auditId);
  return event.allowanceActionId;
}

export function billingNotificationId(idempotencyKey: string) {
  const hash = createHash("sha256").update(idempotencyKey, "utf8").digest("hex").slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20)}`;
}

export function createBillingEventEmitter(
  repository: BillingNotificationRepository,
): BillingNotificationPort {
  return {
    emit: async (event) => {
      const rule = await repository.resolveRule(event.key);
      if (!rule) throw new Error(`NOTIFICATION_RULE_NOT_REGISTERED:${event.key}`);
      if (!rule.defaultEnabled) throw new Error(`BILLING_RULE_DISABLED:${event.key}`);
      const isTest = event.isTest || await repository.isDemoTenant(event.tenantId);
      const fields = content(event, isTest);
      const recipients = await repository.resolveRecipients(rule, event.tenantId, isTest);
      const notificationIds: string[] = [];
      for (const recipient of recipients) {
        const destinations = isTest
          ? ["bell" as const]
          : [...new Set(recipient.destinations)];
        if (destinations.length === 0) continue;
        const receipt = await repository.insertNotification({
          tenantId: event.tenantId,
          userId: recipient.userId,
          recipientEmail: recipient.recipientEmail ?? null,
          ruleId: rule.id,
          eventKey: event.key,
          idempotencyKey:
            `${event.key}:${event.tenantId}:${eventIdentity(event)}:`
            + `${recipient.userId ?? recipient.recipientEmail}`,
          isTest,
          ...fields,
        });
        if (!receipt.notificationId.trim()) throw new Error("BILLING_NOTICE_RECEIPT_INVALID");
        notificationIds.push(receipt.notificationId);
        for (const destination of destinations) {
          await repository.insertDeliveryIntent({
            notificationId: receipt.notificationId,
            destination,
          });
        }
      }
      if (notificationIds.length === 0) throw new Error("BILLING_NOTIFICATION_RECIPIENT_REQUIRED");
      return { notificationId: notificationIds[0] };
    },
  };
}

export function createBillingNotificationRepository(): BillingNotificationRepository {
  const client = createSupabaseServiceClient();
  const destinationRepository = createAlertDestinationRepository();
  return {
    resolveRule: async (key) => {
      const { data, error } = await client.from("alert_rules")
        .select("id,event_key,name,default_enabled,suppressible,include_success_owner,include_billing_contact,scope,audience_roles,default_destinations")
        .eq("event_key", key).eq("scope", "tenant").single();
      if (error || !data) return null;
      return {
        id: data.id, eventKey: data.event_key, name: data.name,
        defaultEnabled: data.default_enabled, suppressible: data.suppressible,
        includeBillingContact: data.include_billing_contact, scope: "tenant",
        includeSuccessOwner: data.include_success_owner,
        audienceRoles: Array.isArray(data.audience_roles) ? data.audience_roles : [],
        defaultDestinations: Array.isArray(data.default_destinations)
          ? data.default_destinations as NotificationDestination[] : [],
      } as NotificationRule;
    },
    isDemoTenant: async (tenantId) => {
      const { data, error } = await client.from("tenants").select("is_demo").eq("id", tenantId).single();
      if (error || !data) throw new Error("BILLING_TENANT_READ_FAILED");
      return data.is_demo === true;
    },
    resolveRecipients: (rule, tenantId, isTest = false) => resolveAlertDestinations({
      id: rule.id,
      scope: "tenant",
      audienceRoles: rule.audienceRoles ?? [],
      includeSuccessOwner: rule.includeSuccessOwner ?? false,
      includeBillingContact: rule.includeBillingContact,
      defaultDestinations: rule.defaultDestinations ?? ["bell"],
      suppressible: rule.suppressible,
    }, { tenantId, isTest }, destinationRepository),
    insertNotification: async (input) => {
      const id = billingNotificationId(input.idempotencyKey);
      const { data, error } = await client.rpc("record_alert_rule_notification", {
        p_notification_id: id,
        p_tenant_id: input.tenantId,
        p_user_id: input.userId,
        p_recipient_email: input.recipientEmail,
        p_rule_id: input.ruleId,
        p_source_event_id: input.idempotencyKey,
        p_event_key: input.eventKey,
        p_title: input.title,
        p_body: input.body,
        p_link: input.link,
        p_is_test: input.isTest,
      });
      if (error || data !== id) throw new Error("BILLING_NOTIFICATION_WRITE_FAILED");
      const persisted = await client.from("notifications")
        .select("id,tenant_id,user_id,recipient_email,kind")
        .eq("id", id).single();
      if (persisted.error || !persisted.data || persisted.data.tenant_id !== input.tenantId
        || persisted.data.user_id !== input.userId
        || persisted.data.recipient_email !== input.recipientEmail
        || persisted.data.kind !== input.eventKey) {
        throw new Error("BILLING_NOTIFICATION_READBACK_MISMATCH");
      }
      return { notificationId: id };
    },
    insertDeliveryIntent: async (input) => {
      const bell = input.destination === "bell";
      const now = new Date().toISOString();
      const { error } = await client.from("notification_deliveries").upsert({
        notification_id: input.notificationId, destination: input.destination,
        ...(bell ? {
          status: "delivered", provider_reference: `bell:${input.notificationId}`,
          delivered_at: now, terminal_at: now,
        } : { next_attempt_at: now }),
      }, { onConflict: "notification_id,destination", ignoreDuplicates: true });
      if (error) throw new Error("BILLING_DELIVERY_INTENT_WRITE_FAILED");
    },
  };
}

export function createLiveBillingNotificationPort() {
  let live: BillingNotificationPort | null = null;
  return {
    emit: (event: BillingNotificationEvent) => {
      live ??= createBillingEventEmitter(createBillingNotificationRepository());
      return live.emit(event);
    },
  } satisfies BillingNotificationPort;
}
