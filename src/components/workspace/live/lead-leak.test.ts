import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/coach/pipelines",
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { leakBreakdown, leakExplanation } from "@/components/workspace/live/lead-leak";
import { leadFunnel } from "@/components/workspace/live/leads-surface";
import type { ContactRead } from "@/lib/repositories/contacts";

function lead(
  id: string,
  outcome: string | null,
  pipelineStage: string,
): ContactRead {
  return {
    channels: [{ address: id, channel: "instagram" }],
    credit: null,
    goal: null,
    id,
    isDemo: false,
    isTest: false,
    lastActivityAt: "2026-08-24T09:00:00.000Z",
    name: id,
    outcome,
    pipelineStage,
    timeline: null,
  };
}

const contacts: ContactRead[] = [
  lead("a", null, "new_lead"),
  lead("b", null, "qualifying"),
  lead("c", null, "qualifying"),
  lead("d", "SOFT_DQ", "long_term_followup"),
  lead("e", "HARD_DQ", "disqualified"),
  lead("f", "SOFT_DQ", "long_term_followup"),
  lead("g", "BOOK", "booked"),
  lead("h", "BOOK", "qualifying"),
];

describe("the funnel leak breakdown", () => {
  /*
   * The guard that makes the restatement in LEAK_COHORTS safe. Each cohort is derived from the
   * same columns FUNNEL_STEPS counts, so its total has to equal the drop the funnel measured; a
   * step definition that moves on one side and not the other fails here rather than shipping a
   * sentence about the wrong leads.
   */
  it("accounts for exactly the leads the funnel measured as the drop", () => {
    const steps = leadFunnel(contacts);
    for (const [index, step] of steps.entries()) {
      const previous = steps[index - 1];
      if (!previous) continue;
      const breakdown = leakBreakdown(contacts, step.key);
      const total = breakdown.reduce((sum, entry) => sum + entry.count, 0);
      expect(total).toBe(previous.count - step.count);
    }
  });

  it("describes a decision gap by the decisions and a booking gap by the stages", () => {
    expect(leakBreakdown(contacts, "ready")).toEqual([
      { count: 2, label: "Not a fit yet" },
      { count: 1, label: "Not a fit" },
    ]);
    expect(leakBreakdown(contacts, "booked")).toEqual([
      { count: 1, label: "Still talking" },
    ]);
  });

  it("says the counts are current state rather than the point a lead stopped at", () => {
    const sentence = leakExplanation(contacts, { key: "ready", label: "Ready to book" });
    expect(sentence).toContain("Of the 3 leads that did not reach Ready to book");
    expect(sentence).toContain("2 not a fit yet");
    expect(sentence).toContain("not the point it stopped at");
  });

  it("returns nothing to explain when no lead was lost at the step", () => {
    const everyoneBooked = [lead("x", "BOOK", "booked"), lead("y", "BOOK", "booked")];
    expect(leakExplanation(everyoneBooked, { key: "booked", label: "Booked" })).toBeNull();
    expect(leakExplanation(contacts, { key: "all", label: "Leads" })).toBeNull();
  });
});
