import { describe, expect, it } from "vitest";

import { assetHostsFor, DEFAULT_ASSET_HOSTS, hostOf } from "@/lib/offer/asset-hosts";

describe("assetHostsFor", () => {
  it("unions the platform hosts, the tenant's own list and the business website host", () => {
    const hosts = assetHostsFor([" Files.Example.com ", ""], "https://www.coach.example/about");
    for (const host of DEFAULT_ASSET_HOSTS) expect(hosts).toContain(host);
    expect(hosts).toContain("files.example.com");
    expect(hosts).toContain("www.coach.example");
    expect(hosts).not.toContain("");
  });

  it("copes with no website and a malformed one", () => {
    expect(assetHostsFor([], null)).toEqual([...DEFAULT_ASSET_HOSTS]);
    expect(assetHostsFor([], "not a url")).toEqual([...DEFAULT_ASSET_HOSTS]);
    expect(hostOf("not a url")).toBeNull();
  });
});
