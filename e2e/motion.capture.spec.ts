import path from "node:path";
import { test, type Page } from "@playwright/test";

/**
 * Not an assertion suite -- a camera. It drives the gestures the motion pass reworked and samples
 * frames while they are mid-flight, so the result can be looked at rather than reasoned about.
 *
 * Playback is slowed through CDP first. `--ease-smooth-out` is heavily front-loaded, so a 250ms
 * collapse is about 90% done by 80ms; sampling it at real speed gives you the start and the end
 * and nothing in between. The frames below are genuine interpolated states, just stretched over a
 * wall clock a screenshot can actually hit -- the timings in the file names are the real,
 * undilated positions in the animation.
 *
 * Run with: npx playwright test --config=playwright.motion.config.ts e2e/motion.capture.spec.ts
 */

const SHOTS = path.join(".planning", "quick", "260829-n1s-admin-redesign", "shots");
const RATE = 0.1;

function shot(name: string) {
  return path.join(SHOTS, `motion-${name}.png`);
}

async function slowMotion(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Animation.enable");
  await cdp.send("Animation.setPlaybackRate", { playbackRate: RATE });
}

/** Sample a gesture at points across its *real* duration, waiting the dilated equivalent. */
async function frames(page: Page, name: string, atMs: readonly number[]) {
  let elapsed = 0;
  for (const at of atMs) {
    await page.waitForTimeout((at - elapsed) / RATE);
    elapsed = at;
    await page.screenshot({ path: shot(`${name}-${String(at).padStart(4, "0")}ms`) });
  }
}

test.describe("admin visual motion", () => {
  test("record sheet open and close", async ({ page }) => {
    await page.goto("/admin/platform-clients");
    await page.waitForLoadState("networkidle");
    await slowMotion(page);

    const row = page.locator("tbody tr").first();
    if ((await row.count()) === 0) test.skip(true, "no rows to open a sheet from");

    await page.screenshot({ path: shot("sheet-0-before") });
    await row.click();
    await frames(page, "sheet-open", [40, 100, 200, 400]);

    await page.keyboard.press("Escape");
    await frames(page, "sheet-close", [40, 100, 200, 350]);
  });

  test("tab indicator travel", async ({ page }) => {
    await page.goto("/admin/platform-clients");
    await page.waitForLoadState("networkidle");

    const row = page.locator("tbody tr").first();
    if ((await row.count()) === 0) test.skip(true, "no rows to open a sheet from");
    await row.click();
    await page.waitForTimeout(600);
    await slowMotion(page);

    const tabs = page.getByRole("tab");
    if ((await tabs.count()) < 2) test.skip(true, "sheet has a single view, nothing to slide");

    await page.screenshot({ path: shot("tabs-0-before") });
    await tabs.nth(1).click();
    await frames(page, "tabs", [40, 100, 170, 250]);
  });

  test("sidebar collapse and expand", async ({ page }) => {
    await page.goto("/admin");
    await page.waitForLoadState("networkidle");
    await slowMotion(page);

    const trigger = page.getByRole("button", { name: /toggle sidebar/i }).first();
    if ((await trigger.count()) === 0) test.skip(true, "no sidebar trigger on this shell");

    await page.screenshot({ path: shot("sidebar-0-expanded") });
    await trigger.click();
    await frames(page, "sidebar-collapse", [30, 80, 150, 250]);

    await trigger.click();
    await frames(page, "sidebar-expand", [30, 80, 150, 250]);
  });

  test("theme swap reveal", async ({ page }) => {
    await page.goto("/admin");
    await page.waitForLoadState("networkidle");

    // The theme choice moved into the user menu, which is the account control in the header.
    // Not simply the last button in the header -- a page's own Export control lands there too.
    const user = page.getByRole("button", { name: /account/i }).first();
    if ((await user.count()) === 0) test.skip(true, "no user menu in the header");
    await user.click();
    await page.waitForTimeout(400);

    const dark = page.getByRole("menuitemradio", { name: /^dark$/i });
    if ((await dark.count()) === 0) test.skip(true, "no theme choice in the user menu");

    await page.screenshot({ path: shot("theme-0-before") });
    await slowMotion(page);
    await dark.click();
    await frames(page, "theme", [60, 150, 260, 400]);
  });
});
