/**
 * The four things step two of setup is about, read back from the offer the coach actually has.
 *
 * The canvas draws this step as an editor with four panels of controls. The offer editor already
 * exists, at `/coach/agent`, wired to `GET/PUT /api/coach/offer` with its own draft/publish
 * lifecycle, its own validation and its own change trail -- and `docs/SIMPLIFICATION-SPEC.md` puts
 * those controls there and nowhere else. §4, "Every remaining setting, as a statement or a
 * request," fixes the coach-owned set at four -- Your prices, Who qualifies, How you sound, What
 * each follow-up says -- and rules that everything else is a sentence stating what SetterFi chose
 * rather than a control; §3 places those same four as cards on the "Your agent" rail item. Both
 * sections read and confirmed 2026-09-01; an earlier version of this docblock cited §2.12, which
 * is "Consumer (lighter pass)" and has nothing to do with the offer. A second editor over the same
 * rows would be a fork of that behaviour maintained by nobody, and the canvas audit says as much:
 * what is missing from onboarding is the *framing* of the offer step, not another copy of it.
 *
 * So this step states what SetterFi has for each of the four, and hands the one control over to
 * the editor. That is also the shape `CLAUDE.md` asks the redesign for -- most rows state the
 * value rather than offering a control, so the few things the coach owns are the only interactive
 * things on the page.
 *
 * **Absence is rendered, never filled in.** A programme with no name says it has no name; a
 * qualifier with no minimum says there is no minimum, which is a real and different statement from
 * "0". Nothing here derives a value from another value.
 */

import type { PersistedOfferLayer } from "@/lib/offer/types";
import { ruleSentences } from "@/lib/offer/rules";

export type OfferReviewValue =
  | { kind: "value"; text: string }
  | { kind: "absent"; text: string };

export type OfferReviewRow = {
  key: "program" | "prices" | "qualifiers" | "voice";
  eyebrow: string;
  name: string;
  /** What SetterFi will do with these answers. The canvas's sentence for each panel. */
  note: string;
  values: readonly { label: string; value: OfferReviewValue }[];
};

export type OfferReview = {
  rows: readonly OfferReviewRow[];
  /** Whether the coach has told us enough for the agent to talk about their offer at all. */
  ready: boolean;
  /** Which offer this is reading: the published one, an unpublished draft, or neither. */
  source: "published" | "draft" | "none";
};

const MONEY = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 0,
  style: "currency",
});

const BILLING_PERIOD_LABELS = {
  annual: "a year",
  monthly: "a month",
  one_time: "one time",
  per_session: "a session",
  weekly: "a week",
} as const;

const BRAND_VOICE_LABELS = {
  friendly: "Friendly",
  neutral: "Neutral",
  professional: "Professional",
} as const;

function present(text: string): OfferReviewValue {
  return { kind: "value", text };
}

function absent(text: string): OfferReviewValue {
  return { kind: "absent", text };
}

function money(cents: number | null, absentText: string): OfferReviewValue {
  return cents === null ? absent(absentText) : present(MONEY.format(cents / 100));
}

function priceLine(price: PersistedOfferLayer["offerPrices"][number]) {
  const amount = MONEY.format(price.amountCents / 100);
  const period = price.billingPeriod ? BILLING_PERIOD_LABELS[price.billingPeriod] : null;
  return `${price.label}: ${amount}${period ? ` ${period}` : ""}`;
}

export function offerReview(offer: PersistedOfferLayer | null, source: OfferReview["source"]): OfferReview {
  const programName = offer?.programName?.trim() || "";
  const prices = offer?.offerPrices ?? [];

  return {
    ready: Boolean(programName) && prices.length > 0,
    rows: [
      {
        eyebrow: "Your words, not ours",
        key: "program",
        name: "What you call your program",
        note: "Your agent uses this name in every message, so write it the way you say it on a call.",
        values: [
          {
            label: "Programme name",
            value: programName
              ? present(programName)
              : absent("You have not named your programme yet"),
          },
        ],
      },
      {
        eyebrow: "Quoted exactly as written",
        key: "prices",
        name: "Your prices",
        note: "Your agent will never invent a number, discount one of these, or promise a payment plan you have not written down.",
        values: prices.length > 0
          ? prices.map((price) => ({ label: price.label, value: present(priceLine(price)) }))
          : [{
            label: "Prices",
            value: absent(
              "No price is saved, so your agent will not quote one and will offer to have you answer instead",
            ),
          }],
      },
      {
        eyebrow: "Anyone below these is turned away politely",
        key: "qualifiers",
        name: "Who is worth your time",
        note: "You can change any of these later, and the reason a lead was ruled out always stays on their record.",
        values: [
          {
            label: "Credit score at least",
            value: offer?.creditMin === null || offer?.creditMin === undefined
              ? absent("No minimum")
              : present(String(offer.creditMin)),
          },
          {
            label: "Looking for at least",
            value: money(offer?.fundingGoalMinCents ?? null, "No minimum"),
          },
          {
            label: "Business revenue at least",
            value: money(offer?.monthlyRevenueMinCents ?? null, "No minimum"),
          },
          ...ruleSentences(offer?.qualificationRules ?? []).map((sentence, index) => ({
            label: `Rule ${index + 1}`,
            value: present(sentence),
          })),
        ],
      },
      {
        eyebrow: "Every message is written in the tone you pick",
        key: "voice",
        name: "How you want to sound",
        note: "Your agent keeps this tone in every reply. What it is allowed to say is the central brain's, and it is kept current for you.",
        values: [
          {
            label: "Tone",
            value: offer?.brandVoice
              ? present(BRAND_VOICE_LABELS[offer.brandVoice])
              : absent("No tone picked, so your agent uses the central brain's default"),
          },
          {
            label: "Voice guidelines",
            value: offer?.voiceGuidelines
              ? present(offer.voiceGuidelines)
              : absent("No guidelines written, so the tone above is all your agent goes on"),
          },
        ],
      },
    ],
    source: offer ? source : "none",
  };
}
