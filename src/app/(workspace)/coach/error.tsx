"use client";

import Link from "next/link";
import { useEffect } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { ACCENT_FILL_SHADOW_CLASS } from "@/components/kit/atomics/button-class";
import { DeckPanel } from "@/components/kit/deck-panel";
import { Refresh, TriangleAlert } from "@/components/kit/icons";
import { COACH_FOOTNOTE_CLASS } from "@/components/workspace/live/coach-type";

/**
 * What a coach sees when a coach route fails to render.
 *
 * The artboard's own note is the whole design brief for this screen: "The dashboard failed to
 * load. The agent did not. Say exactly that and nothing more." That distinction is the only thing
 * a coach actually wants from an error page, and the old `DataState` version could not make it --
 * it printed "This coach view couldn't finish loading" over `FAILURE_BODY.agent`, which says no
 * agent action was completed *by this error state*. True, and read as "my setter has stopped",
 * which is the opposite of what happened. The setter runs in the webhook path on the server; a
 * React segment that threw while drawing a chart has no bearing on whether it is still answering
 * DMs.
 *
 * **What the artboard says and this does not: the channel names.** The canvas reads "Your agent is
 * still answering leads on Instagram and Messenger", and an error boundary is the one place in the
 * product that cannot know that. It has no tenant, no connection rows, and no way to reach them --
 * it is a client component handed an `Error` and a `reset`. Naming two channels here would be
 * asserting live provider state from a component whose entire premise is that a read failed, and
 * a coach whose Instagram token expired this morning would be told it is fine by the very screen
 * that broke. So the sentence keeps the claim it can support -- the failure is confined to this
 * page -- and drops the two words it cannot.
 *
 * The shell is still rendered around it, deliberately: the pill bar is how a coach leaves a broken
 * page, and an error screen that eats the navigation strands them on it.
 */

/*
 * The two actions, at the coach's 52px rather than the kit's 34px. `Button` is sized for the owner
 * console and `coach.css` only raises the floor to 44px, which is the minimum rather than the size
 * the canvas draws a primary action at. These two strings are local for the same reason
 * `coach-billing.tsx` keeps its own: the recipe is one screen's, and a shared one would have to be
 * true at both densities.
 */
const RETRY_CLASS =
  "inline-flex h-[52px] items-center justify-center gap-[12px] rounded-[12px] border border-[var(--accent-line)] bg-[var(--accent-fill)] px-[26px] text-[18px] leading-none font-semibold text-[color:var(--on-accent)]" +
  ` ${ACCENT_FILL_SHADOW_CLASS}`;
const LEAVE_CLASS =
  "inline-flex h-[52px] items-center justify-center rounded-[12px] border border-[var(--line)] bg-[var(--well)] px-[22px] text-[16px] leading-none font-medium text-[color:var(--body)] hover:border-[var(--accent-edge)] hover:text-[color:var(--ink)]";

export default function CoachError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  /*
   * The digest, which is the only identifier that exists. Next stamps it on a server error and
   * support can look it up; a client-side throw has none, so rather than print an empty well the
   * fallback names the failure class itself. It is deliberately not a generated code -- a
   * reference number invented in the browser matches nothing in any log, and handing a coach one
   * to read out to support wastes both their time.
   */
  const code = error.digest ?? "COACH_SEGMENT_RENDER_FAILED";

  return (
    <AppShell
      activePath="/coach/home"
      crumbs={[{ label: "Coach" }, { label: "View interrupted" }]}
      role="coach"
    >
      <div className="grid min-w-0 flex-1 place-items-center py-[var(--s-6)]">
        <DeckPanel
          /*
            620px, the width `CoachError.dc.html:94` draws, as a literal rather than a token.

            This was `max-w-[var(--drawer-w)]`, which is 480px -- so the card rendered 140px
            narrower than drawn. The borrowed name is the real defect and it is worth being
            explicit about, because the number was only the symptom: every one of the twenty-two
            other `--drawer-w` readings in the tree is a drawer, a sheet, a dialog, a popover, or
            a table column sized off one, and this was the single caller that is none of those. A
            token means "how wide a drawer is"; this is a centred page card that happens to have
            been near that width once. So the day somebody tunes a drawer -- which is exactly the
            kind of change nobody would think to check an error boundary against -- this card
            would have moved with it for no reason anyone could reconstruct.

            A literal is the honest form here and not laziness. There is no width token this
            belongs to: `--measure-*` are all `ch` measures for text columns, and a card holding a
            44px tile beside a heading is sized by its own content rather than by a line length.
            One page, one number, and the artboard line it came from written beside it.
          */
          /*
            `coach-panel--page` asks for the density `CoachError.dc.html:96,106` draws -- a
            `15px 30px` band with the tile and the heading centred against each other, and a
            `28px 30px 30px` body on a 24px gap -- instead of the deck's `19px 20px` band on a
            78px floor, which is the measurement for one card in a row of three and puts this
            page's warning tile at the top of a band it does not fill.

            It travels with `nameSize="page"` below: both say "this panel is the page", and a
            future page-shaped panel should take both or neither. The body's 24px gap is why the
            four children below carry no `mt-*` of their own any more -- they had three different
            margins where the artboard has one rhythm, and a gap beside a margin is two rules
            fighting over the same space.
          */
          className="coach-panel--page w-full max-w-[620px]"
          eyebrow="This page"
          headingId="coach-error-title"
          hero
          /*
            The amber tile the artboard opens this panel with. Amber rather than the failure tone
            on purpose: the page a coach was reading did not load, which is a thing to tell them
            about, and nothing was lost or broken on their account -- the footnote below says so in
            words and the colour should not contradict it.
          */
          lead={
            <span
              aria-hidden
              className="inline-flex size-[44px] items-center justify-center rounded-[11px] border border-[var(--warning-line)] bg-[var(--warning-wash)] text-[color:var(--warning-text)]"
            >
              <TriangleAlert size={22} strokeWidth={1.75} />
            </span>
          }
          /*
            Two separate things the artboard settles, and the comment here used to run them
            together and get the second one backwards.

            The level: `CoachError.dc.html` opens the panel with an `<h1>`, and this page is the
            shape that makes that right -- one centred panel and nothing else, no page header
            above it, so the panel IS the page. Left at the component's default the document
            opened at level two with no h1 at all, which gives a screen reader a heading list with
            no top and makes "jump to the main heading" reach nothing.

            The size: `CoachError.dc.html:102` draws that h1 at 26px/600/-0.02em, and it does not
            draw at the artboard's size on its own. `coach.css` styles `.coach-panel__name` by
            class at 20px/500/-0.015em, so the heading rendered six pixels short and a weight
            light for four rounds behind a comment claiming it "draws at exactly the artboard's
            size either way". `nameSize="page"` is what asks for the drawn one -- `page` and not
            `hero`, because `hero` is the Tips card at 26px, weight 500, -0.018em, and this is
            the heavier heading that carries a page rather than labelling a card.
          */
          name="Something on our side broke"
          nameAs="h1"
          nameSize="page"
        >
          <p className="max-w-[var(--measure-prose)] text-[18px] leading-[1.55] text-[color:var(--body)]">
            Your agent is still answering leads. This is only the dashboard, and we already know it
            went down.
          </p>

          {/*
            A well rather than a `Callout`: the code is a fact to read aloud to a person, not a
            warning, and framing it in a tone colour would make a reference number look like a
            second thing that had gone wrong.
          */}
          <div className="flex flex-wrap items-center justify-between gap-[16px] rounded-[14px_14px_11px_11px] border border-[var(--line)] bg-[var(--well)] px-[20px] py-[16px]">
            <span className="text-[16px] leading-[1.4] text-[color:var(--muted)]">
              Give support this code
            </span>
            <code className="font-[family-name:var(--font-mono)] text-[18px] leading-[1.3] tracking-[0.04em] text-[color:var(--ink)]">
              {code}
            </code>
          </div>

          <div className="flex flex-wrap items-center gap-[14px]">
            <button className={RETRY_CLASS} onClick={reset} type="button">
              {/* The glyph the artboard draws on this button, and the one place on the page where
                  an icon earns its room: "Try again" is the only control here that does something
                  rather than going somewhere, and the arrows say re-run before the word is read. */}
              <Refresh aria-hidden size={20} strokeWidth={1.75} />
              Try again
            </button>
            <Link className={LEAVE_CLASS} href="/coach/conversations">
              Go to your inbox
            </Link>
          </div>

          <p className={`max-w-[var(--measure-prose)] ${COACH_FOOTNOTE_CLASS}`}>
            Nothing you were doing was saved or changed by this.
          </p>
        </DeckPanel>
      </div>
    </AppShell>
  );
}
