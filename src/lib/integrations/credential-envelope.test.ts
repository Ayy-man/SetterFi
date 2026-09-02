import { describe, expect, it } from "vitest";

import {
  decryptCredential,
  encryptCredential,
  type CredentialEnvelopeV1,
} from "@/lib/integrations/credential-envelope";
import { DriverConfigurationError } from "@/lib/env-contract";

const key = Buffer.alloc(32, 7).toString("base64url");
const otherKey = Buffer.alloc(32, 8).toString("base64url");
const environment = { SETTERFI_CREDENTIAL_ENCRYPTION_KEY: key };
const fixedIv = () => Buffer.alloc(12, 3);

describe("credential envelope", () => {
  it("round-trips V1 with a 96-bit IV and base64url byte fields", () => {
    const envelope = encryptCredential("credential-canary", environment, fixedIv);

    expect(envelope).toEqual({
      version: 1,
      keyVersion: 1,
      algorithm: "A256GCM",
      iv: Buffer.alloc(12, 3).toString("base64url"),
      ciphertext: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      tag: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
    });
    expect(decryptCredential(envelope, environment)).toBe("credential-canary");
  });

  it("round-trips a long OAuth-shaped credential whose PostgreSQL base64 rendering would wrap", () => {
    const credential = `header.${"x".repeat(320)}.signature`;
    const envelope = encryptCredential(credential, environment, fixedIv);
    expect(Buffer.from(envelope.ciphertext, "base64url").length).toBeGreaterThan(57);
    expect(decryptCredential(envelope, environment)).toBe(credential);
  });

  it("uses the mock envelope when the mock selector is explicit", () => {
    const mockEnvironment = { SETTERFI_META_DRIVER: "mock" };
    const envelope = encryptCredential("mock-credential", mockEnvironment, fixedIv);
    expect(decryptCredential(envelope, mockEnvironment)).toBe("mock-credential");
  });

  it("fails explicit real selection without a usable deployment key by variable name only", () => {
    for (const candidate of [undefined, "too-short"]) {
      const selected = {
        SETTERFI_META_DRIVER: "real",
        SETTERFI_CREDENTIAL_ENCRYPTION_KEY: candidate,
      };
      expect(() => encryptCredential("credential-canary", selected, fixedIv)).toThrowError(
        DriverConfigurationError,
      );
      try {
        encryptCredential("credential-canary", selected, fixedIv);
      } catch (error) {
        expect(String(error)).toContain("SETTERFI_CREDENTIAL_ENCRYPTION_KEY");
        expect(String(error)).not.toContain("credential-canary");
        expect(String(error)).not.toContain("too-short");
      }
    }
  });

  it("rejects a wrong key and altered authenticated fields without value-bearing errors", () => {
    const envelope = encryptCredential("plaintext-canary", environment, fixedIv);
    const alter = (value: string) => `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
    const variants: CredentialEnvelopeV1[] = [
      envelope,
      { ...envelope, ciphertext: alter(envelope.ciphertext) },
      { ...envelope, tag: alter(envelope.tag) },
    ];
    const environments = [
      { SETTERFI_CREDENTIAL_ENCRYPTION_KEY: otherKey },
      environment,
      environment,
    ];

    variants.forEach((variant, index) => {
      try {
        decryptCredential(variant, environments[index]);
        throw new Error("EXPECTED_DECRYPTION_FAILURE");
      } catch (error) {
        expect(String(error)).toContain("CREDENTIAL_ENVELOPE_AUTHENTICATION_FAILED");
        expect(String(error)).not.toContain("plaintext-canary");
        expect(String(error)).not.toContain(key);
      }
    });
  });

  it("rejects unsupported envelope versions, key versions and algorithms explicitly", () => {
    const envelope = encryptCredential("credential-canary", environment, fixedIv);
    expect(() => decryptCredential({ ...envelope, version: 0 }, environment)).toThrow(
      "CREDENTIAL_ENVELOPE_VERSION_UNSUPPORTED",
    );
    expect(() => decryptCredential({ ...envelope, keyVersion: 2 }, environment)).toThrow(
      "CREDENTIAL_ENVELOPE_KEY_VERSION_UNSUPPORTED",
    );
    expect(() => decryptCredential({ ...envelope, algorithm: "legacy" }, environment)).toThrow(
      "CREDENTIAL_ENVELOPE_ALGORITHM_UNSUPPORTED",
    );
  });
});
