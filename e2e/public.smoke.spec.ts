import { test } from "@playwright/test";
import { assertAll } from "./assertions";
import { PUBLIC_ROUTES } from "./routes";

for (const route of PUBLIC_ROUTES) {
  test(`${route} renders clean`, async ({ page }) => {
    await page.goto(route, { waitUntil: "networkidle" });
    await assertAll(page, route);
  });
}
