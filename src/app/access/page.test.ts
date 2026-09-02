import { describe, expect, it } from "vitest";

import { gateNote } from "@/app/access/page";

/**
 * The sentence on the gate has to follow the gate, and this watches the branch rather than the
 * words.
 *
 * It used to read "Per-user sign-in, roles, and tenant scoping arrive with the backend build" --
 * true the day it was written, false from the day `/login` shipped, and nothing in the product was
 * in a position to notice. It now reads `authMode()`, so the failure it can still have is a
 * *branch* that says the wrong thing, not a phrase that ages: a fourth mode returning the
 * supabase sentence, or a configuration error presented as a claim about the deployment.
 *
 * These pass synthetic environments to the real `authMode()` rather than stubbing it, so what is
 * being tested is the actual resolution and not a second copy of it.
 */
const SUPABASE = {
  SETTERFI_AUTH_MODE: "supabase",
  NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-anon-key",
} as const;

const SHARED = "A shared password for the review deployment, not a user account.";

describe("what the access gate says about the deployment behind it", () => {
  it("keeps the one sentence that is true in every mode", () => {
    for (const environment of [
      SUPABASE,
      { SETTERFI_AUTH_MODE: "password", SETTERFI_ACCESS_PASSWORD: "synthetic" },
      { SETTERFI_AUTH_MODE: "open", NODE_ENV: "development" },
      {},
    ]) {
      expect(gateNote(environment)).toContain(SHARED);
    }
  });

  it("promises per-user sign-in only where per-user sign-in exists", () => {
    expect(gateNote(SUPABASE)).toMatch(/sign in with your own account/i);
    expect(gateNote({ SETTERFI_AUTH_MODE: "password", SETTERFI_ACCESS_PASSWORD: "synthetic" }))
      .toMatch(/not switched on/i);
    expect(gateNote({ SETTERFI_AUTH_MODE: "open", NODE_ENV: "development" }))
      .toMatch(/not switched on/i);
  });

  /*
   * `authMode()` throws on an incomplete configuration -- `supabase` with no URL, `open` in
   * production, an unrecognised value. The page cannot say what the deployment enforces when the
   * deployment cannot say either, so it must fall back to the half it knows rather than guessing
   * in either direction. Guessing "enforced" is the dishonest one; guessing "not switched on" is
   * the one that would understate the product again, which is how this sentence broke the first
   * time.
   */
  it("claims nothing about enforcement when the configuration cannot be read", () => {
    for (const broken of [
      { SETTERFI_AUTH_MODE: "supabase" },
      { SETTERFI_AUTH_MODE: "open", NODE_ENV: "production" },
      { SETTERFI_AUTH_MODE: "not-a-mode" },
    ]) {
      const note = gateNote(broken);
      expect(note).toBe(SHARED);
      expect(note).not.toMatch(/not switched on|sign in with your own account/i);
    }
  });
});
