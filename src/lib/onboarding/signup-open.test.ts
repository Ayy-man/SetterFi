import { describe, expect, it } from "vitest";

import { signupOpen } from "./signup-open";

describe("signupOpen", () => {
  it("is closed while phase 5 is off, whatever the catalogue holds", async () => {
    await expect(signupOpen({
      enabled: () => false,
      catalog: async () => [{ label: "Growth" }],
    })).resolves.toBe(false);
  });

  it("is closed on an empty catalogue, a placeholder-only one, or one that cannot be read", async () => {
    await expect(signupOpen({ enabled: () => true, catalog: async () => [] })).resolves.toBe(false);
    await expect(signupOpen({
      enabled: () => true,
      catalog: async () => [{ label: "SETTERFI_DEMO_PLACEHOLDER_TIER" }, { label: "   " }],
    })).resolves.toBe(false);
    await expect(signupOpen({
      enabled: () => true,
      catalog: async () => { throw new Error("SIGNUP_TIER_CATALOG_READ_FAILED"); },
    })).resolves.toBe(false);
  });

  it("is open once one named plan exists", async () => {
    await expect(signupOpen({
      enabled: () => true,
      catalog: async () => [{ label: "SETTERFI_DEMO_PLACEHOLDER_TIER" }, { label: "Growth (demo)" }],
    })).resolves.toBe(true);
  });
});
