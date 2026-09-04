"use client";

import type { CSSProperties } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { Surface, SurfaceHeader } from "@/components/kit/atomics/surface";
import { Skeleton } from "@/components/ui/skeleton";
import { HOME_BUBBLES } from "@/components/workspace/rehaul/coach-home-figures";
import { useWorkspaceEnv } from "@/components/workspace/workspace-env";

/**
 * Home's own loading boundary, drawn as `Loading.dc.html` draws it.
 *
 * The artboard's note is the whole design brief: "The greeting and the chrome are real: they come
 * from the session, not from the read in flight. Only the figures are skeletons, and each one is
 * the size of the number that lands in it."
 *
 * That is why this file is a client component rather than the server one it used to be. The
 * greeting is the coach's first name, and the workspace layout publishes it through
 * `WorkspaceEnvProvider` above this boundary, so it is available before the page's own read has
 * started. It is real text, not a bone, and it does not move when the page arrives.
 *
 * **What stays a bone, and why each one does.** The status sentence names live channels and a
 * carrier day, which are page reads. The window eyebrow on each panel names the range, which comes
 * from the URL the page parses. The provenance line names whether this tenant's rows are seeded,
 * which is the one on-screen label the test-data segregation rule turns on and may not be guessed.
 * Every figure. Everything else on this screen is either chrome or a constant, so it is drawn.
 *
 * `CoachLoading` one level up still covers the other coach routes and is untouched: it draws three
 * generic deck panels because the panel is the shape every coach screen is made of, and Home's own
 * six-panel composition would be wrong on the other seven.
 */

/**
 * One bone per stop the range control renders, at the width its label will be.
 *
 * The widths are written out one by one rather than derived from the labels, because a bone is a
 * measurement of rendered text and a character count is not one. `loading.test.tsx` asserts this
 * list is exactly as long as the control's own, which is what keeps a stop added there from
 * landing nowhere here and changing the strip's width at the moment the page settles.
 */
export const STOP_WIDTHS = ["78px", "88px", "96px", "108px", "58px", "88px"] as const;

function Bone({
  className,
  on = "card",
  style,
}: {
  className: string;
  on?: "card" | "pane";
  style?: CSSProperties;
}) {
  return (
    <Skeleton
      aria-hidden
      className={`block ${on === "pane" ? "bg-[var(--band)]" : "bg-[var(--well)]"} ${className}`}
      style={style}
    />
  );
}

/** A panel drawn to the bubble's anatomy, with a bone exactly where the figure lands. */
function BubbleBones({ name, sentence }: { name: string; sentence: string }) {
  return (
    <section className="coach-panel">
      <header className="coach-panel__header">
        <div className="min-w-0">
          <Bone className="mb-1 h-[15px] w-[92px] rounded-[6px]" />
          <h2 className="coach-panel__name">{name}</h2>
        </div>
        <Bone className="h-11 w-11 flex-none rounded-[10px]" />
      </header>
      <div className="coach-panel__body">
        {/*
          The figure's own box: 62px of mono at `--coach-figure`'s leading is what lands here, and
          a bone drawn at a comfortable height rather than that one is how a deck grows twenty
          pixels the moment it settles.
        */}
        <Bone className="h-[58px] w-[132px] rounded-[12px]" />
        <p className="coach-panel__sentence min-h-[48px]">{sentence}</p>
      </div>
    </section>
  );
}

export default function CoachHomeLoading() {
  const workspace = useWorkspaceEnv();
  const greeting = workspace.account?.firstName ?? null;

  return (
    <AppShell
      activePath="/coach/home"
      crumbs={[{ label: "Coach" }, { label: "Home" }]}
      role="coach"
    >
      {/*
        One live region for the whole page rather than one per bone: a deck of six panels labelling
        every block would announce "Loading content" a dozen times.
      */}
      <div aria-busy="true" className="flex min-w-0 flex-col gap-6" role="status">
        <span className="sr-only">Loading your numbers.</span>

        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="min-w-0">
            <h1 className="coach-page-title m-0">
              {greeting ? `Welcome back, ${greeting}` : "Dashboard"}
            </h1>
            {/* The status sentence is two page reads, so it holds its line without asserting one. */}
            <Bone className="mt-3 h-[26px] w-[min(100%,520px)] rounded-[8px]" on="pane" />
            <Bone className="mt-[10px] h-[19px] w-[min(100%,320px)] rounded-[7px]" on="pane" />
          </div>
          <div
            aria-hidden
            className="flex gap-1 rounded-xl border border-[var(--line)] bg-[var(--well)] p-1"
            data-slot="home-range-bones"
          >
            {STOP_WIDTHS.map((width, index) => (
              <Bone
                // Keyed by position. Every stop is a fixed placeholder that never reorders, which
                // is the case where the index is the correct identity rather than the lazy one,
                // and two stops share a width so the width itself is not a key.
                className="h-[44px] rounded-[9px]"
                key={index}
                style={{ width }}
              />
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {HOME_BUBBLES.map((bubble) => (
            <BubbleBones key={bubble.key} name={bubble.name} sentence={bubble.sentence} />
          ))}
        </div>

        {/*
          A sentence where the chart lands rather than a chart-shaped bone. A block the size of six
          bars is a picture of a chart, and the artboard prints a line instead for the same reason
          the page prints one when the series is too short: nothing on this screen may draw a shape
          the data has not arrived to support.
        */}
        <Surface
          aria-labelledby="home-months-bones-heading"
          className="flex min-w-0 flex-col"
          variant="panel"
        >
          <SurfaceHeader
            overline="Six months"
            scale="coach-data"
            title="Leads by month"
            titleAs="h2"
            titleId="home-months-bones-heading"
          />
          <div className="px-[26px] py-8">
            <p className="text-[16px] leading-[1.5] text-[color:var(--muted)]">
              Loading six months of leads.
            </p>
          </div>
        </Surface>
      </div>
    </AppShell>
  );
}
