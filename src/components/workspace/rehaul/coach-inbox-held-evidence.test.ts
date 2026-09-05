import { describe, expect, it } from "vitest";

import { heldEvidenceViewModel } from "@/components/workspace/rehaul/coach-inbox-held-evidence";

describe("heldEvidenceViewModel", () => {
  it.each([
    ["NUM", "used a number that is not in your offer"],
    ["CLAIM", "made a promise your compliance rules forbid"],
    ["ECHO", "repeated wording it should not"],
    ["LINK", "included a link that is not approved"],
    ["SCOPE", "went outside what your agent is allowed to discuss"],
    ["LEN", "went over the SMS length"],
    ["JUDGE", "failed a final compliance review"],
  ] as const)("translates %s into coach language", (evidenceClass, copy) => {
    expect(heldEvidenceViewModel({
      layer: "checker",
      class: evidenceClass,
      ruleId: "RULE-001",
      moderatorReason: null,
    })).toMatchObject({ title: `Held: ${copy}`, layer: "Checker", rule: "RULE-001" });
  });

  it("includes a moderator reason without accepting model configuration data", () => {
    expect(heldEvidenceViewModel({
      layer: "moderator",
      class: "CLAIM",
      ruleId: "CLAIM-001",
      moderatorReason: "The draft promised an approval outcome.",
    })).toEqual({
      title: "Held: made a promise your compliance rules forbid",
      layer: "Moderator",
      rule: "CLAIM-001",
      moderatorReason: "The draft promised an approval outcome.",
    });
  });
});
