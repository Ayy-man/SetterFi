import { expect, test } from "@playwright/test";

import { demoLoginAccounts } from "../src/lib/auth/demo-logins";
import { workspaceForRole } from "../src/lib/auth/claims";

/**
 * The four one-click review accounts on /login, each pressed for real.
 *
 * /login threw a persistent error boundary and the sweep did not notice, because a route that
 * renders "This surface couldn't finish loading." still renders: `public.smoke.spec.ts` walks the
 * page but never presses anything on it, so every shortcut could have been dead for as long as the
 * boundary was up. These press the button and follow it to the workspace the role is entitled to,
 * which is the only assertion that fails when the account, the password, the claim hook, or the
 * redirect is wrong.
 *
 * The accounts come from `src/lib/auth/demo-logins.ts` rather than a list retyped here, so a
 * renamed or rotated account cannot leave this suite green against a button nobody can press. The
 * homes come from `workspaceForRole`, for the same reason.
 */
const accounts = demoLoginAccounts();

test("offers every demo shortcut the deployment is configured for", async ({ page }) => {
  // Loud rather than skipped. An empty list means the gate is off or the password is unset on the
  // target, and the four tests below would otherwise report success on nothing.
  expect(
    accounts.map((account) => account.role),
    "no demo accounts are configured; set SETTERFI_DEMO_LOGINS and SETTERFI_DEMO_LOGIN_PASSWORD for the target",
  ).toEqual(["owner", "admin", "coach", "affiliate"]);

  await page.goto("/login", { waitUntil: "networkidle" });
  for (const account of accounts) {
    await expect(
      page.getByRole("button", { name: account.label, exact: true }),
      `/login does not offer the ${account.role} shortcut`,
    ).toBeVisible();
  }
});

for (const account of accounts) {
  const home = workspaceForRole(account.role);

  test(`the ${account.role} shortcut lands on its role home`, async ({ page }) => {
    expect(home, `${account.role} has no workspace to land in`).not.toBeNull();

    await page.goto("/login", { waitUntil: "networkidle" });
    await Promise.all([
      // `/admin` keeps its own URL while rendering the overview, so the home is a prefix rather
      // than an equality: what is being asserted is the workspace, not the exact landing path.
      page.waitForURL((url) => url.pathname === `/${home}` || url.pathname.startsWith(`/${home}/`)),
      page.getByRole("button", { name: account.label, exact: true }).click(),
    ]);

    await expect(
      page.getByText(/couldn.t finish loading|something went wrong/i),
      `the ${account.role} shortcut landed on an error boundary`,
    ).toHaveCount(0);
  });
}
