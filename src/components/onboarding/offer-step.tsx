import Link from "next/link";

import { TONE_LINE, TONE_MARK, TONE_TEXT, TONE_WASH, type Tone } from "@/components/kit/atomics";
import {
  OnboardingStepShell,
  STEP_PANEL_CLASS,
  STEP_PRIMARY_CLASS,
  STEP_SECONDARY_CLASS,
  StepReadback,
  nextStepHref,
} from "@/components/onboarding/step-shell";
import type { OfferReview } from "@/components/onboarding/offer-view-models";

/*
 * Step 5 of 6.
 *
 * `offerReview(...)` is unchanged, and so is the decision it encodes: this step states what
 * SetterFi has for each of the four answers and hands editing to `/coach/agent`, which is the one
 * offer editor in the product. A second editor over the same rows would be a fork of the
 * draft-and-publish lifecycle maintained by nobody.
 *
 * Absence is stated, never filled in: a programme with no name says it has no name, and a
 * qualifier with no minimum says there is no minimum, which is a different fact from "0".
 *
 * The forward action is Continue and it is the page's only fill, which is a change from the
 * shipped screen: that one offered Back, "Set up your offer" and Continue in one row, and filled
 * whichever of the two forward actions the state chose. Two forward actions on a step is the
 * ambiguity the audit measured on the connect screen, in a quieter form.
 */

const SOURCE_STATUS: Record<OfferReview["source"], { label: string; tone: Tone }> = {
  draft: { label: "Draft, so your agent is not using it yet", tone: "draft" },
  none: { label: "Nothing saved yet", tone: "warning" },
  published: { label: "These are the answers your agent uses", tone: "good" },
};

const SOURCE_LEAD: Record<OfferReview["source"], string> = {
  draft: "These answers are saved as a draft, so your agent is not saying them to leads yet.",
  none: "Your agent knows the industry already. These four answers are what make it yours.",
  published: "This is what your agent says about your business. You change all four from your agent screen.",
};

export function offerStepEyeCopy(review: OfferReview) {
  return [
    "The four things your agent needs to know about your business. Everything else about how it"
    + " talks to funding leads is already built and kept current for you.",
    ...review.rows.map((row) => `${row.name}: ${row.note}`),
    "You change all four from your agent screen; this step reads them back rather than being a"
    + " second editor for the same rows.",
  ].join(" ");
}

export function OfferStep({ review }: { review: OfferReview }) {
  const status = SOURCE_STATUS[review.source];

  return (
    <OnboardingStepShell
      eyeCopy={offerStepEyeCopy(review)}
      eyeScreen="onboarding-offer"
      lead={SOURCE_LEAD[review.source]}
      primary={
        <Link className={STEP_PRIMARY_CLASS} href={nextStepHref("offer")}>
          Continue to going live
        </Link>
      }
      stepKey="offer"
      width={980}
    >
      <div className="flex flex-col gap-[20px]">
        <p className="m-0">
          <StatePill label={status.label} tone={status.tone} />
        </p>

        <div className="grid grid-cols-1 items-start gap-[20px] md:grid-cols-2">
          {review.rows.map((row) => (
            <section
              aria-labelledby={`onboarding-offer-${row.key}`}
              className={STEP_PANEL_CLASS}
              data-slot={`onboarding-offer-${row.key}`}
              key={row.key}
            >
              <div className="flex min-h-[78px] flex-col justify-center border-b border-[var(--line)] px-[16px] py-[19px] sm:px-[20px]">
                <span className="mb-[4px] block text-[14px] leading-[1.55] text-[color:var(--muted)]">
                  {row.eyebrow}
                </span>
                <h2
                  className="m-0 text-[20px] leading-[1.2] font-[500] tracking-[-0.015em] text-[color:var(--ink)]"
                  id={`onboarding-offer-${row.key}`}
                >
                  {row.name}
                </h2>
              </div>
              <dl className="m-0 flex flex-col gap-[16px] px-[16px] py-[20px] sm:px-[20px]">
                {row.values.map((entry, index) => (
                  <div className="min-w-0" key={`${entry.label}-${index}`}>
                    <dt className="mb-[6px] text-[16px] leading-[1.4] text-[color:var(--muted)]">
                      {entry.label}
                    </dt>
                    <dd className="m-0">
                      <StepReadback absent={entry.value.kind === "absent"}>
                        {entry.value.text}
                      </StepReadback>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        {/*
          The editor lives on one screen and this is the way to it. Secondary, because Continue is
          the step's forward action and a filled "Change your offer" would send a coach sideways
          out of setup with the loudest control on the page.
        */}
        <p className="m-0">
          <Link className={STEP_SECONDARY_CLASS} href="/coach/agent">
            {review.ready ? "Change these on your agent screen" : "Fill these in on your agent screen"}
          </Link>
        </p>
      </div>
    </OnboardingStepShell>
  );
}

/** The vocabulary's 32px state pill: a dot, then the word. Never pressable. */
function StatePill({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span
      className="inline-flex h-[32px] items-center gap-[8px] rounded-full border px-[12px] text-[15px] leading-none font-[500]"
      style={{ background: TONE_WASH[tone], borderColor: TONE_LINE[tone], color: TONE_TEXT[tone] }}
    >
      <span
        aria-hidden="true"
        className="size-[8px] flex-none rounded-full"
        style={{ background: TONE_MARK[tone] }}
      />
      {label}
    </span>
  );
}
