// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  navFoldLive: vi.fn(() => false),
  redirect: vi.fn((location: string) => { throw new Error(`NEXT_REDIRECT:${location}`); }),
}));
vi.mock("next/navigation", () => ({ redirect: navigation.redirect }));
vi.mock("@/lib/env-contract", () => ({ navFoldLive: navigation.navFoldLive }));

const { default: AdminTierOverridesPage } = await import("./page");

/**
 * Where the "Client overrides" link ends up.
 *
 * The route used to render the whole Plans and pricing page under a document title of its own, so
 * the tab said "Client overrides" while the heading said "Plans and pricing" and the reader landed
 * at the top of the page rather than on the override rows. The band it should land on is the one
 * `admin-money-tiers.tsx` marks with `id="client-overrides"`; the fragment is asserted here and the
 * id is asserted in that component's own test, so neither half can be removed on its own without
 * something going red.
 */
describe("/admin/tiers/overrides", () => {
  beforeEach(() => {
    navigation.navFoldLive.mockReturnValue(false);
    navigation.redirect.mockClear();
  });

  it("keeps the saved link's original destination when the nav fold is off", async () => {
    await expect(AdminTierOverridesPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_REDIRECT:/admin/tiers#client-overrides");
    expect(navigation.redirect).toHaveBeenCalledWith("/admin/tiers#client-overrides");
  });

  it("sends the saved link to the folded Billing tab when the nav fold is on", async () => {
    navigation.navFoldLive.mockReturnValue(true);

    await expect(AdminTierOverridesPage({ searchParams: Promise.resolve({ client: "tenant-1" }) }))
      .rejects.toThrow("NEXT_REDIRECT:/admin/billing?client=tenant-1&tab=tiers#client-overrides");
    expect(navigation.redirect).toHaveBeenCalledWith("/admin/billing?client=tenant-1&tab=tiers#client-overrides");
  });
});
