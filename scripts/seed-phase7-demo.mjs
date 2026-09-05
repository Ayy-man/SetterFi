/** Deterministic, synthetic Phase 7 measurement evidence on one labelled demo tenant. */

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import pg from "pg";

import { DEMO_IDS, resolveDemoTarget } from "./seed-phase1-demo.mjs";
import { PHASE2_DEMO_IDS } from "./seed-phase2-demo.mjs";
import { PHASE6_DEMO_IDS, PHASE6_DEMO_VALUES } from "./seed-phase6-demo.mjs";
import {
  DEMO_MEASUREMENT_COPY,
  DEMO_SUPPORT_TENANT_NAMES,
  LEAD_NAMES,
  assertUniqueDisplayNames,
} from "./fixtures/names.mjs";
import { isShowcaseLeadId } from "./fixtures/showcase-leads-namespace.mjs";

const PHASE2_ADMIN_ID = PHASE2_DEMO_IDS.admin;
const ACTIVE_GENERATOR_ID = "10000000-0000-4000-8000-000000000001";

/*
 * The demo clock.
 *
 * Every row here used to carry an absolute June 2026 timestamp. That was deterministic and it was
 * also a slow-acting bug: coach Home defaults to a one-month window, so from July onwards the seed
 * put nothing inside it, `metricAvailability` fell through to `needs_more_history`, and seven of
 * the eight figures on the screen printed "not yet" over a day counter. The honest-states
 * machinery was working perfectly; it was being handed a dataset with no recent rows, and the
 * client read the result as a broken product on 2026-08-31.
 *
 * So the fixture keeps its shape and loses its absolute position: `demoDay(n)` is day n of a
 * twelve-day story that always ends about a fortnight before the seed runs. DEMO_SPAN_START_DAYS
 * is 24 rather than 12 so the newest row lands ~13 days back -- inside the one-month window with
 * room to spare, and still old enough that a "this week" view honestly shows less.
 *
 * Determinism survives where it matters: one anchor is computed once per run and every row is a
 * fixed offset from it, so the relative spacing the measurement fixtures assert is unchanged.
 */
const DEMO_SPAN_START_DAYS = 24;
const DEMO_ANCHOR = (() => {
  const anchor = new Date();
  anchor.setUTCDate(anchor.getUTCDate() - DEMO_SPAN_START_DAYS);
  anchor.setUTCHours(0, 0, 0, 0);
  return anchor;
})();

/** Day `dayOffset` of the demo story, plus optional minutes, as an ISO timestamp. */
export function demoDay(dayOffset, minuteOffset = 0) {
  const at = new Date(DEMO_ANCHOR);
  at.setUTCDate(at.getUTCDate() + dayOffset);
  at.setUTCMinutes(at.getUTCMinutes() + minuteOffset);
  return at.toISOString().replace(".000Z", "Z");
}

export const PHASE7_DEMO_IDS = Object.freeze({
  tenant: "87000000-0000-4000-8000-000000000001",
  coach: "87000000-0000-4000-8000-000000000002",
  calendar: "87000000-0000-4000-8000-000000000003",
  contacts: Object.freeze(Array.from({ length: 7 }, (_, index) =>
    `87000000-0000-4000-8001-${String(index + 1).padStart(12, "0")}`)),
  conversations: Object.freeze(Array.from({ length: 7 }, (_, index) =>
    `87000000-0000-4000-8002-${String(index + 1).padStart(12, "0")}`)),
  messages: Object.freeze(Array.from({ length: 5 }, (_, index) =>
    `87000000-0000-4000-8003-${String(index + 1).padStart(12, "0")}`)),
  identities: Object.freeze([
    "87000000-0000-4000-8004-000000000001",
    "87000000-0000-4000-8004-000000000002",
  ]),
  followups: Object.freeze([
    "87000000-0000-4000-8005-000000000001",
    "87000000-0000-4000-8005-000000000002",
    "87000000-0000-4000-8005-000000000003",
  ]),
  onboardingRun: "87000000-0000-4000-8006-000000000001",
  provisioning: Object.freeze(Array.from({ length: 8 }, (_, index) =>
    `87000000-0000-4000-8006-${String(index + 2).padStart(12, "0")}`)),
  knowledgeUsage: "87000000-0000-4000-8006-000000000010",
  ghlInstall: "87000000-0000-4000-8006-000000000011",
  // Three outbound agent turns that each cite one published objection, so the coach Top
  // objections panel has real rows rather than an honest-but-empty one.
  objectionMessages: Object.freeze([
    "87000000-0000-4000-8007-000000000001",
    "87000000-0000-4000-8007-000000000002",
    "87000000-0000-4000-8007-000000000003",
  ]),
  // Not published anywhere yet: the synthetic pricing objection this seed publishes alongside
  // the platform's real "Needs more information" objection (`DEMO_IDS.objection` in
  // seed-phase1-demo.mjs), so the panel shows two labels ranked by distinct-conversation count
  // instead of one.
  pricingObjection: "87000000-0000-4000-8007-000000000010",
});

export const PHASE7_DEMO_VALUES = Object.freeze({
  slug: "setterfi-demo-placeholder-measurement",
  email: "phase7-measurement@example.invalid",
  challengerModel: "setterfi/demo-phase7-challenger",
  comparisonCaseSet: createHash("sha256").update("SETTERFI_DEMO_PLACEHOLDER_PHASE7_CASE_SET").digest("hex"),
  promotionNotes: DEMO_MEASUREMENT_COPY.promotionNotes,
  legacyPromotionNotes: "SETTERFI_DEMO_PLACEHOLDER_PHASE7_PROMOTED_CASE_UNAPPROVED",
  appointmentExternalId: "SETTERFI_DEMO_PLACEHOLDER_PHASE7_LATER_BOOKING",
  ghlLocationId: "SETTERFI_DEMO_PLACEHOLDER_PHASE7_LOCATION",
  ghlCompanyId: "SETTERFI_DEMO_PLACEHOLDER_PHASE7_COMPANY",
});

const PIPELINE_STAGES = [
  "new_lead", "qualifying", "booked", "qualified_no_buy",
  "long_term_followup", "no_show", "disqualified",
];
const PHASE7_CONTACT_FIXTURES = Object.freeze([
  { name: LEAD_NAMES[13], channel: "sms", outcome: null, dqReason: null },
  { name: LEAD_NAMES[14], channel: "instagram", outcome: null, dqReason: null },
  { name: LEAD_NAMES[15], channel: "whatsapp", outcome: "BOOK", dqReason: null },
  {
    name: LEAD_NAMES[16],
    channel: "messenger",
    outcome: "SOFT_DQ",
    dqReason: "The lead is interested but is not ready to proceed.",
  },
  {
    name: LEAD_NAMES[17],
    channel: "sms",
    outcome: "SOFT_DQ",
    dqReason: "The lead asked to revisit funding later.",
  },
  { name: LEAD_NAMES[18], channel: "instagram", outcome: "BOOK", dqReason: null },
  {
    name: LEAD_NAMES[19],
    channel: "whatsapp",
    outcome: "HARD_DQ",
    dqReason: "The lead falls outside the current program criteria.",
  },
]);
const PROVISIONING = [
  ["account", "pending", null],
  ["billing", "running", null],
  ["ghl_location", "awaiting_coach", null],
  ["ghl_snapshot", "awaiting_platform", null],
  ["phone_number", "awaiting_provider", "carrier"],
  ["sms_eligibility_screen", "done", null],
  ["business_profile", "failed", null],
  ["optin_artifact", "blocked", null],
];

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

async function normalizePhase7AdditionalContacts(database) {
  const rows = (await database.query(
    "select id from public.contacts where tenant_id=$1 order by id",
    [PHASE7_DEMO_IDS.tenant],
  )).rows;
  const fixedIds = new Set(PHASE7_DEMO_IDS.contacts);
  // Same exemption as `seed-phase1-demo.mjs`: `seed-showcase-leads.mjs` writes two hundred named,
  // staged, dated contacts on this tenant, and renaming them from a nine-name tail would destroy
  // the dataset and then fail the capacity assert below.
  const additional = rows.filter((row) => !fixedIds.has(row.id) && !isShowcaseLeadId(row.id));
  const availableNames = LEAD_NAMES.slice(20, 29);
  assert(additional.length <= availableNames.length, "PHASE7_DEMO_CONTACT_NAME_CAPACITY_EXCEEDED");
  const channels = ["webchat", "sms", "instagram", "whatsapp", "messenger"];
  for (let index = 0; index < additional.length; index += 1) {
    await database.query(
      `update public.contacts set name=$1,last_channel=$2,pipeline_stage=$3,stage_set_by='system',
         outcome=null,dq_reason=null,business_context='Demo review contact. Excluded from real analytics.'
       where id=$4 and tenant_id=$5`,
      [availableNames[index], channels[index % channels.length],
        PIPELINE_STAGES[index % PIPELINE_STAGES.length], additional[index].id, PHASE7_DEMO_IDS.tenant],
    );
  }
  return additional.length;
}

async function assertPhase7ContactReviewData(database) {
  const contacts = (await database.query(
    `select id,name,is_test,pipeline_stage,last_channel,outcome
     from public.contacts where tenant_id=$1 order by id`,
    [PHASE7_DEMO_IDS.tenant],
  )).rows;
  assert(contacts.length >= PHASE7_DEMO_IDS.contacts.length, "PHASE7_DEMO_CONTACT_COUNT_INVALID");
  assert(contacts.every((contact) => contact.is_test === true), "PHASE7_DEMO_CONTACT_NOT_TEST_DATA");
  assertUniqueDisplayNames(
    contacts.map((contact) => contact.name ?? ""),
    "PHASE7_DEMO_CONTACT_DISPLAY_NAMES_NOT_UNIQUE",
  );
  assert(!contacts.some((contact) => /^(demo|test|synthetic|setterfi)\b/i.test(contact.name ?? "")),
    "PHASE7_DEMO_CONTACT_STATE_NAME_VISIBLE");
  const stages = new Set(contacts.map((contact) => contact.pipeline_stage));
  assert(PIPELINE_STAGES.every((stage) => stages.has(stage)), "PHASE7_DEMO_PIPELINE_STAGE_EMPTY");
  return { contacts: contacts.length, stages: stages.size };
}

async function setAdminClaims(database) {
  await database.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: PHASE2_ADMIN_ID, app_metadata: { role: "admin" } }),
  ]);
}

async function requirePhase6Seed(database) {
  const result = (await database.query(
    `select
      count(distinct intent.id)::int intents,
      count(distinct subscription.id)::int subscriptions,
      count(distinct rollup.id)::int cost_rollups
     from public.signup_intents intent
     join public.tenants tenant on tenant.id = intent.tenant_id and tenant.is_demo
     left join public.billing_subscriptions subscription on subscription.tenant_id = tenant.id
     left join public.tenant_cost_rollups rollup on rollup.tenant_id = tenant.id
     where intent.id = any($1::uuid[])`,
    [[PHASE6_DEMO_IDS.affiliateIntent, PHASE6_DEMO_IDS.moneyIntent]],
  )).rows[0];
  assert(result.intents === 2 && result.subscriptions >= 2 && result.cost_rollups >= 1,
    "PHASE6_DEMO_SEED_MISSING");
  const ancestry = await database.query(
    `select tenant.slug, tenant.is_demo from public.signup_intents intent
     join public.tenants tenant on tenant.id = intent.tenant_id
     where intent.id = $1`,
    [PHASE6_DEMO_IDS.moneyIntent],
  );
  assert(ancestry.rows[0]?.slug === PHASE6_DEMO_VALUES.moneySlug && ancestry.rows[0]?.is_demo === true,
    "PHASE6_DEMO_SEED_MISSING");
}

async function requirePhase7Ancestry(database) {
  const existing = await database.query(
    "select id, slug, is_demo from public.tenants where id = $1 or slug = $2",
    [PHASE7_DEMO_IDS.tenant, PHASE7_DEMO_VALUES.slug],
  );
  if (existing.rowCount === 0) return;
  assert(existing.rowCount === 1
    && existing.rows[0].id === PHASE7_DEMO_IDS.tenant
    && existing.rows[0].slug === PHASE7_DEMO_VALUES.slug
    && existing.rows[0].is_demo === true,
  "PHASE7_DEMO_TENANT_ANCESTRY_REFUSED");
}

async function seedTenant(database) {
  await database.query(
    `insert into public.tenants
       (id, slug, name, status, is_demo, billing_contact_email, billing_contact_name, created_at)
     values ($1, $2, $4, 'active', true, $3,
       'Avery Morgan (demo)', '${demoDay(0)}')
     on conflict (id) do update set name=excluded.name,status='active',is_demo=true,
       billing_contact_email=excluded.billing_contact_email,
       billing_contact_name=excluded.billing_contact_name`,
    [PHASE7_DEMO_IDS.tenant, PHASE7_DEMO_VALUES.slug, PHASE7_DEMO_VALUES.email,
      DEMO_SUPPORT_TENANT_NAMES.measurement],
  );
  await database.query(
    `insert into public.users (id, email, full_name, role, tenant_id)
     values ($1, $2, 'Avery Morgan (demo)', 'coach', $3)
     on conflict (id) do update set email=excluded.email,full_name=excluded.full_name,
       role='coach',tenant_id=excluded.tenant_id`,
    [PHASE7_DEMO_IDS.coach, PHASE7_DEMO_VALUES.email, PHASE7_DEMO_IDS.tenant],
  );
  await database.query(
    `insert into public.tenant_settings (tenant_id, timezone)
     values ($1, 'America/New_York') on conflict (tenant_id) do nothing`,
    [PHASE7_DEMO_IDS.tenant],
  );
  await database.query(
    `insert into public.calendar_connections
       (id, tenant_id, provider, external_calendar_id, calendar_name, timezone, state, is_primary)
     values ($1, $2, 'ghl', 'SETTERFI_DEMO_PLACEHOLDER_PHASE7_CALENDAR',
       'Measurement review calendar', 'America/New_York', 'ready', true)
     on conflict (id) do update set calendar_name=excluded.calendar_name,state='ready',
       is_primary=true`,
    [PHASE7_DEMO_IDS.calendar, PHASE7_DEMO_IDS.tenant],
  );
  // `contact_identities_provider_account_guard` (migration 20260905000010) binds every `ghl`
  // identity to a `ghl_installs` row on the same tenant, so the install has to exist before the
  // operational rows are written.
  await database.query(
    `insert into public.ghl_installs
       (id, tenant_id, location_id, company_id, token_expires_at, install_state, last_error)
     values ($1, $2, $3, $4, '2030-01-01T00:00:00Z', 'installed', null)
     on conflict (id) do update set tenant_id=excluded.tenant_id,
       location_id=excluded.location_id, company_id=excluded.company_id,
       token_expires_at=excluded.token_expires_at, install_state='installed', last_error=null`,
    [PHASE7_DEMO_IDS.ghlInstall, PHASE7_DEMO_IDS.tenant,
      PHASE7_DEMO_VALUES.ghlLocationId, PHASE7_DEMO_VALUES.ghlCompanyId],
  );
}

async function seedOperationalRows(database) {
  for (let index = 0; index < PIPELINE_STAGES.length; index += 1) {
    const fixture = PHASE7_CONTACT_FIXTURES[index];
    await database.query(
      `insert into public.contacts
         (id, tenant_id, last_channel, name, business_context, outcome, dq_reason, is_test,
          pipeline_stage, stage_set_at, created_at)
       values ($1, $2, $3, $4, 'Plausible demo lead for pipeline review.', $5, $6, true, $7,
         '${demoDay(0)}', '${demoDay(0)}')
       on conflict (id) do update set last_channel=excluded.last_channel,name=excluded.name,
         business_context=excluded.business_context,outcome=excluded.outcome,
         dq_reason=excluded.dq_reason,is_test=true,pipeline_stage=excluded.pipeline_stage,
         stage_set_at=excluded.stage_set_at`,
      [PHASE7_DEMO_IDS.contacts[index], PHASE7_DEMO_IDS.tenant,
        fixture.channel, fixture.name, fixture.outcome, fixture.dqReason, PIPELINE_STAGES[index]],
    );
    const status = index === 3 ? "nurture" : index === 4 ? "needs_human" : index === 5 ? "scope_blocked" : "agent";
    const reason = index === 3 ? "cadence_exhausted" : index === 4 ? "tripwire_escalate" : index === 5 ? "scope_exit_cap" : null;
    await database.query(
      `insert into public.conversations
         (id, tenant_id, contact_id, channel, status, status_reason, first_touch_keyword,
          current_step, model_config_id, is_test, tripwire_count, scope_attack_count,
          created_at, status_changed_at)
       values ($1, $2, $3, $4, $5, $6, $7,
         $11, $8, true, $9, $10,
         '${demoDay(0)}', '${demoDay(0)}')
       on conflict (id) do update set channel=excluded.channel,status=excluded.status,
         status_reason=excluded.status_reason,first_touch_keyword=excluded.first_touch_keyword,
         current_step=excluded.current_step,model_config_id=excluded.model_config_id,is_test=true,
         tripwire_count=excluded.tripwire_count,scope_attack_count=excluded.scope_attack_count`,
      [PHASE7_DEMO_IDS.conversations[index], PHASE7_DEMO_IDS.tenant,
        PHASE7_DEMO_IDS.contacts[index], fixture.channel, status, reason,
        index === 0 ? null : DEMO_MEASUREMENT_COPY.firstTouchKeywords[index - 1],
        ACTIVE_GENERATOR_ID, index === 4 ? 1 : 0, index === 5 ? 3 : 0,
        DEMO_MEASUREMENT_COPY.stepQualification],
    );
  }

  const messageRows = [
    [0, 0, "in", "lead", DEMO_MEASUREMENT_COPY.leadAnswer, demoDay(1)],
    [1, 0, "out", "agent", DEMO_MEASUREMENT_COPY.agentQuestion, demoDay(1, 1)],
    [2, 3, "in", "lead", DEMO_MEASUREMENT_COPY.replyAfterNextTouch, demoDay(4)],
    [3, 3, "in", "lead", DEMO_MEASUREMENT_COPY.replyAtSevenDayBoundary, demoDay(9)],
    [4, 4, "out", "agent", DEMO_MEASUREMENT_COPY.heldRuleOutcome, demoDay(2)],
  ];
  for (const [messageIndex, conversationIndex, direction, author, body, createdAt] of messageRows) {
    await database.query(
      `insert into public.messages
         (id, tenant_id, conversation_id, direction, author, body, provider, is_test, created_at)
       values ($1, $2, $3, $4, $5, $6, 'ghl', true, $7)
       on conflict (id) do update set body = excluded.body`,
      [PHASE7_DEMO_IDS.messages[messageIndex], PHASE7_DEMO_IDS.tenant,
        PHASE7_DEMO_IDS.conversations[conversationIndex], direction, author, body, createdAt],
    );
  }
  await database.query(
    `insert into public.message_traces
       (message_id, tenant_id, rule_fired, checks, violations, model, params, trace, created_at)
     values ($1, $2, $3, $4::jsonb, '[]'::jsonb, $5, '{}'::jsonb, $6::jsonb,
       '${demoDay(2)}')
     on conflict (message_id) do update set rule_fired = excluded.rule_fired,
       checks = excluded.checks, model = excluded.model, trace = excluded.trace`,
    [PHASE7_DEMO_IDS.messages[4], PHASE7_DEMO_IDS.tenant,
      DEMO_MEASUREMENT_COPY.heldRule,
      JSON.stringify([{ result: DEMO_MEASUREMENT_COPY.heldCheckResult }]),
      DEMO_MEASUREMENT_COPY.mockModel,
      JSON.stringify({ outcome: "held", driverArm: "mock", label: DEMO_MEASUREMENT_COPY.demoLabel })],
  );
  await database.query(
    `select * from public.record_conversation_step_events($1,$2,$3,$4,$5,$6)`,
    [PHASE7_DEMO_IDS.tenant, PHASE7_DEMO_IDS.conversations[0],
      PHASE7_DEMO_IDS.messages[0], PHASE7_DEMO_IDS.messages[1],
      // `conversation_step_events` is strictly append-only (`app.reject_phase7_append_only`) and
      // the conflict clause keys on the step key itself, so renaming these would leave the old
      // event beside the new one and double the seed's own step counts with no way to clean up.
      // The pair stays a sentinel; the step a coach actually sees is `conversations.current_step`.
      "SETTERFI_DEMO_PLACEHOLDER_STEP_DISCOVERY", "SETTERFI_DEMO_PLACEHOLDER_STEP_QUALIFICATION"],
  );

  const identityRows = [
    [0, 0, "ghl", "sms", "SETTERFI_DEMO_PLACEHOLDER_IDENTITY_SMS", "reply_only", "inbound_message", demoDay(1)],
    [1, 3, "meta_direct", "whatsapp", "SETTERFI_DEMO_PLACEHOLDER_IDENTITY_CROSS_CHANNEL", "unverified", null, demoDay(4, 30)],
  ];
  for (const [identityIndex, contactIndex, provider, channel, providerId, consent, source, createdAt] of identityRows) {
    await database.query(
      `insert into public.contact_identities
         (id, tenant_id, contact_id, provider, channel, provider_identity_id,
          consent_state, consent_source, consent_captured_at, consent_evidence, created_at,
          provider_account_id, ghl_install_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$11::jsonb,$10,$12,$13::uuid)
       on conflict (id) do update set consent_evidence = excluded.consent_evidence`,
      [PHASE7_DEMO_IDS.identities[identityIndex], PHASE7_DEMO_IDS.tenant,
        PHASE7_DEMO_IDS.contacts[contactIndex], provider, channel, providerId, consent, source,
        source ? createdAt : null, createdAt,
        JSON.stringify({ label: DEMO_MEASUREMENT_COPY.consentLabel }),
        // Non-`ghl` identities must carry no binding at all; the same guard rejects one.
        provider === "ghl" ? PHASE7_DEMO_VALUES.ghlLocationId : null,
        provider === "ghl" ? PHASE7_DEMO_IDS.ghlInstall : null],
    );
  }
  const followupRows = [
    [0, 1, demoDay(2)],
    [1, 2, demoDay(2)],
    [2, 3, demoDay(11)],
  ];
  for (const [index, touch, sentAt] of followupRows) {
    await database.query(
      `insert into public.followups
         (id, tenant_id, conversation_id, touch_no, purpose, scheduled_at, status, sent_at,
          is_test, channel_class, cadence_anchor_at, original_scheduled_at, created_at)
       values ($1,$2,$3,$4,'value_nudge',$5,'sent',$5,true,'durable',
         '${demoDay(0)}',$5,'${demoDay(0)}')
       on conflict (id) do nothing`,
      [PHASE7_DEMO_IDS.followups[index], PHASE7_DEMO_IDS.tenant,
        PHASE7_DEMO_IDS.conversations[3], touch, sentAt],
    );
  }
  await database.query(
    `update public.conversations set cadence_anchor_at='${demoDay(0)}'
     where id=$1 and cadence_anchor_at is null`,
    [PHASE7_DEMO_IDS.conversations[3]],
  );

  await database.query(
    `select * from public.record_provider_appointment(
      $1,$2,$3,$4,'ghl',$5,'${demoDay(9, 900)}','${demoDay(9, 930)}',
      'America/New_York','agent',true)`,
    [PHASE7_DEMO_IDS.tenant, PHASE7_DEMO_IDS.contacts[2],
      PHASE7_DEMO_IDS.conversations[2], PHASE7_DEMO_IDS.calendar,
      PHASE7_DEMO_VALUES.appointmentExternalId],
  );

  await database.query(
    `insert into public.brain_knowledge_usage_events
       (id, knowledge_entry_id, conversation_id, tenant_id, used_at, is_test)
     values ($1,$2,$3,$4,'${demoDay(2)}',true) on conflict (id) do nothing`,
    [PHASE7_DEMO_IDS.knowledgeUsage, PHASE2_DEMO_IDS.knowledge,
      PHASE7_DEMO_IDS.conversations[0], PHASE7_DEMO_IDS.tenant],
  );
  await database.query(
    `insert into public.onboarding_runs
       (id, tenant_id, started_at, readiness_met_at, went_live_at, created_at)
     values ($1,$2,'${demoDay(0)}','${demoDay(3)}','${demoDay(5)}',
       '${demoDay(0)}') on conflict (id) do nothing`,
    [PHASE7_DEMO_IDS.onboardingRun, PHASE7_DEMO_IDS.tenant],
  );
  for (let index = 0; index < PROVISIONING.length; index += 1) {
    const [step, state, party] = PROVISIONING[index];
    await database.query(
      `insert into public.provisioning_steps
         (id, tenant_id, step_key, state, awaiting_party, attempts, started_at, last_attempt_at,
          completed_at, error_code, error_message, blocked_reason, external_ref,
          next_attempt_at, last_transition_at, idempotency_key, lease_expires_at, attempt_id, created_at)
       values ($1,$2,$3,$4,$5,1,'${demoDay(0)}','${demoDay(1)}',
         $6,$7,$8,$9,$13::jsonb,
         '${demoDay(2)}','${demoDay(1)}',$10,$11,$12,'${demoDay(0)}')
       on conflict (id) do update set error_code = excluded.error_code,
         error_message = excluded.error_message, blocked_reason = excluded.blocked_reason,
         external_ref = excluded.external_ref`,
      [PHASE7_DEMO_IDS.provisioning[index], PHASE7_DEMO_IDS.tenant, step, state, party,
        state === "done" ? demoDay(1) : null,
        state === "failed" ? DEMO_MEASUREMENT_COPY.provisioningFailureCode : null,
        state === "failed" ? DEMO_MEASUREMENT_COPY.provisioningFailureMessage : null,
        state === "blocked" ? DEMO_MEASUREMENT_COPY.provisioningBlockedReason : null,
        `${PHASE7_DEMO_IDS.tenant}:${step}`,
        state === "running" ? demoDay(2) : null,
        state === "running" ? PHASE7_DEMO_IDS.provisioning[index] : null,
        JSON.stringify({ label: DEMO_MEASUREMENT_COPY.provisioningLabel })],
    );
  }
}

/**
 * Publishes one Brain snapshot carrying two objections -- the platform's real "Needs more
 * information" objection (`DEMO_IDS.objection`, already live in `public.brain_objections` from
 * Phase 1) and a synthetic pricing objection this seed owns outright -- and records three agent
 * turns that cite them, so `read_coach_top_objections_for_actor` has real rows instead of an
 * honest empty panel.
 *
 * This mirrors `seedBrain` in `seed-phase2-demo.mjs`: a draft version, a passing checker eval run,
 * then `publish_brain_draft`. It is its own snapshot rather than added to Phase 2's, because that
 * payload carries no `entities` key and Phase 2's own idempotency lookup keys on it staying that
 * way (`payload ->> 'demoSeed' = 'phase2'`).
 *
 * Idempotent the same way: a `demoSeed` marker on the draft/snapshot payload is looked up first,
 * and nothing here is written twice.
 */
/**
 * The platform prompt the demo snapshot carries. Every snapshot needs one: the runtime refuses a
 * snapshot whose compiled platform is empty (`RUNTIME_BRAIN_COMPILED_PLATFORM_INVALID`), and the
 * first cut of this seed published without it, which refused every agent turn on the hosted
 * database from 2026-09-02 until it was republished. Synthetic, like Phase 2's, because the demo
 * has no real Brain compile; the engine adds its own invariants around it.
 */
export const PHASE7_DEMO_COMPILED_PLATFORM = [
  "[A] PLATFORM FRAME",
  "You are the appointment setter texting on behalf of one coach. Leads reach you by SMS or DM after showing interest in the coach's offer. Your only job is to hold a short, natural conversation that qualifies the lead against the coach's criteria and books them onto the coach's calendar.",
  "Voice: warm, plain, brief. One idea and at most one question per message. One or two short sentences, under 160 characters on SMS and never more than 300 anywhere, no bullet points, no emojis unless the lead uses them first. Sound like a person on the coach's team, never like a script or a bot.",
  "Method: acknowledge what the lead said, then ask the next qualification question the server state names as current_step_asks. Do not skip ahead, do not ask several questions at once, and do not re-ask something the lead already answered.",
  "Grounding: describe the offer, pricing, process and outcomes only with facts from the coach data and the Brain entries below, and cite the entry you used. Never invent a number, guarantee, timeline, testimonial or link. If a lead asks something the Brain does not cover, say you'll have the coach confirm and continue qualifying.",
  "Booking: once the lead qualifies, offer the available times you are given and confirm the one they pick. Do not promise a time you were not given.",
  "Honesty: when asked whether they are talking to an automated system, answer plainly with the disclosure you are given. Never claim to be the coach.",
  "Out of scope: anything that is not qualifying or booking this lead for this coach. Decline briefly and return to the lead's goal.",
].join("\n");

async function seedBrainObjectionUsage(database) {
  const payload = {
    demoSeed: "phase7-objections",
    compiledPlatform: PHASE7_DEMO_COMPILED_PLATFORM,
    platformTokens: 358,
    knowledgeMode: "inline",
    entities: [
      {
        type: "brain_objection",
        id: DEMO_IDS.objection,
        value: {
          label: "Needs more information",
          response: "We can explain the process and collect only the details needed to assess fit.",
          category: "clarity",
          matchKeywords: ["not sure", "more information"],
          hardGate: false,
        },
      },
      {
        type: "brain_objection",
        id: PHASE7_DEMO_IDS.pricingObjection,
        value: {
          label: DEMO_MEASUREMENT_COPY.objectionPricingLabel,
          response: DEMO_MEASUREMENT_COPY.objectionPricingResponse,
          category: "pricing",
          matchKeywords: ["price", "cost", "how much"],
          hardGate: false,
        },
      },
    ],
  };
  let draft = (await database.query(
    "select id, content_hash from public.brain_draft_versions where payload ->> 'demoSeed' = 'phase7-objections' and nullif(payload ->> 'compiledPlatform', '') is not null order by created_at limit 1",
  )).rows[0];
  if (!draft) {
    const hash = (await database.query(
      "select app.phase2_json_hash($1::jsonb) hash", [JSON.stringify(payload)],
    )).rows[0].hash;
    const result = await database.query(
      "select public.create_brain_draft_version($1, $2, $3::jsonb) id",
      [PHASE2_ADMIN_ID, hash, JSON.stringify(payload)],
    );
    draft = { id: result.rows[0].id, content_hash: hash };
  }
  let evalRun = (await database.query(
    "select id from public.eval_runs where brain_draft_version_id = $1 and kind = 'checker' order by created_at limit 1",
    [draft.id],
  )).rows[0]?.id;
  if (!evalRun) {
    evalRun = (await database.query(
      "select public.record_eval_run($1, $2, 'checker', null, 'phase7-objections-synthetic-v1', $3::jsonb) id",
      [draft.id, draft.content_hash, JSON.stringify(evalSuites())],
    )).rows[0].id;
  }
  let snapshot = (await database.query(
    // Only a snapshot with a platform prompt counts as seeded; the empty one is superseded.
    "select id from public.brain_snapshots where payload ->> 'demoSeed' = 'phase7-objections' and nullif(compiled_platform, '') is not null order by version limit 1",
  )).rows[0];
  if (!snapshot) {
    snapshot = (await database.query(
      "select snapshot_id id from public.publish_brain_draft($1, $2, $3, $4, $5)",
      [PHASE2_ADMIN_ID, draft.id, draft.content_hash, evalRun,
        DEMO_MEASUREMENT_COPY.objectionsPublishReason],
    )).rows[0];
  }

  // [messageIndex into PHASE7_DEMO_IDS.objectionMessages, conversationIndex, objectionId, body,
  //  handlingOutcome, createdAt]. Two conversations cite the clarity objection and one cites the
  // pricing objection, so the panel's ranking (highest distinct-conversation count first) has
  // something to show rather than a three-way tie.
  const objectionTurns = [
    [0, 1, DEMO_IDS.objection, DEMO_MEASUREMENT_COPY.objectionClarityReply, "answered", demoDay(5)],
    [1, 2, DEMO_IDS.objection, DEMO_MEASUREMENT_COPY.objectionClarityReply, "answered", demoDay(6)],
    [2, 6, PHASE7_DEMO_IDS.pricingObjection, DEMO_MEASUREMENT_COPY.objectionPricingReply, "answered", demoDay(7)],
  ];
  for (const [messageIndex, conversationIndex, objectionId, body, outcome, createdAt] of objectionTurns) {
    const messageId = PHASE7_DEMO_IDS.objectionMessages[messageIndex];
    await database.query(
      `insert into public.messages
         (id, tenant_id, conversation_id, direction, author, body, provider, is_test, created_at)
       values ($1, $2, $3, 'out', 'agent', $4, 'ghl', true, $5)
       on conflict (id) do update set body = excluded.body`,
      [messageId, PHASE7_DEMO_IDS.tenant, PHASE7_DEMO_IDS.conversations[conversationIndex], body,
        createdAt],
    );
    await database.query(
      `insert into public.message_traces
         (message_id, tenant_id, objection_snapshot_id, objection_id,
          objection_handling_outcome, objection_hard_gate, created_at)
       values ($1, $2, $3, $4, $5, false, $6)
       on conflict (message_id) do update set
         objection_snapshot_id = excluded.objection_snapshot_id,
         objection_id = excluded.objection_id,
         objection_handling_outcome = excluded.objection_handling_outcome,
         objection_hard_gate = excluded.objection_hard_gate`,
      [messageId, PHASE7_DEMO_IDS.tenant, snapshot.id, objectionId, outcome, createdAt],
    );
  }
}

function evalSuites() {
  return [
    "compliance_guardrails", "pricing_discipline", "jailbreak_injection",
    "output_integrity", "qualification_accuracy", "voice_tone",
  ].map((suite) => ({
    suite,
    cases: [{
      caseKey: `Demo case: ${suite.replaceAll("_", " ")}`,
      passed: true,
      response: DEMO_MEASUREMENT_COPY.evalResponse,
      trace: { driverArm: "mock", label: DEMO_MEASUREMENT_COPY.demoLabel },
      latencyMs: 0,
      costCents: 0,
    }],
  }));
}

/**
 * The evaluation rows below are written once and then guarded by an existence check, so a database
 * seeded before the readable-copy pass would keep its sentinels forever. These statements rewrite
 * exactly the display columns those rows own, and they are no-ops on a clean database.
 */
async function relabelLegacyEvaluationCopy(database) {
  await database.query(
    `update public.eval_cases set notes = $2 where source_tenant_id = $1 and notes = $3`,
    [PHASE7_DEMO_IDS.tenant, PHASE7_DEMO_VALUES.promotionNotes,
      PHASE7_DEMO_VALUES.legacyPromotionNotes],
  );
  await database.query(
    `update public.eval_cases
     set turns = $1::jsonb, expectation = $2::jsonb
     where source_tenant_id = $3 and turns::text like '%SETTERFI_DEMO_PLACEHOLDER_%'
       and exists (
         select 1 from public.conversations c where c.id = eval_cases.source_conversation_id
       )`,
    [JSON.stringify([
      { role: "user", content: DEMO_MEASUREMENT_COPY.redactedLeadTurn },
      { role: "assistant", content: DEMO_MEASUREMENT_COPY.redactedAgentTurn },
    ]), JSON.stringify({ outcome: DEMO_MEASUREMENT_COPY.expectedQualification }),
    PHASE7_DEMO_IDS.tenant],
  );
  await database.query(
    `update public.eval_case_results
     set case_key = 'Demo case: ' || replace(lower(regexp_replace(case_key,
           '^SETTERFI_DEMO_PLACEHOLDER_', '')), '_', ' '),
         response = $1,
         trace = jsonb_set(trace, '{label}', to_jsonb($2::text))
     where case_key like 'SETTERFI_DEMO_PLACEHOLDER_%'`,
    [DEMO_MEASUREMENT_COPY.evalResponse, DEMO_MEASUREMENT_COPY.demoLabel],
  );
  await database.query(
    `update public.model_configs
     set params = jsonb_set(params, '{demoLabel}', to_jsonb($2::text))
     where openrouter_model = $1 and params->>'demoLabel' like 'SETTERFI_DEMO_PLACEHOLDER_%'`,
    [PHASE7_DEMO_VALUES.challengerModel, DEMO_MEASUREMENT_COPY.demoLabel],
  );
  // The test-agent turn is written by the same one-shot block, and it lands as ordinary
  // `messages` and `message_traces` rows on the tenant.
  await database.query(
    `update public.messages
     set body = case when author = 'lead' then $2 else $3 end
     where tenant_id = $1 and body like 'SETTERFI_DEMO_PLACEHOLDER_%'`,
    [PHASE7_DEMO_IDS.tenant, DEMO_MEASUREMENT_COPY.testLeadTurn,
      DEMO_MEASUREMENT_COPY.testAgentResponse],
  );
  await database.query(
    `update public.message_traces
     set model = $2, trace = jsonb_set(trace, '{label}', to_jsonb($3::text))
     where tenant_id = $1 and model like 'SETTERFI_DEMO_PLACEHOLDER_%'`,
    [PHASE7_DEMO_IDS.tenant, DEMO_MEASUREMENT_COPY.mockModel, DEMO_MEASUREMENT_COPY.demoLabel],
  );
}

async function seedEvaluationRows(database) {
  await setAdminClaims(database);
  await relabelLegacyEvaluationCopy(database);
  let challenger = (await database.query(
    `select id from public.model_configs where openrouter_model=$1 and role='generator'
     and active=false order by created_at`,
    [PHASE7_DEMO_VALUES.challengerModel],
  )).rows;
  assert(challenger.length <= 1, "PHASE7_DEMO_CHALLENGER_NOT_UNIQUE");
  if (challenger.length === 0) {
    challenger = (await database.query(
      `select model_config_id id from public.create_challenger_model_config($1,$2,$3::jsonb)`,
      [PHASE2_ADMIN_ID, PHASE7_DEMO_VALUES.challengerModel,
        JSON.stringify({ temperature: 0, demoLabel: DEMO_MEASUREMENT_COPY.demoLabel })],
    )).rows;
  }
  const challengerId = challenger[0].id;
  const draft = (await database.query(
    `select id, content_hash from public.brain_draft_versions
     where payload->>'demoSeed'='phase2' order by created_at limit 1`,
  )).rows[0];
  assert(draft, "PHASE2_DEMO_DRAFT_MISSING");

  let comparison = (await database.query(
    `select id,status,run_a_id,run_b_id from public.eval_comparisons
     where case_set_hash=$1 and model_config_a_id=$2 and model_config_b_id=$3 order by created_at`,
    [PHASE7_DEMO_VALUES.comparisonCaseSet, ACTIVE_GENERATOR_ID, challengerId],
  )).rows;
  assert(comparison.length <= 1, "PHASE7_DEMO_COMPARISON_NOT_UNIQUE");
  if (comparison.length === 0) {
    const comparisonId = (await database.query(
      `select public.start_eval_comparison($1,$2,$3,$4,$5,$6) id`,
      [PHASE2_ADMIN_ID, draft.id, draft.content_hash, ACTIVE_GENERATOR_ID,
        challengerId, PHASE7_DEMO_VALUES.comparisonCaseSet],
    )).rows[0].id;
    const suitePayload = JSON.stringify(evalSuites());
    const runA = (await database.query(
      `select public.record_eval_run($1,$2,'engine',$3,'phase7-demo-v1',$4::jsonb) id`,
      [draft.id, draft.content_hash, ACTIVE_GENERATOR_ID, suitePayload],
    )).rows[0].id;
    const runB = (await database.query(
      `select public.record_eval_run($1,$2,'engine',$3,'phase7-demo-v1',$4::jsonb) id`,
      [draft.id, draft.content_hash, challengerId, suitePayload],
    )).rows[0].id;
    await database.query("select public.finish_eval_comparison($1,$2,$3,$4)",
      [comparisonId, runA, runB, PHASE7_DEMO_VALUES.comparisonCaseSet]);
  } else {
    assert(comparison[0].status === "completed", "PHASE7_DEMO_COMPARISON_INCOMPLETE");
  }

  const promoted = await database.query(
    "select id from public.eval_cases where source_tenant_id=$1 and notes=$2",
    [PHASE7_DEMO_IDS.tenant, PHASE7_DEMO_VALUES.promotionNotes],
  );
  assert(promoted.rowCount <= 1, "PHASE7_DEMO_PROMOTION_NOT_UNIQUE");
  if (promoted.rowCount === 0) {
    const sessionId = (await database.query(
      "select public.create_test_agent_session($1,$2) id",
      [PHASE7_DEMO_IDS.tenant, PHASE7_DEMO_IDS.coach],
    )).rows[0].id;
    const turn = (await database.query(
      `select * from public.persist_test_agent_turn($1,$2,$3,$4,$5,$6::jsonb,'mock',$7,$8)`,
      [PHASE7_DEMO_IDS.tenant, PHASE7_DEMO_IDS.coach, sessionId,
        DEMO_MEASUREMENT_COPY.testLeadTurn,
        DEMO_MEASUREMENT_COPY.testAgentResponse,
        JSON.stringify({ model: DEMO_MEASUREMENT_COPY.mockModel, params: {},
          label: DEMO_MEASUREMENT_COPY.demoLabel }),
        DEMO_MEASUREMENT_COPY.testAnsweredStep,
        DEMO_MEASUREMENT_COPY.testAskedStep],
    )).rows[0];
    assert(turn.resolved_driver_arm === "mock" && turn.contact_is_test
      && turn.conversation_is_test && turn.lead_is_test && turn.agent_is_test
      && turn.trace_is_test && turn.step_rows_is_test
      && Number(turn.appointment_rows) === 0 && Number(turn.billable_rows) === 0
      && Number(turn.followup_rows) === 0, "PHASE7_DEMO_TEST_TURN_NOT_SEGREGATED");
    const redactedTurns = [
      { role: "user", content: DEMO_MEASUREMENT_COPY.redactedLeadTurn },
      { role: "assistant", content: DEMO_MEASUREMENT_COPY.redactedAgentTurn },
    ];
    const hashes = (await database.query(
      `select app.phase2_json_hash(to_jsonb($1::text)) source_hash,
        app.phase2_json_hash($2::jsonb) redacted_hash`,
      [DEMO_MEASUREMENT_COPY.testAgentResponse, JSON.stringify(redactedTurns)],
    )).rows[0];
    await setAdminClaims(database);
    await database.query(
      `select * from public.promote_eval_case($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,
        'qualification_accuracy',$8::jsonb,$9,$10,$11)`,
      [PHASE2_ADMIN_ID, PHASE7_DEMO_IDS.tenant, turn.conversation_id, turn.agent_message_id,
        turn.contact_id, JSON.stringify(redactedTurns),
        JSON.stringify({ outcome: DEMO_MEASUREMENT_COPY.expectedQualification }),
        JSON.stringify({ placeholders: [] }), hashes.source_hash, hashes.redacted_hash,
        PHASE7_DEMO_VALUES.promotionNotes],
    );
  }
}

export async function seedPhase7Demo({ argumentsList = process.argv.slice(2) } = {}) {
  if (argumentsList.includes("--verify-idempotent")) {
    const { verifyPhase7Demo } = await import("./run-phase7-demo.mjs");
    return verifyPhase7Demo({ argumentsList });
  }
  const target = resolveDemoTarget(argumentsList);
  if (!target.databaseUrl) throw new Error("SUPABASE_DB_PASSWORD_REQUIRED_FOR_HOSTED_PHASE7_SEED");
  const database = new pg.Client({ connectionString: target.databaseUrl });
  await database.connect();
  try {
    await database.query("begin");
    await requirePhase6Seed(database);
    await requirePhase7Ancestry(database);
    await seedTenant(database);
    await seedOperationalRows(database);
    await seedBrainObjectionUsage(database);
    await seedEvaluationRows(database);
    const additionalContacts = await normalizePhase7AdditionalContacts(database);
    const contactReview = await assertPhase7ContactReviewData(database);
    await database.query("commit");
    const { verifyPhase7Demo } = await import("./run-phase7-demo.mjs");
    const counts = await verifyPhase7Demo({ argumentsList, quiet: true });
    console.log(`Phase 7 seed read-back: ${JSON.stringify(counts)} synthetic=true review_contacts=${contactReview.contacts} pipeline_stages=${contactReview.stages} renamed_additional_contacts=${additionalContacts}`);
    return { ...counts, contactReview };
  } catch (error) {
    await database.query("rollback");
    throw error;
  } finally {
    await database.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedPhase7Demo().catch((error) => {
    console.error(error instanceof Error ? error.message : "PHASE7_DEMO_SEED_FAILED");
    process.exitCode = 1;
  });
}
