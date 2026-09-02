import { describe, expect, it } from "vitest";

import { COACH_PIPELINE_STAGES } from "@/components/workspace/live/measurement-view-models";
import { QUALIFICATION_OUTCOMES } from "@/lib/domain/qualification";
import { CHANNEL_CONNECTION_STATES } from "@/lib/repositories/channel-connections";
import { CONVERSATION_STATUSES } from "@/lib/repositories/conversations";

import {
  BILLING_INVOICE_STATE_COPY,
  BILLING_SUBSCRIPTION_STATE_COPY,
  CHANNEL_CONNECTION_STATE_COPY,
  CONVERSATION_STATE_COPY,
  MODERATOR_STATE_COPY,
  PIPELINE_STAGE_COPY,
  QUALIFICATION_OUTCOME_COPY,
  TRACE_RULE_FALLBACK_COPY,
  receiptState,
  type ChannelReceipts,
} from "./states";

const EMPTY_RECEIPTS: ChannelReceipts = {
  oauthCompletedAt: null,
  assetVerifiedAt: null,
  webhookSubscribedAt: null,
  signedRoundTripAt: null,
};

const BANNED_VOCABULARY = [
  "persisted",
  "projection",
  "RPC",
  "Unavailable",
  "Action refused",
  "readiness unavailable",
  "route-owned",
  "real-tenant boundary",
  "tombstone",
  "timestamptz",
  "cents",
  "artifact",
  "GoHighLevel",
  "GHL",
  "Twilio",
] as const;

describe("state copy", () => {
  it("maps every channel connection state", () => {
    expect(Object.keys(CHANNEL_CONNECTION_STATE_COPY)).toEqual(CHANNEL_CONNECTION_STATES);
  });

  it("maps every conversation state", () => {
    expect(Object.keys(CONVERSATION_STATE_COPY)).toEqual(CONVERSATION_STATUSES);
  });

  it("maps subscription and invoice states to coach-safe labels", () => {
    expect(BILLING_SUBSCRIPTION_STATE_COPY).toEqual({
      active: { label: "Active", tone: "good" },
      trialing: { label: "Trial", tone: "info" },
      past_due: { label: "Payment due", tone: "warning" },
      unpaid: { label: "Payment overdue", tone: "critical" },
      canceled: { label: "Canceled", tone: "neutral" },
      incomplete: { label: "Setup pending", tone: "warning" },
      incomplete_expired: { label: "Setup expired", tone: "critical" },
      paused: { label: "Paused", tone: "warning" },
    });
    expect(BILLING_INVOICE_STATE_COPY).toEqual({
      active: { label: "Current", tone: "good" },
      paid: { label: "Paid", tone: "good" },
      open: { label: "Open", tone: "neutral" },
      draft: { label: "Preparing", tone: "neutral" },
      past_due: { label: "Payment due", tone: "warning" },
      unpaid: { label: "Payment overdue", tone: "critical" },
      uncollectible: { label: "Needs attention", tone: "critical" },
      void: { label: "Voided", tone: "neutral" },
      canceled: { label: "Canceled", tone: "neutral" },
    });
  });

  it("uses every approved pipeline label verbatim", () => {
    expect(
      COACH_PIPELINE_STAGES.map(({ key }) => [key, PIPELINE_STAGE_COPY[key].label]),
    ).toEqual(COACH_PIPELINE_STAGES.map(({ key, label }) => [key, label]));
  });

  it("maps every qualification outcome", () => {
    expect(Object.keys(QUALIFICATION_OUTCOME_COPY)).toEqual(QUALIFICATION_OUTCOMES);
  });

  it("maps moderator states and the missing-rule fallback", () => {
    expect(MODERATOR_STATE_COPY).toEqual({
      allowed: { label: "Allowed", tone: "good" },
      blocked: { label: "Blocked", tone: "critical" },
      unavailable: { label: "No moderator response", tone: "warning" },
      not_recorded: { label: "No moderator result recorded", tone: "neutral" },
    });
    expect(TRACE_RULE_FALLBACK_COPY.not_recorded).toEqual({
      label: "No matching rule recorded",
      tone: "neutral",
    });
  });

  it("returns live only from a signed round-trip receipt", () => {
    expect(receiptState(EMPTY_RECEIPTS)).toBe("connecting");
    expect(receiptState({ ...EMPTY_RECEIPTS, oauthCompletedAt: "oauth-receipt" })).toBe(
      "connecting",
    );
    expect(
      receiptState({
        ...EMPTY_RECEIPTS,
        oauthCompletedAt: "oauth-receipt",
        assetVerifiedAt: "asset-receipt",
      }),
    ).toBe("ready");
    expect(
      receiptState({
        ...EMPTY_RECEIPTS,
        oauthCompletedAt: "oauth-receipt",
        assetVerifiedAt: "asset-receipt",
        webhookSubscribedAt: "webhook-receipt",
      }),
    ).toBe("ready");
    expect(
      receiptState({ ...EMPTY_RECEIPTS, signedRoundTripAt: "signed-round-trip-receipt" }),
    ).toBe("live");
  });

  it("keeps banned vocabulary out of every label", () => {
    const labels = [
      ...Object.values(BILLING_INVOICE_STATE_COPY),
      ...Object.values(BILLING_SUBSCRIPTION_STATE_COPY),
      ...Object.values(CHANNEL_CONNECTION_STATE_COPY),
      ...Object.values(CONVERSATION_STATE_COPY),
      ...Object.values(PIPELINE_STAGE_COPY),
      ...Object.values(QUALIFICATION_OUTCOME_COPY),
      ...Object.values(MODERATOR_STATE_COPY),
      ...Object.values(TRACE_RULE_FALLBACK_COPY),
    ].map(({ label }) => label);

    for (const label of labels) {
      expect(label).not.toContain("\u2014");
      expect(label).not.toMatch(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/u);
      for (const banned of BANNED_VOCABULARY) {
        expect(label).not.toMatch(new RegExp(banned, "iu"));
      }
    }
  });
});
