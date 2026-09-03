"use client";

/**
 * `/meet-agent` for a coach, drawn as `MeetAgent.body.html`: a phone-shaped card that plays the
 * demonstration conversation turn by turn, and a quiet ledger beside it with one row per turn.
 *
 * **The ledger is generated from the turns, not written beside them.** The old surface kept a
 * six-item `stepsFor()` list that was maintained by hand next to a five-item script, so the two
 * could drift and nothing would catch it. Here every turn carries its own trace row, the phone
 * renders the turn and the panel renders the row, and a turn that does not exist cannot have a row
 * describing it. That is also what makes the composer work: a live turn arrives with a receipt
 * from `/api/agent`, and its row is built from that receipt's stage, rule and grounding rather
 * than from anything written here.
 *
 * **What is written and what is real.** The playback conversation is a constant, both sides of it,
 * and the header says so in those words. The two numbers it checks are not invented: `creditFloor`
 * and `minimumRaiseCents` come from the coach's own published offer, read by the page, and when
 * the offer has neither the row says no rules are published rather than printing a floor belonging
 * to a coach who does not exist. Anything the coach types in the composer is a real turn against
 * their own configured agent through the existing test-agent route, which writes no lead send, no
 * calendar entry and no billing effect -- so "nothing sent, nothing counted" stays true on both
 * sides of the composer.
 */

import { ArrowRight, MoreVertical, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import type { CoachAgentPreviewRules } from "@/components/workspace/live/coach-agent-preview";
import type { TestAgentTurnReceipt } from "@/lib/repositories/test-agent";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ *
 * Turns and their trace rows
 * ------------------------------------------------------------------ */

type TraceTone = "grey" | "good" | "amber";

/** One row of "What your agent did". Never authored apart from the turn it describes. */
type TraceRow = {
  /** What happened, in the coach's words. */
  what: string;
  /** The mono figure on the right of the row. */
  detail: string;
  tone: TraceTone;
};

type PreviewTurn = {
  id: string;
  from: "lead" | "agent";
  text: string;
  /** A mono caption under the bubble, when the turn has one. */
  caption?: string;
  trace: TraceRow;
};

const CURRENCY = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 0,
  style: "currency",
});

/** The score the written lead gives. Named so the rule check below cannot drift from the bubble. */
const SCRIPT_SCORE = 720;
/** The raise the written lead asks for, in dollars. Same reason. */
const SCRIPT_RAISE = 60_000;

/**
 * The one row that makes a claim about this coach's own configuration.
 *
 * Four shapes, because there are four things that can be true: both rules published, one, the
 * other, or neither. The written lead's 720 and $60,000 are constants, so whether they clear the
 * coach's floor is a real comparison and the row states the outcome it actually computes -- a row
 * that said "lands in Ready" against a floor of 760 would be a lie about the coach's own setup,
 * which is the only kind of lie this screen is in a position to tell.
 */
function rulesRow(rules: CoachAgentPreviewRules): TraceRow {
  const floor = rules.creditFloor;
  const raise = rules.minimumRaiseCents === null ? null : rules.minimumRaiseCents / 100;

  if (floor === null && raise === null) {
    return {
      detail: "none published",
      tone: "grey",
      what: "Looked for your credit floor and smallest raise, and you have published neither",
    };
  }

  const clearsFloor = floor === null || SCRIPT_SCORE >= floor;
  const clearsRaise = raise === null || SCRIPT_RAISE >= raise;
  const detail = floor === null
    ? `${CURRENCY.format(raise ?? 0)} or more`
    : `${floor} or more`;

  if (floor !== null && raise !== null) {
    return {
      detail,
      tone: clearsFloor && clearsRaise ? "good" : "amber",
      what: clearsFloor && clearsRaise
        ? `Checked your own rules, ${SCRIPT_SCORE} and ${CURRENCY.format(SCRIPT_RAISE)} clear both`
        : `Checked your own rules, ${SCRIPT_SCORE} and ${CURRENCY.format(SCRIPT_RAISE)} do not clear both`,
    };
  }

  if (floor !== null) {
    return {
      detail,
      tone: clearsFloor ? "good" : "amber",
      what: clearsFloor
        ? `Checked your credit floor, ${SCRIPT_SCORE} lands in Ready`
        : `Checked your credit floor, ${SCRIPT_SCORE} sits under it`,
    };
  }

  return {
    detail,
    tone: clearsRaise ? "good" : "amber",
    what: clearsRaise
      ? `Checked your smallest raise, ${CURRENCY.format(SCRIPT_RAISE)} clears it`
      : `Checked your smallest raise, ${CURRENCY.format(SCRIPT_RAISE)} sits under it`,
  };
}

/**
 * The demonstration, `MeetAgent.body.html:20`-`:27`, with each turn carrying the row the panel
 * draws for it. Six turns, six rows, and the panel counts them rather than being told a number.
 */
function scriptedTurns(rules: CoachAgentPreviewRules): readonly PreviewTurn[] {
  return [
    {
      from: "lead",
      id: "keyword",
      text: "CCA",
      trace: {
        detail: "8s to answer",
        tone: "grey",
        what: "Matched your keyword CCA on Instagram",
      },
    },
    {
      from: "agent",
      id: "purpose",
      text: "Hey, good to connect. What's the funding for, running a business or launching one?",
      trace: {
        detail: "question 1 of 4",
        tone: "grey",
        what: "Asked what the funding is for",
      },
    },
    {
      from: "lead",
      id: "detail",
      text:
        "Launching a mobile detailing business. About $60k for the van and gear, and I want to "
        + "move now.",
      trace: {
        detail: "3 of 4 answered",
        tone: "grey",
        what: "Read purpose, amount and timeline out of one message",
      },
    },
    {
      from: "agent",
      id: "score",
      text: "Got it. Do you know your credit score roughly?",
      trace: {
        detail: "question 4 of 4",
        tone: "grey",
        what: "Asked for a rough credit score",
      },
    },
    {
      from: "lead",
      id: "answer",
      text: "Around 720.",
      trace: rulesRow(rules),
    },
    {
      caption: "replied in 8 seconds",
      from: "agent",
      id: "times",
      text: "That works. Reid has Wed 10:00, Wed 3:30 and Thu 9:00 open. Which one?",
      trace: {
        detail: "3 slots, none invented",
        tone: "good",
        what: "Offered three open times from the calendar you connected",
      },
    },
  ];
}

/**
 * The row a real turn gets, built from its receipt.
 *
 * Every field here is something the route reported: the stage it ended in, the rule it fired, the
 * passages it retrieved. Nothing is inferred from the reply text, because a sentence that reads
 * like a booking and a turn the engine recorded as a booking are different facts and only the
 * second one is a receipt.
 */
function liveTraceRow(receipt: TestAgentTurnReceipt): TraceRow {
  const { turn } = receipt;
  const passages = receipt.trace.sourceIds.length;
  const detail = turn.ruleFired
    ? turn.ruleFired
    : passages > 0
      ? `${passages} from The Brain`
      : "no rule fired";

  if (turn.stage === "guardrail") {
    return { detail, tone: "amber", what: "Held the reply rather than answering" };
  }
  if (turn.stage === "book") {
    return { detail, tone: "good", what: "Offered times from the calendar you connected" };
  }
  if (turn.stage === "closing") {
    return { detail, tone: "grey", what: "Closed the conversation" };
  }
  return {
    detail,
    tone: "grey",
    what: turn.grounded
      ? "Answered from The Brain and kept qualifying"
      : "Asked a qualifying question",
  };
}

/* ------------------------------------------------------------------ *
 * Every sentence this screen used to print under a heading
 * ------------------------------------------------------------------ */

const EYE_COPY = [
  "Both sides of the playback conversation are written: the lead and the replies.",
  "What comes from your own setup is the rules it checks, read from your agent page.",
  "Nothing on this screen reaches anyone, and none of it counts in your numbers.",
  "Try it yourself runs a real turn against your own configured agent, with no lead send, no",
  "calendar entry and no billing effect. Your real conversations are in your inbox.",
].join(" ");

/* ------------------------------------------------------------------ *
 * Shape
 * ------------------------------------------------------------------ */

const MONO_CLASS = "font-mono font-medium tracking-[-0.05em]";

const PHONE_CLASS = [
  "flex w-[390px] max-w-full flex-col overflow-hidden rounded-[32px]",
  "border border-[var(--line)]",
  "bg-[linear-gradient(180deg,var(--card-top),var(--card))]",
  "shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_1px_2px_rgba(28,42,82,0.04),0_18px_40px_-22px_rgba(28,42,82,0.35)]",
].join(" ");

const PANEL_CLASS = [
  "flex min-w-0 flex-col overflow-hidden rounded-[24px_24px_17px_17px]",
  "border border-[var(--line)]",
  "bg-[linear-gradient(180deg,var(--card-top),var(--card))]",
  "shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_1px_2px_rgba(28,42,82,0.04),0_8px_20px_-14px_rgba(28,42,82,0.16)]",
].join(" ");

const QUIET_BUTTON_CLASS = [
  "inline-flex h-[46px] shrink-0 items-center justify-center gap-[8px] rounded-[12px]",
  "border border-[var(--line-input)] bg-[var(--control-fill)] px-[20px] text-[16px]",
  "leading-none font-medium text-[color:var(--body)] no-underline",
  "hover:border-[var(--accent-edge)] hover:text-[color:var(--ink)]",
].join(" ");

const PRIMARY_BUTTON_CLASS = [
  "inline-flex h-[56px] flex-1 items-center justify-center gap-[10px] rounded-[12px]",
  "border border-[var(--accent-line)] bg-[var(--accent-fill)] px-[20px] text-[17px]",
  "leading-none font-semibold text-[color:var(--on-accent)] no-underline",
].join(" ");

const SECONDARY_BUTTON_CLASS = [
  "inline-flex h-[56px] flex-1 items-center justify-center gap-[10px] rounded-[12px]",
  "border border-[var(--line-input)] bg-[var(--control-fill)] px-[20px] text-[17px]",
  "leading-none font-medium text-[color:var(--body)] no-underline",
  "hover:border-[var(--accent-edge)] hover:text-[color:var(--ink)]",
].join(" ");

const DOT_TONE: Record<TraceTone, string> = {
  amber: "bg-[var(--warning)]",
  good: "bg-[var(--good)]",
  grey: "bg-[rgba(60,90,150,0.3)]",
};

const DETAIL_TONE: Record<TraceTone, string> = {
  amber: "text-[color:var(--warning-text)]",
  good: "text-[color:var(--good-text)]",
  grey: "text-[color:var(--faint)]",
};

/** How long each bubble waits before the next arrives. `coach-agent-preview.tsx`'s cadence. */
const TURN_DELAY_MS = 900;

/* ------------------------------------------------------------------ *
 * The screen
 * ------------------------------------------------------------------ */

export type RehaulMeetAgentProps = {
  /** The coach's first name, when the shell knows one. Display only. */
  coachName?: string | null;
  rules?: CoachAgentPreviewRules;
};

export function RehaulMeetAgent({
  coachName,
  rules = { creditFloor: null, minimumRaiseCents: null },
}: RehaulMeetAgentProps) {
  const script = useMemo(() => scriptedTurns(rules), [rules]);

  /*
   * The playback starts complete rather than at zero. A conversation that types itself out on
   * arrival makes a coach wait to read a page they did not ask to watch, and it delivers the same
   * text in pieces to anyone reading with a screen reader. "Play it again" is the opt-in.
   */
  const [shown, setShown] = useState(script.length);
  const [live, setLive] = useState<readonly PreviewTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<string | null>(null);
  const timers = useRef<number[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const clearTimers = useCallback(() => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current = [];
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const replay = useCallback(() => {
    clearTimers();
    setLive([]);
    setError(null);
    /*
     * A reader who asked their system for less motion gets the whole conversation at once. The
     * button still does something -- it clears any live turns and returns the screen to the
     * demonstration -- but the something is the end state rather than six staggered arrivals.
     */
    const reduced =
      typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setShown(script.length);
      return;
    }
    setShown(1);
    for (let turn = 2; turn <= script.length; turn += 1) {
      timers.current.push(
        window.setTimeout(() => setShown(turn), TURN_DELAY_MS * (turn - 1)),
      );
    }
  }, [clearTimers, script.length]);

  const turns = useMemo(
    () => [...script.slice(0, shown), ...live],
    [live, script, shown],
  );

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [turns.length]);

  /**
   * One real turn against this coach's own agent, through the route the admin sandbox already
   * uses. The session is created on the first send rather than on mount: a page that opens a
   * server session for every reader who never types is a request nobody asked for.
   */
  const send = useCallback(async (message: string) => {
    const text = message.trim();
    if (!text || sending) return;

    setSending(true);
    setError(null);
    setShown(script.length);
    clearTimers();
    setLive((current) => [
      ...current,
      {
        from: "lead",
        id: `lead-${current.length}-${text.slice(0, 12)}`,
        text,
        trace: { detail: "your message", tone: "grey", what: "You typed as the lead" },
      },
    ]);
    setDraft("");

    try {
      if (!sessionRef.current) {
        const started = await fetch("/api/agent", { headers: { Accept: "application/json" } });
        const payload: unknown = await started.json();
        if (
          !started.ok || !payload || typeof payload !== "object"
          || !("sessionId" in payload) || typeof payload.sessionId !== "string"
        ) {
          throw new Error("A test session could not be started, so nothing was sent.");
        }
        sessionRef.current = payload.sessionId;
      }

      const response = await fetch("/api/agent", {
        body: JSON.stringify({ message: text, sessionId: sessionRef.current }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload: unknown = await response.json();
      if (
        !response.ok || !payload || typeof payload !== "object"
        || !("state" in payload) || payload.state !== "persisted"
        || !("turn" in payload) || !payload.turn
      ) {
        throw new Error("Your agent did not return a confirmed turn, so nothing was recorded.");
      }
      const receipt = payload as TestAgentTurnReceipt;
      setLive((current) => [
        ...current,
        {
          from: "agent",
          id: receipt.agentMessageId,
          text: receipt.turn.reply,
          trace: liveTraceRow(receipt),
        },
      ]);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Your agent could not be reached, so nothing was recorded.",
      );
    } finally {
      setSending(false);
    }
  }, [clearTimers, script.length, sending]);

  const leadName = coachName ? `${coachName}'s sample lead` : "Jasmine Torres";
  const playing = shown < script.length;

  return (
    <div className="relative flex min-w-0 flex-col" data-slot="rehaul-meet-agent">
      <div className="flex flex-wrap items-end gap-[24px]">
        <div className="min-w-0">
          <h1 className="m-0 text-[46px] leading-[1.05] font-semibold tracking-[-0.025em] text-[color:var(--ink)]">
            Meet your agent
          </h1>
          <div className="mt-[10px] flex flex-wrap gap-[20px] text-[16px] text-[color:var(--muted)]">
            <span className="flex items-center gap-[8px]">
              <span aria-hidden className="size-[8px] flex-[0_0_8px] rounded-full bg-[var(--warning)]" />
              {live.length > 0 ? "Your message, your agent's reply" : "Sample lead, written both sides"}
            </span>
            <span className="flex items-center gap-[8px]">
              <span aria-hidden className="size-[8px] flex-[0_0_8px] rounded-full bg-[rgba(60,90,150,0.3)]" />
              Nothing sent, nothing counted
            </span>
          </div>
        </div>
        <button
          className={cn(QUIET_BUTTON_CLASS, "ml-auto")}
          onClick={replay}
          type="button"
        >
          <RefreshCw aria-hidden className="size-[18px]" strokeWidth={2} />
          Play it again
        </button>
      </div>

      <div className="mt-[28px] grid min-w-0 items-start gap-[44px] lg:grid-cols-[390px_minmax(0,1fr)]">
        <section aria-label="Sample conversation" className={PHONE_CLASS}>
          <div className="flex h-[72px] flex-[0_0_72px] items-center gap-[12px] border-b border-[var(--line)] bg-[var(--well)] px-[20px]">
            <span
              aria-hidden
              className={cn(
                "flex size-[40px] flex-none items-center justify-center rounded-full",
                "border border-[var(--accent-edge)] bg-[var(--accent-wash)]",
                "text-[14px] text-[color:var(--accent-text)]",
                MONO_CLASS,
              )}
            >
              JT
            </span>
            <span className="min-w-0">
              <span className="block text-[16px] leading-[1.3] font-semibold text-[color:var(--ink)]">
                {leadName}
              </span>
              <span className="flex items-center gap-[7px] text-[14px] text-[color:var(--faint)]">
                Instagram
                <span className={MONO_CLASS}>CCA</span>
              </span>
            </span>
            <MoreVertical
              aria-hidden
              className="ml-auto size-[18px] text-[color:var(--faint)]"
              strokeWidth={2}
            />
          </div>

          <div
            className="flex min-h-[430px] flex-1 flex-col gap-[11px] overflow-y-auto px-[18px] pt-[18px] pb-[8px] text-[15px]"
            ref={scrollRef}
          >
            <span className={cn("self-center text-[14px] text-[color:var(--faint)]", MONO_CLASS)}>
              Tue 2 Sept
            </span>
            {turns.map((turn) => (
              <div
                className={turn.from === "lead" ? "flex flex-col items-start" : "flex flex-col items-end"}
                key={turn.id}
              >
                <p
                  className={cn(
                    "m-0 px-[15px] py-[11px] leading-[1.45]",
                    turn.from === "lead"
                      ? "max-w-[78%] rounded-[18px_18px_18px_6px] border border-[var(--line)] bg-[var(--well)] text-[color:var(--body)]"
                      : "max-w-[84%] rounded-[18px_18px_6px_18px] bg-[var(--ink)] text-[color:var(--card)]",
                  )}
                  data-turn={turn.from}
                >
                  {turn.text}
                </p>
                {turn.caption ? (
                  <span className={cn("mt-[6px] text-[14px] text-[color:var(--faint)]", MONO_CLASS)}>
                    {turn.caption}
                  </span>
                ) : null}
              </div>
            ))}
            {sending ? (
              <span className={cn("self-end text-[14px] text-[color:var(--faint)]", MONO_CLASS)}>
                your agent is answering
              </span>
            ) : null}
            {error ? (
              <p className="m-0 self-center text-[14px] text-[color:var(--warning-text)]">{error}</p>
            ) : null}
          </div>

          <form
            className="flex h-[68px] flex-[0_0_68px] items-center gap-[10px] border-t border-[var(--line)] bg-[var(--well)] px-[18px]"
            onSubmit={(event) => {
              event.preventDefault();
              void send(draft);
            }}
          >
            <label className="sr-only" htmlFor="rehaul-meet-agent-composer">
              Type as the lead
            </label>
            <input
              autoComplete="off"
              className="h-[44px] min-w-0 flex-1 rounded-full border border-[var(--line-input)] bg-[var(--card)] px-[16px] text-[15px] text-[color:var(--ink)] placeholder:text-[color:var(--faint)]"
              disabled={sending}
              id="rehaul-meet-agent-composer"
              maxLength={800}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Type as the lead"
              ref={inputRef}
              value={draft}
            />
            <button
              aria-label="Send as the lead"
              className="inline-flex size-[44px] flex-[0_0_44px] items-center justify-center rounded-full border border-[var(--accent-line)] bg-[var(--accent-fill)] text-[color:var(--on-accent)] disabled:opacity-60"
              disabled={sending || !draft.trim()}
              type="submit"
            >
              <ArrowRight aria-hidden className="size-[18px]" strokeWidth={2} />
            </button>
          </form>
        </section>

        <div className="flex min-w-0 flex-col gap-[16px]">
          <section aria-labelledby="rehaul-meet-agent-trace" className={cn(PANEL_CLASS, "flex-1")}>
            <div className="flex min-h-[78px] items-center gap-[12px] border-b border-[var(--line)] px-[20px] py-[19px]">
              <span className="min-w-0">
                <span className="block text-[14px] text-[color:var(--muted)]">Turn by turn</span>
                <span
                  className="block text-[17px] leading-[1.3] font-semibold tracking-[-0.01em] text-[color:var(--ink)]"
                  id="rehaul-meet-agent-trace"
                >
                  What your agent did
                </span>
              </span>
              <span className={cn("ml-auto text-[14px] text-[color:var(--faint)]", MONO_CLASS)}>
                {`${turns.length} turns`}
              </span>
            </div>
            <ol className="m-0 flex list-none flex-col p-0">
              {turns.map((turn, index) => (
                <li
                  className="flex min-h-[var(--coach-target,44px)] flex-1 flex-wrap items-center gap-[16px] border-b border-[var(--line-soft)] px-[24px] py-[14px] last:border-b-0"
                  key={turn.id}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-[8px] flex-[0_0_8px] rounded-full",
                      DOT_TONE[turn.trace.tone],
                    )}
                  />
                  <span
                    className={cn(
                      "w-[64px] flex-[0_0_64px] text-[14px] text-[color:var(--faint)]",
                      MONO_CLASS,
                    )}
                  >
                    {`Turn ${index + 1}`}
                  </span>
                  <span className="min-w-0 flex-1 text-[16px] text-[color:var(--body)]">
                    {turn.trace.what}
                  </span>
                  <span
                    className={cn("text-[14px]", MONO_CLASS, DETAIL_TONE[turn.trace.tone])}
                  >
                    {turn.trace.detail}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <div className="flex flex-wrap gap-[12px]">
            <button
              className={PRIMARY_BUTTON_CLASS}
              onClick={() => inputRef.current?.focus()}
              type="button"
            >
              Try it yourself
            </button>
            <Link className={SECONDARY_BUTTON_CLASS} href="/coach/agent">
              Go to your agent
            </Link>
          </div>
        </div>
      </div>

      {/* The playing state is announced rather than drawn: the header button is the only control
          that starts it, and a pill that appears beside a title the reader is already looking at
          adds a moving object to a screen whose whole job is to be watched somewhere else. */}
      <p aria-live="polite" className="sr-only">
        {playing ? "Playing the sample conversation." : "The sample conversation is complete."}
      </p>

      <ContextEye copy={EYE_COPY} screen="meet-agent" />
    </div>
  );
}
