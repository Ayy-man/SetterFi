import Link from "next/link";

import { Prose, kitButtonClass } from "@/components/kit/atomics";
import { DeckPanel } from "@/components/kit/deck-panel";
import type { OfferReview } from "@/components/onboarding/offer-view-models";
import {
  COACH_FOOTNOTE_CLASS,
  COACH_READING_CLASS,
} from "@/components/workspace/live/coach-type";

const SOURCE_NOTE = {
  draft: "These are your saved answers. They are a draft, so your agent is not using them yet.",
  none: "Nothing is saved for your offer yet, so your agent has nothing of yours to talk about.",
  published: "These are the answers your agent is using right now.",
} as const;

/**
 * Step two's four rows, and the one control the step actually owns.
 *
 * Every value is a read-back with its absence stated in words, so a coach can see at a glance
 * which of the four SetterFi has and which it does not. The forward action changes with what is
 * saved: with no programme name and no price there is nothing to review, so the fill goes to the
 * editor; once both exist the fill moves to the next step and the editor becomes the quiet one.
 * There is exactly one fill either way.
 */
export function OfferReviewPanels({ review }: { review: OfferReview }) {
  return (
    <div className="flex flex-col gap-[var(--s-6)]">
      <p className={`m-0 ${COACH_READING_CLASS} text-[color:var(--muted)]`}>
        {SOURCE_NOTE[review.source]}
      </p>

      <div className="grid grid-cols-1 gap-[18px] @min-[860px]:grid-cols-2">
        {review.rows.map((row) => (
          <DeckPanel
            dataSlot={`offer-row-${row.key}`}
            eyebrow={row.eyebrow}
            headingId={`offer-row-${row.key}`}
            key={row.key}
            name={row.name}
          >
            <dl className="m-0 flex flex-col gap-[var(--s-3)]">
              {row.values.map((entry, index) => (
                <div
                  className="surface-well flex min-h-[var(--coach-target)] flex-col justify-center gap-[2px]"
                  key={`${entry.label}-${index}`}
                >
                  <dt className={COACH_FOOTNOTE_CLASS}>{entry.label}</dt>
                  <dd
                    className={`m-0 ${COACH_READING_CLASS} ${
                      entry.value.kind === "absent"
                        ? "text-[color:var(--muted)] italic"
                        : "text-[color:var(--ink)]"
                    }`}
                    data-absent={entry.value.kind === "absent" ? "true" : undefined}
                  >
                    {entry.value.text}
                  </dd>
                </div>
              ))}
            </dl>
            <Prose className={`mt-[var(--s-4)] ${COACH_FOOTNOTE_CLASS}`}>{row.note}</Prose>
          </DeckPanel>
        ))}
      </div>

      <div className="surface-strip flex flex-col items-start justify-between gap-[var(--s-4)] @min-[720px]:flex-row @min-[720px]:items-center">
        <Prose className={`${COACH_READING_CLASS} text-[color:var(--muted)]`} measure="wide">
          Nothing here is final. You can change all four from your agent screen at any time.
        </Prose>
        <div className="flex shrink-0 flex-wrap gap-[var(--s-3)]">
          <Link
            className={kitButtonClass({
              className: "h-[52px] px-[22px] text-[17px] no-underline",
              variant: "secondary",
            })}
            href="/onboarding/connect"
          >
            Back
          </Link>
          <Link
            className={kitButtonClass({
              className: "h-[52px] px-[24px] text-[17px] no-underline",
              variant: review.ready ? "secondary" : "primary",
            })}
            href="/coach/agent"
          >
            {review.ready ? "Change your offer" : "Set up your offer"}
          </Link>
          {review.ready ? (
            <Link
              className={kitButtonClass({
                className: "h-[52px] px-[28px] text-[17px] no-underline",
                variant: "primary",
              })}
              href="/meet-agent"
            >
              Next: meet your agent
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}
