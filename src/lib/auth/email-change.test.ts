import { describe, expect, it } from "vitest";

import {
  accountEmailChangeCompletion,
  accountEmailChangeLink,
  accountEmailChangeRequest,
  hashAccountEmailChangeToken,
  issueAccountEmailChangeToken,
  normalizeAccountEmail,
} from "./email-change";

describe("account email change helpers", () => {
  it("normalizes a bounded address and refuses malformed request bodies", () => {
    expect(normalizeAccountEmail(" Coach@Example.Test ")).toBe("coach@example.test");
    expect(normalizeAccountEmail("not-an-address")).toBeNull();
    expect(accountEmailChangeRequest({ currentPassword: "current-password", newEmail: "coach@example.test", mfaCode: "123456" }))
      .toEqual({ currentPassword: "current-password", newEmail: "coach@example.test", mfaCode: "123456" });
    expect(accountEmailChangeRequest({ currentPassword: "current-password", newEmail: "coach@example.test", mfaCode: "not-a-code" })).toBeNull();
  });

  it("issues opaque capabilities and persists only their stable hashes", () => {
    const token = issueAccountEmailChangeToken();
    expect(hashAccountEmailChangeToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashAccountEmailChangeToken("wrong")).toBeNull();
    expect(accountEmailChangeCompletion({ action: "confirm", token })).toEqual({ action: "confirm", tokenHash: hashAccountEmailChangeToken(token) });
  });

  it("builds fixed internal confirmation endpoints rather than accepting a redirect target", () => {
    const link = accountEmailChangeLink("https://setterfi.test", "refuse", "a".repeat(43));
    expect(link).toBe("https://setterfi.test/api/account/security/email/confirm?action=refuse&token=" + "a".repeat(43));
  });
});
