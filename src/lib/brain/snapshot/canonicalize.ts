/**
 * Deterministic Brain draft serialization shared by draft creation, diffs, and eval identity.
 *
 * Database timestamps are deliberately excluded: a read-back time must not make unchanged content
 * look publishable. The serializer mirrors PostgreSQL jsonb text ordering because the Wave 1 RPC
 * independently hashes `payload::text` before it accepts an immutable draft revision.
 */

import { createHash } from "node:crypto";

export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

export type BrainDraftEntity = {
  type: string;
  id: string;
  value: Readonly<Record<string, unknown>>;
};

export type BrainDraftPayloadInput = {
  entities: readonly BrainDraftEntity[];
  compiledPlatform: string;
  platformTokens: number;
  knowledgeMode: "inline" | "retrieved";
  /** Optional similarity floor for retrieval, in [0, 1]; absent means the code default. */
  retrievalFloor?: number;
  sourceHash?: string;
  placeholderSchemaHash?: string;
  placeholderResolutionHash?: string;
};

export type CanonicalBrainEntity = {
  type: string;
  id: string;
  value: { [key: string]: CanonicalJson };
};

export type CanonicalBrainPayload = {
  entities: CanonicalBrainEntity[];
  compiledPlatform: string;
  platformTokens: number;
  knowledgeMode: "inline" | "retrieved";
  retrievalFloor?: number;
  sourceHash?: string;
  placeholderSchemaHash?: string;
  placeholderResolutionHash?: string;
};

const TIMESTAMP_KEY = /(?:^|_)(?:created|updated|published|fetched|decided)_at$|(?:Created|Updated|Published|Fetched|Decided)At$/;

function compareJsonbKeys(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length - rightBytes.length || Buffer.compare(leftBytes, rightBytes);
}

function normalizeJson(value: unknown, path: string): CanonicalJson {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.replace(/\r\n?/g, "\n");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`BRAIN_CANONICAL_NUMBER_INVALID:${path}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => normalizeJson(entry, `${path}[${index}]`));
  }
  if (!value || typeof value !== "object") {
    throw new Error(`BRAIN_CANONICAL_VALUE_INVALID:${path}`);
  }

  const output: { [key: string]: CanonicalJson } = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !TIMESTAMP_KEY.test(key))
    .sort(([left], [right]) => compareJsonbKeys(left, right))) {
    if (entry === undefined) throw new Error(`BRAIN_CANONICAL_VALUE_INVALID:${path}.${key}`);
    output[key] = normalizeJson(entry, `${path}.${key}`);
  }
  return output;
}

function serializeJsonb(value: CanonicalJson): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(serializeJsonb).join(", ")}]`;
  return `{${Object.keys(value)
    .sort(compareJsonbKeys)
    .map((key) => `${JSON.stringify(key)}: ${serializeJsonb(value[key])}`)
    .join(", ")}}`;
}

export function canonicalizeBrainDraft(input: BrainDraftPayloadInput): CanonicalBrainPayload {
  const seen = new Set<string>();
  const entities = input.entities.map((entity) => {
    const type = entity.type.trim();
    const id = entity.id.trim();
    if (!type || !id) throw new Error("BRAIN_CANONICAL_ENTITY_ID_REQUIRED");
    const key = `${type}:${id}`;
    if (seen.has(key)) throw new Error(`BRAIN_CANONICAL_ENTITY_DUPLICATE:${key}`);
    seen.add(key);
    return {
      type,
      id,
      value: normalizeJson(entity.value, key) as { [key: string]: CanonicalJson },
    };
  }).sort((left, right) => left.type.localeCompare(right.type) || left.id.localeCompare(right.id));

  if (!Number.isSafeInteger(input.platformTokens) || input.platformTokens < 0) {
    throw new Error("BRAIN_CANONICAL_PLATFORM_TOKENS_INVALID");
  }
  const payload: CanonicalBrainPayload = {
    entities,
    compiledPlatform: input.compiledPlatform.replace(/\r\n?/g, "\n"),
    platformTokens: input.platformTokens,
    knowledgeMode: input.knowledgeMode,
  };
  if (input.retrievalFloor !== undefined) {
    if (
      typeof input.retrievalFloor !== "number" || !Number.isFinite(input.retrievalFloor) ||
      input.retrievalFloor < 0 || input.retrievalFloor > 1
    ) throw new Error("BRAIN_CANONICAL_RETRIEVAL_FLOOR_INVALID");
    payload.retrievalFloor = input.retrievalFloor;
  }
  if (input.sourceHash) payload.sourceHash = input.sourceHash;
  if (input.placeholderSchemaHash) payload.placeholderSchemaHash = input.placeholderSchemaHash;
  if (input.placeholderResolutionHash) {
    payload.placeholderResolutionHash = input.placeholderResolutionHash;
  }
  return payload;
}

export function serializeCanonicalJson(value: CanonicalJson) {
  return serializeJsonb(normalizeJson(value, "payload"));
}

export function contentHashForPayload(payload: CanonicalBrainPayload) {
  return createHash("sha256").update(serializeCanonicalJson(payload)).digest("hex");
}
