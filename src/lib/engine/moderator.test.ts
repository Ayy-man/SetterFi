import { describe, expect, it, vi } from "vitest";

import {
  buildModeratorPayload,
  moderateDraft,
  parseModeratorVerdict,
} from "@/lib/engine/moderator";

const INPUTS = {
  draft: "A grounded reply.",
  leadMessage: "Can you guarantee it?",
  numberAllowlist: ["score:681"],
  complianceLexicon: ["guarantee"],
  linkWhitelist: ["summit.example"],
  roleBoundary: "credit and funding qualification only",
};

describe("parseModeratorVerdict", () => {
  it("accepts the six deterministic classes plus JUDGE", () => {
    for (const value of ["NUM", "CLAIM", "ECHO", "LINK", "SCOPE", "LEN", "JUDGE"]) {
      expect(parseModeratorVerdict({ verdict: "block", class: value, rule_id: "RULE-001", reason: "unsafe" }).class)
        .toBe(value);
    }
  });

  it.each([
    { verdict: "allow", class: "JUDGE", reason: "safe", replacement: "rewrite" },
    { verdict: "maybe", class: "JUDGE", reason: "unclear" },
    { verdict: "block", class: "OTHER", reason: "unsafe" },
    { verdict: "block", class: "REVOKE", reason: "unsafe" },
    { verdict: "block", class: "JUDGE", reason: "", rule_id: "JUDGE-001" },
  ])("rejects open or malformed verdict output", (value) => {
    expect(() => parseModeratorVerdict(value)).toThrow();
  });
});

describe("moderateDraft", () => {
  it("sends exactly the six named inputs without Brain or coach data", async () => {
    const moderate = vi.fn(async (inputs: typeof INPUTS) => {
      expect(inputs).toEqual(INPUTS);
      return {
        verdict: "allow" as const,
        class: "JUDGE" as const,
        reason: "safe",
      };
    });
    await moderateDraft({ driver: { moderate }, inputs: INPUTS, mode: "production" });
    expect(Object.keys(buildModeratorPayload(INPUTS)).sort()).toEqual([
      "complianceLexicon", "draft", "leadMessage", "linkWhitelist", "numberAllowlist", "roleBoundary",
    ]);
    expect(JSON.stringify(moderate.mock.calls[0][0])).not.toMatch(/tenant_offer|\[B\] THE BRAIN/i);
  });

  it.each([
    ["timeout", () => new Promise<never>(() => undefined), 5],
    ["provider error", async () => { throw new Error("PROVIDER_RATE_LIMITED"); }, 2_000],
  ] as const)("fails closed in production on %s", async (_name, moderate, timeoutMs) => {
    const result = await moderateDraft({ driver: { moderate }, inputs: INPUTS, mode: "production", timeoutMs });
    expect(result).toMatchObject({
      kind: "refused",
      proceed: false,
      moderatorUnavailableIncrement: 1,
      trace: { moderator: "unavailable" },
    });
  });

  it("refuses to count an unavailable eval as passing evidence", async () => {
    const result = await moderateDraft({
      driver: { moderate: async () => { throw new Error("NO_PROVIDER"); } },
      inputs: INPUTS,
      mode: "eval",
    });
    expect(result).toMatchObject({
      kind: "refused",
      mode: "eval",
      proceed: false,
      moderatorUnavailableIncrement: 1,
      trace: { moderator: "unavailable", mode: "eval", reason: "NO_PROVIDER" },
    });
  });

  it.each(["production", "test", "eval"] as const)(
    "stamps %s mode on every verdict kind without changing the driver call",
    async (mode) => {
      const allow = vi.fn<(inputs: typeof INPUTS) => Promise<unknown>>(async () => ({
        verdict: "allow", class: "JUDGE", reason: "safe",
      }));
      const block = vi.fn<(inputs: typeof INPUTS) => Promise<unknown>>(async () => ({
        verdict: "block", class: "CLAIM", rule_id: "CLAIM-001", reason: "guarantee",
      }));
      const allowed = await moderateDraft({ driver: { moderate: allow }, inputs: INPUTS, mode });
      const blocked = await moderateDraft({ driver: { moderate: block }, inputs: INPUTS, mode });
      const refused = await moderateDraft({
        driver: { moderate: async () => { throw new Error("DOWN"); } }, inputs: INPUTS, mode,
      });
      expect(allowed).toMatchObject({ kind: "allowed", mode });
      expect(blocked).toMatchObject({ kind: "blocked", mode });
      expect(refused).toMatchObject({ kind: "refused", mode, trace: { mode } });
      // The mode reaches the record, never the provider: the payload stays the six named fields.
      expect(allow.mock.calls[0][0]).toEqual(INPUTS);
      expect(block.mock.calls[0][0]).toEqual(INPUTS);
    },
  );
});
