// The lifecycle writes run against Postgres because the separation from tenant ownership and
// affiliate identity isolation are database guarantees, not route-only conventions.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL =
  process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const TENANT = "90800000-0000-4000-8000-000000000001";
const ADMIN = "90800000-0000-4000-8000-000000000002";
const SUCCESS_A = "90800000-0000-4000-8000-000000000003";
const SUCCESS_B = "90800000-0000-4000-8000-000000000004";
const COACH = "90800000-0000-4000-8000-000000000005";
const AFFILIATE_A = "90800000-0000-4000-8000-000000000006";
const AFFILIATE_B = "90800000-0000-4000-8000-000000000007";
const THREAD = "90800000-0000-4000-8000-000000000008";

let db: Client;

async function actAs(role: "authenticated" | "service_role", claims: Record<string, string>) {
  await db.query(`set local role ${role}`);
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: claims.sub, app_metadata: claims }),
  ]);
}

async function resetRole() {
  await db.query("reset role");
  await db.query(`select set_config('request.jwt.claims', '{}', true)`);
}

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  await db.connect();
});

afterAll(async () => {
  await db?.end();
});

beforeEach(async () => {
  await db.query("begin");
  await db.query(`
    insert into public.tenants (id, slug, name, billing_contact_email) values
      ('${TENANT}', 'lifecycle-identity', 'Synthetic Lifecycle Tenant', 'lifecycle@test.invalid');
    insert into public.users (id, email, role, tenant_id) values
      ('${ADMIN}', 'admin@lifecycle.test', 'admin', null),
      ('${SUCCESS_A}', 'success-a@lifecycle.test', 'success', null),
      ('${SUCCESS_B}', 'success-b@lifecycle.test', 'success', null),
      ('${COACH}', 'coach@lifecycle.test', 'coach', '${TENANT}'),
      ('${AFFILIATE_A}', 'affiliate-a@lifecycle.test', 'affiliate', null),
      ('${AFFILIATE_B}', 'affiliate-b@lifecycle.test', 'affiliate', null);
    update public.tenants set success_owner = '${SUCCESS_A}' where id = '${TENANT}';
    insert into public.support_threads (id, tenant_id, subject, created_by)
      values ('${THREAD}', '${TENANT}', 'Synthetic lifecycle thread', '${COACH}');
    insert into public.affiliates (user_id, referral_code) values
      ('${AFFILIATE_A}', 'SF-OWN-908'), ('${AFFILIATE_B}', 'SF-OTHER-908');
  `);
});

afterEach(async () => {
  await db.query("rollback");
});

describe("support thread lifecycle and affiliate identity", () => {
  it("persists every supported status with an audit receipt and leaves tenant success ownership unchanged", async () => {
    await actAs("service_role", { sub: ADMIN, role: "admin" });
    for (const status of ["open", "waiting_on_coach", "resolved"]) {
      const receipt = await db.query<{
        thread_id: string; tenant_id: string; status: string; audit_id: string;
      }>(`select * from public.set_support_thread_status($1,$2,$3,$4)`, [
        THREAD, ADMIN, status, `Synthetic ${status} transition`,
      ]);
      expect(receipt.rows[0]).toMatchObject({ thread_id: THREAD, tenant_id: TENANT, status });
      expect(Number(receipt.rows[0].audit_id)).toBeGreaterThan(0);
    }
    await resetRole();
    const persisted = await db.query<{
      status: string; success_owner: string; audit_count: string;
    }>(`
      select thread.status, tenant.success_owner,
        (select count(*)::text from public.audit_log
         where target_type = 'support_thread' and target_id = '${THREAD}'
           and action = 'support.thread.status.changed') as audit_count
      from public.support_threads thread join public.tenants tenant on tenant.id = thread.tenant_id
      where thread.id = '${THREAD}'
    `);
    expect(persisted.rows[0]).toEqual({
      status: "resolved", success_owner: SUCCESS_A, audit_count: "3",
    });
  });

  it("assigns only the thread, records the actor, and rejects a coach actor", async () => {
    await actAs("service_role", { sub: ADMIN, role: "admin" });
    const receipt = await db.query<{ assigned_to: string; audit_id: string }>(
      `select * from public.set_support_thread_assignee($1,$2,$3,$4)`,
      [THREAD, ADMIN, SUCCESS_B, "Synthetic support routing"],
    );
    await resetRole();
    const persisted = await db.query<{
      assigned_to: string; success_owner: string; actor_id: string; action: string;
    }>(`
      select thread.assigned_to, tenant.success_owner, audit.actor_id, audit.action
      from public.support_threads thread
      join public.tenants tenant on tenant.id = thread.tenant_id
      join public.audit_log audit on audit.id = $2::bigint
      where thread.id = $1
    `, [THREAD, receipt.rows[0].audit_id]);
    expect(persisted.rows[0]).toEqual({
      assigned_to: SUCCESS_B,
      success_owner: SUCCESS_A,
      actor_id: ADMIN,
      action: "support.thread.assignment.changed",
    });

    await actAs("service_role", { sub: COACH, role: "coach", tenant_id: TENANT });
    await expect(db.query(
      `select * from public.set_support_thread_assignee($1,$2,$3,$4)`,
      [THREAD, COACH, SUCCESS_B, "Forged routing"],
    )).rejects.toThrow(/SUPPORT_THREAD_ACTOR_FORBIDDEN/);
  });

  it("RLS exposes an affiliate only their own referral code and refuses a cross-affiliate lookup", async () => {
    await actAs("authenticated", { sub: AFFILIATE_A, role: "affiliate" });
    const own = await db.query<{ referral_code: string }>(
      "select referral_code from public.affiliates order by referral_code",
    );
    const other = await db.query<{ referral_code: string }>(
      "select referral_code from public.affiliates where user_id = $1",
      [AFFILIATE_B],
    );

    expect(own.rows).toEqual([{ referral_code: "SF-OWN-908" }]);
    expect(other.rows).toEqual([]);
  });
});
