import { describe, expect, it } from "vitest";

import { deliveryLabel } from "./bell";

describe("bell delivery labels", () => {
  it.each([
    [[], "Recorded"],
    [[{ destination: "bell", status: "delivered" }], "Recorded"],
    [[{ destination: "email", status: "pending" }], "Queued"],
    [[{ destination: "email", status: "sending" }], "Queued"],
    [[{ destination: "email", status: "accepted" }], "Sent"],
    [[{ destination: "email", status: "delivered" }], "Delivered"],
    [[{ destination: "email", status: "failed" }], "Failed"],
    [[{ destination: "email", status: "unavailable" }], "Unavailable"],
  ] as const)("maps persisted %j to %s", (deliveries, label) => {
    expect(deliveryLabel(deliveries)).toBe(label);
  });

  it("does not let a delivered bell overstate an accepted email", () => {
    expect(deliveryLabel([
      { destination: "bell", status: "delivered" },
      { destination: "email", status: "accepted" },
    ])).toBe("Sent");
  });
});
