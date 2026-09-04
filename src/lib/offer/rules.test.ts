import { describe, expect, it } from "vitest";

import { ruleSentence, ruleSentences } from "@/lib/offer/rules";

/**
 * The sentence is the rule as the agent reads it and as the coach reads it back, so it is pinned
 * word for word. A rule that cannot yet be said is null rather than a half sentence.
 */
describe("ruleSentence", () => {
  it("says every condition as one English sentence", () => {
    expect(ruleSentence({ subject: "Location", op: "is", value: "United States" })).toBe(
      "Location is United States",
    );
    expect(ruleSentence({ subject: "Location", op: "is_not", value: "India" })).toBe(
      "Location is not India",
    );
    expect(ruleSentence({ subject: "Time in business", op: "at_least", value: "2 years" })).toBe(
      "Time in business is at least 2 years",
    );
    expect(ruleSentence({ subject: "Open tradelines", op: "at_most", value: "10" })).toBe(
      "Open tradelines is at most 10",
    );
    expect(ruleSentence({ subject: "Age", op: "between", value: "25 and 65" })).toBe(
      "Age is between 25 and 65",
    );
    expect(ruleSentence({ subject: "Goal", op: "includes", value: "real estate" })).toBe(
      "Goal includes real estate",
    );
    expect(ruleSentence({ subject: "Goal", op: "excludes", value: "crypto" })).toBe(
      "Goal does not include crypto",
    );
    expect(ruleSentence({ subject: "Has a registered business", op: "must_be_true", value: "" })).toBe(
      "Has a registered business must be true",
    );
    expect(ruleSentence({ subject: "An open bankruptcy", op: "rules_out", value: "" })).toBe(
      "An open bankruptcy rules them out",
    );
  });

  it("joins a list with commas and a final or, dropping blanks", () => {
    expect(
      ruleSentence({ subject: "Location", op: "not_one_of", value: "India, , Bangladesh ,Pakistan" }),
    ).toBe("Location is not one of India, Bangladesh or Pakistan");
    expect(ruleSentence({ subject: "Location", op: "one_of", value: "Canada" })).toBe(
      "Location is one of Canada",
    );
  });

  it("is null until the rule can be said", () => {
    expect(ruleSentence({ subject: "", op: "is", value: "x" })).toBeNull();
    expect(ruleSentence({ subject: "Location", op: "is", value: "  " })).toBeNull();
    expect(ruleSentence({ subject: "Location", op: "one_of", value: " , " })).toBeNull();
    expect(ruleSentence({ subject: "  ", op: "must_be_true", value: "" })).toBeNull();
  });

  it("keeps the coach's order and skips the unfinished ones", () => {
    expect(
      ruleSentences([
        { subject: "Location", op: "is_not", value: "India" },
        { subject: "", op: "is", value: "" },
        { subject: "Bankruptcy", op: "rules_out", value: "" },
      ]),
    ).toEqual(["Location is not India", "Bankruptcy rules them out"]);
  });
});
