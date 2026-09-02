/** Embedding contracts keep provider text transient and return only caller ids plus finite vectors. */

export const EMBEDDING_DIMENSIONS = 1536 as const;

export type EmbeddingInput = {
  id: string;
  text: string;
};

export type EmbeddingResult = {
  id: string;
  vector: readonly number[];
};

export interface EmbeddingsDriver {
  model: "mock-hash-1536" | "text-embedding-3-small";
  dimensions: typeof EMBEDDING_DIMENSIONS;
  embed(input: readonly EmbeddingInput[]): Promise<readonly EmbeddingResult[]>;
}

export class EmbeddingInputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "EmbeddingInputError";
  }
}

export function validateEmbeddingInput(input: readonly EmbeddingInput[]) {
  const ids = new Set<string>();
  for (const row of input) {
    if (!row.id.trim()) throw new EmbeddingInputError("EMBEDDING_INPUT_ID_REQUIRED");
    if (ids.has(row.id)) throw new EmbeddingInputError("EMBEDDING_INPUT_ID_DUPLICATE");
    if (!row.text.trim()) throw new EmbeddingInputError("EMBEDDING_INPUT_TEXT_REQUIRED");
    ids.add(row.id);
  }
}
