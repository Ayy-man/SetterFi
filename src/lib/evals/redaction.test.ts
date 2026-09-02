import { describe, expect, it } from "vitest";

import {
  assertPromotionRedacted,
  redactEvalTurns,
} from "./redaction";

describe("eval promotion redaction", () => {
  it("removes overlapping personal and client-identifying copy while retaining test figures", () => {
    const source = [{
      role: "user",
      content: "I'm Jordan Lee at Summit Credit Advisors, 12 Market Street. Email jordan.lee@example.test, call (415) 555-0134, or use https://summit.example.test/apply. I need $50,000 with a 720 score.",
    }];

    const result = redactEvalTurns(source);

    expect(result.redactedTurns).toEqual([{
      role: "user",
      content: "I'm [NAME] at [NAME], [ADDRESS]. Email [EMAIL], call [PHONE], or use [URL]. I need $50,000 with a 720 score.",
    }]);
    expect(result.redactionManifest).toEqual({
      placeholders: [
        { type: "ADDRESS", count: 1 },
        { type: "EMAIL", count: 1 },
        { type: "NAME", count: 2 },
        { type: "PHONE", count: 1 },
        { type: "URL", count: 1 },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("Jordan");
    expect(JSON.stringify(result)).not.toContain("415");
    expect(() => assertPromotionRedacted(
      result.redactedTurns,
      result.redactionManifest,
    )).not.toThrow();
  });

  it.each([
    "Contact me at lead@example.test",
    "Call 415-555-0134",
    "Visit https://client.example.test",
    "I'm Jordan Lee",
    "Meet at 12 Market Street",
    "This came from Summit Credit Advisors",
  ])("refuses residual sensitive copy rather than scrubbing at promotion time: %s", (content) => {
    expect(() => assertPromotionRedacted(
      [{ role: "user", content }],
      { placeholders: [] },
    )).toThrow("EVAL_PROMOTION_RESIDUAL_PII");
  });

  it("refuses a manifest count drift without including the source value in its error", () => {
    let message = "";
    try {
      assertPromotionRedacted(
        [{ role: "user", content: "Email [EMAIL]" }],
        { placeholders: [{ type: "EMAIL", count: 2 }] },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("EVAL_REDACTION_MANIFEST_MISMATCH");
    expect(message).not.toContain("Email");
  });
});
