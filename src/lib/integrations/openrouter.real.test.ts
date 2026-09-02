import { describe, expect, it } from "vitest";

import { environmentValue, realArmSkipReason } from "@/lib/env-contract";

import {
  assertDifferentModelVendors,
  createRealModelDriver,
  createRealModeratorDriver,
} from "./openrouter";

const generator = { role: "generator" as const, model: "anthropic/claude-opus-4.1", params: {} };
const moderator = { role: "moderator" as const, model: "openai/gpt-5", params: {} };
const skipReason = realArmSkipReason(
  "openrouter",
  "SETTERFI_OPENROUTER_DRIVER",
  ["OPENROUTER_API_KEY"],
);

describe.skipIf(Boolean(skipReason))(
  `OpenRouter real arm — SKIPPED: ${skipReason ?? "configured"}`,
  () => {
    it("resolves both candidate model IDs through different vendors", async () => {
      assertDifferentModelVendors(generator.model, moderator.model);
      const apiKey = environmentValue("OPENROUTER_API_KEY")!;
      const model = createRealModelDriver(apiKey);
      const judge = createRealModeratorDriver(apiKey, moderator);
      const generated = await model.generate([{ role: "user", content: "Reply with the word ready." }], {
        model: generator.model,
        params: { max_tokens: 8 },
      });
      expect(generated.provider.generationId).toBeTruthy();
      await expect(
        judge.moderate({
          draft: generated.draft,
          leadMessage: "Are you ready?",
          numberAllowlist: [],
          complianceLexicon: [],
          linkWhitelist: [],
          roleBoundary: "Appointment setter",
        }),
      ).resolves.toMatchObject({ verdict: expect.stringMatching(/^(allow|block)$/) });
    });
  },
);
