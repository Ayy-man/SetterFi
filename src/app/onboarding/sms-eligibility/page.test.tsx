import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CARRIER_TYPICAL_DAYS } from "@/lib/onboarding/contracts";
import SmsEligibilityPage from "./page";

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

// Both instants land mid-afternoon in America/New_York, the workspace display timezone, so the
// civil-day arithmetic `elapsedWorkspaceDays` does is exactly two days and cannot straddle a
// midnight.
const NOW = new Date("2026-08-31T18:00:00.000Z");
const SUBMITTED_AT = "2026-08-29T18:00:00.000Z";

/** The carrier-review panel, which is where the clock lives and the only place it may. */
function reviewPanel() {
  return screen.getByRole("region", { name: "Carrier review" });
}

describe("SmsEligibilityPage", () => {
  /**
   * The honest-states claim this page exists to keep: the wait is a real elapsed day count, never
   * a percentage and never a predicted decision date.
   *
   * The count comes from `elapsedWorkspaceDays`, the same function coach Home and the setup rail
   * count with, rather than from this page's own clock. That matters historically: this screen
   * once counted off `Date.now()` with a `+1`, so a registration filed an hour ago read "day 1"
   * here while every other surface read day 0 for the same row.
   */
  it("counts real elapsed days against the shared carrier range, with no percentage and no predicted date", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    const fetcher = vi.fn().mockImplementation(() => json({
      screen: { screenId: "screen-1", state: "flagged", matches: [{ phrase: "credit repair" }], coachAcknowledgedAt: null, adminConfirmedAt: null },
      registration: { submittedAt: SUBMITTED_AT, state: "awaiting_provider" },
    }));
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    render(<SmsEligibilityPage />);

    await screen.findByText("With the carriers");
    const panel = reviewPanel();
    const text = panel.textContent ?? "";

    expect(within(panel).getByText("2")).toBeVisible();
    expect(text).toContain(`of about ${CARRIER_TYPICAL_DAYS[1]} days`);
    // No percentage, and no date beyond the one that already happened: a decision date would be a
    // prediction about a carrier that publishes no schedule.
    expect(text).not.toContain("%");
    const MONTH_DAY = /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}\b/gu;
    expect(text.match(MONTH_DAY) ?? []).toEqual(["Aug 29"]);

    // The wait is never dressed as completion, and nothing on the page claims approval.
    expect(document.body.textContent ?? "").not.toMatch(/all set|100%|approved/i);

    await user.click(screen.getByLabelText("I understand this is an acknowledgement, not carrier approval"));
    await user.click(screen.getByRole("button", { name: "Record acknowledgement" }));
    expect(fetcher).toHaveBeenCalledWith("/api/onboarding/sms-eligibility", expect.objectContaining({ method: "POST" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/onboarding/sms-eligibility",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  /**
   * With nothing filed there is no elapsed review to count, so the screen states that in words
   * where the figure would be rather than starting a clock on a filing that has not happened.
   * A day zero would read as a review under way on its first day, which is a different fact.
   */
  it("starts no running clock before anything has been filed with the carriers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => json({
      screen: { screenId: "screen-1", state: "clean", matches: [], coachAcknowledgedAt: null, adminConfirmedAt: null },
      registration: { submittedAt: null, state: null },
    })));
    render(<SmsEligibilityPage />);

    await screen.findByText("Nothing in your words looks like a problem");
    expect(screen.getByText("Not filed yet")).toBeVisible();
    expect(within(reviewPanel()).getByText(/carriers' clock starts on the day it does/u)).toBeVisible();
    expect(reviewPanel().querySelector("[class*='text-[62px]']")).toBeNull();
  });

  /**
   * The three states this page once had no arm for.
   *
   * Every branch keyed off `submittedAt` while `registration.state` sat unread on the payload the
   * handler already sends. A filing date is never cleared, so a registration that finished, failed
   * or was permanently declined still rendered "With the carriers" over a day counter that climbed
   * forever: day 47 of a review that ended on day 19. Each case asserts the counter is absent as
   * well as asserting the new sentence, because the sentence appearing beside a still-running
   * clock would pass on the half of the bug that shows a coach a wrong number.
   */
  it.each([
    ["done", "Registered", /The carriers finished/],
    ["failed", "Setup needs review", /Texting setup did not complete/],
    ["blocked", "Refused by the carriers", /The carriers refused this registration/],
  ])("stops the carrier clock once registration reaches %s", async (state, label, prose) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => json({
      screen: { screenId: "screen-1", state: "clean", matches: [], coachAcknowledgedAt: null, adminConfirmedAt: null },
      registration: { submittedAt: SUBMITTED_AT, state },
    })));
    render(<SmsEligibilityPage />);

    expect(await screen.findByText(label)).toBeVisible();
    expect(within(reviewPanel()).getByText(prose)).toBeVisible();
    expect(screen.queryByText("With the carriers")).toBeNull();
    expect(reviewPanel().querySelector("[class*='text-[62px]']")).toBeNull();
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
    expect(within(reviewPanel()).getByText(/did not run/u)).toBeVisible();
    expect(screen.queryByText("Not filed yet")).toBeNull();
    expect(reviewPanel().querySelector("[class*='text-[62px]']")).toBeNull();
  });

  /**
   * The rule the audit measured this screen failing hardest: it carried seven drenched elements
   * against a canvas budget of two, and the drench is the loudest object the coach language has.
   * Nothing on this step is drenched now, and the step's one accent fill is the forward action.
   */
  it("spends no drench, and exactly one accent fill", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => json({
      screen: { screenId: "screen-1", state: "clean", matches: [], coachAcknowledgedAt: null, adminConfirmedAt: null },
      registration: { submittedAt: null, state: null },
    })));
    render(<SmsEligibilityPage />);
    await screen.findByText("Not filed yet");

    expect(document.querySelectorAll("[data-drench]")).toHaveLength(0);
    expect(document.querySelectorAll("[class*='var(--accent-fill)']")).toHaveLength(1);
  });
});
