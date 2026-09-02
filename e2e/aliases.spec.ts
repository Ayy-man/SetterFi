import { expect, test, type Response } from "@playwright/test";
import { ALIAS_ROUTES } from "./routes";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Each alias is followed with the session of the workspace it belongs to; a foreign
// role would be bounced to its own home and hide the alias behaviour under test.
function roleFor(route: string): "admin" | "coach" | "affiliate" {
  if (route.startsWith("/coach")) return "coach";
  if (route.startsWith("/affiliate")) return "affiliate";
  return "admin";
}

for (const [from, to] of ALIAS_ROUTES) {
  test(`${from} redirects once to ${to}`, async ({ browser }) => {
    const context = await browser.newContext({
      storageState: `e2e/.auth/${roleFor(to)}.json`,
    });
    const page = await context.newPage();
    const redirectResponses: string[] = [];
    const recordRedirect = (response: Response) => {
      if (
        response.request().isNavigationRequest()
        && (response.status() === 307 || response.status() === 308)
      ) {
        redirectResponses.push(response.url());
      }
    };

    page.on("response", recordRedirect);
    try {
      await page.goto(from);
    } finally {
      page.off("response", recordRedirect);
    }

    await expect(page).toHaveURL(new RegExp(`${escapeRegExp(to)}$`));
    expect(
      redirectResponses,
      `${from} must reach ${to} through exactly one 307 or 308 response`,
    ).toHaveLength(1);
  });
}
