"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";

import { ACCENT_FILL_SHADOW_CLASS } from "@/components/kit/atomics/button-class";
import { DataState } from "@/components/kit/data-state";
import { DeckPanel } from "@/components/kit/deck-panel";
import { ArrowLeft, Play, Search } from "@/components/kit/icons";
import { Prose } from "@/components/kit/atomics";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import { workspaceDateFormat } from "@/lib/format/datetime";
import { COACH_FOOTNOTE_CLASS, COACH_LEAD_CLASS, COACH_READING_CLASS } from "./coach-type";

/**
 * One training, exactly as a coach reads it.
 *
 * There is no repository behind this type and no API route that returns it, which is a fact worth
 * stating in the file rather than leaving for the next reader to discover. `src/lib/repositories`
 * has no trainings store, nothing under `src/app/api` serves a catalogue, and the intake never
 * asked the client for one -- the videos in the artboard are drawn copy, not content anybody has
 * recorded. So the surface ships with the real page head and the kit's honest empty state, and the
 * card shape lives behind the `trainings` prop so the day the content lands the work is passing an
 * array rather than designing a page.
 *
 * `duration` is a string, not seconds, on purpose: the only source will be whatever the coaching
 * team writes beside each video, and a component that takes a number would have to invent a
 * formatting convention for content it has never seen. `href` is nullable for the same reason --
 * a training can be listed before it is playable, and a Watch button that goes nowhere is worse
 * than a card that says only what it is about.
 */
export type CoachTraining = {
  id: string;
  /**
   * The category, sentence case. Never uppercase: it renders as the panel's eyebrow, at
   * `--coach-eyebrow`. Named by reference rather than as a pixel value, because this said "12px"
   * against a 14px token for a whole redesign pass -- see the same correction in `coach-billing.tsx`.
   */
  category: string;
  title: string;
  /** As authored -- "5:02", "8:14". Shown in mono beside the play affordance. */
  duration: string;
  /** One sentence saying what the coach gets out of watching it. */
  sentence: string;
  /** Where the video plays. `null` while a listed training is not yet playable. */
  href: string | null;
  /** ISO date. Only the featured training prints it, as "added 26 August". */
  addedAt?: string;
  /** Leads the page in the wide card. At most one; the first one wins if a caller sets two. */
  featured?: boolean;
  /** A second, quieter action -- "Open my offer sheet". Featured only. */
  related?: { label: string; href: string };
};

export type CoachTipsProps = {
  /**
   * Defaults to empty, and empty is the state that ships today. A caller that has nothing to pass
   * gets the empty state without opting into it, which is the right default for a surface whose
   * content does not exist yet: the failure mode to avoid is a page that looks populated because
   * somebody left placeholder rows in a default.
   */
  trainings?: readonly CoachTraining[];
};

/*
 * The coach scale, restated locally the way `coach-billing.tsx` does it -- see the note there for
 * why the kit's `--t-*` roles cannot be used on this side of the product.
 */
const PANEL_SENTENCE_CLASS = `m-0 max-w-[var(--measure-deck)] text-[color:var(--muted)] ${COACH_READING_CLASS}`;
const DURATION_CLASS =
  "font-[family-name:var(--font-mono)] text-[15px] leading-[1.4] text-[color:var(--faint)] [font-variant-numeric:tabular-nums_lining-nums]";
const ACCENT_FILL_CLASS =
  "inline-flex h-[56px] items-center justify-center gap-[12px] rounded-[12px] border border-[var(--accent-line)] [background:var(--accent-fill)] px-[28px] text-[18px] leading-none font-semibold text-[color:var(--on-accent)] no-underline" +
  ` ${ACCENT_FILL_SHADOW_CLASS}`;
const SECONDARY_BUTTON_CLASS =
  "inline-flex h-[56px] items-center justify-center rounded-[12px] border border-[var(--line)] bg-[var(--well)] px-[24px] text-[17px] leading-none font-medium text-[color:var(--body)] no-underline hover:border-[var(--accent-edge)] hover:text-[color:var(--ink)]";

function addedLabel(value: string | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : `added ${workspaceDateFormat.format(date)}`;
}

/**
 * The page head, at the coach side's scale rather than the console's.
 *
 * Local rather than `PageHeader` for the reason `LeadsHead` documents: `PageHeader` sets its title
 * with `.t-page-title`, the console's 20px, and no prop moves it. The lead is the client's own
 * sentence from the artboard, kept word for word because "none of them assumes you know what an
 * API is" is the promise the whole surface is making and it is not ours to soften.
 */
function TipsHead() {
  return (
    <header className="flex min-w-0 flex-col gap-[var(--s-2)]" data-page-head="tips">
      {/*
        The way back. Tips is reached from the account menu and the support bubble, neither of
        which is a place on the page, so without this a coach who opens it has no route out of it
        except the browser. "Back to Home" rather than the artboard's "Back to overview": the
        shipped nav calls the destination Home, and a link should name it the way it names itself.
      */}
      <Link
        className="inline-flex items-center gap-[var(--s-2)] text-[16px] leading-[1.4] font-medium text-[color:var(--muted)] no-underline hover:text-[color:var(--ink)]"
        data-slot="tips-back"
        href="/coach/home"
      >
        <ArrowLeft aria-hidden size={18} strokeWidth={1.75} />
        Back to Home
      </Link>
      <h1 className="coach-page-title m-0">Tips and trainings</h1>
      <Prose className={`m-0 ${COACH_LEAD_CLASS}`} measure="wide">
        Short videos from your coaching team on getting more out of your agent. None of them is
        longer than eight minutes, and none of them assumes you know what an API is.
      </Prose>
    </header>
  );
}

/**
 * The play affordance, which is a link and not a button.
 *
 * A training that has no `href` yet renders the same square with no link around it and no hover:
 * the tile still tells a reader that this row is a video, and nothing on screen invites a press
 * that would go nowhere. 56px rather than the 44px floor because the artboard draws it that size
 * and it is the only target in the card.
 */
function PlayTile({ href, title }: { href: string | null; title: string }) {
  const face =
    "grid h-[56px] w-[56px] shrink-0 place-items-center rounded-[14px] border border-[var(--line)] bg-[var(--well)] text-[color:var(--accent-text)]";
  if (!href) return <span aria-hidden className={face}><Play size={22} /></span>;
  return (
    <Link
      className={`${face} no-underline hover:border-[var(--accent-edge)]`}
      href={href}
    >
      <Play size={22} />
      <span className="sr-only">Watch {title}</span>
    </Link>
  );
}

/**
 * The featured training: the artboard's wide card, with the drenched thumbnail block that is the
 * only saturated thing on the screen.
 *
 * The drench sits on the thumbnail rather than on the panel, which is what keeps the page inside
 * the rule: `docs/REDESIGN-CANVAS.md` allows at most two drenched panels and nothing else filling,
 * and this way the page spends none of that budget while still getting the one saturated block the
 * artboard leads with. The accent fill on "Watch now" is then the screen's only fill, and the six
 * cards below it carry no fill at all.
 */
function FeaturedTraining({ training }: { training: CoachTraining }) {
  const added = addedLabel(training.addedAt);
  const headingId = `featured-training-${training.id}`;
  return (
    <DeckPanel
      eyebrow={added ? `${training.category} · ${added}` : training.category}
      headingId={headingId}
      name={training.title}
      /*
        `nameSize` and not `hero`, and the difference is the one property the drawing did not
        change. `CoachTips.dc.html:123` sets this training's name at 26px/500/-0.018em inside a
        real eyebrow+name band -- so it is the banded shape at a hero size. It is not the only
        enlarged name on the canvas, which this comment used to claim: `CoachError.dc.html:102`
        draws a second one at 26px/600/-0.02em, and that claim of uniqueness is why the error
        page's h1 sat at 20px for four rounds. This one is `hero`; that one is `page`. What this
        is *not* is a 30px-radius card: the artboard draws this one at `24px 24px 17px 17px`, the same radius as
        the six cards under it, and `hero` was quietly moving it to 30px while leaving the name at
        the ordinary 20px. So it had the wrong half of the treatment in both directions.
      */
      nameSize="hero"
    >
      {/*
        `CoachTips.dc.html:113` draws this thumbnail at 560x300 with `flex: none`, `gap: 0` to the
        text beside it and a `border-right` hairline -- an image that reaches the card's edge, the
        way a thumbnail does. It shipped at 320x180 floating inside the body's padding with 24px of
        gap, which is a picture *in* a card rather than the face of one, and at 180px tall it was
        shorter than the sentence next to it, so the one saturated block on the screen was also the
        smallest thing in its own row.

        The bleed is negative margins against `.coach-panel__body`'s 20px (`coach.css:213`) rather
        than a structural change, because the true anatomy -- the thumbnail beside the header band
        as well as the body -- would mean changing `DeckPanel`, and this lane does not own that
        file. Routed rather than reached for. It is `md:` only: stacked on a phone the bleed would
        pull the sentence up under the image instead of sitting beside it.
      */}
      <div className="grid min-w-0 items-stretch gap-[20px] md:grid-cols-[minmax(0,560px)_minmax(0,1fr)] md:gap-0">
        <div className="relative grid min-h-[220px] place-items-center rounded-[16px] bg-[var(--coach-drench-info)] md:-my-[20px] md:-ml-[20px] md:min-h-[300px] md:rounded-none md:border-r md:border-[var(--line)]">
          {/*
            A still frame we do not have. The play mark stands in for it, and it is `aria-hidden`
            because the Watch control below carries the accessible name -- a reader who cannot see
            this block has lost decoration, not a destination.
          */}
          <span aria-hidden className="grid h-[88px] w-[88px] place-items-center rounded-[var(--r-full)] border border-[rgba(255,255,255,0.55)] bg-[rgba(255,255,255,0.14)] text-[color:var(--on-accent)] md:h-[108px] md:w-[108px]">
            <Play size={40} />
          </span>
          {/* 14px here against the grid cards' 15px, per `:117`: this one is read off a saturated
              ground where the same size reads a step larger than it does on a card face. */}
          <span className="absolute right-[16px] bottom-[16px] rounded-[8px] border border-[rgba(255,255,255,0.22)] bg-[rgba(0,0,0,0.28)] px-[11px] py-[5px] font-[family-name:var(--font-mono)] text-[14px] leading-[1.4] text-[color:rgba(255,255,255,0.92)] [font-variant-numeric:tabular-nums_lining-nums]">
            {training.duration}
          </span>
        </div>
        <div className="flex min-w-0 flex-col gap-[18px] md:py-[4px] md:pl-[26px]">
          <Prose className={`m-0 text-[18px] leading-[1.55] text-[color:var(--body)]`} measure="prose">
            {training.sentence}
          </Prose>
          <div className="flex flex-wrap items-center gap-[14px]">
            {training.href ? (
              <Link className={ACCENT_FILL_CLASS} href={training.href}>
                <Play size={19} />
                Watch now
              </Link>
            ) : (
              /*
                Listed but not yet playable. It says which of the two it is rather than showing a
                dead button, because "nothing happened when I pressed it" is the one outcome a
                coach cannot tell apart from a broken product.
              */
              <p className={`m-0 ${COACH_FOOTNOTE_CLASS}`}>
                This training is not published yet.
              </p>
            )}
            {training.related ? (
              <Link className={SECONDARY_BUTTON_CLASS} href={training.related.href}>
                {training.related.label}
              </Link>
            ) : null}
          </div>
        </div>
      </div>
    </DeckPanel>
  );
}

/**
 * One card in the grid.
 *
 * The duration rides the header band, hard right against the name, which is where the artboard
 * puts it and which is also what makes a grid of these scannable: three cards in a row show three
 * lengths on one line rather than three lengths at three different heights, because the sentences
 * under them are not the same length.
 *
 * The play tile is left of the sentence, not under it (`CoachTips.dc.html:145`: one flex row,
 * `gap: 16px`). It shipped in a footer pushed to the bottom by `margin-top: auto`, and the
 * argument for that -- a row of cards ending level -- was solving a problem the artboard does not
 * have: `DeckPanel` already stretches the cards to equal height, so all the footer bought was a
 * band of empty card under short sentences with the only control in the card stranded below it.
 * Beside the sentence, the tile is the first thing in the body and reads as what the card is,
 * which is a video.
 */
function TrainingCard({ training }: { training: CoachTraining }) {
  return (
    <DeckPanel
      eyebrow={training.category}
      headingId={`training-${training.id}`}
      liftable={Boolean(training.href)}
      meta={<span className={DURATION_CLASS}>{training.duration}</span>}
      name={training.title}
    >
      <div className="flex min-w-0 items-start gap-[16px]">
        <PlayTile href={training.href} title={training.title} />
        <Prose className={PANEL_SENTENCE_CLASS} measure="caption">{training.sentence}</Prose>
      </div>
    </DeckPanel>
  );
}

/* The sentences this screen would otherwise print as help text, handed to the eye instead. */
const TIPS_EYE_COPY =
  "Short videos from your coaching team, none of them longer than eight minutes. Search reads a "
  + "training's title, its category and its one-line summary, nothing inside the video itself. "
  + "Nothing on this page changes your agent, so it is safe to read at any point in setup.";

export function CoachTips({ trainings = [] }: CoachTipsProps) {
  const [query, setQuery] = useState("");
  const searchId = useId();

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return trainings;
    return trainings.filter((training) => [
      training.title,
      training.category,
      training.sentence,
    ].some((field) => field.toLowerCase().includes(needle)));
  }, [query, trainings]);

  const featured = matches.find((training) => training.featured) ?? null;
  const rest = featured ? matches.filter((training) => training.id !== featured.id) : matches;

  return (
    <div className="flex min-w-0 flex-col gap-[24px]">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-[24px]">
        <TipsHead />
        <div className="flex min-w-0 items-center gap-[12px]">
        {/*
          The search field only exists once there is something to search. A box over an empty
          catalogue is a claim that content is there and the reader has not found it, which is the
          opposite of what the empty state below is saying.
        */}
          {trainings.length > 0 ? (
            <div className="flex min-w-0 items-center gap-[12px] rounded-[12px] border border-[var(--line)] bg-[var(--well)] px-[18px]">
              <Search className="text-[color:var(--faint)]" size={18} />
              <label className="sr-only" htmlFor={searchId}>Search the trainings</label>
              <input
                className="h-[48px] min-w-0 flex-1 border-0 bg-transparent text-[16px] leading-[1.4] text-[color:var(--ink)] outline-none placeholder:text-[color:var(--faint)]"
                id={searchId}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search the trainings"
                type="search"
                value={query}
              />
            </div>
          ) : null}
          <ContextEye
            copy={TIPS_EYE_COPY}
            placement="header"
            scale="coach"
            screen="coach-tips"
          />
        </div>
      </div>

      {trainings.length === 0 ? (
        /*
          The honest empty state, and the reason this page exists as a route at all: the surface is
          real, the catalogue is not. It says who owes the content and what will happen when it
          arrives, rather than "no results", which would read as a search that failed.
        */
        <DataState
          body="Your coaching team records these, and they will appear here as they are published. Nothing is missing from your account."
          kind="empty"
          title="No trainings have been published yet"
        />
      ) : matches.length === 0 ? (
        <DataState
          body="No training matches that search. Clear the box to see all of them again."
          kind="empty"
          title="Nothing matches that search"
        />
      ) : (
        <div className="flex min-w-0 flex-col gap-[18px]">
          {featured ? <FeaturedTraining training={featured} /> : null}
          {rest.length > 0 ? (
            <div className="grid min-w-0 gap-[16px] md:grid-cols-2 xl:grid-cols-3">
              {rest.map((training) => (
                <TrainingCard key={training.id} training={training} />
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
