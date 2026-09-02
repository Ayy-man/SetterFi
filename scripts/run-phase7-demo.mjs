/** Read-only fixed-scope verifier for the synthetic Phase 7 measurement seed. */

import { pathToFileURL } from "node:url";

import pg from "pg";

import { resolveDemoTarget } from "./seed-phase1-demo.mjs";
import { PHASE7_DEMO_IDS, PHASE7_DEMO_VALUES } from "./seed-phase7-demo.mjs";
import { SHOWCASE_LEADS_SQL_PATTERN } from "./fixtures/showcase-leads-namespace.mjs";

function assert(condition, code, detail) {
  if (!condition) throw new Error(detail ? `${code}:${JSON.stringify(detail)}` : code);
}

/**
 * The six counts below are exact equalities against the Phase 7 fixture, so they have to be the
 * fixture's rows and only those. `seed-showcase-leads.mjs` writes two hundred contacts and their
 * threads onto this same tenant, additively and by design, and without this clause every one of
 * them reads as drift. Segregation is unaffected: the `not is_test` block further down still
 * counts every row on the tenant, showcase rows included, and still has to come back zero.
 */
const FIXTURE_ONLY = `id::text like '${SHOWCASE_LEADS_SQL_PATTERN}'`;

export async function verifyPhase7Demo({
  argumentsList = process.argv.slice(2),
  quiet = false,
} = {}) {
  const target = resolveDemoTarget(argumentsList);
  if (!target.databaseUrl) throw new Error("SUPABASE_DB_PASSWORD_REQUIRED_FOR_HOSTED_PHASE7_VERIFY");
  const database = new pg.Client({ connectionString: target.databaseUrl });
  await database.connect();
  try {
    const tenant = (await database.query(
      "select id,slug,is_demo from public.tenants where id=$1 or slug=$2",
      [PHASE7_DEMO_IDS.tenant, PHASE7_DEMO_VALUES.slug],
    )).rows;
    assert(tenant.length === 1 && tenant[0].id === PHASE7_DEMO_IDS.tenant
      && tenant[0].slug === PHASE7_DEMO_VALUES.slug && tenant[0].is_demo === true,
    "PHASE7_DEMO_TENANT_ANCESTRY_REFUSED", tenant);

    const counts = (await database.query(
      `select
        (select count(*)::int from public.contacts where tenant_id=$1 and not ${FIXTURE_ONLY}) contacts,
        (select count(*)::int from public.conversations where tenant_id=$1 and not ${FIXTURE_ONLY}) conversations,
        (select count(*)::int from public.messages where tenant_id=$1 and not ${FIXTURE_ONLY}) messages,
        (select count(*)::int from public.message_traces where tenant_id=$1) traces,
        (select count(*)::int from public.conversation_step_events
          where tenant_id=$1 and not ${FIXTURE_ONLY}) step_events,
        (select count(*)::int from public.contact_identities
          where tenant_id=$1 and not ${FIXTURE_ONLY}) identities,
        (select count(*)::int from public.followups where tenant_id=$1) followups,
        (select count(*)::int from public.appointments where tenant_id=$1 and not ${FIXTURE_ONLY}) appointments,
        (select count(*)::int from public.billable_events where tenant_id=$1) billables,
        (select count(*)::int from public.onboarding_runs where tenant_id=$1) onboarding_runs,
        (select count(*)::int from public.provisioning_steps where tenant_id=$1) provisioning_steps,
        (select count(distinct state)::int from public.provisioning_steps where tenant_id=$1) provisioning_states,
        (select count(distinct pipeline_stage)::int from public.contacts
          where tenant_id=$1 and test_session_id is null) pipeline_stages,
        (select count(*)::int from public.brain_knowledge_usage_events where tenant_id=$1) knowledge_usage,
        (select count(*)::int from public.brain_objection_usage_events where tenant_id=$1) objection_usage,
        (select count(*)::int from public.test_agent_sessions where tenant_id=$1) test_sessions,
        (select count(*)::int from public.model_configs where openrouter_model=$2
          and role='generator' and active=false) challengers,
        (select count(*)::int from public.eval_comparisons where case_set_hash=$3
          and status='completed') comparisons,
        (select count(*)::int from public.eval_runs run join public.eval_comparisons comparison
          on comparison.id=run.comparison_id where comparison.case_set_hash=$3) comparison_runs,
        (select count(*)::int from public.eval_case_results result join public.eval_runs run
          on run.id=result.run_id join public.eval_comparisons comparison
          on comparison.id=run.comparison_id where comparison.case_set_hash=$3) comparison_results,
        (select count(*)::int from public.eval_cases where source_tenant_id=$1 and notes=$4
          and suite='qualification_accuracy') promoted_cases`,
      [PHASE7_DEMO_IDS.tenant, PHASE7_DEMO_VALUES.challengerModel,
        PHASE7_DEMO_VALUES.comparisonCaseSet, PHASE7_DEMO_VALUES.promotionNotes],
    )).rows[0];
    const expected = {
      contacts: 8,
      conversations: 8,
      messages: 10,
      traces: 5,
      step_events: 4,
      identities: 2,
      followups: 3,
      appointments: 1,
      billables: 0,
      onboarding_runs: 1,
      provisioning_steps: 8,
      provisioning_states: 8,
      pipeline_stages: 7,
      knowledge_usage: 1,
      objection_usage: 3,
      test_sessions: 1,
      challengers: 1,
      comparisons: 1,
      comparison_runs: 2,
      comparison_results: 12,
      promoted_cases: 1,
    };
    assert(Object.entries(expected).every(([key, value]) => counts[key] === value),
      "PHASE7_DEMO_COUNT_MISMATCH", { expected, actual: counts });

    const segregation = (await database.query(
      `select
        (select count(*)::int from public.contacts where tenant_id=$1 and not is_test) contacts,
        (select count(*)::int from public.conversations where tenant_id=$1 and not is_test) conversations,
        (select count(*)::int from public.messages where tenant_id=$1 and not is_test) messages,
        (select count(*)::int from public.followups where tenant_id=$1 and not is_test) followups,
        (select count(*)::int from public.appointments where tenant_id=$1 and not is_test) appointments,
        (select count(*)::int from public.conversation_step_events where tenant_id=$1 and not is_test) steps,
        (select count(*)::int from public.brain_knowledge_usage_events where tenant_id=$1 and not is_test) knowledge,
        (select count(*)::int from public.brain_objection_usage_events where tenant_id=$1 and not is_test) objections,
        -- Every message on this tenant has to announce itself as synthetic. It used to do that
        -- with a raw SETTERFI_DEMO_PLACEHOLDER_ sentinel, which held the line on a local stack
        -- and turned the hosted demo into a database dump. The (demo) marker carries the same
        -- guarantee in copy a person can read.
        (select count(*)::int from public.messages where tenant_id=$1
          and body not like '%(demo)%') non_placeholder_messages,
        (select count(*)::int from public.contact_identities where tenant_id=$1
          and coalesce(consent_evidence,'{}'::jsonb)::text ~ '"approved"[[:space:]]*:[[:space:]]*true') approved_consent`,
      [PHASE7_DEMO_IDS.tenant],
    )).rows[0];
    assert(Object.values(segregation).every((value) => value === 0),
      "PHASE7_DEMO_SEGREGATION_FAILED", segregation);

    if (!quiet) console.log(`Phase 7 verifier: ${JSON.stringify(counts)} idempotent=true read_only=true`);
    return counts;
  } finally {
    await database.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyPhase7Demo().catch((error) => {
    console.error(error instanceof Error ? error.message : "PHASE7_DEMO_VERIFY_FAILED");
    process.exitCode = 1;
  });
}
