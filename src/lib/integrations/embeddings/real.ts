/**
 * The real embedding adapter batches transient text below documented provider limits.
 *
 * It validates response indices and vector values before restoring caller-id order, so a partial
 * or reordered provider response cannot attach an embedding to the wrong source row.
 */

import {
  EMBEDDING_DIMENSIONS,
  EmbeddingInputError,
  validateEmbeddingInput,
  type EmbeddingInput,
  type EmbeddingResult,
  type EmbeddingsDriver,
} from "./types";

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const MAX_BATCH_ITEMS = 128;
const MAX_INPUT_TOKENS_ESTIMATE = 8_000;
const MAX_BATCH_TOKENS_ESTIMATE = 250_000;
const CHARACTERS_PER_TOKEN_ESTIMATE = 3;

type JsonObject = Record<string, unknown>;
type FetchLike = typeof fetch;

export type RealEmbeddingsDependencies = {
  fetch?: FetchLike;
};

export class OpenAiEmbeddingsError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
    readonly bodyShape: string | null = null,
  ) {
    super(status === null ? code : `${code} (HTTP ${status})`);
    this.name = "OpenAiEmbeddingsError";
  }
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function bodyShape(value: unknown) {
  const record = object(value);
  return record ? Object.keys(record).sort().join(",") : Array.isArray(value) ? "array" : typeof value;
}

function estimatedTokens(value: string) {
  return Math.max(1, Math.ceil(value.length / CHARACTERS_PER_TOKEN_ESTIMATE));
}

export function embeddingBatches(input: readonly EmbeddingInput[]) {
  validateEmbeddingInput(input);
  const batches: EmbeddingInput[][] = [];
  let batch: EmbeddingInput[] = [];
  let batchTokens = 0;

  for (const row of input) {
    const tokens = estimatedTokens(row.text);
    if (tokens > MAX_INPUT_TOKENS_ESTIMATE) {
      throw new EmbeddingInputError("EMBEDDING_INPUT_TOKEN_LIMIT_EXCEEDED");
    }
    if (
      batch.length > 0 &&
      (batch.length >= MAX_BATCH_ITEMS || batchTokens + tokens > MAX_BATCH_TOKENS_ESTIMATE)
    ) {
      batches.push(batch);
      batch = [];
      batchTokens = 0;
    }
    batch.push(row);
    batchTokens += tokens;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

async function responseJson(response: Response) {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new OpenAiEmbeddingsError("OPENAI_EMBEDDINGS_MALFORMED_JSON", response.status, "non-json");
  }
  if (!response.ok) {
    throw new OpenAiEmbeddingsError(
      "OPENAI_EMBEDDINGS_REQUEST_FAILED",
      response.status,
      bodyShape(payload),
    );
  }
  return payload;
}

function orderedBatchResults(payload: unknown, batch: readonly EmbeddingInput[]) {
  const data = object(payload)?.data;
  if (!Array.isArray(data) || data.length !== batch.length) {
    throw new OpenAiEmbeddingsError("OPENAI_EMBEDDINGS_RESPONSE_COUNT_INVALID");
  }
  const byIndex = new Map<number, readonly number[]>();
  for (const item of data) {
    const row = object(item);
    const index = row?.index;
    const vector = row?.embedding;
    if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= batch.length) {
      throw new OpenAiEmbeddingsError("OPENAI_EMBEDDINGS_RESPONSE_INDEX_INVALID");
    }
    if (byIndex.has(index as number)) {
      throw new OpenAiEmbeddingsError("OPENAI_EMBEDDINGS_RESPONSE_INDEX_DUPLICATE");
    }
    if (
      !Array.isArray(vector) ||
      vector.length !== EMBEDDING_DIMENSIONS ||
      !vector.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      throw new OpenAiEmbeddingsError("OPENAI_EMBEDDINGS_VECTOR_INVALID");
    }
    byIndex.set(index as number, vector as number[]);
  }
  return batch.map((input, index): EmbeddingResult => {
    const vector = byIndex.get(index);
    if (!vector) throw new OpenAiEmbeddingsError("OPENAI_EMBEDDINGS_RESPONSE_INDEX_MISSING");
    return { id: input.id, vector };
  });
}

export function createRealEmbeddingsDriver(
  apiKey: string,
  { fetch: fetcher = fetch }: RealEmbeddingsDependencies = {},
): EmbeddingsDriver {
  return {
    model: OPENAI_EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    embed: async (input) => {
      const results: EmbeddingResult[] = [];
      for (const batch of embeddingBatches(input)) {
        const response = await fetcher(OPENAI_EMBEDDINGS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: OPENAI_EMBEDDING_MODEL,
            dimensions: EMBEDDING_DIMENSIONS,
            input: batch.map((row) => row.text),
          }),
        });
        results.push(...orderedBatchResults(await responseJson(response), batch));
      }
      return results;
    },
  };
}
