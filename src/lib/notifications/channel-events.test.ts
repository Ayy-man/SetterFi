import { describe, expect, it } from "vitest";

import type { ChannelDomainEvent } from "@/lib/booking/types";

import {
  CHANNEL_EVENT_KEYS,
  a2pClearedEvent,
  channelDisconnectedEvent,
  createChannelEventEmitter,
  continuationUnavailableEvent,
  needsHumanEvent,
  onboardingStalledEvent,
  templateRejectedEvent,
  windowExpiredEvent,
  type ChannelEventKey,
  type ChannelNotificationRepository,
  type ChannelNotificationRule,
} from "./channel-events";

function eventFor(key: ChannelEventKey): ChannelDomainEvent {
  if (key === "send.refused.window_expired") {
    return windowExpiredEvent({
      tenantId: "tenant-1",
      conversationId: "conversation-1",
      channel: "whatsapp",
      isTest: false,
      occurredAt: "2026-08-17T12:00:00.000Z",
    });
  }
  if (key === "message_template.rejected") {
    return templateRejectedEvent({
      tenantId: "tenant-1",
      templateId: "template-1",
      channel: "whatsapp",
      rejectionReason: "Synthetic policy mismatch",
      isTest: false,
      occurredAt: "2026-08-17T12:00:00.000Z",
    });
  }
  if (key === "conversation.channel_continuation_unavailable") {
    return continuationUnavailableEvent({
      tenantId: "tenant-1",
      conversationId: "conversation-1",
      channel: "whatsapp",
      reason: "PROVIDER_WINDOW_EXPIRED",
      isTest: false,
      occurredAt: "2026-08-17T12:00:00.000Z",
    });
  }
  if (key === "channel.disconnected") {
    return channelDisconnectedEvent({
      tenantId: "tenant-1", connectionId: "connection-1", channel: "whatsapp",
      commandReceiptId: "command-receipt-1", isTest: false,
      occurredAt: "2026-08-17T12:00:00.000Z",
    });
  }
  if (key === "onboarding.a2p_cleared") {
    return a2pClearedEvent({
      tenantId: "tenant-1", probeReceiptId: "probe-receipt-1", isTest: false,
      occurredAt: "2026-08-17T12:00:00.000Z",
    });
  }
  if (key === "onboarding.stalled") {
    return onboardingStalledEvent({
      tenantId: "tenant-1", stepKey: "sms_live", attemptId: "attempt-1", isTest: false,
      occurredAt: "2026-08-17T12:00:00.000Z",
    });
  }
  return needsHumanEvent({
    tenantId: "tenant-1",
    conversationId: "conversation-1",
    isTest: false,
    occurredAt: "2026-08-17T12:00:00.000Z",
  });
}

function harness() {
  const resolved: ChannelEventKey[] = [];
  const notifications: Parameters<ChannelNotificationRepository["insertNotification"]>[0][] = [];
  const deliveries: Parameters<ChannelNotificationRepository["insertDeliveryIntent"]>[0][] = [];
  const rules = new Map<ChannelEventKey, ChannelNotificationRule>(
    CHANNEL_EVENT_KEYS.map((eventKey) => [eventKey, {
      id: `rule:${eventKey}`,
      eventKey,
      defaultEnabled: true,
      audienceRoles: ["coach"],
      defaultDestinations: ["bell", "email"],
    }]),
  );
  const repository: ChannelNotificationRepository = {
    async resolveRule(eventKey) {
      resolved.push(eventKey);
      return rules.get(eventKey) ?? null;
    },
    async resolveRecipients() {
      return [{ userId: "coach-1", destinations: ["bell", "email"] }];
    },
    async insertNotification(input) {
      notifications.push(input);
      return { notificationId: `notification-${notifications.length}` };
    },
    async insertDeliveryIntent(input) {
      deliveries.push(input);
    },
  };
  return { repository, rules, resolved, notifications, deliveries };
}

describe("channel domain events", () => {
  it("pins the additive Phase 4 registry", () => {
    expect(CHANNEL_EVENT_KEYS).toEqual([
      "send.refused.window_expired",
      "message_template.rejected",
      "conversation.needs_human",
      "conversation.channel_continuation_unavailable",
      "channel.disconnected",
      "onboarding.a2p_cleared",
      "onboarding.stalled",
    ]);
  });

  it("resolves every channel event through the registered repository", async () => {
    const h = harness();
    const emit = createChannelEventEmitter(h.repository);

    for (const key of CHANNEL_EVENT_KEYS) await emit(eventFor(key));

    expect(h.resolved).toEqual(CHANNEL_EVENT_KEYS);
    expect(h.notifications.map((row) => row.eventKey)).toEqual(CHANNEL_EVENT_KEYS);
    expect(h.deliveries).toHaveLength(CHANNEL_EVENT_KEYS.length * 2);
  });

  it("emits the registered alert when a message template is rejected", async () => {
    const h = harness();
    const emit = createChannelEventEmitter(h.repository);

    await emit(eventFor("message_template.rejected"));

    expect(h.notifications).toEqual([expect.objectContaining({
      eventKey: "message_template.rejected",
      title: "Message template rejected",
      link: "/coach/integrations",
    })]);
  });

  it("names and links the durable records behind each newly bound alert", async () => {
    const h = harness();
    const emit = createChannelEventEmitter(h.repository);
    await emit(eventFor("channel.disconnected"));
    await emit(eventFor("onboarding.a2p_cleared"));
    await emit(eventFor("onboarding.stalled"));
    expect(h.notifications).toEqual([
      expect.objectContaining({
        eventKey: "channel.disconnected",
        sourceEventId: "connection-1:command-receipt-1",
        link: "/coach/integrations?connectionId=connection-1",
      }),
      expect.objectContaining({
        eventKey: "onboarding.a2p_cleared",
        sourceEventId: "probe-receipt-1",
        link: "/coach/get-started",
      }),
      expect.objectContaining({
        eventKey: "onboarding.stalled",
        sourceEventId: "sms_live:attempt-1",
        link: "/coach/get-started",
      }),
    ]);
  });

  it("keeps test events in the tenant bell without outbound delivery intent", async () => {
    const h = harness();
    const emit = createChannelEventEmitter(h.repository);

    await emit({ ...eventFor("send.refused.window_expired"), isTest: true });

    expect(h.resolved).toEqual(["send.refused.window_expired"]);
    expect(h.notifications).toEqual([expect.objectContaining({
      title: "Test · Message window expired",
      isTest: true,
    })]);
    expect(h.deliveries).toEqual([{ notificationId: "notification-1", destination: "bell" }]);
  });

  it("fails closed if the seeded rule is unavailable", async () => {
    const h = harness();
    h.rules.delete("conversation.needs_human");
    const emit = createChannelEventEmitter(h.repository);

    await expect(emit(eventFor("conversation.needs_human"))).rejects.toThrow(
      "NOTIFICATION_RULE_NOT_REGISTERED:conversation.needs_human",
    );
  });

  it("keeps unknown channel keys outside the compile-time registry", () => {
    // @ts-expect-error The domain registry is deliberately closed.
    const unknown: ChannelEventKey = "conversation.imagined_state";
    expect(unknown).toBe("conversation.imagined_state");
  });
});
