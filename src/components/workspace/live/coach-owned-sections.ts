/**
 * The sections of the setter a coach actually owns, named and counted in one place.
 *
 * Screen 5c draws a "yours to set" list on Home, and `/coach/agent` already renders one: a header
 * that reads "<n> things are yours to set. We run everything else." counted off its own local
 * array, with a stated answer beside every section. Two lists, two counts, one coach. If Home
 * counts separately the two pages eventually disagree about how much of the setter belongs to the
 * coach, which is the one thing this list exists to settle. So the list lives here, `coach-offer`
 * counts it for its header, the Dashboard summarises it, and neither of them owns it.
 *
 * **The artifact draws five rows and two of them have no writable storage.**
 *
 * - *When you take calls* ("Mon-Thu, 9am-4pm, 30 min"). `calendar_connections` stores a timezone,
 *   `slot_duration_minutes` and `min_notice_minutes`. There is no weekday set and no hours window
 *   anywhere in the schema: the bookable hours live in the calendar the coach connected and are
 *   read as slots, never stored as a rule SetterFi could show back or let them edit here.
 * - *Who gets hot leads* ("Dana Whitfield, texted first"). `conversations` has `taken_over_by`,
 *   which records who *did* take a thread over, after the fact. Nothing anywhere nominates a
 *   person in advance, so a row offering to set one would be offering a control that does not
 *   exist.
 *
 * Both moved to the managed strip on `/coach/agent`, where each entry carries the storage note
 * that puts it on that side of the line. What is left is four sections with real coach-writable
 * storage behind every one, and four is the honest count.
 *
 * The fourth, follow-up, is in the artifact's *managed* strip rather than its owned list, and both
 * placements are half right: `coachCadenceSchedule` comments that "the platform owns the channel
 * class, the touch count, and the timing, so only the purpose column is editable downstream". We
 * set when the touches go out; the coach sets what each one is about. The row is named for the
 * half that is theirs.
 */

import type { CoachOfferDraftInput } from "@/lib/offer/types";

export type CoachOwnedSectionKey = "prices" | "voice" | "qualification" | "cadence";

export type CoachOwnedSection = {
  key: CoachOwnedSectionKey;
  /** The row title, as screen 5c words it. */
  label: string;
  /** The one line under the title saying what the setting does to a conversation. */
  explanation: string;
};

export const COACH_OWNED_SECTIONS: readonly CoachOwnedSection[] = [
  {
    key: "prices",
    label: "Your prices",
    explanation: "What the setter quotes, exactly, every time",
  },
  {
    key: "voice",
    label: "How it sounds",
    explanation: "Voice and habits in every message it sends",
  },
  {
    key: "qualification",
    label: "Who you do not want",
    explanation: "Rules that turn a lead away, in your words",
  },
  {
    key: "cadence",
    label: "What each follow-up says",
    explanation: "The angle behind every touch we send for you",
  },
];

export const BRAND_VOICE_LABELS: Record<string, string> = {
  friendly: "Friendly",
  neutral: "Balanced",
  professional: "Professional",
};

/**
 * The six qualifying facts, in the order the qualification section ranks them. A fact is "set"
 * when the coach saved a value for it, so an untouched control stays uncounted even where the
 * platform has a default it would fall back to.
 */
export type QualificationFactSource = Pick<
  CoachOfferDraftInput,
  | "creditMin"
  | "fundingGoalMinCents"
  | "fundingGoalMaxCents"
  | "monthlyRevenueMinCents"
  | "creditRepair"
  | "refundPosture"
>;

export function qualificationFacts(source: QualificationFactSource) {
  return [
    source.creditMin,
    source.fundingGoalMinCents,
    source.fundingGoalMaxCents,
    source.monthlyRevenueMinCents,
    source.creditRepair,
    source.refundPosture,
  ];
}

/**
 * What a published offer already answers for each owned section.
 *
 * `set` is the whole point of the shape: a row the coach has filled in and a row still running on
 * our default are different states and must never render alike, so the wording of an unset row
 * says what we do instead rather than leaving a blank the reader has to interpret.
 */
export type CoachOwnedAnswer = { set: boolean; text: string };

export type CoachOwnedAnswerSource = QualificationFactSource & {
  brandVoice: string | null;
  voiceStyleAnswer: string | null;
  voiceObjectionAnswer: string | null;
  voiceFollowupAnswer: string | null;
  offerPrices: readonly unknown[];
  cadencePurposes: readonly unknown[];
};

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

export function coachOwnedAnswers(
  offer: CoachOwnedAnswerSource | null,
): Record<CoachOwnedSectionKey, CoachOwnedAnswer> | null {
  if (!offer) return null;

  const facts = qualificationFacts(offer);
  const rules = facts.filter((value) => value !== null).length;
  const voiceAnswers = [
    offer.voiceStyleAnswer,
    offer.voiceObjectionAnswer,
    offer.voiceFollowupAnswer,
  ].filter((value) => Boolean(value && value.trim())).length;
  const voiceLabel = offer.brandVoice ? BRAND_VOICE_LABELS[offer.brandVoice] : null;
  const purposes = offer.cadencePurposes.length;

  return {
    prices: offer.offerPrices.length
      ? { set: true, text: `${plural(offer.offerPrices.length, "price", "prices")} the agent may quote` }
      : { set: false, text: "no price the agent can quote" },
    voice:
      voiceLabel || voiceAnswers
        ? {
            set: true,
            text: [voiceLabel, voiceAnswers ? `${plural(voiceAnswers, "answer", "answers")} written` : null]
              .filter(Boolean)
              .join(", "),
          }
        : { set: false, text: "using our standard voice" },
    qualification:
      rules > 0
        ? { set: true, text: `${rules} of ${facts.length} qualifying facts` }
        : { set: false, text: "no qualifying rules saved" },
    // No denominator here on purpose. The touch count comes from `coachCadenceSchedule`, which
    // needs the tenant's connected channels; the Dashboard does not read those, and inventing a
    // denominator to make the fraction look like the editor's would be a number nothing measured.
    cadence: purposes
      ? { set: true, text: `${plural(purposes, "touch", "touches")} given a purpose` }
      : { set: false, text: "using our default purposes" },
  };
}
