// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

const redirect = vi.fn(() => {
  throw new Error("NEXT_REDIRECT");
});
vi.mock("next/navigation", () => ({ redirect }));

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
  it("sends a saved link to the client-override band of Plans and pricing", () => {
    expect(() => AdminTierOverridesPage()).toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/admin/tiers#client-overrides");
  });
});
