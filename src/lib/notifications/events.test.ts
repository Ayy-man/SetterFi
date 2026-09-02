import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { AlertEventKey, BookingDomainEvent, BookingEventKey } from "@/lib/booking/types";

import {
  ALERT_EVENT_KEYS,
  BOOKING_EVENT_KEYS,
  DOMAIN_EVENT_KEYS,
  buildBookingNotificationContent,
  createBookingEventEmitter,
  createComplianceEventEmitter,
  suppressionProviderUnconfirmedEvent,
  conversationTripwireEscalatedEvent,
  contactDeletedEvent,
  domainEventFromCalendarHealth,
  type NotificationRepository,
  type NotificationRule,
} from "./events";

const bookedEvent: Extract<BookingDomainEvent, { key: "appointment.booked" }> = {
  key: "appointment.booked",
  tenantId: "tenant-1",
  conversationId: "conversation-1",
  contactId: "contact-1",
  providerContactId: "provider-contact-1",
  leadName: "Jordan Lee",
  channel: "sms",
  leadTimezone: "America/Los_Angeles",
  qualification: {
    creditBand: "680–719",
    fundingGoal: "$50K–100K",
    timeline: "1–3 months",
  },
  isTest: false,
  appointmentId: "appointment-1",
  calendarConnectionId: "calendar-1",
  calendarTimezone: "America/New_York",
  startAt: "2026-08-20T14:00:00.000Z",
  endAt: "2026-08-20T14:30:00.000Z",
  attributedToAgent: true,
};

function makeRepository() {
  const rules = new Map<AlertEventKey, NotificationRule>(
    BOOKING_EVENT_KEYS.map((eventKey) => [
      eventKey,
      {
        id: `rule:${eventKey}`,
        eventKey,
        name: eventKey,
        defaultEnabled: true,
        suppressible: true,
        includeBillingContact: false,
      },
    ]),
  );
  const notifications: Parameters<NotificationRepository["insertNotification"]>[0][] = [];
  const deliveries: Parameters<NotificationRepository["insertDeliveryIntent"]>[0][] = [];
  const resolvedEvents: AlertEventKey[] = [];
  const repository: NotificationRepository = {
    async resolveRule(eventKey) {
      resolvedEvents.push(eventKey);
      return rules.get(eventKey) ?? null;
    },
    async resolveRecipients(_rule, event) {
      if (event.key === "appointment.booked") {
        return [
          { userId: "coach-owner", destinations: ["bell", "email"] },
          { userId: "assigned-calendar-user", destinations: ["bell"] },
        ];
      }
      return [{ userId: "coach-owner", destinations: ["bell"] }];
    },
    async insertNotification(input) {
      notifications.push(input);
      return { notificationId: `notification-${notifications.length}` };
    },
    async insertDeliveryIntent(input) {
      deliveries.push(input);
    },
  };
  return { repository, rules, notifications, deliveries, resolvedEvents };
}

function eventFor(key: BookingEventKey): BookingDomainEvent {
  if (key === "appointment.booked") return bookedEvent;
  if (key === "appointment.rescheduled") {
    return {
      ...bookedEvent,
      key,
      priorStartAt: "2026-08-20T13:00:00.000Z",
      priorEndAt: "2026-08-20T13:30:00.000Z",
    };
  }
  if (key === "appointment.canceled") {
    return { ...bookedEvent, key, cancelSource: "coach" };
  }
  if (key === "brain.publish_failed") {
    return {
      key,
      tenantId: null,
      occurredAt: "2026-08-20T14:00:00.000Z",
      actorId: "platform-admin",
      draftId: "draft-1",
      errorCode: "BRAIN_PUBLISH_FAILED",
      isTest: false,
    };
  }
  return {
    key,
    tenantId: bookedEvent.tenantId,
    calendarConnectionId: bookedEvent.calendarConnectionId,
    occurredAt: "2026-08-20T14:00:00.000Z",
    error: "CALENDAR_SLOT_FETCH_FAILED",
    isTest: false,
  };
}

describe("booking domain events", () => {
  it("pins every registered booking, calendar, and Brain event key", () => {
    expect(BOOKING_EVENT_KEYS).toEqual([
      "appointment.booked",
      "appointment.rescheduled",
      "appointment.canceled",
      "calendar.connection_unhealthy",
      "brain.publish_failed",
    ]);
  });

  it("keeps booking compatibility while appending the exact Phase 3 alert-event union", () => {
    expect(ALERT_EVENT_KEYS).toEqual([
      ...BOOKING_EVENT_KEYS,
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
    ]);
  });

  it("matches the frozen Phase 3 event-key and scope rows in migration and exact DB tests", () => {
    const expected = [
      "contact.deleted:tenant",
      "conversation.tripwire_escalated:platform",
      "conversation.tripwire_escalated:tenant",
      "suppression.provider_unconfirmed:platform",
      "suppression.provider_unconfirmed:tenant",
    ];
    const migration = readFileSync(resolve(
      process.cwd(),
      "supabase/migrations/20260819000001_phase3_compliance_safety.sql",
    ), "utf8");
    const alertBlock = migration.match(
      /insert into public\.alert_rules[\s\S]*?on conflict \(event_key, scope\) do nothing/,
    )?.[0] ?? "";
    const migrationRows = [...alertBlock.matchAll(
      /\('([a-z0-9_.]+)', '(tenant|platform)'/g,
    )].map((entry) => `${entry[1]}:${entry[2]}`).sort();
    const phase1Test = readFileSync(resolve(
      process.cwd(),
      "supabase/tests/phase1-schema.test.ts",
    ), "utf8");
    const phase1Rows = [...phase1Test.matchAll(/"([a-z0-9_.]+:(?:tenant|platform))"/g)]
      .map((entry) => entry[1])
      .filter((row) => expected.includes(row))
      .sort();

    expect(migrationRows).toEqual(expected);
    expect(phase1Rows).toEqual(expected);
  });

  it("resolves every synthetic state event through the registry rather than a notifier", async () => {
    const { repository, resolvedEvents, notifications } = makeRepository();
    const emit = createBookingEventEmitter(repository);

    for (const key of BOOKING_EVENT_KEYS) await emit(eventFor(key));

    expect(resolvedEvents).toEqual(BOOKING_EVENT_KEYS);
    expect(notifications.map((row) => row.eventKey)).toEqual([
      "appointment.booked",
      "appointment.booked",
      "appointment.rescheduled",
      "appointment.canceled",
      "calendar.connection_unhealthy",
      "brain.publish_failed",
    ]);
  });

  it("resolves a failed Brain publish through its platform rule without tenant scope", async () => {
    const { repository, notifications } = makeRepository();
    const emit = createBookingEventEmitter(repository);

    await emit(eventFor("brain.publish_failed"));

    expect(notifications).toEqual([
      expect.objectContaining({
        tenantId: null,
        eventKey: "brain.publish_failed",
        title: "Brain publish failed",
        link: "/admin/brain",
        content: {
          actorId: "platform-admin",
          draftId: "draft-1",
          errorCode: "BRAIN_PUBLISH_FAILED",
        },
      }),
    ]);
  });

  it("persists the six booking content fields and no platform economics", async () => {
    const { repository, notifications, deliveries } = makeRepository();
    const emit = createBookingEventEmitter(repository);

    await emit(bookedEvent);

    const expectedContent = {
      leadName: "Jordan Lee",
      channel: "sms",
      slot:
        "2026-08-20 10:00 America/New_York " +
        "(2026-08-20 07:00 America/Los_Angeles)",
      qualification: "Credit: 680–719; Funding goal: $50K–100K; Timeline: 1–3 months",
      conversationDeepLink: "/coach/conversations?conversationId=conversation-1",
      agentBooked: true,
    };
    expect(buildBookingNotificationContent(bookedEvent)).toEqual(expectedContent);
    expect(notifications).toHaveLength(2);
    expect(notifications[0].content).toEqual(expectedContent);
    expect(Object.keys(notifications[0].content).sort()).toEqual([
      "agentBooked",
      "channel",
      "conversationDeepLink",
      "leadName",
      "qualification",
      "slot",
    ]);
    expect(JSON.stringify(notifications)).not.toMatch(/cost|margin/i);
    expect(deliveries).toEqual([
      { notificationId: "notification-1", destination: "bell" },
      { notificationId: "notification-1", destination: "email" },
      { notificationId: "notification-2", destination: "bell" },
    ]);
  });

  it("keeps a test appointment in the originating tenant bell with zero outbound intent", async () => {
    const { repository, notifications, deliveries, resolvedEvents } = makeRepository();
    const emit = createBookingEventEmitter(repository);

    await emit({ ...bookedEvent, isTest: true });

    expect(resolvedEvents).toEqual(["appointment.booked"]);
    expect(notifications).toHaveLength(2);
    expect(notifications.every((row) => row.title.startsWith("Test · "))).toBe(true);
    expect(deliveries).toEqual([
      { notificationId: "notification-1", destination: "bell" },
      { notificationId: "notification-2", destination: "bell" },
    ]);
  });

  it("does not persist an invisible row when a recipient has disabled every destination", async () => {
    const { repository, notifications, deliveries } = makeRepository();
    repository.resolveRecipients = async () => [{ userId: "coach-owner", destinations: [] }];
    const emit = createBookingEventEmitter(repository);

    await emit(bookedEvent);

    expect(notifications).toEqual([]);
    expect(deliveries).toEqual([]);
  });

  it("fails closed when a state owner emits an unregistered rule", async () => {
    const { repository, rules } = makeRepository();
    rules.delete("appointment.canceled");
    const emit = createBookingEventEmitter(repository);

    await expect(emit(eventFor("appointment.canceled"))).rejects.toThrow(
      "NOTIFICATION_RULE_NOT_REGISTERED:appointment.canceled",
    );
  });

  it("turns a failed slot-fetch health write into the named unhealthy event", () => {
    expect(
      domainEventFromCalendarHealth({
        kind: "unhealthy",
        tenantId: "tenant-1",
        calendarConnectionId: "calendar-1",
        fetchedAt: "2026-08-20T14:00:00.000Z",
        error: "CALENDAR_SLOT_FETCH_FAILED",
        isTest: false,
      }),
    ).toEqual({
      key: "calendar.connection_unhealthy",
      tenantId: "tenant-1",
      calendarConnectionId: "calendar-1",
      occurredAt: "2026-08-20T14:00:00.000Z",
      error: "CALENDAR_SLOT_FETCH_FAILED",
      isTest: false,
    });
  });

  // Phase 4
  it("widens the domain registry without changing the existing booking key order", () => {
    expect(DOMAIN_EVENT_KEYS).toEqual([
      ...BOOKING_EVENT_KEYS,
      "conversation.tripwire_escalated",
      "conversation.outbound_send_unconfirmed",
      "suppression.provider_unconfirmed",
      "contact.deleted",
      "send.refused.window_expired",
      "message_template.rejected",
      "conversation.needs_human",
      "conversation.channel_continuation_unavailable",
    ]);
  });
});

describe("Phase 3 compliance events", () => {
  it("emits exact scoped keys as notification intents without claiming delivery", async () => {
    const { repository, rules, notifications, deliveries } = makeRepository();
    for (const [key, scopes] of [
      ["suppression.provider_unconfirmed", ["tenant", "platform"]],
      ["conversation.tripwire_escalated", ["tenant", "platform"]],
      ["contact.deleted", ["tenant"]],
    ] as const) {
      for (const scope of scopes) {
        rules.set(key, {
          id: `rule:${key}:${scope}`,
          eventKey: key,
          name: key,
          defaultEnabled: true,
          suppressible: true,
          includeBillingContact: false,
          scope,
          defaultDestinations: ["bell", "email"],
        });
      }
    }
    repository.resolveRule = async (eventKey, scope = "tenant") => ({
      id: `rule:${eventKey}:${scope}`,
      eventKey,
      name: eventKey,
      defaultEnabled: true,
      suppressible: true,
      includeBillingContact: false,
      scope,
      defaultDestinations: ["bell", "email"],
    });
    repository.resolveRecipients = async (rule) => [{
      userId: `${rule.scope}-recipient`,
      destinations: ["bell", "email"],
    }];
    const emit = createComplianceEventEmitter(repository);

    await emit(suppressionProviderUnconfirmedEvent({
      tenantId: "tenant-1", suppressionId: "suppression-1",
      occurredAt: "2026-08-17T00:00:00.000Z", isTest: false,
    }));
    await emit(conversationTripwireEscalatedEvent({
      tenantId: "tenant-1", conversationId: "conversation-1", tripwireClass: "guarantee",
      occurredAt: "2026-08-17T00:00:00.000Z", isTest: false,
    }));
    await emit(contactDeletedEvent({
      tenantId: "tenant-1", contactId: "contact-1", auditId: 51,
      occurredAt: "2026-08-17T00:00:00.000Z", isTest: false,
    }));

    expect(notifications.map((row) => `${row.eventKey}:${row.tenantId === null ? "platform" : "tenant"}`)).toEqual([
      "suppression.provider_unconfirmed:tenant",
      "suppression.provider_unconfirmed:platform",
      "conversation.tripwire_escalated:tenant",
      "conversation.tripwire_escalated:platform",
      "contact.deleted:tenant",
    ]);
    expect(deliveries).toHaveLength(10);
    expect(deliveries.filter((intent) => intent.destination === "email")).toHaveLength(5);
    expect(deliveries.filter((intent) => intent.destination === "bell")).toHaveLength(5);
  });

  it("keeps test compliance events in the tenant bell and outside outbound delivery", async () => {
    const { repository, rules, notifications, deliveries } = makeRepository();
    rules.set("contact.deleted", {
      id: "rule:contact.deleted:tenant",
      eventKey: "contact.deleted",
      name: "Contact deleted",
      defaultEnabled: true,
      suppressible: true,
      includeBillingContact: false,
      scope: "tenant",
      defaultDestinations: ["bell", "email"],
    });
    const emit = createComplianceEventEmitter(repository);
    await emit(contactDeletedEvent({
      tenantId: "tenant-1", contactId: "contact-1", auditId: 51,
      occurredAt: "2026-08-17T00:00:00.000Z", isTest: true,
    }));
    expect(notifications).toEqual([expect.objectContaining({
      eventKey: "contact.deleted",
      title: "Test · Contact deleted",
      isTest: true,
    })]);
    expect(deliveries).toEqual([{ notificationId: "notification-1", destination: "bell" }]);
  });
});
