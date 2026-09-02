/** Deterministic, credential-free Phase 6 money story on labelled demo tenants. */

import { pathToFileURL } from "node:url";

import pg from "pg";

import { resolveDemoTarget } from "./seed-phase1-demo.mjs";
import { seedPhase5Demo } from "./seed-phase5-demo.mjs";
import {
  DEMO_TIER_LADDER,
  DEMO_BILLING_COPY,
  DEMO_BUSINESS_NAMES,
  DEMO_FAIR_USE_NOTE,
  DEMO_LEAD_NAMES,
  DEMO_PERSON_NAMES,
} from "./fixtures/names.mjs";

const PHASE2_ADMIN_ID = "82000000-0000-4000-8000-000000000001";

export const PHASE6_DEMO_IDS = Object.freeze({
  tiers: Object.freeze([
    "86000000-0000-4000-8000-000000000001",
    "86000000-0000-4000-8000-000000000002",
    "86000000-0000-4000-8000-000000000003",
  ]),
  affiliateIntent: "86000000-0000-4000-8000-000000000004",
  affiliateUser: "86000000-0000-4000-8000-000000000005",
  moneyIntent: "86000000-0000-4000-8000-000000000006",
  moneyCoach: "86000000-0000-4000-8000-000000000007",
  calendar: "86000000-0000-4000-8000-000000000008",
  contact: "86000000-0000-4000-8000-000000000009",
  billables: Object.freeze([
    "86000000-0000-4000-8000-000000000010",
    "86000000-0000-4000-8000-000000000011",
    "86000000-0000-4000-8000-000000000012",
    "86000000-0000-4000-8000-000000000013",
  ]),
  correctionRequests: Object.freeze([
    "86000000-0000-4000-8000-000000000014",
    "86000000-0000-4000-8000-000000000015",
  ]),
  correctionDecisions: Object.freeze([
    "86000000-0000-4000-8000-000000000016",
    "86000000-0000-4000-8000-000000000017",
  ]),
  correctionOffset: "86000000-0000-4000-8000-000000000018",
  allowanceNotice: "86000000-0000-4000-8000-000000000019",
});

export const PHASE6_DEMO_VALUES = Object.freeze({
  affiliateSlug: "setterfi-demo-placeholder-affiliate",
  moneySlug: "setterfi-demo-placeholder-money",
  affiliateEmail: "phase6-affiliate@example.invalid",
  moneyEmail: "phase6-money@example.invalid",
  checkoutKey: "SETTERFI_DEMO_PLACEHOLDER_CHECKOUT_KEY",
  checkoutSession: "SETTERFI_DEMO_PLACEHOLDER_STRIPE_SESSION",
  customer: "SETTERFI_DEMO_PLACEHOLDER_STRIPE_CUSTOMER",
  subscription: "SETTERFI_DEMO_PLACEHOLDER_STRIPE_SUBSCRIPTION",
  suspendedCustomer: "SETTERFI_DEMO_PLACEHOLDER_SUSPENDED_CUSTOMER",
  suspendedSubscription: "SETTERFI_DEMO_PLACEHOLDER_SUSPENDED_SUBSCRIPTION",
  invoices: Object.freeze([
    "SETTERFI_DEMO_PLACEHOLDER_INVOICE_ONE",
    "SETTERFI_DEMO_PLACEHOLDER_INVOICE_TWO",
  ]),
  bookingPrefix: "SETTERFI_DEMO_PLACEHOLDER_BOOKING_",
});

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

async function setClaims(database, claims) {
  await database.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: claims.sub, app_metadata: claims }),
  ]);
}

/**
 * One ladder rung per tier row. Price and allowance are part of the update set on purpose: a
 * re-run against a database seeded before the ladder existed has to correct the old `$0.00` rows
 * rather than leave them standing.
 */
/** The sentinel every seeded tier price id carries, and the only value this seeder will release. */
/*
 * `PHASE6_DEMO_IDS.tiers` and the ladder's own ids are the same three uuids, and several rows below
 * still reference them through this object -- the money tenant's subscription, its signup intent
 * and the allowance notice. They are asserted equal rather than assumed: editing one list and not
 * the other would leave those rows pointing at a tier this seeder never writes, which the database
 * would accept as a foreign key to a row some other run happened to create.
 */
if (PHASE6_DEMO_IDS.tiers.length !== DEMO_TIER_LADDER.length
  || PHASE6_DEMO_IDS.tiers.some((id, index) => id !== DEMO_TIER_LADDER[index].id)) {
  throw new Error("PHASE6_DEMO_TIER_IDS_DIVERGED_FROM_LADDER");
}

export const DEMO_TIER_PRICE_PREFIX = "SETTERFI_DEMO_PLACEHOLDER_PRICE_";

export function demoTierPriceId(rung) {
  // Provider identity, never copy: derived from the rung name without its `(demo)` marker, so
  // `PRICE_STARTER` stays `PRICE_STARTER`.
  return `${DEMO_TIER_PRICE_PREFIX}${rung.name.replace(/\s*\(demo\)$/u, "").toUpperCase()}`;
}

/**
 * The stamp to write a subscription snapshot under.
 *
 * `apply_billing_subscription_snapshot` treats two different snapshots stamped the same instant as
 * a contradiction and raises STRIPE_SUBSCRIPTION_TIMESTAMP_COLLISION, which is right for a provider
 * webhook and fatal for a seeder that writes one fixed stamp. A database seeded before the ladder
 * changed holds the old price under this seeder's stamp, so reseeding it aborts the whole chain
 * rather than converging, and that is what production hit.
 *
 * A provider that actually changed the subscription would send a later stamp, so this does too, and
 * only then: when the stored snapshot already agrees, the fixed stamp is returned unchanged and the
 * write stays a no-op. The bump is one second past whichever stamp is later, so it is a function of
 * the database's own state rather than the wall clock, and rerunning converges instead of drifting.
 */
export async function snapshotStampFor(database, tenantId, desired, fixedStamp) {
  const existing = (await database.query(
    `select stripe_price_id, status::text as status, current_period_start, current_period_end,
            cancel_at_period_end, provider_updated_at
     from public.billing_subscriptions where tenant_id = $1`,
    [tenantId],
  )).rows[0];
  if (!existing) return fixedStamp;
  const agrees = existing.stripe_price_id === desired.priceId
    && existing.status === desired.status
    && existing.current_period_start.toISOString() === new Date(desired.periodStart).toISOString()
    && existing.current_period_end.toISOString() === new Date(desired.periodEnd).toISOString()
    && existing.cancel_at_period_end === desired.cancelAtPeriodEnd;
  // Agreeing means there is nothing to say, so the snapshot is restated under the stamp it already
  // carries. Restating it under the fixed one would be a stale snapshot the moment a previous run
  // has bumped it, which is the same seeder failing on its own output.
  if (agrees) return existing.provider_updated_at.toISOString();
  const later = Math.max(
    existing.provider_updated_at.getTime(),
    new Date(fixedStamp).getTime(),
  );
  return new Date(later + 1000).toISOString();
}

/**
 * Write a cost rollup only when the window is genuinely unwritten.
 *
 * A rollup is the one record in this schema with no correction path at all. Its window is unique
 * per tenant, `write_tenant_cost_rollup` raises COST_ROLLUP_REPLAY_MISMATCH on any differing
 * replay, and `app.reject_phase6_append_only` refuses every update and delete against the table,
 * including the cascade from deleting the tenant. A month, once computed, is final. That is the
 * right shape for a cost ledger and it is why reseeding a database that holds an older ladder used
 * to abort here: the seeder was asking to restate a closed month, which nothing in the product can
 * do.
 *
 * So this asks first. An unwritten window is written. A window already holding these exact figures
 * is left alone, which is the rerun case. A window holding different figures is reported and
 * skipped rather than raised on, because the seeder cannot correct it and stopping the whole chain
 * over a closed month helps nobody. The returned count of stale windows is surfaced in the
 * seeder's read-back line so an operator sees what was left standing rather than assuming it
 * converged.
 */
export async function writeCostRollupOnce(database, rollup) {
  const existing = (await database.query(
    `select recognized_subscription_cents, model_cents, messaging_cents, embedding_cents
     from public.tenant_cost_rollups
     where tenant_id = $1 and window_start = $2::timestamptz and window_end = $3::timestamptz`,
    [rollup.tenantId, rollup.windowStart, rollup.windowEnd],
  )).rows[0];
  const same = (stored, wanted) =>
    (stored === null ? null : Number(stored)) === (wanted ?? null);
  if (existing) {
    const agrees = same(existing.recognized_subscription_cents, rollup.revenueCents)
      && same(existing.model_cents, rollup.modelCents)
      && same(existing.messaging_cents, rollup.messagingCents)
      && same(existing.embedding_cents, rollup.embeddingCents);
    return agrees ? "unchanged" : "stale";
  }
  await database.query(
    `select * from public.write_tenant_cost_rollup(
      $1, $2::timestamptz, $3::timestamptz, $4, $5, $6, $7, $8::text[],
      jsonb_build_object('source', $9::text)
    )`,
    [rollup.tenantId, rollup.windowStart, rollup.windowEnd, rollup.revenueCents,
      rollup.modelCents, rollup.messagingCents, rollup.embeddingCents,
      rollup.missingSources ?? "{}", rollup.evidence],
  );
  return "written";
}

/**
 * `tiers.stripe_price_id` is globally unique, and which ladder rung each frozen tier id carries has
 * changed over the life of these seeds — `tiers[1]` used to be Growth and is now Scale. On a
 * database that still holds the old mapping, writing the new price id onto one row while a stale row
 * still holds it violates `tiers_stripe_price_id_key` and aborts the whole chain, which is why a
 * fresh local reset never sees it and every hosted rerun does.
 *
 * So the price ids this seeder is about to write are released from any row that is not their
 * intended owner, first. Every one of them carries the `SETTERFI_DEMO_PLACEHOLDER_PRICE_` sentinel,
 * so this can only ever touch this seeder's own past output — a real Stripe price id never matches.
 */
async function releaseStaleTierPriceIds(database, owners) {
  const result = await database.query(
    `update public.tiers row set stripe_price_id = null
     from unnest($1::text[], $2::uuid[]) as want(price_id, owner_id)
     where row.stripe_price_id = want.price_id and row.id <> want.owner_id
       and row.stripe_price_id like $3`,
    [owners.map((owner) => owner.priceId), owners.map((owner) => owner.id),
      `${DEMO_TIER_PRICE_PREFIX.replaceAll("_", "\\_")}%`],
  );
  return result.rowCount ?? 0;
}

async function ensureTier(database, id, rung) {
  await database.query(
    `insert into public.tiers
       (id, name, price_cents, call_allowance, fair_use_cap, is_uncapped, stripe_price_id, active,
        fair_use_note)
     values ($1, $2, $3, $4, $5, $6, $7, true, $8)
     on conflict (id) do update set name = excluded.name, price_cents = excluded.price_cents,
       call_allowance = excluded.call_allowance, fair_use_cap = excluded.fair_use_cap,
       is_uncapped = excluded.is_uncapped, stripe_price_id = excluded.stripe_price_id, active = true,
       fair_use_note = excluded.fair_use_note`,
    [
      id,
      rung.name,
      rung.priceCents,
      rung.callAllowance,
      rung.fairUseCap,
      rung.isUncapped,
      demoTierPriceId(rung),
      DEMO_FAIR_USE_NOTE,
    ],
  );
}

async function ensureSignup(database, {
  intentId, userId, email, business, person, slug, tierId, referralCode = null, affiliateOptIn = false,
}) {
  await database.query(
    `insert into public.signup_intents (id, auth_user_id, email, tier_id, timezone, referral_code, state)
     values ($1, $2, $3, $4, 'America/New_York', $5, 'started')
     on conflict (id) do nothing`,
    [intentId, userId, email, tierId, referralCode],
  );
  const result = await database.query(
    `select * from public.complete_onboarding_signup(
       $1, $1, $2, $3, $4, $5, $6, 'America/New_York', $7, $8
     )`,
    [userId, email, person, business, slug, tierId, referralCode, affiliateOptIn],
  );
  const tenantId = result.rows[0]?.tenant_id;
  assert(tenantId, "PHASE6_DEMO_SIGNUP_FAILED");
  await database.query(
    `update public.tenants set is_demo = true, status = 'active' where id = $1 and is_demo = false`,
    [tenantId],
  );
  // `complete_onboarding_signup` returns early once the intent is completed, so a tenant seeded
  // before the readable-copy pass would keep its old sentinel name. Rewrite the display columns.
  await database.query(
    `update public.tenants set name = $2, billing_contact_name = $3 where id = $1`,
    [tenantId, business, person],
  );
  await database.query(
    `update public.users set full_name = $2 where id = $1`, [userId, person],
  );
  return tenantId;
}

async function ensureAudit(database, { action, actorId, tenantId, targetType, targetId, reason }) {
  const existing = await database.query(
    `select id from public.audit_log
     where action = $1 and actor_id = $2 and tenant_id = $3 and target_type = $4 and target_id = $5
     order by id limit 1`,
    [action, actorId, tenantId, targetType, targetId],
  );
  // The audit log is append-only (`AUDIT_LOG_APPEND_ONLY`), so a reason written by an earlier
  // seed run stays exactly as it was filed. That is the point of an audit log, and it is why the
  // lookup keys on action and target rather than on the reason text.
  if (existing.rows[0]) return existing.rows[0].id;
  const inserted = await database.query(
    `select app.write_audit_row($1, $2, $3, $4, $5, $6, $7::jsonb) as id`,
    [action, actorId, tenantId, targetType, targetId, reason, JSON.stringify({ demoOnly: true })],
  );
  return inserted.rows[0].id;
}

/**
 * Correction requests, their decisions, and billable adjustments are append-only ledger rows
 * (`app.reject_phase6_append_only`), so a run cannot rewrite copy an earlier run filed. A demo
 * database that still holds the old sentinel reasons is cleared with `npm run demo:reset-phase6`
 * before this reseeds, which is the only honest way to change a filed reason.
 */
async function ensureCorrections(database, tenantId) {
  const adminId = PHASE2_ADMIN_ID;
  for (let index = 0; index < 2; index += 1) {
    const requestId = PHASE6_DEMO_IDS.correctionRequests[index];
    // One filed each way, two days apart. Both rows used to be a `-1` with the same reason and
    // the same timestamp, which read as the table rendering one row twice and left the Direction
    // facet with a single value.
    const delta = index === 0 ? -1 : 2;
    const reason = index === 0
      ? DEMO_BILLING_COPY.correctionRequest
      : DEMO_BILLING_COPY.correctionRequestIncrease;
    const requestAudit = await ensureAudit(database, {
      action: "billing.correction.requested",
      actorId: PHASE6_DEMO_IDS.moneyCoach,
      tenantId,
      targetType: "billing_correction_request",
      targetId: requestId,
      reason,
    });
    await database.query(
      `insert into public.billing_correction_requests
         (id, tenant_id, billable_event_id, quantity_delta, requested_by, reason, audit_id,
          created_at)
       values ($1, $2, $3, $7, $4, $6, $5, $8::timestamptz)
       -- \`billing_correction_requests\` is append-only (\`app.reject_phase6_append_only\`), so a
       -- rerun cannot refresh this row; the values are deterministic and the row already matches.
       on conflict (id) do nothing`,
      [requestId, tenantId, PHASE6_DEMO_IDS.billables[index], PHASE6_DEMO_IDS.moneyCoach, requestAudit,
        reason, delta, index === 0 ? "2026-08-24T15:20:00Z" : "2026-08-22T09:40:00Z"],
    );
    if (index === 0) {
      await database.query(
        `insert into public.billable_events
           (id, tenant_id, quantity, adjusted_by, adjust_reason, is_test, adjusts_event_id)
         values ($1, $2, -1, $3, $5, true, $4)
         on conflict (id) do nothing`,
        [PHASE6_DEMO_IDS.correctionOffset, tenantId, adminId, PHASE6_DEMO_IDS.billables[index],
          DEMO_BILLING_COPY.correctionApproved],
      );
    }
    const action = index === 0 ? "billing.correction.approved" : "billing.correction.rejected";
    const decisionAudit = await ensureAudit(database, {
      action,
      actorId: adminId,
      tenantId,
      targetType: "billing_correction_request",
      targetId: requestId,
      reason: index === 0 ? DEMO_BILLING_COPY.correctionApproved : DEMO_BILLING_COPY.correctionRejected,
    });
    await database.query(
      `insert into public.billing_correction_decisions
         (id, request_id, decision, decided_by, reason, offset_event_id, audit_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (id) do nothing`,
      [
        PHASE6_DEMO_IDS.correctionDecisions[index], requestId,
        index === 0 ? "approved" : "rejected", adminId,
        index === 0 ? DEMO_BILLING_COPY.correctionApproved : DEMO_BILLING_COPY.correctionRejected,
        index === 0 ? PHASE6_DEMO_IDS.correctionOffset : null, decisionAudit,
      ],
    );
  }
}

async function readBack(database, tenantId, affiliateTenantId) {
  return (await database.query(
    `select
      (select count(*)::int from public.tiers where id = any($1::uuid[])) tiers,
      (select count(*)::int from public.tenants where id = any($2::uuid[]) and is_demo) demo_tenants,
      (select count(*)::int from public.referrals where tenant_id = $3) referrals,
      (select count(*)::int from public.stripe_checkout_sessions where tenant_id = $3) checkouts,
      (select count(*)::int from public.billing_subscriptions where tenant_id = any($2::uuid[])) subscriptions,
      (select count(*)::int from public.appointments where tenant_id = $3 and attributed_to_agent) appointments,
      (select count(*)::int from public.billable_events where tenant_id = $3 and adjusts_event_id is null) billables,
      (select count(*)::int from public.billing_correction_requests where tenant_id = $3) correction_requests,
      (select count(*)::int from public.billing_correction_decisions d
        join public.billing_correction_requests r on r.id = d.request_id where r.tenant_id = $3) correction_decisions,
      (select count(*)::int from public.allowance_actions where tenant_id = $3) allowance_actions,
      (select count(*)::int from public.commission_ledger l join public.referrals r on r.id = l.referral_id
        where r.tenant_id = $3) ledger_entries,
      (select count(*)::int from public.commission_payout_events e join public.commission_payouts p on p.id = e.payout_id
        join public.affiliates a on a.id = p.affiliate_id where a.user_id = $4) payout_events,
      (select count(*)::int from public.tenant_cost_rollups where tenant_id = $3) cost_rollups,
      (select status::text from public.tenants where id = $3) money_status,
      (select status::text from public.tenants where id = $5) suspended_status`,
    [
      PHASE6_DEMO_IDS.tiers,
      [tenantId, affiliateTenantId],
      tenantId,
      PHASE6_DEMO_IDS.affiliateUser,
      affiliateTenantId,
    ],
  )).rows[0];
}

export async function seedPhase6Demo({ argumentsList = process.argv.slice(2) } = {}) {
  if (argumentsList.includes("--verify-idempotent")) {
    const { verifyPhase6Demo } = await import("./run-phase6-demo.mjs");
    return verifyPhase6Demo({ argumentsList });
  }
  await seedPhase5Demo({ argumentsList });
  const target = resolveDemoTarget(argumentsList);
  if (!target.databaseUrl) throw new Error("SUPABASE_DB_PASSWORD_REQUIRED_FOR_HOSTED_PHASE6_SEED");
  const database = new pg.Client({ connectionString: target.databaseUrl });
  await database.connect();
  let staleRollups = 0;
  try {
    await database.query("begin");
    /*
     * The ladder is the client's three contracted tiers and it now owns its own ids, which are
     * these three -- so this is the whole price list rather than three rungs of five. The gaps seed
     * and the phase 5 signup tier upsert rungs out of the same array against the same ids instead
     * of minting a fourth and fifth row, and each deactivates the id it used to mint.
     *
     * Two rungs' price ids move rows in this change (`PRICE_SCALE` from `tiers[1]` to `tiers[2]`,
     * `PRICE_GROWTH` onto `tiers[1]`), and `tiers.stripe_price_id` is globally unique, so the
     * release below is load-bearing on any database seeded before the collapse rather than
     * defensive.
     */
    const tierOwners = DEMO_TIER_LADDER.map((rung) => ({
      id: rung.id,
      rung,
      priceId: demoTierPriceId(rung),
    }));
    await releaseStaleTierPriceIds(database, tierOwners);
    for (const owner of tierOwners) await ensureTier(database, owner.id, owner.rung);

    const affiliateTenantId = await ensureSignup(database, {
      intentId: PHASE6_DEMO_IDS.affiliateIntent,
      userId: PHASE6_DEMO_IDS.affiliateUser,
      email: PHASE6_DEMO_VALUES.affiliateEmail,
      business: DEMO_BUSINESS_NAMES.affiliatePortfolio,
      person: DEMO_PERSON_NAMES.affiliateOwner,
      slug: PHASE6_DEMO_VALUES.affiliateSlug,
      tierId: PHASE6_DEMO_IDS.tiers[0],
      affiliateOptIn: true,
    });
    const referralCode = `SF-${PHASE6_DEMO_IDS.affiliateUser.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
    const moneyTenantId = await ensureSignup(database, {
      intentId: PHASE6_DEMO_IDS.moneyIntent,
      userId: PHASE6_DEMO_IDS.moneyCoach,
      email: PHASE6_DEMO_VALUES.moneyEmail,
      business: DEMO_BUSINESS_NAMES.moneyStory,
      person: DEMO_PERSON_NAMES.moneyCoach,
      slug: PHASE6_DEMO_VALUES.moneySlug,
      tierId: PHASE6_DEMO_IDS.tiers[0],
      referralCode,
    });
    const referral = await database.query(
      `select id from public.referrals where tenant_id = $1`,
      [moneyTenantId],
    );
    assert(referral.rowCount === 1, "PHASE5_REFERRAL_ATTRIBUTION_MISSING");

    await database.query(
      `insert into public.calendar_connections
         (id, tenant_id, provider, external_calendar_id, timezone, state, is_primary)
       values ($1, $2, 'ghl', 'SETTERFI_DEMO_PLACEHOLDER_CALENDAR', 'America/New_York', 'ready', true)
       on conflict (id) do nothing`,
      [PHASE6_DEMO_IDS.calendar, moneyTenantId],
    );
    await database.query(
      `insert into public.contacts (id, tenant_id, name, email, last_channel, is_test)
       values ($1, $2, $3, 'phase6-lead@example.invalid', 'sms', true)
       on conflict (id) do update set name = excluded.name`,
      [PHASE6_DEMO_IDS.contact, moneyTenantId, DEMO_LEAD_NAMES.moneyStory],
    );
    for (let index = 0; index < PHASE6_DEMO_IDS.billables.length; index += 1) {
      const appointment = await database.query(
        `select * from public.record_provider_appointment(
          $1, $2, null, $3, 'ghl', $4,
          $5::timestamptz, $6::timestamptz, 'America/New_York', 'agent', true
        )`,
        [
          moneyTenantId, PHASE6_DEMO_IDS.contact, PHASE6_DEMO_IDS.calendar,
          `${PHASE6_DEMO_VALUES.bookingPrefix}${index + 1}`,
          `2026-08-${10 + index}T14:00:00Z`, `2026-08-${10 + index}T14:30:00Z`,
        ],
      );
      const appointmentId = appointment.rows[0]?.appointment_id;
      assert(appointmentId, "PHASE6_DEMO_APPOINTMENT_MISSING");
      await database.query(
        `insert into public.billable_events (id, tenant_id, appointment_id, quantity, is_test)
         values ($1, $2, $3, 1, true) on conflict (id) do nothing`,
        [PHASE6_DEMO_IDS.billables[index], moneyTenantId, appointmentId],
      );
      if (index === 0) {
        await database.query(
          `select public.record_appointment_attendance($1, $2, 'completed', 'coach', $3)`,
          [moneyTenantId, appointmentId, PHASE6_DEMO_IDS.moneyCoach],
        );
      }
    }
    await ensureCorrections(database, moneyTenantId);

    await database.query(
      `select * from public.record_stripe_checkout_session(
        $1, $2, $3, $4, $5, $6, $7, 'completed', '2026-08-02T00:00:00Z', '2026-08-01T00:00:00Z'
      )`,
      [
        moneyTenantId, PHASE6_DEMO_IDS.moneyCoach, PHASE6_DEMO_IDS.tiers[0],
        PHASE6_DEMO_VALUES.checkoutKey, PHASE6_DEMO_VALUES.checkoutSession,
        PHASE6_DEMO_VALUES.customer, PHASE6_DEMO_VALUES.subscription,
      ],
    );
    const firstMoneyPass = (await database.query(
      `select not exists(select 1 from public.billing_subscriptions where tenant_id = $1) as first_pass`,
      [moneyTenantId],
    )).rows[0].first_pass;
    if (firstMoneyPass) {
      await database.query(
        `select * from public.apply_billing_subscription_snapshot(
          $1, $2, $3, $4, 'active', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', false,
          '2026-08-01T00:00:01Z'
        )`,
        // Derived from the rung, never written out: a literal here and a `demoTierPriceId` there
        // are two spellings of one identity, and only one of them moves when the ladder does.
        [moneyTenantId, PHASE6_DEMO_VALUES.customer, PHASE6_DEMO_VALUES.subscription,
          demoTierPriceId(DEMO_TIER_LADDER[0])],
      );
      for (let index = 0; index < PHASE6_DEMO_VALUES.invoices.length; index += 1) {
        await database.query(
          `select * from public.apply_stripe_invoice_paid(
            $1, $2, $3, $4::timestamptz, $5, $6, $7::timestamptz
          )`,
          [
            moneyTenantId, PHASE6_DEMO_VALUES.subscription, PHASE6_DEMO_VALUES.invoices[index],
            `2026-08-${5 + index * 10}T00:00:00Z`,
            // A paid month is this tenant's own subscription price, never an invented figure.
            // These were $11.00 and $22.00 against a coach the tier screen prices at $297, so the
            // affiliate's commission on them was a tenth of a number nothing on the platform sold.
            DEMO_TIER_LADDER[0].priceCents, DEMO_TIER_LADDER[0].priceCents,
            `2026-08-${5 + index * 10}T00:00:01Z`,
          ],
        );
      }
      await database.query(
        `select * from public.reverse_invoice_commission($1, $2, $3, 'refund', 900, '2026-08-16T00:00:00Z')`,
        [moneyTenantId, PHASE6_DEMO_VALUES.invoices[0], "SETTERFI_DEMO_PLACEHOLDER_REFUND"],
      );
      await database.query(
        `select * from public.reverse_invoice_commission($1, $2, $3, 'dispute_loss', 600, '2026-08-17T00:00:00Z')`,
        [moneyTenantId, PHASE6_DEMO_VALUES.invoices[0], "SETTERFI_DEMO_PLACEHOLDER_DISPUTE"],
      );
      await database.query(
        `select * from public.reverse_invoice_commission($1, $2, $3, 'dispute_recovery', 400, '2026-08-18T00:00:00Z')`,
        [moneyTenantId, PHASE6_DEMO_VALUES.invoices[0], "SETTERFI_DEMO_PLACEHOLDER_RECOVERY"],
      );
    }

    const affiliate = (await database.query(
      `select id from public.affiliates where user_id = $1`, [PHASE6_DEMO_IDS.affiliateUser],
    )).rows[0];
    const payable = (await database.query(
      `select l.id from public.commission_ledger l
       join public.referrals r on r.id = l.referral_id
       left join public.commission_payout_items i on i.ledger_id = l.id
       where r.tenant_id = $1 and l.stripe_invoice_id = $2 and l.entry_kind = 'accrual' and i.ledger_id is null`,
      [moneyTenantId, PHASE6_DEMO_VALUES.invoices[1]],
    )).rows[0];
    if (payable) {
      await setClaims(database, { role: "admin", sub: PHASE2_ADMIN_ID });
      const payout = await database.query(
        `select * from public.approve_commission_payout($1, $2, $3, $4)`,
        [PHASE2_ADMIN_ID, affiliate.id, [payable.id], DEMO_BILLING_COPY.payoutApproval],
      );
      await database.query(
        `select * from public.record_commission_payout_sent($1, $2, $3, '2026-08-19')`,
        [PHASE2_ADMIN_ID, payout.rows[0].payout_id, DEMO_BILLING_COPY.payoutReference],
      );
    }
    // `commission_payout_events` is append-only too, so a reference filed by an earlier run is
    // cleared by `npm run demo:reset-phase6`, never rewritten in place.

    await database.query(
      `select * from public.record_allowance_action(
        $1, '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', 'warning', 3, 3,
        null, null, null, null, 'pending'
      )`,
      [moneyTenantId],
    );
    await database.query(
      `insert into public.notifications (id, tenant_id, user_id, kind, title, body)
       values ($1, $2, $3, 'billing.allowance_crossed', $4, $5)
       on conflict (id) do update set title = excluded.title, body = excluded.body`,
      [PHASE6_DEMO_IDS.allowanceNotice, moneyTenantId, PHASE6_DEMO_IDS.moneyCoach,
        DEMO_BILLING_COPY.allowanceNoticeTitle, DEMO_BILLING_COPY.allowanceNoticeBody],
    );
    await database.query(
      `select * from public.record_allowance_action(
        $1, '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', 'crossing', 3, 4,
        $2, '2026-09-01T00:00:00Z', $3, 'SETTERFI_DEMO_PLACEHOLDER_SCHEDULE', 'scheduled'
      )`,
      [moneyTenantId, PHASE6_DEMO_IDS.tiers[1], PHASE6_DEMO_IDS.allowanceNotice],
    );
    /*
     * July is the month this tenant paid for, so recognised revenue is the rung it subscribes to
     * rather than zero. It read $0.00 against sixty cents of cost, which made the admin cost
     * evidence screen look broken rather than informative. August below stays at zero, and that
     * one is honest: `apply_stripe_invoice_failed` runs against it, so nothing was recognised.
     */
    const rollupOutcomes = [
      await writeCostRollupOnce(database, {
        tenantId: moneyTenantId,
        windowStart: "2026-07-01T00:00:00Z", windowEnd: "2026-08-01T00:00:00Z",
        revenueCents: DEMO_TIER_LADDER[0].priceCents,
        modelCents: 7300, messagingCents: 2800, embeddingCents: 600,
        evidence: "SETTERFI_DEMO_PLACEHOLDER_COMPLETE",
      }),
      await writeCostRollupOnce(database, {
        tenantId: moneyTenantId,
        windowStart: "2026-08-01T00:00:00Z", windowEnd: "2026-09-01T00:00:00Z",
        revenueCents: 0, modelCents: 10, messagingCents: null, embeddingCents: null,
        missingSources: "{messaging,embedding}",
        evidence: "SETTERFI_DEMO_PLACEHOLDER_INCOMPLETE",
      }),
    ];
    staleRollups = rollupOutcomes.filter((outcome) => outcome === "stale").length;
    if (firstMoneyPass) {
      await database.query(
        `select * from public.apply_stripe_invoice_failed(
          $1, $2, 'SETTERFI_DEMO_PLACEHOLDER_FAILED_INVOICE', '2026-08-25T00:00:00Z'
        )`,
        [moneyTenantId, PHASE6_DEMO_VALUES.subscription],
      );
    }

    /*
     * The suspended tenant subscribes to a rung that exists.
     *
     * It carried `SETTERFI_DEMO_PLACEHOLDER_SUSPENDED_PRICE`, which no `tiers` row holds, and the
     * allowance job resolves a subscription's tier by matching `tiers.stripe_price_id`
     * (`src/lib/billing/allowances.ts`). That read came back empty for this tenant on every run,
     * logged ALLOWANCE_CANDIDATE_READ_FAILED, and skipped it, so a suspended account was also an
     * account the platform could not price. `tenants.tier_id` already says Starter, and this now
     * agrees with it.
     *
     * Suspension is not a price. It is `tenants.status`, set by the
     * `set_tenant_billing_status` call directly below, which is what the screens read.
     */
    const suspendedSnapshot = {
      priceId: demoTierPriceId(DEMO_TIER_LADDER[0]),
      status: "active",
      periodStart: "2026-08-01T00:00:00Z",
      periodEnd: "2026-09-01T00:00:00Z",
      cancelAtPeriodEnd: false,
    };
    await database.query(
      `select * from public.apply_billing_subscription_snapshot(
        $1, $2, $3, $4, 'active',
        '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', false, $5::timestamptz
      )`,
      [affiliateTenantId, PHASE6_DEMO_VALUES.suspendedCustomer,
        PHASE6_DEMO_VALUES.suspendedSubscription, suspendedSnapshot.priceId,
        await snapshotStampFor(
          database, affiliateTenantId, suspendedSnapshot, "2026-08-01T00:00:01Z",
        )],
    );
    const affiliateStatus = (await database.query(
      `select status::text from public.tenants where id = $1`, [affiliateTenantId],
    )).rows[0]?.status;
    if (affiliateStatus !== "suspended") {
      await setClaims(database, { role: "admin", sub: PHASE2_ADMIN_ID });
      await database.query(
        `select * from public.set_tenant_billing_status(
          $1, $2, 'suspended', $3
        )`,
        [affiliateTenantId, PHASE2_ADMIN_ID, DEMO_BILLING_COPY.suspensionReason],
      );
    }

    const counts = await readBack(database, moneyTenantId, affiliateTenantId);
    const expected = {
      tiers: 3, demo_tenants: 2, referrals: 1, checkouts: 1, subscriptions: 2,
      appointments: 4, billables: 4, correction_requests: 2, correction_decisions: 2,
      allowance_actions: 2, ledger_entries: 5, payout_events: 2, cost_rollups: 2,
      money_status: "overdue", suspended_status: "suspended",
    };
    assert(JSON.stringify(counts) === JSON.stringify(expected), `PHASE6_DEMO_READBACK_INVALID:${JSON.stringify(counts)}`);
    await database.query("commit");
    console.log(`Phase 6 seed read-back: ${JSON.stringify(counts)} stripe_arm=Mock `
      + `provider_proof=mock-only stale_cost_rollups=${staleRollups}`);
    return { counts, moneyTenantId, affiliateTenantId };
  } catch (error) {
    await database.query("rollback");
    throw error;
  } finally {
    await database.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedPhase6Demo().catch((error) => {
    console.error(error instanceof Error ? error.message : "PHASE6_DEMO_SEED_FAILED");
    process.exitCode = 1;
  });
}
