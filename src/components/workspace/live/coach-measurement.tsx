"use client";

import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";

import type { ColumnDef } from "@tanstack/react-table";

import { CoachScale } from "@/components/coach-scale";
import type { MetricAvailability } from "@/components/kit/headline-stat";
import {
  Figure,
  kitButtonClass,
  MonoMeta,
  Prose,
  Segmented,
  StatusDot,
  Surface,
  SurfaceHeader,
} from "@/components/kit/atomics";
import { identityColumn } from "@/components/kit/columns";
import {
  CoachDeck,
  DeckStats,
  type CoachDeckItem,
  type DeckStat,
} from "@/components/workspace/live/coach-deck";
import {
  CoachCarrierNotice,
  CoachChannelStatusLine,
  type CoachChannelStatus,
} from "@/components/workspace/live/coach-channel-status";
import { CoachPageHead } from "@/components/workspace/live/coach-page-head";
import { DataState } from "@/components/kit/data-state";
import { DataTable } from "@/components/kit/data-table";
import { SegmentedControl } from "@/components/kit/segmented-control";
import { TrendPanel } from "@/components/kit/trend-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  availableMetric,
  metricDefinition,
  type MetricEvidence,
  type MetricKey,
} from "@/lib/analytics/metric-definitions";
import { workspaceCountFormat, workspaceDateFormat } from "@/lib/format/datetime";
import { formatMetric } from "@/lib/format/metric";
import type {
  CoachLeadComposition,
  CoachMeasurement,
  CoachMeasurementWindow,
} from "@/lib/repositories/analytics";
import { STEP_LABELS } from "@/components/onboarding/view-models";
import type { ProvisioningStep } from "@/lib/onboarding/contracts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { workspaceTimestampFormat } from "@/lib/format/datetime";

type CoachAttention = {
  threadsNeedingHuman: number;
  leadsToCallBack: number;
  blockedSetupSteps: number;
  /**
   * The facts each queue line needs to say why it is waiting, read from the columns the page
   * already queries. Every one of them is optional: an older caller, or a read that found nothing,
   * renders the count with no sentence rather than a plausible one.
   */
  oldestThreadWaitMinutes?: number | null;
  noShows?: number;
  longTermFollowUps?: number;
  blockedStepKey?: ProvisioningStep | null;
  openConversations?: number;
};

/**
 * A channel that used to work and has stopped, with the custody facts screen 5d opens on.
 *
 * `unprocessedEvents` counts `webhook_events` rows sitting at `failed` for this provider. It is
 * events, not threads, and `null` when the read failed rather than zero, which is a different
 * claim: one says nothing is waiting, the other says we could not find out.
 */
export type BlockedChannel = {
  channelLabel: string;
  connectionId: string;
  /** `channel_connections.error`, verbatim, or null where nothing recorded a cause. */
  providerReason: string | null;
  unprocessedEvents: number | null;
  signedRoundTripAt: string | null;
  state: string;
  stoppedAt: string;
};

type CoachMeasurementProps = {
  attention: CoachAttention;
  blockedChannel?: BlockedChannel | null;
  measurement: CoachMeasurement;
  composition: CoachLeadComposition;
  window: CoachMeasurementWindow;
  customFrom?: string | null;
  customTo?: string | null;
  impersonation?: { sessionId: string; tenantId: string } | null;
  /**
   * What the coach has already set, or `null` when nothing is published and there is therefore
   * nothing of theirs running. Optional so the surface still renders under a caller that has not
   * plumbed the offer read, which is the state every unit fixture is in.
   */
  /**
   * The coach's own first name, for the greeting, or null when there is nobody to greet.
   *
   * Null covers three different situations and deliberately renders the same way in all of them:
   * the read failed, `users.full_name` is empty, or a platform user is reading this page under
   * impersonation. The last is the one that matters -- the reader is real and has a name, and it
   * is the wrong name to put at the top of somebody else's dashboard.
   */
  greeting?: string | null;
  /**
   * What the agent is answering on, and where the text registration has got to. Optional because
   * every unit fixture renders without it, and because a page whose channel read failed should
   * lose a status line rather than the whole screen.
   */
  channelStatus?: CoachChannelStatus | null;
};

/*
 * The faces come from the kit now: `Surface` carries `.surface-card`, `.surface-well` and the
 * panel variant, and `Figure` / `MonoMeta` / `Prose` carry the type roles. What is left here is
 * the layout the recipes have no opinion about, plus the `@container/card` each card lays itself
 * out against so a table holds its shape at 1000px instead of sprawling to the viewport.
 *
 * **The labels are `.coach-eyebrow`, not the kit's `Overline`.** `Overline` renders 9.5px
 * uppercase mono in `--overline`, which `tokens.css:111` measures at 4.8:1 and files under label
 * weight only, and `docs/DESIGN.md` scopes to "the owner console, and only the owner console".
 * Seven of them were mounted here, on the surface built for the reader who found the console hard
 * to read. `Main.dc.html` settles what belongs instead, and it is not the same label at a bigger
 * size: every panel label on the coach Home artboard -- "Agent analytics", "Pipeline", "Company
 * trend", "Where your leads come from" -- is 14px, sentence case, proportional, in `--muted`. The
 * only uppercase mono on that artboard is a 13px chip reading DEMO WORKSPACE DATA, which is a
 * badge and not a label. `.coach-eyebrow` in `coach.css` is exactly that recipe and its comment
 * already names it "the coach scale's replacement for the 9.5px uppercase mono overline".
 */
const CARD_TITLE_CLASS = "m-0 text-[15px] leading-[1.3] font-semibold text-[color:var(--ink)]";
const CARD_SUB_CLASS = "m-0 text-[12.5px] leading-[1.45] text-[color:var(--faint)]";

/**
 * The page's single accent fill. It belongs to whatever clears the top of the attention queue and
 * to nothing else, so a page with an empty queue spends no fill at all.
 */
const ACCENT_FILL_CLASS =
  "inline-flex h-[34px] shrink-0 items-center justify-center rounded-[9px] border border-[var(--accent-line)] bg-[var(--accent-fill)] px-[15px] text-[13px] leading-none font-semibold text-[color:var(--on-accent)] shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_8px_20px_-8px_var(--accent)]";

/**
 * The attention card's ground, which is now the ordinary card face every other panel on Home
 * carries -- `--card` under the shared hairline, at the shared radius.
 *
 * It used to be the warning recipe: `--warning-wash` as a radial off the top-left corner inside a
 * `--warning-line` frame all the way round. Two things were wrong with that. The card sits inside
 * the page's own framed pane, so a second frame in a second colour read as a table that had lost
 * its header rather than as a card; and the wash tinted all three rows alike, including the rows
 * that are merely busy -- two leads to call back is a normal Tuesday, not an incident. State is
 * carried by the warning dot beside the title and by the warning figure on the rows whose count is
 * above zero, which is the same rule the rest of the product follows: a dot, a fill, or a chip,
 * never a frame or an edge stripe.
 */
const ATTENTION_CARD_CLASS =
  "@container/card surface-card min-w-0 px-[17px] py-[16px]";

/**
 * The one action face on this card, and every row wears it.
 *
 * The three rows used to disagree with each other -- row one had a 34px accent fill floated to the
 * far right of the card, rows two and three had accent text links at a different x -- so a coach
 * scanning down the card met three different affordances for the same kind of move. The only thing
 * here allowed to be louder is the reconnect action on an outage, which is a different kind of item
 * and leads the card rather than joining the list; it differs by variant, not by size.
 *
 * The size is `lg` rather than the `sm` the kit calls "an action inside a queue row", because that
 * sentence is written against the console's 26/30/34px scale and the coach shell does not run it:
 * `coach.css:599` floors every `a[href]` at `--coach-target`, 44px. An `sm` button therefore
 * renders 80x44 -- 10px of side padding around 12px text inside a 44px box, which reads as a squat
 * chip rather than a button. `lg` is the size whose padding and 13px text are proportionate once
 * the floor has had its say, and it is the size the coach body copy is set at.
 */
const ATTENTION_ACTION_CLASS = kitButtonClass({ size: "lg", variant: "secondary" });

/**
 * How a deck sentence names the window it is counting over.
 *
 * The artboard writes every sentence against a month -- "ruled out this month", "reached this
 * month", "the 18 calls booked this month" -- because a month is the window it happens to draw.
 * The window here is a control the coach sets, so a fixed "this month" is false on five of the
 * six settings, and a sentence that lies about its own window is worse than one that reads a
 * little more stiffly. These are the phrases that make each sentence true at every setting, and
 * on the default 1M window they render the artboard's wording exactly.
 */
const WINDOW_PHRASE: Record<CoachMeasurementWindow, string> = {
  "1d": "today",
  "1w": "this week",
  "1m": "this month",
  "3m": "in the last three months",
  all: "since you started",
  custom: "in the window you picked",
};

/**
 * What each deck panel says about its own figure.
 *
 * Held as a table rather than written into the JSX because the deck is built by mapping over the
 * key list: the alternative is six near-identical blocks, which is how the eyebrow and the
 * sentence drift apart from the metric they belong to. Every sentence describes what the query
 * counts, not what it means -- `metric-definitions` owns the denominators and this must not become
 * a second, prettier version of them.
 *
 * **`name` is coach language, not the metric's label, and that is a deliberate reversal.** The
 * deck used to name every panel `metricDefinition(key).label`, which is written for whoever has to
 * reason about the query: "Disqualified leads", "Lead-to-booked conversion". The artboard names
 * the same six things the way the coach says them -- "Not a fit", "Conversion" -- and this is the
 * surface built for a reader who told us in round-1 feedback that the product read like a
 * database. The metric's own label has not gone anywhere: it is the `<dt>` of the "How these are
 * measured" list further down the page, which is where a reader who wants the exact denominator
 * goes, and which is now the only place either name appears twice.
 */
const DECK_COPY: Record<string, {
  eyebrow: string;
  name: string;
  sentence: (windowPhrase: string, isDemo: boolean) => string;
}> = {
  "coach.booked_contacts": {
    eyebrow: "Won outcome",
    name: "Booked",
    sentence: (when) => `Leads who took a slot on your calendar ${when}.`,
  },
  "coach.disqualified_leads": {
    eyebrow: "Agent analytics",
    name: "Not a fit",
    /*
     * The second half is a claim about another screen and it was checked before it was written.
     * `contacts.outcome` is a stored enum (`SOFT_DQ` / `HARD_DQ`), and `coach-pipeline.tsx` and
     * `coach-contacts.tsx` both render a reason line off it on the lead's own row -- "The lead did
     * not meet the current qualification rules." So the reason really does stay on each one, and
     * the sentence is telling the coach where to go rather than reassuring them in the abstract.
     */
    sentence: (when) =>
      `Leads your agent ruled out ${when}, so you never had to. The reason stays on each one.`,
  },
  "coach.active_leads": {
    eyebrow: "Agent analytics",
    name: "Active",
    sentence: () =>
      "Leads the agent is talking to now, not counting finished or ruled-out conversations.",
  },
  "coach.conversion_rate": {
    eyebrow: "Pipeline",
    name: "Conversion",
    sentence: (when) => `The share of leads who wrote in ${when} and ended up booking a call.`,
  },
  "coach.new_leads": {
    eyebrow: "Agent analytics",
    name: "Leads",
    /*
     * The artboard's second half is "Test conversations are left out", which is true of a real
     * workspace and false of this one when `isDemo` is set: the demo tenant's whole point is that
     * its seeded rows are counted, and the page's own provenance chip says so at the top. So the
     * clause follows the workspace rather than being printed unconditionally. A sentence that
     * promises a filter the surface is not applying is the same defect as an invented figure --
     * it is just a claim about the population instead of about the count.
     */
    sentence: (when, isDemo) => `Everyone your agent reached ${when}. ${isDemo
      ? "This is the demo workspace, so its seeded conversations are counted."
      : "Test conversations are left out."}`,
  },
  "coach.average_time_to_book": {
    eyebrow: "Agent analytics",
    name: "Avg time to book",
    /*
     * Two approximations in one sentence, both of them small enough to keep and both worth
     * naming. The metric measures `contacts.created_at` to the first appointment's `created_at`,
     * so "a lead's first message" is really the moment the contact row appeared, which for an
     * inbound lead is the same event, and "a call on your calendar" is the moment the booking was
     * made rather than the moment the call happens. The exact definition is one disclosure away in
     * "How these are measured"; this is the sentence a coach can read at a glance.
     */
    sentence: () => "Average time from a lead's first message to a call on your calendar.",
  },
};

/**
 * The deck's own order, and it is the artboard's rather than the funnel's.
 *
 * Outcome first, then what the agent absorbed, then what it is still working, then the rate, then
 * the intake it all came from, then how long it took. `coach.qualified_leads` left the deck when
 * this order arrived: it was a seventh panel whose figure now appears as a supporting reading in
 * two footers, under the two panels a coach actually asks it about. Six panels is the point --
 * the deck's failure mode is a screen where every figure is equally loud.
 */
const DECK_KEYS = [
  "coach.booked_contacts",
  "coach.disqualified_leads",
  "coach.active_leads",
  "coach.conversion_rate",
  "coach.new_leads",
  "coach.average_time_to_book",
] as const satisfies readonly MetricKey[];

/**
 * The metrics the "How these are measured" disclosure spells out the denominator for.
 *
 * Derived from `DECK_KEYS` rather than listed beside it, because the list's whole job is to cover
 * every figure the page draws: a hand-written copy drifted the moment a panel was added or
 * removed, and a denominator list that silently omits one of the six figures is worse than no
 * list, since a reader who finds four of their five numbers explained concludes the fifth needs no
 * explaining. `coach.qualified_leads` is appended because it left the deck but stayed on the page
 * as a footer reading under two panels, and a number on screen with no stated denominator is
 * exactly what this disclosure exists to prevent.
 */
const SUMMARY_KEYS = [
  ...DECK_KEYS,
  "coach.qualified_leads",
] as const satisfies readonly MetricKey[];



/**
 * Two names per window on purpose: `pill` is the word `Main.dc.html:114-118` draws on the button,
 * `label` is the full phrase the caption under the deck names the same window by.
 *
 * The pills used to read `1D / 1W / 1M / 3M / ALL`, with the full phrase carried alongside in an
 * `sr-only` span because an abbreviation has to announce what it abbreviates. The artboard draws
 * words -- `Today`, `Week`, `Month`, `3 months`, `All` -- so there is no abbreviation left to
 * expand, and the hidden span went with the shorthand rather than being kept out of habit.
 * `Custom` has no pill on the artboard; the window exists in the code, so it keeps the plain
 * word rather than inventing a drawing for it.
 */
export const WINDOW_OPTIONS = [
  { value: "1d", pill: "Today", label: "1 day" },
  { value: "1w", pill: "Week", label: "1 week" },
  { value: "1m", pill: "Month", label: "1 month" },
  { value: "3m", pill: "3 months", label: "3 months" },
  { value: "all", pill: "All", label: "All history" },
  { value: "custom", pill: "Custom", label: "Custom" },
] as const satisfies ReadonlyArray<{ value: CoachMeasurementWindow; pill: string; label: string }>;

/**
 * The disclosure every figure block on this page carries.
 *
 * The summary is `--muted`, not `--accent-text`. Three accent-coloured summaries plus the queue's
 * fill spent the accent four times on one screen, and the Ownership Rule says the accent marks what
 * the coach owns or must act on. Reading how a number was computed is neither.
 */
function Method({ children, summary }: { children: ReactNode; summary: string }) {
  return (
    <details className="text-[12.5px] leading-[1.5] text-[color:var(--muted)]">
      <summary className="w-fit cursor-pointer font-medium hover:text-[color:var(--ink)]">
        {summary}
      </summary>
      <div className="mt-[var(--s-2)] flex flex-col gap-[var(--s-3)]">{children}</div>
    </details>
  );
}

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Saved billing boundary" : workspaceDateFormat.format(date);
}

/**
 * A composition month's name written out, falling back to the label the server sent.
 *
 * The RPC labels its months "Aug 2026", which is right on an axis and wrong in a sentence -- "Aug
 * is lighter because the month is not over yet" reads as a word that got cut off. The fallback is
 * not defensive padding: `month` is a date string from the database and this runs in the browser,
 * so a value the client's `Intl` cannot parse should degrade to the label the server already
 * computed rather than leave a sentence with a hole in it.
 */
const longMonthFormat = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" });

function longMonth(month: string, fallback: string) {
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/u.test(month) ? `${month}T00:00:00.000Z` : month);
  return Number.isNaN(parsed.getTime()) ? fallback : longMonthFormat.format(parsed);
}

/**
 * The chart's own download, which is a plain anchor over a blob rather than the kit's export menu.
 *
 * Two reasons, and the second is the load-bearing one. The table below has a server export because
 * the rows a coach sees there are a page of a larger set and the server is the only thing that can
 * hand over the rest; the trend is six numbers that are already entirely in the browser, so
 * round-tripping them through an export route would add a failure mode to a file we can write
 * synchronously. And the page is meant to carry exactly one export menu -- the one on the table --
 * so a second one here would say there are two exportable tables on the screen when there is one.
 *
 * The blob URL is revoked on the next tick rather than left to the page's lifetime. A coach who
 * switches windows a dozen times should not accumulate a dozen retained files.
 */
function TrendDownload({ months }: { months: CoachLeadComposition["months"] }) {
  if (months.length === 0) return null;

  function download() {
    const header = "month,leads,qualified,disqualified,active,partial";
    const rows = months.map((month) => [
      month.month,
      month.total,
      month.qualified,
      month.disqualified,
      month.active,
      // The partial flag travels with the row. A month that is still filling reads low, and a
      // spreadsheet that does not say which month that is invites the same wrong conclusion the
      // note under the chart exists to prevent.
      month.partial ? "still filling" : "complete",
    ].join(","));
    const blob = new Blob([[header, ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "setterfi-leads-by-month.csv";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <button className={MUTED_LINK_CLASS} onClick={download} type="button">
      Download
    </button>
  );
}

function dayProgress(evidence: MetricEvidence, asOf: string) {
  const start = evidence.windowStart ? Date.parse(evidence.windowStart) : Number.NaN;
  const end = evidence.windowEnd ? Date.parse(evidence.windowEnd) : Number.NaN;
  const now = Date.parse(asOf);
  if (![start, end, now].every(Number.isFinite) || end <= start || now < start) {
    return null;
  }
  const day = 86_400_000;
  const needs = Math.max(1, Math.ceil((end - start) / day));
  return {
    days: Math.min(needs, Math.max(1, Math.ceil((Math.min(now, end) - start) / day))),
    needs,
  };
}

function metricFormat(evidence: MetricEvidence) {
  const unit = metricDefinition(evidence.metricKey).unit;
  if (unit === "percent") return "percent" as const;
  if (unit === "seconds" || unit === "days") return "duration" as const;
  return "count" as const;
}

function metricAvailability(
  evidence: MetricEvidence | undefined,
  asOf: string,
): MetricAvailability {
  if (!evidence) {
    return { kind: "unavailable", note: "No sourced reading is available for this window." };
  }

  const definition = metricDefinition(evidence.metricKey);
  if (
    definition.requiresPositiveDenominator
    && (evidence.denominator === null
      || !Number.isFinite(evidence.denominator)
      || evidence.denominator <= 0)
  ) {
    return {
      kind: "unavailable",
      note: "There is no eligible activity for this calculation.",
    };
  }

  const value = availableMetric(evidence);
  if (value !== null) {
    if (value === 0 && definition.unit === "count") {
      return { kind: "no-events", note: "No matching leads yet" };
    }
    return { kind: "value", value, format: metricFormat(evidence) };
  }

  if (evidence.state === "still_filling" || evidence.state === "needs_more_history") {
    const progress = dayProgress(evidence, asOf);
    return progress
      ? { kind: "needs-history", ...progress }
      : { kind: "unavailable", note: "No valid history clock is available for this window." };
  }
  return { kind: "unavailable", note: "This window has no sourced reading yet." };
}


/**
 * A metric's reading as a short string for a footer slot, or null when there is not one.
 *
 * Null is the whole point. A footer stat is drawn small and beside another one, which is precisely
 * the position where a plausible-looking number does the most damage, so this refuses to fall back
 * to a zero, a dash or the headline's own figure: it returns a reading when `metricAvailability`
 * says there is a reading, and nothing otherwise, and `DeckStats` prints the absence in words.
 */
function footerReading(
  measurement: CoachMeasurement,
  key: MetricKey,
  asOf: string,
): string | null {
  const evidence = measurement.metrics.find((metric) => metric.metricKey === key);
  const availability = metricAvailability(evidence, asOf);
  if (availability.kind === "value") {
    return formatMetric(availability.value, availability.format);
  }
  if (availability.kind === "no-events") return formatMetric(0, "count");
  return null;
}

/**
 * The supporting readings under each panel, and the four the artboard draws that our reads cannot
 * produce.
 *
 * This is the part of the artboard that does not survive contact with the schema, and each refusal
 * is here rather than in the report because the next person to open `Main.dc.html` beside this
 * file will otherwise spend an afternoon rediscovering it.
 *
 * **"Worth keeping warm" / "Ended politely", under Not a fit.** The artboard splits 37 ruled-out
 * leads into 21 and 16, which is a partition, and we cannot make one. The natural candidate is
 * `contacts.outcome`: `SOFT_DQ` really does mean the lead may be a better fit later and `HARD_DQ`
 * really does mean the conversation ended, and `analytics_contacts` carries the column. But no key
 * in `COACH_METRIC_KEYS` projects it, and adding one is not a local change --
 * `parseMetricEvidenceRows` refuses any payload whose row count disagrees with the expected key
 * list, so a twenty-first key would crash every coach dashboard read against hosted until the RPC
 * shipped the matching row. The other candidate, splitting on `pipeline_stage`, is worse than
 * unavailable: `long_term_followup` is the kept-warm stage and `coach.active_leads` already counts
 * it, so the split would put the same contact inside both this panel and the one beside it.
 *
 * **"Answered back", under Leads.** Summing `respondedConversations` across the keyword rows does
 * produce a real number, and it is not this one. It counts conversations, the figure above it
 * counts contacts, and the keyword disclosure on this same page already says the two can differ
 * when a contact returns through another campaign. A coach reading "Leads 214 / Answered back 138"
 * will read 138 of those 214, which is the one thing the number does not mean.
 *
 * What is here instead are readings from the same cohort as the figure they sit under, or, where
 * the population differs, a note saying so in words. Two of the three notes exist for that reason
 * alone: open conversations are not the active-contact cohort, and the billing period is not the
 * analytics window.
 */
function deckFooter(
  key: MetricKey,
  measurement: CoachMeasurement,
  attention: CoachAttention,
  asOf: string,
): {
  stats: readonly DeckStat[];
  note?: string;
  layout?: "pair" | "rows" | "caption";
  meter?: number | null;
} | null {
  const reading = (metric: MetricKey) => footerReading(measurement, metric, asOf);

  if (key === "coach.booked_contacts") {
    const { allowance } = measurement;
    return allowance.state === "available"
      ? {
        /*
         * `caption`, because this footer annotates the bar under it rather than standing as a
         * reading of its own -- `Main.dc.html:156-159` puts the allowance hard left and its label
         * hard right on one baseline, 14px above the meter.
         */
        layout: "caption" as const,
        stats: [{
          label: "Monthly plan progress",
          value: `${workspaceCountFormat.format(allowance.used)} / ${workspaceCountFormat.format(allowance.limit)}`,
        }],
        /*
         * The bar is drawn only where there is a real allowance to divide by. A limit of zero
         * makes the share undefined, and a full bar over "0 / 0" would tell a coach they are at
         * their plan's limit when the record says there is no limit recorded at all.
         */
        meter: allowance.limit > 0 ? allowance.used / allowance.limit : null,
        note: `Counted over your billing period, ${dateLabel(allowance.periodStart)} to ${dateLabel(allowance.periodEnd)}, not the window above.`,
      }
      : {
        layout: "caption" as const,
        stats: [{ label: "Monthly plan progress", value: null }],
        note: "There is no active billing period to count an allowance against.",
      };
  }

  if (key === "coach.disqualified_leads") {
    return {
      layout: "rows",
      stats: [
        { label: "Worth keeping warm", tone: "waiting", value: null },
        { label: "Ended politely", tone: "quiet", value: null },
      ],
      note: "Ruled-out leads are not stored split into these two, so neither is counted here.",
    };
  }

  if (key === "coach.active_leads") {
    // Both halves come from `conversations`, read at one instant with one test filter, so the
    // pair is internally consistent and its own total is the sum of the two figures the panel
    // draws. It used to be checkable against a header readout as well; that readout is off the
    // page per spec §2.1, so the note below is now the only thing naming the population, and it
    // has to keep doing so -- what this is not is a slice of the contact figure above it.
    const open = attention.openConversations;
    const handled = typeof open === "number"
      ? Math.max(0, open - attention.threadsNeedingHuman)
      : null;
    return {
      layout: "rows",
      stats: [
        {
          label: "Agent handling",
          tone: "good",
          value: handled === null ? null : workspaceCountFormat.format(handled),
        },
        {
          label: "Needs you",
          tone: "waiting",
          value: workspaceCountFormat.format(attention.threadsNeedingHuman),
        },
      ],
      note: "Counted over open conversations, which is a different population from the leads above.",
    };
  }

  if (key === "coach.conversion_rate") {
    return {
      stats: [
        { label: "Qualified", value: reading("coach.qualified_leads") },
        { label: "Booked", value: reading("coach.booked_contacts") },
      ],
    };
  }

  if (key === "coach.new_leads") {
    return {
      stats: [
        { label: "Answered back", value: null },
        { label: "Qualified", value: reading("coach.qualified_leads") },
      ],
      note: "Replies are counted per conversation, not per lead, so they are not shown against this figure.",
    };
  }

  if (key === "coach.average_time_to_book") {
    /*
     * The basis line, and it is the metric's own denominator rather than a second count of
     * bookings. `coach.average_time_to_book` averages over "selected-cohort contacts with a first
     * non-canceled appointment", and that count is what `denominator` carries, so the sentence
     * names the exact population the average was taken over. Reading `coach.booked_contacts`
     * instead would usually agree and would quietly stop agreeing the moment either definition
     * moved, which is the kind of drift a stated basis exists to make impossible.
     */
    const evidence = measurement.metrics.find(
      (metric) => metric.metricKey === "coach.average_time_to_book",
    );
    const basis = evidence?.denominator;
    if (typeof basis !== "number" || !Number.isFinite(basis) || basis <= 0) return null;
    return {
      stats: [],
      note: `Measured over the ${workspaceCountFormat.format(basis)} calls booked ${WINDOW_PHRASE[measurement.window]}.`,
    };
  }

  return null;
}

/**
 * The deck's figures, read straight from the measurement.
 *
 * It goes through `metricAvailability` for exactly the reason that function exists: the five ways
 * a figure can be absent are the page's whole honest-states story, and a deck that computed its
 * own availability would be a second opinion about whether a number is real.
 *
 * Only the first panel is drenched. Round 3's failure mode was a deck where every panel wanted to
 * be the important one, and the accent only reads as emphasis while it stays scarce.
 */
function deckItems(
  measurement: CoachMeasurement,
  attention: CoachAttention,
  asOf: string,
): CoachDeckItem[] {
  const when = WINDOW_PHRASE[measurement.window];
  return DECK_KEYS.map((key, index) => {
    const copy = DECK_COPY[key];
    const footer = deckFooter(key, measurement, attention, asOf);
    return {
      availability: metricAvailability(
        measurement.metrics.find((metric) => metric.metricKey === key),
        asOf,
      ),
      /*
       * Two drenches and no more, which is `Main.dc.html`'s own count and the accent rule stated
       * as a number: `live` on Booked, the outcome the coach opened the page for, and `info` on
       * Conversion, the one figure that is a judgement about the whole funnel rather than a count
       * of one stage. Keyed by metric rather than by index so re-ordering the deck cannot move an
       * accent onto whatever happens to land in fourth place.
       */
      drench: index === 0
        ? ("live" as const)
        : key === "coach.conversion_rate"
          ? ("info" as const)
          : undefined,
      eyebrow: copy.eyebrow,
      footer: footer
        ? (
          <DeckStats
            layout={footer.layout}
            meter={footer.meter}
            note={footer.note}
            stats={footer.stats}
          />
        )
        : undefined,
      hero: index === 0,
      name: copy.name,
      sentence: copy.sentence(when, measurement.isDemo),
    };
  });
}

type KeywordRow = CoachMeasurement["keywords"][number];

/**
 * A keyword count column. `Main.dc.html` draws four columns of plain counts, and what stood here
 * was five with three of them rendered as percentages of the conversation count.
 *
 * The rates were derivable -- every numerator and the denominator are counts the RPC already
 * returns -- so dropping to counts loses no fact, and it gains two. A percentage over a single-
 * digit denominator reads as precision the row does not have ("50%" off one conversation of two),
 * and the rate cells needed a whole absent-figure treatment for the keyword with no conversations
 * at all, where the honest count is simply 0. Anyone who wants the share can read it off the row,
 * which is the arithmetic the artboard expects a coach to do.
 *
 * The share columns were also not comparable with each other: `qualifiedContacts` and
 * `bookedContacts` count contacts while `conversations` counts conversations, so two of the three
 * percentages were contacts over conversations. As counts they each say what they are.
 */
function stageColumn(
  id: string,
  header: string,
  countOf: (row: KeywordRow) => number,
  denominatorOf: (row: KeywordRow) => number,
  mode: "count" | "percent",
): ColumnDef<KeywordRow> {
  return {
    id,
    accessorFn: countOf,
    header,
    enableHiding: true,
    enableSorting: true,
    meta: {
      // A figure in a table cell is mono or it is wrong: the counts read down one column only when
      // the digits sit in one column, which is what tabular mono buys here.
      cellClassName: "text-right font-[family-name:var(--font-mono)] tabular-nums",
      headerClassName: "text-right",
      label: header,
    },
    cell: ({ row }) => {
      const count = countOf(row.original);
      if (mode === "count") return workspaceCountFormat.format(count);
      const denominator = denominatorOf(row.original);
      if (denominator === 0) return "not yet";
      return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(
        (count * 100) / denominator,
      )}%`;
    },
  };
}

/**
 * Four columns, as the artboard draws them, with one substitution: its "Leads" header sits over
 * what this platform counts as conversations, and `conversations` is the column the keyword
 * attribution and the conservation check in `analytics.ts` are both written against. Calling a
 * conversation count "Leads" on a page whose other panels count leads would be the kind of quiet
 * mislabel that survives for months.
 *
 * "Responded" is the column the canvas does not draw, and it goes. It is the weakest of the four
 * for a coach choosing where to spend -- a reply is not an outcome -- and it stays in the CSV
 * through `COACH_KEYWORD_COLUMNS`, so nothing is lost to anyone who wants it.
 */
function keywordColumns(
  mode: "count" | "percent",
  optInDenominator: number,
): ColumnDef<KeywordRow>[] {
  return [
    identityColumn<KeywordRow, string>({
      accessor: (row) => row.keyword,
      header: "Keyword",
      id: "keyword",
    }) as ColumnDef<KeywordRow>,
    stageColumn(
      "conversations", "Opt-ins", (row) => row.conversations,
      () => optInDenominator, mode,
    ),
    stageColumn(
      "qualified", "Qualified", (row) => row.qualifiedContacts,
      (row) => row.conversations, mode,
    ),
    stageColumn(
      "booked", "Booked", (row) => row.bookedContacts,
      (row) => row.conversations, mode,
    ),
  ];
}

const KEYWORD_EXPORT_COLUMNS = [
  "keyword", "conversations", "qualifiedContacts", "respondedConversations", "bookedContacts",
  "optInDenominator", "qualifiedDenominator", "bookedDenominator", "dataLabel",
] as const;

/**
 * The window switch, as screen 2a draws it: one row of pills rather than a dropdown and an
 * Apply button. Five of the six windows are a single fact each, so making the coach open a menu,
 * pick, then confirm asked for three gestures where the artifact asks for one.
 *
 * `scale="coach"` and no `face`, both read off `Main.dc.html:114-118`: the artboard draws 16px/500
 * proportional words in 44px pills, and the shared atomic renders 12px mono by default because
 * that is what the eight console artboards draw. The console's 12px stays the console's; this
 * mount asks for the coach density instead of the number being edited underneath the console.
 * Nothing here is tabular any more either -- the pills read `Today`, not `1D`.
 *
 * It stays a `GET` form rather than becoming a router push, because the window is a server read:
 * the URL is what the page is rendered from, and a control that changes the page without changing
 * the URL leaves a coach unable to reload or share what they are looking at. The pills write the
 * hidden field and submit it once the value has committed, which is why the submit waits a render
 * rather than firing inside the click.
 *
 * Custom is the one window that needs two more facts before it can be read, so it alone reveals
 * the date fields and keeps an explicit Apply. The segmented control is never the accent: a period
 * switch is not the page's live action, and the queue above it already owns the page's one fill.
 */
function MeasurementPicker({
  window,
  customFrom,
  customTo,
}: {
  window: CoachMeasurementWindow;
  customFrom: string | null;
  customTo: string | null;
}) {
  const [selectedWindow, setSelectedWindow] = useState<CoachMeasurementWindow>(window);
  const formRef = useRef<HTMLFormElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);

  return (
    // A `<form>` needs `method`, which `Surface`'s prop type does not carry, so this one reaches
    // the well through the globals recipe directly rather than through the component.
    <form
      aria-label="Performance window"
      className="surface-well flex min-w-0 flex-wrap items-end gap-[var(--s-3)]"
      method="get"
      ref={formRef}
    >
      <div className="flex min-w-0 flex-col gap-[var(--s-1)]">
        <span className="coach-eyebrow">Performance window</span>
        {/* Uncontrolled on purpose. The submitted value is written to the field and the form is
            submitted in the same gesture, so there is no render to wait for and no effect that
            sets state to schedule one. */}
        <input defaultValue={window} name="window" ref={fieldRef} type="hidden" />
        <Segmented
          label="Performance window"
          onValueChange={(next) => {
            setSelectedWindow(next as CoachMeasurementWindow);
            if (next === "custom") return;
            if (fieldRef.current) fieldRef.current.value = next;
            formRef.current?.requestSubmit();
          }}
          options={WINDOW_OPTIONS.map((option) => ({
            key: option.value,
            label: option.pill,
          }))}
          scale="coach"
          value={selectedWindow}
        />
      </div>
      {selectedWindow === "custom" ? (
        <>
          <label className="flex flex-col gap-[var(--s-1)]">
            <span className="coach-eyebrow">From</span>
            <Input defaultValue={customFrom ?? ""} name="from" type="date" />
          </label>
          <label className="flex flex-col gap-[var(--s-1)]">
            <span className="coach-eyebrow">To</span>
            <Input defaultValue={customTo ?? ""} name="to" type="date" />
          </label>
          <Button type="submit" variant="outline">Apply</Button>
        </>
      ) : null}
    </form>
  );
}

/**
 * One amber frame, three sources, and the queue is the only thing on this page allowed to hold
 * attention weight: it carries the page's single glow on its dot and the page's single accent
 * fill on the verb that clears whatever sits at the top of it. A waiting conversation outranks a
 * waiting lead, which outranks a blocked setup step, so the fill always points at the most urgent
 * of the three and the rest demote to accent-text links rather than a second lit control.
 *
 * When every source is empty the queue stops being an attention surface: it drops to the flattest
 * face in the system and says so in one sentence. Three tiles reading zero claimed the coach still
 * had a queue to work, which is the opposite of what an empty queue means. No banner, no green,
 * no "all set" -- just the absence, stated.
 */
function waitSentence(minutes: number | null | undefined) {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) return null;
  if (minutes < 1) return "The oldest arrived less than a minute ago.";
  if (minutes < 60) return `The oldest has waited ${minutes} min.`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `The oldest has waited ${hours} ${hours === 1 ? "hour" : "hours"}.`;
  const days = Math.floor(hours / 24);
  return `The oldest has waited ${days} ${days === 1 ? "day" : "days"}.`;
}

/**
 * The callback line's own composition, counted rather than described.
 *
 * The count above it is the sum of two pipeline stages, so this says which two and how many of
 * each. It renders nothing when the caller supplies no split: "no shows and long term follow ups"
 * with no numbers behind it is a sentence about the query rather than about the coach's leads.
 */
function callbackSentence(attention: CoachAttention) {
  const noShows = attention.noShows;
  const followUps = attention.longTermFollowUps;
  if (typeof noShows !== "number" || typeof followUps !== "number") return null;
  const parts = [
    noShows > 0 ? `${noShows} ${noShows === 1 ? "no show" : "no shows"}` : null,
    followUps > 0 ? `${followUps} long term follow ${followUps === 1 ? "up" : "ups"}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : `${parts.join(" and ")}.`;
}

function blockedSentence(attention: CoachAttention) {
  if (!attention.blockedStepKey) return null;
  const label = STEP_LABELS[attention.blockedStepKey];
  return attention.blockedSetupSteps > 1
    ? `${label} is blocked, and so is one other step.`
    : `${label} is blocked and cannot finish on its own.`;
}

/**
 * The recorded cause, said in words a coach can act on, or verbatim when we cannot translate it.
 *
 * The stored values are enum-ish tokens written by the platform rather than sentences written by
 * a provider, so a raw `LEGACY_CREDENTIAL_REAUTHORIZATION_REQUIRED` on a coach's screen is SQL
 * shouting at somebody it was not addressed to. Only tokens that can be enumerated are translated.
 * Anything else is shown exactly as stored: a cause we cannot phrase is still a cause, and hiding
 * it would put the surface back in the state this function exists to fix.
 */
const PROVIDER_REASONS: Record<string, string> = {
  LEGACY_CREDENTIAL_REAUTHORIZATION_REQUIRED:
    "This sign in predates our current credential system, so it can no longer be used. Reconnecting is what fixes it.",
};

export function providerReasonSentence(reason: string | null) {
  if (!reason) return null;
  return PROVIDER_REASONS[reason] ?? reason;
}

function stoppedLabel(at: string) {
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime())
    ? "at a time we could not read"
    : workspaceTimestampFormat.format(parsed);
}

/**
 * What the coach is owed about a channel that has stopped, and nothing more.
 *
 * Screen 5d draws four facts. Two are real, one is real but empty in production today, and one
 * cannot be stated at all:
 *
 * - **Signed out at** is the connection row's own `updated_at`.
 * - **Messages recorded and not answered** is a count of failed `webhook_events` for the
 *   provider. Events, not threads, and it says so, because nothing groups them by conversation.
 * - **The provider's reason** is `channel_connections.error`, and it **is** rendered when the row
 *   carries one. An earlier version of this comment refused it on the premise that every writer
 *   sets `null`; that premise was false.
 *   `20260905000010_backend_security_sagas.sql:62` writes
 *   `LEGACY_CREDENTIAL_REAUTHORIZATION_REQUIRED` on connections whose credential was quarantined,
 *   and those rows persist, so refusing the column hid the one recorded cause that exists from
 *   exactly the coach it was recorded for. The row is omitted, not blanked, where the column is
 *   null: an unrecorded cause is a fact, an invented one is a fabrication, and that is the
 *   contract `channel-connections.ts` states.
 * - **"What leads see: nothing, no failed sends" is not rendered.**
 *   `outbound_send_attempts` carries a status `indeterminate` whose own column comment reads
 *   "provider acceptance cannot be ruled out and automatic retry is forbidden". The schema
 *   explicitly models sends whose outcome is unknown, so promising a coach that no lead saw a
 *   failure would assert exactly what that status exists to deny.
 *
 * Step two names the signed round trip on purpose: nothing here reads connected until that
 * receipt comes back, which is a real gate rather than a reassurance.
 */
function BlockedChannelDialog({
  channel,
  onOpenChange,
  open,
}: {
  channel: BlockedChannel;
  onOpenChange: (next: boolean) => void;
  open: boolean;
}) {
  const rows: readonly { label: string; value: ReactNode }[] = [
    { label: "Stopped", value: stoppedLabel(channel.stoppedAt) },
    {
      label: "Messages recorded, not answered",
      value: channel.unprocessedEvents === null
        ? "could not be counted just now"
        : `${workspaceCountFormat.format(channel.unprocessedEvents)} `
          + `${channel.unprocessedEvents === 1 ? "event" : "events"}, not yet grouped into threads`,
    },
    { label: "Recorded state", value: channel.state },
  ];
  // Omitted rather than blanked when nothing recorded a cause. A row that can only read "none"
  // is the permanent-empty-field problem; an absent row is the honest absent arm.
  const recordedReason = providerReasonSentence(channel.providerReason);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      {/*
        `CoachScale` inside the portal, and it is load-bearing rather than tidy.

        Radix mounts `DialogContent` through `DialogPrimitive.Portal`, which appends to
        `document.body` -- outside the `[data-shell-role="coach"]` root `AppShell` stamps. Every
        rule in `coach.css` is written under that attribute, so `.coach-eyebrow` and every
        `--coach-*` token simply do not match in here: the browser drops the whole declaration and
        the text falls back to inherited size with nothing on screen saying so. That is the same
        escape that squared a chip on sixteen surfaces when `--r-pill` went undefined, and the same
        one that rendered the coach's own account menu at the console's density until the portalled
        content was stamped. Stamping it here rather than in `ui/dialog.tsx` keeps the primitive
        role-neutral, since admin mounts the same component and must not get the coach's scale.

        `display: contents` so the wrapper adds no box: `DialogContent` lays its own children out.
      */}
      <DialogContent>
        <CoachScale className="contents">
        <DialogHeader>
          <DialogTitle>Reconnect {channel.channelLabel}</DialogTitle>
          <DialogDescription>
            {channel.channelLabel} signed your setter out, so it is not replying there. Incoming
            messages are still being recorded.
          </DialogDescription>
        </DialogHeader>

        <dl className="m-0 grid gap-[var(--s-2)]">
          {rows.map((row) => (
            <div
              className="flex flex-wrap items-baseline justify-between gap-[var(--s-2)] border-b border-[var(--line-soft)] pb-[var(--s-2)] last:border-b-0"
              key={row.label}
            >
              <dt className="text-[12.5px] text-[color:var(--muted)]">{row.label}</dt>
              <dd className="m-0"><MonoMeta>{row.value}</MonoMeta></dd>
            </div>
          ))}
        </dl>

        {recordedReason ? (
          <div className="flex flex-col gap-[var(--s-1)]">
            <h3 className="coach-eyebrow">Recorded reason</h3>
            <Prose className="m-0" measure="wide">{recordedReason}</Prose>
          </div>
        ) : null}

        <div className="flex flex-col gap-[var(--s-2)]">
          <h3 className="coach-eyebrow">What happens next</h3>
          <ol className="m-0 flex list-none flex-col gap-[var(--s-2)] p-0">
            <li className="text-[12.5px] leading-[1.5] text-[color:var(--body)]">
              You sign in again. Nobody at SetterFi holds your password, so this step is yours.
            </li>
            <li className="text-[12.5px] leading-[1.5] text-[color:var(--body)]">
              We confirm the account and run a signed test message. Nothing reads connected until
              that comes back, and we do not promise how long it takes.
            </li>
            <li className="text-[12.5px] leading-[1.5] text-[color:var(--body)]">
              Messages that arrived while it was out stay on file. Sending them through is a
              separate step somebody runs per message, not something that happens on its own when
              you reconnect.
            </li>
          </ol>
        </div>

        <div className="flex flex-wrap items-center gap-[var(--s-3)]">
          <Link className={ACCENT_FILL_CLASS} href="/coach/integrations">
            Reconnect {channel.channelLabel}
          </Link>
          <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
            Not now
          </Button>
        </div>
        </CoachScale>
      </DialogContent>
    </Dialog>
  );
}

function AttentionQueue({
  attention,
  blockedChannel,
}: {
  attention: CoachAttention;
  blockedChannel: BlockedChannel | null;
}) {
  const sources = [
    {
      count: attention.threadsNeedingHuman,
      href: "/coach/conversations?stage=needs_human",
      note: "Open inbox",
      // Every one of these is read off a column on the page's own query. None is a rate, an
      // estimate or a prediction, so none of them can claim more than the count beside it.
      sentence: waitSentence(attention.oldestThreadWaitMinutes),
      title: "Threads needing a human",
    },
    {
      count: attention.leadsToCallBack,
      // The list this tile counts, not the whole leads console: `view=callback` renders exactly
      // the two stages the count is the sum of, in the order it makes sense to work them.
      href: "/coach/contacts?view=callback",
      note: "See the list",
      sentence: callbackSentence(attention),
      title: "Leads to call back",
    },
    {
      count: attention.blockedSetupSteps,
      href: "/coach/get-started",
      note: "Open setup",
      sentence: blockedSentence(attention),
      title: "Blocked setup steps",
    },
  ];
  /*
   * `waiting` decides whether the card exists at all; it no longer decides which rows render.
   *
   * A row used to vanish when its count reached zero, which is the one thing an attention queue
   * must not do: a coach who cleared the callback list saw the line disappear and had no way to
   * tell "nothing to call back" from "we stopped counting". The honest-states rule in `CLAUDE.md`
   * covers exactly this, so every row states its count including the zero, and only a card with
   * nothing at all on it collapses to the one calm line below.
   */
  const waiting = sources.filter((source) => source.count > 0);
  const primary = waiting[0] ?? null;
  const [outageOpen, setOutageOpen] = useState(false);

  /*
   * A dead channel outranks everything else in the queue, and it is a different kind of item, so
   * it leads the card rather than joining the list. A thread waiting on a human is one lead the
   * setter has escalated; a channel that has stopped is every lead on that channel getting no
   * reply at all, including the ones that have not arrived yet.
   *
   * It stays inside the one amber card. `docs/DESIGN.md` bans two stacked amber frames outright,
   * and an outage banner above the queue is exactly that.
   */
  if (!primary && !blockedChannel) {
    return (
      <Surface
        aria-labelledby="coach-attention-heading"
        as="section"
        className="flex min-w-0 flex-col gap-[var(--s-2)]"
        variant="strip"
      >
        <h2 className="coach-eyebrow" id="coach-attention-heading">
          What needs you today
        </h2>
        {/* 14px, which is the coach floor for helper text -- the same size the rows below use
            when there are any. An empty state a coach cannot read is not a calmer one. */}
        <Prose className="m-0 text-[14px] leading-[1.5] text-[color:var(--faint)]">
          Nothing is waiting on you right now.
        </Prose>
      </Surface>
    );
  }

  return (
    <section aria-labelledby="coach-attention-heading" className={ATTENTION_CARD_CLASS}>
      {blockedChannel ? (
        <BlockedChannelDialog
          channel={blockedChannel}
          onOpenChange={setOutageOpen}
          open={outageOpen}
        />
      ) : null}
      <div className="mb-[10px] flex min-w-0 items-center gap-[8px]">
        {/* The product's one glow, asked for by name so `glow-budget.test.ts` can see it. It is
            also the card's whole state signal now that the warning frame is gone. */}
        <StatusDot glow tone="warning" />
        <h2 className={CARD_TITLE_CLASS} id="coach-attention-heading">
          What needs you today
        </h2>
      </div>
      {blockedChannel ? (
        <div className="mb-[12px] flex flex-col gap-[9px] border-b border-[var(--line-soft)] pb-[12px]">
          <div>
            <p className="m-0 text-[14.5px] leading-[1.35] font-semibold text-[color:var(--ink)]">
              Your {blockedChannel.channelLabel} sign in stopped working
            </p>
            {/* The weaker sentence, and deliberately so. Messages arriving are recorded, which
                is provable; they do not replay on reconnect, which the artifact promised and no
                code does. See `loadBlockedChannel` for the three claims that were dropped. */}
            <p className="m-0 mt-[3px] max-w-[var(--measure-prose)] text-[14px] leading-[1.45] text-[color:var(--warning-body)]">
              Nothing is lost, and nothing is sent until you reconnect. Your setter cannot reply
              there until you sign in again.
            </p>
          </div>
          {/* The card's one fill, and only an outage may spend it: reconnecting is the single
              action here that unblocks every line under it. A card with no outage spends none.
              Both actions are `lg` because this block leads the card; the rows below are `sm`,
              which is the kit's own distinction between a block's action and a row's. */}
          <div className="flex flex-wrap items-center gap-[8px]">
            <Link className={ACCENT_FILL_CLASS} href="/coach/integrations">
              Reconnect {blockedChannel.channelLabel}
            </Link>
            <button
              className={kitButtonClass({ size: "lg", variant: "secondary" })}
              onClick={() => setOutageOpen(true)}
              type="button"
            >
              See what is affected
            </button>
          </div>
        </div>
      ) : null}
      <ul className="m-0 flex list-none flex-col p-0">
        {sources.map((source) => (
          <li
            className="grid grid-cols-[var(--s-6)_minmax(0,1fr)_auto] items-baseline gap-x-[12px] border-t border-[var(--line-soft)] py-[10px] first:border-t-0 first:pt-0"
            key={source.title}
          >
            {/*
             * The count column is a fixed `--s-6` track rather than a `min-w` on a flex child, so
             * the three counts share one right edge and every label starts at the same x whether
             * the number is 1 or 148. A count above zero is the row's bad news and takes the
             * warning face; a zero is not bad news, so it renders in `--faint` -- which has to be
             * an inline style because `Figure` sets its own colour inline from the tone and a
             * class would lose to it.
             *
             * Every size in this card is at or above 14px. `SIMPLIFICATION-SPEC.md` §5 puts the
             * floor there for helper text and the coach surface exists because coaches over 55
             * said the console was hard to read; the card had been running its label at 13px and
             * its explanation at 12px, which rendered visibly smaller than the body copy in the
             * panels directly under it. Hierarchy inside the row comes from weight and colour
             * instead: 15px mono figure, 14px medium `--ink` label, 14px regular `--muted`
             * explanation.
             */}
            <Figure
              className="col-start-1 row-start-1 justify-self-end"
              size="md"
              style={source.count > 0 ? undefined : { color: "var(--faint)" }}
              tone={source.count > 0 ? "warning" : "neutral"}
            >
              {source.count}
            </Figure>
            <span className="col-start-2 row-start-1 min-w-0 text-[14px] leading-[1.4] font-medium text-[color:var(--ink)]">
              {source.title}
            </span>
            {/* Screen 2a's second line: why this queue is waiting, in the same words the column
                carries. It sits in the label's own column so it reads as the row explaining
                itself rather than as a second paragraph under the card. */}
            {source.sentence ? (
              <span className="col-start-2 row-start-2 mt-[2px] max-w-[var(--measure-prose)] text-[14px] leading-[1.45] text-[color:var(--muted)]">
                {source.sentence}
              </span>
            ) : null}
            <Link
              className={`${ATTENTION_ACTION_CLASS} col-start-3 row-start-1 row-span-2 self-center`}
              href={source.href}
            >
              {source.note}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A neutral link, not an accent one. The Ownership Rule gives the accent to what the coach must
 * act on, and this section is a readout of decisions already made. The attention card above
 * spends the page's one fill, and only when a channel has stopped.
 */
const MUTED_LINK_CLASS =
  "shrink-0 text-[12.5px] font-medium text-[color:var(--muted)] underline underline-offset-[3px] decoration-[var(--line)] hover:text-[color:var(--ink)]";

export function CoachMeasurementSurface({
  attention,
  blockedChannel = null,
  measurement,
  composition,
  window,
  customFrom = null,
  customTo = null,
  impersonation = null,
  greeting = null,
  channelStatus = null,
}: CoachMeasurementProps) {
  const [keywordKpiMode, setKeywordKpiMode] = useState<"count" | "percent">("count");
  const keywordOptInDenominator = measurement.keywords.reduce(
    (total, row) => total + row.conversations,
    0,
  );
  const keywordKpiColumns = keywordColumns(keywordKpiMode, keywordOptInDenominator);
  const exportQuery = {
    window,
    ...(window === "custom" && customFrom && customTo ? { from: customFrom, to: customTo } : {}),
    columns: [...KEYWORD_EXPORT_COLUMNS],
  };
  const allTrendPoints = composition.months.map((month) => ({
    at: month.month,
    value: month.total,
  }));
  const activeTrendPoints = allTrendPoints.filter((point) => (
    Number.isFinite(point.value) && point.value > 0
  ));
  const partialMonth = [...composition.months].reverse().find((month) => month.partial) ?? null;
  // The window the figures above the picker are counting, named from the same table the picker
  // labels its pills from, so the caption cannot drift from the control that sets it.
  const windowLabel = WINDOW_OPTIONS.find((option) => option.value === window)?.label ?? "Selected window";
  // Every preset window runs through the next local midnight, so its rows come back
  // `still_filling` and the figures above are today's count of a window that has not closed. The
  // deck prints the number (DECISIONS T12-1: mark the partial period, do not withhold it) and this
  // caption is where it is marked -- once, under the deck, rather than as a note on six panels.
  const windowStillOpen = measurement.metrics.some((row) => row.state === "still_filling");
  const windowCaption = windowStillOpen
    ? `${windowLabel} of leads, set above. Counted through today, so this window is still filling.`
    : `${windowLabel} of leads, set above`;
  const trendData = {
    minPeriods: 2,
    periodLabel: "Last six calendar months",
    points: activeTrendPoints.length >= 2 ? allTrendPoints : activeTrendPoints,
  };

  return (
    <div className="@container/page flex min-w-0 flex-col gap-[var(--s-6)]">
      {/*
        The three header facts the artboard draws, and where each of them is now read from.
        An earlier version of this comment refused all three on the grounds that the page held no
        column behind them. That premise was wrong about all three, and it is worth writing down
        why, because the refusals were argued convincingly enough to survive several readings:

        **"Welcome back, <name>."** `public.users.full_name` has existed since the initial
        migration and the signup RPC writes it. The page resolves it for the signed-in actor and
        passes the first name here. It is suppressed under impersonation, where the reader is a
        platform user looking at somebody else's workspace and greeting them by name on it would
        name the wrong person on the right page.

        **"Live on Instagram and Messenger."** The old comment reasoned from `blockedChannel`,
        which is indeed only the negative -- one connection that stopped -- and concluded no
        positive existed. But `loadBlockedChannel` derives that negative from
        `listChannelConnections`, which returns every connection with its own `state`, and `live`
        is one of those states. The page now reads that list once and passes both halves, so the
        green line is made from rows that actually say `live` rather than from the absence of a
        failure.

        **"Texting is on day N of carrier review."** `loadCoachA2pRegistration` projects
        `submittedAt` off the A2P steps and three other surfaces already render `DayCounter` from
        it. The page reads the same projection. This is the one place on Home where an elapsed day
        count is the honest answer to "how long", because the wait is on a third party who
        publishes no decision schedule -- see `figureFor` in `coach-deck.tsx` for why the same
        treatment is refused for an analytics window.
      */}
      {/*
        `Main.dc.html` draws the greeting at 46px with the range picker beside it and nothing else
        -- no description, no crumbs, and no open-conversation readout, which spec §2.1 KILLs. The
        window control moved up here because it governs every figure on the page: it was sitting
        two thirds of the way down inside a "Performance" section, below the deck whose numbers it
        sets, which is the wrong end of the causal arrow.
      */}
      <CoachPageHead
        action={<MeasurementPicker customFrom={customFrom} customTo={customTo} window={window} />}
        provenance={measurement.isDemo ? "demo" : "real"}
        sub={impersonation
          ? "Read-only admin view of this coach's workspace."
          : "Start with the queue, then scan the latest performance before your next call."}
        surface="home"
        title={greeting ? `Welcome back, ${greeting}` : "Dashboard"}
      />

      <CoachChannelStatusLine status={channelStatus} />

      {/* Above the attention queue on purpose. The queue is a list of things the coach has to do
          and this notice exists to say there is nothing to do, so putting the reassurance after
          the list would let a coach read the amber card first and conclude that the carrier wait
          is one more item on it. */}
      <CoachCarrierNotice status={channelStatus} />

      <AttentionQueue attention={attention} blockedChannel={blockedChannel} />

      {/* The glance row, and it is a bare strip rather than a second card. The Performance strip
          below takes the card face because it is the page's measured block, with its own window
          control and its own method note; this one is three outcomes at a glance and carries no
          chrome, which is how the reader knows the two are not the same object said twice. The
          window is named on the row itself because the control that sets it sits further down. */}
      {/*
        One deck, where the page used to carry two strips of the same figures -- a bare "What came
        of it" row and a card-faced "Performance" row whose difference needed a comment to explain
        and which no coach reported understanding. Saying the numbers once, large, with a sentence
        on each panel about what it counts, is the change the client asked for.
      */}
      <section aria-labelledby="coach-outcomes-heading" className="flex min-w-0 flex-col gap-[var(--s-3)]">
        <h2 className="sr-only" id="coach-outcomes-heading">
          Your numbers
        </h2>
        <CoachDeck items={deckItems(measurement, attention, composition.asOf)} />
        <MonoMeta className="block">{windowCaption}</MonoMeta>
      </section>

      {/*
        What left this page, and where it went.

        "Yours to set" was a second copy of `/coach/agent`'s four cards, stated rather than
        editable, and `SIMPLIFICATION-SPEC.md` §2.1 MERGEs it into that page -- which now draws all
        four open at once, so the summary was a list of links to a list. `Main.dc.html` draws
        neither it nor the "Performance" heading it sat above: the picker moved into the head, the
        figures are the deck, and the seven denominators the section disclosed are one link.
      */}
      <Method summary="How we count these">
        <dl className="m-0 grid gap-[var(--s-2)]">
          {SUMMARY_KEYS.map((key) => {
            const definition = metricDefinition(key);
            return (
              <div className="grid gap-[var(--s-1)]" key={key}>
                <dt className="coach-eyebrow">{definition.label}</dt>
                <Prose as="dd" className="m-0" measure="wide">
                  {definition.denominator}
                </Prose>
              </div>
            );
          })}
        </dl>
        <Prose className="m-0" measure="wide">
          Counts follow the same contact cohort throughout the selected window. Demo and test
          activity is kept out of real-workspace analytics.
        </Prose>
      </Method>

      <section aria-labelledby="coach-trend-heading" className="flex min-w-0 flex-col gap-[var(--s-3)]">
        {/* The panel below carries its own title, so this labels the block rather than opening a
            second heading level over it. It is the coach scale's 12px sentence-case eyebrow rather
            than the 9.5px uppercase mono overline it used to be: `docs/DESIGN.md` now scopes that
            role to the owner console, and this is the surface built for the reader who told us the
            console was hard to read. */}
        <div className="flex flex-wrap items-end justify-between gap-[var(--s-3)]">
          <div className="flex min-w-0 flex-col gap-[var(--s-1)]">
            <h2 className="coach-eyebrow" id="coach-trend-heading">
              Company trend
            </h2>
            <Prose className={CARD_SUB_CLASS}>
              A fixed calendar view for spotting movement across complete and current months.
            </Prose>
          </div>
          <TrendDownload months={composition.months} />
        </div>
        <TrendPanel
          data={trendData}
          emptyReason="Lead volume appears after two calendar months record activity."
          periodFormat="long"
          title="Leads by month"
        />
        {/* The artifact's footnote under the chart, and both halves of it are read rather than
            written: the partial month is the composition's own `partial` flag on its last row, and
            the exclusion sentence follows the workspace's provenance instead of promising a real
            reader that demo rows were filtered out of a demo workspace. */}
        {/* The artboard's footnote under the chart, and both halves are read rather than written:
            the partial month is the composition's own `partial` flag on its last row, and the
            exclusion clause follows the workspace's provenance instead of promising a real reader
            that demo rows were filtered out of a demo workspace. The month is named in full here
            rather than as the axis's abbreviation, because this is a sentence and "Aug is lighter"
            reads as a truncation. */}
        <p className="coach-panel__stat-note">
          {partialMonth ? `${longMonth(partialMonth.month, partialMonth.label)} is lighter because the month is not over yet. ` : ""}
          {measurement.isDemo
            ? "Demo workspace, excluded from real analytics."
            : "Test and demo activity excluded."}
        </p>
        <Method summary="About this trend">
          <Prose className="m-0" measure="wide">
            The current month remains partial. A line appears only when at least two months carry
            recorded leads.
          </Prose>
        </Method>
      </section>

      {/* A panel, not a card: `DataTable` brings its own toolbar band and row rules and is built to
          run edge to edge, so the face, the radius and the clipping belong to the panel around it
          rather than to a second box drawn inside one. */}
      {/*
        The eyebrow the artboard draws over this panel's name, put back the right way round.

        `Main.dc.html:369-370` sets "Where your leads come from" as the 14px muted category and
        "Which keyword brings the best leads" as the panel's own name under it. The code had them
        swapped: the category was the heading and the name was the opening clause of a subtitle
        sentence, so the panel announced itself by the section it belongs to rather than by the
        question it answers -- and a coach scanning headings read a preposition phrase where every
        other panel on the page gives them a claim.

        It now sits inside the band, which is where the artboard draws it. It could not before:
        `SurfaceHeader`'s only eyebrow slot rendered `Overline` -- the console's 9.5px uppercase
        mono role, which `coach-shared-type-floor.test.ts` bans outright from a coach page and is
        the exact legibility complaint this surface exists to answer -- so the eyebrow was hoisted
        to a sibling heading above the card and the band opened on the name alone. The
        `coach-data` arm on `SurfaceHeader` closes that: this panel is the wide data panel, the
        third card shape, and `Main.dc.html:366-371` is one of the three drawings it was
        established from.
      */}
      <Surface
        aria-labelledby="coach-keywords-heading"
        className="flex min-w-0 flex-col"
        variant="panel"
      >
        <SurfaceHeader
          overline="Where your leads come from"
          scale="coach-data"
          subtitle="Percent view uses each keyword's share of all keyword opt-ins; qualified and booked use that keyword's opt-ins."
          title="Which keyword brings the best leads"
          titleAs="h2"
          titleId="coach-keywords-heading"
          trailing={(
            <div className="flex flex-wrap items-center justify-end gap-[var(--s-2)]">
              <SegmentedControl
                ariaLabel="Keyword KPI display"
                onValueChange={(value) => setKeywordKpiMode(value as "count" | "percent")}
                scale="coach"
                segments={[{ key: "count", label: "Count" }, { key: "percent", label: "Percent" }]}
                value={keywordKpiMode}
              />
              <MonoMeta>
                {workspaceCountFormat.format(measurement.keywords.length)}
                {measurement.keywords.length === 1 ? " keyword" : " keywords"}
              </MonoMeta>
            </div>
          )}
        />
        <DataTable
          ariaLabel="Keyword performance"
          columns={keywordKpiColumns}
          data={measurement.keywords}
          emptyState={(
            <DataState
              body="Keyword rows appear once a conversation is attributed to a keyword."
              kind="empty"
              title="No keyword activity yet"
            />
          )}
          exportResource={{
            filename: "setterfi-coach-measurement-keywords",
            mode: "server",
            query: exportQuery,
            resource: "coach-measurement-keywords",
          }}
          getRowId={(row) => row.keyword}
          rowLabel={{ plural: "keywords", singular: "keyword" }}
        />
      </Surface>

      {/* The allowance used to be a card of its own here, under the heading "Booked calls this
          billing period". It is now the Booked panel's footer, which is where the artboard puts
          it and where it answers the question a coach is actually holding when they look at their
          booked count. Both facts the card carried survived the move: the reading is the footer
          stat, and the period boundaries it is counted between are the note under it. Rendering
          both would have put `coach.allowance_used` on the screen twice, which is the duplication
          the deck was built to remove. */}
    </div>
  );
}
