import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL = process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const TENANT_A = "97000000-0000-4000-8000-000000000001";
const TENANT_B = "97000000-0000-4000-8000-000000000002";
const COACH_A = "97000000-0000-4000-8000-000000000011";
const COACH_B = "97000000-0000-4000-8000-000000000012";
let db: Client;

async function actAs(role: "authenticated" | "service_role", claims: Record<string, string> = {}) {
  await db.query(`set local role ${role}`);
  await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: claims.sub, app_metadata: claims })]);
}

const profileArgs = [TENANT_A, COACH_A, "Synthetic LLC", "llc", true, "https://example.test", "1 Test Street", null, "Austin", "TX", "78701", "us"];

beforeAll(async () => { db = new Client({ connectionString: DB_URL }); await db.connect(); });
afterAll(async () => { await db?.end(); });
beforeEach(async () => {
  await db.query("begin");
  await db.query(`insert into public.tenants (id, slug, name, billing_contact_email) values
    ('${TENANT_A}', 'onboarding-write-a', 'Onboarding Write A', 'a@write.test'),
    ('${TENANT_B}', 'onboarding-write-b', 'Onboarding Write B', 'b@write.test');
    insert into public.users (id, email, role, tenant_id) values
    ('${COACH_A}', 'coach-a@write.test', 'coach', '${TENANT_A}'),
    ('${COACH_B}', 'coach-b@write.test', 'coach', '${TENANT_B}');`);
});
afterEach(async () => { await db.query("rollback"); });

describe("onboarding coach write contracts", () => {
  it("keeps the business-profile RPC service-only, scoped to its coach tenant, and audit-backed", async () => {
    await actAs("service_role", { sub: COACH_A, tenant_id: TENANT_A, role: "coach" });
    const saved = await db.query<{ profile_id: string; audit_id: string }>(`select * from public.save_onboarding_business_profile(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
    )`, profileArgs);
    expect(saved.rows[0].profile_id).toEqual(expect.any(String));
    const stored = await db.query<{ country_code: string; action: string; tenant_id: string }>(`
      select profile.country_code, audit.action, audit.tenant_id::text
      from public.business_profiles profile join public.audit_log audit on audit.id = $2::bigint where profile.id = $1::uuid`,
    [saved.rows[0].profile_id, saved.rows[0].audit_id]);
    expect(stored.rows[0]).toEqual({ country_code: "US", action: "onboarding.business_profile.saved", tenant_id: TENANT_A });
    await db.query("savepoint forged_tenant");
    await expect(db.query(`select * from public.save_onboarding_business_profile($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [TENANT_B, COACH_A, ...profileArgs.slice(2)])).rejects.toThrow(/ONBOARDING_COACH_TENANT_FORBIDDEN/);
    await db.query("rollback to savepoint forged_tenant");
    await db.query("reset role"); await actAs("authenticated", { sub: COACH_A, tenant_id: TENANT_A, role: "coach" });
    await expect(db.query(`select * from public.save_onboarding_business_profile($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, profileArgs)).rejects.toThrow(/permission denied/);
  });

  it("enforces the LLC EIN constraint before writing the business profile", async () => {
    await actAs("service_role", { sub: COACH_A, tenant_id: TENANT_A, role: "coach" });
    await db.query("savepoint missing_ein");
    await expect(db.query(`select * from public.save_onboarding_business_profile($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [...profileArgs.slice(0, 4), false, ...profileArgs.slice(5)])).rejects.toThrow(/BUSINESS_PROFILES_ENTITY_EIN_REQUIRED/);
    await db.query("rollback to savepoint missing_ein");
  });

  it("stores only a calendar authorization receipt hash, keeps the connection connecting, and denies direct writes", async () => {
    await actAs("service_role", { sub: COACH_A, tenant_id: TENANT_A, role: "coach" });
    const result = await db.query<{ calendar_connection_id: string; audit_id: string; state: string }>(`
      select * from public.record_onboarding_calendar_authorization($1,$2,$3::public.calendar_provider,$4,$5,$6,$7,$8)`,
    [TENANT_A, COACH_A, "google", "account-ref", "calendar-ref", "Synthetic calendar", "America/Chicago", "a".repeat(64)]);
    expect(result.rows[0].state).toBe("connecting");
    const stored = await db.query<{ receipt: string; account: string; action: string }>(`
      select connection.authorization_receipt_hash as receipt, connection.external_account_reference as account, audit.action
      from public.calendar_connections connection join public.audit_log audit on audit.id = $2::bigint
      where connection.id = $1::uuid`, [result.rows[0].calendar_connection_id, result.rows[0].audit_id]);
    expect(stored.rows[0]).toEqual({ receipt: "a".repeat(64), account: "account-ref", action: "onboarding.calendar_authorization.recorded" });
    await db.query("reset role"); await actAs("authenticated", { sub: COACH_A, tenant_id: TENANT_A, role: "coach" });
    await expect(db.query(`update public.calendar_connections set state = 'ready' where id = $1`, [result.rows[0].calendar_connection_id])).rejects.toThrow(/permission denied/);
  });

  it("keeps the new RPCs service-role-only and migration source free of raw receipt storage", async () => {
    const grants = await db.query<{ proname: string; authenticated: boolean; service: boolean }>(`
      select proname, has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
        has_function_privilege('service_role', p.oid, 'execute') as service
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and proname in ('save_onboarding_business_profile', 'record_onboarding_calendar_authorization') order by proname`);
    expect(grants.rows).toEqual([
      { proname: "record_onboarding_calendar_authorization", authenticated: false, service: true },
      { proname: "save_onboarding_business_profile", authenticated: false, service: true },
    ]);
    const migration = readFileSync(resolve("supabase/migrations/20260907000001_onboarding_coach_write_contracts.sql"), "utf8");
    expect(migration).toContain("force row level security");
    expect(migration).toContain("authorization_receipt_hash");
    expect(migration).not.toMatch(/authorization_receipt text/i);
  });
});
