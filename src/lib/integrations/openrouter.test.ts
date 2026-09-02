import { describe, expect, it, vi } from "vitest";

import {
  OpenRouterProviderError,
  assertDifferentModelVendors,
  createMockModelDriver,
  createMockModeratorDriver,
  createRealModelDriver,
  createRealModeratorDriver,
} from "./openrouter";

const generator = { role: "generator" as const, model: "anthropic/generator", params: {} };
const moderator = { role: "moderator" as const, model: "openai/moderator", params: {} };

describe("OpenRouter model pairing", () => {
  it("rejects equal vendor prefixes before either arm can be called", () => {
    expect(() => assertDifferentModelVendors("same/generator", "same/moderator")).toThrow(
      /OPENROUTER_MODEL_VENDOR_COLLISION/,
    );
    expect(() => assertDifferentModelVendors(generator.model, moderator.model)).not.toThrow();
  });

  it("keeps both mock arms deterministic and network-free", async () => {
    const model = createMockModelDriver(generator);
    const messages = [{ role: "user" as const, content: "Hello" }];
    expect(await model.generate(messages, { model: generator.model, params: {} })).toEqual(
      await model.generate(messages, { model: generator.model, params: {} }),
    );
    const judge = createMockModeratorDriver(moderator);
    const inputs = {
      draft: "Hello",
      leadMessage: "Hi",
      numberAllowlist: [],
      complianceLexicon: [],
      linkWhitelist: [],
      roleBoundary: "Appointment setter",
    };
    expect(await judge.moderate(inputs)).toEqual(await judge.moderate(inputs));
  });

  it("declares an exact prompt candidate in the credless Phase 2 arm", async () => {
    const model = createMockModelDriver(generator);
    const result = await model.generate([
      { role: "system", content: "[entry_id:synthetic-entry] Synthetic candidate" },
      { role: "user", content: "Hello" },
    ], { model: generator.model, params: {} });
    expect(JSON.parse(result.draft)).toEqual({
      reply: "Mock response: Hello",
      citation_entry_id: "synthetic-entry",
    });
  });
});

describe("OpenRouter real transport", () => {
  it("attaches required headers and returns narrowed generation usage and metadata", async () => {
    let captured: RequestInit | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      captured = init;
      return new Response(
        JSON.stringify({
          id: "generation-1",
          provider: "provider-name",
          choices: [{ message: { content: "Draft" } }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, cost: 0.01 },
        }),
        { status: 200 },
      );
    };
    const driver = createRealModelDriver("injected-api-key", {
      fetch: fetcher,
      now: (() => {
        const values = [100, 125];
        return () => values.shift() ?? 125;
      })(),
    });
    await expect(
      driver.generate([{ role: "user", content: "Hello" }], {
        model: generator.model,
        params: { temperature: 0 },
      }),
    ).resolves.toEqual({
      draft: "Draft",
      usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
      provider: { name: "provider-name", generationId: "generation-1", latencyMs: 25, cost: 0.01 },
    });
    expect(captured?.headers).toMatchObject({
      Authorization: "Bearer injected-api-key",
      "Content-Type": "application/json",
    });
  });

  it("returns a four-field moderator verdict and never accepts replacement text", async () => {
    let captured: RequestInit | undefined;
    const fetcher: typeof fetch = async (_input, init) => {
      captured = init;
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: JSON.stringify({ verdict: "block", class: "JUDGE", reason: "claim" }) } },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 },
      );
    };
    const driver = createRealModeratorDriver("injected-api-key", moderator, { fetch: fetcher });
    await expect(
      driver.moderate({
        draft: "Draft",
        leadMessage: "Lead",
        numberAllowlist: [],
        complianceLexicon: [],
        linkWhitelist: [],
        roleBoundary: "Setter",
      }),
    ).resolves.toEqual({ verdict: "block", class: "JUDGE", reason: "claim" });
    const request = JSON.parse(String(captured?.body));
    expect(request.messages[0].content).toContain("Never rewrite");
  });

  it("holds the moderator request open for thirty seconds so a reasoning model can answer", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let abortedAt: number | null = null;
      let elapsed = 0;
      controller.signal.addEventListener("abort", () => {
        abortedAt = elapsed;
      });
      const driver = createRealModeratorDriver("injected-api-key", moderator, {
        createAbortController: () => controller,
        fetch: (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      });
      const settled = driver
        .moderate({
          draft: "Draft",
          leadMessage: "Lead",
          numberAllowlist: [],
          complianceLexicon: [],
          linkWhitelist: [],
          roleBoundary: "Setter",
        })
        .then(
          () => "resolved",
          (error: unknown) => String(error),
        );
      elapsed = 29_999;
      await vi.advanceTimersByTimeAsync(29_999);
      expect(abortedAt).toBeNull();
      elapsed = 30_000;
      await vi.advanceTimersByTimeAsync(1);
      expect(abortedAt).toBe(30_000);
      expect(await settled).toContain("aborted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects malformed success and error envelopes without repeating provider details", async () => {
    const malformed = createRealModelDriver("injected-api-key", {
      fetch: async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
    });
    await expect(
      malformed.generate([], { model: generator.model, params: {} }),
    ).rejects.toThrow(/OPENROUTER_SUCCESS_ENVELOPE_INVALID/);

    const failed = createRealModelDriver("injected-api-key", {
      fetch: async () => new Response(JSON.stringify({ privateDetail: "not-repeated" }), { status: 429 }),
    });
    try {
      await failed.generate([], { model: generator.model, params: {} });
    } catch (error) {
      expect(error).toBeInstanceOf(OpenRouterProviderError);
      expect(String(error)).not.toContain("not-repeated");
    }
  });
});
