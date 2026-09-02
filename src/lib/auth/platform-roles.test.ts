import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { PLATFORM_ROLES, USER_ROLES } from "@/lib/auth/claims";

/**
 * The set lived in three files under two names, and nothing failed when they drifted. This test is
 * the thing that fails: it pins the contents once, and then refuses a fourth copy anywhere in the
 * three consumers.
 */
const CONSUMERS = [
  "src/app/api/admin/provisioning/handler.ts",
  "src/lib/repositories/onboarding-steps.ts",
  "src/components/onboarding/install-attempts-view-models.ts",
];

/** Comment lines are stripped so prose quoting the four roles can neither pass nor fail this. */
function code(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
    .join("\n");
}

describe("PLATFORM_ROLES", () => {
  it("is the four roles that may read platform-wide provisioning state", () => {
    expect([...PLATFORM_ROLES]).toEqual(["owner", "admin", "success", "build"]);
  });

  it("names only roles the claims module recognises", () => {
    for (const role of PLATFORM_ROLES) expect(USER_ROLES).toContain(role);
  });

  it.each(CONSUMERS)("%s imports the shared set", (path) => {
    const source = code(path);
    expect(source).toContain("PLATFORM_ROLES");
    // `[^;]` already spans newlines, so a multi-line import statement matches without the `s` flag.
    expect(source).toMatch(/import[^;]*PLATFORM_ROLES[^;]*from "@\/lib\/auth\/claims"/);
  });

  it.each(CONSUMERS)("%s declares no copy of its own", (path) => {
    expect(code(path)).not.toMatch(/\[\s*"owner",\s*"admin",\s*"success",\s*"build"\s*\]/);
  });
});
