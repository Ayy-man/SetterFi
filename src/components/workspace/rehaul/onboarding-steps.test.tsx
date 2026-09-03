import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { connectCards } from "@/components/onboarding/connect-view-models";
import { offerReview } from "@/components/onboarding/offer-view-models";
import { OnboardingCalendarRehaul } from "@/components/workspace/rehaul/onboarding-calendar";
import { OnboardingConnectRehaul } from "@/components/workspace/rehaul/onboarding-connect";
import { OnboardingOfferRehaul } from "@/components/workspace/rehaul/onboarding-offer";
import { OnboardingProfileRehaul } from "@/components/workspace/rehaul/onboarding-profile";
import { OnboardingSmsRehaul } from "@/components/workspace/rehaul/onboarding-sms";

/**
 * The five setup screens under the rehaul flag.
 *
 * Every case asserts the same three things the rehaul asks of a screen: the heading it claims, one
 * real value read off the data it was handed, and the absence of the explainer sentence the
 * pre-rehaul page printed under that heading. The explainer assertions are the point -- those
 * sentences moved to the context eye, and a screen that quietly kept one would pass every other
 * check on this file.
 *
 * The honest-state assertions ride along where the screen makes a claim about a wait: step 2 and
 * step 5 both draw the carrier clock, and neither may say a percentage, a predicted date, or
 * anything that reads as approval while the review has not started.
 */

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("OnboardingProfileRehaul", () => {
  it("renders the step-1 heading and the saved profile, without the carrier explainer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      profile: {
        legalName: "Reid Funding Group LLC", entityType: "llc", hasEin: true,
        websiteUrl: "https://reidfunding.com", addressLine1: "1420 Alderwood Avenue",
        addressLine2: null, city: "Tempe", region: "Arizona", postalCode: "85281",
        countryCode: "US",
      },
    })));
    render(<OnboardingProfileRehaul />);

    expect(screen.getByRole("heading", { level: 1, name: "Your business details" })).toBeVisible();
    expect(await screen.findByDisplayValue("85281")).toBeVisible();
    expect(screen.getByText("Step 1 of 5")).toBeVisible();
    expect(screen.getByRole("button", { name: "Continue" })).toBeVisible();

    const body = document.body.textContent ?? "";
    expect(body).not.toContain("These legal details are what the phone carriers check");
    expect(body).not.toContain("We record whether you have an EIN");
  });

  it("keeps the EIN rule that blocks the submit", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      profile: {
        legalName: "Reid Funding Group LLC", entityType: "llc", hasEin: false,
        websiteUrl: "https://reidfunding.com", addressLine1: "1420 Alderwood Avenue",
        addressLine2: null, city: "Tempe", region: "Arizona", postalCode: "85281",
        countryCode: "US",
      },
    })));
    render(<OnboardingProfileRehaul />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("LLCs and corporations must have an EIN");
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });
});

describe("OnboardingConnectRehaul", () => {
  it("renders the step-2 heading, a day-0 carrier clock and no channel explainers", () => {
    const cards = connectCards({ connections: [], registration: null });
    render(<OnboardingConnectRehaul cards={cards} nextEnabled={false} />);

    expect(screen.getByRole("heading", { level: 1, name: "Where your leads message you" }))
      .toBeVisible();
    expect(screen.getByText("day 0")).toBeVisible();
    expect(screen.getByText(/typically 14 to 21 days once filed/)).toBeVisible();
    expect(screen.getByText("No page chosen yet")).toBeVisible();

    const body = document.body.textContent ?? "";
    expect(body).not.toContain("Your agent answers every DM and every story reply");
    expect(body).not.toContain("Sending business texts in the US means the phone carriers vet");
    // The wait is never dressed as progress, and nothing here is GoHighLevel's.
    expect(body).not.toMatch(/%|all set|approved/i);
    expect(body).not.toMatch(/gohighlevel|ghl|twilio/i);
  });
});

describe("OnboardingOfferRehaul", () => {
  it("states each missing answer rather than filling it in, without the panel notes", () => {
    render(<OnboardingOfferRehaul review={offerReview(null, "none")} />);

    expect(screen.getByRole("heading", { level: 1, name: "Tell us about your offer" })).toBeVisible();
    expect(screen.getByText("You have not named your programme yet")).toBeVisible();
    expect(screen.getAllByText("No minimum").length).toBeGreaterThan(0);

    const body = document.body.textContent ?? "";
    expect(body).not.toContain("Your agent uses this name in every message");
    expect(body).not.toContain("Your agent will never invent a number");
  });
});

describe("OnboardingCalendarRehaul", () => {
  it("renders the step-4 heading and stays amber until availability is verified", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      connection: null,
      googleConnectAvailable: true,
      googleGrant: null,
      pendingCalendars: [],
    })));
    render(<OnboardingCalendarRehaul />);

    expect(screen.getByRole("heading", { level: 1, name: "Connect your booking calendar" }))
      .toBeVisible();
    expect(await screen.findByRole("link", { name: "Connect Google Calendar" })).toBeVisible();
    expect(screen.getByText("Availability not verified, so your agent cannot book yet")).toBeVisible();
    expect(screen.getByLabelText("Calendar timezone")).toBeVisible();

    const body = document.body.textContent ?? "";
    expect(body).not.toContain("SetterFi asks Google for permission to read your availability");
    expect(body).not.toContain("Nothing else on your Google account is touched");
    expect(body).not.toMatch(/gohighlevel|ghl branding|twilio/i);
  });
});

describe("OnboardingSmsRehaul", () => {
  it("opens the clock at day 0 with a start button, and claims nothing is approved", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      screen: {
        screenId: "screen-1",
        state: "flagged",
        matches: [{ phrase: "credit repair", page: "published-offer" }],
        coachAcknowledgedAt: null,
        adminConfirmedAt: null,
      },
      registration: { submittedAt: null, state: null },
    })));
    render(<OnboardingSmsRehaul />);

    expect(screen.getByRole("heading", { level: 1, name: "Can your business send texts" }))
      .toBeVisible();
    expect(await screen.findByText("credit repair")).toBeVisible();
    expect(screen.getByText("day 0")).toBeVisible();
    expect(screen.getByRole("button", { name: "Start registration" })).toBeVisible();
    expect(screen.getByText("Not filed")).toBeVisible();

    const body = document.body.textContent ?? "";
    // No percentage, no predicted decision date, and nothing that reads as carrier approval.
    expect(body).not.toMatch(/%|all set|approved/i);
    expect(body).not.toMatch(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}\b/);
    expect(body).not.toContain("Carrier rules can permanently refuse credit repair");
  });
});
