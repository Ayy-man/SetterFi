import { describe, expect, it } from "vitest";

import { DISCLOSURE_CASES } from "./disclosure-url.cases";
import { disclosureHost, disclosureHostIsReachable } from "./disclosure-url";

describe("disclosure host reachability", () => {
  // The table is the contract. Each case carries its own reason, so a failure names the edge it
  // is about rather than an index.
  for (const { url, reachable, because } of DISCLOSURE_CASES) {
    it(`${reachable ? "accepts" : "refuses"} ${JSON.stringify(url)} -- ${because}`, () => {
      expect(disclosureHostIsReachable(url)).toBe(reachable);
    });
  }

  it("never throws, whatever it is handed", () => {
    // Every caller is reading a row that already exists, so a read that raises is worse than a
    // read that says no. Nothing here can be stored under the column's `^https://` check today,
    // which is exactly why the rule has to answer for it rather than assume it away.
    const hostile = ["", " ", "https://", "://x", "not a url", "https://[", "https://%",
      "HTTPS://COACH-SITE.COM/x", "https://x".repeat(4000)];
    for (const value of hostile) {
      expect(() => disclosureHostIsReachable(value)).not.toThrow();
    }
  });

  it("reports the host it judged, so a flagged row can explain itself", () => {
    // The boolean alone does not tell an operator what was wrong. These are the only two things
    // the export column's explanation can be built from.
    expect(disclosureHost("https://user:pw@Coach-Site.COM:8443/privacy?a=1#b")).toBe("coach-site.com");
    expect(disclosureHost("https://example.invalid/phase5-demo/privacy")).toBe("example.invalid");
    expect(disclosureHost("/opt-in/tenant-a/privacy")).toBeNull();
  });

  it("is case-insensitive on the host but not fooled by a lowercased path", () => {
    // The path is never part of the judgement: a reserved name in the path is not the host.
    expect(disclosureHostIsReachable("https://EXAMPLE.INVALID/x")).toBe(false);
    expect(disclosureHostIsReachable("https://coach-site.com/example.invalid")).toBe(true);
  });
});
