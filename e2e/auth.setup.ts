import path from "node:path";
import { mkdir } from "node:fs/promises";
import { test } from "@playwright/test";

import { demoLoginAccounts } from "../src/lib/auth/demo-logins";

const missingCredentialsMessage =
  "E2E credentials not set; run with .env.e2e, or set SETTERFI_DEMO_LOGINS and SETTERFI_DEMO_LOGIN_PASSWORD";

/**
 * The seeded review accounts, as a fallback for the three personas.
 *
 * A run against a deployed URL has no `.env.e2e` of its own and no reason to invent a second set of
 * credentials for accounts that already exist: these are the same four the sign-in page offers as
 * one-click shortcuts, read from `src/lib/auth/demo-logins.ts` so a rotated password or a renamed
 * account reaches the suite in one place. A purpose-made `E2E_*` credential still wins, because a
 * run that was given one meant it.
 */
const demo = new Map(demoLoginAccounts().map((account) => [account.role, account]));

const personas: ReadonlyArray<{
  role: "admin" | "coach" | "affiliate";
  home: string;
  email: string | undefined;
  password: string | undefined;
}> = [
  {
    role: "admin",
    home: "/admin",
    email: process.env.E2E_ADMIN_EMAIL ?? demo.get("admin")?.email,
    password: process.env.E2E_ADMIN_PASSWORD ?? demo.get("admin")?.password,
  },
  {
    role: "coach",
    home: "/coach/home",
    email: process.env.E2E_COACH_EMAIL ?? demo.get("coach")?.email,
    password: process.env.E2E_COACH_PASSWORD ?? demo.get("coach")?.password,
  },
  {
    role: "affiliate",
    home: "/affiliate",
    email: process.env.E2E_AFFILIATE_EMAIL ?? demo.get("affiliate")?.email,
    password: process.env.E2E_AFFILIATE_PASSWORD ?? demo.get("affiliate")?.password,
  },
];

for (const persona of personas) {
  test(`authenticate ${persona.role}`, async ({ page }) => {
    test.skip(!persona.email || !persona.password, missingCredentialsMessage);

    await page.goto("/login");
    await page.getByLabel(/email/i).fill(persona.email!);
    // By accessible name, not by label text. The field ships with a "Show password" reveal button
    // beside it, so a loose `getByLabel(/password/i)` resolves to two elements and fails strict
    // mode; and the label's own text carries the required marker, so an anchored label match finds
    // nothing at all.
    await page.getByRole("textbox", { name: "Password", exact: true }).fill(persona.password!);

    await Promise.all([
      // The admin alias "/admin" may keep its URL while rendering the overview.
      page.waitForURL(
        (url) => url.pathname === persona.home || url.pathname.startsWith(`${persona.home}/`),
      ),
      // Exact name: the login page also offers one-click demo buttons named "Sign in as ...".
      page.getByRole("button", { name: /^sign in$/i }).click(),
    ]);

    const storagePath = path.join("e2e", ".auth", `${persona.role}.json`);
    await mkdir(path.dirname(storagePath), { recursive: true });
    await page.context().storageState({ path: storagePath });
  });
}
