import type { ReactNode } from "react";

import {
  Prose,
  StatusDot,
  TONE_LINE,
  TONE_TEXT,
  TONE_WASH,
  type Tone,
} from "@/components/kit/atomics";
import { CoachScale } from "@/components/coach-scale";
import { COACH_EYEBROW_CLASS } from "@/components/workspace/live/coach-type";
import { cn } from "@/lib/utils";

/**
 * The stage every unauthenticated surface stands on: `/`, `/login`, `/signup`, `/access` and both
 * halves of the password-recovery flow.
 *
 * Before this existed each of those five pages drew its own face, and `/` carried a second palette
 * outright: `landing.css` hardcoded the pre-redesign Electric Blue ramp -- ground, accent and ink
 * all as literals -- and reached for two `--sf-radius-*` variables that no longer exist anywhere in
 * the tree, so its cards had been rendering with square corners. The first thing anyone sees is now
 * built from the same tokens, the same surface recipes and the same type roles as the console they
 * are signing in to. `src/app/entry-surfaces.test.ts` is what keeps it that way.
 *
 * The ground is `--canvas` under `--pane-bloom`, which is the product's one restrained brand
 * moment and a background gradient rather than a shadow -- the page's glow budget stays unspent,
 * which matters because on these screens the thing worth noticing is the submit, not the backdrop.
 *
 * **The scale is the coach's, not the console's**, and `CoachScale` is what makes that reachable:
 * every rule in `coach.css` keys on an attribute `AppShell` stamps, and none of these pages renders
 * an `AppShell`. See that component for why the attribute is loaned rather than copied. In practice
 * it means 16px body, a 44px floor under every control, and the deck panel's asymmetric corners --
 * the same face the coach sees the moment they are through this door, which is the point.
 */
export function AuthStage({
  children,
  lockup = true,
  width = "narrow",
}: {
  children: ReactNode;
  /**
   * The wordmark above the column. `/` renders "SetterFi" as its own `<h1>` -- the role picker's
   * heading genuinely is the product's name -- so it opts out rather than carrying the mark twice.
   */
  lockup?: boolean;
  /** `narrow` is a single column of fields; `wide` is the signup form's two-column grid. */
  width?: "narrow" | "wide";
}) {
  return (
    <CoachScale
      as="main"
      className="relative min-h-svh bg-[var(--canvas)] px-[var(--s-4)] py-[var(--s-10)] text-[color:var(--body)] sm:px-[var(--s-6)]"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ backgroundImage: "var(--pane-bloom)" }}
      />
      <div
        className="@container relative mx-auto flex w-full flex-col gap-[28px]"
        style={{ maxWidth: width === "wide" ? "940px" : "468px" }}
      >
        {lockup ? <AuthLockup /> : null}
        {children}
      </div>
    </CoachScale>
  );
}

/**
 * The mark and the name, side by side.
 *
 * Identity rather than a heading, which is why it is a `<p>` and why it moved off `AuthHeader`:
 * three of these pages now carry their title inside a panel's header band instead, and the mark
 * has to sit above the panel in all of them. The tile is the accent's second and last appearance
 * on a sign-in screen; the submit button is the first.
 */
function AuthLockup() {
  return (
    <p className="m-0 flex items-center gap-[var(--s-3)]" data-slot="auth-wordmark">
      <span className="grid size-[38px] place-items-center rounded-[10px] border border-[var(--accent-edge)] bg-[var(--accent-wash)] text-[color:var(--accent-text)]">
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
      {/*
        One word in one colour, which is how every artboard draws it. The two-tone version put a
        second accent on a screen that already spends one on the mark beside it and one on the
        submit, and the accent reads as emphasis only while it stays scarce -- a wordmark is not
        emphasis, it is the name of the place.
      */}
      <span className="text-[20px] font-[600] tracking-[-0.014em] text-[color:var(--ink)]">
        SetterFi
      </span>
    </p>
  );
}

/**
 * A page-level header: the eyebrow, the `<h1>`, and one sentence under it.
 *
 * Used where the title belongs to the page rather than to a single panel -- /signup, where two
 * panels follow it, and the three recovery surfaces, which are one short form each. /login uses
 * `AuthPanel` instead, because there the title and the form are one object.
 *
 * The eyebrow is `COACH_EYEBROW_CLASS`, sentence case, which is `--coach-eyebrow` -- 14px. It was
 * a 9.5px uppercase mono `Overline`, which is the worst legibility case in the product and had no
 * business being the first type a coach over 55 reads; it was then a hardcoded `text-[12px]`,
 * which is the exact drift `COACH_EYEBROW_CLASS` was created to make structurally impossible, and
 * this file kept it because the type-floor ratchet only walks modules a coach *route* reaches and
 * an entry surface is reached from `/signup` instead. The token resolves here because every
 * `AuthHeader` caller renders inside `AuthStage`, which mounts `CoachScale` and therefore
 * `[data-shell-role="coach"]`, where `--coach-eyebrow` is declared.
 *
 * The `<h1>` is what the page is actually for: the old pages made "SetterFi" the `<h1>` on all four
 * surfaces, so a screen reader heard the same heading on the login page, the signup page and the
 * access gate.
 */
export function AuthHeader({
  align = "start",
  eyebrow,
  subline,
  title,
}: {
  /** `center` is the signup artboard's shape: a 46px title over a centred sentence. */
  align?: "start" | "center";
  eyebrow?: string;
  subline?: ReactNode;
  title: string;
}) {
  return (
    <header
      className={cn(
        "flex flex-col gap-[var(--s-2)]",
        align === "center" ? "items-center text-center" : "items-start",
      )}
    >
      {eyebrow ? <p className={`m-0 ${COACH_EYEBROW_CLASS}`}>{eyebrow}</p> : null}
      <h1 className="coach-page-title m-0">{title}</h1>
      {subline ? (
        <Prose
          className="text-[17px] leading-[1.5] text-[color:var(--muted)]"
          measure={align === "center" ? "tight" : "prose"}
        >
          {subline}
        </Prose>
      ) : null}
    </header>
  );
}

/**
 * The deck panel, carrying a page's whole reason for existing: a header band with the eyebrow and
 * the `<h1>`, then the form.
 *
 * This is the login artboard's shape and it is one object rather than two on purpose -- a header
 * floating above a separate card made the sign-in form read as an afterthought on the one screen
 * where it is the only thing. `hero` corners (30px on top) because it leads the page; there is
 * never more than one on a screen.
 *
 * The classes come from `coach.css` rather than from `Surface`: `Surface`'s card face is the
 * console's 14px radius, and the asymmetric 30/17 corner is the coach language's signature. The
 * markup is `DeckPanel`'s anatomy with one deliberate difference -- the name is an `<h1>`, since
 * this panel *is* the page, where a deck panel is one of six on one.
 */
export function AuthPanel({
  children,
  eyebrow,
  title,
}: {
  children: ReactNode;
  eyebrow?: string;
  title: string;
}) {
  return (
    <section className="coach-panel" data-hero="true">
      {/*
        WHY THESE FIVE VALUES ARE INLINE STYLES AND NOT TAILWIND CLASSES.

        They were classes -- `px-[30px]` on the body, `text-[28px] leading-[1.15] font-[600]
        tracking-[-0.02em]` on the `<h1>` -- and **none of them had ever applied.** `@import
        "tailwindcss"` opens with `@layer theme, base, components, utilities;` and emits every
        utility inside `@layer utilities`, while `coach.css` is imported by `CoachScale` as a plain
        stylesheet and is therefore unlayered. Unlayered author CSS beats *any* cascade layer no
        matter how specific the layered selector is, so
        `[data-shell-role="coach"] .coach-panel__body { padding: 20px }` and
        `.coach-panel__name { font-size: var(--coach-panel-name) }` won every one of those
        contests silently.

        What a reader saw and what the file said had come apart. The class string promised the
        login artboard's 28px/600/-0.02em/1.15 title (`Login.dc.html:74`); the screen rendered the
        deck panel's 20px/500/-0.015em/1.25, because the panel name role is what actually won. The
        audit that read this file recorded "Code: 28px" off the class string and was wrong for the
        same reason -- a dead declaration reads exactly like a live one.

        Inline styles are the honest instrument here. They beat both the layer and the unlayered
        rule, they cannot be silently outranked by an edit to a stylesheet this component does not
        own, and they sit next to the reason. `!` utilities would also win, but an important-flag
        arms race against a stylesheet is how the next override gets written too.

        The horizontal inset is the drawing's and the vertical floor is the language's: the
        artboard's `15px` header padding (`Login.dc.html:72`) would drop the band under
        `coach.css`'s 78px floor, and that floor keeps a row of panels reading as a set. A
        one-panel page does not need it relaxed.

        Not fixed in `coach.css`, which is the obvious move and the wrong one: it would move every
        deck panel in the product, and `AuthPanel` is the only caller in the tree that overrides a
        `coach-panel__*` property at all.
      */}
      <header className="coach-panel__header" style={{ paddingInline: "30px" }}>
        <div className="min-w-0">
          {eyebrow ? <p className="coach-panel__eyebrow">{eyebrow}</p> : null}
          <h1
            className="coach-panel__name m-0"
            style={{
              fontSize: "28px",
              fontWeight: 600,
              letterSpacing: "-0.02em",
              lineHeight: 1.15,
            }}
          >
            {title}
          </h1>
        </div>
      </header>
      <div
        className="coach-panel__body gap-[var(--s-5)]"
        style={{ padding: "28px 30px 30px" }}
      >
        {children}
      </div>
    </section>
  );
}

/**
 * A sentence about the state of the attempt: the sign-in failed, the workspace is still being
 * built, the reset link has expired.
 *
 * `failure` is clay and `waiting` is periwinkle, and the difference is load-bearing -- a workspace
 * still provisioning is not a thing anyone is failing at, and painting it the same colour as a
 * rejected password would be the dishonest state `CLAUDE.md` bans. Both carry a dot beside the
 * words rather than colour alone, and neither grows an edge stripe.
 *
 * 16px, like everything else a coach reads here. It was 12.5px, which put the one sentence
 * explaining why they cannot get in below the size the round-1 demo feedback was about.
 */
export function AuthNotice({
  children,
  className,
  role = "status",
  tone,
}: {
  children: ReactNode;
  className?: string;
  role?: "alert" | "status";
  tone: Extract<Tone, "failure" | "waiting">;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-[var(--s-3)] rounded-[16px_16px_12px_12px] border p-[var(--s-4)] text-[16px] leading-[1.5]",
        className,
      )}
      data-slot="auth-notice"
      data-tone={tone}
      role={role}
      style={{
        background: TONE_WASH[tone],
        borderColor: TONE_LINE[tone],
        color: TONE_TEXT[tone],
      }}
    >
      <StatusDot className="mt-[7px]" size={6} tone={tone} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
