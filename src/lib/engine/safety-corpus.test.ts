import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const databaseSentinel = vi.hoisted(() => vi.fn(() => {
  throw new Error("SAFETY_CORPUS_DATABASE_ACCESS_FORBIDDEN");
}));

vi.mock("@supabase/supabase-js", () => ({ createClient: databaseSentinel }));

import { runOutputChecks } from "@/lib/engine/output-checks";
import {
  PHASE3_CHECKER_PROJECTIONS,
  PHASE3_ENGINE_CASES,
  SAFETY_CORPUS,
} from "@/lib/engine/safety-corpus";

const originalFetch = globalThis.fetch;
const fetchSentinel = vi.fn(() => {
  throw new Error("SAFETY_CORPUS_NETWORK_ACCESS_FORBIDDEN");
});

beforeAll(() => {
  globalThis.fetch = fetchSentinel;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("repo-held safety corpus", () => {
  for (const testCase of SAFETY_CORPUS) {
    it(testCase.id, () => {
      const result = runOutputChecks(testCase.draft, testCase.context);
      if (testCase.expectedClass === null) {
        expect(result.violations).toEqual([]);
      } else {
        expect(result.violations.map((violation) => violation.class)).toContain(testCase.expectedClass);
      }
    });
  }

  it("does not touch network or a Supabase client", () => {
    expect(fetchSentinel).not.toHaveBeenCalled();
    expect(databaseSentinel).not.toHaveBeenCalled();
  });

  it("projects the required Phase 3 cases through the four existing suite files", () => {
    expect([...new Set(PHASE3_CHECKER_PROJECTIONS.map((testCase) => testCase.suite))].sort()).toEqual([
      "compliance_guardrails",
      "jailbreak_injection",
      "output_integrity",
      "pricing_discipline",
    ]);
    expect(PHASE3_CHECKER_PROJECTIONS.map((testCase) => testCase.id)).toEqual(expect.arrayContaining([
      "phase3:compliance:stop-control-projection",
      "phase3:compliance:help-control-projection",
      "phase3:compliance:start-control-projection",
      "phase3:compliance:stop-substring-negative-projection",
      "phase3:compliance:cross-class-second-hit-projection",
      "phase3:jailbreak:multi-turn-scope-cap-projection",
      "phase3:jailbreak:missing-caller-history-projection",
      "phase3:output:closing-tag-sanitizer-projection",
      "phase3:output:scope-check-does-not-increment-inbound",
    ]));
  });

  it("keeps inherently model-executed Phase 3 cases tagged for the existing engine arm", () => {
    expect(PHASE3_ENGINE_CASES.map((testCase) => testCase.key)).toEqual([
      "phase3:compliance:engine-stop-idempotency",
      "phase3:compliance:engine-cross-class-tripwire",
      "phase3:pricing:engine-outcome-pressure",
      "phase3:jailbreak:engine-three-turn-scope-cap",
      "phase3:jailbreak:engine-missing-caller-history",
      "phase3:output:engine-nested-sanitizer",
    ]);
  });
});
