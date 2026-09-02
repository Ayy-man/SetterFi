import { describe, expect, it, vi } from "vitest";

import {
  createNotificationDeliveryJobHandler,
  notificationDriversForClaim,
} from "./handler";

const receipt = {
  scheduled: 3, recovered: 1, expired: 1, claimed: 2,
  accepted: 1, delivered: 1, retryable: 0, unavailable: 0,
};

describe("notification delivery job", () => {
  it("returns 404 before constructing live work while disabled", async () => {
    const run = vi.fn(async () => receipt);
    const response = await createNotificationDeliveryJobHandler({
      enabled: () => false, secret: "secret", run,
    })(new Request("http://local/api/jobs/notification-deliveries"));
    expect(response.status).toBe(404);
    expect(run).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("constructs only the provider selected by the claimed destination", () => {
    const email = { deliverEmail: vi.fn() };
    const slack = { postSlack: vi.fn() };
    const resolvers = {
      email: vi.fn(() => email),
      slack: vi.fn(() => slack),
    };

    expect(notificationDriversForClaim({ destination: "email", isTest: false }, resolvers).email)
      .toBe(email);
    expect(resolvers.email).toHaveBeenCalledWith(false);
    expect(resolvers.slack).not.toHaveBeenCalled();

    resolvers.email.mockClear();
    expect(notificationDriversForClaim({ destination: "slack", isTest: false }, resolvers).slack)
      .toBe(slack);
    expect(resolvers.slack).toHaveBeenCalledWith(false);
    expect(resolvers.email).not.toHaveBeenCalled();
  });

  it("uses the CRON bearer guard and returns bounded job counts", async () => {
    const run = vi.fn(async () => receipt);
    const handler = createNotificationDeliveryJobHandler({ enabled: () => true, secret: "secret", run });
    const denied = await handler(new Request("http://local/api/jobs/notification-deliveries", {
      headers: { authorization: "Bearer wrong" },
    }));
    expect(denied.status).toBe(401);
    const response = await handler(new Request("http://local/api/jobs/notification-deliveries", {
      headers: { authorization: "Bearer secret" },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(receipt);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
