/**
 * Recipient resolution for every registry-backed alert.
 *
 * Event owners supply only a rule and source fact. This module derives users, billing addresses,
 * preferences and test-only bell behavior so no emitter can widen recipients or choose an address.
 */

import type { NotificationDestination } from "@/lib/notifications/events";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type AlertDestinationRule = {
  id: string;
  scope: "tenant" | "platform";
  audienceRoles: readonly string[];
  includeSuccessOwner: boolean;
  includeBillingContact: boolean;
  defaultDestinations: readonly NotificationDestination[];
  suppressible: boolean;
};

export type AlertDestinationEvent = {
  tenantId: string | null;
  isTest: boolean;
};

export type AlertDestinationUser = {
  id: string;
  tenantId: string | null;
  email: string | null;
};

export type AlertPreference = {
  userId: string;
  destination: NotificationDestination;
  enabled: boolean;
};

export type ResolvedAlertDestination = {
  userId: string | null;
  recipientEmail: string | null;
  destinations: NotificationDestination[];
};

export type AlertDestinationRepository = {
  listAudienceUsers(input: {
    tenantId: string | null;
    roles: readonly string[];
  }): Promise<AlertDestinationUser[]>;
  getTenantRouting(tenantId: string): Promise<{
    successOwnerId: string | null;
    billingContactEmail: string | null;
  }>;
  getUser(userId: string): Promise<AlertDestinationUser | null>;
  findTenantUserByEmail(tenantId: string, email: string): Promise<AlertDestinationUser | null>;
  listPreferences(ruleId: string, userIds: readonly string[]): Promise<AlertPreference[]>;
};

function destinationsForUser(
  rule: AlertDestinationRule,
  event: AlertDestinationEvent,
  userId: string,
  preferences: readonly AlertPreference[],
) {
  const defaults = event.isTest ? ["bell" as const] : [...rule.defaultDestinations];
  if (!rule.suppressible) return [...new Set(defaults)];
  return [...new Set(defaults)].filter((destination) =>
    preferences.find((preference) =>
      preference.userId === userId && preference.destination === destination)?.enabled ?? true);
}

export async function resolveAlertDestinations(
  rule: AlertDestinationRule,
  event: AlertDestinationEvent,
  repository: AlertDestinationRepository,
): Promise<ResolvedAlertDestination[]> {
  if (event.isTest && (rule.scope === "platform" || event.tenantId === null)) return [];

  const users = new Map((await repository.listAudienceUsers({
    tenantId: rule.scope === "tenant" ? event.tenantId : null,
    roles: rule.audienceRoles,
  })).map((user) => [user.id, user]));
  let billingContactEmail: string | null = null;

  if (event.tenantId !== null && (rule.includeSuccessOwner || rule.includeBillingContact)) {
    const routing = await repository.getTenantRouting(event.tenantId);
    if (rule.includeSuccessOwner && routing.successOwnerId) {
      const successOwner = await repository.getUser(routing.successOwnerId);
      if (successOwner) users.set(successOwner.id, successOwner);
    }
    if (rule.includeBillingContact && routing.billingContactEmail?.trim()) {
      billingContactEmail = routing.billingContactEmail.trim();
      const billingUser = await repository.findTenantUserByEmail(
        event.tenantId,
        billingContactEmail,
      );
      if (billingUser) users.set(billingUser.id, billingUser);
    }
  }

  const userIds = [...users.keys()];
  const preferences = userIds.length === 0
    ? []
    : await repository.listPreferences(rule.id, userIds);
  const resolved: ResolvedAlertDestination[] = [...users.values()].map((user) => ({
    userId: user.id,
    recipientEmail: user.email,
    destinations: destinationsForUser(rule, event, user.id, preferences),
  })).filter((recipient) => recipient.destinations.length > 0);

  if (!event.isTest && billingContactEmail
    && !resolved.some((recipient) => recipient.recipientEmail === billingContactEmail)) {
    const emailEnabled = !rule.suppressible || rule.defaultDestinations.includes("email");
    if (emailEnabled) resolved.push({
      userId: null,
      recipientEmail: billingContactEmail,
      destinations: ["email"],
    });
  }

  return resolved;
}

export function createAlertDestinationRepository(): AlertDestinationRepository {
  const client = createSupabaseServiceClient();
  return {
    listAudienceUsers: async ({ tenantId, roles }) => {
      if (roles.length === 0) return [];
      let query = client.from("users").select("id,tenant_id,email").in("role", [...roles]);
      query = tenantId === null ? query.is("tenant_id", null) : query.eq("tenant_id", tenantId);
      const { data, error } = await query;
      if (error) throw new Error("NOTIFICATION_RECIPIENTS_READ_FAILED");
      return (data ?? []).map((user) => ({
        id: user.id,
        tenantId: user.tenant_id,
        email: user.email,
      }));
    },
    getTenantRouting: async (tenantId) => {
      const { data, error } = await client.from("tenants")
        .select("success_owner,billing_contact_email").eq("id", tenantId).single();
      if (error || !data) throw new Error("NOTIFICATION_TENANT_ROUTING_READ_FAILED");
      return {
        successOwnerId: data.success_owner,
        billingContactEmail: data.billing_contact_email,
      };
    },
    getUser: async (userId) => {
      const { data, error } = await client.from("users")
        .select("id,tenant_id,email").eq("id", userId).maybeSingle();
      if (error) throw new Error("NOTIFICATION_RECIPIENTS_READ_FAILED");
      return data ? { id: data.id, tenantId: data.tenant_id, email: data.email } : null;
    },
    findTenantUserByEmail: async (tenantId, email) => {
      const { data, error } = await client.from("users").select("id,tenant_id,email")
        .eq("tenant_id", tenantId).eq("email", email).maybeSingle();
      if (error) throw new Error("NOTIFICATION_RECIPIENTS_READ_FAILED");
      return data ? { id: data.id, tenantId: data.tenant_id, email: data.email } : null;
    },
    listPreferences: async (ruleId, userIds) => {
      if (userIds.length === 0) return [];
      const { data, error } = await client.from("notification_preferences")
        .select("user_id,destination,enabled").eq("rule_id", ruleId).in("user_id", [...userIds]);
      if (error) throw new Error("NOTIFICATION_PREFERENCES_READ_FAILED");
      return (data ?? []).map((preference) => ({
        userId: preference.user_id,
        destination: preference.destination as NotificationDestination,
        enabled: preference.enabled,
      }));
    },
  };
}
