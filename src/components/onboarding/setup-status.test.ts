import { describe, expect, it } from "vitest";

import {
  ONBOARDING_STEP_COUNT,
  onboardingSteps,
  resumeStep,
  setupHeadline,
  stepsDone,
  type OnboardingSetupEvidence,
} from "@/components/onboarding/setup-status";

const NOW = new Date("2026-08-31T18:00:00.000Z");
const SUBMITTED_AT = "2026-08-29T18:00:00.000Z";

function evidence(overrides: Partial<OnboardingSetupEvidence> = {}): OnboardingSetupEvidence {
  return {
    calendarReady: false,
    carrier: { kind: "not-filed" },
    live: false,
    metaLive: false,
    offerPublished: false,
    profileSaved: false,
    ...overrides,
  };
}

describe("the six setup steps", () => {
  it("draws exactly the six the board draws, in the board's order", () => {
    const rows = onboardingSteps(evidence(), NOW);
    expect(rows).toHaveLength(ONBOARDING_STEP_COUNT);
    expect(rows.map((row) => row.title)).toEqual([
      "Business profile",
      "Connect Instagram and Messenger",
      "Texting eligibility",
      "Calendar",
      "Your offer",
      "Go live",
    ]);
    expect(rows.map((row) => row.position)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  /**
   * Note 3's contradiction, closed by construction rather than by a corrected constant.
   *
   * `/onboarding` printed "3 of 7 confirmed" over a four-box strip while `/coach/home` printed
   * "0 of 3 done" over four cards, because in both cases the numerator was computed beside the
   * rows rather than from them. The counter here can only count rows that exist.
   */
  it("counts done over the rows themselves, so the counter cannot drift from the rail", () => {
    const rows = onboardingSteps(
      evidence({ carrier: { kind: "live" }, metaLive: true, profileSaved: true }),
      NOW,
    );
    expect(stepsDone(rows)).toBe(rows.filter((row) => row.state === "done").length);
    expect(stepsDone(rows)).toBe(3);
  });

  /**
   * Position in the flow is not evidence of progress through it. A coach can file carrier details
   * before they name their business, and a rung ticked because the reader walked past it would be
   * the completion theatre `CLAUDE.md` forbids.
   */
  it("ticks a proved step that sits after an unproved one, and ticks nothing on position", () => {
    const rows = onboardingSteps(evidence({ offerPublished: true }), NOW);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    expect(byKey.get("offer")?.state).toBe("done");
    expect(byKey.get("business_profile")?.state).toBe("current");
    expect(byKey.get("calendar")?.state).toBe("later");
  });

  /** Exactly one rung is current, and it is the first thing the coach can actually move. */
  it("marks one step current and offers the resume button that step", () => {
    const rows = onboardingSteps(evidence({ profileSaved: true }), NOW);
    expect(rows.filter((row) => row.state === "current")).toHaveLength(1);
    expect(resumeStep(rows)?.key).toBe("connect");
    expect(resumeStep(rows)?.href).toBe("/onboarding/connect");
  });

  /**
   * A later step carries a plain ring with no numeral. The shipped rail drew ticks for steps 1, 5
   * and 7 and circled numbers for 2, 3, 4 and 6, so a reader saw "2, 3, 4, 6" and concluded a step
   * was missing. A rung with no pill and no numeral has no sequence to find a hole in.
   */
  it("gives a later step no state pill at all", () => {
    const rows = onboardingSteps(evidence(), NOW);
    const later = rows.filter((row) => row.state === "later");
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((row) => row.pill === null)).toBe(true);
  });

  /**
   * The carrier wait is somebody else's clock. It is not counted as done, it is not offered as the
   * step to resume, and it prints a real elapsed day count rather than a percentage or a date.
   */
  it("counts the carrier wait in real days and never resumes into it", () => {
    const rows = onboardingSteps(
      evidence({
        carrier: { kind: "in-review", submittedAt: SUBMITTED_AT },
        metaLive: true,
        profileSaved: true,
      }),
      NOW,
    );
    const texting = rows.find((row) => row.key === "texting");
    expect(texting?.state).toBe("waiting");
    expect(texting?.pill?.label).toBe("Day 2 of about 21");
    expect(stepsDone(rows)).toBe(2);
    expect(resumeStep(rows)?.key).toBe("calendar");
    expect(rows.some((row) => (row.pill?.label ?? "").includes("%"))).toBe(false);
  });

  /** Filed, with no readable filing date. That is an absence, not a day zero. */
  it("states the wait without a day number when the filing date is unreadable", () => {
    const rows = onboardingSteps(
      evidence({ carrier: { kind: "in-review", submittedAt: null } }),
      NOW,
    );
    expect(rows.find((row) => row.key === "texting")?.pill?.label).toBe("With the carriers");
  });

  /**
   * "You have not done this" and "we could not find out" are different sentences, and only one of
   * them is true after a failed query. An unknown step is excluded from the numerator and the
   * headline stops counting rather than counting around it.
   */
  it("keeps an unread step out of the count and says the page could not read it", () => {
    const rows = onboardingSteps(evidence({ metaLive: null, profileSaved: true }), NOW);
    const connect = rows.find((row) => row.key === "connect");
    expect(connect?.state).toBe("unknown");
    expect(connect?.pill?.label).toBe("We could not check this");
    expect(stepsDone(rows)).toBe(1);
    expect(setupHeadline(rows)).toBe("Some of your setup could not be read just now");
  });

  /**
   * The headline counts the steps waiting on the coach, not every step that is not done: the
   * carrier wait is not something they can act on, and telling them to go and do it would be false.
   *
   * It also does not borrow coach Home's sentence. Home prints "N steps are waiting on you" from
   * the count of `provisioning_steps` rows in `blocked`, a different fact that lands on a different
   * number for the same account, so the two surfaces say two things in two ways rather than one
   * thing in two numbers.
   */
  it("counts only the steps waiting on the coach, in its own words", () => {
    const headline = setupHeadline(onboardingSteps(evidence(), NOW));
    expect(headline).toBe("Six steps are still yours to finish");
    expect(headline).not.toContain("waiting on you");
    expect(setupHeadline(onboardingSteps(
      evidence({
        calendarReady: true,
        carrier: { kind: "in-review", submittedAt: SUBMITTED_AT },
        metaLive: true,
        offerPublished: true,
        profileSaved: true,
      }),
      NOW,
    ))).toBe("One step is still yours to finish");
  });

  /** Nothing left, and the page says so rather than offering a button into a finished screen. */
  it("has nothing to resume once every step is proved", () => {
    const rows = onboardingSteps(
      evidence({
        calendarReady: true,
        carrier: { kind: "live" },
        live: true,
        metaLive: true,
        offerPublished: true,
        profileSaved: true,
      }),
      NOW,
    );
    expect(stepsDone(rows)).toBe(ONBOARDING_STEP_COUNT);
    expect(resumeStep(rows)).toBeNull();
    expect(setupHeadline(rows)).toBe("Nothing is left for you to finish");
  });

  /** Every sentence on the rail is one sentence, and none of them explains the product. */
  it("gives every rung exactly one sentence", () => {
    for (const row of onboardingSteps(evidence(), NOW)) {
      expect(row.sentence.trim().length).toBeGreaterThan(0);
      expect(row.sentence).not.toContain("--");
    }
  });
});
