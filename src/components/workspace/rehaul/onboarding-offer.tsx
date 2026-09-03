import Link from "next/link";

import { kitButtonClass } from "@/components/kit/atomics";
import type { Tone } from "@/components/kit/atomics";
import { DeckPanel } from "@/components/kit/deck-panel";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import {
  OnboardingFooter,
  OnboardingReadback,
  OnboardingShell,
} from "@/components/workspace/rehaul/onboarding-shell";
import type { OfferReview } from "@/components/onboarding/offer-view-models";

/*
 * Step 3 of setup, drawn from `OnboardingOffer.body.html`.
 *
 * `offerReview(...)` is unchanged, and so is the decision it encodes: this step states what
 * SetterFi has for each of the four answers and hands editing to `/coach/agent`, which is the one
 * offer editor in the product. The artboard draws typed fields; the fields here are the same
 * 48px face carrying a stated value, because a second editor over the same rows would be a fork
 * of the draft-and-publish lifecycle maintained by nobody.
 *
 * Absence is stated, never filled in: a programme with no name says it has no name, and a
 * qualifier with no minimum says there is no minimum, which is a different fact from "0".
 */

const SOURCE_STATUS: Record<OfferReview["source"], { label: string; tone: Tone }> = {
  draft: { label: "Draft, so your agent is not using it yet", tone: "draft" },
  none: { label: "Nothing saved, so your agent has nothing of yours to say", tone: "warning" },
  published: { label: "These are the answers your agent is using", tone: "good" },
};

export function offerEyeCopy(review: OfferReview) {
  return [
    "The four things your agent needs to know about your business. Everything else about how it "
    + "talks to funding leads is already built and kept current for you.",
    ...review.rows.map((row) => `${row.name}: ${row.note}`),
    "You change all four from your agent screen; this step reads them back.",
  ].join(" ");
}

export function OnboardingOfferRehaul({ review }: { review: OfferReview }) {
  const status = SOURCE_STATUS[review.source];

  return (
    <OnboardingShell
      status={[status]}
      step={3}
      title="Tell us about your offer"
      width={1160}
    >
      <div className="grid grid-cols-1 items-start gap-[20px] @min-[860px]/onboarding:grid-cols-2">
        {review.rows.map((row) => (
          <DeckPanel
            dataSlot={`rehaul-offer-${row.key}`}
            eyebrow={row.eyebrow}
            headingId={`rehaul-offer-${row.key}`}
            key={row.key}
            name={row.name}
          >
            <dl className="m-0 flex flex-col gap-[16px]">
              {row.values.map((entry, index) => (
                <div className="min-w-0" key={`${entry.label}-${index}`}>
                  <dt className="mb-[6px] text-[14px] font-medium text-[color:var(--muted)]">
                    {entry.label}
                  </dt>
                  <dd className="m-0">
                    <OnboardingReadback absent={entry.value.kind === "absent"}>
                      {entry.value.text}
                    </OnboardingReadback>
                  </dd>
                </div>
              ))}
            </dl>
          </DeckPanel>
        ))}
      </div>

      <OnboardingFooter
        actions={
          <>
            <Link
              className={kitButtonClass({
                className: "h-[48px] px-[22px] text-[16px] no-underline",
                variant: "secondary",
              })}
              href="/onboarding/connect"
            >
              Back
            </Link>
            <Link
              className={kitButtonClass({
                className: "h-[48px] px-[24px] text-[16px] no-underline",
                variant: review.ready ? "secondary" : "primary",
              })}
              href="/coach/agent"
            >
              {review.ready ? "Change your offer" : "Set up your offer"}
            </Link>
            {review.ready ? (
              <Link
                className={kitButtonClass({
                  className: "h-[48px] px-[28px] text-[17px] no-underline",
                  variant: "primary",
                })}
                href="/onboarding/calendar"
              >
                Continue
              </Link>
            ) : null}
          </>
        }
        sentence="Nothing here is final; you can change all four from your agent screen at any time."
      />

      <ContextEye copy={offerEyeCopy(review)} screen="onboarding-offer" />
    </OnboardingShell>
  );
}
