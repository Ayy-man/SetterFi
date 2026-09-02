/** Exact-ID reset for the synthetic Phase 5 demo extension. */

import { pathToFileURL } from "node:url";

import pg from "pg";

import { DEMO_IDS, DEMO_VALUES, resolveDemoTarget } from "./seed-phase1-demo.mjs";
import { PHASE5_DEMO_IDS, PHASE5_DEMO_VALUES } from "./seed-phase5-demo.mjs";
import { RETIRED_DEMO_TIER_IDS } from "./fixtures/names.mjs";

const PHASE5_ONLY_STEPS = [
  "billing",
  "ghl_snapshot",
  "phone_number",
  "sms_eligibility_screen",
  "business_profile",
  "optin_artifact",
  "a2p_brand",
  "meta_connect",
  "whatsapp_connect",
];

async function requireKnownDemo(database) {
  const tenant = (await database.query(
    "select id, slug, is_demo from public.tenants where id = $1",
    [DEMO_IDS.tenant],
  )).rows[0];
  if (!tenant || tenant.id !== DEMO_IDS.tenant || tenant.slug !== DEMO_VALUES.slug || tenant.is_demo !== true) {
    throw new Error("PHASE5_RESET_REFUSED_NOT_KNOWN_DEMO");
  }
}

export async function resetPhase5Demo({ argumentsList = process.argv.slice(2) } = {}) {
  const target = resolveDemoTarget(argumentsList);
  console.log(`Demo database target host: ${target.host}`);
  if (!target.databaseUrl) throw new Error("SUPABASE_DB_PASSWORD_REQUIRED_FOR_HOSTED_PHASE5_RESET");
  const database = new pg.Client({ connectionString: target.databaseUrl });
  await database.connect();
  try {
    await database.query("begin");
    await requireKnownDemo(database);
    await database.query("set local session_replication_role = replica");
    await database.query(
      "delete from public.a2p_probe_receipts where tenant_id = $1 and probe_key = any($2::text[])",
      [DEMO_IDS.tenant, PHASE5_DEMO_VALUES.probeKeys],
    );
    await database.query(
      `delete from public.audit_log where tenant_id = $1 and (
         (action = 'tenant.went_live' and target_id = $1::text)
         or target_id = any($2::text[])
       )`,
      [DEMO_IDS.tenant, [PHASE5_DEMO_IDS.artifact, PHASE5_DEMO_IDS.flaggedScreen]],
    );
    await database.query(
      "delete from public.onboarding_content_screens where id = any($1::uuid[]) and tenant_id = $2",
      [[PHASE5_DEMO_IDS.cleanScreen, PHASE5_DEMO_IDS.flaggedScreen], DEMO_IDS.tenant],
    );
    await database.query(
      "delete from public.onboarding_optin_artifacts where id = $1 and tenant_id = $2",
      [PHASE5_DEMO_IDS.artifact, DEMO_IDS.tenant],
    );
    await database.query(
      "delete from public.business_profiles where id = $1 and tenant_id = $2",
      [PHASE5_DEMO_IDS.businessProfile, DEMO_IDS.tenant],
    );
    await database.query(
      "delete from public.brain_snapshots where id = $1 and payload ->> 'demoSeed' = 'phase5'",
      [PHASE5_DEMO_IDS.brainSnapshot],
    );
    await database.query(
      "delete from public.signup_intents where id = any($1::uuid[])",
      [[PHASE5_DEMO_IDS.completedIntent, PHASE5_DEMO_IDS.failedIntent]],
    );
    /*
     * The retired id only. This reset used to delete the tier row this seeder minted, and that row
     * is now a rung of the shared ladder owned by the phase 6 seeder and referenced by its seeded
     * subscriptions -- deleting it here would either fail on the foreign key or take another
     * seeder's rows with it. What is safe to remove is the row this seeder used to mint and no
     * longer writes.
     */
    await database.query("delete from public.tiers where id = $1", [RETIRED_DEMO_TIER_IDS.phase5]);
    await database.query(
      "delete from public.onboarding_runs where id = $1 and tenant_id = $2",
      [PHASE5_DEMO_IDS.onboardingRun, DEMO_IDS.tenant],
    );
    await database.query(
      "delete from public.provisioning_steps where tenant_id = $1 and step_key = any($2::public.provisioning_step[])",
      [DEMO_IDS.tenant, PHASE5_ONLY_STEPS],
    );
    await database.query(
      `update public.provisioning_steps set
         state = case step_key
           when 'test_pass' then 'pending'::public.provisioning_state
           when 'a2p_campaign' then 'awaiting_provider'::public.provisioning_state
           when 'sms_live' then 'pending'::public.provisioning_state
           when 'go_live' then 'pending'::public.provisioning_state
           else 'done'::public.provisioning_state end,
         awaiting_party = case when step_key = 'a2p_campaign' then 'carrier'::public.awaiting_party else null end,
         attempts = 0, started_at = null, last_attempt_at = null,
         completed_at = case when step_key in ('account','ghl_location','calendar_connect','offer_layer')
           then coalesce(completed_at, created_at) else null end,
         error_code = null, error_message = null, blocked_reason = null, external_ref = null,
         next_attempt_at = created_at, lease_expires_at = null, last_transition_at = created_at,
         attempt_id = null, updated_at = now()
       where tenant_id = $1`,
      [DEMO_IDS.tenant],
    );
    await database.query("update public.tenants set status = 'active' where id = $1", [DEMO_IDS.tenant]);
    await database.query(
      `update public.calendar_connections set last_slot_fetch_at = null, last_slot_fetch_ok = null,
         last_error = null where id = $1 and tenant_id = $2`,
      [DEMO_IDS.calendar, DEMO_IDS.tenant],
    );
    await database.query("commit");
  } catch (error) {
    await database.query("rollback");
    throw error;
  } finally {
    await database.end();
  }

  console.log("Phase 5 reset read-back: phase5_rows=0 lower_demo=preserved immutable_production_contract=unchanged");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  resetPhase5Demo().catch((error) => {
    console.error(error instanceof Error ? error.message : "PHASE5_DEMO_RESET_FAILED");
    process.exitCode = 1;
  });
}
