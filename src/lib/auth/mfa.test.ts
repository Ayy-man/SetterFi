import { describe, expect, it } from "vitest";

import { decodeTotpSecret, generateTotpSecret, mfaCode, totpCode, verifyTotpCode } from "./mfa";

describe("TOTP", () => {
  it("matches the RFC 6238 SHA-1 test vectors", () => {
    const secret = Buffer.from("12345678901234567890", "ascii");
    expect(totpCode(secret, 59, 8)).toBe("94287082");
    expect(totpCode(secret, 1_111_111_109, 8)).toBe("07081804");
    expect(totpCode(secret, 1_111_111_111, 8)).toBe("14050471");
    expect(totpCode(secret, 1_234_567_890, 8)).toBe("89005924");
    expect(totpCode(secret, 2_000_000_000, 8)).toBe("69279037");
    expect(totpCode(secret, 20_000_000_000, 8)).toBe("65353130");
  });

  it("accepts exactly the RFC 6238 one-step skew window", () => {
    const secret = "JBSWY3DPEHPK3PXP";
    const now = new Date("2026-08-30T12:00:00.000Z");
    const currentCounter = Math.floor(now.getTime() / 30_000);
    expect(verifyTotpCode(secret, totpCode(decodeTotpSecret(secret)!, (currentCounter - 1) * 30), now)).toBe(currentCounter - 1);
    expect(verifyTotpCode(secret, totpCode(decodeTotpSecret(secret)!, (currentCounter + 1) * 30), now)).toBe(currentCounter + 1);
    expect(verifyTotpCode(secret, totpCode(decodeTotpSecret(secret)!, (currentCounter - 2) * 30), now)).toBeNull();
    expect(verifyTotpCode(secret, totpCode(decodeTotpSecret(secret)!, (currentCounter + 2) * 30), now)).toBeNull();
  });

  it("issues a decodable 160-bit secret and accepts only a six-digit code", () => {
    expect(decodeTotpSecret(generateTotpSecret())).toHaveLength(20);
    expect(mfaCode("123456")).toBe("123456");
    expect(mfaCode("12345")).toBeNull();
    expect(mfaCode("abcdef")).toBeNull();
  });
});
