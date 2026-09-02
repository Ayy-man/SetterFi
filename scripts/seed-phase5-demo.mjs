/** Deterministic, credential-free Phase 5 extension of the guarded Phase 1/2 demo tenant. */

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import pg from "pg";

import { DEMO_IDS, DEMO_VALUES, resolveDemoTarget } from "./seed-phase1-demo.mjs";
import { PHASE2_DEMO_IDS } from "./seed-phase2-demo.mjs";
import {
  DEMO_FAIR_USE_NOTE,
  DEMO_TIER_LADDER,
  RETIRED_DEMO_TIER_IDS,
  assertUniqueDisplayNames,
} from "./fixtures/names.mjs";

// The uncapped top rung, named once so the signup evidence and the tier row cannot drift apart.
export const PHASE5_TIER_RUNG = DEMO_TIER_LADDER[DEMO_TIER_LADDER.length - 1];

export const PHASE5_DEMO_IDS = Object.freeze({
  businessProfile: "85000000-0000-4000-8000-000000000001",
  artifact: "85000000-0000-4000-8000-000000000002",
  cleanScreen: "85000000-0000-4000-8000-000000000003",
  flaggedScreen: "85000000-0000-4000-8000-000000000004",
  onboardingRun: "85000000-0000-4000-8000-000000000005",
  completedIntent: "85000000-0000-4000-8000-000000000006",
  completedAuthUser: "85000000-0000-4000-8000-000000000007",
  failedIntent: "85000000-0000-4000-8000-000000000008",
  failedAuthUser: "85000000-0000-4000-8000-000000000009",
  brainSnapshot: "85000000-0000-4000-8000-000000000010",
  tier: "85000000-0000-4000-8000-000000000011",
});

export const PHASE5_DEMO_VALUES = Object.freeze({
  artifactMarker: "SETTERFI_DEMO_PLACEHOLDER_PHASE5_CONSENT",
  termsMarker: "SETTERFI_DEMO_PLACEHOLDER_PHASE5_TERMS",
  privacyMarker: "SETTERFI_DEMO_PLACEHOLDER_PHASE5_PRIVACY",
  targetMarker: "SETTERFI_DEMO_PLACEHOLDER_A2P_PROBE_TARGET",
  submittedAt: "2026-08-12T00:00:00.000Z",
  probeKeys: Object.freeze([
    "phase5-demo:terminal-blocked",
    "phase5-demo:delivered",
    "phase5-demo:registering",
  ]),
});

export const PHASE5_STEP_STATES = Object.freeze({
  account: "done",
  billing: "awaiting_platform",
  ghl_location: "done",
  ghl_snapshot: "done",
  phone_number: "done",
  sms_eligibility_screen: "done",
  business_profile: "done",
  optin_artifact: "done",
  a2p_brand: "done",
  a2p_campaign: "awaiting_provider",
  sms_live: "awaiting_provider",
  meta_connect: "done",
  whatsapp_connect: "blocked",
  calendar_connect: "done",
  offer_layer: "done",
  test_pass: "done",
  go_live: "done",
});

const COMPLETE_STEPS = new Set(
  Object.entries(PHASE5_STEP_STATES).filter(([, state]) => state === "done").map(([key]) => key),
);

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function requireKnownDemo(database) {
  const tenant = (await database.query(
    "select id, slug, is_demo from public.tenants where id = $1",
    [DEMO_IDS.tenant],
  )).rows[0];
  if (!tenant || tenant.id !== DEMO_IDS.tenant || tenant.slug !== DEMO_VALUES.slug || tenant.is_demo !== true) {
    throw new Error("PHASE5_DEMO_TENANT_ANCESTRY_REFUSED");
  }
}

async function ensurePhase5CompatibleBaseline(target) {
  if (!target.databaseUrl) throw new Error("SUPABASE_DB_PASSWORD_REQUIRED_FOR_HOSTED_PHASE5_SEED");
  const database = new pg.Client({ connectionString: target.databaseUrl });
  await database.connect();
  try {
    await database.query("begin");
    await requireKnownDemo(database);
    const baseline = [
      ["account", "done", null],
      ["ghl_location", "done", null],
      ["calendar_connect", "done", null],
      ["offer_layer", "done", null],
      ["test_pass", "pending", null],
      ["a2p_campaign", "awaiting_provider", "carrier"],
      ["sms_live", "pending", null],
      ["go_live", "pending", null],
    ];
    for (const [stepKey, state, awaitingParty] of baseline) {
      await database.query(
        `insert into public.provisioning_steps (
           tenant_id, step_key, state, awaiting_party, completed_at,
           next_attempt_at, last_transition_at, idempotency_key
         ) values (
           $1::uuid, $2::public.provisioning_step, $3::public.provisioning_state,
           $4::public.awaiting_party, case when $3::text = 'done' then $5::timestamptz else null end,
           $5, $5, $1::uuid::text || ':' || $2::text
         ) on conflict (tenant_id, step_key) do nothing`,
        [DEMO_IDS.tenant, stepKey, state, awaitingParty, "2026-08-17T00:00:00.000Z"],
      );
    }
    await database.query("commit");
  } catch (error) {
    await database.query("rollback");
    throw error;
  } finally {
    await database.end();
  }
}

async function requireLowerDemo(target) {
  await ensurePhase5CompatibleBaseline(target);
  const database = new pg.Client({ connectionString: target.databaseUrl });
  await database.connect();
  try {
    await requireKnownDemo(database);
    const result = (await database.query(
      `select
         exists(select 1 from public.users where id = $1) coach,
         exists(select 1 from public.calendar_connections where id = $2 and tenant_id = $3) calendar,
         exists(select 1 from public.channel_connections where id = $4 and tenant_id = $3) meta,
         exists(select 1 from public.offer_layers where tenant_id = $3 and status = 'published') offer`,
      [DEMO_IDS.coach, DEMO_IDS.calendar, DEMO_IDS.tenant, DEMO_IDS.instagramMetaConnection],
    )).rows[0];
    if (!result.coach || !result.calendar || !result.meta || !result.offer) {
      throw new Error("PHASE1_PHASE2_DEMO_BASELINE_REQUIRED");
    }
    const contacts = (await database.query(
      `select name from public.contacts
       where tenant_id=$1 and merged_into_contact_id is null order by id`,
      [DEMO_IDS.tenant],
    )).rows;
    assertUniqueDisplayNames(
      contacts.map((contact) => contact.name ?? ""),
      "PHASE5_DEMO_CONTACT_DISPLAY_NAMES_NOT_UNIQUE",
    );
    if (contacts.some((contact) => /^(demo|test|synthetic|setterfi)\b/i.test(contact.name ?? ""))) {
      throw new Error("PHASE5_DEMO_CONTACT_STATE_NAME_VISIBLE");
    }
  } finally {
    await database.end();
  }
}

async function seedBrainEvidence(database, now) {
  const payload = {
    demoSeed: "phase5",
    labelled: true,
    source: "SETTERFI_DEMO_PLACEHOLDER_PHASE5_BRAIN",
  };
  const payloadText = JSON.stringify(payload);
  const contentHash = hash(payloadText);
  const nextVersion = Number((await database.query(
    "select coalesce(max(version), 0) + 1 next_version from public.brain_snapshots",
  )).rows[0].next_version);
  await database.query(
    `insert into public.brain_snapshots (
       id, version, content_hash, source_hash, payload, compiled_platform, platform_tokens,
       knowledge_mode, eval_run_id, rollback_of_snapshot_id, published_by, reason, published_at
     ) values ($1, $2, $3, $3, $4::jsonb, 'SETTERFI_DEMO_PLACEHOLDER_PHASE5_BRAIN', 1,
       'inline', null, null, $5, 'Synthetic Phase 5 readiness fixture', $6)
     on conflict (id) do nothing`,
    [PHASE5_DEMO_IDS.brainSnapshot, nextVersion, contentHash, payloadText, PHASE2_DEMO_IDS.admin, now],
  );
}

async function seedArtifact(database) {
  const marketing = `${PHASE5_DEMO_VALUES.artifactMarker}_MARKETING`;
  const nonMarketing = `${PHASE5_DEMO_VALUES.artifactMarker}_NON_MARKETING`;
  const campaign = `${PHASE5_DEMO_VALUES.artifactMarker}_CAMPAIGN`;
  const terms = PHASE5_DEMO_VALUES.termsMarker;
  const privacy = PHASE5_DEMO_VALUES.privacyMarker;
  const artifactHash = hash(JSON.stringify({ marketing, nonMarketing, campaign, terms, privacy }));
  await database.query(
    `insert into public.onboarding_optin_artifacts (
       id, tenant_id, version, template_version, marketing_language, marketing_language_hash,
       non_marketing_language, non_marketing_language_hash, terms_url, privacy_url,
       campaign_description, campaign_description_hash, artifact_hash, placeholder, is_current,
       terms_body, terms_body_hash, privacy_body, privacy_body_hash
     ) values (
       $1, $2, 1, 'SETTERFI_DEMO_PLACEHOLDER_PHASE5_TEMPLATE_V1', $3, $4, $5, $6,
       'https://example.invalid/phase5-demo/terms', 'https://example.invalid/phase5-demo/privacy',
       $7, $8, $9, true, true, $10, $11, $12, $13
     ) on conflict (id) do update set
       template_version = excluded.template_version,
       marketing_language = excluded.marketing_language,
       marketing_language_hash = excluded.marketing_language_hash,
       non_marketing_language = excluded.non_marketing_language,
       non_marketing_language_hash = excluded.non_marketing_language_hash,
       terms_url = excluded.terms_url,
       privacy_url = excluded.privacy_url,
       campaign_description = excluded.campaign_description,
       campaign_description_hash = excluded.campaign_description_hash,
       artifact_hash = excluded.artifact_hash,
       placeholder = true,
       is_current = true,
       terms_body = excluded.terms_body,
       terms_body_hash = excluded.terms_body_hash,
       privacy_body = excluded.privacy_body,
       privacy_body_hash = excluded.privacy_body_hash`,
    [
      PHASE5_DEMO_IDS.artifact,
      DEMO_IDS.tenant,
      marketing,
      hash(marketing),
      nonMarketing,
      hash(nonMarketing),
      campaign,
      hash(campaign),
      artifactHash,
      terms,
      hash(terms),
      privacy,
      hash(privacy),
    ],
  );
  await database.query(
    "select public.confirm_onboarding_artifact($1, $2, $3)",
    [DEMO_IDS.tenant, PHASE5_DEMO_IDS.artifact, DEMO_IDS.coach],
  );
}

async function seedContentScreens(database) {
  const cleanHash = hash("SETTERFI_DEMO_PLACEHOLDER_PHASE5_CLEAN_SCREEN");
  const flaggedHash = hash("SETTERFI_DEMO_PLACEHOLDER_PHASE5_FLAGGED_SCREEN");
  await database.query(
    `insert into public.onboarding_content_screens
       (id, tenant_id, input_hash, result, matches, is_current)
     values ($1, $2, $3, 'clean', '[]'::jsonb, false)
     on conflict (id) do update set input_hash = excluded.input_hash, result = 'clean',
       matches = '[]'::jsonb, is_current = false`,
    [PHASE5_DEMO_IDS.cleanScreen, DEMO_IDS.tenant, cleanHash],
  );
  await database.query(
    `insert into public.onboarding_content_screens
       (id, tenant_id, input_hash, result, matches, is_current)
     values ($1, $2, $3, 'flagged', $4::jsonb, true)
     on conflict (id) do update set input_hash = excluded.input_hash, result = 'flagged',
       matches = excluded.matches, is_current = true`,
    [
      PHASE5_DEMO_IDS.flaggedScreen,
      DEMO_IDS.tenant,
      flaggedHash,
      JSON.stringify([{ phrase: "guaranteed funding", page: "https://example.invalid/phase5-demo" }]),
    ],
  );
  await database.query(
    "select public.acknowledge_onboarding_content_screen($1, $2, $3)",
    [DEMO_IDS.tenant, PHASE5_DEMO_IDS.flaggedScreen, DEMO_IDS.coach],
  );
  await database.query(
    "select public.confirm_onboarding_content_screen($1, $2, $3)",
    [DEMO_IDS.tenant, PHASE5_DEMO_IDS.flaggedScreen, PHASE2_DEMO_IDS.admin],
  );
}

async function seedSignupEvidence(database) {
  await database.query(
    /*
     * The ladder's top rung, upserted against the ladder's own id rather than a fifth tier row of
     * this seeder's own. It used to mint `PHASE5_DEMO_IDS.tier` carrying an invented $2,497 rung
     * that existed only so three seeders could avoid duplicate names; the ladder is now the
     * client's three contracted tiers and there is no fifth price to give a row. Upserting is still
     * enough to run this seeder alone -- it writes the row it then references.
     *
     * The Stripe price id stays out of the update set entirely, rather than being written as null:
     * this row is signup evidence and this seeder has no checkout price to assert, but phase 6 owns
     * a real price id on the same row now, and writing null here would strip it on whichever
     * seeder ran last.
     */
    `insert into public.tiers
       (id, name, price_cents, call_allowance, fair_use_cap, is_uncapped, stripe_price_id, active,
        fair_use_note)
     values ($1, $2, $3, $4, $5, $6, null, true, $7)
     on conflict (id) do update set name = excluded.name, price_cents = excluded.price_cents,
       call_allowance = excluded.call_allowance, fair_use_cap = excluded.fair_use_cap,
       is_uncapped = excluded.is_uncapped, active = true, fair_use_note = excluded.fair_use_note`,
    [
      PHASE5_TIER_RUNG.id,
      PHASE5_TIER_RUNG.name,
      PHASE5_TIER_RUNG.priceCents,
      PHASE5_TIER_RUNG.callAllowance,
      PHASE5_TIER_RUNG.fairUseCap,
      PHASE5_TIER_RUNG.isUncapped,
      DEMO_FAIR_USE_NOTE,
    ],
  );
  /*
   * The row this seeder used to mint. A database seeded before the collapse still holds it with its
   * old name and its invented price, and a stale priced row on Plans and pricing is the whole
   * defect being fixed -- so it is retired here rather than left to be noticed. Deactivated, not
   * deleted: `signup_intents.tier_id` references it on exactly those databases.
   */
  await database.query(
    "update public.tiers set active = false where id = $1",
    [RETIRED_DEMO_TIER_IDS.phase5],
  );
  await database.query(
    `insert into public.signup_intents
       (id, auth_user_id, email, tenant_id, tier_id, timezone, state, error)
     values ($1, $2, 'phase5-completed@example.invalid', $3, $4, 'America/New_York', 'completed', null)
     on conflict (id) do update set tenant_id = excluded.tenant_id, tier_id = excluded.tier_id,
       timezone = excluded.timezone, state = 'completed', error = null`,
    [PHASE5_DEMO_IDS.completedIntent, PHASE5_DEMO_IDS.completedAuthUser, DEMO_IDS.tenant, PHASE5_TIER_RUNG.id],
  );
  await database.query(
    `insert into public.signup_intents
       (id, auth_user_id, email, tenant_id, tier_id, timezone, state, error)
     values ($1, $2, 'phase5-failed@example.invalid', null, $3, 'America/New_York', 'failed',
       'SETTERFI_DEMO_PLACEHOLDER_SIGNUP_FAILED')
     on conflict (id) do update set tenant_id = null, tier_id = excluded.tier_id,
       timezone = excluded.timezone, state = 'failed', error = excluded.error`,
    [PHASE5_DEMO_IDS.failedIntent, PHASE5_DEMO_IDS.failedAuthUser, PHASE5_TIER_RUNG.id],
  );
}

async function seedSteps(database, now) {
  for (const [stepKey, state] of Object.entries(PHASE5_STEP_STATES)) {
    const done = COMPLETE_STEPS.has(stepKey);
    const awaitingParty = state === "awaiting_provider" ? "carrier" : null;
    const blockedReason = state === "blocked"
      // Coach-facing copy on the checklist. The carrier decision code beside it stays a real code.
      ? "The carrier turned this registration down. Support is refiling it. (demo)"
      : null;
    const errorCode = stepKey === "billing"
      ? "subscription_contract_unavailable"
      : state === "blocked"
        ? "A2P_TERMINAL_REJECTION"
        : null;
    const externalRef = stepKey === "a2p_campaign"
      ? { arm: "mock", demoOnly: true, submittedAt: PHASE5_DEMO_VALUES.submittedAt }
      : { arm: "mock", demoOnly: true, fixture: `phase5:${stepKey}` };
    await database.query(
      `insert into public.provisioning_steps (
         tenant_id, step_key, state, awaiting_party, attempts, started_at, last_attempt_at,
         completed_at, error_code, error_message, blocked_reason, external_ref,
         next_attempt_at, lease_expires_at, last_transition_at, attempt_id, idempotency_key
       ) values (
         $1::uuid, $2::public.provisioning_step, $3::public.provisioning_state,
         $4::public.awaiting_party, 1, $5, $5, $6, $7, null, $8, $9::jsonb,
         $5, null, $5, null, $1::uuid::text || ':' || $2::text
       ) on conflict (tenant_id, step_key) do update set
         state = excluded.state, awaiting_party = excluded.awaiting_party, attempts = excluded.attempts,
         started_at = excluded.started_at, last_attempt_at = excluded.last_attempt_at,
         completed_at = excluded.completed_at, error_code = excluded.error_code,
         error_message = null, blocked_reason = excluded.blocked_reason,
         external_ref = excluded.external_ref, next_attempt_at = excluded.next_attempt_at,
         lease_expires_at = null, last_transition_at = excluded.last_transition_at,
         attempt_id = null, idempotency_key = excluded.idempotency_key`,
      [
        DEMO_IDS.tenant,
        stepKey,
        state,
        awaitingParty,
        now,
        done ? now : null,
        errorCode,
        blockedReason,
        JSON.stringify(externalRef),
      ],
    );
  }
}

async function seedProbes(database) {
  const targetHash = hash(PHASE5_DEMO_VALUES.targetMarker);
  const probes = [
    [PHASE5_DEMO_VALUES.probeKeys[0], "terminal_rejection", "SETTERFI_DEMO_PLACEHOLDER_TERMINAL_REF", "A2P_TERMINAL_REJECTION", "2026-08-13T00:00:00.000Z"],
    [PHASE5_DEMO_VALUES.probeKeys[1], "delivered", "SETTERFI_DEMO_PLACEHOLDER_DELIVERED_REF", "DELIVERED", "2026-08-14T00:00:00.000Z"],
    [PHASE5_DEMO_VALUES.probeKeys[2], "inconclusive", null, "SETTERFI_DEMO_PLACEHOLDER_REGISTERING", "2026-08-15T00:00:00.000Z"],
  ];
  for (const [probeKey, result, providerReference, providerCode, observedAt] of probes) {
    await database.query(
      "select public.record_a2p_probe_receipt($1, $2, $3, $4, $5, $6, $7)",
      [DEMO_IDS.tenant, probeKey, targetHash, result, providerReference, providerCode, observedAt],
    );
  }
}

async function seedGoLive(database, now) {
  const prior = (await database.query(
    `select id, created_at from public.audit_log
     where action = 'tenant.went_live' and tenant_id = $1 and target_id = $1::text
     order by id limit 1`,
    [DEMO_IDS.tenant],
  )).rows[0];
  if (prior) {
    await database.query(
      `update public.onboarding_runs set readiness_met_at = coalesce(readiness_met_at, $2),
         went_live_at = coalesce(went_live_at, $2) where id = $1`,
      [PHASE5_DEMO_IDS.onboardingRun, prior.created_at],
    );
    await database.query("update public.tenants set status = 'active' where id = $1", [DEMO_IDS.tenant]);
    return String(prior.id);
  }
  await database.query("update public.tenants set status = 'onboarding' where id = $1", [DEMO_IDS.tenant]);
  const receipt = (await database.query(
    "select * from public.go_live_onboarding($1, $2, true, $3, 'trialing', $3)",
    [DEMO_IDS.tenant, DEMO_IDS.coach, now],
  )).rows[0];
  return String(receipt.audit_id);
}

async function readBack(database) {
  const counts = (await database.query(
    `select
       (select count(*)::int from public.provisioning_steps where tenant_id = $1) steps,
       (select count(*)::int from public.onboarding_optin_artifacts where id = $2 and placeholder and confirmed_at is not null) artifacts,
       (select count(*)::int from public.onboarding_content_screens where id = any($3::uuid[])) screens,
       (select count(*)::int from public.a2p_probe_receipts where tenant_id = $1 and probe_key = any($4::text[])) probes,
       (select count(*)::int from public.signup_intents where id = any($5::uuid[])) intents`,
    [
      DEMO_IDS.tenant,
      PHASE5_DEMO_IDS.artifact,
      [PHASE5_DEMO_IDS.cleanScreen, PHASE5_DEMO_IDS.flaggedScreen],
      PHASE5_DEMO_VALUES.probeKeys,
      [PHASE5_DEMO_IDS.completedIntent, PHASE5_DEMO_IDS.failedIntent],
    ],
  )).rows[0];
  if (counts.steps !== 17 || counts.artifacts !== 1 || counts.screens !== 2 || counts.probes !== 3 || counts.intents !== 2) {
    throw new Error(`PHASE5_DEMO_READBACK_INVALID:${JSON.stringify(counts)}`);
  }
  return counts;
}

export async function seedPhase5Demo({ argumentsList = process.argv.slice(2) } = {}) {
  const target = resolveDemoTarget(argumentsList);
  console.log(`Demo database target host: ${target.host}`);
  await requireLowerDemo(target);
  const database = new pg.Client({ connectionString: target.databaseUrl });
  await database.connect();
  try {
    await database.query("begin");
    await requireKnownDemo(database);
    const existingRun = (await database.query(
      "select started_at from public.onboarding_runs where id = $1",
      [PHASE5_DEMO_IDS.onboardingRun],
    )).rows[0];
    const now = existingRun?.started_at ?? new Date().toISOString();
    await database.query(
      `insert into public.users (id, email, full_name, role, tenant_id)
       values ($1, 'phase2-admin@example.invalid', 'Synthetic Phase 2 admin', 'admin', null)
       on conflict (id) do update set role = 'admin', tenant_id = null`,
      [PHASE2_DEMO_IDS.admin],
    );
    await seedBrainEvidence(database, now);
    await database.query(
      `insert into public.business_profiles
         (id, tenant_id, legal_name, entity_type, has_ein, website_url, address_line1,
          address_line2, city, region, postal_code, country_code)
       values ($1, $2, 'SETTERFI_DEMO_PLACEHOLDER_PHASE5_BUSINESS', 'llc', true,
         'https://example.invalid/phase5-demo', 'SETTERFI_DEMO_PLACEHOLDER_ADDRESS', null,
         'Example City', 'EX', '00000', 'US')
       on conflict (id) do update set legal_name = excluded.legal_name,
         website_url = excluded.website_url, address_line1 = excluded.address_line1`,
      [PHASE5_DEMO_IDS.businessProfile, DEMO_IDS.tenant],
    );
    await seedArtifact(database);
    await seedContentScreens(database);
    await seedSignupEvidence(database);
    await database.query(
      `insert into public.onboarding_runs (id, tenant_id, started_at)
       values ($1, $2, $3) on conflict (id) do nothing`,
      [PHASE5_DEMO_IDS.onboardingRun, DEMO_IDS.tenant, now],
    );
    await seedSteps(database, now);
    await database.query(
      `update public.channel_connections set state = 'ready', updated_at = $2
       where id = $1 and tenant_id = $3`,
      [DEMO_IDS.smsGhlConnection, now, DEMO_IDS.tenant],
    );
    await database.query(
      `update public.calendar_connections set state = 'ready', last_slot_fetch_at = $2,
         last_slot_fetch_ok = true, last_error = null, updated_at = $2
       where id = $1 and tenant_id = $3`,
      [DEMO_IDS.calendar, now, DEMO_IDS.tenant],
    );
    await seedProbes(database);
    const auditId = await seedGoLive(database, now);
    const counts = await readBack(database);
    await database.query("commit");
    console.log(`Phase 5 seed read-back: steps=${counts.steps} artifacts=${counts.artifacts}:placeholder-confirmed screens=${counts.screens} probes=${counts.probes} intents=${counts.intents} go_live_audit=${auditId} provider_proof=mock-only`);
    return { counts, auditId };
  } catch (error) {
    await database.query("rollback");
    throw error;
  } finally {
    await database.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedPhase5Demo().catch((error) => {
    console.error(error instanceof Error ? error.message : "PHASE5_DEMO_SEED_FAILED");
    process.exitCode = 1;
  });
}
