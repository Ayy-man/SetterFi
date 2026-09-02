import type { ReactNode } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The coach segment's loading boundary, drawn as the deck it is about to become.
 *
 * This file used to be `export { default } from "@/components/kit/skeleton"`, which draws the
 * owner console's shape: a stack of `--r-card` cards at 13px proportions with console row heights.
 * On a coach route that produced a page that visibly re-laid itself the moment the data landed --
 * every block the wrong size, the title in the wrong place, the panels the wrong radius -- and the
 * jump is worst for exactly the reader the coach density exists for.
 *
 * So the skeleton is the deck's own anatomy: the asymmetric `30px 30px 17px 17px` corners, the
 * header band closed by a hairline with a 44px action square at its right, a figure block at the
 * height a 62px mono number occupies, two sentence lines, and a footer widget pushed to the
 * bottom. `coach.css` owns all of that through `.coach-panel`, so the bones are placed by the same
 * stylesheet that will place the real content, and they cannot drift apart the way two hand-typed
 * copies of a layout do.
 *
 * **Why the head is bones rather than the artboard's words.** `CoachLoading` draws "Welcome back,
 * Marcus" and a "DEMO WORKSPACE DATA" chip as real text over a skeletal deck. A loading boundary
 * knows neither: it renders before the page's own server read, so it has no name, and -- more
 * importantly -- no idea whether this tenant's data is demo, test or real. Printing that chip
 * would be the one on-screen label the segregation rule turns on, guessed. Both are bones here and
 * become real when the page arrives.
 *
 * This boundary covers every `/coach/*` route, not just Home, which is why the deck is three
 * generic panels rather than Home's exact six: the panel is the shape every coach screen is made
 * of, so it is right everywhere, where a copy of one page's layout would be right on one route and
 * misleading on the other seven.
 */

/**
 * A bone at a given size. `Skeleton` from the primitive rather than the kit's, whose shimmer
 * recipe is tuned to console-sized blocks; at 52px tall the sweep reads as a flash.
 *
 * `on` is which face the bone is drawn against, and it exists because a bone is only a bone if it
 * separates from its ground. Every bone here was `--well`, chosen when the pane behind them was
 * `oklch(0.15)`; the light palette landed in `39f0cae` and on a near-white pane `--well` is darker
 * than its ground by a hair rather than lighter by a step -- 1.02:1, which is nothing, on the one
 * screen whose whole job is to show the page's shape before it arrives. Inside a card `--well`
 * still separates cleanly, so the panel bones keep it and only the ones sitting straight on the
 * pane move to `--band`.
 */
function Bone({ className, on = "card" }: { className: string; on?: "card" | "pane" }) {
  return (
    <Skeleton
      aria-hidden
      className={`block ${on === "pane" ? "bg-[var(--band)]" : "bg-[var(--well)]"} ${className}`}
    />
  );
}


function PanelBones() {
  return (
    <section className="coach-panel">
      <header className="coach-panel__header">
        <div className="flex min-w-0 flex-col gap-[9px]">
          <Bone className="h-[13px] w-[96px] rounded-[6px]" />
          <Bone className="h-[18px] w-[128px] rounded-[7px]" />
        </div>
        <Bone className="h-[44px] w-[44px] flex-none rounded-[10px]" />
      </header>
      <div className="coach-panel__body">
        <Bone className="h-[52px] w-[108px] rounded-[12px]" />
        <Bone className="mt-[12px] h-[15px] w-full rounded-[7px]" />
        <Bone className="mt-[12px] h-[15px] w-[62%] rounded-[7px]" />
        <div className="coach-panel__footer">
          <div className="flex items-baseline justify-between gap-[10px]">
            <Bone className="h-[17px] w-[74px] rounded-[7px]" />
            <Bone className="h-[14px] w-[132px] rounded-[7px]" />
          </div>
          <Bone className="mt-[14px] h-[8px] w-full rounded-[var(--r-full)]" />
        </div>
      </div>
    </section>
  );
}

/**
 * `children` is for a route whose own boundary needs one more bone than the segment's.
 *
 * Only Home uses it today, for the performance-window picker that exists on that route and no
 * other -- see `coach/home/loading.tsx`. It renders after the deck, where the real control sits.
 * Omitted, which is the case on the other seven routes, this file draws exactly what it drew
 * before the parameter existed.
 */
export default function CoachLoading({ children }: { children?: ReactNode }) {
  return (
    <AppShell
      activePath="/coach/home"
      crumbs={[{ label: "Coach" }, { label: "Loading" }]}
      role="coach"
    >
      {/*
        One live region for the whole page rather than one per bone. `kit/skeleton` labels every
        block `role="status"`, which on a deck of six panels announces "Loading content" eighteen
        times; here the bones are all `aria-hidden` and this single node says it once.
      */}
      <div aria-busy="true" className="min-w-0" role="status">
        <span className="sr-only">Loading your workspace.</span>

        <header className="flex min-w-0 flex-col gap-[14px]">
          <Bone className="h-[26px] w-[188px] rounded-[8px]" on="pane" />
          <Bone className="h-[46px] w-[min(100%,420px)] rounded-[10px]" on="pane" />
          <div className="flex flex-wrap items-center gap-[28px]">
            {["first", "second"].map((line) => (
              <span className="flex items-center gap-[10px]" key={line}>
                <Bone className="h-[9px] w-[9px] rounded-[var(--r-full)]" on="pane" />
                <Bone className="h-[15px] w-[min(60vw,240px)] rounded-[7px]" on="pane" />
              </span>
            ))}
          </div>
        </header>

        {/*
          The deck's own layout, now actually the deck's.

          This block used to be a `gap-[10px]` grid of `repeat(auto-fit, minmax(min(100%,210px),
          1fr))` under a comment saying it was copied from `CoachDeck` -- and `CoachDeck` argues
          against that exact grid by name (`coach-deck.tsx:271-282`): the 210px floor sized every
          panel identically and made the deck read as a table, which is why it was replaced by
          three `flex-1` columns at a 14px gap that stack below `md`. The skeleton had copied the
          version the deck replaced, so the one screen whose whole job is that nothing moves held
          the wrong gaps and the wrong column widths.

          `--coach-panel-radius` is redeclared here for the same reason `CoachDeck` redeclares it
          on its wrapper: `Main.dc.html` and `CoachLoading.dc.html` both give every deck panel the
          hero's `30px 30px 17px 17px`, and `.coach-panel`'s own fallback in `coach.css` is 24px.
          Without the override the bones' corners visibly changed the moment the real panels
          arrived. `--coach-figure` is the deck's other wrapper override and is deliberately not
          copied: nothing in here renders a figure, the block that stands in for one is a fixed
          52x108 bone the artboard draws at that size, so the token would have no effect.

          One bone per column, which is what makes three panels the right count rather than a row
          of three under the six the deck will land. The deck has no column stagger, so neither does
          this -- all three bones share one top line, the same as the panels that replace them.
        */}
        <div className="mt-[34px] flex flex-col items-start gap-[14px] [--coach-panel-radius:30px_30px_17px_17px] md:flex-row">
          {[0, 1, 2].map((index) => (
            <div
              className="flex min-w-0 flex-1 flex-col gap-[14px] self-stretch md:self-auto"
              data-deck-column={index}
              // Keyed by position. The three columns are identical now that nothing offsets them,
              // so position is the only identity they have, and a fixed list that never reorders is
              // exactly where the index is the correct key rather than the lazy one -- same as the
              // picker stops in `home/loading.tsx`.
              key={index}
            >
              <PanelBones />
            </div>
          ))}
        </div>

        {children}
      </div>
    </AppShell>
  );
}
