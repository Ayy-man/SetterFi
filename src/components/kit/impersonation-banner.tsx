"use client";

import { useEffect, useState, type ReactNode } from "react";

/**
 * The banner that says you are inside somebody else's workspace.
 *
 * `docs/REDESIGN-CANVAS.md` draws it (`AdminImpersonation.dc.html`) and `CLAUDE.md`'s hard rules
 * are what it is actually for: an owner reading a coach's workspace has crossed a tenant boundary,
 * that read is audit-logged, and the coach can see the visit on their own trail. A screen that
 * merely looked different while impersonating would be a decoration; this one states the fact.
 *
 * **Before this component there was no banner at all** -- five surfaces each hand-rolled their own
 * inline notice (`coach-conversations.tsx`, `coach-integrations.tsx`, `leads-surface.tsx`,
 * `admin-compliance.tsx`, `admin-channel-health.tsx`), in five different shapes, saying five
 * different things, and not one of them named the workspace, showed the elapsed time, or offered a
 * way out. `/api/platform/impersonation/end` existed and had no caller anywhere in the app, so the
 * only way to leave a session was to wait out its thirty minutes. That is the gap this closes.
 *
 * ## What is inert and what is not
 *
 * **Navigation stays live.** An owner opened the session to look around, and a banner that froze
 * the rail would defeat the feature it announces. The inertness belongs on anything that writes,
 * and it is already enforced in four places that do not depend on this component rendering:
 * Postgres refuses the write while the claim exists (`app.phase7_session_actor` against
 * `public.impersonation_sessions`), `src/lib/support/service.ts` throws
 * `SUPPORT_IMPERSONATION_READ_ONLY`, the admin route guards `forbidden()` outright, and the coach
 * surfaces disable their own composers and row actions off the same `impersonation` prop. This
 * banner is the visible half of a rule the database already keeps; it is not the enforcement.
 *
 * ## Why the band is sized to the coach surface's floor
 *
 * The band is admin-triggered chrome, but the shell underneath it is a coach's: an impersonation
 * session opens onto a coach workspace, which runs 16px body text and a 44px minimum on anything
 * pressable, with no exceptions, because it is read by coaches over 55 who told the client the
 * console was hard to read. It shipped at the console's density instead -- a 40px exit button and
 * 12.5px copy -- so the one strip that has to be legible on every page of the session was the
 * smallest thing on the screen. It cannot inherit the floor the way the rest of the surface does:
 * every rule in `coach.css` is scoped to `[data-shell-role="coach"]`, which `AppShell` stamps on
 * the shell root, and this renders above that root. So the sizes are stated here, taken from
 * `AdminImpersonation.dc.html` -- a 52px tile and exit button, a 20px identity line, 16px meta.
 *
 * ## Why the clock counts up rather than down
 *
 * A session is a hard thirty minutes (`assertExactDuration` in `src/lib/impersonation.ts`), so a
 * countdown is expressible. It counts up anyway. The number that matters to the person reading a
 * coach's inbox is how long they have been in there -- that is what appears on the coach's audit
 * trail and what they will be asked about -- and a countdown reframes the same session as an
 * allowance being spent. `expiresAt` is still stated in words beside it, so nothing is hidden.
 */

export type ImpersonationBannerProps = {
  /** The workspace being read, by name. Never a bare tenant id: an id names nobody. */
  tenantName: string;
  /**
   * Who is doing the reading, and in what capacity.
   *
   * The canvas puts "Dana Whitlock, client success" in the band and it is not decoration. The
   * audit entry names this person, the coach will see this person's name on their own trail, and
   * an owner console is a shared login in practice -- someone reading over a colleague's shoulder,
   * or returning to a machine left open, has to be able to tell whose session they are inside
   * before they act. Optional because a caller that genuinely cannot resolve the name should say
   * nothing rather than print an id.
   */
  operator?: { name: string; role: string };
  /** The session to end. Sent to `/api/platform/impersonation/end` as `sessionId`. */
  sessionId: string;
  /** ISO timestamp the session began. The clock is elapsed time since this. */
  startedAt: string;
  /** ISO timestamp the session expires. Stated in words; never rendered as a percentage. */
  expiresAt: string;
  /**
   * Where to land after the session ends. A full page load rather than a router push, because
   * ending a session rewrites the auth claims and every server component above this one was
   * rendered under the old ones.
   */
  returnTo?: string;
};

/** Elapsed time in whole minutes and seconds. Under a minute it says seconds, which reads honestly. */
function elapsedLabel(startedAt: string, now: number): string {
  const started = new Date(startedAt).getTime();
  if (Number.isNaN(started)) return "elapsed time not recorded";

  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  if (seconds < 60) return `${seconds}s in this workspace`;

  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s in this workspace`;
}

function expiryLabel(expiresAt: string): string {
  const expires = new Date(expiresAt);
  if (Number.isNaN(expires.getTime())) return "The session ends on its own.";
  return `The session ends on its own at ${expires.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  })}.`;
}

export function ImpersonationBanner({
  expiresAt,
  operator,
  returnTo = "/admin/platform-clients",
  sessionId,
  startedAt,
  tenantName,
}: ImpersonationBannerProps) {
  /*
   * The clock starts at null and fills in after mount. Rendering an elapsed time on the server
   * would ship a number that is already wrong by the time it is painted, and would differ between
   * the server pass and the first client pass, which is a hydration mismatch on a banner whose
   * whole job is to be trusted.
   */
  const [now, setNow] = useState<number | null>(null);
  const [ending, setEnding] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const initial = window.setTimeout(() => setNow(Date.now()), 0);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, []);

  async function end() {
    setEnding(true);
    setFailed(false);
    try {
      const response = await fetch("/api/platform/impersonation/end", {
        body: JSON.stringify({ sessionId }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      if (!response.ok) throw new Error("END_REFUSED");
      // A hard navigation, not a router push: the claims this page was rendered under are gone.
      window.location.assign(returnTo);
    } catch {
      setEnding(false);
      setFailed(true);
    }
  }

  return (
    <div
      /*
       * A full amber band, not a hairline with a dot.
       *
       * Every colour here is a `--warning-*` token rather than a literal, and that is the whole
       * reason this component was ever wrong. It was authored while the product was dark-only and
       * it transcribed the dark palette's warning family as raw rgba -- `rgba(184, 137, 78, ...)`
       * is exactly the dark `--warning-wash` hue -- which was harmless while nothing rendered it.
       * Mounting it put that dark-solved amber on the light palette a viewer with no stored theme
       * now gets, and `eb3bd1f` had just re-solved the light hairlines and washes precisely
       * because a dark alpha does not composite the same way over a near-white ground.
       *
       * Measured with `tokens-contrast.test.ts`'s own OKLCH-to-sRGB, alpha-`over` and contrast
       * math, the literals were failing AA on light: `--warning-text` on the authored band fill
       * came to 4.39 against the 4.5 small-text floor, and 3.62 on the authored button fill --
       * the one control that gets an operator out of a tenant's workspace. The tokens clear it at
       * 4.55 on the band, and they hold in dark at 9.05, because they flip and a literal cannot.
       *
       * The "no edge colour stripes" rule the client set is about a coloured bar down one side of
       * an otherwise neutral card, which reads as decoration and carries no meaning. This is the
       * opposite: the whole band is tinted, on every page of the session, because the tint IS the
       * message. An owner should never be able to lose track of whose workspace they are standing
       * in, and a neutral banner with a small warning dot is exactly the thing a person stops
       * seeing by the third page.
       */
      className="flex w-full min-w-0 flex-wrap items-center gap-[var(--s-6)] border-b border-[var(--warning-line)] bg-[var(--warning-wash)] px-[var(--s-10)] py-[18px]"
      data-slot="impersonation-banner"
      /*
       * `role="status"` rather than `alert`: nothing is wrong, and an assertive live region would
       * interrupt a screen-reader user once a second as the clock ticks. The clock itself is
       * `aria-live="off"` below for the same reason.
       */
      role="status"
    >
      <span
        aria-hidden="true"
        className="grid size-[52px] shrink-0 place-items-center rounded-[13px] border border-[var(--warning-line)] text-[color:var(--warning-text)]"
      >
        <EyeGlyph />
      </span>

      {/*
        * `basis-[320px]` rather than a bare `flex-1`, and this is load-bearing rather than taste.
        *
        * A `min-w-0 flex-1` block sharing a flex line with `shrink-0` neighbours collapses to its
        * own minimum before the row ever wraps, because wrapping only fires once an item cannot
        * fit at its min-content width -- and a paragraph's min-content width is one word. The
        * clock and the button would hold their full width while the sentence naming the workspace
        * squeezed into a column of single words. The coach inbox shipped the same bug in its other
        * form, where a shrink-0 timestamp ate every lead's name down to "Jo...".
        *
        * A basis gives the sentence a width to defend, so the two controls wrap under it instead.
        * On a banner whose entire job is to be read, the metadata is what must give.
        */}
      <div className="min-w-0 flex-1 basis-[320px]">
        <p className="m-0 text-[20px] leading-[1.3] font-semibold text-[color:var(--warning-text)]">
          You are viewing {tenantName}&rsquo;s workspace. Read-only.
        </p>

        <div className="mt-[5px] flex flex-wrap items-center gap-x-[var(--s-5)] gap-y-[var(--s-1)] text-[16px] leading-[1.45] text-[color:var(--body)]">
          {operator ? <span>{operator.name}, {operator.role}</span> : null}

          <span className="flex items-center gap-[7px]">
            <ClockGlyph />
            In this workspace{" "}
            <span
              aria-live="off"
              className="font-mono tabular-nums text-[color:var(--ink)]"
              data-slot="impersonation-elapsed"
            >
              {now === null ? "counting" : elapsedLabel(startedAt, now)}
            </span>
          </span>

          <span
            className="flex items-center gap-[7px] text-[color:var(--muted)]"
            data-slot="audit-microcopy"
          >
            <ShieldGlyph />
            Logged. This visit is on {tenantName}&rsquo;s audit trail with your name on it.
          </span>
        </div>

        {/*
          * What is inert, and what to do instead.
          *
          * The canvas draws this as a separate lock strip inside the coach page body. It lives in
          * the banner instead because the banner is the one thing that mounts on every page of the
          * session, and a rule stated only on the page that happened to be drawn is a rule the
          * operator meets once. Naming the route out matters as much as naming the block: an owner
          * who cannot change a setting and is told only "no" will go looking for a way around it.
          */}
        <p className="m-0 mt-[6px] max-w-[var(--measure-prose)] text-[16px] leading-[1.45] text-[color:var(--muted)]">
          Nothing here can be changed from this session. To edit {tenantName}&rsquo;s settings, ask
          them to make the change or open a support request from the owner console.{" "}
          {expiryLabel(expiresAt)}
        </p>

        {failed ? (
          <p
            className="m-0 mt-[6px] text-[16px] leading-[1.45] text-[color:var(--failure-text)]"
            data-slot="impersonation-end-failed"
          >
            Ending the session was refused, so you are still in {tenantName}&rsquo;s workspace.
            Nothing changed. It ends on its own at the time above.
          </p>
        ) : null}
      </div>

      {/*
        * The way out, in the band's own amber rather than the product accent.
        *
        * The accent is the product's "this is the thing to press" colour everywhere else, and
        * spending it here would make leaving look like a normal product action on a page where
        * every other control is inert. Amber keeps the exit inside the band's own vocabulary while
        * still being the only filled thing on the strip.
        *
        * The label is `--ink` rather than `--warning-text`, and that is a measurement rather than
        * a taste: no translucent amber fill strong enough to separate this control from the band
        * leaves a warning-family text token above 4.5 on the light palette -- `--warning-text`
        * lands at 3.41 and even `--warning-body` at 4.12. `--ink` is the palette's own maximum
        * contrast text, it flips with the theme, and it clears at 10.2 light and 10.5 dark.
        */}
      <button
        className="inline-flex h-[52px] shrink-0 items-center gap-[var(--s-3)] rounded-[12px] border border-[var(--warning-line)] bg-[var(--warning-line)] px-[var(--s-6)] text-[17px] font-semibold text-[color:var(--ink)] disabled:opacity-60"
        data-slot="impersonation-end"
        disabled={ending}
        onClick={end}
        type="button"
      >
        <ExitGlyph />
        {ending ? "Leaving…" : "Leave this workspace"}
      </button>
    </div>
  );
}

/*
 * The four glyphs, drawn here rather than imported.
 *
 * This banner has to be mountable above any shell -- coach, console, or a future one -- and an
 * icon-set import is the kind of dependency that later decides where a component may live. They
 * are `aria-hidden` because every one of them sits beside text that already says the same thing.
 */
function Glyph({ children, size = 17 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.75"
      viewBox="0 0 24 24"
      width={size}
    >
      {children}
    </svg>
  );
}

function EyeGlyph() {
  return (
    <Glyph size={24}>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </Glyph>
  );
}

function ClockGlyph() {
  return (
    <Glyph>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Glyph>
  );
}

function ShieldGlyph() {
  return (
    <Glyph>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </Glyph>
  );
}

function ExitGlyph() {
  return (
    <Glyph size={20}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </Glyph>
  );
}
