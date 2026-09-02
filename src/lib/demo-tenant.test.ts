import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { DEMO_TENANT_ID, pickPlatformDemoTenant } from "@/lib/demo-tenant";

const SEEDER_PATH = "scripts/seed-phase1-demo.mjs";
const seederSource = readFileSync(resolve(process.cwd(), SEEDER_PATH), "utf8");

/** The five rows production actually holds, in the order the table happened to return them. */
const PRODUCTION_ROWS = [
  { id: "a1000000-0000-4000-8000-000000000001", created_at: "2026-07-20T10:00:00.000Z" },
  { id: "a1000000-0000-4000-8000-000000000002", created_at: "2026-07-22T10:00:00.000Z" },
  { id: DEMO_TENANT_ID, created_at: "2026-08-01T10:00:00.000Z" },
  { id: "a1000000-0000-4000-8000-000000000003", created_at: "2026-07-25T10:00:00.000Z" },
  { id: "a1000000-0000-4000-8000-000000000004", created_at: "2026-07-28T10:00:00.000Z" },
];

describe("pickPlatformDemoTenant", () => {
  // The regression: the resolver required exactly one is_demo row, so five of them meant
  // TEST_AGENT_PLATFORM_TENANT_UNAVAILABLE and a 409 for every owner, admin and success session.
  it("picks the canonical seeded workspace out of a crowd, whatever the row order", () => {
    expect(pickPlatformDemoTenant(PRODUCTION_ROWS)).toBe(DEMO_TENANT_ID);
    expect(pickPlatformDemoTenant([...PRODUCTION_ROWS].reverse())).toBe(DEMO_TENANT_ID);
  });

  it("still resolves a single demo tenant that is not the canonical one", () => {
    expect(pickPlatformDemoTenant([PRODUCTION_ROWS[0]])).toBe(PRODUCTION_ROWS[0].id);
  });

  it("falls back to the oldest, tie-broken by id, so two callers cannot disagree", () => {
    const withoutCanonical = PRODUCTION_ROWS.filter((row) => row.id !== DEMO_TENANT_ID);
    expect(pickPlatformDemoTenant(withoutCanonical)).toBe(withoutCanonical[0].id);
    expect(pickPlatformDemoTenant([...withoutCanonical].reverse())).toBe(withoutCanonical[0].id);

    const sameInstant = [
      { id: "b0000000-0000-4000-8000-000000000002", created_at: "2026-07-20T10:00:00.000Z" },
      { id: "b0000000-0000-4000-8000-000000000001", created_at: "2026-07-20T10:00:00.000Z" },
    ];
    expect(pickPlatformDemoTenant(sameInstant)).toBe("b0000000-0000-4000-8000-000000000001");
  });

  // Borrowing a real coach's tenant to run test traffic would be worse than refusing.
  it("returns null when the project has no demo tenant at all", () => {
    expect(pickPlatformDemoTenant([])).toBeNull();
  });

  it("names the tenant the demo seeders actually populate", () => {
    expect(seederSource).toContain(`tenant: "${DEMO_TENANT_ID}"`);
  });
});
