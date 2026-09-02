import Stripe from "stripe";
import { describe, expect, it } from "vitest";

import {
  createMockStripeDriver,
  createMockStripeEventFixtures,
  mockStripeWebhookBody,
} from "./mock";

const NOW = new Date("2026-08-17T12:00:00.000Z");
const SYNTHETIC_SIGNING_SECRET = "synthetic-stripe-webhook-signing-secret";

function signedFixture(ageSeconds = 0) {
  const event = createMockStripeEventFixtures({ clock: () => new Date(NOW) }).invoicePaid;
  const rawBody = mockStripeWebhookBody(event);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: new TextDecoder().decode(rawBody),
    secret: SYNTHETIC_SIGNING_SECRET,
    timestamp: Math.floor(NOW.getTime() / 1_000) - ageSeconds,
  });
  return { event, rawBody, signature };
}

function driver() {
  return createMockStripeDriver({
    clock: () => new Date(NOW),
    webhookSecret: SYNTHETIC_SIGNING_SECRET,
  });
}

describe("Stripe raw webhook signature contract", () => {
  it("accepts the exact signed bytes and normalizes their money event", () => {
    const fixture = signedFixture();
    expect(driver().verifyWebhook(fixture.rawBody, fixture.signature)).toEqual(fixture.event);
  });

  it("rejects a parsed and reserialized body even when its JSON value is unchanged", () => {
    const fixture = signedFixture();
    const parsed = JSON.parse(new TextDecoder().decode(fixture.rawBody)) as unknown;
    const reserialized = new TextEncoder().encode(JSON.stringify(parsed, null, 2));

    expect(() => driver().verifyWebhook(reserialized, fixture.signature)).toThrow(
      /No signatures found matching the expected signature/,
    );
  });

  it("accepts the 300-second boundary and rejects a signature one second older", () => {
    const boundary = signedFixture(300);
    const stale = signedFixture(301);

    expect(() => driver().verifyWebhook(boundary.rawBody, boundary.signature)).not.toThrow();
    expect(() => driver().verifyWebhook(stale.rawBody, stale.signature)).toThrow(
      /Timestamp outside the tolerance zone/,
    );
  });

  it("fails closed on a missing or incorrect signature", () => {
    const fixture = signedFixture();
    expect(() => driver().verifyWebhook(fixture.rawBody, "")).toThrow();
    expect(() => driver().verifyWebhook(
      fixture.rawBody,
      Stripe.webhooks.generateTestHeaderString({
        payload: new TextDecoder().decode(fixture.rawBody),
        secret: "different-synthetic-signing-secret",
        timestamp: Math.floor(NOW.getTime() / 1_000),
      }),
    )).toThrow(/No signatures found matching the expected signature/);
  });
});
