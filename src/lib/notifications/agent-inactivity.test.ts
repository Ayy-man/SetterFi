import { describe, expect, it, vi } from "vitest";

import {
  AGENT_INACTIVITY_EVENT_KEY,
  createAgentInactivityEmitter,
  runAgentInactivitySweep,
  selectAgentInactivityEvents,
  type AgentInactivityRepository,
} from "./agent-inactivity";

const NOW = new Date("2026-08-30T12:00:00.000Z");

function repository(overrides: Partial<AgentInactivityRepository> = {}): AgentInactivityRepository {
  return {
    listInactiveAgents: vi.fn().mockResolvedValue([]),
    resolveRule: vi.fn().mockResolvedValue({
      id: "rule-1", defaultEnabled: true, audienceRoles: ["coach"],
      defaultDestinations: ["bell", "email"], suppressible: true,
      includeSuccessOwner: false, includeBillingContact: false,
    }),
    resolveRecipients: vi.fn().mockResolvedValue([
      { userId: "coach-1", destinations: ["bell", "email"] },
    ]),
    insertNotification: vi.fn().mockResolvedValue({ notificationId: "notification-1" }),
    insertDeliveryIntent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("agent inactivity notifications", () => {
  it("uses the last durable agent message as the inactivity-episode identity", () => {
    const events = selectAgentInactivityEvents([
      { tenantId: "quiet", lastAgentMessageId: "message-old", lastAgentMessageAt: "2026-08-27T12:00:00.000Z", isTest: false },
      { tenantId: "active", lastAgentMessageId: "message-new", lastAgentMessageAt: "2026-08-29T12:00:01.000Z", isTest: false },
    ], NOW);
    expect(events).toEqual([expect.objectContaining({
      key: AGENT_INACTIVITY_EVENT_KEY, tenantId: "quiet", lastAgentMessageId: "message-old",
    })]);
  });

  it("persists the durable notification before writing delivery intent", async () => {
    const repo = repository();
    await createAgentInactivityEmitter(repo)({
      key: AGENT_INACTIVITY_EVENT_KEY, tenantId: "tenant-1", lastAgentMessageId: "message-1",
      lastAgentMessageAt: "2026-08-27T12:00:00.000Z", isTest: false,
    });
    expect(repo.insertNotification).toHaveBeenCalledWith(expect.objectContaining({
      sourceEventId: "message-1", title: "Agent inactive for 72 hours", link: "/coach/conversations",
    }));
    expect(repo.insertDeliveryIntent).toHaveBeenNthCalledWith(1, {
      notificationId: "notification-1", destination: "bell",
    });
  });

  it("keeps a demo or test sweep in the bell without outbound delivery intent", async () => {
    const repo = repository({
      resolveRecipients: vi.fn().mockResolvedValue([{ userId: "coach-1", destinations: ["bell", "email"] }]),
    });
    await createAgentInactivityEmitter(repo)({
      key: AGENT_INACTIVITY_EVENT_KEY, tenantId: "tenant-1", lastAgentMessageId: "message-1",
      lastAgentMessageAt: "2026-08-27T12:00:00.000Z", isTest: true,
    });
    expect(repo.insertDeliveryIntent).toHaveBeenCalledTimes(1);
    expect(repo.insertDeliveryIntent).toHaveBeenCalledWith({ notificationId: "notification-1", destination: "bell" });
  });

  it("does not invent an inactivity fact for a tenant without an agent message", async () => {
    const repo = repository({ listInactiveAgents: vi.fn().mockResolvedValue([]) });
    await expect(runAgentInactivitySweep(repo, NOW)).resolves.toEqual({ selected: 0, emitted: 0 });
    expect(repo.resolveRule).not.toHaveBeenCalled();
  });
});
