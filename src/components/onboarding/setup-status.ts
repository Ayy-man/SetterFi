/**
 * The six steps of setup, and what each one is allowed to say.
 *
 * `OnboardingOverview.dc.html` draws six rungs, a state on each, a headline counting the
 * outstanding ones, and one button that resumes at the current step. This module is that drawing
 * as a pure function, so every rule on it is testable without a browser or a database.
 *
 * **The counter counts the rows.** The visual audit's section 11 found `/onboarding` claiming
 * "3 of 7" while `/coach/home` claimed "0 of 3" for the same account, which is Note 3's two-way
 * contradiction. The cause was two surfaces counting different things and neither counting what it
 * drew: onboarding counted the seven go-live readiness checks while drawing a four-box strip, and
 * home counted three rungs while drawing four cards. Here `done` is derived from the same array
 * the rows are drawn from, so `stepsDone(rows)` and `rows.map(...)` cannot disagree, and the facts
 * the two surfaces share -- a live Meta channel, the carrier clock -- come from the same two reads
 * home makes, not from a second derivation of them.
 *
 * **A step nobody has proved is not done, whichever side of the current one it sits on.** Position
 * in the flow is not evidence of progress through it. A coach can file carrier details before they
 * name their business, and a rung ticked because the reader has walked past it would be the
 * completion theatre `CLAUDE.md` forbids on the one screen a new coach is most inclined to
 * believe.
 *
 * **A read that did not run is `unknown`, never `later`.** "You have not done this" and "we could
 * not find out" are different sentences, and only one of them is true after a failed query. An
 * unknown step is excluded from the numerator and stated in words.
 */

import type { Tone } from "@/components/kit/atomics";
import { elapsedWorkspaceDays } from "@/components/kit/day-counter";
import type { CarrierReview } from "@/lib/onboarding/carrier-review";
import { CARRIER_TYPICAL_DAYS } from "@/lib/onboarding/contracts";

export const ONBOARDING_STEP_KEYS = [
  "business_profile",
  "connect",
  "texting",
  "calendar",
  "offer",
  "go_live",
] as const;

export type OnboardingStepKey = (typeof ONBOARDING_STEP_KEYS)[number];

export const ONBOARDING_STEP_COUNT = ONBOARDING_STEP_KEYS.length;

/**
 * The state a rung is drawn in.
 *
 * `waiting` is the carrier arm and nothing else: work that has genuinely started, is not finished,
 * and is not the coach's to move. It is not counted as done, because it is not, and it is not
 * offered as the step to resume, because there is nothing there to press.
 */
export type OnboardingStepState = "done" | "current" | "waiting" | "later" | "unknown";

export type OnboardingStepRow = {
  key: OnboardingStepKey;
  /** 1-indexed, so a step screen can print "Step 3 of 6" without recomputing the order. */
  position: number;
  title: string;
  href: string;
  /** One sentence, in the rung. Never two, and never an explanation of the product. */
  sentence: string;
  state: OnboardingStepState;
  /** The state pill beside the rung. Absent on a later step, which carries a plain ring. */
  pill: { label: string; tone: Tone } | null;
};

export const ONBOARDING_STEP_TITLES: Record<OnboardingStepKey, string> = {
  business_profile: "Business profile",
  connect: "Connect Instagram and Messenger",
  texting: "Texting eligibility",
  calendar: "Calendar",
  offer: "Your offer",
  go_live: "Go live",
};

export const ONBOARDING_STEP_HREFS: Record<OnboardingStepKey, string> = {
  business_profile: "/onboarding/business-profile",
  connect: "/onboarding/connect",
  texting: "/onboarding/sms-eligibility",
  calendar: "/onboarding/calendar",
  offer: "/onboarding/offer",
  go_live: "/onboarding/go-live",
};

/**
 * What each read established, or did not.
 *
 * Every field is a three-valued answer on purpose: `true` proved, `false` read and not proved,
 * `null` not read. The page hands these in from the reads it actually made, and this module never
 * infers one from another.
 */
export type OnboardingSetupEvidence = {
  /** `provisioning_steps.business_profile` reached `done`. */
  profileSaved: boolean | null;
  /**
   * A Meta channel is genuinely answering. Home's `liveChannels` and this are the same claim off
   * the same `channel_connections` read, so the two surfaces cannot disagree about it.
   */
  metaLive: boolean | null;
  /** The A2P reduction every carrier surface in the product shares. */
  carrier: CarrierReview;
  /** `provisioning_steps.calendar_connect` reached `done`. */
  calendarReady: boolean | null;
  /** `provisioning_steps.offer_layer` reached `done`. */
  offerPublished: boolean | null;
  /** `provisioning_steps.go_live` reached `done`, which is the agent actually answering. */
  live: boolean | null;
};

const UNKNOWN_PILL = { label: "We could not check this", tone: "neutral" as Tone };

const CARRIER_DAY_RANGE = `about ${CARRIER_TYPICAL_DAYS[1]}`;

/**
 * The carrier rung, which is the only one whose state belongs to somebody else.
 *
 * `CLAUDE.md` allows a real elapsed-day counter here and forbids a percentage and a predicted
 * date. The day number comes from `elapsedWorkspaceDays`, the same function coach Home and the
 * texting step count their own days with, so the three cannot drift by a day the way
 * `/onboarding/sms-eligibility` did when it counted its own off `Date.now()` with a `+1`.
 */
function textingRow(carrier: CarrierReview, now?: Date): Omit<OnboardingStepRow, "position"> {
  const base = {
    href: ONBOARDING_STEP_HREFS.texting,
    key: "texting" as const,
    title: ONBOARDING_STEP_TITLES.texting,
  };
  if (carrier.kind === "unchecked") {
    return {
      ...base,
      pill: UNKNOWN_PILL,
      sentence: "The carrier registration check did not run, so this step cannot say where it is.",
      state: "unknown",
    };
  }
  if (carrier.kind === "live") {
    return {
      ...base,
      pill: { label: "Registered", tone: "good" },
      sentence: "The carriers finished, so your agent can text as well as answer messages.",
      state: "done",
    };
  }
  if (carrier.kind === "in-review") {
    /*
     * The day count, and never a percentage or a finish date. An unreadable submission date is an
     * absence rather than a zero: "With the carriers" states the thing that is true without
     * claiming a day nobody recorded.
     */
    const day = carrier.submittedAt ? elapsedWorkspaceDays(carrier.submittedAt, now) : null;
    return {
      ...base,
      pill: {
        label: day === null
          ? "With the carriers"
          : `Day ${day} of ${CARRIER_DAY_RANGE}`,
        tone: "waiting",
      },
      sentence:
        "Your details are with the carriers. Nothing is broken and there is nothing for you to do while it runs.",
      state: "waiting",
    };
  }
  if (carrier.kind === "blocked") {
    return {
      ...base,
      pill: { label: "Refused by the carriers", tone: "failure" },
      sentence: "The carriers refused this registration. It has to be corrected before it is filed again.",
      state: "current",
    };
  }
  if (carrier.kind === "failed") {
    return {
      ...base,
      pill: { label: "Needs review", tone: "failure" },
      sentence: "Texting setup did not complete. SetterFi owns the next step on this one.",
      state: "waiting",
    };
  }
  return {
    ...base,
    pill: { label: "Waiting on you", tone: "warning" },
    sentence: `Send your details to the carriers. Their review runs ${CARRIER_DAY_RANGE} days and no one is given a finish date.`,
    state: "current",
  };
}

/**
 * A rung whose answer is a plain yes, no, or "we could not find out".
 *
 * `waitingSentence` is what the coach reads when the step is theirs to do; `doneSentence` is the
 * fact the read established. Neither is an explanation of why the step exists, because that
 * belongs in the context eye.
 */
function plainRow(input: {
  key: OnboardingStepKey;
  proved: boolean | null;
  doneSentence: string;
  waitingSentence: string;
  unknownSentence: string;
}): Omit<OnboardingStepRow, "position"> {
  const base = {
    href: ONBOARDING_STEP_HREFS[input.key],
    key: input.key,
    title: ONBOARDING_STEP_TITLES[input.key],
  };
  if (input.proved === null) {
    return { ...base, pill: UNKNOWN_PILL, sentence: input.unknownSentence, state: "unknown" };
  }
  if (input.proved) {
    return { ...base, pill: { label: "Done", tone: "good" }, sentence: input.doneSentence, state: "done" };
  }
  return {
    ...base,
    pill: { label: "Waiting on you", tone: "warning" },
    sentence: input.waitingSentence,
    state: "current",
  };
}

/**
 * The six rungs, in the board's order, from evidence the page actually read.
 *
 * `current` is resolved last and exactly once: every unproved step comes out of the builders above
 * marked `current`, and this pass demotes all but the first of them to `later`. That is what makes
 * the rail read as a sequence without any rung claiming a position it cannot prove, and it is why
 * a later step carries a plain ring with no numeral: the numeral is what made the shipped rail
 * read "2, 3, 4, 6" and look broken.
 */
export function onboardingSteps(
  evidence: OnboardingSetupEvidence,
  now?: Date,
): OnboardingStepRow[] {
  const rows: Omit<OnboardingStepRow, "position">[] = [
    plainRow({
      doneSentence: "Saved. Your name, your city and what you help people with.",
      key: "business_profile",
      proved: evidence.profileSaved,
      unknownSentence: "Your saved business profile could not be read, so this step cannot say whether it is done.",
      waitingSentence: "Your name, your city and what you help people with. Your agent says these words to your leads.",
    }),
    plainRow({
      doneSentence: "Your agent is answering direct messages and page messages.",
      key: "connect",
      proved: evidence.metaLive,
      unknownSentence: "Your channel connections could not be read, so this step cannot say what is answering.",
      waitingSentence: "Connect the accounts your leads already message you on.",
    }),
    textingRow(evidence.carrier, now),
    plainRow({
      doneSentence: "Connected, and your agent can see when you are free.",
      key: "calendar",
      proved: evidence.calendarReady,
      unknownSentence: "Your calendar connection could not be read, so this step cannot say whether it is done.",
      waitingSentence: "Tell us where your calls should land, so your agent can book them.",
    }),
    plainRow({
      doneSentence: "Saved. What you sell, what it costs, and who is a good fit.",
      key: "offer",
      proved: evidence.offerPublished,
      unknownSentence: "Your saved offer could not be read, so this step cannot say whether it is done.",
      waitingSentence: "What you sell, what it costs, and who is a good fit.",
    }),
    goLiveRow(evidence),
  ];

  let currentTaken = false;
  return rows.map((row, index) => {
    let state = row.state;
    if (state === "current") {
      if (currentTaken) {
        state = "later";
      } else {
        currentTaken = true;
      }
    }
    return {
      ...row,
      pill: state === "later" ? null : row.pill,
      position: index + 1,
      state,
    };
  });
}

/**
 * The last rung, which is an action rather than a thing to prepare.
 *
 * It says "comes last" until every earlier step it depends on is proved, because offering the
 * final press beside four outstanding steps would be a button whose only outcome is a refusal.
 */
function goLiveRow(evidence: OnboardingSetupEvidence): Omit<OnboardingStepRow, "position"> {
  const base = {
    href: ONBOARDING_STEP_HREFS.go_live,
    key: "go_live" as const,
    title: ONBOARDING_STEP_TITLES.go_live,
  };
  if (evidence.live === null) {
    return {
      ...base,
      pill: UNKNOWN_PILL,
      sentence: "We could not read whether your agent is on, so this step cannot say.",
      state: "unknown",
    };
  }
  if (evidence.live) {
    return {
      ...base,
      pill: { label: "Live", tone: "good" },
      sentence: "Your agent is answering. You can turn it off again from your agent screen.",
      state: "done",
    };
  }
  return {
    ...base,
    pill: { label: "Comes last", tone: "neutral" },
    sentence: "Turn your agent on. This is the last step and it takes one press.",
    state: "current",
  };
}

/** The numerator, counted over the rows themselves so it cannot drift from what was drawn. */
export function stepsDone(rows: readonly OnboardingStepRow[]): number {
  return rows.filter((row) => row.state === "done").length;
}

/**
 * The step the resume button goes to: the first one that is the coach's to move.
 *
 * A `waiting` step is skipped because there is nothing on it to press, and an `unknown` step is
 * skipped because sending a coach to a screen we could not read would be guessing on their
 * behalf. Everything proved, and the button resumes at go live, which is the honest last stop.
 */
export function resumeStep(rows: readonly OnboardingStepRow[]): OnboardingStepRow | null {
  return rows.find((row) => row.state === "current") ?? null;
}

/**
 * The headline over the rail, counted from the same rows.
 *
 * It counts steps waiting on the coach rather than steps not done, because the carrier wait is not
 * something a coach can act on and a headline that told them to go and do it would be false. The
 * unknown arm says so rather than counting around it.
 *
 * The wording is deliberately "still yours to finish" and not "waiting on you". Coach Home already
 * prints "N steps are waiting on you" from a different fact: rows of `provisioning_steps` sitting
 * in `blocked`, which is the worker refusing a step rather than the coach not having reached it.
 * For the demo coach those are one and five on the same afternoon, so leaving both sentences in the
 * same words would recreate Note 3's contradiction in prose after the counter itself was fixed.
 * Two different facts get two different sentences until one lane owns both surfaces.
 */
export function setupHeadline(rows: readonly OnboardingStepRow[]): string {
  if (rows.some((row) => row.state === "unknown")) {
    return "Some of your setup could not be read just now";
  }
  const yours = rows.filter((row) => row.state === "current" || row.state === "later").length;
  if (yours === 0) return "Nothing is left for you to finish";
  if (yours === 1) return "One step is still yours to finish";
  return `${COUNT_IN_WORDS[yours] ?? String(yours)} steps are still yours to finish`;
}

/**
 * Small enough to spell. The rail counts at most six steps and the go-live checklist at most seven,
 * so a numeral never has to appear in a sentence: the coach type rules keep figures in mono, and a
 * mono "4" sitting inside prose reads as a measurement rather than as a count of chores.
 */
export const COUNT_IN_WORDS: Record<number, string> = {
  2: "Two",
  3: "Three",
  4: "Four",
  5: "Five",
  6: "Six",
  7: "Seven",
};
