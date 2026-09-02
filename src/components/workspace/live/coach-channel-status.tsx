import Link from "next/link";

import { Clock } from "@/components/kit/icons";
import { DayCounter, elapsedWorkspaceDays } from "@/components/kit/day-counter";
import { carrierReviewFrom, type CarrierReview } from "@/lib/onboarding/carrier-review";
import { CARRIER_TYPICAL_DAYS } from "@/lib/onboarding/contracts";
import type { MessagingChannel } from "@/lib/integrations/types";

/**
 * What coach Home is allowed to say about the channels the agent answers on, and about the one
 * channel that is still waiting on somebody else.
 *
 * This is a separate module from `coach-measurement` for a reason that is about evidence rather
 * than about file size. Everything else on Home is a measurement -- a number the analytics RPC
 * returned over a window the coach picked -- and every one of those goes through
 * `metricAvailability` so an absent figure says why it is absent. The two facts here are not
 * measurements at all: they are the state of a row in `channel_connections` and the state of an
 * A2P registration, neither of which has a window, a denominator or a cohort. Routing them
 * through the metric machinery would have meant inventing an availability arm for a thing that is
 * never a number, and keeping them in the same file as the deck is how a later reader ends up
 * doing exactly that. So the boundary is drawn here, and the honest-states rule is enforced on
 * this side of it by the `CarrierReview` union rather than by `MetricAvailability`.
 */

/**
 * The registration reduction, re-exported under the name Home already imports it by.
 *
 * It moved to `@/lib/onboarding/carrier-review` when `/onboarding/sms-eligibility` needed the same
 * answer -- an onboarding route cannot import a workspace component, and a fourth hand-derived
 * copy is what put a forever-climbing day counter on that step. The alias stays because this
 * module is where the coach surfaces already reach for it.
 */
export type CoachCarrierReview = CarrierReview;
export { carrierReviewFrom };

export type CoachChannelStatus = {
  /**
   * The channels whose connection row is in state `live`, in the order `MESSAGING_CHANNELS`
   * declares them, so the sentence reads the same way on every tenant.
   */
  liveChannels: readonly MessagingChannel[];
  /** False when the connection read failed, which is a different claim from "nothing is live". */
  channelsChecked: boolean;
  carrier: CoachCarrierReview;
};

/**
 * The coach-facing name for a channel, which is deliberately not the repository's `channelLabel`.
 *
 * `channel-connections.ts` labels Messenger "Facebook Messenger" and SMS "Text messages (SMS)",
 * and those are the right names on an operator's channel-health table, where a row has to be
 * unambiguous about which provider integration it is. This sentence is the first line a coach
 * reads on their own dashboard, and the product already has a coach-facing name for the same
 * pair: `STEP_LABELS.meta_connect` is "Instagram and Messenger". Two names for one thing is a
 * cost either way; this is the audience that gets the shorter one.
 */
const COACH_CHANNEL_NAMES: Readonly<Record<MessagingChannel, string>> = {
  instagram: "Instagram",
  messenger: "Messenger",
  sms: "Text messaging",
  whatsapp: "WhatsApp",
  webchat: "Web chat",
};

/**
 * A list of names as a sentence, so "Instagram and Messenger" reads the way a person writes it.
 */
function nameList(names: readonly string[]) {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The two-dot line under the greeting: what is answering, and what is still waiting.
 *
 * The green half is a claim about live channels and it is made only from rows that actually say
 * `live`. `ready`, `pending_review` and `connecting` are all connections that exist and none of
 * them is a channel a lead can reach, so a status line built from "has a row" rather than from
 * "is live" would greet a coach mid-onboarding with news that their agent is answering.
 */
export function CoachChannelStatusLine({ status }: { status: CoachChannelStatus | null }) {
  if (!status) return null;

  const liveNames = status.liveChannels.map((channel) => COACH_CHANNEL_NAMES[channel]);
  const carrierWaiting = status.carrier.kind === "in-review";

  // Nothing to say is said as nothing. A row of dots explaining that we could not find out is
  // noise under a greeting, and the setup journey is where an unfinished connection belongs.
  if (liveNames.length === 0 && !carrierWaiting) return null;

  return (
    <p className="coach-statusline">
      {liveNames.length > 0 ? (
        <span className="coach-statusline__item" data-tone="good">
          <span aria-hidden="true" className="coach-statusline__dot" />
          Your agent is live on {nameList(liveNames)}
        </span>
      ) : null}
      {carrierWaiting ? (
        <span className="coach-statusline__item" data-tone="warning">
          <span aria-hidden="true" className="coach-statusline__dot" />
          Text messaging is still in carrier review
        </span>
      ) : null}
    </p>
  );
}

/**
 * The carrier-review notice, and the one place on this page an elapsed day count is the honest
 * answer to "how long".
 *
 * A2P 10DLC vetting is a wait on a third party who publishes no decision schedule, so there is no
 * percentage that means anything and no date that is not invented. What there is, is the number
 * of days since we filed, which is a fact. `elapsedWorkspaceDays` is the same function
 * `DayCounter` computes its own reading from -- called here rather than reimplemented -- so the
 * headline and the counter beneath it cannot drift by a day, which is exactly what happened when
 * `/onboarding/sms-eligibility` counted its own days off `Date.now()` with a `+1`.
 *
 * The reassurance sentence is doing real work and is not decoration: the single most common
 * support contact during this window is a coach who believes something has broken. "About three
 * weeks" is the top of `CARRIER_TYPICAL_DAYS` in words; the exact 14-to-21 range is stated
 * precisely by the `DayCounter` immediately below it, so the prose stays readable without the
 * page losing the real bound.
 */
export function CoachCarrierNotice({
  status,
  now,
}: {
  status: CoachChannelStatus | null;
  now?: Date;
}) {
  if (!status || status.carrier.kind !== "in-review") return null;
  const { submittedAt } = status.carrier;
  const day = submittedAt ? elapsedWorkspaceDays(submittedAt, now) : null;

  return (
    <section aria-labelledby="coach-carrier-heading" className="coach-notice">
      {/*
        The tile `Main.dc.html:124-126` opens this notice with. `aria-hidden` because it says
        nothing the heading beside it does not already say in words -- this is the surface where
        colour and iconography are never the sole carrier of a state, and the heading below spells
        out both the channel and the day count.
      */}
      <span aria-hidden className="coach-notice__tile">
        <Clock size={24} strokeWidth={1.75} />
      </span>
      <div className="coach-notice__body">
        <h2 className="coach-notice__title" id="coach-carrier-heading">
          {day === null ? (
            "Text messaging is still in carrier review"
          ) : (
            <>
              Text messaging is on day <span className="mono">{day}</span> of carrier review
            </>
          )}
        </h2>
        <p className="coach-notice__prose">
          Carriers take about three weeks to approve a new business for texting. Nothing is broken
          and there is nothing for you to do.
        </p>
        {submittedAt ? (
          <div className="coach-notice__counter">
            <DayCounter now={now} since={submittedAt} typicalDays={CARRIER_TYPICAL_DAYS} />
          </div>
        ) : (
          /*
           * Filed, but the filing date was never recorded. The notice still appears, because the
           * wait is real and the coach should know about it, and it counts nothing rather than
           * counting from today -- "day 0" would claim we filed this morning.
           */
          <p className="coach-notice__prose">
            The filing date was not recorded, so no day count is shown.
          </p>
        )}
      </div>
      <Link className="coach-notice__action" href="/coach/get-started">
        See setup
      </Link>
    </section>
  );
}
