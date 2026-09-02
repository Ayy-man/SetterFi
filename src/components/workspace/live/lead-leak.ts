import {
  OUTCOME_LABELS,
  STAGE_LABELS,
} from "@/components/workspace/live/lead-search";
import type { ContactRead } from "@/lib/repositories/contacts";

export type LeakBreakdownEntry = { label: string; count: number };

/**
 * Who the leads that did not advance are, per funnel step, along a stored column.
 *
 * Round 3's artifact explains its leak with a sentence nothing here can produce ("61 said some
 * version of can't afford it right now"): that reads message text, and no message text reaches
 * this page. What is derivable is the recorded state of the leads that did not advance, which is
 * a column on every row, so the leak is explained by naming what those leads actually are rather
 * than by inventing why they stopped.
 *
 * The three predicates restate what `FUNNEL_STEPS` counts, which is a restatement worth guarding:
 * `lead-leak.test.ts` checks that each breakdown totals exactly the drop the funnel measured, so
 * a step whose definition moves without this one moving fails rather than quietly explaining the
 * wrong cohort.
 */
const LEAK_COHORTS: Record<string, {
  dropped: (contact: ContactRead) => boolean;
  describe: (contact: ContactRead) => string;
}> = {
  decided: {
    // Counted as a lead, no decision recorded against it. Where it sits is the only thing it says.
    dropped: (contact) => contact.outcome === null,
    describe: (contact) => STAGE_LABELS[contact.pipelineStage] ?? "Stage needs review",
  },
  ready: {
    // A decision exists and it was not to book, so the decision itself is the explanation.
    dropped: (contact) => contact.outcome !== null && contact.outcome !== "BOOK",
    describe: (contact) => OUTCOME_LABELS[contact.outcome ?? ""] ?? "Decision needs review",
  },
  booked: {
    // Qualified to book and not on the calendar. Where it stalled is the useful axis.
    dropped: (contact) => contact.outcome === "BOOK" && contact.pipelineStage !== "booked",
    describe: (contact) => STAGE_LABELS[contact.pipelineStage] ?? "Stage needs review",
  },
};

export function leakBreakdown(
  contacts: readonly ContactRead[],
  stepKey: string,
): readonly LeakBreakdownEntry[] {
  const cohort = LEAK_COHORTS[stepKey];
  if (!cohort) return [];

  const counts = new Map<string, number>();
  for (const contact of contacts) {
    if (!cohort.dropped(contact)) continue;
    const label = cohort.describe(contact);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Array.from(counts, ([label, count]) => ({ count, label }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

/**
 * The leak in a sentence a coach can act on, or null when the step has nothing to explain.
 *
 * It closes by saying the counts are current state rather than the point each lead stopped at,
 * because nothing records the stages a lead passed through and a sentence about a funnel reads as
 * a sentence about a journey unless it says otherwise.
 */
export function leakExplanation(
  contacts: readonly ContactRead[],
  step: { key: string; label: string },
): string | null {
  const parts = leakBreakdown(contacts, step.key);
  if (!parts.length) return null;

  const dropped = parts.reduce((total, part) => total + part.count, 0);
  const listed = parts.map((part) => `${part.count} ${part.label.toLocaleLowerCase()}`);
  const phrase = listed.length === 1
    ? listed[0]
    : `${listed.slice(0, -1).join(", ")} and ${listed.at(-1)}`;
  const subject = dropped === 1 ? "lead that did not reach" : "leads that did not reach";
  return `Of the ${dropped} ${subject} ${step.label}, ${phrase}. That is what each one is recorded as now, not the point it stopped at.`;
}
