import { describe, expect, it } from "vitest";

import { signupOpen } from "./signup-open";

const published = {
  state: "published" as const, versionKey: "v1", contentHash: "a".repeat(64),
  publishedAt: "2026-08-30T00:00:00Z", termsBody: "Terms", privacyBody: "Privacy",
};
const terms = { termsEnabled: () => true, currentTerms: async () => published };

describe("signupOpen", () => {
  it("is closed while phase 5 is off, whatever the catalogue holds", async () => {
    await expect(signupOpen({
      enabled: () => false,
      catalog: async () => [{ label: "Growth" }],
    })).resolves.toBe(false);
  });

  it("is closed on an empty catalogue, a placeholder-only one, or one that cannot be read", async () => {
    await expect(signupOpen({ ...terms, enabled: () => true, catalog: async () => [] })).resolves.toBe(false);
    await expect(signupOpen({
      ...terms,
      enabled: () => true,
      catalog: async () => [{ label: "SETTERFI_DEMO_PLACEHOLDER_TIER" }, { label: "   " }],
    })).resolves.toBe(false);
    await expect(signupOpen({
      ...terms,
      enabled: () => true,
      catalog: async () => { throw new Error("SIGNUP_TIER_CATALOG_READ_FAILED"); },
    })).resolves.toBe(false);
  });

  it("is open once a named plan and published terms exist", async () => {
    await expect(signupOpen({
      ...terms,
      enabled: () => true,
      catalog: async () => [{ label: "SETTERFI_DEMO_PLACEHOLDER_TIER" }, { label: "Growth (demo)" }],
    })).resolves.toBe(true);
  });

  it("withholds referral links when terms are unpublished, disabled, or unreadable", async () => {
    const catalog = async () => [{ label: "Growth" }];
    await expect(signupOpen({ ...terms, enabled: () => true, catalog,
      currentTerms: async () => ({ state: "none_published" }),
    })).resolves.toBe(false);
    await expect(signupOpen({ ...terms, enabled: () => true, catalog,
      termsEnabled: () => false,
    })).resolves.toBe(false);
    await expect(signupOpen({ ...terms, enabled: () => true, catalog,
      currentTerms: async () => { throw new Error("unavailable"); },
    })).resolves.toBe(false);
  });
});
