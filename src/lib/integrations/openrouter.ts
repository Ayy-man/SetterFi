/**
 * OpenRouter owns only transport and provider-envelope narrowing.
 *
 * Prompt policy, deterministic output checks, and the moderator response ladder remain in the
 * engine; this module never rewrites a draft or turns an unavailable moderator into a verdict.
 */

import type { ActiveModelConfiguration } from "./selector";
import type { ModelDriver, ModeratorDriver } from "./types";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODERATOR_CLASSES = ["NUM", "CLAIM", "ECHO", "LINK", "SCOPE", "LEN", "JUDGE"] as const;

type JsonObject = Record<string, unknown>;
type FetchLike = typeof fetch;

export class OpenRouterProviderError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
    readonly bodyShape: string | null = null,
  ) {
    super(status === null ? code : `${code} (HTTP ${status})`);
    this.name = "OpenRouterProviderError";
  }
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function shape(value: unknown) {
  const row = object(value);
  return row ? Object.keys(row).sort().join(",") : Array.isArray(value) ? "array" : typeof value;
}

function stableId(prefix: string, values: readonly string[]) {
  let hash = 2_166_136_261;
  for (const character of values.join("|")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function modelVendorPrefix(model: string) {
  const separator = model.indexOf("/");
  return separator > 0 ? model.slice(0, separator) : model;
}

export function assertDifferentModelVendors(generatorModel: string, moderatorModel: string) {
  if (modelVendorPrefix(generatorModel) === modelVendorPrefix(moderatorModel)) {
    throw new OpenRouterProviderError("OPENROUTER_MODEL_VENDOR_COLLISION");
  }
}

/**
 * OpenRouter keeps a long non-streaming request alive by writing SSE-style comment lines
 * (`: OPENROUTER PROCESSING`) ahead of the JSON body, so the body is read as text and those
 * leading comment lines are dropped before parsing. Anything else that is not JSON still refuses.
 */
function stripKeepaliveComments(body: string) {
  return body.replace(/^(?:[ \t]*:[^\n]*\r?\n|\s)+/, "");
}

async function responseJson(response: Response, code: string) {
  let payload: unknown;
  try {
    payload = JSON.parse(stripKeepaliveComments(await response.text()));
  } catch {
    throw new OpenRouterProviderError(`${code}_MALFORMED_JSON`, response.status, "non-json");
  }
  if (!response.ok) throw new OpenRouterProviderError(code, response.status, shape(payload));
  return payload;
}

function completionContent(payload: unknown) {
  const row = object(payload);
  const choice = Array.isArray(row?.choices) ? object(row.choices[0]) : null;
  const message = object(choice?.message);
  const content = text(message?.content);
  if (!row || !content) {
    throw new OpenRouterProviderError("OPENROUTER_SUCCESS_ENVELOPE_INVALID", null, shape(payload));
  }
  return { row, content };
}

function parseUsage(payload: JsonObject) {
  const usage = object(payload.usage);
  const promptTokens = finiteNumber(usage?.prompt_tokens);
  const completionTokens = finiteNumber(usage?.completion_tokens);
  const totalTokens = finiteNumber(usage?.total_tokens);
  if (promptTokens === null || completionTokens === null || totalTokens === null) {
    throw new OpenRouterProviderError("OPENROUTER_USAGE_ENVELOPE_INVALID");
  }
  return { promptTokens, completionTokens, totalTokens };
}

function parseModeratorEnvelope(content: string) {
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    throw new OpenRouterProviderError("OPENROUTER_MODERATOR_JSON_INVALID");
  }
  const row = object(payload);
  const verdict = text(row?.verdict);
  const moderationClass = text(row?.class);
  const reason = text(row?.reason);
  const ruleId = row?.rule_id === undefined ? undefined : text(row.rule_id);
  const normalizedVerdict: "allow" | "block" | null =
    verdict === "allow" ? "allow" : verdict === "block" ? "block" : null;
  if (
    !normalizedVerdict ||
    !MODERATOR_CLASSES.includes(moderationClass as (typeof MODERATOR_CLASSES)[number]) ||
    !reason ||
    (row?.rule_id !== undefined && !ruleId)
  ) {
    throw new OpenRouterProviderError("OPENROUTER_MODERATOR_ENVELOPE_INVALID");
  }
  return {
    verdict: normalizedVerdict,
    class: moderationClass as (typeof MODERATOR_CLASSES)[number],
    ...(ruleId ? { rule_id: ruleId } : {}),
    reason,
  };
}

type TransportOptions = {
  fetch?: FetchLike;
  now?: () => number;
  createAbortController?: () => AbortController;
};

function transport(apiKey: string, options: TransportOptions = {}) {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const createAbortController = options.createAbortController ?? (() => new AbortController());

  return async (body: JsonObject, timeoutMs: number) => {
    const controller = createAbortController();
    const startedAt = now();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return { payload: await responseJson(response, "OPENROUTER_REQUEST_FAILED"), latencyMs: now() - startedAt };
    } finally {
      clearTimeout(timeout);
    }
  };
}

export function createMockModelDriver(configuration: ActiveModelConfiguration): ModelDriver {
  return {
    generate: async (messages, config) => {
      const lastUser = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
      const reply = `Mock response: ${lastUser}`;
      const system = messages.find((message) => message.role === "system")?.content ?? "";
      const declaredEntryId = system.match(/\[entry_id:([^\]]+)\]/)?.[1];
      const draft = declaredEntryId
        ? JSON.stringify({ reply, citation_entry_id: declaredEntryId })
        : reply;
      return {
        draft,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        provider: {
          name: "mock",
          generationId: stableId("mock-generation", [configuration.model, config.model, draft]),
          latencyMs: 0,
          cost: null,
        },
      };
    },
  };
}

export function createMockModeratorDriver(
  configuration: ActiveModelConfiguration,
): ModeratorDriver {
  return {
    moderate: async (inputs) => ({
      verdict: "allow",
      class: "JUDGE",
      reason: stableId("mock-moderator", [configuration.model, inputs.draft]),
    }),
  };
}

export function createRealModelDriver(
  apiKey: string,
  options: TransportOptions = {},
): ModelDriver {
  const request = transport(apiKey, options);
  return {
    generate: async (messages, config) => {
      // Providers occasionally return a well-formed completion whose message content is null
      // with finish_reason "stop" (observed live on anthropic/claude-opus-4.1 via Bedrock).
      // That is a transient, not a contract violation, so it gets two fresh attempts before
      // the envelope error propagates and fails the whole turn.
      let attempt = 0;
      let payload: unknown;
      let latencyMs = 0;
      let parsed: ReturnType<typeof completionContent> | null = null;
      for (;;) {
        ({ payload, latencyMs } = await request(
          // A bounded completion by default: OpenRouter precharges the full requested output
          // window, so an unbounded request can 402 on a funded key, and no DM-sized reply
          // needs more than this. A config row's params still override.
          { model: config.model, messages, max_tokens: 1024, ...config.params },
          30_000,
        ));
        try {
          parsed = completionContent(payload);
          break;
        } catch (error) {
          attempt += 1;
          const retryable = error instanceof OpenRouterProviderError
            && error.message === "OPENROUTER_SUCCESS_ENVELOPE_INVALID";
          if (!retryable || attempt >= 3) throw error;
        }
      }
      const { row, content } = parsed;
      const usage = parseUsage(row);
      return {
        draft: content,
        usage,
        provider: {
          name: text(row.provider) ?? "unreported",
          generationId: text(row.id),
          latencyMs,
          cost: finiteNumber(object(row.usage)?.cost),
        },
      };
    },
  };
}

export function createRealModeratorDriver(
  apiKey: string,
  configuration: ActiveModelConfiguration,
  options: TransportOptions = {},
): ModeratorDriver {
  const request = transport(apiKey, options);
  return {
    // Reasoning models are valid moderators, and they are slow: gpt-5 measures ~18s at default
    // effort and ~6s at reasoning.effort=minimal. The budget matches the generator arm so a
    // moderator row left at default effort still answers inside it.
    moderate: async (inputs) => {
      const { payload } = await request(
        {
          model: configuration.model,
          // Bounded for the same precharge reason as generation, and reasoning is held to
          // minimal by default because a verdict envelope needs none of it — gpt-5 measured
          // 18s at default effort against 6s at minimal. A config row's params still override.
          max_tokens: 2048,
          reasoning: { effort: "minimal" },
          ...configuration.params,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                'Return JSON with exactly these fields: "verdict" (must be exactly "allow" or "block"), ' +
                '"class" (must be exactly one of NUM, CLAIM, ECHO, LINK, SCOPE, LEN, JUDGE), ' +
                'optional "rule_id", and "reason" (short sentence). No other fields, no other verdict ' +
                "or class values. Never rewrite the draft. Use verdict \"allow\" with class JUDGE when " +
                "the draft is acceptable; use \"block\" with the class naming what it violates.",
            },
            { role: "user", content: JSON.stringify(inputs) },
          ],
        },
        30_000,
      );
      return parseModeratorEnvelope(completionContent(payload).content);
    },
  };
}
