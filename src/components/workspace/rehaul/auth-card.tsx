import type { ReactNode } from "react";

import { CoachScale } from "@/components/coach-scale";

/**
 * The entry surface of the rehaul: one 440px card, centred on the canvas, with the mark above it.
 *
 * `Login.body.html` and `Signup.body.html` draw the same object twice -- a lockup, then a hero deck
 * panel whose header band carries the page's `<h1>` at the coach page-title size, then the fields.
 * The old `AuthStage` stacked a 468px column from the top of the viewport and set the title at
 * 28px inside the band; the artboards centre a narrower card and let the title run at the coach
 * scale, so the first thing anyone reads is the same size as the greeting they meet on the other
 * side of the door.
 *
 * The panel classes are `coach.css`'s, not this file's: `coach-panel[data-hero]` is where the
 * 30/30/17/17 corner lives and `coach-page-title` is where 46px (30px under 640px) lives. Only the
 * two paddings the artboards move off the deck defaults are inline, for the reason `AuthPanel`
 * records at length -- `coach.css` is unlayered, so a Tailwind padding utility on
 * `.coach-panel__header` would lose to it silently.
 *
 * `min-h-svh` with `justify-center` rather than a fixed height: the signup card is taller than a
 * short viewport, and a centred flex child that overflows its container is unreachable above the
 * fold. With height left to `auto` the container simply grows and the page scrolls.
 */
export function AuthCard({
  above,
  below,
  children,
  title,
}: {
  /** Notices that describe the attempt, between the mark and the card. */
  above?: ReactNode;
  /** The quiet cross-link under the card. */
  below?: ReactNode;
  children: ReactNode;
  title: string;
}) {
  return (
    <CoachScale
      as="main"
      className="relative flex min-h-svh flex-col items-center justify-center bg-[var(--canvas)] px-[var(--s-4)] py-[var(--s-8)] text-[color:var(--body)] sm:px-[var(--s-6)]"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ backgroundImage: "var(--pane-bloom)" }}
      />
      <div className="relative flex w-full max-w-[440px] flex-col gap-[22px]">
        <AuthMark />
        {above}
        <section className="coach-panel" data-hero="true">
          <header
            className="coach-panel__header"
            style={{ minHeight: 0, padding: "24px 30px" }}
          >
            <h1 className="coach-page-title m-0 min-w-0">{title}</h1>
          </header>
          {/* `@container` so the two-up rows inside measure the card, not the viewport. */}
          <div className="coach-panel__body @container gap-[18px]" style={{ padding: "28px 30px 30px" }}>
            {children}
          </div>
        </section>
        {below}
      </div>
    </CoachScale>
  );
}

/**
 * The mark and the name. Identity rather than a heading, so a `<p>`: the `<h1>` on these screens is
 * what the page is for, and it lives in the card's header band.
 */
function AuthMark() {
  return (
    <p className="m-0 flex items-center gap-[var(--s-3)]" data-slot="auth-wordmark">
      <span className="grid size-[38px] shrink-0 place-items-center rounded-[10px] border border-[var(--accent-edge)] bg-[var(--accent-wash)] text-[color:var(--accent-text)]">
        <svg
          aria-hidden="true"
          fill="none"
          height="20"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.75"
          viewBox="0 0 24 24"
          width="20"
        >
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        </svg>
      </span>
      <span className="text-[20px] font-[600] tracking-[-0.014em] text-[color:var(--ink)]">
        SetterFi
      </span>
    </p>
  );
}

/** The submit both cards draw: full width, 56px, the page's one accent fill. */
export const AUTH_SUBMIT_CLASS = "h-[56px] w-full text-[18px]";

/**
 * The 48px field shell the artboards draw, against the kit's 34px console default.
 *
 * Applied to the form rather than to each control because `PasswordField` owns its own `KitInput`
 * and takes no class of its own -- reaching its shell from outside is what keeps the reveal button
 * and its live region exactly as they already are, which is the half of that component nobody
 * should be re-implementing for a new skin.
 */
export const AUTH_FIELDS_CLASS =
  "[&_[data-slot=field-shell]]:h-[48px] [&_[data-slot=field-shell]]:rounded-[10px] [&_[data-slot=field-shell]]:px-[14px] [&_[data-slot=kit-input]]:text-[16px]";
