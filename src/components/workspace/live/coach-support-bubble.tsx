"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { ACCENT_FILL_SHADOW_CLASS } from "@/components/kit/atomics/button-class";
import { ChatIcon, ChevronRight, X } from "@/components/kit/icons";
import { COACH_SURFACE_TITLE_CLASS } from "@/components/workspace/live/coach-type";

/**
 * One of the three questions the panel opens with.
 *
 * `href` rather than an answer body, and that is the load-bearing decision in this file. The
 * artboard draws three questions with chevrons and no answers, and the tempting reading is that
 * the bubble should expand each one into a paragraph. It must not, for two reasons that both
 * point the same way.
 *
 * The first is the honest-states rule. "When will texting start working?" has exactly one true
 * answer -- the elapsed day count on this coach's own A2P registration -- and that number lives
 * on the setup screen, computed by `DayCounter` from the registration's real start time. A
 * paragraph inside a floating panel would either restate a number it cannot see or, far worse,
 * offer the reassuring sentence a coach wants ("about a week to go"), which is the predicted date
 * the product is forbidden from printing. Linking to the screen that owns the counter is the only
 * version of this answer that cannot go stale or lie.
 *
 * The second is that answers written here would be a fourth place the product explains itself,
 * after the screens, the trainings, and the support thread. Three of those already have owners.
 */
export type CoachSupportQuestion = {
  /** Stable across renders; used as the React key and in the link's own test hook. */
  id: string;
  /** The question in the coach's words, not ours. Sentence case, ends in a question mark. */
  question: string;
  /** The screen that actually answers it. */
  href: string;
};

/**
 * The three questions the artboard names, pointed at the screens that own their answers.
 *
 * They are a default rather than a hard-coded list because "what other coaches ask most" is a
 * claim about a population, and the population will tell us it is wrong. A caller -- the shell
 * today, a ranked query later -- replaces the array without touching this component.
 */
export const COACH_SUPPORT_DEFAULT_QUESTIONS: readonly CoachSupportQuestion[] = [
  {
    id: "turned-away",
    question: "Why did my agent turn a lead away?",
    href: "/coach/agent",
  },
  {
    // Answered by the setup screen's day counter, never by a sentence in this panel. See the
    // note on `CoachSupportQuestion` for why that distinction is a product rule and not taste.
    id: "texting",
    question: "When will texting start working?",
    href: "/coach/get-started",
  },
  {
    id: "pricing",
    question: "How do I change what I charge?",
    href: "/coach/agent",
  },
];

export type CoachSupportBubbleProps = {
  /**
   * The coach's first name, so the panel opens with "Need a hand, Marcus?". Omitted -- and it will
   * be omitted, because a workspace can be opened by a team member whose own name we do not have
   * on this render -- the heading falls back to "Need a hand?" rather than to a placeholder name.
   * A greeting addressed to the wrong person is worse than a greeting addressed to nobody.
   */
  coachName?: string;
  /** Defaults to `COACH_SUPPORT_DEFAULT_QUESTIONS`. */
  questions?: readonly CoachSupportQuestion[];
  /** Where "Message a person" goes. The support thread list, which is the real channel. */
  helpHref?: string;
  /** Where "Tips and trainings" goes. */
  tipsHref?: string;
  /** Opens mounted. For a screen that arrives from "get help" and for tests; not a shell prop. */
  defaultOpen?: boolean;
  className?: string;
};

/*
 * The coach scale, restated locally the way `coach-billing.tsx` does it.
 *
 * The bubble is drawn at the coach's sizes -- 20px panel name, 17px questions, 16px body -- and
 * every pressable thing in it clears 44px without relying on `coach.css` to stretch it, because
 * this component is explicitly designed to be mountable outside a `[data-shell-role="coach"]`
 * subtree if the shell ever moves it. A control whose target only exists because an ancestor
 * stylesheet raised its `min-height` is a control that breaks silently when it is re-parented.
 */
const QUESTION_CLASS =
  "flex min-h-[60px] w-full items-center gap-[14px] rounded-[12px] px-[14px] py-[12px] text-[17px] leading-[1.35] font-medium text-[color:var(--ink)] no-underline outline-none hover:bg-[var(--row-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]";
/*
 * The one accent fill the open bubble spends. The launcher takes it while the panel is shut and
 * gives it up the moment the panel opens -- see the note on `LauncherIcon` below -- so whichever
 * state the bubble is in, a reader is looking at exactly one filled thing.
 */
const ACCENT_FILL_CLASS =
  /* 11px, which is `CoachSupportBubble.dc.html:223` and one pixel off the 12px the question rows
     above it take (`:208`). The difference is deliberate in the drawing -- the rows sit inside the
     panel's 10px padding and the button spans the footer edge to edge -- and it is the only radius
     in this component that had drifted; the panel's `22px 22px 16px 16px`, the rows' 12px and the
     launcher's full round all match. Kept as a literal beside them rather than tokenised, because
     a one-pixel relationship between two adjacent shapes is what the artboard is saying. */
  "inline-flex h-[52px] w-full items-center justify-center gap-[11px] rounded-[11px] border border-[var(--accent-line)] [background:var(--accent-fill)] text-[17px] leading-none font-semibold text-[color:var(--on-accent)] no-underline" +
  ` ${ACCENT_FILL_SHADOW_CLASS}`;

export function CoachSupportBubble({
  className,
  coachName,
  defaultOpen = false,
  helpHref = "/coach/help",
  questions = COACH_SUPPORT_DEFAULT_QUESTIONS,
  tipsHref = "/coach/tips",
}: CoachSupportBubbleProps) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const headingId = useId();
  const launcherRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  /*
   * Whether the last close should hand focus back. A close the coach asked for -- Escape, the X,
   * a click outside -- must return the caret to the launcher, or a keyboard user is dropped at
   * the top of the document. A bubble that was simply never opened must not steal focus on mount,
   * which is what an unconditional "focus the launcher on close" effect would do.
   */
  const returnFocusRef = useRef(false);

  const close = useCallback(() => {
    returnFocusRef.current = true;
    setOpen(false);
  }, []);

  /*
   * Escape on the document rather than on the panel, because the panel is deliberately not a
   * focus trap: it is a non-modal helper floating over a page the coach can keep reading and
   * clicking. Focus can therefore legitimately be outside it while it is open, and an Escape
   * handler bound to the panel would simply not fire in that case.
   */
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close, open]);

  /*
   * A pointer press anywhere else closes it, which is what every reader expects of a thing that
   * floats over the page. `pointerdown` rather than `click` so the panel is gone before the press
   * lands on whatever is underneath, and so a press that starts inside and drags out does not
   * count as leaving.
   */
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (launcherRef.current?.contains(target)) return;
      close();
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [close, open]);

  /* Focus the panel itself on open, and the launcher again on a close the coach asked for. */
  useEffect(() => {
    if (open) {
      panelRef.current?.focus();
      return;
    }
    if (returnFocusRef.current) {
      returnFocusRef.current = false;
      launcherRef.current?.focus();
    }
  }, [open]);

  const heading = coachName ? `Need a hand, ${coachName}?` : "Need a hand?";

  return (
    <div
      /*
       * The artboard's 40/32 offsets, but only from `sm` up. Below it the coach's five
       * destinations are a `fixed` 56px tab bar on the bottom edge (`coach-pillbar.tsx`), and a
       * launcher at 24px from the bottom lands on top of Leads. The phone offset clears the bar,
       * its own safe-area inset, and 16px of air -- the same expression `<main>` pads with in
       * `app-shell.tsx`, so the two stay in step if the bar's height moves.
       */
      className={`fixed right-[20px] bottom-[calc(56px+16px+env(safe-area-inset-bottom))] z-50 flex flex-col items-end gap-[16px] sm:right-[40px] sm:bottom-[32px] ${className ?? ""}`}
      data-slot="coach-support-bubble"
    >
      {open ? (
        <div
          aria-labelledby={headingId}
          className={[
            "w-[min(380px,calc(100vw-48px))] overflow-hidden rounded-[22px_22px_16px_16px]",
            "border border-[var(--line)] bg-[linear-gradient(180deg,var(--card-top),var(--card))]",
            /*
             * `--shadow-raised`, not the hand-typed 90%-black recipe this panel shipped with. That
             * literal was authored against the near-black pane; the light palette landed in
             * `39f0cae` and a 64px blur of 90% black under a floating panel on a near-white page
             * is a grey smudge rather than a lift. The token carries a tuned value in both
             * palettes, and this is the one panel in the lane with no card behind it to hide the
             * difference.
             */
            "shadow-[var(--shadow-raised)] outline-none",
            /*
             * The one animation, and it is opt-in rather than opt-out: the keyframes only exist
             * inside `motion-safe`, so a reader who has asked their system for less motion gets a
             * panel that is simply there, with no `animation` property to override.
             */
            "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-[var(--duration-quick)]",
          ].join(" ")}
          data-slot="coach-support-panel"
          id={panelId}
          ref={panelRef}
          role="dialog"
          tabIndex={-1}
        >
          <div className="border-b border-[var(--line)] px-[22px] py-[20px]">
            <h2 className={COACH_SURFACE_TITLE_CLASS} id={headingId}>{heading}</h2>
            <p className="m-0 mt-[4px] text-[16px] leading-[1.5] text-[color:var(--muted)]">
              Start with what other coaches ask most.
            </p>
          </div>

          <nav aria-label="Common questions" className="flex flex-col p-[10px]">
            {questions.map((item, index) => (
              <Link
                className={`${QUESTION_CLASS}${index > 0 ? " border-t border-[var(--line-soft)]" : ""}`}
                data-question={item.id}
                href={item.href}
                key={item.id}
                onClick={close}
              >
                <span className="min-w-0 flex-1">{item.question}</span>
                <ChevronRight className="text-[color:var(--faint)]" size={18} />
              </Link>
            ))}
          </nav>

          <div className="flex flex-col gap-[14px] border-t border-[var(--line)] px-[18px] pt-[16px] pb-[18px]">
            <Link className={ACCENT_FILL_CLASS} href={helpHref} onClick={close}>
              <ChatIcon size={19} />
              Message a person
            </Link>
            {/*
              The artboard puts "Someone replies within the hour" beside this link. It is not here,
              and its absence is deliberate: that sentence is a support commitment, and nothing in
              the codebase or the copy files records one -- no SLA, no first-response target, no
              staffed-hours window. Printing it would be the product promising on behalf of a
              support team that has never agreed to it, which is the same class of mistake as a
              predicted A2P date. It goes back in the day someone writes the real number down.
            */}
            <Link
              className="inline-flex min-h-[44px] items-center text-[16px] leading-[1.4] font-medium text-[color:var(--accent-text)] no-underline hover:underline"
              href={tipsHref}
              onClick={close}
            >
              Tips and trainings
            </Link>
          </div>
        </div>
      ) : null}

      <button
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={open ? "Close help" : "Get help"}
        className={[
          "inline-flex h-[60px] w-[60px] items-center justify-center rounded-[var(--r-full)]",
          /*
             Open, the launcher is a plain close control on the well face; shut, it carries the
             accent fill. That swap is what keeps the One Fill Rule true in both states: with the
             panel open, "Message a person" is the verb, and a second filled circle two inches
             below it would split the emphasis between the action and the thing that dismisses it.
           */
          open
            ? "border border-[var(--line)] bg-[var(--well)] text-[color:var(--body)] hover:border-[var(--accent-edge)] hover:text-[color:var(--ink)]"
            : `border border-[var(--accent-line)] [background:var(--accent-fill)] text-[color:var(--on-accent)] ${ACCENT_FILL_SHADOW_CLASS}`,
        ].join(" ")}
        data-slot="coach-support-launcher"
        onClick={() => (open ? close() : setOpen(true))}
        ref={launcherRef}
        type="button"
      >
        {open ? <X size={24} /> : <ChatIcon size={24} />}
      </button>
    </div>
  );
}
