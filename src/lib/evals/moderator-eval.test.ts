import { describe, expect, it } from "vitest";

import type { ModeratorVerdict } from "@/lib/engine/moderator";
import type { ModeratorCorpusCase } from "./moderator-corpus";
import { runModeratorCorpus, scoreModeratorCase } from "./moderator-eval";

const PAYLOAD = {
  draft: "What's your credit score range?",
  leadMessage: "hey",
  numberAllowlist: ["currency:297:offer_price:synthetic-price-1"],
  complianceLexicon: ["guarantee approval"],
  linkWhitelist: ["book.example-coaching.test"],
  roleBoundary: "credit and funding qualification only",
};

function testCase(
  key: string,
  expectation: ModeratorCorpusCase["expectation"],
  category: ModeratorCorpusCase["category"] = "qualification",
): ModeratorCorpusCase {
  return { key, category, expectation, payload: { ...PAYLOAD, draft: `${PAYLOAD.draft} ${key}` } };
}

const allow: ModeratorVerdict = { verdict: "allow", class: "JUDGE", reason: "clean" };
const block = (cls: ModeratorVerdict["class"]): ModeratorVerdict =>
  ({ verdict: "block", class: cls, reason: `${cls} tripped` });

describe("scoreModeratorCase", () => {
  it("scores each of the four verdict outcomes", () => {
    expect(scoreModeratorCase({ verdict: "allow" }, allow)).toBe("correct");
    expect(scoreModeratorCase({ verdict: "allow" }, block("NUM"))).toBe("false_block");
    expect(scoreModeratorCase({ verdict: "block", class: "NUM" }, allow)).toBe("false_allow");
    expect(scoreModeratorCase({ verdict: "block", class: "NUM" }, block("NUM"))).toBe("correct");
    expect(scoreModeratorCase({ verdict: "block", class: "NUM" }, block("CLAIM"))).toBe("class_mismatch");
  });
});

describe("runModeratorCorpus", () => {
  const cases = [
    testCase("allow-ok", { verdict: "allow" }),
    testCase("allow-held", { verdict: "allow" }),
    testCase("block-ok", { verdict: "block", class: "CLAIM" }, "negated_lexicon"),
    testCase("block-leaked", { verdict: "block", class: "NUM" }, "invented_number"),
    testCase("block-wrong-class", { verdict: "block", class: "LINK" }, "unapproved_link"),
    testCase("block-errored", { verdict: "block", class: "SCOPE" }, "role_adoption"),
  ];
  const scripted: Record<string, () => Promise<ModeratorVerdict>> = {
    "allow-ok": async () => allow,
    "allow-held": async () => block("LEN"),
    "block-ok": async () => block("CLAIM"),
    "block-leaked": async () => allow,
    "block-wrong-class": async () => block("SCOPE"),
    "block-errored": async () => { throw new Error("MODERATOR_TIMEOUT"); },
  };

  it("calls the moderator once per case with the case payload and scores every outcome", async () => {
    const seen: string[] = [];
    let tick = 0;
    const { results, summary } = await runModeratorCorpus({
      cases,
      now: () => { tick += 10; return tick; },
      moderate: async (payload) => {
        const key = payload.draft.split(" ").at(-1) as string;
        seen.push(key);
        expect(payload.numberAllowlist).toEqual(PAYLOAD.numberAllowlist);
        expect(payload.roleBoundary).toBe(PAYLOAD.roleBoundary);
        return scripted[key]();
      },
    });

    expect(seen).toEqual(cases.map((c) => c.key));
    expect(results.map((r) => [r.key, r.outcome, r.correct])).toEqual([
      ["allow-ok", "correct", true],
      ["allow-held", "false_block", false],
      ["block-ok", "correct", true],
      ["block-leaked", "false_allow", false],
      ["block-wrong-class", "class_mismatch", false],
      ["block-errored", "error", false],
    ]);
    expect(results[3].actual).toEqual({ verdict: "allow", class: "JUDGE", reason: "clean" });
    expect(results[3].expected).toEqual({ verdict: "block", class: "NUM" });
    expect(results[5].actual).toBeNull();
    expect(results[5].error).toBe("MODERATOR_TIMEOUT");
    expect(results.every((r) => r.latencyMs === 10)).toBe(true);

    expect(summary).toEqual({
      total: 6,
      correct: 2,
      falseAllows: 1,
      falseBlocks: 1,
      classMismatches: 1,
      errors: 1,
      accuracy: 2 / 6,
      verdictAccuracy: 3 / 6,
      expectedBlocks: 4,
      expectedAllows: 2,
      falseAllowRate: 1 / 4,
      falseBlockRate: 1 / 2,
      p50LatencyMs: 10,
      p95LatencyMs: 10,
    });
  });

  it("reports p50 latency from the measured distribution and zero rates on an empty corpus", async () => {
    const durations = [50, 5, 500, 20, 100];
    let index = 0;
    let clock = 0;
    const { summary } = await runModeratorCorpus({
      cases: durations.map((_, i) => testCase(`c${i}`, { verdict: "allow" })),
      now: () => clock,
      moderate: async () => { clock += durations[index]; index += 1; return allow; },
    });
    expect(summary.p50LatencyMs).toBe(50);
    expect(summary.p95LatencyMs).toBe(500);
    expect(summary.accuracy).toBe(1);

    const empty = await runModeratorCorpus({ cases: [], moderate: async () => allow });
    expect(empty.summary).toMatchObject({
      total: 0, accuracy: 0, falseAllowRate: 0, falseBlockRate: 0, p50LatencyMs: 0,
    });
  });
});
