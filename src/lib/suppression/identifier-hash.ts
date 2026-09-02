/**
 * Application-side HMAC boundary for suppression identifiers.
 *
 * SQL receives only the lowercase digest. Errors name the missing configuration or input class,
 * never the normalized identifier or the deployment-held pepper used to derive it.
 */

import { createHmac } from "node:crypto";

import {
  DriverConfigurationError,
  environmentValue,
  type EnvironmentSource,
} from "@/lib/env-contract";

export class IdentifierHashInputError extends Error {
  readonly code = "IDENTIFIER_HASH_INPUT_INVALID";

  constructor() {
    super("Normalized identifier is required");
    this.name = "IdentifierHashInputError";
  }
}

export function hashSuppressionIdentifier(
  normalizedIdentifier: string,
  environment: EnvironmentSource = process.env,
) {
  if (!normalizedIdentifier || normalizedIdentifier !== normalizedIdentifier.trim() ||
    /[\u0000-\u001f\u007f]/.test(normalizedIdentifier)) {
    throw new IdentifierHashInputError();
  }
  const pepper = environmentValue("SETTERFI_SUPPRESSION_PEPPER", environment);
  if (!pepper) {
    throw new DriverConfigurationError("suppression", ["SETTERFI_SUPPRESSION_PEPPER"]);
  }
  return createHmac("sha256", pepper).update(normalizedIdentifier, "utf8").digest("hex");
}
