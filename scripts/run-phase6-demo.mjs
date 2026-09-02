/** Read-only evidence reader for the seeded Phase 6 money story. */

import { pathToFileURL } from "node:url";

import pg from "pg";

import { resolveDemoTarget } from "./seed-phase1-demo.mjs";
import { PHASE6_DEMO_IDS, PHASE6_DEMO_VALUES } from "./seed-phase6-demo.mjs";

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

export async function verifyPhase6Demo({ argumentsList = process.argv.slice(2) } = {}) {
  const target = resolveDemoTarget(argumentsList);
  if (!target.databaseUrl) throw new Error("SUPABASE_DB_PASSWORD_REQUIRED_FOR_HOSTED_PHASE6_VERIFY");
  const database = new pg.Client({ connectionString: target.databaseUrl });
  await database.connect();
  try {
    const tenants = await database.query(
      `select intent.id intent_id, tenant.id, tenant.slug, tenant.status::text, tenant.is_demo
       from public.signup_intents intent join public.tenants tenant on tenant.id = intent.tenant_id
       where intent.id = any($1::uuid[]) order by intent.id`,
      [[PHASE6_DEMO_IDS.affiliateIntent, PHASE6_DEMO_IDS.moneyIntent]],
    );
    assert(tenants.rowCount === 2 && tenants.rows.every((row) => row.is_demo), "PHASE6_DEMO_TENANTS_INVALID");
    const moneyTenant = tenants.rows.find((row) => row.slug === PHASE6_DEMO_VALUES.moneySlug);
    assert(moneyTenant?.status === "overdue", "PHASE6_DEMO_OVERDUE_SCENARIO_MISSING");
    const counts = (await database.query(
      `select
        (select count(*)::int from public.stripe_checkout_sessions where tenant_id = $1) checkouts,
        (select count(*)::int from public.appointments where tenant_id = $1 and attributed_to_agent) bookings,
        (select count(*)::int from public.billable_events where tenant_id = $1 and adjusts_event_id is null) billables,
        (select count(*)::int from public.billing_correction_requests where tenant_id = $1) corrections,
        (select count(*)::int from public.allowance_actions where tenant_id = $1) allowance_actions,
        (select count(*)::int from public.commission_ledger l join public.referrals r on r.id = l.referral_id
          where r.tenant_id = $1) ledger_entries,
        (select count(*)::int from public.tenant_cost_rollups where tenant_id = $1 and complete) complete_rollups,
        (select count(*)::int from public.tenant_cost_rollups where tenant_id = $1 and not complete) incomplete_rollups`,
      [moneyTenant.id],
    )).rows[0];
    const expected = {
      checkouts: 1, bookings: 4, billables: 4, corrections: 2,
      allowance_actions: 2, ledger_entries: 5, complete_rollups: 1, incomplete_rollups: 1,
    };
    assert(JSON.stringify(counts) === JSON.stringify(expected), `PHASE6_DEMO_IDEMPOTENCY_INVALID:${JSON.stringify(counts)}`);
    console.log(`Phase 6 demo evidence: ${JSON.stringify(counts)} stripe_arm=Mock real_stripe_calls=0`);
    console.log("Browser UAT remains human-owed; follow scripts/phase6-demo-runbook.md exactly.");
    return { counts, tenants: tenants.rows };
  } finally {
    await database.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyPhase6Demo().catch((error) => {
    console.error(error instanceof Error ? error.message : "PHASE6_DEMO_VERIFY_FAILED");
    process.exitCode = 1;
  });
}
