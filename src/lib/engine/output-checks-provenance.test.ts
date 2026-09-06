// Number provenance on runtime-backed entries. A figure in a reviewed answer grounds itself only
// when the review bound it, and only while the answer is still the text the review saw.
import { describe, expect, it } from "vitest";

import { rewriteHash } from "@/lib/brain/provenance";
import { buildNumberSources, runOutputChecks } from "@/lib/engine/output-checks";
import type { CoachOffer, PublishedBrainEntry } from "@/lib/engine/types";

const OFFER: CoachOffer = {
  tenantId: "tenant",
  version: 2,
  programName: "Summit",
  products: [],
  brandVoice: "direct",
  voiceAnswers: [],
  qualificationRules: [],
  voiceGuidelines: null,
  proof: [],
  assets: [],
  offerPrices: [],
  creditMin: null,
  fundingGoalMinCents: null,
  bookingHorizonDays: 30,
};

const TEMPLATE = "Funding usually lands in 45 days, rates start near 8%, and the review costs $297.";

function entry(overrides: Partial<PublishedBrainEntry["provenance"]> = {}, answer = TEMPLATE): PublishedBrainEntry {
  return {
    id: "reviewed",
    category: "funding",
    question: "How does it work?",
    answer,
    published: true,
    provenance: {
      responseTemplate: TEMPLATE,
      numberBindings: [
        { kind: "percentage", value: 8, binding: "platform_constant", offset: 40 },
        { kind: "currency", value: 297, binding: "offer_prices", offset: 68 },
      ],
      rewriteHash: rewriteHash(TEMPLATE),
      ...overrides,
    },
  };
}

function context(brainEntries: readonly PublishedBrainEntry[]) {
  return {
    numberSources: buildNumberSources({ offer: OFFER, brainEntries, leadMessages: [] }),
    complianceRules: [],
    linkWhitelist: [],
    systemText: "",
    echoExemptions: brainEntries.map((candidate) => candidate.answer),
    roleBoundary: "credit and funding qualification only",
    channel: "sms" as const,
  };
}

describe("buildNumberSources with reviewed provenance", () => {
  it("admits only the figures a binding covers and leaves the rest to fail NUM", () => {
    const sources = buildNumberSources({ offer: OFFER, brainEntries: [entry()], leadMessages: [] });
    expect(sources).toHaveLength(2);
    expect(sources).toContainEqual({ kind: "percentage", value: 8, sourceType: "brain_entry", sourceId: "reviewed" });
    expect(sources).toContainEqual({ kind: "currency", value: 297, sourceType: "brain_entry", sourceId: "reviewed" });
    const checks = context([entry()]);
    expect(runOutputChecks("The review costs $297 and rates start near 8%.", checks).passed).toBe(true);
    // 45 is a bare integer outside the score range, so it is not a fact the checker can see; use a
    // figure that is: a percentage nobody bound.
    const unbound = runOutputChecks("Rates start near 12%.", checks);
    expect(unbound.violations.map((violation) => violation.class)).toEqual(["NUM"]);
  });

  it("admits a figure a placeholder rendered from the offer even though no binding names it", () => {
    const template = "We work with goals from {{target_funding_amount}} and a review of $297.";
    const rendered = entry({
      responseTemplate: template,
      numberBindings: [{ kind: "currency", value: 297, binding: "offer_prices", offset: 60 }],
      rewriteHash: rewriteHash(template),
    }, "We work with goals from $50,000–$150,000 and a review of $297.");
    const sources = buildNumberSources({ offer: OFFER, brainEntries: [rendered], leadMessages: [] });
    expect(sources.map((source) => source.value).sort((a, b) => a - b)).toEqual([297, 50_000, 150_000]);
  });

  it("withdraws every binding once the answer text stops matching the reviewed hash", () => {
    const edited = entry({ rewriteHash: rewriteHash("some earlier wording") });
    expect(buildNumberSources({ offer: OFFER, brainEntries: [edited], leadMessages: [] })).toEqual([]);
    const never = entry({ rewriteHash: null });
    expect(buildNumberSources({ offer: OFFER, brainEntries: [never], leadMessages: [] })).toEqual([]);
    expect(runOutputChecks("The review costs $297.", context([edited])).violations[0]?.class).toBe("NUM");
  });

  it("keeps the legacy self-grounding rule for an entry with no review record", () => {
    const legacy: PublishedBrainEntry = { ...entry(), provenance: undefined };
    const sources = buildNumberSources({ offer: OFFER, brainEntries: [legacy], leadMessages: [] });
    expect(sources.map((source) => source.value).sort((a, b) => a - b)).toEqual([8, 297]);
  });
});
