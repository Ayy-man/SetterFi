import { describe, expect, it } from "vitest";

import { AuthConfigurationError, authMode } from "./mode";

describe("authMode", () => {
  it("selects Supabase only when both public client values are present", () => {
    expect(authMode({
      SETTERFI_AUTH_MODE: "supabase",
      NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
      NODE_ENV: "production",
    })).toBe("supabase");
    expect(() => authMode({ SETTERFI_AUTH_MODE: "supabase", NODE_ENV: "production" }))
      .toThrow(AuthConfigurationError);
  });

  it("requires both an explicit password mode and a nonblank password", () => {
    expect(authMode({ SETTERFI_AUTH_MODE: "password", SETTERFI_ACCESS_PASSWORD: "secret" }))
      .toBe("password");
    expect(() => authMode({ SETTERFI_ACCESS_PASSWORD: "secret" })).toThrow(AuthConfigurationError);
    expect(() => authMode({ SETTERFI_AUTH_MODE: "password" })).toThrow(AuthConfigurationError);
  });

  it("allows explicit open mode only outside production", () => {
    expect(authMode({ SETTERFI_AUTH_MODE: "open", NODE_ENV: "development" })).toBe("open");
    expect(authMode({
      SETTERFI_AUTH_MODE: "open",
      NODE_ENV: "production",
      VERCEL_ENV: "preview",
    })).toBe("open");
    expect(() => authMode({ SETTERFI_AUTH_MODE: "open", NODE_ENV: "production" }))
      .toThrow(AuthConfigurationError);
    expect(() => authMode({ SETTERFI_AUTH_MODE: "open", VERCEL_ENV: "production" }))
      .toThrow(AuthConfigurationError);
  });

  it("rejects missing and unknown modes in every environment", () => {
    expect(() => authMode({ NODE_ENV: "development" })).toThrow(AuthConfigurationError);
    expect(() => authMode({ SETTERFI_AUTH_MODE: "magic", NODE_ENV: "development" }))
      .toThrow(AuthConfigurationError);
  });
});
