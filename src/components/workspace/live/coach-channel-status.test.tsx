import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CARRIER_TYPICAL_DAYS } from "@/lib/onboarding/contracts";
import {
  CoachCarrierNotice,
  CoachChannelStatusLine,
  carrierReviewFrom,
  type CoachChannelStatus,
} from "./coach-channel-status";

const NOW = new Date("2026-09-01T15:00:00.000Z");

function status(overrides: Partial<CoachChannelStatus> = {}): CoachChannelStatus {
  return {
    channelsChecked: true,
    liveChannels: ["instagram", "messenger"],
    carrier: { kind: "in-review", submittedAt: "2026-08-20T12:00:00.000Z" },
    ...overrides,
  };
}

describe("the coach channel status line", () => {
  /**
   * The positive control this file's negatives depend on.
   *
   * Every assertion below is of the form "this claim does not appear", and a component stubbed to
   * `return null` satisfies all of them. So the first thing asserted is that the line rendered
   * something specific, and the rest of the suite is only meaningful because this passes.
   */
  it("names the channels whose rows actually say live", () => {
    const { container } = render(<CoachChannelStatusLine status={status()} />);
    expect(container.textContent).toContain("Your agent is live on Instagram and Messenger");
    expect(container.querySelectorAll(".coach-statusline__item")).toHaveLength(2);
  });

  /**
   * The drift: a status line built from "has a connection row" rather than from "the row says
   * live". `ready` and `pending_review` are both connections that exist and neither is a channel a
   * lead can reach, so greeting a coach mid-onboarding with "your agent is live" would be the fake
   * all-set state `CLAUDE.md` forbids. The caller does the filtering, so what is pinned here is
   * that the component states exactly the channels it was handed and invents none.
   */
  it("claims nothing is live when no channel was handed to it", () => {
    const { container } = render(
      <CoachChannelStatusLine status={status({ liveChannels: [] })} />,
    );
    expect(container.textContent).not.toContain("is live on");
    // The carrier half still renders, so this is not the component quietly returning null.
    expect(container.textContent).toContain("Text messaging is still in carrier review");
  });

  it("says nothing at all when there is nothing true to say", () => {
    const { container } = render(
      <CoachChannelStatusLine
        status={status({ carrier: { kind: "unchecked" }, liveChannels: [] })}
      />,
    );
    expect(container.textContent).toBe("");
  });
});

describe("the carrier review notice", () => {
  /**
   * The honest-states rule, stated as the thing it forbids.
   *
   * `CLAUDE.md` requires a real elapsed day counter on A2P and bans three specific substitutes: a
   * percentage, a predicted decision date, and a fake "all set". All three are cheap to reach for
   * on a screen whose whole subject is a wait, so all three are asserted against here rather than
   * left to review. The day count itself is the positive control: 2026-08-20 to 2026-09-01 is
   * twelve civil days, and that number has to be on the screen for the negatives to mean anything.
   */
  it("counts real elapsed days and predicts nothing", () => {
    const { container } = render(<CoachCarrierNotice now={NOW} status={status()} />);
    const text = container.textContent ?? "";

    expect(text).toContain("Text messaging is on day");
    expect(text).toContain("12");
    expect(text).toContain("of carrier review");
    expect(text).toContain(
      "Carriers take about three weeks to approve a new business for texting. Nothing is broken and there is nothing for you to do.",
    );
    // The shared counter's own range, so the prose's "about three weeks" is never the only bound
    // on screen and cannot drift from the constant the rest of the product reads.
    expect(text).toContain(`typical ${CARRIER_TYPICAL_DAYS[0]} to ${CARRIER_TYPICAL_DAYS[1]} days`);

    expect(text).not.toMatch(/%/u);
    expect(text).not.toMatch(/expected by|estimated|should complete|by \w+ \d+/iu);
    expect(text).not.toMatch(/all set|complete|approved/iu);
  });

  /**
   * A filing with no recorded submission date still gets a notice, and gets no number.
   *
   * "Day 0" would claim we filed this morning, which is the confident wrong answer the counter's
   * own null arm exists to prevent. Suppressing the whole notice would be the other failure: the
   * wait is real whether or not we wrote down when it started, and a coach who sees nothing
   * concludes texting works.
   */
  it("shows the wait without a day count when the filing date was never recorded", () => {
    const { container } = render(
      <CoachCarrierNotice
        now={NOW}
        status={status({ carrier: { kind: "in-review", submittedAt: null } })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Text messaging is still in carrier review");
    expect(text).toContain("The filing date was not recorded");
    expect(text).not.toMatch(/\bday \d/iu);
  });

  it("renders nothing when no registration is with the carriers", () => {
    for (const carrier of [
      { kind: "unchecked" },
      { kind: "not-filed" },
      { kind: "live" },
      { kind: "blocked" },
    ] as const) {
      const { container } = render(<CoachCarrierNotice now={NOW} status={status({ carrier })} />);
      expect(container.textContent, `${carrier.kind} drew a carrier notice`).toBe("");
    }
  });
});

describe("reducing the A2P registration projection", () => {
  /**
   * The distinction the whole union exists for: a read that did not run has established nothing.
   *
   * Folding `unchecked` into `not-filed` would put "registration has not been filed" on screen on
   * the strength of a query that failed, which is a claim about the carriers made from a claim
   * about our own database being reachable.
   */
  it("keeps a failed read separate from a registration that was never filed", () => {
    expect(carrierReviewFrom({
      checked: false,
      registrationState: "awaiting_provider",
      submittedAt: "2026-08-20T12:00:00.000Z",
      terminalRejection: false,
    })).toEqual({ kind: "unchecked" });

    expect(carrierReviewFrom({
      checked: true,
      registrationState: null,
      submittedAt: null,
      terminalRejection: false,
    })).toEqual({ kind: "not-filed" });
  });

  /**
   * `running` means two different things and only one of them is a carrier wait.
   *
   * With a `submittedAt` it means filed and waiting; without one it means we are still assembling
   * the filing. A surface that switched on the state alone would tell every tenant in the second
   * half of that state that carriers are reviewing something nobody has sent.
   */
  it("only calls running a carrier wait once something was actually filed", () => {
    expect(carrierReviewFrom({
      checked: true,
      registrationState: "running",
      submittedAt: "2026-08-20T12:00:00.000Z",
      terminalRejection: false,
    })).toEqual({ kind: "in-review", submittedAt: "2026-08-20T12:00:00.000Z" });

    expect(carrierReviewFrom({
      checked: true,
      registrationState: "running",
      submittedAt: null,
      terminalRejection: false,
    })).toEqual({ kind: "not-filed" });
  });

  it("treats a terminal rejection as blocked whatever the state column says", () => {
    expect(carrierReviewFrom({
      checked: true,
      registrationState: "awaiting_provider",
      submittedAt: "2026-08-20T12:00:00.000Z",
      terminalRejection: true,
    })).toEqual({ kind: "blocked" });
  });
});
