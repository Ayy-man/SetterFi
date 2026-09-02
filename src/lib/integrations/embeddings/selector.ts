/** Embedding selection applies the shared mock/real rule before constructing a network-capable arm. */

import {
  driverSelection,
  requireEnvironment,
  type EnvironmentSource,
} from "@/lib/env-contract";

import { createMockEmbeddingsDriver } from "./mock";
import { createRealEmbeddingsDriver, type RealEmbeddingsDependencies } from "./real";
import type { EmbeddingsDriver } from "./types";

export function resolveEmbeddingsDriver(
  environment: EnvironmentSource = process.env,
  realDependencies: RealEmbeddingsDependencies = {},
): EmbeddingsDriver {
  if (driverSelection("embeddings", "SETTERFI_EMBEDDINGS_DRIVER", environment) === "mock") {
    return createMockEmbeddingsDriver();
  }
  const apiKey = requireEnvironment(
    "embeddings",
    ["OPENAI_API_KEY"],
    environment,
  ).OPENAI_API_KEY;
  return createRealEmbeddingsDriver(apiKey, realDependencies);
}
