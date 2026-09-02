import Link from "next/link";

import { Prose, Status, kitButtonClass } from "@/components/kit/atomics";
import { DayCounter } from "@/components/kit/day-counter";
import { DeckPanel } from "@/components/kit/deck-panel";
import type { ConnectCard } from "@/components/onboarding/connect-view-models";
import {
  COACH_FOOTNOTE_CLASS,
  COACH_READING_CLASS,
} from "@/components/workspace/live/coach-type";
import { CARRIER_TYPICAL_DAYS } from "@/lib/onboarding/contracts";

/**
 * The three channel cards, and the footer bar that carries the coach out of the step.
 *
 * **The accent is spent once.** The canvas fills all three card buttons, which was drawn against
 * the dark palette and before the two-drenches-and-one-fill budget was written down; on a light
 * ground three filled buttons plus a filled "Next" is four competing primaries. The fill goes to
 * the first card that is genuinely waiting on the coach, which is the same rule
 * `coach-integrations.tsx` already applies to this exact set of channels, and the step's own
 * forward action stays quiet until at least one channel is connected -- it is not the thing to
 * press first.
 *
 * The SMS card is never the accent, whatever order it lands in. Filling it would make a
 * three-week carrier review look like the fastest thing on the screen.
 */
export function ConnectChannels({
  cards,
  nextEnabled,
}: {
  cards: readonly ConnectCard[];
  /** Whether any channel is connected. Gates the forward action's fill, never the link itself. */
  nextEnabled: boolean;
}) {
  const accentKey = cards.find((card) => card.key !== "sms" && card.action)?.key ?? null;

  return (
    <div className="flex flex-col gap-[var(--s-6)]">
      <div className="grid grid-cols-1 gap-[18px] lg:grid-cols-3">
        {cards.map((card) => (
          <DeckPanel
            className="flex flex-col"
            dataSlot={`connect-card-${card.key}`}
            eyebrow={card.eyebrow}
            headingId={`connect-card-${card.key}`}
            key={card.key}
            name={card.name}
          >
            <div className="flex h-full flex-col gap-[var(--s-4)]">
              {card.status ? <Status label={card.status.label} tone={card.status.tone} /> : null}

              <Prose className={`${COACH_READING_CLASS} text-[color:var(--body)]`}>
                {card.body}
              </Prose>

              {card.detail ? (
                <p className={`m-0 ${COACH_READING_CLASS} text-[color:var(--ink)]`}>
                  {card.detail}
                </p>
              ) : null}

              {card.wait ? (
                <div className="surface-well">
                  <DayCounter since={card.wait.since} typicalDays={CARRIER_TYPICAL_DAYS} />
                </div>
              ) : null}

              <Prose className={COACH_FOOTNOTE_CLASS}>{card.note}</Prose>

              {card.action ? (
                <Link
                  className={kitButtonClass({
                    className:
                      "mt-auto h-[56px] w-full justify-center text-[17px] no-underline",
                    variant: card.key === accentKey ? "primary" : "secondary",
                  })}
                  href={card.action.href}
                >
                  {card.action.label}
                </Link>
              ) : null}
            </div>
          </DeckPanel>
        ))}
      </div>

      <div className="surface-strip flex flex-col items-start justify-between gap-[var(--s-4)] @min-[720px]:flex-row @min-[720px]:items-center">
        <Prose className={`${COACH_READING_CLASS} text-[color:var(--muted)]`} measure="wide">
          Connect at least one channel to carry on. You can add the others later from your setup
          screen, and nothing you set up here is lost.
        </Prose>
        <div className="flex shrink-0 flex-wrap gap-[var(--s-3)]">
          <Link
            className={kitButtonClass({
              className: "h-[52px] px-[22px] text-[17px] no-underline",
              variant: "secondary",
            })}
            href="/onboarding"
          >
            Do this later
          </Link>
          <Link
            className={kitButtonClass({
              className: "h-[52px] px-[28px] text-[17px] no-underline",
              variant: nextEnabled ? "primary" : "secondary",
            })}
            href="/onboarding/offer"
          >
            Next: your offer
          </Link>
        </div>
      </div>
    </div>
  );
}
