import { CoachScale } from "@/components/coach-scale";
import { OnboardingMark } from "@/components/onboarding/step-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { ONBOARDING_STEP_COUNT } from "@/components/onboarding/setup-status";

/**
 * The setup steps' loading boundary, drawn as the step shell it is about to become.
 *
 * This file used to re-export the owner console's bare `Skeleton`, which is one grey bar with no
 * shell around it. Between two setup steps that rendered as the empty canvas with a single bone
 * on it: a whole screen going dark for the length of the server read, then the new step popping
 * in. So the bones are the step shell's own anatomy, in the shell's own positions: the top bar
 * with the real mark, the six-segment rail, the step line and title at their sizes, the panel at
 * the width the form arrives at, and the footer's button. The pane, its bloom and the hairlines
 * are all drawn, so the screen never loses its ground.
 *
 * The rail is all `--line` rather than guessing a position: the boundary renders before the route
 * knows which step it is.
 */
function Bone({ className }: { className: string }) {
  return <Skeleton aria-hidden className={`block bg-[var(--well)] ${className}`} />;
}

export default function OnboardingLoading() {
  return (
    <CoachScale
      as="main"
      className="flex min-h-svh flex-col bg-[var(--canvas)] text-[color:var(--body)]"
      style={{ backgroundImage: "var(--pane-bloom)" }}
    >
      <div className="flex h-[64px] flex-none items-center gap-[16px] border-b border-[var(--line)] bg-[var(--pane)] px-[var(--s-4)] sm:h-[76px] sm:gap-[32px] sm:px-[40px]">
        <OnboardingMark />
        <span className="mx-auto hidden text-[20px] font-[500] tracking-[-0.015em] text-[color:var(--ink)] sm:block">
          Setup
        </span>
        <Bone className="ml-auto h-[44px] w-[44px] rounded-[10px] sm:ml-0" />
      </div>

      <div
        aria-busy="true"
        className="mx-auto flex w-full flex-grow flex-col px-[var(--s-4)] pt-[24px] sm:px-[40px] sm:pt-[36px]"
        role="status"
        style={{ maxWidth: "860px" }}
      >
        <span className="sr-only">Loading this step.</span>

        <div aria-hidden="true" className="flex w-full gap-[6px]">
          {Array.from({ length: ONBOARDING_STEP_COUNT }, (_, index) => (
            <span className="h-[6px] flex-1 rounded-full bg-[var(--line)]" key={index} />
          ))}
        </div>

        <header className="mt-[20px] mb-[24px] flex flex-col sm:mt-[24px] sm:mb-[32px]">
          <Bone className="mb-[8px] h-[16px] w-[96px] rounded-[7px]" />
          <Bone className="mb-[12px] h-[34px] w-[min(100%,420px)] rounded-[10px] sm:h-[46px]" />
          <Bone className="h-[16px] w-[min(100%,560px)] rounded-[7px] sm:h-[17px]" />
        </header>

        <div className="flex flex-col gap-[20px] overflow-hidden rounded-[24px_24px_17px_17px] border border-[var(--line)] bg-[linear-gradient(180deg,var(--card-top),var(--card))] p-[22px_16px] shadow-[var(--shadow-card)] sm:p-[24px_20px]">
          <Bone className="h-[16px] w-[60%] rounded-[7px]" />
          {[0, 1, 2].map((row) => (
            <div className="flex flex-col gap-[6px]" key={row}>
              <Bone className="h-[16px] w-[140px] rounded-[7px]" />
              <Bone className="h-[48px] w-full rounded-[10px]" />
            </div>
          ))}
        </div>

        <div className="mt-[32px] mb-[40px] flex items-center gap-[24px]">
          <Bone className="h-[48px] w-[160px] rounded-[9px]" />
          <Bone className="h-[16px] w-[150px] rounded-[7px]" />
        </div>
      </div>
    </CoachScale>
  );
}
