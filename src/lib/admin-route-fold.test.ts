import { describe, expect, it } from "vitest";

import { foldedRouteFor, foldedRouteRedirect } from "@/lib/admin-route-fold";

describe("foldedRouteRedirect", () => {
  it.each([
    ["/admin/tiers", "/admin/billing?tab=tiers"],
    ["/admin/tiers/overrides", "/admin/billing?tab=tiers#client-overrides"],
    ["/admin/affiliates", "/admin/billing?tab=affiliates"],
    ["/admin/corrections", "/admin/billing?tab=corrections"],
    ["/admin/billing/costs", "/admin/billing?tab=costs"],
    ["/admin/agents", "/admin/platform-clients?tab=agent"],
    ["/admin/agent-performance", "/admin/platform-clients?tab=performance"],
    ["/admin/channel-health", "/admin/platform-clients?tab=health"],
    ["/admin/provisioning", "/admin/platform-clients?tab=setup"],
    ["/admin/support-team", "/admin/platform-clients?tab=team"],
    ["/admin/brain/testing", "/admin/brain?tab=evals"],
    ["/admin/account-terms", "/account?section=terms"],
    ["/admin/help", "/account?section=help"],
  ])("maps %s to %s", (pathname, expected) => {
    expect(foldedRouteRedirect(pathname, new URLSearchParams())).toBe(expected);
    expect(foldedRouteFor[pathname]).toBeDefined();
  });

  it("preserves existing search params while setting the folded destination tab", () => {
    expect(foldedRouteRedirect("/admin/tiers", new URLSearchParams("client=tenant-1&filter=active&tag=one&tag=two")))
      .toBe("/admin/billing?client=tenant-1&filter=active&tag=one&tag=two&tab=tiers");
  });

  it("keeps the fragment after the query string", () => {
    expect(foldedRouteRedirect("/admin/tiers/overrides", new URLSearchParams("client=tenant-1")))
      .toBe("/admin/billing?client=tenant-1&tab=tiers#client-overrides");
  });

  it("returns null for an unfurled route", () => {
    expect(foldedRouteRedirect("/admin/billing", new URLSearchParams("tab=tiers"))).toBeNull();
  });
});
