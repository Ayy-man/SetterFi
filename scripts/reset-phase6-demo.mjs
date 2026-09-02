/** Removes only rows reachable from the fixed Phase 6 demo signup intents and fixture ids. */

import { pathToFileURL } from "node:url";

import pg from "pg";

import { resolveDemoTarget } from "./seed-phase1-demo.mjs";
import { PHASE6_DEMO_IDS, PHASE6_DEMO_VALUES } from "./seed-phase6-demo.mjs";
import { resetPhase5Demo } from "./reset-phase5-demo.mjs";

async function requireFixtureTenants(database) {
  const result = await database.query(
    `select intent.id intent_id, tenant.id tenant_id, tenant.slug, tenant.is_demo
     from public.signup_intents intent
     left join public.tenants tenant on tenant.id = intent.tenant_id
     where intent.id = any($1::uuid[]) order by intent.id`,
    [[PHASE6_DEMO_IDS.affiliateIntent, PHASE6_DEMO_IDS.moneyIntent]],
  );
  if (result.rowCount === 0) return [];
  const expected = new Map([
    [PHASE6_DEMO_IDS.affiliateIntent, PHASE6_DEMO_VALUES.affiliateSlug],
    [PHASE6_DEMO_IDS.moneyIntent, PHASE6_DEMO_VALUES.moneySlug],
  ]);
  for (const row of result.rows) {
    if (!row.tenant_id || row.is_demo !== true || row.slug !== expected.get(row.intent_id)) {
      throw new Error("PHASE6_DEMO_RESET_ANCESTRY_REFUSED");
    }
  }
  return result.rows.map((row) => row.tenant_id);
}

async function deleteFixtureRows(database, tenantIds) {
  const affiliate = (await database.query(
    `select id from public.affiliates where user_id = $1`,
    [PHASE6_DEMO_IDS.affiliateUser],
  )).rows[0];
  const referralIds = (await database.query(
    `select id from public.referrals where tenant_id = any($1::uuid[])`, [tenantIds],
  )).rows.map((row) => row.id);
  const payoutIds = affiliate
    ? (await database.query(`select id from public.commission_payouts where affiliate_id = $1`, [affiliate.id])).rows.map((row) => row.id)
    : [];

  await database.query("set local session_replication_role = replica");
  await database.query(`delete from public.commission_payout_events where payout_id = any($1::uuid[])`, [payoutIds]);
  await database.query(`delete from public.commission_payout_items where payout_id = any($1::uuid[])`, [payoutIds]);
  await database.query(`delete from public.commission_payouts where id = any($1::uuid[])`, [payoutIds]);
  await database.query(`delete from public.commission_ledger where referral_id = any($1::uuid[])`, [referralIds]);
  await database.query(`delete from public.referral_commission_windows where referral_id = any($1::uuid[])`, [referralIds]);
  await database.query(
    `delete from public.billing_correction_decisions where request_id = any($1::uuid[])`,
    [PHASE6_DEMO_IDS.correctionRequests],
  );
  await database.query(
    `delete from public.billing_correction_requests where id = any($1::uuid[])`,
    [PHASE6_DEMO_IDS.correctionRequests],
  );
  await database.query(`delete from public.allowance_actions where tenant_id = any($1::uuid[])`, [tenantIds]);
  await database.query(`delete from public.notification_deliveries where notification_id = $1`, [PHASE6_DEMO_IDS.allowanceNotice]);
  await database.query(`delete from public.notifications where id = $1`, [PHASE6_DEMO_IDS.allowanceNotice]);
  await database.query(`delete from public.tenant_cost_rollups where tenant_id = any($1::uuid[])`, [tenantIds]);
  await database.query(`delete from public.tenant_price_overrides where tenant_id = any($1::uuid[])`, [tenantIds]);
  await database.query(`delete from public.stripe_checkout_sessions where tenant_id = any($1::uuid[])`, [tenantIds]);
  await database.query(`delete from public.billing_subscriptions where tenant_id = any($1::uuid[])`, [tenantIds]);
  await database.query(
    `delete from public.billable_events where id = any($1::uuid[])`,
    [[...PHASE6_DEMO_IDS.billables, PHASE6_DEMO_IDS.correctionOffset]],
  );
  await database.query(
    `delete from public.appointments where tenant_id = any($1::uuid[]) and external_id like $2`,
    [tenantIds, `${PHASE6_DEMO_VALUES.bookingPrefix}%`],
  );
  await database.query(`delete from public.calendar_connections where id = $1`, [PHASE6_DEMO_IDS.calendar]);
  await database.query(`delete from public.contacts where id = $1`, [PHASE6_DEMO_IDS.contact]);
  await database.query(`delete from public.referrals where id = any($1::uuid[])`, [referralIds]);
  if (affiliate) await database.query(`delete from public.affiliates where id = $1`, [affiliate.id]);
  await database.query(
    `delete from public.audit_log where tenant_id = any($1::uuid[])
       or actor_id = any($2::uuid[])
       or target_id = any($3::text[])`,
    [
      tenantIds,
      [PHASE6_DEMO_IDS.affiliateUser, PHASE6_DEMO_IDS.moneyCoach],
      [...PHASE6_DEMO_IDS.correctionRequests, ...payoutIds],
    ],
  );
  await database.query(`delete from public.provisioning_steps where tenant_id = any($1::uuid[])`, [tenantIds]);
  await database.query(`delete from public.onboarding_runs where tenant_id = any($1::uuid[])`, [tenantIds]);
  await database.query(`delete from public.tenant_settings where tenant_id = any($1::uuid[])`, [tenantIds]);
  await database.query(
    `delete from public.signup_intents where id = any($1::uuid[])`,
    [[PHASE6_DEMO_IDS.affiliateIntent, PHASE6_DEMO_IDS.moneyIntent]],
  );
  await database.query(
    `delete from public.users where id = any($1::uuid[])`,
    [[PHASE6_DEMO_IDS.affiliateUser, PHASE6_DEMO_IDS.moneyCoach]],
  );
  await database.query(`delete from public.tenants where id = any($1::uuid[])`, [tenantIds]);
  await database.query(`delete from public.tiers where id = any($1::uuid[])`, [PHASE6_DEMO_IDS.tiers]);
  await database.query("set local session_replication_role = origin");
}

async function assertReset(database) {
  const result = (await database.query(
    `select
      (select count(*)::int from public.signup_intents where id = any($1::uuid[])) intents,
      (select count(*)::int from public.users where id = any($2::uuid[])) users,
      (select count(*)::int from public.tiers where id = any($3::uuid[])) tiers,
      (select count(*)::int from public.billable_events where id = any($4::uuid[])) billables`,
    [
      [PHASE6_DEMO_IDS.affiliateIntent, PHASE6_DEMO_IDS.moneyIntent],
      [PHASE6_DEMO_IDS.affiliateUser, PHASE6_DEMO_IDS.moneyCoach],
      PHASE6_DEMO_IDS.tiers,
      [...PHASE6_DEMO_IDS.billables, PHASE6_DEMO_IDS.correctionOffset],
    ],
  )).rows[0];
  if (Object.values(result).some((value) => value !== 0)) {
    throw new Error(`PHASE6_DEMO_RESET_INCOMPLETE:${JSON.stringify(result)}`);
  }
  return result;
}

export async function resetPhase6Demo({ argumentsList = process.argv.slice(2) } = {}) {
  const target = resolveDemoTarget(argumentsList);
  if (!target.databaseUrl) throw new Error("SUPABASE_DB_PASSWORD_REQUIRED_FOR_HOSTED_PHASE6_RESET");
  const database = new pg.Client({ connectionString: target.databaseUrl });
  await database.connect();
  try {
    await database.query("begin");
    const tenantIds = await requireFixtureTenants(database);
    if (tenantIds.length > 0) await deleteFixtureRows(database, tenantIds);
    const counts = await assertReset(database);
    await database.query("commit");
    await resetPhase5Demo({ argumentsList });
    console.log(`Phase 6 reset read-back: ${JSON.stringify(counts)} fixed_fixture_scope_only=true`);
    return counts;
  } catch (error) {
    await database.query("rollback");
    throw error;
  } finally {
    await database.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  resetPhase6Demo().catch((error) => {
    console.error(error instanceof Error ? error.message : "PHASE6_DEMO_RESET_FAILED");
    process.exitCode = 1;
  });
}
