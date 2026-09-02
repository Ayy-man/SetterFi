import { describe, expect, it } from "vitest";

import {
  filterLeads,
  LEAD_SEARCH_FIELDS,
  LEAD_SEARCH_PLACEHOLDER,
  leadSearchScope,
} from "@/components/workspace/live/lead-search";
import type { ContactRead } from "@/lib/repositories/contacts";

const contacts: ContactRead[] = [
  {
    channels: [{ address: "marcus.builds", channel: "instagram" }],
    credit: "680 to 719",
    goal: "$40,000",
    id: "lead-1",
    isDemo: false,
    isTest: false,
    lastActivityAt: "2026-08-24T09:00:00.000Z",
    name: "Marcus Tate",
    outcome: null,
    pipelineStage: "new_lead",
    timeline: "This month",
  },
  {
    channels: [{ address: "+14155552210", channel: "sms" }],
    credit: "720 or higher",
    goal: "$80,000",
    id: "lead-2",
    isDemo: false,
    isTest: false,
    lastActivityAt: "2026-08-23T09:00:00.000Z",
    name: "Leo Mendes",
    outcome: "BOOK",
    pipelineStage: "booked",
    timeline: "Next quarter",
  },
];

const query = { channels: [], outcomes: [], stages: [] };

describe("the lead search scope", () => {
  it("names every field the search reads, because both come off one list", () => {
    const scope = leadSearchScope();
    for (const field of LEAD_SEARCH_FIELDS) {
      expect(scope).toContain(field.label);
    }
  });

  it("never offers to search what a lead said in a thread", () => {
    const words = `${leadSearchScope()} ${LEAD_SEARCH_PLACEHOLDER}`.toLocaleLowerCase();
    // The artifact's own headline, and the three ways it tends to get paraphrased back in.
    for (const promise of ["anything they said", "anything a lead", "transcript", "what they said"]) {
      expect(words).not.toContain(promise);
    }
    expect(leadSearchScope()).toContain("The conversation is not searched");
  });

  it("matches a captured answer and finds nothing for a phrase only a thread would hold", () => {
    expect(filterLeads(contacts, { ...query, query: "720 or higher" }).map((lead) => lead.id))
      .toEqual(["lead-2"]);
    expect(filterLeads(contacts, { ...query, query: "2210" }).map((lead) => lead.id))
      .toEqual(["lead-2"]);
    expect(filterLeads(contacts, { ...query, query: "ghosting" })).toEqual([]);
  });

  it("keeps facet filters independent of the query", () => {
    expect(filterLeads(contacts, { ...query, query: "", stages: ["booked"] }).map((lead) => lead.id))
      .toEqual(["lead-2"]);
    expect(filterLeads(contacts, { ...query, outcomes: ["pending"], query: "" }).map((lead) => lead.id))
      .toEqual(["lead-1"]);
  });
});
