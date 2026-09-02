"use client";

import {
  FigureStrip,
  MonoMeta,
  NoteStrip,
  Prose,
  Status,
  StatusAbsent,
  Surface,
  SurfaceHeader,
  type FigureStripItem,
} from "@/components/kit/atomics";
import {
  ESCALATION_CLOCK_BASIS,
  ESCALATION_HANDOFFS,
  ESCALATION_WAIT_ABSENT,
  type EscalationHandoff,
  type EscalationQueue,
} from "@/components/workspace/live/escalation-queue";
import { formatElapsed } from "@/lib/operations/attention-queue-format";
import { COACH_READING_CLASS, COACH_SURFACE_TITLE_CLASS } from "./coach-type";

/**
 * The escalation panel: screen 1a's summary and screen 1l's rules, over the inbox's own rows.
 *
 * The artifact draws 1a as a second full list of the same threads. Building it that way here would
 * put the same six conversations on the page twice, once ranked by wait and once by recency, so the
 * ranking moved into the inbox list itself and this panel keeps what a list cannot say: how deep
 * the queue is, how long the worst wait is, what the order means, and what hands a thread over in
 * the first place.
 *
 * 1l is transcribed as a statement rather than as a settings screen. Its toggles, its hit rates and
 * its "describe a new rule in plain words" box all need a per-coach escalation-rule table, and
 * there isn't one: escalation reasons are a fixed enum the platform writes. A toggle over nothing
 * reads as broken, so what SetterFi already decided is stated in words -- which is the done-for-you
 * posture the rest of this console takes -- and the only numbers are counts of the queue's own rows.
 */
export function EscalationPanel({ queue }: { queue: EscalationQueue }) {
  const waiting = queue.waiting > 0;
  const figures: FigureStripItem[] = [
    {
      label: "Waiting on you",
      value: queue.waiting,
      tone: "warning",
      note: waiting ? "nobody has taken these over yet" : undefined,
    },
    {
      label: "Longest wait",
      value: queue.longestWaitSeconds,
      format: "duration",
      tone: "warning",
      absent: "no wait could be measured",
    },
  ];
  // Only said when it is true. A "0 unrecorded" tile would make a clean queue look like a defect.
  if (queue.waitsNotRecorded > 0) {
    figures.push({
      // The count is of nulls, and null has four causes -- an unstamped column, no server instant,
      // an unparseable value, and a stamp sitting ahead of the clock. The note used to name the
      // first of them, which reads as a finding the queue never made: in the skew case the thread
      // was stamped and it is the measurement that failed. So the tile states what it counted and
      // stops there rather than trading a wrong diagnosis for a right-sounding one.
      label: "Wait not measured",
      value: queue.waitsNotRecorded,
      note: "the wait could not be measured for these",
    });
  }

  return (
    <Surface
      aria-label="Escalations"
      className="mb-[var(--s-3)]"
      // The frame is amber only while somebody is actually waiting on the coach. An empty queue is
      // the good case, and framing it in the waiting colour would call a clean inbox a problem.
      tone={waiting ? "warning" : "neutral"}
      variant="panel"
    >
      <SurfaceHeader
        subtitle={queue.rankedBy}
        /*
         * The panel used to wear an "ESCALATIONS" overline above this title -- 9.5px uppercase
         * mono, the role this surface is getting rid of. It is not replaced by a coach-sized
         * eyebrow, it is dropped: the title under it already says what the panel is, so the
         * overline was a category label for a category of one. `Surface` still carries
         * `aria-label="Escalations"`, so nothing that navigates by landmark lost its name.
         */
        title={
          <span className={COACH_SURFACE_TITLE_CLASS}>
            Threads the agent handed to you
          </span>
        }
        /*
         * Every wait on this page was measured once, when the page was built. Saying so is not
         * pedantry: without it a coach reads a frozen "22m" as a live clock and trusts it after it
         * has stopped being true. A rendered timestamp would be worse, because it would need a
         * timezone the server and the browser do not agree on.
         */
        trailing={
          <MonoMeta>{queue.asOf === null ? "wait clock unavailable" : "measured at page load"}</MonoMeta>
        }
      />
      <div className="flex flex-col gap-[var(--s-4)] p-[var(--s-4)]">
        <FigureStrip items={figures} label="Escalation queue depth" />
        {/* What the clock reads, said once, for the tile above, the clock on every row below and
            the order those rows are in -- all three read the same `waitSeconds`. Per-row it would
            be noise; unsaid it would let a carried-over stamp pass as this handoff's wait, and
            would leave the ranking a coach triages by looking like a fact. */}
        <Prose className={`${COACH_READING_CLASS} text-[color:var(--muted)]`}>{ESCALATION_CLOCK_BASIS}</Prose>

        <section aria-label="What hands a thread over">
          {/* A 17px sentence-case heading where this was an `Overline`. The atomic renders 9.5px
              uppercase mono, which is correct on the owner console and is the worst legibility
              case in the product on a surface built for coaches over 55. */}
          <h3 className="m-0 text-[17px] leading-[1.3] font-semibold text-[color:var(--ink)]">
            What hands a thread over
          </h3>
          <Prose className={`mt-[var(--s-2)] ${COACH_READING_CLASS} text-[color:var(--muted)]`}>
            {queue.handoffs.basis}
          </Prose>
          <ul className="m-0 mt-[var(--s-3)] flex list-none flex-col gap-[var(--s-2)] p-0">
            {handoffRows(queue).map((row) => (
              <li className="surface-well flex min-w-0 flex-wrap items-start gap-[var(--s-3)]" key={row.handoff.reason}>
                <div className="min-w-0 flex-1">
                  <p className="m-0 text-[17px] leading-[1.3] font-medium text-[color:var(--ink)]">{row.handoff.label}</p>
                  <Prose className={`mt-[calc(var(--s-1)/2)] ${COACH_READING_CLASS} text-[color:var(--muted)]`}>
                    {row.handoff.behaviour}
                  </Prose>
                </div>
                <div className="shrink-0">
                  {row.waiting === 0 ? (
                    <StatusAbsent label="No thread is waiting on this one" />
                  ) : (
                    <Status
                      /* The atomic hard-codes the console's 11.5px lozenge and takes a className
                         for exactly this: the tone contract stays the atomic's, the scale is the
                         caller's, and on the coach surface the scale is 15px. */
                      className="gap-[8px] py-[5px] pr-[12px] pl-[10px] text-[15px]"
                      detail={`${Math.round(row.share)}%`}
                      label={`${row.waiting} waiting`}
                      tone="warning"
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>

        <NoteStrip tone="neutral">
          SetterFi sets these for every coach, so there is nothing here to switch on or off. If one
          of them is firing more than it should, that is usually the agent&rsquo;s tone rather than
          the rule, and your success owner can look at it with you.
        </NoteStrip>
      </div>
    </Surface>
  );
}

/**
 * Every published rule, in the order the migration declares them, plus any reason the queue is
 * actually carrying that this build has not been taught. A rule with nothing waiting still renders:
 * the list is what hands a thread over, not a leaderboard, and dropping the quiet ones would make
 * the policy look like whatever happened this morning.
 */
function handoffRows(queue: EscalationQueue) {
  const counted = new Map(queue.handoffs.counts.map((count) => [count.handoff.reason, count]));
  const published = ESCALATION_HANDOFFS.map((handoff: EscalationHandoff) => ({
    handoff,
    waiting: counted.get(handoff.reason)?.waiting ?? 0,
    share: counted.get(handoff.reason)?.share ?? 0,
  }));
  const extra = queue.handoffs.counts
    .filter((count) => !ESCALATION_HANDOFFS.some((handoff) => handoff.reason === count.handoff.reason))
    .map((count) => ({ handoff: count.handoff, waiting: count.waiting, share: count.share }));
  return [...published, ...extra];
}

/**
 * The clock a queued row wears, in the units `formatElapsed` already sets across the console. An
 * unknown wait says so; it never reads as zero, and never as "just now".
 */
export function escalationClockLabel(waitSeconds: number | null) {
  if (waitSeconds === null) return ESCALATION_WAIT_ABSENT;
  return `waiting ${formatElapsed(waitSeconds / 60)}`;
}
