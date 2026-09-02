import { describe, expect, it } from "vitest";

import { DESIGN_SHEET_ROLES } from "@/app/design/page";
import { PLATFORM_ROLES, USER_ROLES } from "@/lib/auth/claims";

/**
 * The property, not the spelling.
 *
 * `/design` is an internal component sheet and its docblock used to claim it was gated exactly the
 * way `/admin/audit` and `/admin/overview` are. It never was: those admit `owner`, `admin` and
 * `success`; this admits `owner`, `admin` and `build`. Nothing leaked, because both sets are
 * platform staff -- but a comment inviting the next reader to reconcile the two is a standing
 * instruction to break it, in one of two directions, and neither is visible in a diff that looks
 * like tidying.
 *
 * So these assert the two halves of the difference rather than the three names. Restating the
 * literal set here would pass on any change made to the constant and the test together, which is
 * exactly the change worth catching.
 */
describe("who may read the atomics sheet", () => {
  it("admits the engineering role the page exists for", () => {
    expect(DESIGN_SHEET_ROLES).toContain("build");
  });

  /*
   * The reconciliation guard. `success` owns a book of coaches; an internal component sheet is not
   * theirs, and adding them is precisely what "make it match `/admin/audit`" would do.
   */
  it("excludes the client-success role, which is where it differs from the admin console", () => {
    expect(DESIGN_SHEET_ROLES).not.toContain("success");
    expect([...DESIGN_SHEET_ROLES].sort()).not.toEqual([...PLATFORM_ROLES].sort());
  });

  /*
   * An allow-list, so a role added to the product later is refused until somebody decides
   * otherwise -- the safe default for an internal page, and stated here so the omission reads as a
   * decision rather than an oversight.
   */
  it("names only real roles, and stays an allow-list rather than a deny-list", () => {
    for (const role of DESIGN_SHEET_ROLES) expect(USER_ROLES).toContain(role);
    expect(DESIGN_SHEET_ROLES.length).toBeLessThan(USER_ROLES.length);
  });
});
