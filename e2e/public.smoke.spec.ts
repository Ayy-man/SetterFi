import { expect, test } from "@playwright/test";
import { assertAll } from "./assertions";
import { PUBLIC_ROUTES } from "./routes";

for (const route of PUBLIC_ROUTES) {
  test(`${route} renders clean`, async ({ page }) => {
    await page.goto(route, { waitUntil: "networkidle" });
    await assertAll(page, route);
  });
}

/**
 * The front door, asserted on what it is for rather than only on what it must not contain.
 *
 * /login served a persistent error boundary (React #441, digest 3222388206) while the sweep above
 * passed it, because that sweep reads the page for violations and an error boundary is a clean
 * render of an apology. The route can only regress silently while nothing asserts that the thing
 * people come here to use is on the screen, so this names the form, its two fields and its submit,
 * and then names the boundary text separately so a failure says which of the two happened.
 */
test("/login renders the sign-in form rather than an error boundary", async ({ page }) => {
  await page.goto("/login", { waitUntil: "networkidle" });

  await expect(
    page.getByText(/couldn.t finish loading|something went wrong|application error/i),
    "/login rendered an error boundary",
  ).toHaveCount(0);

  await expect(page.getByLabel(/email/i)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Password", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^sign in$/i })).toBeVisible();
});
