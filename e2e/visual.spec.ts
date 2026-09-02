import { expect, test } from "@playwright/test";
import {
  ADMIN_ROUTES,
  AFFILIATE_ROUTES,
  COACH_ROUTES,
  PUBLIC_ROUTES,
} from "./routes";

const ROUTES_BY_ROLE = {
  admin: ADMIN_ROUTES,
  affiliate: AFFILIATE_ROUTES,
  coach: COACH_ROUTES,
  public: PUBLIC_ROUTES,
} as const;

const THEMES = ["light", "dark"] as const;

const VISUAL_PROJECTS_BY_ROLE: Record<keyof typeof ROUTES_BY_ROLE, string> = {
  admin: "admin-visual-1440",
  affiliate: "affiliate-visual-1440",
  coach: "coach-visual-1440",
  public: "public-visual-1440",
};

// Regions whose content is written by the test traffic itself (the smoke assertions exercise
// audit-logged export endpoints), so they can never be pixel-stable and are masked per route.
const VOLATILE_REGIONS: Record<string, ReadonlyArray<string>> = {
  // The audit footer is masked by slot, not by copy: it spells its own count ("202 events, showing
  // 1 to 50") rather than the kit's "Showing 1-50 of 202", so the text matcher below never covered
  // it, and a reworded footer would silently unmask it again.
  "/admin/audit": [
    'section[aria-labelledby^="audit-day-"]',
    '[data-slot="audit-pagination"]',
    "text=/Showing \\d+.\\d+ of/",
  ],
};

function routeSlug(route: string): string {
  return route === "/"
    ? "home"
    : route.slice(1).replace(/[^a-z0-9]+/gi, "-").toLocaleLowerCase();
}

for (const [role, routes] of Object.entries(ROUTES_BY_ROLE)) {
  for (const route of routes) {
    for (const theme of THEMES) {
      test(`${role} visual ${route} ${theme}`, async ({ page }, testInfo) => {
        test.skip(
          testInfo.project.name !== VISUAL_PROJECTS_BY_ROLE[role as keyof typeof ROUTES_BY_ROLE],
          "Visual baselines run in the matching 1440 role project.",
        );

        await page.emulateMedia({ colorScheme: theme });
        await page.goto(route, { waitUntil: "networkidle" });
        await page.evaluate((selectedTheme) => {
          document.documentElement.dataset.theme = selectedTheme;
          document.documentElement.dataset.workspaceTheme = selectedTheme;
        }, theme);
        await page.evaluate(async () => {
          await document.fonts.ready;
        });

        await expect(page).toHaveScreenshot(`${routeSlug(route)}-${theme}.png`, {
          animations: "disabled",
          fullPage: true,
          mask: [
            page.locator("[data-volatile]"),
            ...(VOLATILE_REGIONS[route] ?? []).map((selector) => page.locator(selector)),
          ],
        });
      });
    }
  }
}
