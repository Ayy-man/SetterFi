import type { ReactNode } from "react";

import { DeckPanel } from "@/components/kit/deck-panel";
import {
  availableMetric,
  metricDefinition,
  type MetricEvidence,
  type MetricKey,
} from "@/lib/analytics/metric-definitions";
import { workspaceCountFormat } from "@/lib/format/datetime";
import { formatMetric } from "@/lib/format/metric";
import type { CoachMeasurement, CoachMeasurementWindow } from "@/lib/repositories/analytics";

/**
 * The six bubbles `Main.dc.html:117` draws, in the artboard's order, on one anatomy.
 *
 * The anatomy is the whole point of the block and it is the thing the 2026-09-04 audit found
 * missing: a band carrying an eyebrow, a name and at most one action; a figure; a sentence slot
 * two lines deep whether or not the sentence fills it; and a footer that is pushed to the card's
 * bottom. Three cards of 155px with 60px of nothing under the baseline is what the round before
 * this drew, and the reason was that each card decided its own shape.
 *
 * **Absence is stated, never drawn.** A reading with no evidence replaces the figure with a
 * sentence saying why and the card ends there: no sentence, no footer, no dashed rule standing in
 * for a series. That is `docs/COACH-REDESIGN-PLAYBOOK.md` rule 1 and it is why the cards can be
 * this large without any of them being able to lie.
 *
 * **A footer row is drawn only where the measurement carries its evidence.** The artboard gives
 * every bubble two rows; the measurement carries the evidence for four of the twelve. The rest are
 * omitted rather than filled, and the ones that are missing because a read does not exist yet are
 * listed in the round-2 report. The card keeps its anatomy and its height either way, because the
 * grid stretches the row and `.coach-panel__footer` pins the footer to the bottom.
 */

/* --------------------------------------------------------------------------------------------
 * Readings
 * ------------------------------------------------------------------------------------------ */

export type Reading =
  | { kind: "value"; text: string }
  | { kind: "absent"; note: string };

/**
 * The floor under which a keyword's rates are not printed, and the row the RPC names for the
 * leads who sent nothing.
 *
 * Both live here rather than in the table because the Conversion bubble names the best keyword and
 * has to apply the same floor and skip the same row: two copies of this number is how one screen
 * ends up with a headline that contradicts the table under it.
 */
/**
 * The six bubbles' names and their sentences, in the artboard's order.
 *
 * Exported because `coach/home/loading.tsx` draws the same six panels with a bone where the figure
 * will land, and the sentence under a bone has to be the sentence that arrives with the figure. A
 * second copy of these strings is a page that visibly rewrites itself the moment the read
 * finishes, which is the whole thing a loading boundary exists to prevent.
 *
 * Conversion's sentence here is the fallback. When the rate's own evidence carries a numerator and
 * a denominator the panel prints those instead, because the artboard's line is the arithmetic
 * spelled out and the arithmetic is what the reading is.
 */
export const HOME_BUBBLES = [
  {
    key: "booked",
    name: "Booked calls",
    sentence: "Qualified leads who booked a call on your calendar.",
  },
  { key: "active", name: "Active leads", sentence: "Leads your agent is actively trying to book." },
  { key: "new", name: "New leads", sentence: "People who messaged you for the first time." },
  {
    key: "disqualified",
    name: "Disqualified",
    sentence: "Poor fit on credit, finances or timing. The reason stays on each one.",
  },
  {
    key: "conversion",
    name: "Conversion",
    sentence: "Booked calls as a share of the leads who arrived in this window.",
  },
  {
    key: "time-to-book",
    name: "Average time to book",
    sentence: "From a lead's first message to a call on your calendar.",
  },
] as const;

/** One row of the table above, by key, so a bubble never respells its own name. */
function copy(key: (typeof HOME_BUBBLES)[number]["key"]) {
  return HOME_BUBBLES.find((bubble) => bubble.key === key)!;
}

export const KEYWORD_RATE_MINIMUM = 10;
export const NO_KEYWORD_ROW = "No keyword";

/**
 * A duration inside one glyph run, which is what the artboard draws and what `formatMetric` does
 * not do.
 *
 * `formatMetric(value, "duration")` renders `72 hr` through `Intl`'s unit style. The 2026-09-04
 * audit measured that on this screen and called it out by name: at 62px in mono the space puts
 * "hr" at figure size beside the number, so it reads as part of the number rather than as its
 * unit. `design/coach/VOCABULARY.md` states the rule the owner console's `5.8d` already follows,
 * that a unit stays inside the glyph run, and the artboard's own reading is `5.2h`.
 */
function compactDuration(seconds: number) {
  const magnitude = Math.abs(seconds);
  const scaled = (divisor: number) =>
    new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(seconds / divisor);
  if (magnitude < 60) return `${scaled(1)}s`;
  if (magnitude < 3_600) return `${scaled(60)}m`;
  if (magnitude < 86_400) return `${scaled(3_600)}h`;
  return `${scaled(86_400)}d`;
}

function readingText(evidence: MetricEvidence, value: number) {
  const unit = metricDefinition(evidence.metricKey).unit;
  if (unit === "percent") return formatMetric(value, "percent");
  if (unit === "seconds") return compactDuration(value);
  if (unit === "days") return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value)}d`;
  return formatMetric(value, "count");
}

/**
 * One figure, or the reason there is not one.
 *
 * `emptyPopulation` is the caller's own words for the one absence a generic sentence gets wrong.
 * A metric that needs a positive denominator is absent because nothing eligible happened, and
 * "there is no eligible activity for this calculation" is a sentence about arithmetic where the
 * coach needs a sentence about their week: no leads arrived, or no call was booked.
 */
export function readMetric(
  measurement: CoachMeasurement,
  key: MetricKey,
  emptyPopulation?: string,
): Reading {
  const evidence = measurement.metrics.find((metric) => metric.metricKey === key);
  if (!evidence) {
    return { kind: "absent", note: "We have no reading for this window yet." };
  }

  const definition = metricDefinition(evidence.metricKey);
  if (
    definition.requiresPositiveDenominator
    && (evidence.denominator === null
      || !Number.isFinite(evidence.denominator)
      || evidence.denominator <= 0)
  ) {
    return {
      kind: "absent",
      note: emptyPopulation ?? "Nothing in this window can be counted against.",
    };
  }

  const value = availableMetric(evidence);
  if (value !== null) return { kind: "value", text: readingText(evidence, value) };

  if (evidence.state === "still_filling" || evidence.state === "needs_more_history") {
    return { kind: "absent", note: "This window is still filling." };
  }
  return { kind: "absent", note: "We have no reading for this window yet." };
}

/**
 * A raw count off an evidence row, for a footer that counts rather than rates.
 *
 * The key is a plain string rather than a `MetricKey` on purpose. Two of the four callers ask for
 * `coach.active_leads_agent_handling` and `coach.active_leads_needs_you`, which
 * `docs/plans/2026-09-04-coach-backend-gaps.md` records as a deferred gap on the shared
 * `read_coach_measurement` RPC: they are not members of `COACH_METRIC_KEYS` today. Typing the
 * parameter to the union would make asking for them a compile error, so this screen could not be
 * written to use them the day they land. Asking by name and getting nothing is the same answer the
 * absent-evidence path already gives, and the footer states it in words either way.
 */
function evidenceCount(
  measurement: CoachMeasurement,
  key: string,
  part: "numerator" | "value",
): number | null {
  const evidence = measurement.metrics.find((metric) => (metric.metricKey as string) === key);
  if (!evidence) return null;
  const raw = part === "numerator" ? evidence.numerator : evidence.value;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/* --------------------------------------------------------------------------------------------
 * Faces
 * ------------------------------------------------------------------------------------------ */

/**
 * How a bubble's eyebrow names the window it counts over.
 *
 * A fixed "last month" is false on five of the six settings, so the phrase follows the control.
 * The windows are trailing spans rather than calendar ones (`metric-definitions.ts` calls them a
 * "selected half-open window"), which is why these read "last week" rather than "this week".
 */
export const RANGE_EYEBROW: Record<CoachMeasurementWindow, string> = {
  "1d": "Last day",
  "1m": "Last month",
  "1w": "Last week",
  "3m": "Last three months",
  all: "All time",
  custom: "Your chosen range",
};

function Figure({ reading }: { reading: Reading }) {
  if (reading.kind === "value") {
    return <p className="coach-panel__figure">{reading.text}</p>;
  }
  /*
   * The absence line the vocabulary specifies: sentence face, 20px at weight 500 in the muted
   * role, in the slot the figure would have taken, and the card ends after it.
   */
  return (
    <p
      className="max-w-[var(--measure-caption)] text-[20px] leading-[1.35] font-medium text-[color:var(--muted)]"
      data-slot="bubble-absence"
    >
      {reading.note}
    </p>
  );
}

/**
 * The sentence slot, held two lines deep whether or not the sentence needs both.
 *
 * `.coach-panel__sentence` owns the measure, the colour and the size. The floor is the one thing
 * it cannot own, because it is a property of the row of six rather than of one card: without it
 * the figures in a row sit at one height and the footers at another, which is the ragged deck the
 * `margin-top: auto` on the footer was written to prevent one level up.
 */
function Sentence({ children }: { children: ReactNode }) {
  return <p className="coach-panel__sentence min-h-[48px]">{children}</p>;
}

function FooterRow({
  divided,
  label,
  value,
}: {
  divided: boolean;
  label: string;
  value: string;
}) {
  return (
    <div
      className={`grid min-h-[46px] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 ${
        divided ? "border-t border-[var(--line-soft)]" : ""
      }`}
      data-slot="bubble-footer-row"
    >
      <span aria-hidden="true" className="size-2 rounded-full bg-[var(--faint)]" />
      <span className="text-[16px] text-[color:var(--muted)]">{label}</span>
      <span className="font-mono text-[17px] font-medium tabular-nums text-[color:var(--ink)]">
        {value}
      </span>
    </div>
  );
}

type FooterFact = { label: string; value: string };

function footerNode(facts: readonly FooterFact[], note?: string) {
  if (facts.length === 0 && !note) return undefined;
  return (
    <>
      {facts.map((fact, index) => (
        <FooterRow divided={index > 0} key={fact.label} label={fact.label} value={fact.value} />
      ))}
      {note ? <p className="coach-panel__stat-note">{note}</p> : null}
    </>
  );
}

/* --------------------------------------------------------------------------------------------
 * The six
 * ------------------------------------------------------------------------------------------ */

type Bubble = {
  action?: { href: string; label: string };
  drench?: "live";
  eyebrow: string;
  facts: readonly FooterFact[];
  footerNote?: string;
  key: string;
  name: string;
  reading: Reading;
  sentence: string;
};

export type CoachHomeBubblesProps = {
  measurement: CoachMeasurement;
  window: CoachMeasurementWindow;
};

export function CoachHomeBubbles({ measurement, window }: CoachHomeBubblesProps) {
  const eyebrow = RANGE_EYEBROW[window];
  const count = (value: number) => workspaceCountFormat.format(value);

  const booked = readMetric(measurement, "coach.booked_contacts");
  const active = readMetric(measurement, "coach.active_leads");
  const newLeads = readMetric(measurement, "coach.new_leads");
  const disqualified = readMetric(measurement, "coach.disqualified_leads");
  const conversion = readMetric(
    measurement,
    "coach.conversion_rate",
    "No leads arrived in this window to measure against.",
  );
  const timeToBook = readMetric(
    measurement,
    "coach.average_time_to_book",
    "No call was booked in this window.",
  );

  /*
   * "Showed up so far" is `coach.show_rate`'s numerator, which the definition states is completed
   * plus unmarked past appointments. It is a count off a rate's own evidence rather than a second
   * read, so it cannot disagree with the rate the Billing screen prints from the same row.
   */
  const showed = evidenceCount(measurement, "coach.show_rate", "numerator");

  /*
   * The active-leads split. `coach.active_leads_agent_handling` and `coach.active_leads_needs_you`
   * were added to the measurement RPC in `20261012000006_active_leads_agent_split.sql` and sum to
   * `coach.active_leads` by construction. Where the migration has not reached a database the rows
   * are simply absent, and the footer says so in words rather than splitting the total by guess.
   */
  const agentHandling = evidenceCount(measurement, "coach.active_leads_agent_handling", "value");
  const needsYou = evidenceCount(measurement, "coach.active_leads_needs_you", "value");
  const splitRead = agentHandling !== null && needsYou !== null;

  /*
   * The conversion sentence is the artboard's, built from the rate's own numerator and
   * denominator, so the sentence and the percentage above it are one calculation rather than two.
   */
  const conversionEvidence = measurement.metrics.find(
    (metric) => metric.metricKey === "coach.conversion_rate",
  );
  const conversionSentence =
    conversionEvidence
      && typeof conversionEvidence.numerator === "number"
      && typeof conversionEvidence.denominator === "number"
      && conversionEvidence.denominator > 0
      ? `${count(conversionEvidence.numerator)} booked calls out of the ${
        count(conversionEvidence.denominator)
      } new leads.`
      : copy("conversion").sentence;

  /*
   * The best keyword, over the same ten-sender floor the table below applies, so the two cannot
   * name different winners. A keyword with four senders and one booking reads as a 25 percent
   * booked rate and is noise; the table refuses to print its rates for exactly that reason.
   */
  const bestKeyword = [...measurement.keywords]
    .filter((row) => row.conversations >= KEYWORD_RATE_MINIMUM && row.keyword !== NO_KEYWORD_ROW)
    .sort((left, right) =>
      right.bookedContacts / right.conversations - left.bookedContacts / left.conversations
    )[0];

  const bubbles: Bubble[] = [
    {
      action: { href: "/coach/billing", label: "Open your bookings" },
      drench: "live",
      eyebrow,
      facts: showed === null ? [] : [{ label: "Showed up so far", value: count(showed) }],
      key: copy("booked").key,
      name: copy("booked").name,
      reading: booked,
      sentence: copy("booked").sentence,
    },
    {
      action: { href: "/coach/conversations", label: "Open your inbox" },
      // Not the window: the stage this counts is read at the moment the page loads, which is what
      // `coach.active_leads`'s cohort rule says and what the artboard's own eyebrow says.
      eyebrow: "Right now",
      facts: splitRead
        ? [
          { label: "Agent handling", value: count(agentHandling) },
          { label: "Needs you", value: count(needsYou) },
        ]
        : [],
      footerNote: splitRead
        ? undefined
        : "We cannot yet split these into the ones your agent is handling and the ones needing you.",
      key: copy("active").key,
      name: copy("active").name,
      reading: active,
      sentence: copy("active").sentence,
    },
    {
      action: { href: "/coach/contacts", label: "Open your leads" },
      eyebrow,
      facts: [],
      key: copy("new").key,
      name: copy("new").name,
      reading: newLeads,
      sentence: copy("new").sentence,
    },
    {
      action: { href: "/coach/pipelines", label: "Open your pipeline" },
      eyebrow,
      facts: [],
      key: copy("disqualified").key,
      name: copy("disqualified").name,
      reading: disqualified,
      sentence: copy("disqualified").sentence,
    },
    {
      eyebrow,
      facts: bestKeyword
        ? [{
          label: `Best keyword, ${bestKeyword.keyword}`,
          value: formatMetric(
            (bestKeyword.bookedContacts * 100) / bestKeyword.conversations,
            "percent",
          ),
        }]
        : [],
      key: copy("conversion").key,
      name: copy("conversion").name,
      reading: conversion,
      sentence: conversionSentence,
    },
    {
      eyebrow,
      facts: [],
      key: copy("time-to-book").key,
      name: copy("time-to-book").name,
      reading: timeToBook,
      sentence: copy("time-to-book").sentence,
    },
  ];

  return (
    <div
      className="grid grid-cols-1 items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-3"
      data-slot="home-bubbles"
    >
      {bubbles.map((bubble) => (
        <DeckPanel
          action={bubble.action}
          dataSlot={`home-bubble-${bubble.key}`}
          drench={bubble.drench}
          eyebrow={bubble.eyebrow}
          footer={bubble.reading.kind === "absent"
            ? undefined
            : footerNode(bubble.facts, bubble.footerNote)}
          headingId={`home-bubble-${bubble.key}-heading`}
          key={bubble.key}
          name={bubble.name}
        >
          <Figure reading={bubble.reading} />
          {bubble.reading.kind === "value" ? <Sentence>{bubble.sentence}</Sentence> : null}
        </DeckPanel>
      ))}
    </div>
  );
}
