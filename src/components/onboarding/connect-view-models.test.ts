import { describe, expect, it } from "vitest";

import {
  connectCards,
  connectStepComplete,
} from "@/components/onboarding/connect-view-models";
import type { ChannelConnectionView } from "@/lib/repositories/channel-connections";
import type { CoachA2pRegistrationProjection } from "@/lib/repositories/onboarding-evidence";

function connection(overrides: Partial<ChannelConnectionView> = {}): ChannelConnectionView {
  return {
    capabilities: {} as ChannelConnectionView["capabilities"],
    channel: "instagram",
    channelLabel: "Instagram",
    createdAt: "2026-08-20T10:00:00.000Z",
    error: null,
    externalAccountLabel: "@reidfundinggroup",
    id: "connection-1",
    receipts: {
      assetVerifiedAt: null,
      oauthCompletedAt: null,
      signedRoundTripAt: null,
      webhookSubscribedAt: null,
    },
    state: "disconnected",
    tokenExpiresAt: null,
    updatedAt: "2026-08-20T10:00:00.000Z",
    ...overrides,
  };
}

function registration(
  overrides: Partial<CoachA2pRegistrationProjection> = {},
): CoachA2pRegistrationProjection {
  return {
    registrationState: "awaiting_provider",
    submittedAt: null,
    terminalCode: null,
    terminalRejection: false,
    ...overrides,
  };
}

const card = (cards: ReturnType<typeof connectCards>, key: string) =>
  cards.find((entry) => entry.key === key)!;

describe("connectCards", () => {
  it("draws three cards, in the artboard's order", () => {
    const cards = connectCards({ connections: [], registration: null });
    expect(cards.map((entry) => entry.key)).toEqual(["instagram", "messenger", "sms"]);
  });

  it("offers a connect action and asserts no state when nothing is connected", () => {
    const instagram = card(connectCards({ connections: [], registration: null }), "instagram");
    expect(instagram.status).toBeNull();
    expect(instagram.detail).toBeNull();
    expect(instagram.action).toEqual({ href: "/coach/get-started", label: "Connect Instagram" });
  });

  it("reads answering only from a signed round trip, never from a live state alone", () => {
    const withoutReceipt = card(
      connectCards({
        connections: [connection({ state: "live" })],
        registration: null,
      }),
      "instagram",
    );
    expect(withoutReceipt.status?.label).not.toBe("Answering");

    const withReceipt = card(
      connectCards({
        connections: [
          connection({
            receipts: {
              assetVerifiedAt: null,
              oauthCompletedAt: null,
              signedRoundTripAt: "2026-08-28T09:00:00.000Z",
              webhookSubscribedAt: null,
            },
            state: "live",
          }),
        ],
        registration: null,
      }),
      "instagram",
    );
    expect(withReceipt.status).toEqual({ label: "Answering", tone: "good" });
    expect(withReceipt.detail).toBe("@reidfundinggroup");
    expect(withReceipt.action).toBeNull();
  });

  it("says a ready connection is not answering yet rather than calling it done", () => {
    const ready = card(
      connectCards({ connections: [connection({ state: "ready" })], registration: null }),
      "instagram",
    );
    expect(ready.status).toEqual({ label: "Not answering yet", tone: "waiting" });
    expect(ready.note).toContain("not answering");
  });

  it("omits the account line rather than inventing a handle when the label is blank", () => {
    const blank = card(
      connectCards({
        connections: [
          connection({
            externalAccountLabel: "   ",
            receipts: {
              assetVerifiedAt: null,
              oauthCompletedAt: null,
              signedRoundTripAt: "2026-08-28T09:00:00.000Z",
              webhookSubscribedAt: null,
            },
            state: "live",
          }),
        ],
        registration: null,
      }),
      "instagram",
    );
    expect(blank.detail).toBeNull();
  });

  it("offers filing and no clock before SMS details are sent", () => {
    const sms = card(connectCards({ connections: [], registration: registration() }), "sms");
    expect(sms.wait).toBeNull();
    expect(sms.action).toEqual({
      href: "/onboarding/sms-eligibility",
      label: "Send my details to the carriers",
    });
  });

  it("counts days and withdraws every control once SMS is with the carriers", () => {
    const sms = card(
      connectCards({
        connections: [],
        registration: registration({ submittedAt: "2026-08-20T10:00:00.000Z" }),
      }),
      "sms",
    );
    expect(sms.wait).toEqual({ since: "2026-08-20T10:00:00.000Z" });
    expect(sms.action).toBeNull();
    expect(sms.status).toEqual({ label: "With the carriers", tone: "waiting" });
  });

  it("never predicts a date or a percentage on the SMS card", () => {
    for (const projection of [
      null,
      registration(),
      registration({ submittedAt: "2026-08-20T10:00:00.000Z" }),
      registration({ terminalCode: "CARRIER_REFUSED", terminalRejection: true }),
    ]) {
      const sms = card(connectCards({ connections: [], registration: projection }), "sms");
      const text = `${sms.body} ${sms.note} ${sms.status?.label ?? ""}`;
      expect(text).not.toMatch(/%/);
      expect(text).not.toMatch(/\bby [A-Z][a-z]+ \d/);
      expect(text).not.toMatch(/all set|ready to go|complete/i);
    }
  });

  it("names no GoHighLevel destination on any card", () => {
    const cards = connectCards({
      connections: [connection({ state: "ready" })],
      registration: registration({ submittedAt: "2026-08-20T10:00:00.000Z" }),
    });
    const rendered = JSON.stringify(cards).toLowerCase();
    expect(rendered).not.toContain("gohighlevel");
    expect(rendered).not.toContain("ghl");
  });

  it("sends a refused registration to the screen that can fix it", () => {
    const sms = card(
      connectCards({
        connections: [],
        registration: registration({ terminalCode: "CARRIER_REFUSED", terminalRejection: true }),
      }),
      "sms",
    );
    expect(sms.status?.tone).toBe("failure");
    expect(sms.action?.href).toBe("/coach/integrations");
  });
});

describe("connectStepComplete", () => {
  const live = (channel: ChannelConnectionView["channel"]) =>
    connection({
      channel,
      receipts: {
        assetVerifiedAt: null,
        oauthCompletedAt: null,
        signedRoundTripAt: "2026-08-28T09:00:00.000Z",
        webhookSubscribedAt: null,
      },
      state: "live",
    });

  it("ticks on a Meta channel with a signed round trip", () => {
    expect(connectStepComplete([live("messenger")])).toBe(true);
  });

  it("does not tick on a ready connection", () => {
    expect(connectStepComplete([connection({ state: "ready" })])).toBe(false);
  });

  it("does not tick on a live connection with no round trip receipt", () => {
    expect(connectStepComplete([connection({ state: "live" })])).toBe(false);
  });

  it("never ticks on SMS, which is weeks from working when the rest of setup is done", () => {
    expect(connectStepComplete([live("sms")])).toBe(false);
  });
});
