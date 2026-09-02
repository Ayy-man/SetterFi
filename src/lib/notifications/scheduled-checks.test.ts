import { describe, expect, it, vi } from "vitest";

import {
  runScheduledAlertChecks,
  selectScheduledAlertEvents,
  type ScheduledAlertEvent,
} from "./scheduled-checks";

const NOW = new Date("2026-08-18T12:00:00.000Z");

describe("scheduled alert checks", () => {
  it("emits stable source facts once thresholds are crossed", () => {
    const events = selectScheduledAlertEvents({
      hasPublishedSnapshot: false,
      now: NOW,
      conversations: [
        { conversationId: "four", tenantId: "tenant", needsHumanAt: "2026-08-18T08:00:00.000Z", isTest: false, isDemo: false },
        { conversationId: "day", tenantId: "tenant", needsHumanAt: "2026-08-17T12:00:00.000Z", isTest: false, isDemo: false },
      ],
    });
    expect(events.map((event) => `${event.key}:${event.scope}`)).toEqual([
      "brain.no_published_snapshot:platform",
      "conversation.needs_human.unclaimed_4h:tenant",
      "conversation.needs_human.unclaimed_4h:tenant",
      "conversation.needs_human.unclaimed_24h:tenant",
    ]);
    expect(events.map((event) => event.sourceEventId)).toEqual([
      "brain:no-published-snapshot", "four:unclaimed:4h", "day:unclaimed:4h", "day:unclaimed:24h",
    ]);
  });

  it("labels demo and test facts and leaves dedupe to stable persistence", async () => {
    const persist = vi.fn<(event: ScheduledAlertEvent) => Promise<void>>(async () => undefined);
    const repository = {
      hasPublishedSnapshot: vi.fn(async () => true),
      listUnclaimedNeedsHuman: vi.fn(async () => [{
        conversationId: "demo", tenantId: "tenant", needsHumanAt: "2026-08-17T12:00:00.000Z",
        isTest: false, isDemo: true,
      }]),
      persist,
    };
    await runScheduledAlertChecks(repository, NOW);
    await runScheduledAlertChecks(repository, NOW);
    expect(persist).toHaveBeenCalledTimes(4);
    expect(new Set(persist.mock.calls.map(([event]) => event.sourceEventId))).toEqual(
      new Set(["demo:unclaimed:4h", "demo:unclaimed:24h"]),
    );
    expect(persist.mock.calls.every(([event]) => event.isTest)).toBe(true);
  });
});
