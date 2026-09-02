/**
 * Review-only platform data.
 *
 * The normal platform aggregate is intentionally empty on an all-demo stack: every analytics_*
 * view excludes `tenants.is_demo` and `is_test` rows.  This script does not weaken that boundary.
 * Instead it writes one explicitly labelled snapshot to a private table and a small set of
 * persisted support threads on the existing demo tenants.  The application can read the snapshot
 * only when both the analytics gate and the demo-login review gate are explicitly enabled.
 */

import { pathToFileURL } from "node:url";

import pg from "pg";

import { DEMO_IDS, resolveDemoTarget } from "./seed-phase1-demo.mjs";
import { PHASE6_DEMO_IDS, PHASE6_DEMO_VALUES, writeCostRollupOnce } from "./seed-phase6-demo.mjs";
import { PHASE7_DEMO_IDS } from "./seed-phase7-demo.mjs";
import { PHASE8_DEMO_IDS, seedPhase8Demo } from "./seed-phase8-demo.mjs";
import { referredBusinessFixtures, seedDemoGaps } from "./seed-demo-gaps.mjs";
import { isShowcaseLeadId } from "./fixtures/showcase-leads-namespace.mjs";
import {
  COACH_NAMES,
  DEMO_BILLING_COPY,
  DEMO_REVIEW_THREADS,
  DEMO_SUPPORT_TENANT_NAMES,
  DEMO_TIER_LADDER,
  LEAD_NAMES,
  assertUniqueDisplayNames,
} from "./fixtures/names.mjs";

export const PLATFORM_REVIEW_DATA_IDS = Object.freeze({
  threads: Object.freeze([
    "8c000000-0000-4000-8000-000000000001",
    "8c000000-0000-4000-8000-000000000002",
    "8c000000-0000-4000-8000-000000000003",
    "8c000000-0000-4000-8000-000000000004",
  ]),
  messages: Object.freeze([
    "8c000000-0000-4000-8001-000000000001",
    "8c000000-0000-4000-8001-000000000002",
    "8c000000-0000-4000-8001-000000000003",
    "8c000000-0000-4000-8001-000000000004",
    "8c000000-0000-4000-8001-000000000005",
    "8c000000-0000-4000-8001-000000000006",
    "8c000000-0000-4000-8001-000000000007",
    "8c000000-0000-4000-8001-000000000008",
  ]),
  // The second coach's correction and the three rows it needs to exist at all: a correction
  // request points at a billable event, which points at an appointment, which needs a contact
  // and a calendar connection on the same tenant.
  secondCoach: Object.freeze({
    calendar: "8c000000-0000-4000-8002-000000000001",
    contact: "8c000000-0000-4000-8002-000000000002",
    billable: "8c000000-0000-4000-8002-000000000003",
    correctionRequest: "8c000000-0000-4000-8002-000000000004",
  }),
});

const SNAPSHOT_KEY = "staging-demo";
const REFERRED_BUSINESSES = Object.freeze(referredBusinessFixtures());
const PIPELINE_STAGES = Object.freeze([
  "new_lead", "qualifying", "booked", "qualified_no_buy",
  "long_term_followup", "no_show", "disqualified",
]);

// Kept as a deliberately closed vocabulary. Node seeders cannot import the TypeScript alias
// module directly, and an unexpected metric key must fail the repository parser at read time.
const PLATFORM_METRIC_KEYS = Object.freeze([
  "platform.new_signups", "platform.active_subscriptions", "platform.gross_mrr",
  "platform.affiliate_commission", "platform.booked_appointments", "platform.churn_rate",
  "platform.ltv", "platform.average_retention", "platform.growth_rate",
  "platform.guardrail_block_rate", "platform.guardrail_rule_fire_rate", "platform.holding_reply_rate",
  "platform.escalation_rate", "platform.scope_block_rate", "platform.no_show_rate",
  "platform.reschedule_rate", "platform.cadence_completion_rate", "platform.followup_reply_rate",
  "platform.cross_channel_continuation_rate", "platform.time_to_live",
  "platform.provisioning_step_failure_rate", "platform.a2p_approval_rate",
  "platform.a2p_median_days_to_clear", "platform.meta_live_sms_registering_share",
  "platform.eval_case_count", "platform.knowledge_usage_count", "platform.margin",
]);

function assert(condition, code, detail) {
  if (!condition) throw new Error(detail ? `${code}:${JSON.stringify(detail)}` : code);
}

function metricValue(key) {
  const values = {
    "platform.new_signups": [3, 3, 3],
    "platform.active_subscriptions": [6, 7, 6],
    "platform.gross_mrr": [6, 6, 298_200],
    "platform.affiliate_commission": [3, 6, 17_892],
    "platform.booked_appointments": [24, 24, 24],
    "platform.churn_rate": [1, 12, 8.3],
    "platform.ltv": [5, 5, 147_500],
    "platform.average_retention": [5, 5, 4.2],
    "platform.growth_rate": [3, 8, 37.5],
    "platform.guardrail_block_rate": [11, 184, 6],
    "platform.guardrail_rule_fire_rate": [184, 2_930, 6.3],
    "platform.holding_reply_rate": [14, 184, 7.6],
    "platform.escalation_rate": [6, 186, 3.2],
    "platform.scope_block_rate": [8, 186, 4.3],
    "platform.no_show_rate": [2, 24, 8.3],
    "platform.reschedule_rate": [3, 24, 12.5],
    "platform.cadence_completion_rate": [41, 48, 85.4],
    "platform.followup_reply_rate": [19, 48, 39.6],
    "platform.cross_channel_continuation_rate": [7, 48, 14.6],
    "platform.time_to_live": [8, 8, 5.8],
    "platform.provisioning_step_failure_rate": [3, 61, 4.9],
    "platform.a2p_approval_rate": [7, 9, 77.8],
    "platform.a2p_median_days_to_clear": [7, 7, 11.4],
    "platform.meta_live_sms_registering_share": [4, 9, 44.4],
    "platform.eval_case_count": [48, 48, 48],
    "platform.knowledge_usage_count": [72, 72, 72],
    "platform.margin": [6, 6, 186_420],
  };
  const value = values[key];
  assert(value, "PLATFORM_REVIEW_METRIC_UNMAPPED", key);
  return value;
}

/**
 * The three client rows in the snapshot, keyed to real demo tenants when the seeder can supply
 * them.
 *
 * Agent performance printed "Client 1 / 2 / 3" because these rows carried invented tenant ids that
 * matched no tenant row, so no name lookup could ever resolve. Passing the real ids in lets the
 * page read the same "(demo)"-marked names every other screen shows. The default keeps the old
 * opaque keys so `platformReviewSnapshot()` stays callable with no database.
 */
const REVIEW_CLIENT_KEYS = Object.freeze(["north", "harbor", "summit"]);

function reviewClientIds(tenantIds) {
  if (!tenantIds) return REVIEW_CLIENT_KEYS.map((key) => `review-${key}`);
  assert(Array.isArray(tenantIds) && tenantIds.length === REVIEW_CLIENT_KEYS.length
    && tenantIds.every((id) => typeof id === "string" && id.length > 0),
  "PLATFORM_REVIEW_CLIENT_TENANT_IDS_INVALID", tenantIds);
  return tenantIds;
}

/** Validated by the same repository parser as a real RPC result. */
export function platformReviewSnapshot(tenantIds) {
  const [north, harbor, summit] = reviewClientIds(tenantIds);
  return {
    metrics: PLATFORM_METRIC_KEYS.map((metricKey) => {
      const [numerator, denominator, value] = metricValue(metricKey);
      return { metricKey, numerator, denominator, value, state: "available" };
    }),
    subscriptions: [
      { tenantId: north, subscriptionId: "review-sub-north", status: "active", stripePriceId: "review-growth", periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z" },
      { tenantId: harbor, subscriptionId: "review-sub-harbor", status: "active", stripePriceId: "review-scale", periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z" },
      { tenantId: summit, subscriptionId: "review-sub-summit", status: "past_due", stripePriceId: "review-starter", periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z" },
    ],
    // Three plans at three prices, and one client whose cost rollup has not run, so the Margin
    // evidence column and the "clients with cost evidence" figure both mean something. Identical
    // rows made the table look copy-pasted and made the coverage tile a restatement of the count.
    tenantPerformance: [
      { tenantId: north, bookedAppointments: 11, grossMrrCents: 149_700, commissionCents: 8_982, marginCents: 96_400, marginState: "available" },
      { tenantId: harbor, bookedAppointments: 8, grossMrrCents: 99_400, commissionCents: 5_964, marginCents: 61_120, marginState: "available" },
      { tenantId: summit, bookedAppointments: 5, grossMrrCents: 49_700, commissionCents: 2_982, marginCents: null, marginState: "unavailable" },
    ],
    guardrailRules: [
      { ruleKey: "guarantee", label: "Outcome guarantees", fires: 72, blocks: 5, holds: 4 },
      { ruleKey: "scope", label: "Out-of-scope requests", fires: 61, blocks: 4, holds: 6 },
      { ruleKey: "financial", label: "Sensitive financial data", fires: 51, blocks: 2, holds: 4 },
    ],
    followupPerformance: [
      { touchNo: 1, sent: 22, replied: 11, crossChannel: 3, exhausted: 0 },
      { touchNo: 2, sent: 15, replied: 6, crossChannel: 2, exhausted: 1 },
      { touchNo: 3, sent: 11, replied: 2, crossChannel: 2, exhausted: 2 },
    ],
    provisioningPerformance: [
      { stepKey: "business_profile", state: "done", attempts: 12, failures: 0, medianDaysToClear: 0.2 },
      { stepKey: "a2p_campaign", state: "done", attempts: 9, failures: 1, medianDaysToClear: 11.4 },
      { stepKey: "sms_live", state: "awaiting_provider", attempts: 7, failures: 2, medianDaysToClear: null },
    ],
    // The platform RPC emits exactly two periods (20260823000001:502-505) and the repository
    // refuses anything else, so the snapshot mirrors that. The overview reads it as a
    // period-over-period comparison, never as a twelve-point series it does not have.
    // Two periods, because the RPC emits exactly two (20260823000001:502-505) and the repository
    // refuses any other length. The current period's count is the same number the
    // `platform.new_signups` metric carries above, so the tile and the comparison on the overview
    // cannot disagree with each other about the same word.
    history: [
      { periodStart: "2026-07-01T00:00:00.000Z", periodEnd: "2026-08-01T00:00:00.000Z", value: 2, state: "available" },
      { periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z", value: 3, state: "available" },
    ],
  };
}

async function reviewTenants(database) {
  const rows = (await database.query(
    `select id,slug,name,is_demo from public.tenants
     where id=any($1::uuid[]) or slug=any($2::text[])`,
    [
      [DEMO_IDS.tenant, PHASE7_DEMO_IDS.tenant],
      [PHASE6_DEMO_VALUES.moneySlug, PHASE6_DEMO_VALUES.affiliateSlug,
        ...REFERRED_BUSINESSES.map((fixture) => fixture.slug)],
    ],
  )).rows;
  assert(rows.length === 7 && rows.every((row) => row.is_demo === true),
    "PLATFORM_REVIEW_TENANT_ANCESTRY_REFUSED", rows);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  const referrals = REFERRED_BUSINESSES.map((fixture) => bySlug.get(fixture.slug));
  assert(referrals.every(Boolean), "PLATFORM_REVIEW_REFERRED_TENANT_MISSING");
  return {
    phase1: byId.get(DEMO_IDS.tenant),
    phase6Money: bySlug.get(PHASE6_DEMO_VALUES.moneySlug),
    phase6Affiliate: bySlug.get(PHASE6_DEMO_VALUES.affiliateSlug),
    phase7: byId.get(PHASE7_DEMO_IDS.tenant),
    referrals,
    all: rows,
  };
}

async function seedPlatformTenantNames(database, tenants) {
  const coachTenants = [tenants.phase1, tenants.phase6Money, ...tenants.referrals];
  assert(coachTenants.length === COACH_NAMES.length && coachTenants.every(Boolean),
    "PLATFORM_REVIEW_COACH_TENANT_SET_INVALID");
  for (let index = 0; index < coachTenants.length; index += 1) {
    const updated = await database.query(
      "update public.tenants set name=$1 where id=$2 and is_demo=true returning id",
      [COACH_NAMES[index], coachTenants[index].id],
    );
    assert(updated.rowCount === 1, "PLATFORM_REVIEW_COACH_NAME_UPDATE_FAILED", coachTenants[index]);
  }
  /*
   * The two non-coach demo tenants, labelled. They rendered in the admin clients table beside real
   * rows without the `(demo)` marker every other demo display value carries, which is
   * F-11-REVIEW-TENANT-NAMES-UNLABELLED read from the other side: an unmarked demo tenant reads
   * as a real client.
   */
  await database.query(
    "update public.tenants set name=$2 where id=$1 and is_demo=true",
    [tenants.phase6Affiliate.id, DEMO_SUPPORT_TENANT_NAMES.affiliatePartner],
  );
  await database.query(
    "update public.tenants set name=$2 where id=$1 and is_demo=true",
    [tenants.phase7.id, DEMO_SUPPORT_TENANT_NAMES.measurement],
  );
  const lead = await database.query(
    `update public.contacts set name=$1,business_context=$2,last_channel='sms',
       pipeline_stage='booked',stage_set_by='system',outcome='BOOK',dq_reason=null,is_test=true
     where id=$3 and tenant_id=$4 returning id`,
    [LEAD_NAMES[29], "Booked funding review for an established service business.",
      PHASE6_DEMO_IDS.contact, tenants.phase6Money.id],
  );
  assert(lead.rowCount === 1, "PLATFORM_REVIEW_PHASE6_LEAD_UPDATE_FAILED");
}

async function seedSupportThreads(database, tenants) {
  // Ages are stamped relative to the seed run, so the Attention queue ranks by age instead of
  // showing the same elapsed time on every row.
  const seededAt = Date.now();
  function stampedAt(ageDays) {
    return new Date(seededAt - ageDays * 24 * 60 * 60 * 1000).toISOString();
  }

  const owners = [
    [tenants.phase1.id, DEMO_IDS.coach],
    [tenants.phase6Money.id, PHASE6_DEMO_IDS.moneyCoach],
    [tenants.phase6Affiliate.id, PHASE6_DEMO_IDS.affiliateUser],
    [tenants.phase7.id, PHASE7_DEMO_IDS.coach],
  ];
  assert(owners.length === DEMO_REVIEW_THREADS.length, "PLATFORM_REVIEW_THREAD_FIXTURE_MISMATCH");

  for (let index = 0; index < DEMO_REVIEW_THREADS.length; index += 1) {
    const fixture = DEMO_REVIEW_THREADS[index];
    const [tenantId, createdBy] = owners[index];
    assert(tenantId, "PLATFORM_REVIEW_TENANT_MISSING");
    const updatedAt = stampedAt(fixture.ageDays);
    // The last thread stays unassigned so the queue shows both an owned and an unowned request.
    const assignedTo = index === DEMO_REVIEW_THREADS.length - 1 ? null : PHASE8_DEMO_IDS.success;
    await database.query(
      `insert into public.support_threads
         (id,tenant_id,subject,status,assigned_to,created_by,is_test,created_at,updated_at)
       values ($1,$2,$3,$4,$5,$6,true,$7::timestamptz,$7::timestamptz)
       on conflict (id) do update set tenant_id=excluded.tenant_id,subject=excluded.subject,
         status=excluded.status,assigned_to=excluded.assigned_to,created_by=excluded.created_by,
         is_test=true,created_at=excluded.created_at,updated_at=excluded.updated_at`,
      [PLATFORM_REVIEW_DATA_IDS.threads[index], tenantId, fixture.subject, fixture.status,
        assignedTo, createdBy, updatedAt],
    );

    const messages = [
      [PLATFORM_REVIEW_DATA_IDS.messages[index * 2], createdBy, fixture.coachMessage, false,
        stampedAt(fixture.ageDays + 0.1)],
      [PLATFORM_REVIEW_DATA_IDS.messages[index * 2 + 1], PHASE8_DEMO_IDS.success,
        fixture.staffMessage, fixture.staffInternal, updatedAt],
    ];
    for (const [id, authorId, body, internal, createdAt] of messages) {
      await database.query(
        `insert into public.support_messages
           (id,tenant_id,thread_id,author_id,body,internal,is_test,created_at)
         values ($1,$2,$3,$4,$5,$6,true,$7::timestamptz)
         on conflict (id) do update set tenant_id=excluded.tenant_id,thread_id=excluded.thread_id,
           body=excluded.body,internal=excluded.internal,is_test=true,created_at=excluded.created_at`,
        [id, tenantId, PLATFORM_REVIEW_DATA_IDS.threads[index], authorId, body, internal, createdAt],
      );
    }
  }
}

/**
 * A provisioning tracker with a shape.
 *
 * Every referred tenant is created through `complete_onboarding_signup`, so they all stop on the
 * same `billing / awaiting_platform` step and the tracker printed five byte-identical rows with
 * "Not waiting" in every Waiting cell. Each referral gets a different posture here, including one
 * carrier registration with a real submission receipt, so the honest-state day counter the page
 * exists to show has something to count.
 *
 * `submittedAt` lives in `a2p_campaign.external_ref` because that is where
 * `read_coach_a2p_registration` (20260821000002:174-176) reads it from.
 */
const REVIEW_PROVISIONING_POSTURES = Object.freeze([
  Object.freeze({
    label: "carrier registration in flight",
    steps: Object.freeze([
      ["a2p_brand", "done", null, 26],
      ["a2p_campaign", "awaiting_provider", "carrier", 11],
      ["sms_live", "awaiting_provider", "carrier", 11],
    ]),
    a2pSubmittedDaysAgo: 11,
  }),
  Object.freeze({
    label: "waiting on the coach",
    steps: Object.freeze([
      ["meta_connect", "awaiting_coach", null, 3],
    ]),
    a2pSubmittedDaysAgo: null,
  }),
  Object.freeze({
    label: "a failed step an operator can retry",
    steps: Object.freeze([
      ["ghl_snapshot", "failed", null, 2],
    ]),
    a2pSubmittedDaysAgo: null,
  }),
]);

/**
 * A second coach with a filed correction.
 *
 * Corrections seeded both of its rows against the money tenant, so the Coach column printed one
 * name twice and the page could not show that the queue spans clients. A correction is anchored
 * to a billable event, which is anchored to an appointment, so a second coach needs the whole
 * chain: calendar connection, contact, appointment, billable event, then the request. The two
 * `billable_events` guards (`reset-phase1-demo.mjs:118`, `seed-demo-complete.mjs:787`) both scope
 * their count to `DEMO_IDS.tenant`, so writing this chain on the affiliate tenant leaves them
 * untouched. It is left undecided on purpose: the queue needs something actually waiting.
 */
async function seedSecondCoachCorrection(database, tenants) {
  const tenantId = tenants.phase6Affiliate?.id;
  if (!tenantId) return 0;
  const ids = PLATFORM_REVIEW_DATA_IDS.secondCoach;
  const coachId = PHASE6_DEMO_IDS.affiliateUser;

  await database.query(
    `insert into public.calendar_connections
       (id, tenant_id, provider, external_calendar_id, timezone, state, is_primary)
     values ($1, $2, 'ghl', 'SETTERFI_REVIEW_PLACEHOLDER_CALENDAR', 'America/New_York', 'ready', true)
     on conflict (id) do nothing`,
    [ids.calendar, tenantId],
  );
  await database.query(
    `insert into public.contacts (id, tenant_id, name, email, last_channel, is_test)
     values ($1, $2, $3, 'review-second-coach-lead@example.invalid', 'sms', true)
     on conflict (id) do update set name = excluded.name`,
    [ids.contact, tenantId, LEAD_NAMES[1]],
  );
  const appointment = await database.query(
    `select * from public.record_provider_appointment(
      $1, $2, null, $3, 'ghl', 'SETTERFI_REVIEW_PLACEHOLDER_BOOKING_1',
      '2026-08-21T15:00:00Z'::timestamptz, '2026-08-21T15:30:00Z'::timestamptz,
      'America/New_York', 'agent', true
    )`,
    [tenantId, ids.contact, ids.calendar],
  );
  const appointmentId = appointment.rows[0]?.appointment_id;
  assert(appointmentId, "PLATFORM_REVIEW_SECOND_COACH_APPOINTMENT_MISSING");
  await database.query(
    `insert into public.billable_events (id, tenant_id, appointment_id, quantity, is_test)
     values ($1, $2, $3, 1, true) on conflict (id) do nothing`,
    [ids.billable, tenantId, appointmentId],
  );

  // The audit log is append-only, so a rerun has to find the row it already filed rather than
  // file a second one. The lookup keys on action and target, never on the reason text, because
  // an earlier run's reason stays exactly as it was written.
  const existing = await database.query(
    `select id from public.audit_log
     where action = 'billing.correction.requested' and actor_id = $1 and tenant_id = $2
       and target_type = 'billing_correction_request' and target_id = $3
     order by id limit 1`,
    [coachId, tenantId, ids.correctionRequest],
  );
  const auditId = existing.rows[0]?.id ?? (await database.query(
    `select app.write_audit_row(
      'billing.correction.requested', $1, $2, 'billing_correction_request', $3, $4, $5::jsonb
    ) as id`,
    [coachId, tenantId, ids.correctionRequest,
      DEMO_BILLING_COPY.correctionRequestSecondCoach, JSON.stringify({ demoOnly: true })],
  )).rows[0]?.id;
  assert(auditId, "PLATFORM_REVIEW_SECOND_COACH_AUDIT_MISSING");
  await database.query(
    `insert into public.billing_correction_requests
       (id, tenant_id, billable_event_id, quantity_delta, requested_by, reason, audit_id, created_at)
     values ($1, $2, $3, -1, $4, $5, $6, '2026-08-26T11:05:00Z'::timestamptz)
     -- Append-only under \`app.reject_phase6_append_only\`: an \`on conflict do update\` here raises
     -- BILLING_CORRECTION_REQUESTS_APPEND_ONLY on every rerun. The row's values are deterministic.
     on conflict (id) do nothing`,
    [ids.correctionRequest, tenantId, ids.billable, coachId,
      DEMO_BILLING_COPY.correctionRequestSecondCoach, auditId],
  );
  return 1;
}

/**
 * Cost evidence with something to read.
 *
 * Both seeded rollups were the same client at `revenue_cents = 0`, so the page's whole point --
 * revenue against recorded cost -- reduced to a $0.60 loss on a $0.00 month. These three are one
 * healthy margin, one loss, and one month whose model cost genuinely never arrived, so the honest
 * "Not shown" state has a real figure beside it rather than another zero.
 */
/*
 * Recognised revenue is the rung these three businesses actually subscribe to, never a number of
 * this file's own. The three used to read $497, $297 and $197, which were rungs of the retired
 * five-price ladder, so the admin cost evidence screen priced the same three coaches differently
 * from the admin tier screen and from the affiliate's commission on their invoices.
 *
 * The spread the review needs lives in the costs instead, which is where it belongs: one healthy
 * margin, one month that cost more than it earned, and one whose model cost genuinely never
 * arrived, so the honest "Not shown" state has a real figure beside it rather than another zero.
 */
const REVIEW_SUBSCRIPTION_CENTS = DEMO_TIER_LADDER[1].priceCents;

const REVIEW_COST_ROLLUPS = Object.freeze([
  Object.freeze({
    revenueCents: REVIEW_SUBSCRIPTION_CENTS,
    modelCents: 8_400, messagingCents: 3_100, embeddingCents: 900,
    missingSources: "{}", note: DEMO_BILLING_COPY.costEvidenceComplete,
  }),
  Object.freeze({
    // Costs above the subscription on purpose: the review needs one month that lost money.
    revenueCents: REVIEW_SUBSCRIPTION_CENTS,
    modelCents: 51_200, messagingCents: 9_400, embeddingCents: 1_200,
    missingSources: "{}", note: DEMO_BILLING_COPY.costEvidenceComplete,
  }),
  Object.freeze({
    revenueCents: REVIEW_SUBSCRIPTION_CENTS,
    modelCents: null, messagingCents: 2_600, embeddingCents: 700,
    missingSources: "{model}", note: DEMO_BILLING_COPY.costEvidenceIncomplete,
  }),
]);

async function seedCostEvidence(database, tenants) {
  assert(tenants.referrals.length === REVIEW_COST_ROLLUPS.length,
    "PLATFORM_REVIEW_COST_ROLLUP_MISMATCH");
  // Same closed-month problem the phase 6 seeder has: these rollups carry a rung's price, and a
  // written month can never be restated. `writeCostRollupOnce` writes an unwritten window, leaves
  // an identical one alone, and reports one it cannot correct instead of aborting the reseed.
  let stale = 0;
  for (let index = 0; index < tenants.referrals.length; index += 1) {
    const rollup = REVIEW_COST_ROLLUPS[index];
    const outcome = await writeCostRollupOnce(database, {
      tenantId: tenants.referrals[index].id,
      windowStart: "2026-08-01T00:00:00Z", windowEnd: "2026-09-01T00:00:00Z",
      revenueCents: rollup.revenueCents, modelCents: rollup.modelCents,
      messagingCents: rollup.messagingCents, embeddingCents: rollup.embeddingCents,
      missingSources: rollup.missingSources, evidence: rollup.note,
    });
    if (outcome === "stale") stale += 1;
  }
  return { count: REVIEW_COST_ROLLUPS.length, stale };
}

async function seedProvisioningPostures(database, tenants) {
  assert(tenants.referrals.length === REVIEW_PROVISIONING_POSTURES.length,
    "PLATFORM_REVIEW_PROVISIONING_POSTURE_MISMATCH");
  const seededAt = Date.now();
  const stampedAt = (daysAgo) =>
    new Date(seededAt - daysAgo * 24 * 60 * 60 * 1000).toISOString();

  for (let index = 0; index < tenants.referrals.length; index += 1) {
    const tenant = tenants.referrals[index];
    const posture = REVIEW_PROVISIONING_POSTURES[index];
    for (const [stepKey, state, awaitingParty, daysAgo] of posture.steps) {
      const transitionedAt = stampedAt(daysAgo);
      const externalRef = stepKey === "a2p_campaign" && posture.a2pSubmittedDaysAgo !== null
        ? { arm: "mock", demoOnly: true, submittedAt: stampedAt(posture.a2pSubmittedDaysAgo) }
        : { arm: "mock", demoOnly: true, fixture: `platform-review:${stepKey}` };
      const errorCode = state === "failed" ? "provider_timeout" : null;
      await database.query(
        `insert into public.provisioning_steps (
           tenant_id, step_key, state, awaiting_party, attempts, started_at, last_attempt_at,
           completed_at, error_code, external_ref, next_attempt_at, lease_expires_at,
           last_transition_at, attempt_id, idempotency_key
         ) values (
           $1::uuid, $2::public.provisioning_step, $3::public.provisioning_state,
           $4::public.awaiting_party, $5, $6, $6,
           case when $3::text = 'done' then $6::timestamptz else null end, $7, $8::jsonb,
           $6, null, $6, null, $1::uuid::text || ':' || $2::text
         ) on conflict (tenant_id, step_key) do update set
           state = excluded.state, awaiting_party = excluded.awaiting_party,
           attempts = excluded.attempts, started_at = excluded.started_at,
           last_attempt_at = excluded.last_attempt_at, completed_at = excluded.completed_at,
           error_code = excluded.error_code, error_message = null,
           external_ref = excluded.external_ref, next_attempt_at = excluded.next_attempt_at,
           lease_expires_at = null, last_transition_at = excluded.last_transition_at,
           attempt_id = null, idempotency_key = excluded.idempotency_key`,
        [tenant.id, stepKey, state, awaitingParty, state === "failed" ? 2 : 1, transitionedAt,
          errorCode, JSON.stringify(externalRef)],
      );
    }
    // The lateral join in `provisioning_tracker_rows` picks the highest-priority non-done step, so
    // the seeded billing hold has to clear or it outranks every posture written above.
    await database.query(
      `update public.provisioning_steps
       set state = 'done', awaiting_party = null, completed_at = $2::timestamptz,
         last_transition_at = $2::timestamptz, error_code = null
       where tenant_id = $1 and step_key = 'billing' and state <> 'done'`,
      [tenant.id, stampedAt(30)],
    );
  }
}

export async function readPlatformReviewData(database) {
  const tenants = await reviewTenants(database);
  const tenantIds = tenants.all.map((tenant) => tenant.id);
  // `pg.Client` has one connection, so concurrent `query` calls are queued and now emit a
  // deprecation warning. These are a post-write receipt, not a latency-sensitive read.
  const preview = await database.query(
    "select key,is_demo,snapshot from public.platform_measurement_preview_snapshots where key=$1",
    [SNAPSHOT_KEY],
  );
  const counts = await database.query(
    `select
       (select count(*)::int from public.support_threads where id=any($1::uuid[])) threads,
       (select count(*)::int from public.support_messages where id=any($2::uuid[])) messages`,
    [PLATFORM_REVIEW_DATA_IDS.threads, PLATFORM_REVIEW_DATA_IDS.messages],
  );
  const analytics = await database.query(
    `select
       (select count(*)::int from public.analytics_tenants where tenant_id=any($1::uuid[])) tenants,
       (select count(*)::int from public.analytics_contacts where tenant_id=any($1::uuid[])) contacts,
       (select count(*)::int from public.analytics_conversations where tenant_id=any($1::uuid[])) conversations`,
    [tenantIds],
  );
  const contacts = await database.query(
    `select id,tenant_id,name,pipeline_stage,merged_into_contact_id
     from public.contacts where tenant_id=any($1::uuid[]) order by tenant_id,id`,
    [[tenants.phase1.id, tenants.phase6Money.id, tenants.phase7.id]],
  );
  return {
    preview: preview.rows[0] ?? null,
    counts: counts.rows[0],
    analytics: analytics.rows[0],
    tenants: tenants.all,
    contacts: contacts.rows,
  };
}

export function assertPlatformReviewData(snapshot) {
  assert(snapshot.preview?.key === SNAPSHOT_KEY && snapshot.preview.is_demo === true,
    "PLATFORM_REVIEW_PREVIEW_READBACK_INVALID", snapshot.preview);
  assert(Array.isArray(snapshot.preview.snapshot?.metrics)
    && snapshot.preview.snapshot.metrics.length === PLATFORM_METRIC_KEYS.length,
  "PLATFORM_REVIEW_METRIC_SNAPSHOT_INVALID");
  assert(snapshot.counts.threads === 4 && snapshot.counts.messages === 8,
    "PLATFORM_REVIEW_SUPPORT_COUNTS_INVALID", snapshot.counts);
  assert(Object.values(snapshot.analytics).every((value) => value === 0),
    "PLATFORM_REVIEW_ANALYTICS_SEGREGATION_FAILED", snapshot.analytics);
  const tenantNames = snapshot.tenants.map((tenant) => tenant.name);
  assert(COACH_NAMES.every((name) => tenantNames.includes(name)),
    "PLATFORM_REVIEW_COACH_NAMES_MISSING", tenantNames);
  /*
   * Display-name uniqueness is a fact about one coach's book, not about the whole database.
   * This used to compare the three review tenants as one list, which was fine until
   * `seed-showcase-leads.mjs` began writing the same two hundred lead names into two of them.
   * Two coaches each having a client named Priya Raghunathan is what a real book of clients looks
   * like; a coach seeing the same name twice in their own list is the defect worth catching.
   */
  for (const tenantId of new Set(snapshot.contacts.map((contact) => contact.tenant_id))) {
    assertUniqueDisplayNames(
      snapshot.contacts.filter((contact) => contact.tenant_id === tenantId)
        .map((contact) => contact.name ?? ""),
      "PLATFORM_REVIEW_CONTACT_DISPLAY_NAMES_NOT_UNIQUE",
    );
  }
  assert(!snapshot.contacts.some((contact) => /^(demo|test|synthetic|setterfi)\b/i.test(contact.name ?? "")),
    "PLATFORM_REVIEW_CONTACT_STATE_NAME_VISIBLE");
  /*
   * The stage spread below is calibrated to the curated review book of about seventeen and fails
   * the moment one stage holds fifteen, so it is measured over those rows alone. The two hundred
   * showcase leads are a separate dataset with a distribution of their own, exactly as
   * `seed-phase1-demo.mjs` already excludes them from the same check.
   */
  const phase1Contacts = snapshot.contacts.filter((contact) =>
    contact.tenant_id === DEMO_IDS.tenant && contact.merged_into_contact_id === null
    && !isShowcaseLeadId(contact.id));
  const stageCounts = Object.fromEntries(PIPELINE_STAGES.map((stage) => [stage, 0]));
  for (const contact of phase1Contacts) stageCounts[contact.pipeline_stage] += 1;
  const counts = Object.values(stageCounts);
  assert(counts.every((count) => count > 0) && counts.filter((count) => count >= 2).length >= 5
    && Math.max(...counts) < 15,
  "PLATFORM_REVIEW_PIPELINE_DISTRIBUTION_INVALID", stageCounts);
  return snapshot;
}

export async function seedPlatformReviewData({ argumentsList = process.argv.slice(2), quiet = false } = {}) {
  await seedPhase8Demo({ argumentsList, quiet: true });
  // Existing Phase 6 gap coverage owns the synthetic tier, subscription, and affiliate rows.
  // Include it here so a reviewer needs one command for every non-UI populated surface.
  await seedDemoGaps({ argumentsList, quiet: true });
  const target = resolveDemoTarget(argumentsList);
  if (!target.databaseUrl) throw new Error("SUPABASE_DB_PASSWORD_REQUIRED_FOR_PLATFORM_REVIEW_SEED");
  const database = new pg.Client({ connectionString: target.databaseUrl });
  await database.connect();
  try {
    await database.query("begin");
    const tenants = await reviewTenants(database);
    await seedPlatformTenantNames(database, tenants);
    await database.query(
      `insert into public.platform_measurement_preview_snapshots (key,snapshot,is_demo,seeded_at,updated_at)
       values ($1,$2::jsonb,true,now(),now())
       on conflict (key) do update set snapshot=excluded.snapshot,is_demo=true,updated_at=now()`,
      [SNAPSHOT_KEY, JSON.stringify(platformReviewSnapshot(
        tenants.referrals.map((tenant) => tenant.id),
      ))],
    );
    await seedSupportThreads(database, tenants);
    await seedProvisioningPostures(database, tenants);
    await seedSecondCoachCorrection(database, tenants);
    const costEvidence = await seedCostEvidence(database, tenants);
    const snapshot = assertPlatformReviewData(await readPlatformReviewData(database));
    await database.query("commit");
    if (!quiet) {
      console.log(`Platform review seed: preview=synthetic metrics=${PLATFORM_METRIC_KEYS.length} `
        + `support_threads=${snapshot.counts.threads} analytics_contamination=0 `
        + `stale_cost_rollups=${costEvidence.stale}`);
    }
    return snapshot;
  } catch (error) {
    await database.query("rollback");
    throw error;
  } finally {
    await database.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedPlatformReviewData().catch((error) => {
    console.error(error instanceof Error ? error.message : "PLATFORM_REVIEW_SEED_FAILED");
    process.exitCode = 1;
  });
}
