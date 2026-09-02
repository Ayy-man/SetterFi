/**
 * The mock projection is deterministic contract evidence, not semantic-search evidence.
 *
 * Token position participates in each signed bucket so order changes alter the vector, while L2
 * normalization keeps its numeric shape compatible with the real cosine-search boundary.
 */

import {
  EMBEDDING_DIMENSIONS,
  validateEmbeddingInput,
  type EmbeddingsDriver,
} from "./types";

function normalizedTokens(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function hash(value: string) {
  let result = 2_166_136_261;
  for (const character of value) {
    result ^= character.codePointAt(0) ?? 0;
    result = Math.imul(result, 16_777_619);
  }
  return result >>> 0;
}

export function mockEmbedding(value: string) {
  const vector = Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const [position, token] of normalizedTokens(value).entries()) {
    const tokenHash = hash(`${position}:${token}`);
    const bucket = tokenHash % EMBEDDING_DIMENSIONS;
    const sign = tokenHash & 0x80000000 ? -1 : 1;
    vector[bucket] += sign;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
  if (magnitude === 0) return vector;
  return vector.map((item) => item / magnitude);
}

export function createMockEmbeddingsDriver(): EmbeddingsDriver {
  return {
    model: "mock-hash-1536",
    dimensions: EMBEDDING_DIMENSIONS,
    embed: async (input) => {
      validateEmbeddingInput(input);
      return input.map(({ id, text }) => ({ id, vector: mockEmbedding(text) }));
    },
  };
}
