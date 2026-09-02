import { afterEach, describe, expect, it } from "vitest";

import { accessPassword, accessToken, isAuthorized, safeEqual } from "@/lib/access";

afterEach(() => {
  delete process.env.SETTERFI_ACCESS_PASSWORD;
});

describe("accessPassword", () => {
  it("reports no password when the env var is unset, so the demo stays open", () => {
    expect(accessPassword()).toBeNull();
  });

  it("treats a whitespace-only value as unset rather than as a password of spaces", () => {
    process.env.SETTERFI_ACCESS_PASSWORD = "   ";
    expect(accessPassword()).toBeNull();
  });

  it("returns the configured password", () => {
    process.env.SETTERFI_ACCESS_PASSWORD = "demo-pass";
    expect(accessPassword()).toBe("demo-pass");
  });
});

describe("accessToken", () => {
  it("is stable for the same password and different for another", async () => {
    expect(await accessToken("one")).toBe(await accessToken("one"));
    expect(await accessToken("one")).not.toBe(await accessToken("two"));
  });

  it("never contains the password itself, so a stolen cookie does not leak it", async () => {
    const token = await accessToken("hunter2");
    expect(token).not.toContain("hunter2");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("safeEqual", () => {
  it("matches identical strings and rejects different ones", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
  });

  it("rejects a length mismatch without indexing past the end", () => {
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "a")).toBe(false);
  });
});

describe("isAuthorized", () => {
  it("accepts the cookie derived from the configured password", async () => {
    expect(await isAuthorized(await accessToken("demo-pass"), "demo-pass")).toBe(true);
  });

  it("rejects an absent, empty, or forged cookie", async () => {
    expect(await isAuthorized(undefined, "demo-pass")).toBe(false);
    expect(await isAuthorized("", "demo-pass")).toBe(false);
    expect(await isAuthorized("deadbeef", "demo-pass")).toBe(false);
    // A cookie minted against a different password must not carry over.
    expect(await isAuthorized(await accessToken("other"), "demo-pass")).toBe(false);
  });
});
