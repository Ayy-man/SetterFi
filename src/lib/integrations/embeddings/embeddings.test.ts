import { describe, expect, it, vi } from "vitest";

import {
  DriverConfigurationError,
  environmentValue,
} from "@/lib/env-contract";

import { createMockEmbeddingsDriver } from "./mock";
import {
  createRealEmbeddingsDriver,
  embeddingBatches,
  OpenAiEmbeddingsError,
} from "./real";
import { resolveEmbeddingsDriver } from "./selector";
import { EMBEDDING_DIMENSIONS, EmbeddingInputError } from "./types";

function magnitude(vector: readonly number[]) {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

function syntheticVector(value: number) {
  const vector = Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = value;
  return vector;
}

describe("embedding driver selection", () => {
  it("chooses the deterministic mock when explicitly selected", () => {
    expect(resolveEmbeddingsDriver({ SETTERFI_EMBEDDINGS_DRIVER: "mock" })).toMatchObject({
      model: "mock-hash-1536",
      dimensions: 1536,
    });
  });

  it("fails explicit real selection by the missing key name before constructing network work", () => {
    expect(() => resolveEmbeddingsDriver({ SETTERFI_EMBEDDINGS_DRIVER: "real" })).toThrowError(
      DriverConfigurationError,
    );
    expect(() => resolveEmbeddingsDriver({ SETTERFI_EMBEDDINGS_DRIVER: "real" })).toThrow(
      /OPENAI_API_KEY/,
    );
  });
});

describe("deterministic mock embeddings", () => {
  it("returns stable normalized finite 1536-dimensional vectors that preserve caller order", async () => {
    const driver = createMockEmbeddingsDriver();
    const input = [
      { id: "synthetic-a", text: "A synthetic eligibility question" },
      { id: "synthetic-b", text: "A different synthetic scheduling question" },
    ];
    const first = await driver.embed(input);
    const second = await driver.embed(input);

    expect(first).toEqual(second);
    expect(first.map((row) => row.id)).toEqual(["synthetic-a", "synthetic-b"]);
    for (const row of first) {
      expect(row.vector).toHaveLength(EMBEDDING_DIMENSIONS);
      expect(row.vector.every(Number.isFinite)).toBe(true);
      expect(magnitude(row.vector)).toBeCloseTo(1, 12);
    }
    expect(first[0].vector).not.toEqual(first[1].vector);
  });

  it("rejects missing and duplicate ids rather than returning ambiguous results", async () => {
    const driver = createMockEmbeddingsDriver();
    await expect(driver.embed([{ id: " ", text: "synthetic" }])).rejects.toThrowError(
      EmbeddingInputError,
    );
    await expect(driver.embed([
      { id: "same", text: "first synthetic text" },
      { id: "same", text: "second synthetic text" },
    ])).rejects.toThrow(/EMBEDDING_INPUT_ID_DUPLICATE/);
  });
});

describe("real OpenAI embeddings adapter", () => {
  it("posts the pinned model and dimensions in bounded batches, then restores response order", async () => {
    const requestBodies: Array<{ model: string; dimensions: number; input: string[] }> = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        model: string;
        dimensions: number;
        input: string[];
      };
      requestBodies.push(body);
      const data = body.input.map((_text, index) => ({
        object: "embedding",
        index,
        embedding: syntheticVector(index + 1),
      })).reverse();
      return new Response(JSON.stringify({ object: "list", data }));
    });
    const driver = createRealEmbeddingsDriver("synthetic-test-key", { fetch: fetcher });
    const input = Array.from({ length: 130 }, (_, index) => ({
      id: `synthetic-${String(index).padStart(3, "0")}`,
      text: `Synthetic embedding input ${index}`,
    }));

    const results = await driver.embed(input);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(requestBodies.map((body) => body.input.length)).toEqual([128, 2]);
    expect(requestBodies.every((body) =>
      body.model === "text-embedding-3-small" && body.dimensions === EMBEDDING_DIMENSIONS,
    )).toBe(true);
    expect(results.map((row) => row.id)).toEqual(input.map((row) => row.id));
    expect(results[0].vector[0]).toBe(1);
    expect(results[127].vector[0]).toBe(128);
    expect(results[128].vector[0]).toBe(1);
    const headerNames = Object.keys(fetcher.mock.calls[0][1]?.headers ?? {}).sort();
    expect(headerNames).toEqual(["Authorization", "Content-Type"]);
  });

  it("rejects oversized input before fetch using the conservative local token guard", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const driver = createRealEmbeddingsDriver("synthetic-test-key", { fetch: fetcher });
    await expect(driver.embed([{
      id: "synthetic-large",
      text: "x".repeat(24_001),
    }])).rejects.toThrow(/EMBEDDING_INPUT_TOKEN_LIMIT_EXCEEDED/);
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => embeddingBatches([{ id: "synthetic-empty", text: " " }])).toThrowError(
      EmbeddingInputError,
    );
  });

  it.each([
    {
      name: "duplicate response indices",
      data: [
        { index: 0, embedding: syntheticVector(1) },
        { index: 0, embedding: syntheticVector(2) },
      ],
      error: "OPENAI_EMBEDDINGS_RESPONSE_INDEX_DUPLICATE",
    },
    {
      name: "a nonfinite vector",
      data: [
        { index: 0, embedding: [...syntheticVector(1).slice(0, -1), Number.NaN] },
        { index: 1, embedding: syntheticVector(2) },
      ],
      error: "OPENAI_EMBEDDINGS_VECTOR_INVALID",
    },
    {
      name: "the wrong vector dimensions",
      data: [
        { index: 0, embedding: [1, 2, 3] },
        { index: 1, embedding: syntheticVector(2) },
      ],
      error: "OPENAI_EMBEDDINGS_VECTOR_INVALID",
    },
  ])("refuses $name before returning any partial results", async ({ data, error }) => {
    const driver = createRealEmbeddingsDriver("synthetic-test-key", {
      fetch: async () => new Response(JSON.stringify({ data })),
    });
    await expect(driver.embed([
      { id: "synthetic-a", text: "first synthetic text" },
      { id: "synthetic-b", text: "second synthetic text" },
    ])).rejects.toThrow(error);
  });

  it("redacts provider response bodies to status and top-level shape", async () => {
    const providerBodyValue = "synthetic-provider-detail";
    const driver = createRealEmbeddingsDriver("synthetic-test-key", {
      fetch: async () => new Response(JSON.stringify({ error: providerBodyValue }), { status: 400 }),
    });
    try {
      await driver.embed([{ id: "synthetic", text: "synthetic text" }]);
      throw new Error("expected provider error");
    } catch (error) {
      expect(error).toBeInstanceOf(OpenAiEmbeddingsError);
      expect(error).toMatchObject({ status: 400, bodyShape: "error" });
      expect(String(error)).not.toContain(providerBodyValue);
    }
  });
});

const embeddingsRealSkipReason = environmentValue("SETTERFI_EMBEDDINGS_DRIVER") !== "real"
  ? "SETTERFI_EMBEDDINGS_DRIVER=real is required; OPENAI_API_KEY is required"
  : !environmentValue("OPENAI_API_KEY")
    ? "OPENAI_API_KEY is missing"
    : null;

describe.skipIf(Boolean(embeddingsRealSkipReason))(
  `OpenAI embeddings real arm — SKIPPED: ${embeddingsRealSkipReason ?? "configured"}`,
  () => {
    it("embeds one synthetic sentence without promoting the mock arm to provider evidence", async () => {
      const driver = resolveEmbeddingsDriver(process.env);
      const [result] = await driver.embed([{
        id: "synthetic-reachability",
        text: "This sentence contains synthetic reachability text only.",
      }]);
      expect(driver.model).toBe("text-embedding-3-small");
      expect(result.vector).toHaveLength(EMBEDDING_DIMENSIONS);
      expect(result.vector.every(Number.isFinite)).toBe(true);
    });
  },
);
