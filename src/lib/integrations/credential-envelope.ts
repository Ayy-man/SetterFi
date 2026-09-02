import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  type BinaryLike,
} from "node:crypto";

import {
  DriverConfigurationError,
  driverSelection,
  type EnvironmentSource,
} from "@/lib/env-contract";

const ALGORITHM = "aes-256-gcm";
const ENCRYPTION_KEY_NAME = "SETTERFI_CREDENTIAL_ENCRYPTION_KEY";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const MOCK_KEY = createHash("sha256").update("setterfi-credential-envelope-mock-v1").digest();

export type CredentialEnvelopeV1 = {
  version: 1;
  keyVersion: 1;
  algorithm: "A256GCM";
  iv: string;
  ciphertext: string;
  tag: string;
};

export class CredentialEnvelopeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CredentialEnvelopeError";
  }
}

type RandomBytes = (size: number) => Buffer;

function configurationError(): never {
  throw new DriverConfigurationError("meta", [ENCRYPTION_KEY_NAME]);
}

function decodeBase64Url(value: unknown, code: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new CredentialEnvelopeError(code);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) throw new CredentialEnvelopeError(code);
  return decoded;
}

function deploymentKey(environment: EnvironmentSource) {
  const encoded = environment[ENCRYPTION_KEY_NAME]?.trim();
  if (!encoded) {
    if (driverSelection("meta", "SETTERFI_META_DRIVER", environment) === "real") {
      configurationError();
    }
    return MOCK_KEY;
  }
  let key: Buffer;
  try {
    key = decodeBase64Url(encoded, "CREDENTIAL_ENVELOPE_KEY_INVALID");
  } catch {
    configurationError();
  }
  if (key.length !== KEY_BYTES) configurationError();
  return key;
}

function validateEnvelope(value: unknown): CredentialEnvelopeV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CredentialEnvelopeError("CREDENTIAL_ENVELOPE_INVALID");
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.version !== 1) {
    throw new CredentialEnvelopeError("CREDENTIAL_ENVELOPE_VERSION_UNSUPPORTED");
  }
  if (envelope.keyVersion !== 1) {
    throw new CredentialEnvelopeError("CREDENTIAL_ENVELOPE_KEY_VERSION_UNSUPPORTED");
  }
  if (envelope.algorithm !== "A256GCM") {
    throw new CredentialEnvelopeError("CREDENTIAL_ENVELOPE_ALGORITHM_UNSUPPORTED");
  }
  const iv = decodeBase64Url(envelope.iv, "CREDENTIAL_ENVELOPE_INVALID");
  const ciphertext = decodeBase64Url(envelope.ciphertext, "CREDENTIAL_ENVELOPE_INVALID");
  const tag = decodeBase64Url(envelope.tag, "CREDENTIAL_ENVELOPE_INVALID");
  if (iv.length !== IV_BYTES || ciphertext.length === 0 || tag.length !== 16) {
    throw new CredentialEnvelopeError("CREDENTIAL_ENVELOPE_INVALID");
  }
  return {
    version: 1,
    keyVersion: 1,
    algorithm: "A256GCM",
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: tag.toString("base64url"),
  };
}

export function encryptCredential(
  plaintext: string,
  environment: EnvironmentSource = process.env,
  generateRandomBytes: RandomBytes = randomBytes,
): CredentialEnvelopeV1 {
  if (!plaintext) throw new CredentialEnvelopeError("CREDENTIAL_PLAINTEXT_REQUIRED");
  const key = deploymentKey(environment);
  const iv = generateRandomBytes(IV_BYTES);
  if (iv.length !== IV_BYTES) throw new CredentialEnvelopeError("CREDENTIAL_ENVELOPE_IV_INVALID");
  const cipher = createCipheriv(ALGORITHM, key as BinaryLike, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    version: 1,
    keyVersion: 1,
    algorithm: "A256GCM",
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

export function decryptCredential(
  value: unknown,
  environment: EnvironmentSource = process.env,
) {
  const envelope = validateEnvelope(value);
  const key = deploymentKey(environment);
  try {
    const decipher = createDecipheriv(ALGORITHM, key as BinaryLike, Buffer.from(envelope.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new CredentialEnvelopeError("CREDENTIAL_ENVELOPE_AUTHENTICATION_FAILED");
  }
}
