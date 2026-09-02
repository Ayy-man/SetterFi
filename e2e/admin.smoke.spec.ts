import { test } from "@playwright/test";
import { assertAll } from "./assertions";
import { ADMIN_ROUTES } from "./routes";

// A disabled phase flag is a legitimate rendered state, not a missing route.
for (const route of ADMIN_ROUTES) {
  test(`${route} renders clean`, async ({ page }) => {
    await page.goto(route, { waitUntil: "networkidle" });
    await assertAll(page, route);
  });
}
