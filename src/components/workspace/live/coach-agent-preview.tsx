"use client";

import Link from "next/link";

import { useCallback, useEffect, useRef, useState } from "react";

import { ACCENT_FILL_SHADOW_CLASS } from "@/components/kit/atomics/button-class";
import { DeckPanel, TitlePanel } from "@/components/kit/deck-panel";
import { Play, Refresh } from "@/components/kit/icons";
import { COACH_FOOTNOTE_CLASS, COACH_LEAD_CLASS } from "./coach-type";

/**
 * "Watch your agent work" -- the coach's read-only view of what their agent does with a lead.
 *
 * **This is not a replacement for `meet-your-agent.tsx`, on purpose.** That component is a live
 * sandbox with a composer, adversarial suggestion chips, a trace legend, a grounding receipt and an
 * eval-promotion form, and three surfaces depend on it: onboarding, the admin eval playground, and
 * the admin context of `/meet-agent`. `MeetYourAgent.dc.html` draws something categorically
 * simpler -- a scripted playback with an explanation panel -- and building the artboard literally
 * would have deleted working admin capability to conform to a canvas that is still unsigned
 * (`docs/REDESIGN-CANVAS.md:5`). So this is additive: a coach opening `/meet-agent` gets this, a
 * platform actor still gets the sandbox, and nothing was removed to make room.
 *
 * **What is scripted, and what is not.** The conversation is written. It has to be: a coach seeing
 * the product for the first time needs to watch a lead being qualified, refused a guarantee and
 * offered three times, and none of that can be produced on demand from a workspace with no leads in
 * it yet. Every surface that shows it says so -- the chip above the title, the pane header, and the
 * footnote under the steps -- because a demonstration a reader mistakes for their own agent's work
 * is a lie whatever the markup says.
 *
 * The two numbers in step 3 are the exception and are deliberately not scripted: `creditFloor` and
 * `minimumRaiseCents` come from the coach's own published offer, read by the page. When the offer
 * has no value for one -- unpublished, or the field left unset -- the row states the rule without a
 * number rather than printing the artboard's 640 and $25,000, which belong to a coach who does not
 * exist. That is also why step 4's sentence is built from the same pair.
 */

export type CoachAgentPreviewRules = {
  /** The published offer's `creditMin`. Null when there is no offer or the field is unset. */
  creditFloor: number | null;
  /** The published offer's `fundingGoalMinCents`. Null for the same reasons. */
  minimumRaiseCents: number | null;
};

type ScriptTurn = {
  id: string;
  from: "lead" | "agent";
  text: string;
};

/**
 * The five bubbles the artboard draws, verbatim.
 *
 * `Marcus` is not interpolated into the fourth: the sentence is about what the coach does, and the
 * coach reading it is the person it names, so it takes their own first name when the shell knows
 * one and "your coach" when it does not -- see `agentTurns` below.
 */
const SCRIPT: readonly ScriptTurn[] = [
  {
    id: "opener",
    from: "lead",
    text: "Hey, saw your reel. I need funding for my business. Can you help?",
  },
  {
    id: "qualify",
    from: "agent",
    text:
      "Happy to. Two quick things and I will know if this is a fit: roughly where is your credit "
      + "score, and how much are you looking to raise?",
  },
  {
    id: "answer",
    from: "lead",
    text: "690 or so. About $60,000. Is it guaranteed if I sign up?",
  },
  {
    id: "refusal",
    from: "agent",
    text:
      "No, and I will not tell you otherwise. Approval is the lender's call. What {coach} does is "
      + "get your file to where lenders say yes, and he would rather explain that himself.",
  },
  {
    id: "times",
    from: "agent",
    text:
      "He has Wednesday at 10:00, Wednesday at 3:30 and Thursday at 9:00 open. Which one works?",
  },
];

/** The turn the elapsed-time caption belongs to. Read off the script so it cannot go stale. */
const LAST_TURN_ID = SCRIPT[SCRIPT.length - 1]?.id;

/**
 * The sentence under the title, and the one line on this page that has to be argued rather than
 * copied.
 *
 * The artboard prints "This is your real setup answering a made-up lead." That is false and it is
 * false in the direction that matters: both sides of the conversation are constants in `SCRIPT`,
 * so the *replies* -- the thing a coach reads that sentence and then looks at -- were not produced
 * by their setup at all. It also sits directly under a chip saying the conversation is not real,
 * which leaves a reader to decide which of two adjacent sentences to believe.
 *
 * So the sentence names the split instead of averaging over it: the conversation is written, and
 * the coach's own configuration appears in exactly one place, the rules step 3 checks. Saying
 * "partly real" would have been the same evasion in fewer words -- a coach cannot act on "partly",
 * and the two steps that ARE real are two lines away, so a vague sentence reads as a hedge next to
 * them. When nothing is published there is no real part to name and the sentence says that
 * outright rather than implying one exists.
 */
function leadSentence(rules: CoachAgentPreviewRules): string {
  const named = [
    rules.creditFloor === null ? null : "your score floor",
    rules.minimumRaiseCents === null ? null : "your smallest raise",
  ].filter(Boolean);

  if (named.length === 0) {
    return (
      "Both sides of this conversation are written: the lead and the replies. You have not "
      + "published any rules yet, so none of it is reading your own setup."
    );
  }

  return (
    `Both sides of this conversation are written: the lead and the replies. What comes from `
    + `your own setup is the rules it checks in step 3: ${named.join(" and ")}, read from your `
    + `agent page.`
  );
}

const CURRENCY = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 0,
  style: "currency",
});

/**
 * The six rows of "What your agent did", in the coach's words rather than the trace's.
 *
 * Rows 3 and 4 are the only two that make a claim about this coach's own configuration, so they
 * are the only two that take an argument. Everything else describes what the agent does for
 * everybody, which is true of this workspace whether or not an offer has been published.
 */
function stepsFor(
  rules: CoachAgentPreviewRules,
): readonly { title: string; body: string; tone?: "warning" | "accent" }[] {
  const floor = rules.creditFloor === null ? null : `a ${rules.creditFloor} score floor`;
  const raise =
    rules.minimumRaiseCents === null
      ? null
      : `a ${CURRENCY.format(rules.minimumRaiseCents / 100)} smallest raise`;
  const both = [floor, raise].filter(Boolean).join(" and ");

  return [
    {
      title: "Picked up her message",
      body: "Denise wrote to your Instagram account. Your agent answered eight seconds later.",
    },
    {
      title: "Read The Brain",
      body:
        "Looked up how a first funding question gets answered. That knowledge is kept current for "
        + "you, so you never write it.",
    },
    {
      title: "Checked your prices and your rules",
      body: both
        ? `Your own numbers, from your agent page: ${both}.`
        : "Your own numbers, from your agent page. You have not published any yet, so this run "
          + "used no floor of yours.",
    },
    {
      title: both ? "Decided she qualifies" : "Decided whether she qualifies",
      body: both
        ? `690 and $60,000 clear both of your rules, so it kept the conversation going instead of `
          + `ending it politely.`
        : "With no rules of yours published, it had nothing of yours to measure her against. "
          + "Publish your offer and this step becomes your own decision rather than a general one.",
    },
    {
      /*
        `MeetYourAgent.dc.html:190` colours this tile's number amber and `:199` colours the next
        one accent, and the tone is carried here rather than applied to rows 5 and 6 at the render
        because the position is a coincidence and the role is not. Row 4 already changes its title
        when the coach has published no rules, so a renderer keying on the index would tone
        whichever sentence happened to land fifth. This row is amber because it is the refusal --
        the one step where the agent declines to say something -- and the last is accent because it
        is the outcome the whole run exists to reach.
      */
      tone: "warning",
      title: "Refused to promise a guarantee",
      body:
        "She asked if funding was guaranteed. Nothing you wrote says it is, so your agent said no. "
        + "It cannot make that up.",
    },
    {
      tone: "accent",
      title: "Offered three times from your calendar",
      body:
        "Read the openings on the calendar you connected and gave her the next three. It never "
        + "invents a slot.",
    },
  ];
}

/* The "sample lead" chip, `MeetYourAgent.dc.html:98`: a soft-cornered label, not a pill. It sits
   directly above a 46px page title, and a full-radius chip at that size reads as a status pill --
   something the page is reporting -- when what it is is a caption on the title underneath it.

   The radius and the padding are the artboard's; the size is not. It draws 13px, and
   `SIMPLIFICATION-SPEC.md` §5 sets a 14px floor on every coach surface with no exceptions, so the
   floor wins and this stays at 14. `coach-type-floor.test.ts` enforces that, which is how the
   13px arrived and left again inside one commit. */
const CHIP_CLASS =
  "inline-flex items-center gap-[8px] rounded-[8px] border border-[var(--line)]"
  + " bg-[var(--well)] px-[11px] py-[5px] font-[family-name:var(--font-mono)] text-[14px]"
  + " leading-none tracking-[0.04em] text-[color:var(--muted)]";

/*
 * Three button recipes, where there used to be two -- and the split is the point.
 *
 * One `SECONDARY_BUTTON_CLASS` was dressing two controls the artboard draws at different sizes:
 * the replay button in the page header at `MeetYourAgent.dc.html:101` (48px, `0 20px`, radius 11,
 * 16px) and "Change something first" on the drench panel at `:215` (56px, `0 20px`, radius 12,
 * 17px). They are the same word "secondary" and not the same control: one is a utility beside a
 * page title, the other is half of the decision the screen exists for. A single constant meant
 * every future correction to either recipe silently moved the other, and both were at 52px --
 * a size neither of them is drawn at.
 */

/** Header utility, `MeetYourAgent.dc.html:101`. Carries an 18px glyph, hence the gap. */
const REPLAY_BUTTON_CLASS =
  "inline-flex h-[48px] items-center justify-center gap-[11px] rounded-[11px]"
  + " border border-[var(--line)] bg-[var(--well)] px-[20px] text-[16px] leading-none font-medium"
  + " text-[color:var(--body)] no-underline hover:border-[var(--accent-edge)]"
  + " hover:text-[color:var(--ink)]";

/**
 * The drench panel's two choices, `MeetYourAgent.dc.html:215` and `:217`, both at 56px.
 *
 * **The faces stay token-spelled, and that is load-bearing.** Both of these sit on a drenched
 * panel, and `coach.css:816` re-declares `--well`, `--line`, `--body` and the four text roles for
 * that subtree so a face inside it is authored against the drench rather than the page; `:1002`
 * then inverts anything matching `bg-[var(--accent-fill)]` to a near-white face with dark ink,
 * measured at 5.82:1 against the panel with the label at 13.62:1 on it.
 *
 * So the inversion this panel needs already exists and it is a stylesheet rule, not a class list.
 * Writing the inverted face here instead would be worse in three ways that are easy to miss from
 * inside this file: the rule matches on the literal text `bg-[var(--accent-fill)]`, so changing
 * the spelling silently un-styles the button; `coach-drench-controls.test.ts:217` exists to catch
 * exactly that rename and reads `PRIMARY_BUTTON_CLASS` by name; and the rule covers every accent
 * face on any drenched coach panel, where a local class covers one button. Hard-coding white
 * alphas here would likewise route around the `--well` and `--line` remap that already produces
 * them. Leave the colour to the sheet; this constant owns the geometry.
 */
const SECONDARY_BUTTON_CLASS =
  "inline-flex h-[56px] items-center justify-center rounded-[12px] border border-[var(--line)]"
  + " bg-[var(--well)] px-[20px] text-[17px] leading-none font-medium text-[color:var(--body)]"
  + " no-underline hover:border-[var(--accent-edge)] hover:text-[color:var(--ink)]";

const PRIMARY_BUTTON_CLASS =
  "inline-flex h-[56px] items-center justify-center gap-[12px] rounded-[12px]"
  + " border border-[var(--accent-line)] bg-[var(--accent-fill)] px-[28px] text-[18px]"
  + ` leading-none font-semibold text-[color:var(--on-accent)] no-underline ${ACCENT_FILL_SHADOW_CLASS}`;

/**
 * The numbered tile beside each step, `MeetYourAgent.dc.html:155` and its siblings: a 34px square
 * at radius 10, not a 28px circle. Two of the six carry a tone, and which two is decided in
 * `stepsFor` by what the step does -- see the note there.
 *
 * A circle numbered 1..6 reads as a bullet the eye skips; a squared tile at the height of the
 * title beside it reads as a step in a sequence, which is what a coach is being walked through.
 */
const STEP_TILE_TONE_CLASS = {
  plain: "border-[var(--line)] bg-[var(--well)] text-[color:var(--muted)]",
  warning: "border-[var(--warning-line)] bg-[var(--warning-wash)] text-[color:var(--warning-text)]",
  accent: "border-[var(--accent-edge)] bg-[var(--accent-wash)] text-[color:var(--accent-text)]",
} as const;

/** How long each bubble waits before the next arrives. */
const TURN_DELAY_MS = 900;

export function CoachAgentPreview({
  coachName,
  rules = { creditFloor: null, minimumRaiseCents: null },
}: {
  /** The coach's first name, for the one script line that names them. */
  coachName?: string | null;
  rules?: CoachAgentPreviewRules;
}) {
  /*
   * How many bubbles are showing. It starts at the full count rather than at zero, so the screen
   * is complete on first paint and the playback is something the reader opts into with "Play it
   * again". A conversation that types itself out on arrival makes a coach wait to read a page
   * they did not ask to watch, and it makes the page useless to anyone reading it with a screen
   * reader, where the same text would arrive in pieces.
   */
  const [shown, setShown] = useState(SCRIPT.length);
  const timers = useRef<number[]>([]);

  const clearTimers = useCallback(() => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current = [];
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const replay = useCallback(() => {
    clearTimers();
    /*
     * A reader who has asked their system for less motion gets the whole conversation at once.
     * "Play it again" still does something -- it is what confirms the screen responded -- but the
     * something is the end state rather than five staggered arrivals.
     */
    const reduced =
      typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setShown(SCRIPT.length);
      return;
    }
    setShown(1);
    for (let turn = 2; turn <= SCRIPT.length; turn += 1) {
      timers.current.push(
        window.setTimeout(() => setShown(turn), TURN_DELAY_MS * (turn - 1)),
      );
    }
  }, [clearTimers]);

  const playing = shown < SCRIPT.length;
  const steps = stepsFor(rules);
  const coach = coachName?.trim() || "your coach";

  return (
    <div className="flex min-w-0 flex-col gap-[var(--s-6)]">
      <header className="flex flex-wrap items-end justify-between gap-[var(--s-5)]">
        <div className="min-w-0">
          {/*
            The first of three places this page says the conversation is made up. It is a chip
            above the title rather than a footnote below the fold because it has to be read before
            the conversation is, not after.
          */}
          <span className={CHIP_CLASS} data-slot="preview-provenance">
            SAMPLE LEAD · NOT A REAL CONVERSATION
          </span>
          <h1 className="coach-page-title m-0 mt-[var(--s-3)]">Watch your agent work</h1>
          <p className={`m-0 mt-[var(--s-3)] ${COACH_LEAD_CLASS}`} data-slot="preview-lead">
            {leadSentence(rules)} Nothing here reaches anyone, and none of it counts in your
            numbers.
          </p>
        </div>
        <button className={REPLAY_BUTTON_CLASS} onClick={replay} type="button">
          <Refresh aria-hidden size={18} strokeWidth={1.75} />
          Play it again
        </button>
      </header>

      <div className="grid min-w-0 items-start gap-[14px] lg:grid-cols-[minmax(0,560px)_minmax(0,1fr)]">
        <DeckPanel
          dataSlot="preview-conversation"
          eyebrow="Instagram message, sample lead"
          headingId="preview-conversation-heading"
          meta={
            playing ? (
              <span className="rounded-[var(--r-full)] bg-[var(--band)] px-[10px] py-[4px] font-[family-name:var(--font-mono)] text-[14px] leading-none text-[color:var(--body)]">
                Playing
              </span>
            ) : undefined
          }
          name="Denise Alvarez"
        >
          {/*
            `aria-live` is deliberately absent. The full conversation is in the DOM from first
            paint and the replay only hides the tail of it, so there is nothing arriving that a
            screen reader has not already been able to read at its own pace.
          */}
          {/*
            The two widths are different on purpose, and the artboard is consistent about it
            (`:122` against `:126`): the lead's side stops at 78% and the agent's runs to 84%. The
            agent does most of the talking in this script, so equal widths would have left its
            longer turns ragged against a column the lead never fills.
          */}
          <ol className="m-0 flex list-none flex-col gap-[12px] p-0">
            {SCRIPT.slice(0, shown).map((turn) => (
              <li
                className={
                  turn.from === "lead"
                    ? "max-w-[78%] self-start rounded-[14px_14px_14px_5px] border border-[var(--line)] bg-[var(--well)] px-[17px] py-[13px] text-[16px] leading-[1.45] text-[color:var(--body)]"
                    : "max-w-[84%] self-end rounded-[14px_14px_5px_14px] border border-[var(--accent-edge)] bg-[var(--accent-wash)] px-[17px] py-[13px] text-[16px] leading-[1.45] text-[color:var(--body)]"
                }
                data-turn={turn.from}
                key={turn.id}
              >
                {turn.text.replace("{coach}", coach)}
                {/*
                  The elapsed time is a caption on this one message, not on the pane, so
                  `MeetYourAgent.dc.html:130` prints it inside the last bubble. It shipped as a
                  footnote under the whole list, where "22 seconds" read as the length of the
                  conversation rather than the moment that reply landed -- and it stayed on screen
                  during a replay that had not reached the reply yet, timestamping a message the
                  reader could not see. Rendering it from the turn ties it to the bubble it
                  measures, so the replay carries it in and out.
                */}
                {turn.id === LAST_TURN_ID ? (
                  <span className="mt-[8px] block font-[family-name:var(--font-mono)] text-[length:var(--coach-eyebrow)] leading-none text-[color:var(--faint)]">
                    Your agent · 22 seconds into the conversation
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </DeckPanel>

        <DeckPanel
          dataSlot="preview-steps"
          eyebrow="Every step, in plain words"
          headingId="preview-steps-heading"
          meta={
            /* `MeetYourAgent.dc.html:149` gives this a border, a well and 34px of height -- the
               same object as the "Playing" pill opposite it in the other pane's header, and the
               two headers sit side by side on one row. Bare text in one and a pill in the other
               made the same slot look like two different kinds of thing. */
            <span className="inline-flex h-[34px] flex-none items-center rounded-[var(--r-full)] border border-[var(--line)] bg-[var(--well)] px-[13px] font-[family-name:var(--font-mono)] text-[15px] leading-none text-[color:var(--muted)]">
              {`${steps.length} steps`}
            </span>
          }
          name="What your agent did"
        >
          <ol className="m-0 flex list-none flex-col p-0">
            {steps.map((step, index) => (
              <li
                className={`flex gap-[14px] py-[14px]${index > 0 ? " border-t border-[var(--line-soft)]" : ""}`}
                key={step.title}
              >
                <span
                  aria-hidden
                  className={`inline-flex size-[34px] flex-none items-center justify-center rounded-[10px] border font-[family-name:var(--font-mono)] text-[15px] leading-none ${STEP_TILE_TONE_CLASS[step.tone ?? "plain"]}`}
                >
                  {index + 1}
                </span>
                <span className="min-w-0">
                  <span className="block text-[19px] leading-[1.3] font-semibold tracking-[-0.012em] text-[color:var(--ink)]">
                    {step.title}
                  </span>
                  <span className="mt-[4px] block text-[16px] leading-[1.5] text-[color:var(--muted)]">
                    {step.body}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          {/*
            The artboard's footnote here reads "Logged. This run is kept on your account so you can
            show anyone what your agent said." That sentence is not printed, and its absence is the
            most important decision in this file: nothing about this run is kept anywhere. It is a
            written script rendered from a constant, there is no row behind it, and telling a coach
            they could show it to somebody as a record of their agent's work would be inventing a
            receipt -- the same class of claim as a predicted carrier date. The sentence goes in the
            day a real run of theirs is stored and can be linked to.
          */}
          <p className={`mt-[var(--s-4)] ${COACH_FOOTNOTE_CLASS}`}>
            A written demonstration, not a recording of your own agent. Your real conversations are
            in your inbox.
          </p>
        </DeckPanel>
      </div>

      {/*
        The decision the screen exists for, and the reason it is a `TitlePanel`.

        `MeetYourAgent.dc.html:213` draws this as a flat centred row -- `padding: 22px 26px`,
        `align-items: center`, the title and its sentence on the left and the two choices hard
        right against them -- with no header band at all. Through `DeckPanel` it took the banded
        anatomy instead: a 78px eyebrow band across the top, then the sentence, then the two
        choices dropped a block below their own title. A coach reading it had to travel the height
        of a card to get from "Ready when you are" to the control that answers it, on the one panel
        in the product where the title and the decision are the same sentence.
      */}
      <TitlePanel
        aside={
          <div className="flex flex-wrap items-center gap-[14px]">
            <Link className={SECONDARY_BUTTON_CLASS} href="/coach/agent">
              Change something first
            </Link>
            {/*
              A link to the step that owns going live, not a button that does it. Turning the agent
              on is the last step of the setup journey, where the readiness gate and the receipt
              live; a second place to fire it from a preview screen would be a second authority over
              the one action in the product that starts talking to real people.
            */}
            <Link className={PRIMARY_BUTTON_CLASS} href="/coach/get-started">
              <Play aria-hidden size={20} strokeWidth={1.75} />
              This looks right, go live
            </Link>
          </div>
        }
        asideAlign="center"
        className="px-[26px] py-[22px]"
        dataSlot="preview-go-live"
        drench="info"
        headingId="preview-go-live-heading"
        sentence="Going live turns your agent on for Instagram and Messenger today. Text messaging joins on its own once carrier review finishes."
        title="Ready when you are"
      />
    </div>
  );
}
