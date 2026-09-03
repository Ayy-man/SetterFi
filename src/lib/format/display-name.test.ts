import { describe, expect, it } from "vitest";

import { displayName, displayNameOrNull } from "@/lib/format/display-name";

describe("displayName", () => {
  it("strips one trailing seeded marker, whatever its case or spacing", () => {
    expect(displayName("Reid Funding Group (demo)")).toBe("Reid Funding Group");
    expect(displayName("Reid Funding Group(DEMO) ")).toBe("Reid Funding Group");
  });

  it("leaves a marker that is not at the end alone", () => {
    expect(displayName("Acme (demo) Holdings")).toBe("Acme (demo) Holdings");
  });

  it("never returns an empty string for a name that is only the marker", () => {
    expect(displayName("(demo)")).toBe("(demo)");
  });

  it("passes absence through", () => {
    expect(displayNameOrNull(null)).toBeNull();
    expect(displayNameOrNull(undefined)).toBeNull();
    expect(displayNameOrNull("Ana (demo)")).toBe("Ana");
  });
});
