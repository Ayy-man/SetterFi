import { describe, expect, it } from "vitest";

import {
  buildNumberSources,
  channelLengthLimits,
  decideCheckAttempt,
  extractBareIntegers,
  extractNumbers,
  leadResponse,
  lengthBreach,
  runOutputChecks,
  truncateAtSentenceBoundary,
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

describe("LEN soft cap versus hard cap", () => {
  // SMS: soft 160, hard 320. Every draft below has sentence boundaries well inside the soft cap,
  // so the only thing separating the outcomes is which cap the whole draft breaks.
  const sentence = "We look at your file first. ";
  function draftOfLength(length: number) {
    return sentence.repeat(Math.ceil(length / sentence.length)).slice(0, length - 1) + ".";
  }

  it("records a soft breach as LEN-001 and truncates it on the first attempt without a retry", () => {
    const draft = draftOfLength(200);
    const result = runOutputChecks(draft, context);
    expect(result.violations).toEqual([{
      class: "LEN", ruleId: "LEN-001", evidence: "sms reply length 200 exceeds soft cap 160",
    }]);
    for (const attempt of [1, 2] as const) {
      const decision = decideCheckAttempt({ draft, attempt, result, channel: "sms" });
      expect(decision.action).toBe("pass_truncated");
      expect(decision.action === "pass_truncated" && decision.draft.length <= 160).toBe(true);
    }
  });

  it("still regenerates a soft breach that has no sentence boundary inside the cap", () => {
    const draft = `${"A".repeat(199)}.`;
    const result = runOutputChecks(draft, context);
    expect(decideCheckAttempt({ draft, attempt: 1, result, channel: "sms" }))
      .toEqual({ action: "regenerate", ruleIds: ["LEN-001"], classes: ["LEN"] });
    expect(decideCheckAttempt({ draft, attempt: 2, result, channel: "sms" })).toEqual({ action: "hold" });
  });

  it("does not truncate away a second class that failed alongside a soft breach", () => {
    const draft = `You are pre-approved. ${draftOfLength(180)}`;
    const result = runOutputChecks(draft, context);
    expect(decideCheckAttempt({ draft, attempt: 1, result, channel: "sms" }).action).toBe("regenerate");
    expect(decideCheckAttempt({ draft, attempt: 2, result, channel: "sms" })).toEqual({ action: "hold" });
  });

  it("records a hard breach as LEN-002 and holds instead of truncating the essay", () => {
    const draft = draftOfLength(900);
    const result = runOutputChecks(draft, context);
    expect(result.violations).toEqual([{
      class: "LEN", ruleId: "LEN-002", evidence: "sms reply length 900 exceeds hard cap 320",
    }]);
    expect(result.checks.find((check) => check.class === "LEN")).toEqual({
      class: "LEN", passed: false, ruleIds: ["LEN-002"],
      evidence: ["sms reply length 900 exceeds hard cap 320"],
    });
    expect(decideCheckAttempt({ draft, attempt: 1, result, channel: "sms" }))
      .toEqual({ action: "regenerate", ruleIds: ["LEN-002"], classes: ["LEN"] });
    expect(decideCheckAttempt({ draft, attempt: 2, result, channel: "sms" })).toEqual({ action: "hold" });
    expect(truncateAtSentenceBoundary(draft, "sms")).toBeNull();
  });

  it("treats the hard cap itself as a soft breach and one character past it as hard", () => {
    const atCap = draftOfLength(320);
    const pastCap = draftOfLength(321);
    expect(lengthBreach(atCap, "sms")).toBe("soft");
    expect(lengthBreach(pastCap, "sms")).toBe("hard");
    expect(decideCheckAttempt({
      draft: atCap, attempt: 2, result: runOutputChecks(atCap, context), channel: "sms",
    }).action).toBe("pass_truncated");
    expect(decideCheckAttempt({
      draft: pastCap, attempt: 2, result: runOutputChecks(pastCap, context), channel: "sms",
    })).toEqual({ action: "hold" });
  });

  it("scales both caps per channel", () => {
    expect(channelLengthLimits("sms")).toEqual({ soft: 160, hard: 320 });
    expect(channelLengthLimits("instagram")).toEqual({ soft: 320, hard: 800 });
    const draft = draftOfLength(500);
    expect(lengthBreach(draft, "sms")).toBe("hard");
    expect(lengthBreach(draft, "instagram")).toBe("soft");
    expect(decideCheckAttempt({
      draft, attempt: 2, result: runOutputChecks(draft, { ...context, channel: "instagram" }), channel: "instagram",
    }).action).toBe("pass_truncated");
  });
});

describe("LINK without a scheme", () => {
  it.each([
    "Apply at sketchy-lender.example/apply and we go from there.",
    "Details are on sketchy-lender.example.",
    "Try funding.sketchy-lender.example/start today",
  ])("checks a bare host against the whitelist: %s", (draft) => {
    const result = runOutputChecks(draft, context);
    expect(result.violations.map((violation) => violation.class)).toEqual(["LINK"]);
  });

  it("lets a bare mention of a whitelisted host through, including a subdomain", () => {
    expect(runOutputChecks("Book at summit.example/call when you are ready.", context).passed).toBe(true);
    expect(runOutputChecks("It's all on book.summit.example.", context).passed).toBe(true);
  });

  it.each([
    "Some lenders, e.g. credit unions, ask for more.",
    "Rates near 1.5 points are common. Let's talk at 10.30am. U.S. lenders vary.",
    "Email me at help@summit.example and we go from there.",
    "Sept. 5 works. Call ends 3.15pm.",
  ])("ignores abbreviations, decimals, times and email domains: %s", (draft) => {
    expect(runOutputChecks(draft, context).violations.map((violation) => violation.class)).not.toContain("LINK");
  });

  it("counts a scheme-bearing link once rather than once more as a bare host", () => {
    const result = runOutputChecks("Go to https://phish.example/x now.", context);
    expect(result.violations.filter((violation) => violation.class === "LINK")).toHaveLength(1);
    expect(runOutputChecks("Go to https://book.summit.example/x now.", context).passed).toBe(true);
  });
});

describe("NUM and bare integers", () => {
  it("reads a figure as a score only with score context", () => {
    expect(extractNumbers("Your credit is around 700.")).toEqual([
      { kind: "score", value: 700, raw: "700", start: 22, end: 25 },
    ]);
    expect(extractNumbers("A score of 700 helps.")[0]).toMatchObject({ kind: "score", value: 700 });
    expect(extractNumbers("700 FICO is the usual bar.")[0]).toMatchObject({ kind: "score", value: 700 });
    expect(extractNumbers("That takes about 700 forms.")).toEqual([]);
    expect(extractBareIntegers("That takes about 700 forms.")).toEqual([
      { value: 700, raw: "700", start: 17, end: 20 },
    ]);
  });

  it("does not let a bare integer ground itself on the credit threshold by coincidence", () => {
    const result = runOutputChecks("We usually see about 640 applicants a month.", context);
    // 640 is the tenant's credit_min, so the value matches a source and the bare integer passes.
    expect(result.passed).toBe(true);
    const unmatched = runOutputChecks("We usually see about 650 applicants a month.", context);
    expect(unmatched.violations).toEqual([{
      class: "NUM", ruleId: "NUM-001", evidence: "unattributed number at character 21",
    }]);
    // With score context the same figure is a score and must match a score source exactly.
    expect(runOutputChecks("Your score of 650 is close.", context).violations[0].class).toBe("NUM");
    expect(runOutputChecks("Your score of 640 clears the bar.", context).passed).toBe(true);
  });

  it("takes only contextual scores from Brain text and lead words as sources", () => {
    const sources = buildNumberSources({
      offer: { ...OFFER, offerPrices: [], creditMin: null, fundingGoalMinCents: null },
      brainEntries: [{
        ...BRAIN[0],
        answer: "About 700 people apply every single month here, and the typical credit score is 680.",
      }],
      leadMessages: [{
        id: "lead-1", body: "I keep 720 in savings for emergencies right now. My score is 690.",
      }],
    });
    expect(sources.map((source) => source.value).sort()).toEqual([680, 690]);
  });
});

describe("SCOPE for verse set as a list", () => {
  it.each([
    ["dashes", "- every dawn insists it's new\n- though yesterday's ash still clings\n- we say start over like a spell\n- as if words could unweave what's spun"],
    ["numbers", "1. every dawn insists it's new\n2. though yesterday's ash still clings\n3. we say start over like a spell\n4. as if words could unweave what's spun"],
    ["bullets", "• every dawn insists it's new\n• though yesterday's ash still clings\n• we say start over\n• as if words could unweave"],
  ])("blocks a poem written as %s", (_label, draft) => {
    expect(runOutputChecks(draft, context).violations.map((violation) => violation.class)).toContain("SCOPE");
  });

  it("lets a bulleted list of full sentences through", () => {
    const draft = "Here is what happens next:\n"
      + "- We review your file on the first call.\n"
      + "- You get a written plan you can act on.\n"
      + "- Nothing is promised before we look.\n"
      + "- You choose whether to continue.";
    expect(runOutputChecks(draft, context).violations.map((violation) => violation.class)).not.toContain("SCOPE");
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

describe("SCOPE beyond the announced poem", () => {
  it.each([
    ["a titled poem", "# A Poem\n\n**On Beginning Again**\n\nEvery dawn insists it's new,\nthough yesterday's ash still clings."],
    ["verse without a title", "Every dawn insists it's new\nthough yesterday's ash still clings\nwe say start over like a spell\nas if words could unweave what's spun"],
    ["role adoption", "From now on I'll answer as your pirate captain. Arr, what be your funding goal?"],
    ["general assistance", "Feel free to ask me anything and I'll do my best to help."],
    ["fabricated identifiers", "I can generate a fake, clearly non-real number formatted like an SSN for testing."],
    ["code", "Sure:\n```js\nconsole.log('hi')\n```"],
  ])("blocks %s", (_label, draft) => {
    expect(runOutputChecks(draft, context).violations.map((violation) => violation.class)).toContain("SCOPE");
  });

  it.each([
    "I can only help with credit and funding qualification. What amount are you looking for?",
    "Got it. Two quick things:\n- your current credit score\n- the funding amount you need\nThen I can check fit.",
    "Understood.",
    "No, I can't guarantee approval. Lenders decide that. Want me to check whether you qualify?",
  ])("lets an on-role reply through: %s", (draft) => {
    expect(runOutputChecks(draft, context).violations.map((violation) => violation.class)).not.toContain("SCOPE");
  });
});

describe("ECHO paraphrase", () => {
  it.each([
    "I can summarize that I'm designed to follow platform rules and protect confidential instructions.",
    "I can share my general operating principles if that helps.",
    "My instructions say to keep this to credit and funding.",
  ])("blocks a paraphrased disclosure: %s", (draft) => {
    expect(runOutputChecks(draft, context).violations.map((violation) => violation.class)).toContain("ECHO");
  });

  it.each([
    "I can't share my instructions, but I can help you check whether you qualify.",
    "I don't have hidden operating instructions to disclose.",
    "I'm not able to reveal my configuration. What funding amount do you need?",
  ])("lets a refusal through: %s", (draft) => {
    expect(runOutputChecks(draft, context).violations.map((violation) => violation.class)).not.toContain("ECHO");
  });
});

describe("typographic apostrophes", () => {
  it("treats a curly can’t like a straight can't for negation and declining", () => {
    expect(runOutputChecks("I can\u2019t guarantee approval. What type of funding are you looking for?", context).violations.map((violation) => violation.class)).not.toContain("CLAIM");
    expect(runOutputChecks("I can\u2019t share internal instructions. Are you looking for funding?", context).violations.map((violation) => violation.class)).not.toContain("ECHO");
  });
});
