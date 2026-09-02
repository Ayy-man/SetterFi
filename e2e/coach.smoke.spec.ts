import { expect, test } from "@playwright/test";
import { assertAll, assertNoBodyOverflow, assertNoPlatformEconomics } from "./assertions";
import { COACH_ROUTES } from "./routes";

// A disabled phase flag is a legitimate rendered state, not a missing route.
for (const route of COACH_ROUTES) {
  test(`${route} renders clean`, async ({ page }, testInfo) => {
    await page.goto(route, { waitUntil: "networkidle" });
    await assertAll(page, route);
    await assertNoPlatformEconomics(page, route);

    if (route === "/coach/conversations" && testInfo.project.use.viewport?.width === 390) {
      const firstThread = page.getByRole("button", { name: /open conversation with/i }).first();
      await expect(
        firstThread,
        `${route} must render a selectable thread at 390px`,
      ).toBeVisible();
      await firstThread.click();
      await expect(page.getByRole("region", { name: /conversation detail/i })).toBeVisible();
      await assertNoBodyOverflow(page, `${route} with a thread selected`);
    }
  });
}
