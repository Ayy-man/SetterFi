import path from "node:path";
import { mkdir } from "node:fs/promises";
import { test } from "@playwright/test";

const missingCredentialsMessage = "E2E credentials not set; run with .env.e2e";

const personas: ReadonlyArray<{
  role: "admin" | "coach" | "affiliate";
  home: string;
  email: string | undefined;
  password: string | undefined;
}> = [
  {
    role: "admin",
    home: "/admin",
    email: process.env.E2E_ADMIN_EMAIL,
    password: process.env.E2E_ADMIN_PASSWORD,
  },
  {
    role: "coach",
    home: "/coach/home",
    email: process.env.E2E_COACH_EMAIL,
    password: process.env.E2E_COACH_PASSWORD,
  },
  {
    role: "affiliate",
    home: "/affiliate",
    email: process.env.E2E_AFFILIATE_EMAIL,
    password: process.env.E2E_AFFILIATE_PASSWORD,
  },
];

for (const persona of personas) {
  test(`authenticate ${persona.role}`, async ({ page }) => {
    test.skip(!persona.email || !persona.password, missingCredentialsMessage);

    await page.goto("/login");
    await page.getByLabel(/email/i).fill(persona.email!);
    await page.getByLabel(/password/i).fill(persona.password!);

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
