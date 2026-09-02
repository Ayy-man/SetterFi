/**
 * Which demo workspace a platform role gets when it needs one.
 *
 * A coach always tests against their own tenant. Owner, admin and success have no tenant of
 * their own, so the test agent has to name one — and it used to require that exactly one
 * `is_demo = true` row existed. Production has five, so every platform role got
 * TEST_AGENT_PLATFORM_TENANT_UNAVAILABLE and the 409 behind it.
 *
 * The tie-break is not "whichever row the database happens to return first". It is the
 * canonical seeded demo workspace: the tenant `scripts/seed-phase1-demo.mjs` owns, that every
 * later phase seeder populates, and that `scripts/seed-staging-users.mjs` assigns the demo
 * coach to. Testing as an admin and testing as the demo coach therefore land in the same
 * workspace, which is the only reading of "the demo tenant" that isn't arbitrary.
 *
 * When that row is absent — a local stack, or a project seeded some other way — the oldest
 * demo tenant wins, ordered by creation and tie-broken by id so two callers never disagree.
 * With no demo tenant at all the caller still fails honestly rather than borrowing a real one.
 */

/** Kept in step with `DEMO_IDS.tenant` in scripts/seed-phase1-demo.mjs by demo-tenant.test.ts. */
export const DEMO_TENANT_ID = "81000000-0000-4000-8000-000000000001";

export type DemoTenantRow = {
  id: string;
  created_at: string;
};

export function pickPlatformDemoTenant(rows: readonly DemoTenantRow[]): string | null {
  if (rows.some((row) => row.id === DEMO_TENANT_ID)) return DEMO_TENANT_ID;
  const oldestFirst = [...rows].sort((left, right) => (
    left.created_at === right.created_at
      ? left.id.localeCompare(right.id)
      : left.created_at.localeCompare(right.created_at)
  ));
  return oldestFirst[0]?.id ?? null;
}
