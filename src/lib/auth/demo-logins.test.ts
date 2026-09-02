import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { workspaceForRole } from "./claims";
import { demoLoginAccounts, demoLoginPassword } from "./demo-logins";
import { internalRedirectPath } from "./internal-redirect";
import { demoReviewPersonas } from "../workspace-navigation";

const SEEDER_PATH = "scripts/seed-staging-users.mjs";
const seederSource = readFileSync(resolve(process.cwd(), SEEDER_PATH), "utf8");

const LOGIN_PAGE_PATH = "src/app/login/page.tsx";
const loginPageSource = readFileSync(resolve(process.cwd(), LOGIN_PAGE_PATH), "utf8");

const DEMO_LOGINS_PATH = "src/lib/auth/demo-logins.ts";
const demoLoginsSource = readFileSync(resolve(process.cwd(), DEMO_LOGINS_PATH), "utf8");
const testDemoPassword = "<test-demo-password>";
const enabledDemoEnvironment = {
  SETTERFI_DEMO_LOGINS: "true",
  SETTERFI_DEMO_LOGIN_PASSWORD: testDemoPassword,
};
const enabledProductionDemoEnvironment = {
  ...enabledDemoEnvironment,
  NODE_ENV: "production",
  SETTERFI_PRODUCTION_DEMO_LOGINS: "true",
  SETTERFI_ACCESS_PASSWORD: "<test-access-password>",
};

function enabledDemoAccounts() {
  return demoLoginAccounts(enabledDemoEnvironment);
}

function occurrences(haystack: string, needle: string) {
  return haystack.split(needle).length - 1;
}

describe("demo logins", () => {
  // The absent case is the one that protects real coaches: an unset flag has to mean
  // there is nothing to render at all, not an empty shell that still says demo.
  it("offers nothing when SETTERFI_DEMO_LOGINS is absent", () => {
    expect(demoLoginAccounts({})).toEqual([]);
  });

  it("fails closed when the password is absent or empty, even with the gate enabled", () => {
    expect(demoLoginPassword({})).toBeNull();
    expect(demoLoginPassword({ SETTERFI_DEMO_LOGIN_PASSWORD: "" })).toBeNull();
    expect(demoLoginPassword({ SETTERFI_DEMO_LOGIN_PASSWORD: "   " })).toBeNull();
    expect(demoLoginAccounts({ SETTERFI_DEMO_LOGINS: "true" })).toEqual([]);
    expect(demoLoginAccounts({
      SETTERFI_DEMO_LOGINS: "true",
      SETTERFI_DEMO_LOGIN_PASSWORD: "",
    })).toEqual([]);
    expect(demoLoginAccounts({
      SETTERFI_DEMO_LOGINS: "true",
      SETTERFI_DEMO_LOGIN_PASSWORD: "   ",
    })).toEqual([]);
  });

  it.each(["TRUE", "True", "1", "yes", "on", ""])(
    "offers nothing when SETTERFI_DEMO_LOGINS is %o rather than the literal true",
    (value) => {
      expect(demoLoginAccounts({ SETTERFI_DEMO_LOGINS: value })).toEqual([]);
    },
  );

  it("offers the four seeded roles, in button order, when the flag is exactly true", () => {
    const accounts = enabledDemoAccounts();
    expect(accounts.map((account) => account.role)).toEqual([
      "owner",
      "admin",
      "coach",
      "affiliate",
    ]);
    expect(accounts.every((account) => account.password === testDemoPassword)).toBe(true);
  });

  it("keeps production credentials hidden unless the complete review override is configured", () => {
    expect(demoLoginAccounts({ ...enabledDemoEnvironment, NODE_ENV: "production" })).toEqual([]);
    expect(demoLoginAccounts({ ...enabledDemoEnvironment, VERCEL_ENV: "production" })).toEqual([]);
    expect(demoLoginAccounts({
      ...enabledProductionDemoEnvironment,
      SETTERFI_ACCESS_PASSWORD: "",
    })).toEqual([]);
    expect(demoLoginAccounts({
      ...enabledProductionDemoEnvironment,
      SETTERFI_PRODUCTION_DEMO_LOGINS: "false",
    })).toEqual([]);
    expect(demoLoginAccounts(enabledProductionDemoEnvironment)).toEqual(enabledDemoAccounts());
    expect(demoLoginAccounts({
      ...enabledDemoEnvironment,
      NODE_ENV: "production",
      VERCEL_ENV: "preview",
    })).toEqual(enabledDemoAccounts());
  });

  it("gives every account the one shared password and a project email", () => {
    for (const account of enabledDemoAccounts()) {
      expect(account.password).toBe(testDemoPassword);
      expect(account.email.endsWith("@livelegacystrong.com")).toBe(true);
      expect(account.label.trim().length).toBeGreaterThan(0);
    }
  });

  // A button that signs in and then lands nowhere is the failure this catches — every
  // offered role has to resolve to a workspace the redirect can actually send it to.
  it("routes every offered role to a workspace", () => {
    for (const account of enabledDemoAccounts()) {
      expect(workspaceForRole(account.role)).not.toBeNull();
    }
  });

  it("keeps the workspace review picker aligned with every seeded account", () => {
    expect(demoReviewPersonas.map((persona) => persona.id)).toEqual(
      enabledDemoAccounts().map((account) => account.role),
    );
    for (const persona of demoReviewPersonas) {
      expect(workspaceForRole(persona.id)).not.toBeNull();
    }
  });
});

// The offered list and the seeded list are two copies of the same four accounts in two
// files, so they can drift silently — these read the seeder's source text to stop a
// button coming to offer credentials nobody ever created.
describe("demo logins match the seeder", () => {
  it("offers only accounts the seeder creates", () => {
    for (const account of enabledDemoAccounts()) {
      expect(seederSource).toContain(account.email);
      expect(seederSource).toContain(`role: "${account.role}"`);
    }
  });

  it("describes in its header what it now does", () => {
    const header = seederSource.split("\n")
      .slice(0, seederSource.split("\n").findIndex((line) => !line.startsWith("//")))
      .join("\n");
    expect(header).not.toMatch(/\bthree\b/i);
    expect(header).toMatch(/\bfour\b/i);
  });

  it("requires the environment password before it can contact Supabase", () => {
    const passwordRead = seederSource.indexOf("const password = env.SETTERFI_DEMO_LOGIN_PASSWORD;");
    const supabaseClient = seederSource.indexOf("const supabase = createClient(");

    expect(passwordRead).toBeGreaterThan(-1);
    expect(supabaseClient).toBeGreaterThan(passwordRead);
    expect(seederSource.slice(passwordRead, supabaseClient)).toMatch(
      /typeof password !== "string" \|\| password\.trim\(\)\.length === 0/,
    );
    expect(seederSource).not.toMatch(/const\s+PASSWORD\s*=/);
  });

  it("prints account identities without serializing the password", () => {
    expect(seederSource).toContain("Password supplied from SETTERFI_DEMO_LOGIN_PASSWORD in the environment.");
    expect(seederSource).not.toContain("=== CREDENTIALS ===");
  });
});

// The login page is .tsx, which vitest does not collect and could not render in a node
// environment anyway, so its wiring is proven from its source text — the same shape
// src/components/workspace/live/fixture-retirement.test.ts uses.
describe("the login page's use of the gate", () => {
  it("consults the gate rather than merely defining it", () => {
    expect(loginPageSource).toContain("demoLoginAccounts(");
  });

  it("keeps every credential in the one module", () => {
    expect(loginPageSource).not.toContain(testDemoPassword);
    for (const account of enabledDemoAccounts()) {
      expect(loginPageSource).not.toContain(account.email);
    }
    expect(loginPageSource).not.toMatch(/support\+[a-z]+@livelegacystrong\.com/);
  });

  it("reads the password from the environment instead of source", () => {
    expect(demoLoginsSource).toContain("SETTERFI_DEMO_LOGIN_PASSWORD");
    expect(demoLoginsSource).not.toContain(testDemoPassword);
  });

  // The whole point of the buttons is that they exercise the production sign-in path.
  // A second action, or an API route, would let them pass while the real login fails.
  it("keeps one server-side auth path and no client component", () => {
    expect(occurrences(loginPageSource, "signInWithPassword")).toBe(1);
    expect(occurrences(loginPageSource, '"use server"')).toBe(1);
    expect(loginPageSource).not.toContain('"use client"');
  });
});

/**
 * A field report on 2026-08-20 read a sign-in that landed on /admin/overview as the login flow
 * ignoring ?next=. It was not - /admin/overview is where the fall-through goes when `next` is
 * absent, so the two outcomes look identical from the outside and only the code tells them apart.
 * These pin the behaviour so the next person to ask gets an answer from a command.
 */
describe("the login page returns a visitor to where they were sent", () => {
  it("renders the requested path as a hidden field on the password form and every demo form", () => {
    // Two in the source - one on the email/password form, one inside the demo-account map that
    // emits a form per account - which is 1 + the four configured accounts rendered fields when the
    // gate is on. Measured on the live deployment 2026-08-20: five hidden fields in the HTML.
    expect(occurrences(loginPageSource, '<input name="next" type="hidden"')).toBe(2);
    // Rendered through the validator, not straight from the query string, on both.
    expect(occurrences(loginPageSource, 'internalRedirectPath(next, null) ? <input name="next"')).toBe(2);
    expect(loginPageSource).toMatch(/demoAccounts\.map\(\(account\) => \(/);
  });

  it("honours that path before it falls through to the role's home", () => {
    const honoursNext = loginPageSource.indexOf("if (next) redirect(next);");
    const roleFallthrough = loginPageSource.indexOf("workspaceForRole(claims?.role ?? null)");
    expect(honoursNext).toBeGreaterThan(-1);
    expect(roleFallthrough).toBeGreaterThan(-1);
    // Order is the behaviour: reversed, an explicit destination would lose to the role's home.
    expect(honoursNext).toBeLessThan(roleFallthrough);
  });

  it("keeps the requested path across a failed attempt", () => {
    expect(loginPageSource).toMatch(/error=1\$\{next \? `&next=\$\{encodeURIComponent\(next\)\}`/);
  });

  it("accepts only a same-origin relative path, so it cannot become an open redirect", () => {
    expect(internalRedirectPath("/admin/provisioning", null)).toBe("/admin/provisioning");
    expect(internalRedirectPath("//evil.example.com/admin", null)).toBeNull();
    expect(internalRedirectPath("/%5cevil.example.com/admin", null)).toBeNull();
    expect(internalRedirectPath("https://evil.example.com", null)).toBeNull();
    expect(internalRedirectPath("admin/provisioning", null)).toBeNull();
    expect(internalRedirectPath(undefined, null)).toBeNull();
    expect(loginPageSource).toContain("internalRedirectPath(");
  });
});
