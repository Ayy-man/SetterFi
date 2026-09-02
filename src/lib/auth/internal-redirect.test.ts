import { describe, expect, it } from "vitest";

import { internalRedirectPath } from "./internal-redirect";

describe("internalRedirectPath", () => {
  it.each([
    "/admin/provisioning",
    "/coach/home?window=30d#summary",
    "/contacts/%E2%9C%93",
  ])("keeps the internal destination %s", (value) => {
    expect(internalRedirectPath(value, null)).toBe(value);
  });

  it.each([
    undefined,
    null,
    "",
    "admin/provisioning",
    "https://evil.example/path",
    "//evil.example/path",
    "/\\evil.example/path",
    "/%5cevil.example/path",
    "/%5Cevil.example/path",
    "/%255cevil.example/path",
    "/%2525255cevil.example/path",
    "/mixed%5c\\path",
    "/line%0abreak",
    "/line%250dbreak",
    "/line\u2028break",
    "/malformed%escape",
  ])("replaces the unsafe destination %s", (value) => {
    expect(internalRedirectPath(value, "/onboarding")).toBe("/onboarding");
  });
});
