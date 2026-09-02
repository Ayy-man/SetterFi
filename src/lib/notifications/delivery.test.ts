import { describe, expect, it, vi } from "vitest";

import { createMockEmailDriver } from "@/lib/integrations/email/mock";
import { deliveryLabel } from "@/lib/notifications/bell";
import {
  acceptedReceiptExpired,
  createSlackWebhookPacer,
  deliverClaimedNotification,
  recoveryForExpiredLease,
  retryAtForAttempt,
} from "./delivery";

const claim = {
  deliveryId: "delivery", notificationId: "notification", attemptId: "attempt", attemptNumber: 1,
  destination: "email" as const, tenantId: "tenant", userId: "user", recipientEmail: "user@example.test",
  destinationUrl: null, eventKey: "event", title: "title", body: "body", link: null, isTest: false,
};
const copy = { emailSubject: "subject", emailBody: "body", slackText: "slack" };

describe("notification delivery", () => {
  it("uses the exact retry ladder and lets a later provider instant win", () => {
    const now = new Date("2026-08-18T00:00:00.000Z");
    expect([1, 2, 3, 4, 5, 6].map((attempt) => retryAtForAttempt(attempt, now, null))).toEqual([
      "2026-08-18T00:01:00.000Z", "2026-08-18T00:05:00.000Z", "2026-08-18T00:30:00.000Z",
      "2026-08-18T02:00:00.000Z", "2026-08-18T05:00:00.000Z", null,
    ]);
    expect(retryAtForAttempt(1, now, 600)).toBe("2026-08-18T00:10:00.000Z");
  });

  it("recovers an expired lease without reusing its immutable attempt", () => {
    const now = new Date("2026-08-18T00:00:00.000Z");
    expect(recoveryForExpiredLease(2, now)).toEqual({
      status: "failed", attemptOutcome: "retryable", retryAt: "2026-08-18T00:05:00.000Z",
    });
    expect(recoveryForExpiredLease(6, now)).toEqual({
      status: "unavailable", attemptOutcome: "unavailable", retryAt: null,
    });
  });

  it("expires accepted email only after the signed-receipt window", () => {
    const now = new Date("2026-08-19T00:00:00.000Z");
    expect(acceptedReceiptExpired("2026-08-18T00:00:00.001Z", now)).toBe(false);
    expect(acceptedReceiptExpired("2026-08-18T00:00:00.000Z", now)).toBe(true);
  });

  it("records email acceptance without claiming delivery", async () => {
    const finish = vi.fn(async () => undefined);
    const outcome = await deliverClaimedNotification({
      claim, workerId: "worker", now: new Date("2026-08-18T00:00:00.000Z"), emailFrom: "from@example.test",
      repository: { loadCopy: vi.fn(async () => copy), finish },
      email: { deliverEmail: vi.fn(async () => ({ kind: "accepted" as const, providerReference: "email-id" })) },
      slack: { postSlack: vi.fn() },
    });
    expect(outcome).toEqual({ outcome: "accepted" });
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ outcome: "accepted", providerReference: "email-id" }));
  });

  it("keeps an accepted mock email at sent rather than delivered", async () => {
    const finish = vi.fn(async () => undefined);
    const email = createMockEmailDriver();
    const outcome = await deliverClaimedNotification({
      claim, workerId: "worker", now: new Date("2026-08-18T00:00:00.000Z"), emailFrom: "from@example.test",
      repository: { loadCopy: vi.fn(async () => copy), finish },
      email, slack: { postSlack: vi.fn() },
    });
    expect(email.records).toHaveLength(1);
    expect(outcome).toEqual({ outcome: "accepted" });
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ outcome: "accepted" }));
    expect(deliveryLabel([{ destination: "email", status: "accepted" }])).toBe("Sent");
  });

  it("never invokes a provider for a test or demo claim", async () => {
    const email = vi.fn();
    const slack = vi.fn();
    const finish = vi.fn(async () => undefined);
    await deliverClaimedNotification({
      claim: { ...claim, isTest: true }, workerId: "worker", emailFrom: "mock@example.test",
      repository: { loadCopy: vi.fn(), finish },
      email: { deliverEmail: email }, slack: { postSlack: slack },
    });
    expect(email).not.toHaveBeenCalled();
    expect(slack).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ outcome: "unavailable", errorCode: "TEST_DELIVERY_BLOCKED" }));
  });

  it("paces repeated Slack calls to one webhook at one request per second", async () => {
    let clock = 1_000;
    const sleep = vi.fn(async (milliseconds: number) => { clock += milliseconds; });
    const pace = createSlackWebhookPacer({ now: () => clock, sleep });
    await pace("https://hooks.slack.test/a");
    clock += 250;
    await pace("https://hooks.slack.test/a");
    await pace("https://hooks.slack.test/b");
    expect(sleep).toHaveBeenCalledWith(750);
  });
});
