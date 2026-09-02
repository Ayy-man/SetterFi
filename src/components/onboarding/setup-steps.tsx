import { TONE_LINE, TONE_TEXT, TONE_WASH } from "@/components/kit/atomics";

/**
 * The four steps of setup, and which one the coach is standing on.
 *
 * It exists because until now nothing told a coach that setup had a shape. They left `/signup`
 * into a seven-row readiness list with no indication that there were four things to do, which one
 * they were on, or how much was left -- the canvas draws this strip on all three onboarding
 * artboards and the code drew it on none of them.
 *
 * **A step is ticked only when the caller can prove it.** `completed` is evidence the page already
 * holds -- a live channel connection, a saved offer -- and never a guess derived from position in
 * the list. The wizard is not linear in the data: a coach can file their carrier details before
 * they name their programme, and a strip that ticked step one because the reader is looking at
 * step two would be the completion theatre `CLAUDE.md` forbids, in the one place a coach is most
 * likely to believe it. A step with no evidence renders as upcoming, whether it sits before or
 * after the current one.
 *
 * The steps are not links. Every destination here refuses a coach who has not reached it, so a
 * strip of four anchors would be three that bounce; the canvas draws them as a position readout,
 * which is what this is.
 */

export const SETUP_STEP_KEYS = ["connect", "offer", "meet", "go_live"] as const;
export type SetupStepKey = (typeof SETUP_STEP_KEYS)[number];

const SETUP_STEP_LABELS: Record<SetupStepKey, string> = {
  connect: "Connect channels",
  offer: "Tell us about your offer",
  meet: "Meet your agent",
  go_live: "Go live",
};

/**
 * The steps this strip will render as still-to-do, given the evidence its caller holds.
 *
 * It exists so a page's headline and its strip cannot disagree. The go-live screen carried the
 * artboard's "You are one button away from your agent answering" over a strip whose first three
 * boxes read "(still to do)", which is the completion theatre `CLAUDE.md` forbids in the one place
 * a coach is most likely to believe it -- and it could not have been caught by rewording, because
 * a softer sentence goes stale the same way the moment the evidence moves. Deriving the sentence
 * from this function means the only way the headline can claim readiness is for the strip to have
 * stopped saying otherwise.
 *
 * The current step is excluded because the reader is standing on it: a page cannot be waiting on
 * the thing it is. Everything else with no evidence counts, whether it sits before or after,
 * because the wizard is not linear in the data and position proves nothing.
 */
export function outstandingSetupSteps(
  completed: readonly SetupStepKey[],
  current: SetupStepKey,
): SetupStepKey[] {
  const done = new Set(completed);
  return SETUP_STEP_KEYS.filter((key) => key !== current && !done.has(key));
}

export type SetupStepsProps = {
  current: SetupStepKey;
  /** The steps this page has saved evidence for. Anything absent renders as still to do. */
  completed?: readonly SetupStepKey[];
};

export function SetupSteps({ completed = [], current }: SetupStepsProps) {
  const done = new Set(completed);

  return (
    <nav aria-label="Setup steps">
      <ol
        className="m-0 grid list-none grid-cols-1 gap-[var(--s-3)] rounded-[20px_20px_14px_14px] border border-[var(--line)] bg-[var(--well)] p-[10px] sm:grid-cols-2 lg:grid-cols-4"
        data-slot="setup-steps"
      >
        {SETUP_STEP_KEYS.map((key, index) => {
          const isCurrent = key === current;
          // A ticked step keeps its tick even while it is the current one: the coach may be
          // revisiting a step they already finished, and blanking the evidence to draw them as
          // "here" would take a true statement off the screen.
          const isDone = done.has(key);
          const tone = isDone ? "good" : "neutral";

          return (
            <li
              aria-current={isCurrent ? "step" : undefined}
              // `gap-[14px]` and no vertical padding are `OnboardingConnect.dc.html:81` exactly:
              // `gap: 14px; min-height: 64px; padding: 0 18px`. This carried `var(--s-3)` (12px)
              // and `py-[var(--s-2)]` (8px), and neither was visible, because the 64px floor is
              // taller than the row's content and `items-center` absorbs both. That is the reason
              // to fix them rather than to leave them: the floor is what hides the drift, so the
              // day the floor moves -- or a label wraps to two lines on a narrow column and the
              // row grows past 64px -- both wrong numbers become visible at once, in a place
              // nobody will think to look. The scale has no 14px step, so the gap is a literal;
              // `--s-3` and `--s-4` are 12 and 16, and rounding the drawing to either would be
              // choosing the token over the artboard.
              className="flex min-h-[64px] items-center gap-[14px] rounded-[13px] border px-[18px]"
              data-slot="setup-step"
              data-state={isDone ? "done" : isCurrent ? "current" : "upcoming"}
              key={key}
              style={
                isCurrent
                  ? {
                      background: "var(--accent-fill)",
                      borderColor: "var(--accent-line)",
                      color: "var(--on-accent)",
                    }
                  : {
                      background: isDone ? TONE_WASH[tone] : "transparent",
                      borderColor: isDone ? TONE_LINE[tone] : "transparent",
                      color: isDone ? TONE_TEXT[tone] : "var(--muted)",
                    }
              }
            >
              <span
                aria-hidden="true"
                className="grid size-[32px] shrink-0 place-items-center rounded-full border text-[15px] font-[500] font-mono tabular-nums"
                style={
                  isCurrent
                    ? { background: "rgba(255,255,255,0.2)", borderColor: "transparent" }
                    : isDone
                      ? { background: TONE_WASH[tone], borderColor: TONE_LINE[tone] }
                      : { background: "var(--control-fill)", borderColor: "var(--line)" }
                }
              >
                {isDone ? (
                  <svg
                    fill="none"
                    height="17"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                    width="17"
                  >
                    <path d="m5 13 4 4L19 7" />
                  </svg>
                ) : (
                  index + 1
                )}
              </span>
              <span className={`text-[17px] leading-[1.3] ${isCurrent ? "font-[600]" : "font-[500]"}`}>
                {SETUP_STEP_LABELS[key]}
              </span>
              {/* Said in words as well as in colour, because the tick and the fill are the only
                  things distinguishing the three states and neither reaches a screen reader. */}
              <span className="sr-only">
                {isDone ? " (done)" : isCurrent ? " (you are here)" : " (still to do)"}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
