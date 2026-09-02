/** Read-only exact-set contract for the Phase 5 demo extension. */

import { pathToFileURL } from "node:url";

import pg from "pg";

import { DEMO_IDS, DEMO_VALUES, resolveDemoTarget } from "./seed-phase1-demo.mjs";
import { PHASE5_DEMO_IDS, PHASE5_DEMO_VALUES, PHASE5_STEP_STATES, PHASE5_TIER_RUNG } from "./seed-phase5-demo.mjs";
import { assertUniqueDisplayNames } from "./fixtures/names.mjs";

function argumentValue(argumentsList, name) {
  const prefix = `${name}=`;
  return argumentsList.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

export async function readPhase5DemoContract({ argumentsList = process.argv.slice(2) } = {}) {
  const target = resolveDemoTarget(argumentsList);
  if (!target.databaseUrl) throw new Error("SUPABASE_DB_PASSWORD_REQUIRED_FOR_HOSTED_PHASE5_CONTRACT");
  const database = new pg.Client({ connectionString: target.databaseUrl });
  await database.connect();
  try {
    const tenant = await database.query("select id, slug, status, is_demo from public.tenants where id = $1", [DEMO_IDS.tenant]);
    const steps = await database.query("select step_key, state, awaiting_party, error_code, blocked_reason, external_ref, completed_at from public.provisioning_steps where tenant_id = $1 order by step_key", [DEMO_IDS.tenant]);
    const artifact = await database.query("select id, placeholder, confirmed_at, template_version, marketing_language, terms_body, privacy_body from public.onboarding_optin_artifacts where id = $1 and tenant_id = $2", [PHASE5_DEMO_IDS.artifact, DEMO_IDS.tenant]);
    const screens = await database.query("select id, result, matches, is_current, acknowledged_at, admin_confirmed_at from public.onboarding_content_screens where id = any($1::uuid[]) order by id", [[PHASE5_DEMO_IDS.cleanScreen, PHASE5_DEMO_IDS.flaggedScreen]]);
    const probes = await database.query("select probe_key, result, provider_reference, provider_code from public.a2p_probe_receipts where tenant_id = $1 and probe_key = any($2::text[]) order by probe_key", [DEMO_IDS.tenant, PHASE5_DEMO_VALUES.probeKeys]);
    const intents = await database.query("select id, tenant_id, state, error from public.signup_intents where id = any($1::uuid[]) order by id", [[PHASE5_DEMO_IDS.completedIntent, PHASE5_DEMO_IDS.failedIntent]]);
    const run = await database.query("select id, tenant_id, readiness_met_at, went_live_at from public.onboarding_runs where id = $1", [PHASE5_DEMO_IDS.onboardingRun]);
    const profile = await database.query("select id, legal_name, website_url from public.business_profiles where id = $1 and tenant_id = $2", [PHASE5_DEMO_IDS.businessProfile, DEMO_IDS.tenant]);
    const connections = await database.query("select id, provider, channel, state from public.channel_connections where id = any($1::uuid[]) order by id", [[DEMO_IDS.instagramGhlConnection, DEMO_IDS.instagramMetaConnection, DEMO_IDS.smsGhlConnection]]);
    const calendar = await database.query("select id, state, last_slot_fetch_ok, last_slot_fetch_at from public.calendar_connections where id = $1 and tenant_id = $2", [DEMO_IDS.calendar, DEMO_IDS.tenant]);
    const audits = await database.query("select action, target_id from public.audit_log where tenant_id = $1 and (target_id = $1::text or target_id = any($2::text[])) order by action, target_id", [DEMO_IDS.tenant, [PHASE5_DEMO_IDS.artifact, PHASE5_DEMO_IDS.flaggedScreen]]);
    const brain = await database.query("select id, payload, compiled_platform from public.brain_snapshots where id = $1", [PHASE5_DEMO_IDS.brainSnapshot]);
    // The ladder's top rung, which this seeder upserts and both of its signup intents reference.
    // It used to be this seeder's own fifth tier row; the ladder is now the client's three
    // contracted tiers and there is no fifth price to give a row.
    const tier = await database.query("select id, name, active from public.tiers where id = $1", [PHASE5_TIER_RUNG.id]);
    const contacts = await database.query("select id, name from public.contacts where tenant_id = $1 order by id", [DEMO_IDS.tenant]);
    const signupCatalog = await database.query("select id, label from public.list_signup_tier_catalog() order by lower(label), id");
    return {
      tenant: tenant.rows[0] ?? null,
      steps: steps.rows,
      artifact: artifact.rows[0] ?? null,
      screens: screens.rows,
      probes: probes.rows,
      intents: intents.rows,
      run: run.rows[0] ?? null,
      profile: profile.rows[0] ?? null,
      connections: connections.rows,
      calendar: calendar.rows[0] ?? null,
      audits: audits.rows,
      brain: brain.rows[0] ?? null,
      tier: tier.rows[0] ?? null,
      contacts: contacts.rows,
      signupCatalog: signupCatalog.rows,
    };
  } finally {
    await database.end();
  }
}

export function assertPhase5Seeded(snapshot) {
  assert(snapshot.tenant?.id === DEMO_IDS.tenant && snapshot.tenant.slug === DEMO_VALUES.slug, "PHASE5_CONTRACT_TENANT_MISSING");
  assert(snapshot.tenant.is_demo === true && snapshot.tenant.status === "active", "PHASE5_CONTRACT_TENANT_NOT_ACTIVE_DEMO");
  assert(snapshot.steps.length === 17, "PHASE5_CONTRACT_STEP_COUNT_INVALID");
  const states = Object.fromEntries(snapshot.steps.map((row) => [row.step_key, row.state]));
  assert(Object.entries(PHASE5_STEP_STATES).every(([key, state]) => states[key] === state), "PHASE5_CONTRACT_STEP_STATES_INVALID");
  assert(snapshot.steps.every((row) => row.external_ref?.arm === "mock" && row.external_ref?.demoOnly === true), "PHASE5_CONTRACT_PROVIDER_PROOF_NOT_MOCK");
  assert(snapshot.artifact?.placeholder === true && snapshot.artifact.confirmed_at, "PHASE5_CONTRACT_PLACEHOLDER_ARTIFACT_INVALID");
  assert([snapshot.artifact.template_version, snapshot.artifact.marketing_language, snapshot.artifact.terms_body, snapshot.artifact.privacy_body].every((value) => value?.startsWith("SETTERFI_DEMO_PLACEHOLDER_")), "PHASE5_CONTRACT_PLACEHOLDER_MARKER_MISSING");
  assert(snapshot.screens.length === 2 && snapshot.screens[0].result === "clean" && snapshot.screens[0].is_current === false, "PHASE5_CONTRACT_CLEAN_SCREEN_INVALID");
  assert(snapshot.screens[1].result === "flagged" && snapshot.screens[1].is_current === true && snapshot.screens[1].acknowledged_at && snapshot.screens[1].admin_confirmed_at, "PHASE5_CONTRACT_FLAGGED_SCREEN_INVALID");
  assert(snapshot.probes.length === 3 && snapshot.probes.map((row) => row.result).sort().join(",") === "delivered,inconclusive,terminal_rejection", "PHASE5_CONTRACT_PROBE_SCENARIOS_INVALID");
  assert(snapshot.intents.length === 2 && snapshot.intents.some((row) => row.id === PHASE5_DEMO_IDS.failedIntent && row.tenant_id === null && row.state === "failed"), "PHASE5_CONTRACT_TENANTLESS_FAILURE_INVALID");
  assert(snapshot.run?.went_live_at && snapshot.run.readiness_met_at, "PHASE5_CONTRACT_GO_LIVE_MISSING");
  assert(snapshot.profile?.legal_name.startsWith("SETTERFI_DEMO_PLACEHOLDER_"), "PHASE5_CONTRACT_PROFILE_NOT_SYNTHETIC");
  assert(snapshot.brain?.payload?.demoSeed === "phase5" && snapshot.brain.compiled_platform.startsWith("SETTERFI_DEMO_PLACEHOLDER_"), "PHASE5_CONTRACT_BRAIN_NOT_SYNTHETIC");
  assert(snapshot.tier?.active === true && !snapshot.tier.name.startsWith("SETTERFI_DEMO_PLACEHOLDER_"), "PHASE5_CONTRACT_TIER_LABEL_INVALID");
  assertUniqueDisplayNames(
    snapshot.contacts.map((contact) => contact.name ?? ""),
    "PHASE5_CONTRACT_CONTACT_DISPLAY_NAMES_NOT_UNIQUE",
  );
  assert(snapshot.signupCatalog.length > 0 && snapshot.signupCatalog.every((row) =>
    typeof row.label === "string" && row.label.trim().length > 0
      && !row.label.startsWith("SETTERFI_DEMO_PLACEHOLDER_")),
  "PHASE5_CONTRACT_SIGNUP_CATALOG_LABEL_INVALID");
  const byConnection = Object.fromEntries(snapshot.connections.map((row) => [row.id, row]));
  assert(byConnection[DEMO_IDS.instagramMetaConnection]?.state === "ready", "PHASE5_CONTRACT_META_NOT_READY");
  assert(byConnection[DEMO_IDS.smsGhlConnection]?.state === "ready", "PHASE5_CONTRACT_SMS_CONNECTION_NOT_HELD");
  assert(snapshot.calendar?.state === "ready" && snapshot.calendar.last_slot_fetch_ok === true && snapshot.calendar.last_slot_fetch_at, "PHASE5_CONTRACT_CALENDAR_NOT_HEALTHY");
  assert(snapshot.audits.some((row) => row.action === "tenant.went_live"), "PHASE5_CONTRACT_GO_LIVE_AUDIT_MISSING");
  return snapshot;
}

export function assertPhase5Reset(snapshot) {
  assert(snapshot.tenant?.is_demo === true && snapshot.tenant.status === "active", "PHASE5_RESET_CONTRACT_TENANT_INVALID");
  assert(snapshot.artifact === null && snapshot.screens.length === 0 && snapshot.probes.length === 0, "PHASE5_RESET_CONTRACT_EVIDENCE_REMAINS");
  assert(snapshot.intents.length === 0 && snapshot.run === null && snapshot.profile === null, "PHASE5_RESET_CONTRACT_ROWS_REMAIN");
  assert(snapshot.brain === null, "PHASE5_RESET_CONTRACT_BRAIN_REMAINS");
  assert(snapshot.tier === null, "PHASE5_RESET_CONTRACT_TIER_REMAINS");
  assert(snapshot.audits.length === 0, "PHASE5_RESET_CONTRACT_AUDITS_REMAIN");
  assert(snapshot.steps.length === 8, "PHASE5_RESET_CONTRACT_LOWER_STEPS_INVALID");
  return snapshot;
}

export async function runPhase5DemoContract({ argumentsList = process.argv.slice(2) } = {}) {
  const expected = argumentValue(argumentsList, "--expect") ?? "seeded";
  const snapshot = await readPhase5DemoContract({ argumentsList });
  if (expected === "seeded") assertPhase5Seeded(snapshot);
  else if (expected === "reset") assertPhase5Reset(snapshot);
  else throw new Error(`PHASE5_DEMO_EXPECTATION_INVALID:${expected}`);
  console.log(`Phase 5 demo contract: ${expected} PASS steps=${snapshot.steps.length} provider_proof=mock-only`);
  return snapshot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPhase5DemoContract().catch((error) => {
    console.error(error instanceof Error ? error.message : "PHASE5_DEMO_CONTRACT_FAILED");
    process.exitCode = 1;
  });
}
