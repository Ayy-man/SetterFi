import { expect, test } from "@playwright/test";
import { assertAll, assertNoPlatformEconomics } from "./assertions";
import { AFFILIATE_ROUTES } from "./routes";

// A disabled phase flag is a legitimate rendered state, not a missing route.
for (const route of AFFILIATE_ROUTES) {
  test(`${route} renders clean`, async ({ page }) => {
    await page.goto(route, { waitUntil: "networkidle" });
    await assertAll(page, route);
    await assertNoPlatformEconomics(page, route);
  });
}

/**
 * The one thing an affiliate opens the portal for.
 *
 * The sweep above passes on a page that renders "Partner earnings could not load", because a
 * failure card is a well-formed render with no overflow, no machine copy and no em dash in it. So
 * the table is named directly: `/affiliate` is only working when the referrals it exists to show
 * are on the screen. Its empty state is a legitimate pass, and reads "No referred coaches are
 * recorded." inside the same table, which is why this asserts the table and not a row count.
 */
test("/affiliate shows the referrals table rather than a load failure", async ({ page }) => {
  await page.goto("/affiliate", { waitUntil: "networkidle" });

  await expect(
    page.getByText(/could not load/i),
    "/affiliate reported that it could not load its data",
  ).toHaveCount(0);
  // The accessible name sits on the region the table is announced through, not on the `<table>`
  // itself, so the table is reached through it rather than named directly.
  const referrals = page.getByRole("region", { name: "Referred coaches" });
  await expect(referrals.getByRole("table")).toBeVisible();
  await expect(referrals.getByRole("columnheader", { name: /referred coach/i })).toBeVisible();
});
