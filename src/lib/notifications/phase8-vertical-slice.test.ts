import { describe, expect, it, vi } from "vitest";

import { createMockEmailDriver } from "@/lib/integrations/email/mock";
import { createMockSlackDriver } from "@/lib/integrations/slack/mock";
import { deliverClaimedNotification } from "@/lib/notifications/delivery";
import { resolveAlertDestinations } from "@/lib/notifications/resolver";

const billingRule = {
  id: "rule-billing",
  scope: "tenant" as const,
  audienceRoles: [] as const,
  includeSuccessOwner: false,
  includeBillingContact: true,
  defaultDestinations: ["bell", "email"] as const,
  suppressible: false,
};

describe("Phase 8 receipt-backed vertical slice", () => {
  it("routes nonsuppressible billing email to a contact with no user account", async () => {
    const destinations = await resolveAlertDestinations(billingRule, {
      tenantId: "tenant-demo", isTest: false,
    }, {
      listAudienceUsers: async () => [],
      getTenantRouting: async () => ({ successOwnerId: null, billingContactEmail: "billing@example.invalid" }),
      getUser: async () => null,
      findTenantUserByEmail: async () => null,
      listPreferences: async () => [],
    });
    expect(destinations).toEqual([{
      userId: null, recipientEmail: "billing@example.invalid", destinations: ["email"],
    }]);
  });

  it("forces Test events to one bell destination even when the rule has outbound defaults", async () => {
    const destinations = await resolveAlertDestinations({
      ...billingRule, audienceRoles: ["coach"], includeBillingContact: false,
    }, { tenantId: "tenant-demo", isTest: true }, {
      listAudienceUsers: async () => [{ id: "coach", tenantId: "tenant-demo", email: "coach@example.invalid" }],
      getTenantRouting: async () => ({ successOwnerId: null, billingContactEmail: null }),
      getUser: async () => null,
      findTenantUserByEmail: async () => null,
      listPreferences: async () => [],
    });
    expect(destinations).toEqual([{
      userId: "coach", recipientEmail: "coach@example.invalid", destinations: ["bell"],
    }]);
  });

  it("blocks a test claim before either provider driver can run", async () => {
    const email = createMockEmailDriver();
    const slack = createMockSlackDriver();
    const finish = vi.fn(async () => undefined);
    const result = await deliverClaimedNotification({
      claim: {
        deliveryId: "delivery", notificationId: "notification", attemptId: "attempt",
        attemptNumber: 1, destination: "email", tenantId: "tenant-demo", userId: "coach",
        recipientEmail: "coach@example.invalid", destinationUrl: null, eventKey: "demo.test",
        title: "SETTERFI_DEMO_PLACEHOLDER_TITLE", body: "SETTERFI_DEMO_PLACEHOLDER_BODY",
        link: null, isTest: true,
      },
      workerId: "worker", repository: { loadCopy: vi.fn(), finish }, email, slack,
      emailFrom: "sender@example.invalid", now: new Date("2026-08-18T00:00:00Z"),
    });
    expect(result).toEqual({ outcome: "unavailable" });
    expect(email.records).toHaveLength(0);
    expect(slack.records).toHaveLength(0);
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "TEST_DELIVERY_BLOCKED" }));
  });

  it("persists retry then success as separate finish outcomes", async () => {
    const finish = vi.fn(async () => undefined);
    let calls = 0;
    const slack = {
      postSlack: vi.fn(async () => ++calls === 1
        ? { kind: "retry" as const, errorCode: "SETTERFI_DEMO_PLACEHOLDER_RETRY", retryAfterSeconds: null }
        : { kind: "delivered" as const, providerReference: "mock-slack:delivery:2" }),
    };
    const base = {
      deliveryId: "delivery", notificationId: "notification", attemptId: "attempt",
      destination: "slack" as const, tenantId: "tenant-demo", userId: "success",
      recipientEmail: null, destinationUrl: "mock://slack-sink", eventKey: "demo.retry",
      title: "SETTERFI_DEMO_PLACEHOLDER_TITLE", body: "SETTERFI_DEMO_PLACEHOLDER_BODY",
      link: null, isTest: false,
    };
    const repository = {
      loadCopy: async () => ({ emailSubject: null, emailBody: null,
        slackText: "SETTERFI_DEMO_PLACEHOLDER_SLACK" }),
      finish,
    };
    const email = createMockEmailDriver();
    expect(await deliverClaimedNotification({ claim: { ...base, attemptNumber: 1 }, workerId: "worker",
      repository, email, slack, emailFrom: "sender@example.invalid", now: new Date("2026-08-18T00:00:00Z") }))
      .toEqual({ outcome: "retryable" });
    expect(await deliverClaimedNotification({ claim: { ...base, attemptNumber: 2 }, workerId: "worker",
      repository, email, slack, emailFrom: "sender@example.invalid", now: new Date("2026-08-18T00:01:00Z") }))
      .toEqual({ outcome: "delivered" });
    expect(finish).toHaveBeenNthCalledWith(1, expect.objectContaining({ outcome: "retryable" }));
    expect(finish).toHaveBeenNthCalledWith(2, expect.objectContaining({ outcome: "delivered" }));
  });
});
