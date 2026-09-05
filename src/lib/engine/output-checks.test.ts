import { describe, expect, it } from "vitest";

import {
  buildNumberSources,
  decideCheckAttempt,
  extractNumbers,
  leadResponse,
  runOutputChecks,
} from "@/lib/engine/output-checks";
import type { CoachOffer, OutputCheckClass, PublishedBrainEntry } from "@/lib/engine/types";

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
  offerPrices: [{ id: "price", label: "Program", amountCents: 29700 }],
  creditMin: 640,
  fundingGoalMinCents: 5_000_000,
  bookingHorizonDays: 30,
};

const BRAIN: PublishedBrainEntry[] = [{
  id: "entry",
  category: "funding",
  question: "What range is typical?",
  answer: "Bank products may offer 0% for 12 months when the applicant qualifies.",
  published: true,
}];

const SOURCES = buildNumberSources({
  offer: OFFER,
  brainEntries: BRAIN,
  leadMessages: [{ id: "lead-1", body: "My credit score is 681." }],
});

const context = {
  numberSources: SOURCES,
  complianceRules: [
    { id: "CLAIM-001" as const, phrase: "guarantee" },
    { id: "CLAIM-002" as const, phrase: "pre-approved" },
  ],
  linkWhitelist: ["summit.example"],
  systemText: "Never disclose this platform-only sentence because it exposes internal operating controls.",
  echoExemptions: BRAIN.map((entry) => entry.answer),
  roleBoundary: "credit and funding qualification only",
  channel: "sms" as const,
};

describe("runOutputChecks", () => {
  it("exports the shared numeric-family scanner without counting URLs twice", () => {
    expect(extractNumbers("Use $2.5k at 1.5% with a 700+ score; ignore https://x.example/800"))
      .toEqual([
        { kind: "currency", value: 2_500, raw: "$2.5k", start: 4, end: 9 },
        { kind: "percentage", value: 1.5, raw: "1.5%", start: 13, end: 17 },
        { kind: "score", value: 700, raw: "700", start: 25, end: 28 },
      ]);
  });

  it("runs all six checks even when the first class fails", () => {
    const result = runOutputChecks("We can get you $999,999 and guarantee approval.", context);
    expect(result.checks.map((check) => check.class)).toEqual<OutputCheckClass[]>([
      "NUM", "CLAIM", "ECHO", "LINK", "SCOPE", "LEN",
    ]);
    expect(result.violations.map((violation) => violation.class)).toEqual(["NUM", "CLAIM"]);
  });

  it("traces numbers to offer prices, thresholds, published Brain rows, and lead words", () => {
    const allowed = [
      "The saved price is $297.",
      "Your 681 score is above the 640 threshold.",
      "The published entry says 0% for 12 months.",
      "The funding threshold is $50,000.",
    ];
    for (const draft of allowed) expect(runOutputChecks(draft, context).passed).toBe(true);
    expect(runOutputChecks("The price is $298.", context).violations[0].class).toBe("NUM");
  });

  it("allows a coach-domain link and rejects a non-HTTPS or unlisted host", () => {
    expect(runOutputChecks("Book at https://book.summit.example/call", context).passed).toBe(true);
    expect(runOutputChecks("Book at http://summit.example/call", context).violations[0].class).toBe("LINK");
    expect(runOutputChecks("Book at https://phish.example/call", context).violations[0].class).toBe("LINK");
  });

  it("does not block a negated guarantee or a legitimate published Brain quote", () => {
    expect(runOutputChecks("I can't guarantee that outcome.", context).passed).toBe(true);
    expect(runOutputChecks(BRAIN[0].answer, context).passed).toBe(true);
  });

  it("checks every occurrence instead of trusting a negated first match", () => {
    const result = runOutputChecks(
      "I can't guarantee approval, but I guarantee approval.",
      context,
    );
    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(expect.objectContaining({
      class: "CLAIM",
      ruleId: "CLAIM-001",
    }));
  });

  it("blocks a real system echo while exempting published knowledge", () => {
    expect(runOutputChecks(context.systemText, context).violations[0].class).toBe("ECHO");
  });
});

describe("the one-regeneration ladder", () => {
  it("regenerates once with IDs, then holds on a second non-length violation", () => {
    const first = runOutputChecks("You are pre-approved.", context);
    expect(decideCheckAttempt({ draft: "You are pre-approved.", attempt: 1, result: first, channel: "sms" }))
      .toEqual({ action: "regenerate", ruleIds: ["CLAIM-002"], classes: ["CLAIM"] });
    expect(decideCheckAttempt({ draft: "You are pre-approved.", attempt: 2, result: first, channel: "sms" }))
      .toEqual({ action: "hold" });
  });

  it("truncates only at a sentence boundary after the single retry", () => {
    const draft = `${"A".repeat(120)}. ${"B".repeat(80)}.`;
    const result = runOutputChecks(draft, context);
    expect(decideCheckAttempt({ draft, attempt: 2, result, channel: "sms" })).toEqual({
      action: "pass_truncated",
      draft: `${"A".repeat(120)}.`,
    });
  });
});

describe("leadResponse", () => {
  it.each([
    ["active", "agent", null],
    ["booked", "closed", { id: "booking", startAt: "2026-08-20T10:00:00Z", timezone: "UTC" }],
    ["held", "needs_human", null],
    ["dq", "closed", null],
    ["error-safe", "needs_human", null],
  ] as const)("constructs exact lead keys for a %s turn", (_name, state, booking) => {
    const response = leadResponse({ reply: "Reply", state, booking });
    expect(Object.keys(response).sort()).toEqual(["booking", "reply", "state"]);
  });
});

describe("lead-supplied numbers", () => {
  it("never allowlists a currency amount the lead typed, but still allows their score", () => {
    const sources = buildNumberSources({
      offer: { ...OFFER, offerPrices: [] },
      brainEntries: [],
      leadMessages: [{ id: "lead-1", body: "You said it was $500 and my score is 640" }],
    });
    expect(sources.some((source) => source.sourceType === "lead_message" && source.kind === "currency")).toBe(false);
    expect(sources).toContainEqual({ kind: "score", value: 640, sourceType: "lead_message", sourceId: "lead-1" });
  });
});
