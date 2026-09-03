import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CARRIER_TYPICAL_DAYS } from "@/lib/onboarding/contracts";
import SmsEligibilityPage from "./page";

function json(value: unknown) { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

// Both instants land mid-afternoon in America/New_York, the workspace display timezone, so the
// civil-day arithmetic `DayCounter` does is exactly two days and cannot straddle a midnight.
const NOW = new Date("2026-08-31T18:00:00.000Z");
const SUBMITTED_AT = "2026-08-29T18:00:00.000Z";

describe("SmsEligibilityPage", () => {
  /**
   * The honest-states claim this page has to keep, re-pointed at the shared counter rather than
   * relaxed.
   *
   * The page used to count its own days off `Date.now()` with a `+1`, so a registration filed an
   * hour ago read "day 1" here while every other surface read "Day 0" for the same row, and it
   * named no typical range at all. It now renders `DayCounter`, which five surfaces share. What
   * the original test guarded -- a real elapsed count, and no percentage -- is still asserted; the
   * range and the absence of a predicted decision date are asserted too, because those are the
   * other halves of the same rule and the old markup could not have carried them.
   */
  it("counts real elapsed days against the shared carrier range, with no percentage and no predicted date", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    const fetcher = vi.fn().mockImplementation(() => json({ screen: { screenId: "screen-1", state: "flagged", matches: [{ phrase: "credit repair" }], coachAcknowledgedAt: null, adminConfirmedAt: null }, registration: { submittedAt: SUBMITTED_AT, state: "awaiting_provider" } }));
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    render(<SmsEligibilityPage />);

    const counter = (await screen.findByText("Day 2")).closest("p");
    expect(counter).not.toBeNull();
    const text = counter!.textContent ?? "";
    expect(text).toContain(`typical ${CARRIER_TYPICAL_DAYS[0]} to ${CARRIER_TYPICAL_DAYS[1]} days`);
    expect(text).toContain("no action needed from you");
    // No percentage, and no date beyond the one that already happened: a decision date would be a
    // prediction about a carrier that publishes no schedule.
    expect(text).not.toContain("%");
    const MONTH_DAY = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}\b/gu;
    expect(text.match(MONTH_DAY) ?? []).toEqual(["Aug 29"]);

    // The wait is never dressed as completion, and nothing on the page claims approval.
    expect(screen.getByText("With the carriers")).toBeVisible();
    expect(document.body.textContent ?? "").not.toMatch(/all set|100%|approved/i);

    await user.click(screen.getByLabelText("I understand this is an acknowledgement, not carrier approval."));
    await user.click(screen.getByRole("button", { name: "Record acknowledgement" }));
    expect(fetcher).toHaveBeenCalledWith("/api/onboarding/sms-eligibility", expect.objectContaining({ method: "POST" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/onboarding/sms-eligibility",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  /** With nothing filed, there is no clock to run, and the page must not invent one. */
  it("shows no day count before anything has been filed with the carriers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => json({
      screen: { screenId: "screen-1", state: "clean", matches: [], coachAcknowledgedAt: null, adminConfirmedAt: null },
      registration: { submittedAt: null, state: null },
    })));
    render(<SmsEligibilityPage />);

    await screen.findByText("Screen cleared");
    expect(screen.queryByText(/^Day \d+$/u)).toBeNull();
    expect(screen.getByText(/A2P registration has not been filed with carriers/)).toBeVisible();
  });

  /**
   * The three states this page had no arm for, and the reason its fixtures could not see them.
   *
   * Every branch here keyed off `submittedAt` while `registration.state` sat unread on the payload
   * the handler already sends. A filing date is never cleared, so a registration that finished,
   * failed or was permanently declined still rendered "With the carriers" over a day counter that
   * climbed forever -- day 47 of a review that ended on day 19.
   *
   * The fixtures above could not catch it: one uses `awaiting_provider` and one uses `null`, the
   * two states for which counting off `submittedAt` alone gives the right answer. They pass the
   * field, so its presence was known; the assertions just never reached a state where reading it
   * mattered. Each case below therefore asserts the counter is *absent* as well as asserting the
   * new sentence, because the sentence appearing beside a still-running clock would be a pass on
   * the half of the bug that shows a coach a wrong number.
   */
  it.each([
    ["done", "Carrier review complete", /Carrier registration is complete, so there is no review left to count/],
    ["failed", "Setup needs review", /Text messaging setup did not complete/],
    ["blocked", "Blocked", /Carrier registration was permanently declined/],
  ])("stops the carrier clock once registration reaches %s", async (state, label, prose) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => json({
      screen: { screenId: "screen-1", state: "clean", matches: [], coachAcknowledgedAt: null, adminConfirmedAt: null },
      registration: { submittedAt: SUBMITTED_AT, state },
    })));
    render(<SmsEligibilityPage />);

    expect(await screen.findByText(label)).toBeVisible();
    expect(screen.getByText(prose)).toBeVisible();
    expect(screen.queryByText(/^Day \d+$/u)).toBeNull();
    expect(screen.queryByText("With the carriers")).toBeNull();
    // The wait being over is not the same as the channel being approved to send.
    expect(document.body.textContent ?? "").not.toMatch(/all set|100%|approved/i);
  });

  /**
   * A read that did not run establishes nothing, and the page has to say that rather than infer.
   *
   * `registration === null` reaches this page both from a tenant with no `a2p_campaign` row and
   * from a GET that failed, and only the first of those means "nothing has been filed". Printing
   * that sentence on a failed read is the confident wrong answer the honest-states rule exists to
   * stop, so the page tracks the read's outcome rather than reducing from the null alone.
   */
  it("says the check did not run rather than claiming nothing was filed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Response("{}", { status: 500 })));
    render(<SmsEligibilityPage />);

    expect(await screen.findByText("We could not check this")).toBeVisible();
    expect(screen.getByText(/No state was inferred from the failed read/)).toBeVisible();
    expect(screen.queryByText(/A2P registration has not been filed with carriers/)).toBeNull();
    expect(screen.queryByText(/^Day \d+$/u)).toBeNull();
  });

  /** Flag off, and the route hands back the pre-rehaul screen with its own acknowledgement verb. */
  it("renders the pre-rehaul screen while the rehaul flag is off", async () => {
    vi.stubEnv("SETTERFI_UI_REHAUL", "false");
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => json({
      screen: { screenId: "screen-1", state: "flagged", matches: [{ phrase: "credit repair" }], coachAcknowledgedAt: null, adminConfirmedAt: null },
      registration: { submittedAt: null, state: null },
    })));
    render(<SmsEligibilityPage />);

    expect(await screen.findByRole("button", { name: "Record acknowledgement" })).toBeVisible();
    expect(screen.queryByText("Step 5 of 5")).toBeNull();
    vi.unstubAllEnvs();
  });
});
