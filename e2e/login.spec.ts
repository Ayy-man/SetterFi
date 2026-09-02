import { expect, test } from "@playwright/test";

test("a bad password shows a helpful sign-in error", async ({ page }) => {
  await page.goto("/login", { waitUntil: "networkidle" });
  await page.getByLabel(/email/i).fill("invalid-login@setterfi.example");
  await page.getByLabel(/password/i).fill("definitely-wrong-password");
  await page.getByRole("button", { name: /^sign in$/i }).click();

  await expect(page.getByText(/could not sign you in/i)).toBeVisible();
});
