import { describe, expect, it } from "vitest";

import {
  SupabaseProjectRefMismatchError,
  assertSupabaseProjectAgreement,
  supabaseKeyProjectRef,
  supabaseProjectRefMismatches,
  supabaseUrlProjectRef,
} from "./env-contract";

/**
 * Every key here is a synthetic JWT built in-test. Nothing in this file is real key material, and
 * nothing that reaches an assertion may contain any: the signature segment is deliberately a
 * recognisable marker so a leak into a message would be visible.
 */
const SIGNATURE_MARKER = "not-a-real-signature-and-must-never-be-printed";

function base64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function supabaseKey(payload: Record<string, unknown>) {
  return [
    base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
    base64Url(JSON.stringify(payload)),
    SIGNATURE_MARKER,
  ].join(".");
}

const PROJECT = "synthprojectrefaaaaa";
const OTHER_PROJECT = "synthprojectrefbbbbb";
const URL_FOR_PROJECT = `https://${PROJECT}.supabase.co`;

function anonKeyFor(ref: string) {
  return supabaseKey({ iss: "supabase", ref, role: "anon", iat: 1, exp: 2 });
}

function serviceKeyFor(ref: string) {
  return supabaseKey({ iss: "supabase", ref, role: "service_role", iat: 1, exp: 2 });
}

describe("supabase project agreement", () => {
  it("reads the project ref out of a URL and a JWT key", () => {
    expect(supabaseUrlProjectRef(URL_FOR_PROJECT)).toBe(PROJECT);
    expect(supabaseUrlProjectRef(`${URL_FOR_PROJECT}/`)).toBe(PROJECT);
    expect(supabaseKeyProjectRef(anonKeyFor(PROJECT))).toBe(PROJECT);
    expect(supabaseKeyProjectRef(serviceKeyFor(OTHER_PROJECT))).toBe(OTHER_PROJECT);
  });

  it("passes when every key names the project the URL names", () => {
    const environment = {
      NEXT_PUBLIC_SUPABASE_URL: URL_FOR_PROJECT,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKeyFor(PROJECT),
      SUPABASE_SERVICE_ROLE_KEY: serviceKeyFor(PROJECT),
    };
    expect(supabaseProjectRefMismatches(environment)).toEqual([]);
    expect(() => assertSupabaseProjectAgreement(environment)).not.toThrow();
  });

  it("fails on the real incident: a shell-exported key for another project", () => {
    const environment = {
      NEXT_PUBLIC_SUPABASE_URL: URL_FOR_PROJECT,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKeyFor(PROJECT),
      // What a `export SUPABASE_SERVICE_ROLE_KEY=…` line in a shell profile does to any dev server
      // started from that shell: the real environment variable wins over .env.local.
      SUPABASE_SERVICE_ROLE_KEY: serviceKeyFor(OTHER_PROJECT),
    };

    expect(supabaseProjectRefMismatches(environment)).toEqual([
      {
        variableName: "SUPABASE_SERVICE_ROLE_KEY",
        keyProjectRef: OTHER_PROJECT,
        urlProjectRef: PROJECT,
      },
    ]);
    expect(() => assertSupabaseProjectAgreement(environment))
      .toThrow(SupabaseProjectRefMismatchError);
  });

  it("names the variable, both refs, and the shell as the likely source", () => {
    let message = "";
    try {
      assertSupabaseProjectAgreement({
        NEXT_PUBLIC_SUPABASE_URL: URL_FOR_PROJECT,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKeyFor(OTHER_PROJECT),
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    expect(message).toContain(OTHER_PROJECT);
    expect(message).toContain(PROJECT);
    expect(message).toContain("NEXT_PUBLIC_SUPABASE_URL");
    expect(message).toMatch(/shell/i);
    expect(message).toContain(".env.local");
  });

  it("never carries key material into the message", () => {
    const anonKey = anonKeyFor(OTHER_PROJECT);
    const serviceKey = serviceKeyFor(OTHER_PROJECT);
    let message = "";
    try {
      assertSupabaseProjectAgreement({
        NEXT_PUBLIC_SUPABASE_URL: URL_FOR_PROJECT,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
        SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
    expect(message).toContain("SUPABASE_SERVICE_ROLE_KEY");
    for (const key of [anonKey, serviceKey]) {
      expect(message).not.toContain(key);
      // Neither whole keys nor any segment of one: header, payload and signature all stay out.
      for (const segment of key.split(".")) expect(message).not.toContain(segment);
    }
    expect(message).not.toContain(SIGNATURE_MARKER);
  });

  it("skips the new-style publishable and secret keys instead of erroring on them", () => {
    expect(supabaseKeyProjectRef("sb_publishable_abcdefghijklmnopqrstuv")).toBeNull();
    expect(supabaseKeyProjectRef("sb_secret_abcdefghijklmnopqrstuv")).toBeNull();
    expect(supabaseProjectRefMismatches({
      NEXT_PUBLIC_SUPABASE_URL: URL_FOR_PROJECT,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_abcdefghijklmnopqrstuv",
      SUPABASE_SERVICE_ROLE_KEY: "sb_secret_abcdefghijklmnopqrstuv",
    })).toEqual([]);
  });

  it("treats a missing, blank or unreadable value as no finding rather than a mismatch", () => {
    expect(supabaseKeyProjectRef(undefined)).toBeNull();
    expect(supabaseKeyProjectRef("")).toBeNull();
    expect(supabaseKeyProjectRef("not.a.jwt")).toBeNull();
    expect(supabaseKeyProjectRef(supabaseKey({ iss: "supabase", role: "anon" }))).toBeNull();
    expect(supabaseUrlProjectRef(undefined)).toBeNull();
    expect(supabaseUrlProjectRef("http://localhost:54321")).toBeNull();

    // No URL to compare against, a missing key, and a key that carries no ref: none is a mismatch.
    expect(supabaseProjectRefMismatches({})).toEqual([]);
    expect(supabaseProjectRefMismatches({
      NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKeyFor(OTHER_PROJECT),
    })).toEqual([]);
    expect(supabaseProjectRefMismatches({
      NEXT_PUBLIC_SUPABASE_URL: URL_FOR_PROJECT,
      SUPABASE_SERVICE_ROLE_KEY: "   ",
    })).toEqual([]);
    expect(supabaseProjectRefMismatches({
      NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
      SUPABASE_SERVICE_ROLE_KEY: serviceKeyFor(OTHER_PROJECT),
    })).toEqual([]);
  });

  it("reports every disagreeing variable, not only the first", () => {
    const mismatches = supabaseProjectRefMismatches({
      NEXT_PUBLIC_SUPABASE_URL: URL_FOR_PROJECT,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKeyFor(OTHER_PROJECT),
      SUPABASE_SERVICE_ROLE_KEY: serviceKeyFor(OTHER_PROJECT),
    });
    expect(mismatches.map((mismatch) => mismatch.variableName))
      .toEqual(["NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]);
  });
});
