/** Removes only the labelled Phase 7 demo tenant and rows anchored to its synthetic markers. */

import { pathToFileURL } from "node:url";

import pg from "pg";

import { resolveDemoTarget } from "./seed-phase1-demo.mjs";
import { PHASE7_DEMO_IDS, PHASE7_DEMO_VALUES } from "./seed-phase7-demo.mjs";

async function requireFixtureTenant(database) {
  const result = await database.query(
    "select id,slug,is_demo from public.tenants where id=$1 or slug=$2",
    [PHASE7_DEMO_IDS.tenant, PHASE7_DEMO_VALUES.slug],
  );
  if (result.rowCount === 0) return false;
  if (result.rowCount !== 1 || result.rows[0].id !== PHASE7_DEMO_IDS.tenant
    || result.rows[0].slug !== PHASE7_DEMO_VALUES.slug || result.rows[0].is_demo !== true) {
    throw new Error("PHASE7_DEMO_TENANT_ANCESTRY_REFUSED");
  }
  return true;
}

async function deleteFixtureRows(database) {
  const comparisonIds = (await database.query(
    "select id from public.eval_comparisons where case_set_hash=$1",
    [PHASE7_DEMO_VALUES.comparisonCaseSet],
  )).rows.map((row) => row.id);
  const runIds = (await database.query(
    "select id from public.eval_runs where comparison_id=any($1::uuid[])", [comparisonIds],
  )).rows.map((row) => row.id);
  const challengerIds = (await database.query(
    "select id from public.model_configs where openrouter_model=$1 and role='generator' and active=false",
    [PHASE7_DEMO_VALUES.challengerModel],
  )).rows.map((row) => row.id);

  await database.query("set local session_replication_role=replica");
  // Match the legacy sentinel notes too: a case promoted before the readable-copy pass would
  // otherwise survive the reset as an orphan and make the seed skip the test-session bundle.
  await database.query("delete from public.eval_cases where source_tenant_id=$1 and notes=any($2::text[])",
    [PHASE7_DEMO_IDS.tenant, [PHASE7_DEMO_VALUES.promotionNotes, PHASE7_DEMO_VALUES.legacyPromotionNotes]]);
  await database.query("delete from public.eval_case_results where run_id=any($1::uuid[])", [runIds]);
  await database.query("delete from public.eval_runs where id=any($1::uuid[])", [runIds]);
  await database.query("delete from public.eval_comparisons where id=any($1::uuid[])", [comparisonIds]);
  await database.query(
    `delete from public.audit_log where
       (action='eval.case.promoted' and payload->>'source_tenant_id'=$1)
       or (action='eval.model_config.created' and target_id=any($2::text[]))
       or tenant_id=$3`,
    [PHASE7_DEMO_IDS.tenant, challengerIds, PHASE7_DEMO_IDS.tenant],
  );
  await database.query("delete from public.model_configs where id=any($1::uuid[])", [challengerIds]);

  await database.query("delete from public.billable_events where tenant_id=$1", [PHASE7_DEMO_IDS.tenant]);
  await database.query("delete from public.message_traces where tenant_id=$1", [PHASE7_DEMO_IDS.tenant]);
  await database.query("delete from public.conversation_step_events where tenant_id=$1", [PHASE7_DEMO_IDS.tenant]);
  await database.query("delete from public.followups where tenant_id=$1", [PHASE7_DEMO_IDS.tenant]);
  await database.query("delete from public.brain_knowledge_usage_events where tenant_id=$1", [PHASE7_DEMO_IDS.tenant]);
  await database.query("delete from public.appointments where tenant_id=$1", [PHASE7_DEMO_IDS.tenant]);
  await database.query("delete from public.contact_identities where tenant_id=$1", [PHASE7_DEMO_IDS.tenant]);
  await database.query("delete from public.messages where tenant_id=$1", [PHASE7_DEMO_IDS.tenant]);
  await database.query("delete from public.conversations where tenant_id=$1", [PHASE7_DEMO_IDS.tenant]);
  await database.query("delete from public.contacts where tenant_id=$1", [PHASE7_DEMO_IDS.tenant]);
  await database.query("delete from public.test_agent_sessions where tenant_id=$1", [PHASE7_DEMO_IDS.tenant]);
  await database.query("delete from public.provisioning_steps where tenant_id=$1", [PHASE7_DEMO_IDS.tenant]);
  await database.query("delete from public.onboarding_runs where tenant_id=$1", [PHASE7_DEMO_IDS.tenant]);
  await database.query("delete from public.calendar_connections where tenant_id=$1", [PHASE7_DEMO_IDS.tenant]);
  await database.query("delete from public.tenant_settings where tenant_id=$1", [PHASE7_DEMO_IDS.tenant]);
  await database.query("delete from public.users where id=$1 and tenant_id=$2",
    [PHASE7_DEMO_IDS.coach, PHASE7_DEMO_IDS.tenant]);
  await database.query("delete from public.tenants where id=$1 and is_demo=true",
    [PHASE7_DEMO_IDS.tenant]);
  await database.query("set local session_replication_role=origin");
}

async function assertReset(database) {
  return (await database.query(
    `select
      (select count(*)::int from public.tenants where id=$1 or slug=$2) tenants,
      (select count(*)::int from public.users where id=$3) users,
      (select count(*)::int from public.eval_cases where source_tenant_id=$1 and notes=$4) eval_cases,
      (select count(*)::int from public.eval_comparisons where case_set_hash=$5) comparisons,
      (select count(*)::int from public.model_configs where openrouter_model=$6 and active=false) challengers`,
    [PHASE7_DEMO_IDS.tenant, PHASE7_DEMO_VALUES.slug, PHASE7_DEMO_IDS.coach,
      PHASE7_DEMO_VALUES.promotionNotes, PHASE7_DEMO_VALUES.comparisonCaseSet,
      PHASE7_DEMO_VALUES.challengerModel],
  )).rows[0];
}

export async function resetPhase7Demo({ argumentsList = process.argv.slice(2) } = {}) {
  const target = resolveDemoTarget(argumentsList);
  if (!target.databaseUrl) throw new Error("SUPABASE_DB_PASSWORD_REQUIRED_FOR_HOSTED_PHASE7_RESET");
  const database = new pg.Client({ connectionString: target.databaseUrl });
  await database.connect();
  try {
    await database.query("begin");
    if (await requireFixtureTenant(database)) await deleteFixtureRows(database);
    const counts = await assertReset(database);
    if (Object.values(counts).some((value) => value !== 0)) {
      throw new Error(`PHASE7_DEMO_RESET_INCOMPLETE:${JSON.stringify(counts)}`);
    }
    await database.query("commit");
    console.log(`Phase 7 reset read-back: ${JSON.stringify(counts)} fixed_fixture_scope_only=true`);
    return counts;
  } catch (error) {
    await database.query("rollback");
    throw error;
  } finally {
    await database.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  resetPhase7Demo().catch((error) => {
    console.error(error instanceof Error ? error.message : "PHASE7_DEMO_RESET_FAILED");
    process.exitCode = 1;
  });
}
