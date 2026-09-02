import { test } from "@playwright/test";
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
