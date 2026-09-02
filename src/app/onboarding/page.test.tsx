import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { READINESS_KEYS, type ReadinessKey } from "@/lib/onboarding/contracts";

import OnboardingPage from "./page";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next/link", () => ({ default: "a" }));

/**
 * The readiness the page reads, as the go-live endpoint would judge it. A live channel and a
 * published offer, the safe test and the subscription still to do: two strip boxes ticked, and
 * two checks the button would still refuse on, one of which has no box in the strip at all.
 */
const UNMET: ReadinessKey[] = ["test_passed", "subscription_ready"];
/** Mutable per test: the code the unmet checks carry, and whether the go-live flow is on. */
const scenario = { unmetCode: "READINESS_CHECK_MISSING", phase5Live: true };
vi.mock("@/lib/env-contract", () => ({
  phase5Live: () => scenario.phase5Live,
  phase7MeetAgentLive: () => false,
}));
// The body is the client component's business; this file is about the strip and the heading.
vi.mock("@/components/onboarding/coach-onboarding", () => ({ CoachOnboarding: () => null }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "u1" } }, error: null }) },
  }),
}));
vi.mock("@/lib/auth/claims", () => ({ parseAppClaims: () => ({ tenantId: "tenant-1" }) }));
vi.mock("@/app/api/onboarding/readiness/handler", () => ({ createReadinessEvidence: () => ({}) }));
vi.mock("@/lib/onboarding/readiness", () => ({
  evaluateReadiness: async () => ({
    ready: false,
    checks: READINESS_KEYS.map((key) => ({
      key,
      ready: !UNMET.includes(key),
      code: UNMET.includes(key) ? scenario.unmetCode : "ok",
      evidenceAt: null,
      blamingParty: "coach",
    })),
  }),
}));

/**
 * The go-live headline against the strip standing directly above it.
 *
 * The page shipped the artboard's "You are one button away from your agent answering" as an
 * unconditional string while the first three boxes of its own setup strip read "(still to do)".
 * Two statements about the same fact, on the same screen, disagreeing -- which is the honest-states
 * rule in `CLAUDE.md` broken at the exact moment a coach is most inclined to believe the flattering
 * half. `artboard-conformance.test.ts` beside this file could not have caught it: it compares the
 * page to the drawing, and the drawing is where the sentence came from.
 *
 * So this reads the rendered DOM rather than the source, and asserts the pairing rather than the
 * string: while any step box renders as still to do, the heading must not be the drawing's
 * readiness sentence. Rewording the headline to something softer does not satisfy it, because the
 * check below also refuses the other ways a heading can claim to be finished.
 */

const READINESS_CLAIM = /one button away|ready to go|all set|you are live|you're live|100%/iu;

/**
 * The `<h1>` the drawing gives this page. Recorded from the OnboardingGoLive artboard as drawn on
 * 2026-09-02; the artboards are not part of this repository, so a redraw has to be carried here
 * by hand.
 */
function drawnReadinessTitle() {
  return "You are one button away from your agent answering";
}

describe("the go-live headline against its own setup strip", () => {
  beforeEach(() => {
    scenario.unmetCode = "READINESS_CHECK_MISSING";
    scenario.phase5Live = true;
  });

  it("does not claim the agent is one press away while any setup step is still to do", async () => {
    render(await OnboardingPage());

    const outstanding = document.querySelectorAll(
      '[data-slot="setup-step"][data-state="upcoming"]',
    );
    // The positive control. With no outstanding step the assertions below would hold on a page
    // that was entitled to the readiness sentence, and would report agreement on nothing.
    expect(
      outstanding.length,
      "no setup step rendered as still to do, so this render cannot test the disagreement",
    ).toBeGreaterThan(0);

    const heading = screen.getByRole("heading", { level: 1 }).textContent ?? "";
    expect(heading.length, "the page rendered no heading text").toBeGreaterThan(0);

    const drawn = drawnReadinessTitle();
    expect(drawn.length, "the drawing's title came back empty").toBeGreaterThan(0);
    expect(heading).not.toBe(drawn);
    expect(heading).not.toMatch(READINESS_CLAIM);
  });

  /**
   * The other half: the strip and the heading are drawn from one evidence set, so the words a
   * screen reader gets out of the strip agree with the heading by construction rather than by two
   * authors happening to say the same thing.
   */
  it("says the same thing in the strip that it says in the heading", async () => {
    render(await OnboardingPage());

    const steps = Array.from(document.querySelectorAll('[data-slot="setup-step"]'));
    expect(steps.length, "the strip did not render, so there was nothing to compare").toBe(4);
    expect(steps.some((step) => (step.textContent ?? "").includes("still to do"))).toBe(true);
    // The two checks the readiness above proves are the two boxes the strip ticks, and no other.
    const done = steps.filter((step) => step.getAttribute("data-state") === "done");
    expect(done.map((step) => step.getAttribute("data-key") ?? step.textContent)).toHaveLength(2);
  });

  /**
   * The rail's other half. It read `current="go_live"` from the route rather than from the
   * evidence, so step four said "you are here" while steps one to three said "still to do" -- the
   * strip reporting the coach at the end of a path it was simultaneously saying they had not
   * walked.
   */
  it("stands the reader on the first step nobody has proved, not on the last one", async () => {
    render(await OnboardingPage());

    const steps = Array.from(document.querySelectorAll('[data-slot="setup-step"]'));
    expect(steps.length, "the strip did not render, so there was nothing to place").toBe(4);
    const current = steps.filter((step) => step.getAttribute("data-state") === "current");
    expect(current, "exactly one step is the reader's position").toHaveLength(1);
    // The step standing as current must be the earliest one carrying no tick.
    const firstUnticked = steps.find((step) => step.getAttribute("data-state") !== "done");
    expect(current[0]).toBe(firstUnticked);
    expect(current[0]?.textContent).toContain("you are here");
  });

  /**
   * The count. "Your agent is not answering yet" was true and told a coach nothing: three steps out
   * and one step out read the same line, so the headline stopped being a position readout the
   * moment it stopped claiming readiness.
   */
  it("counts every check the button would refuse on, not only the boxes the strip has", async () => {
    render(await OnboardingPage());

    const steps = Array.from(document.querySelectorAll('[data-slot="setup-step"]'));
    const unticked = steps.slice(0, 3).filter((step) => step.getAttribute("data-state") !== "done");
    // One box is unticked (Meet your agent), but two checks are outstanding, because the
    // subscription has no box. The headline must say two, or it is the undercount that shipped.
    expect(unticked).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 }).textContent)
      .toBe("Two things left before your agent answers");
  });

  /**
   * A check the evaluator could not read is reported as not ready so the button stays refused,
   * but it is not one more thing for the coach to do. Counting it printed "One thing left" over a
   * database timeout; the honest headline over evidence the page does not have makes no count.
   */
  it("makes no count when any readiness check could not be read", async () => {
    scenario.unmetCode = "subscription_contract_unavailable";
    render(await OnboardingPage());

    const heading = screen.getByRole("heading", { level: 1 }).textContent ?? "";
    expect(heading).toBe("Your agent is not answering yet");
    expect(heading).not.toMatch(/\bone\b|\btwo\b|\d/iu);
    // The strip still ticks only what was positively proved.
    const done = document.querySelectorAll('[data-slot="setup-step"][data-state="done"]');
    expect(done).toHaveLength(2);
  });

  /**
   * With the go-live flow off the body offers no button, so a headline counting the coach down
   * towards one would be counting towards nothing. The page then reads no readiness at all.
   */
  it("makes no count while the go-live flow is off", async () => {
    scenario.phase5Live = false;
    render(await OnboardingPage());

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Your agent is not answering yet");
    expect(document.querySelectorAll('[data-slot="setup-step"][data-state="done"]')).toHaveLength(0);
  });
});
