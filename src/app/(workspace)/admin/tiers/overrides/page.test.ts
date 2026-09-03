// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  redirect: vi.fn((location: string) => { throw new Error(`NEXT_REDIRECT:${location}`); }),
}));
vi.mock("next/navigation", () => ({ redirect: navigation.redirect }));

const { default: AdminTierOverridesPage } = await import("./page");

/**
 * Where the "Client overrides" link ends up.
 *
 * Plans and pricing is a tab of the Money page now, and the override rows are a band inside it. The
 * band is the one `admin-money-tiers.tsx` marks with `id="client-overrides"`; the fragment is
 * asserted here and the id is asserted in that component's own test, so neither half can be removed
 * on its own without something going red.
 */
describe("/admin/tiers/overrides", () => {
  it("sends the saved link to the Billing tiers tab, on the overrides band", async () => {
    navigation.redirect.mockClear();

    await expect(AdminTierOverridesPage({ searchParams: Promise.resolve({ client: "tenant-1" }) }))
      .rejects.toThrow("NEXT_REDIRECT:/admin/billing?client=tenant-1&tab=tiers#client-overrides");
    expect(navigation.redirect).toHaveBeenCalledWith("/admin/billing?client=tenant-1&tab=tiers#client-overrides");
  });
});
