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
 * The step the reader is standing on, derived from the evidence rather than from the route.
 *
 * The go-live screen passed a hard-coded `current="go_live"`, so the strip drew "you are here" on
 * step four while steps one to three read "(still to do)" -- a rail claiming the coach had walked
 * a path it was simultaneously saying they had not walked. Position in the flow is not evidence of
 * progress through it, and the only honest reading of a strip is the first step nobody has proved.
 *
 * `go_live` is the fallback because it is the last step: once every earlier step is proved, the
 * final action is genuinely where the reader is.
 */
export function currentSetupStep(completed: readonly SetupStepKey[]): SetupStepKey {
  const done = new Set(completed);
  return SETUP_STEP_KEYS.find((key) => !done.has(key)) ?? "go_live";
}

/**
 * The steps standing between the coach and the button, which is every unproved step except the
 * button itself. `go_live` is excluded because it is the action, not a thing to do first: counting
 * it would make "one step left" mean "nothing left but the press", which is the one sentence this
 * page already has a different line for.
 */
export function setupStepsRemaining(completed: readonly SetupStepKey[]): SetupStepKey[] {
  const done = new Set(completed);
  return SETUP_STEP_KEYS.filter((key) => key !== "go_live" && !done.has(key));
}

/** Small enough to spell. The list is four long, so the count before `go_live` never exceeds three. */
const REMAINING_IN_WORDS: Record<number, string> = { 2: "Two", 3: "Three" };

/**
 * The headline the go-live screen is entitled to, from the same evidence the strip is drawn from.
 *
 * The page shipped the artboard's "You are one button away from your agent answering" over a strip
 * whose first three boxes said "(still to do)", and the first repair only replaced it with a
 * cautious "Your agent is not answering yet" -- true, but it told a coach nothing about how far off
 * they were, which is the question the sentence is standing in the place of. So the sentence counts
 * instead: the reader learns their position from the headline and the strip at once, and the
 * readiness line is reachable only when the count reaches zero.
 */
export function setupHeadline(completed: readonly SetupStepKey[]): string {
  const remaining = setupStepsRemaining(completed).length;
  if (remaining === 0) return "You are one button away from your agent answering";
  if (remaining === 1) return "One step left before your agent answers";
  return `${REMAINING_IN_WORDS[remaining] ?? String(remaining)} steps before your agent answers`;
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
