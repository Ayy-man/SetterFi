import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  CoachAgent,
  type RehaulConnectionSurface,
} from "@/components/workspace/rehaul/coach-agent";
import { rehaulConnectionSurface } from "@/components/workspace/rehaul/coach-agent-connection-view";
import type { PersistedOfferLayer } from "@/lib/offer/types";
import type { KeywordGoal } from "@/lib/repositories/keyword-goals";

/** A published offer with every rung's storage actually filled, so the ladder has facts to draw. */
const published: PersistedOfferLayer = {
  id: "offer-1",
  tenantId: "tenant-1",
  status: "published",
  version: 3,
  contentHash: "hash-3",
  programName: "Funding accelerator",
  programDescription: null,
  creditMin: 700,
  fundingGoalMinCents: 2_500_000,
  fundingGoalMaxCents: 15_000_000,
  monthlyRevenueMinCents: 1_000_000,
  businessRevenueRequired: false,
  creditRepair: "yes_included",
  products: ["biz CC"],
  bookingHorizonDays: 3,
  bookingMode: "direct",
  brandVoice: "neutral",
  resultsTimelineMinDays: null,
  resultsTimelineMaxDays: null,
  refundPosture: "conditional",
  voiceStyleAnswer: null,
  voiceObjectionAnswer: null,
  voiceFollowupAnswer: null,
  offerPrices: [
    { id: "price-1", label: "Funding accelerator", amountCents: 250_000, billingPeriod: "one_time" },
    { id: "price-2", label: "Credit rebuild", amountCents: 49_700, billingPeriod: "monthly" },
  ],
  proof: [],
  assets: [],
  cadencePurposes: [],
};

const goals: KeywordGoal[] = [
  {
    id: "goal-1",
    keyword: "CCA",
    normalizedKeyword: "cca",
    goal: "resource",
    resourceUrl: "https://reidfunding.com/funding-guide",
    resourceMessage: "Here is the guide I mentioned",
    postBookingUrl: "https://reidfunding.com/thank-you",
    postBookingMessage: "Locked in.",
    active: true,
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
  },
  {
    id: "goal-2",
    keyword: "COACH",
    normalizedKeyword: "coach",
    goal: "book",
    resourceUrl: null,
    resourceMessage: null,
    postBookingUrl: null,
    postBookingMessage: null,
    active: true,
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
  },
];

const surface: RehaulConnectionSurface = rehaulConnectionSurface({
  calendar: {
    name: "Consults",
    provider: "google",
    state: "ready",
    lastSlotFetchAt: "2026-09-02T12:04:00.000Z",
    lastSlotFetchOk: true,
  },
  connections: [
    {
      id: "conn-1",
      channel: "instagram",
      channelLabel: "Instagram",
      state: "live",
      externalAccountLabel: "@reidfunding",
      capabilities: {} as never,
      receipts: {
        oauthCompletedAt: "2026-08-30T09:00:00.000Z",
        assetVerifiedAt: "2026-08-30T09:05:00.000Z",
        webhookSubscribedAt: "2026-08-30T09:06:00.000Z",
        signedRoundTripAt: "2026-09-01T09:07:00.000Z",
      },
      error: null,
      tokenExpiresAt: null,
      createdAt: "2026-08-30T09:00:00.000Z",
      updatedAt: "2026-09-01T09:07:00.000Z",
    },
  ],
  datasets: [],
  registration: {
    submittedAt: "2026-08-25T13:41:00.000Z",
    registrationState: "awaiting_provider",
    terminalRejection: false,
    terminalCode: null,
  },
});

/** Sentences the old `/coach/agent` printed as help text. None of them may reach the new body. */
const OLD_EXPLAINERS = [
  "Your agent quotes these exactly. It will never invent a price or offer a discount.",
  "Anyone under these numbers is turned away politely, before it reaches you.",
  "SetterFi decides when to follow up. You decide what each message is for.",
  "The agent can qualify only against these saved facts.",
];

describe("rehaul coach agent", () => {
  it("draws the ladder with the offer layer's own figures", () => {
    render(
      <CoachAgent
        connections={surface}
        initialKeywordGoals={goals}
        initialState={{ draft: null, published }}
        publishedDateLabel="Mon 1 Sept"
        tab="ladder"
        testEnabled
      />,
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Your agent" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Live, published Mon 1 Sept")).toBeInTheDocument();

    // A figure that came from storage, not from the artboard's demo coach.
    expect(screen.getByText("$2,500.00 once")).toBeInTheDocument();
    expect(screen.getByLabelText("Do you know your credit score roughly?")).toHaveValue("700");

    // Both keywords, each with its own goal segment.
    expect(screen.getByRole("button", { name: "CCA" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "COACH" })).toBeInTheDocument();

    // The five follow-up touches come off DURABLE_TOUCHES, which runs fourteen days.
    expect(screen.getByText("5 times over 14 days")).toBeInTheDocument();

    for (const sentence of OLD_EXPLAINERS) {
      expect(screen.queryByText(sentence)).not.toBeInTheDocument();
    }
  });

  it("states texting registration as a day counter, never a percentage or a date", () => {
    render(
      <CoachAgent
        connections={surface}
        initialKeywordGoals={goals}
        initialState={{ draft: null, published }}
        publishedDateLabel="Mon 1 Sept"
        tab="connections"
        testEnabled
      />,
    );

    expect(screen.getByRole("heading", { level: 2, name: "Instagram" })).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("Awaiting carrier")).toBeInTheDocument();
    expect(document.querySelector(".daycount")).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/registration[^.]*\d+%/i);
  });

  it("says a connection read did not answer instead of claiming nothing is connected", () => {
    render(
      <CoachAgent
        connections={rehaulConnectionSurface({
          calendar: null,
          connections: null,
          datasets: null,
          registration: null,
        })}
        initialKeywordGoals={goals}
        initialState={{ draft: null, published }}
        publishedDateLabel={null}
        tab="connections"
        testEnabled={false}
      />,
    );

    expect(
      screen.getByText("Your connections could not be read just now."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
  });
});
