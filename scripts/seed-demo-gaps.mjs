/**
 * Fills the three demo surfaces that render empty because nothing was ever written behind them:
 * the coach onboarding checklist, `/coach/billing`, and the affiliate portal.
 *
 * This seeder is additive and idempotent. It writes only to labelled demo tenants
 * (`is_demo = true`) -- `DEMO_IDS.tenant`, whichever demo tenant the /login coach button lands on
 * (see `loginCoachEmail` below), and three referred tenants it creates and labels the same way, so every
 * row it produces is excluded from real analytics by the same `not tenant.is_demo` /
 * `not row.is_test` filters every `analytics_*` view already applies. It never sets `is_test`
 * itself. `app.inherit_is_test()` derives that from the tenant, and a seeder that wrote its own
 * copy could drift from the trigger.
 *
 * It deliberately writes no `billable_events`. On an `is_demo` tenant the trigger forces
 * `is_test = true`, and `coach_billing_projection` filters those out of the booked count anyway,
 * so the rows would buy nothing, while `reset-phase1-demo.mjs` raises
 * DEMO_RESET_REFUSED_BILLABLE_EVIDENCE_PRESENT and `seed-demo-complete.mjs` fails its guarded
 * count if that table moves. Booked usage therefore reads "0 of 25", which is honest.
 *
 * Where a table is closed to the service role the sanctioned RPC is called instead of reaching
 * around it: the Phase 6 money tables are `revoke all ... from service_role` with only `select`
 * granted back, `commission_ledger` also revokes writes, and `referrals` is trigger-locked to the
 * signup path. Every RPC used here is `grant execute ... to service_role`.
 */

import { pathToFileURL } from "node:url";

import { createDemoClient, DEMO_IDS, DEMO_VALUES, resolveDemoTarget } from "./seed-phase1-demo.mjs";
import { demoTierPriceId } from "./seed-phase6-demo.mjs";
import {
  DEMO_TIER_LADDER,
  DEMO_BILLING_COPY,
  DEMO_BUSINESS_NAMES,
  DEMO_FAIR_USE_NOTE,
  DEMO_ONBOARDING_COPY,
  DEMO_PERSON_NAMES,
} from "./fixtures/names.mjs";

/** `grep -rn "8b000000" scripts/ src/ supabase/` was empty before this file existed. */
export const DEMO_GAPS_NAMESPACE = "8b000000-0000-4000-8000-";

function gapsId(sequence) {
  return `${DEMO_GAPS_NAMESPACE}${String(sequence).padStart(12, "0")}`;
}

export const DEMO_GAPS_IDS = Object.freeze({
  tier: gapsId(1),
  referredIntents: Object.freeze([gapsId(11), gapsId(12), gapsId(13)]),
  referredUsers: Object.freeze([gapsId(21), gapsId(22), gapsId(23)]),
});

export const DEMO_GAPS_VALUES = Object.freeze({
  /*
   * Rung 1 of the shared ladder, upserted against the ladder's own id rather than a row of this
   * seeder's own -- the ladder is the client's three contracted tiers and there is no fourth price
   * to give a fourth row. Upserting keeps this script runnable alone: it writes the row it then
   * subscribes the demo tenant to.
   *
   * The price id is derived from the rung rather than written as a literal, and that is the part
   * that had to change. `src/lib/billing/allowances.ts` resolves a subscription's tier by matching
   * `tiers.stripe_price_id` to `billing_subscriptions.stripe_price_id`, and the literal here
   * (`..._DEMO_GROWTH`) is not what `demoTierPriceId` derives for this rung (`..._GROWTH`), so once
   * phase 6 owns the same row the two would disagree and the allowance job would find no tier for
   * this tenant at all.
   */
  tierId: DEMO_TIER_LADDER[1].id,
  tierName: DEMO_TIER_LADDER[1].name,
  tierPriceId: demoTierPriceId(DEMO_TIER_LADDER[1]),
  tierPriceCents: DEMO_TIER_LADDER[1].priceCents,
  tierAllowance: DEMO_TIER_LADDER[1].callAllowance,
  tierFairUseCap: DEMO_TIER_LADDER[1].fairUseCap,
  tierIsUncapped: DEMO_TIER_LADDER[1].isUncapped,
  tierFairUseNote: DEMO_FAIR_USE_NOTE,
  customer: "SETTERFI_DEMO_PLACEHOLDER_CUSTOMER_DEMO_COACH",
  subscription: "SETTERFI_DEMO_PLACEHOLDER_SUBSCRIPTION_DEMO_COACH",
  /*
   * The /login "Sign in as coach" button does not necessarily land on `DEMO_IDS.tenant`.
   * `seed-staging-users.mjs` assigns that tenant only when it creates the account, and leaves an
   * account it finds already seeded on whatever tenant it holds, so on the hosted project the
   * demo coach sits on the phase 7 measurement workspace. That tenant carries contacts,
   * conversations and appointments, and `demo-history.mjs` counts it as the oldest subscriber,
   * but nothing ever wrote it a tier or a `billing_subscriptions` row, so
   * `coach_billing_projection` inner-joined itself to nothing and /coach/billing rendered
   * "Billing details could not load". Seeding the tenant the button actually reaches fixes the
   * screen without moving the coach off the workspace every other screen is seeded against.
   */
  loginCoachEmail: "support+coach@livelegacystrong.com",
  loginCoachCustomer: "SETTERFI_DEMO_PLACEHOLDER_CUSTOMER_LOGIN_COACH",
  loginCoachSubscription: "SETTERFI_DEMO_PLACEHOLDER_SUBSCRIPTION_LOGIN_COACH",
  programName: DEMO_ONBOARDING_COPY.offerProgram,
  affiliateEmail: "support+affiliate@livelegacystrong.com",
  adminEmail: "support+admin@livelegacystrong.com",
  payoutReference: DEMO_BILLING_COPY.payoutReference,
  payoutReason: DEMO_BILLING_COPY.payoutApproval,
  timezone: "America/New_York",
});

/**
 * The A2P clock is a real elapsed count, never a prediction. Fourteen days back from the run date
 * puts the surface in "Registering · day 15", inside the 2-3 week carrier window it describes.
 */
export const A2P_SUBMITTED_DAYS_AGO = 14;

const DAY_MS = 86_400_000;

/** Steps that carry persisted completion evidence. `go_live` is never one of them. */
export const COMPLETED_STEP_KEYS = Object.freeze([
  "account", "billing", "ghl_location", "ghl_snapshot", "phone_number",
  "sms_eligibility_screen", "business_profile", "optin_artifact",
  "meta_connect", "calendar_connect", "offer_layer", "test_pass",
]);

/**
 * The SMS lane stays with the carrier. `sms_live` never reaches `done` from a seed. The honest
 * state while A2P vetting is outstanding is amber with a day counter, not a completed step.
 */
export const CARRIER_PENDING_STEP_KEYS = Object.freeze(["a2p_brand", "a2p_campaign", "sms_live"]);

export function a2pSubmittedAt(now, daysAgo = A2P_SUBMITTED_DAYS_AGO) {
  return new Date(now.getTime() - daysAgo * DAY_MS).toISOString();
}

/**
 * A calendar-month period keeps the demo subscription current for the whole month and makes a
 * re-run inside that month a no-op, while a run in a later month rolls the window forward instead
 * of leaving a lapsed period on screen.
 */
export function billingPeriodFor(now) {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

export function periodCovers(subscription, now) {
  if (!subscription) return false;
  const start = Date.parse(subscription.current_period_start);
  const end = Date.parse(subscription.current_period_end);
  return Number.isFinite(start) && Number.isFinite(end) && start <= now.getTime() && end > now.getTime();
}

/**
 * Three referred businesses, two of them reading `active` and one `inactive` through
 * `affiliate_referral_projection`'s coarse mapping, so the portal shows the status column doing
 * real work rather than one repeated value.
 */
/**
 * The three referred businesses, and the monthly invoices the affiliate earns commission on.
 *
 * The invoice amounts used to be $1,800, $960 and $640, which were three numbers nobody could
 * point at a source for. Every one of these businesses signs up on the rung `ensureTier` writes,
 * so a paid month is that rung's price and nothing else. An affiliate reading a $180 commission
 * against a coach the admin tier screen prices at $597 has been shown two different products.
 *
 * The variety on the affiliate portal comes from how many months each business has paid and from
 * `finalStatus`, which are facts about the referral rather than invented prices.
 */
export function referredBusinessFixtures() {
  const monthlyCents = DEMO_TIER_LADDER[1].priceCents;
  return [
    {
      slug: "setterfi-demo-placeholder-referral-north",
      name: DEMO_BUSINESS_NAMES.referralNorth,
      owner: DEMO_PERSON_NAMES.referralNorth,
      email: "demo-referral-north@example.invalid",
      finalStatus: "active",
      invoiceCents: [monthlyCents, monthlyCents, monthlyCents],
    },
    {
      slug: "setterfi-demo-placeholder-referral-harbor",
      name: DEMO_BUSINESS_NAMES.referralHarbor,
      owner: DEMO_PERSON_NAMES.referralHarbor,
      email: "demo-referral-harbor@example.invalid",
      finalStatus: "active",
      invoiceCents: [monthlyCents, monthlyCents],
    },
    {
      slug: "setterfi-demo-placeholder-referral-summit",
      name: DEMO_BUSINESS_NAMES.referralSummit,
      owner: DEMO_PERSON_NAMES.referralSummit,
      email: "demo-referral-summit@example.invalid",
      finalStatus: "churned",
      invoiceCents: [monthlyCents],
    },
  ];
}

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

async function ok(label, promise) {
  const result = await promise;
  if (result.error) throw new Error(`${label}:${result.error.message}`);
  return result.data;
}

/**
 * The same guard every other seeder repeats, from the other side: refuse to write fixtures into
 * anything that is not the known, labelled demo tenant.
 */
async function requireKnownDemoTenant(client) {
  const tenant = await ok(
    "DEMO_GAPS_TENANT_READ_FAILED",
    client.from("tenants").select("id, slug, is_demo").eq("id", DEMO_IDS.tenant).maybeSingle(),
  );
  if (!tenant || tenant.slug !== DEMO_VALUES.slug || tenant.is_demo !== true) {
    throw new Error("DEMO_GAPS_TENANT_ANCESTRY_REFUSED");
  }
  return tenant;
}

async function requireUserByEmail(client, email, roles, code) {
  const user = await ok(
    "DEMO_GAPS_USER_READ_FAILED",
    client.from("users").select("id, email, role, tenant_id").eq("email", email).maybeSingle(),
  );
  assert(user && roles.includes(user.role), `${code}: run scripts/seed-staging-users.mjs first`);
  return user;
}

/**
 * Same collision the phase 6 seeder guards: `tiers.stripe_price_id` is globally unique, so if this
 * price id is parked on a tier row under a different id — an earlier run of these seeds, when the
 * rung-to-id mapping was different — the upsert below violates `tiers_stripe_price_id_key` instead
 * of converging. The value carries the `SETTERFI_DEMO_PLACEHOLDER_PRICE_` sentinel, so releasing it
 * from a foreign row can only touch the seeds' own past output.
 */
async function releaseStaleTierPriceId(client) {
  const stale = await ok(
    "DEMO_GAPS_TIER_PRICE_READ_FAILED",
    client.from("tiers").select("id, stripe_price_id")
      .eq("stripe_price_id", DEMO_GAPS_VALUES.tierPriceId).neq("id", DEMO_GAPS_VALUES.tierId),
  );
  if (!stale.length) return 0;
  assert(
    stale.every((row) => row.stripe_price_id.startsWith("SETTERFI_DEMO_PLACEHOLDER_PRICE_")),
    "DEMO_GAPS_TIER_PRICE_NOT_A_DEMO_SENTINEL",
  );
  await ok(
    "DEMO_GAPS_TIER_PRICE_RELEASE_FAILED",
    client.from("tiers").update({ stripe_price_id: null })
      .in("id", stale.map((row) => row.id)),
  );
  return stale.length;
}

async function ensureTier(client) {
  await releaseStaleTierPriceId(client);
  await ok(
    "DEMO_GAPS_TIER_UPSERT_FAILED",
    client.from("tiers").upsert({
      id: DEMO_GAPS_VALUES.tierId,
      name: DEMO_GAPS_VALUES.tierName,
      price_cents: DEMO_GAPS_VALUES.tierPriceCents,
      call_allowance: DEMO_GAPS_VALUES.tierAllowance,
      fair_use_cap: DEMO_GAPS_VALUES.tierFairUseCap,
      is_uncapped: DEMO_GAPS_VALUES.tierIsUncapped,
      stripe_price_id: DEMO_GAPS_VALUES.tierPriceId,
      fair_use_note: DEMO_GAPS_VALUES.tierFairUseNote,
      active: true,
    }, { onConflict: "id" }),
  );
  /*
   * The row this seeder used to mint, retired rather than left behind. A database seeded before the
   * collapse still holds it under the old ladder's name and its invented price, and a stale priced
   * row on Plans and pricing is the defect this change exists to fix. Deactivated, not deleted:
   * `tenants.tier_id` and seeded subscriptions reference it on exactly those databases.
   */
  await ok(
    "DEMO_GAPS_RETIRED_TIER_DEACTIVATE_FAILED",
    client.from("tiers").update({ active: false }).eq("id", DEMO_GAPS_IDS.tier)
      .neq("id", DEMO_GAPS_VALUES.tierId),
  );
  return DEMO_GAPS_VALUES.tierId;
}

/**
 * `coach_billing_projection` inner-joins `tiers` through `tenants.tier_id`, while the dashboard
 * allowance card resolves the tier through `analytics_billing_subscriptions` by matching
 * `stripe_price_id`. Both have to agree or the two surfaces disagree about the same subscription.
 */
async function ensureSubscription(client, tenantId, { customer, subscription, now }) {
  const existing = await ok(
    "DEMO_GAPS_SUBSCRIPTION_READ_FAILED",
    client.from("billing_subscriptions")
      .select("id, status, current_period_start, current_period_end")
      .eq("tenant_id", tenantId).maybeSingle(),
  );
  if (periodCovers(existing, now) && existing.status === "active") return { changed: false };
  const period = billingPeriodFor(now);
  await ok(
    "DEMO_GAPS_SUBSCRIPTION_SNAPSHOT_FAILED",
    client.rpc("apply_billing_subscription_snapshot", {
      p_expected_tenant: tenantId,
      p_stripe_customer_id: customer,
      p_stripe_subscription_id: subscription,
      p_stripe_price_id: DEMO_GAPS_VALUES.tierPriceId,
      p_status: "active",
      p_current_period_start: period.start,
      p_current_period_end: period.end,
      p_cancel_at_period_end: false,
      p_provider_updated_at: now.toISOString(),
    }),
  );
  return { changed: true };
}

/**
 * The demo tenant the /login coach button lands on, when that is not `DEMO_IDS.tenant`.
 *
 * Returns null when the button already lands on the tenant this seeder bills, so a database where
 * the two agree does no extra work. Anything that is not a labelled demo tenant stops the seeder
 * rather than getting fixtures written into it, which is the same guard `requireKnownDemoTenant`
 * applies from the other side.
 */
async function resolveDemoLoginCoachTenant(client) {
  const user = await requireUserByEmail(
    client,
    DEMO_GAPS_VALUES.loginCoachEmail,
    ["coach", "coach_member"],
    "DEMO_GAPS_LOGIN_COACH_MISSING",
  );
  if (!user.tenant_id || user.tenant_id === DEMO_IDS.tenant) return null;
  const tenant = await ok(
    "DEMO_GAPS_LOGIN_COACH_TENANT_READ_FAILED",
    client.from("tenants").select("id, slug, is_demo").eq("id", user.tenant_id).maybeSingle(),
  );
  assert(tenant?.is_demo === true, "DEMO_GAPS_LOGIN_COACH_TENANT_NOT_DEMO");
  return tenant;
}

async function seedBillingSurface(client, now) {
  const tierId = await ensureTier(client);
  await ok(
    "DEMO_GAPS_TENANT_TIER_UPDATE_FAILED",
    client.from("tenants").update({ tier_id: tierId }).eq("id", DEMO_IDS.tenant),
  );
  const subscription = await ensureSubscription(client, DEMO_IDS.tenant, {
    customer: DEMO_GAPS_VALUES.customer,
    subscription: DEMO_GAPS_VALUES.subscription,
    now,
  });
  /*
   * The affiliate surface signs its three referred businesses up to a tier, and it has to be this
   * one. It used to be handed `DEMO_GAPS_IDS.tier`, the rung this seeder minted for itself before
   * the ladder collapsed onto the client's three contracted tiers. `ensureTier` now writes the
   * ladder row and deactivates that old id, so on any database seeded after the collapse the old
   * id names no row at all and `signup_intents_tier_id_fkey` rejected the first referred business,
   * which aborted the whole gaps seed. On a database seeded before it, the three referrals, their
   * invoices and every commission accrual hung off the retired $497 rung while the coach's own
   * billing screen read the contracted $597 one. Returning the id the billing surface actually
   * wrote leaves one source for both.
   */
  /*
   * The same plan, period and allowance written onto whichever demo tenant the login button
   * reaches. It is the same rung on purpose: a coach reading one price on their own billing page
   * and the admin book quoting another for the same workspace is the defect this avoids.
   */
  const loginTenant = await resolveDemoLoginCoachTenant(client);
  let loginChanged = false;
  if (loginTenant) {
    await ok(
      "DEMO_GAPS_LOGIN_COACH_TIER_UPDATE_FAILED",
      client.from("tenants").update({ tier_id: tierId }).eq("id", loginTenant.id),
    );
    ({ changed: loginChanged } = await ensureSubscription(client, loginTenant.id, {
      customer: DEMO_GAPS_VALUES.loginCoachCustomer,
      subscription: DEMO_GAPS_VALUES.loginCoachSubscription,
      now,
    }));
  }
  return {
    ...subscription,
    tierId,
    loginTenantId: loginTenant ? loginTenant.id : null,
    loginChanged,
  };
}

/**
 * Every shape check on `provisioning_steps` pairs two columns, so each column is always sent
 * explicitly: `(state = 'done') = (completed_at is not null)`,
 * `(state = 'awaiting_provider') = (awaiting_party is not null)`, and blocked_reason only when
 * blocked. Sending a partial row would let a stale value from a previous state violate one.
 */
export function provisioningStepRows(tenantId, now) {
  const stamp = now.toISOString();
  const completed = COMPLETED_STEP_KEYS.map((step_key) => ({
    tenant_id: tenantId,
    step_key,
    state: "done",
    awaiting_party: null,
    blocked_reason: null,
    completed_at: stamp,
    last_transition_at: stamp,
    idempotency_key: `${tenantId}:${step_key}`,
  }));
  const carrier = CARRIER_PENDING_STEP_KEYS.map((step_key) => ({
    tenant_id: tenantId,
    step_key,
    state: "awaiting_provider",
    awaiting_party: "carrier",
    blocked_reason: null,
    completed_at: null,
    last_transition_at: stamp,
    idempotency_key: `${tenantId}:${step_key}`,
    ...(step_key === "a2p_campaign"
      ? { external_ref: { submittedAt: a2pSubmittedAt(now) } }
      : {}),
  }));
  return [...completed, ...carrier];
}

async function seedOnboardingEvidence(client, now) {
  const stamp = now.toISOString();

  await ok(
    "DEMO_GAPS_PROVISIONING_UPSERT_FAILED",
    client.from("provisioning_steps")
      .upsert(provisioningStepRows(DEMO_IDS.tenant, now), { onConflict: "tenant_id,step_key" }),
  );

  // The readiness check tests for exactly `live` on any provider, and the phase 4 seeder already
  // holds instagram/ghl at `live` (a second live provider on the same channel would violate
  // channel_connections_one_live_provider_idx, and a live meta_direct row would demand the six
  // signed receipts). So this is a read-and-assert, never a write.
  const liveConnections = await ok(
    "DEMO_GAPS_CHANNEL_READ_FAILED",
    client.from("channel_connections").select("channel, provider")
      .eq("tenant_id", DEMO_IDS.tenant).eq("state", "live"),
  );
  assert(liveConnections.length > 0, "DEMO_GAPS_NO_LIVE_CHANNEL: run scripts/seed-phase1-demo.mjs first");

  // Calendar and offer evidence both expire 15 minutes after they are written
  // (MAX_READINESS_EVIDENCE_AGE_MS), so this is refreshed on every run rather than anchored.
  const calendar = await ok(
    "DEMO_GAPS_CALENDAR_READ_FAILED",
    client.from("calendar_connections").select("id")
      .eq("tenant_id", DEMO_IDS.tenant).eq("is_primary", true).maybeSingle(),
  );
  if (calendar) {
    await ok(
      "DEMO_GAPS_CALENDAR_UPDATE_FAILED",
      client.from("calendar_connections")
        .update({ state: "ready", last_slot_fetch_ok: true, last_slot_fetch_at: stamp, last_error: null })
        .eq("id", calendar.id),
    );
  }

  // offer_layers is versioned (unique tenant_id+version) and readiness reads the newest
  // *published* version's updated_at as its 15-minute evidence stamp. Published rows are
  // immutable (offer_layers_history_guard allows only published→superseded), so refreshing the
  // stamp means what a real republish does: supersede the current version, then insert a copy
  // as the next version, published, with a fresh updated_at.
  const publishedOffer = await ok(
    "DEMO_GAPS_OFFER_READ_FAILED",
    client.from("offer_layers").select("*")
      .eq("tenant_id", DEMO_IDS.tenant).eq("status", "published")
      .order("version", { ascending: false }).limit(1).maybeSingle(),
  );
  assert(publishedOffer, "DEMO_GAPS_NO_PUBLISHED_OFFER: run scripts/seed-phase1-demo.mjs first");
  const newestOffer = await ok(
    "DEMO_GAPS_OFFER_VERSION_READ_FAILED",
    client.from("offer_layers").select("version")
      .eq("tenant_id", DEMO_IDS.tenant)
      .order("version", { ascending: false }).limit(1).single(),
  );
  await ok(
    "DEMO_GAPS_OFFER_SUPERSEDE_FAILED",
    client.from("offer_layers").update({ status: "superseded" }).eq("id", publishedOffer.id),
  );
  const { id: _id, version: _version, created_at: _createdAt, ...offerBody } = publishedOffer;
  await ok(
    "DEMO_GAPS_OFFER_REPUBLISH_FAILED",
    client.from("offer_layers").insert({
      ...offerBody,
      version: newestOffer.version + 1,
      status: "published",
      updated_at: stamp,
    }),
  );

  return { calendarSeeded: Boolean(calendar) };
}

/**
 * `referrals` is trigger-locked to the signup path (`referrals_signup_only`), so a referred
 * business is created the way a real one is: an intent row, then `complete_onboarding_signup`
 * carrying the affiliate's own referral code, which writes the attribution.
 */
async function ensureReferredTenant(client, { intentId, userId, fixture, referralCode, tierId }) {
  await ok(
    "DEMO_GAPS_INTENT_UPSERT_FAILED",
    client.from("signup_intents").upsert({
      id: intentId,
      auth_user_id: userId,
      email: fixture.email,
      tier_id: tierId,
      timezone: DEMO_GAPS_VALUES.timezone,
      referral_code: referralCode,
    }, { onConflict: "id" }),
  );
  const rows = await ok(
    "DEMO_GAPS_SIGNUP_FAILED",
    client.rpc("complete_onboarding_signup", {
      p_expected_auth_user_id: userId,
      p_auth_user_id: userId,
      p_email: fixture.email,
      p_full_name: fixture.owner,
      p_business_name: fixture.name,
      p_slug: fixture.slug,
      p_tier_id: tierId,
      p_timezone: DEMO_GAPS_VALUES.timezone,
      p_referral_code: referralCode,
      p_affiliate_opt_in: false,
    }),
  );
  const tenantId = Array.isArray(rows) ? rows[0]?.tenant_id : rows?.tenant_id;
  assert(tenantId, "DEMO_GAPS_SIGNUP_TENANT_MISSING");

  // Label before any money row exists: `reject_phase6_demo_reclassification_with_money` freezes
  // `is_demo` the moment a subscription or ledger row references the tenant.
  await ok(
    "DEMO_GAPS_REFERRED_LABEL_FAILED",
    client.from("tenants").update({ is_demo: true }).eq("id", tenantId).eq("is_demo", false),
  );
  // `complete_onboarding_signup` returns early on replay, so a tenant seeded under the old
  // placeholder names would keep them forever. The display columns are rewritten explicitly.
  await ok(
    "DEMO_GAPS_REFERRED_RENAME_FAILED",
    client.from("tenants")
      .update({ name: fixture.name, billing_contact_name: fixture.owner })
      .eq("id", tenantId),
  );
  await ok(
    "DEMO_GAPS_REFERRED_USER_RENAME_FAILED",
    client.from("users").update({ full_name: fixture.owner }).eq("id", userId),
  );
  return tenantId;
}

async function seedAffiliateSurface(client, now, tierId) {
  const affiliateUser = await requireUserByEmail(
    client, DEMO_GAPS_VALUES.affiliateEmail, ["affiliate"], "DEMO_GAPS_AFFILIATE_USER_REQUIRED",
  );
  const adminUser = await requireUserByEmail(
    client, DEMO_GAPS_VALUES.adminEmail, ["owner", "admin"], "DEMO_GAPS_ADMIN_ACTOR_REQUIRED",
  );
  // The referral code is randomly generated by seed-staging-users.mjs, so it is read, never assumed.
  const affiliate = await ok(
    "DEMO_GAPS_AFFILIATE_READ_FAILED",
    client.from("affiliates").select("id, referral_code").eq("user_id", affiliateUser.id).maybeSingle(),
  );
  assert(affiliate, "DEMO_GAPS_AFFILIATE_ROW_REQUIRED: run scripts/seed-staging-users.mjs first");

  const fixtures = referredBusinessFixtures();
  const ledgerIds = [];
  for (const [index, fixture] of fixtures.entries()) {
    const tenantId = await ensureReferredTenant(client, {
      intentId: DEMO_GAPS_IDS.referredIntents[index],
      userId: DEMO_GAPS_IDS.referredUsers[index],
      fixture,
      referralCode: affiliate.referral_code,
      tierId,
    });
    await ensureSubscription(client, tenantId, {
      customer: `SETTERFI_DEMO_PLACEHOLDER_CUSTOMER_${fixture.slug.toUpperCase()}`,
      subscription: `SETTERFI_DEMO_PLACEHOLDER_SUBSCRIPTION_${fixture.slug.toUpperCase()}`,
      now,
    });
    // `accrue_invoice_commission` opens the 12-month window on the first invoice and returns the
    // existing entry on replay, so re-running writes no second accrual.
    for (const [invoiceIndex, cents] of fixture.invoiceCents.entries()) {
      // Oldest first. `accrue_invoice_commission` opens the 12-month window on whichever invoice
      // arrives first and then ignores anything paid before `window.started_at`, so walking these
      // newest-first would silently drop every accrual after the first.
      const monthsBack = fixture.invoiceCents.length - invoiceIndex;
      const paidAt = new Date(now.getTime() - monthsBack * 30 * DAY_MS).toISOString();
      const rows = await ok(
        "DEMO_GAPS_INVOICE_FAILED",
        client.rpc("apply_stripe_invoice_paid", {
          p_expected_tenant: tenantId,
          p_stripe_subscription_id: `SETTERFI_DEMO_PLACEHOLDER_SUBSCRIPTION_${fixture.slug.toUpperCase()}`,
          p_stripe_invoice_id: `SETTERFI_DEMO_PLACEHOLDER_INVOICE_${fixture.slug.toUpperCase()}_${invoiceIndex}`,
          p_invoice_paid_at: paidAt,
          p_amount_paid_cents: cents,
          p_total_excluding_tax_cents: cents,
          p_provider_updated_at: now.toISOString(),
        }),
      );
      const ledgerId = Array.isArray(rows) ? rows[0]?.commission_ledger_id : rows?.commission_ledger_id;
      if (ledgerId) ledgerIds.push(ledgerId);
    }
    // Coarse status last: it is a plain status update, so it cannot trip the demo-reclassification
    // guard, and it gives the portal one `inactive` row against two `active` ones.
    if (fixture.finalStatus !== "active") {
      await ok(
        "DEMO_GAPS_REFERRED_STATUS_FAILED",
        client.from("tenants").update({ status: fixture.finalStatus }).eq("id", tenantId),
      );
    }
  }

  const payouts = await seedPayouts(client, {
    affiliateId: affiliate.id,
    actorId: adminUser.id,
    ledgerIds,
    now,
  });
  return { referrals: fixtures.length, ledgerEntries: ledgerIds.length, ...payouts };
}

/**
 * Two payouts so the portal renders both states it knows: one approved and recorded sent, one
 * left approved-for-payout. A ledger entry can only ever belong to one payout
 * (`commission_payout_items_ledger_key`), so this block is skipped whole once it has run.
 */
async function seedPayouts(client, { affiliateId, actorId, ledgerIds, now }) {
  const existing = await ok(
    "DEMO_GAPS_PAYOUT_READ_FAILED",
    client.from("commission_payouts").select("id").eq("affiliate_id", affiliateId),
  );
  if (existing.length || ledgerIds.length < 2) {
    // A ledger entry belongs to one payout for life and `commission_payout_events` is append-only,
    // so a reference filed by an earlier run is cleared by the Phase 6 reset, never rewritten.
    return { payoutsCreated: 0, payoutsExisting: existing.length };
  }
  const sentBatch = ledgerIds.slice(0, ledgerIds.length - 1);
  const pendingBatch = ledgerIds.slice(ledgerIds.length - 1);

  const approved = await ok(
    "DEMO_GAPS_PAYOUT_APPROVAL_FAILED",
    client.rpc("approve_commission_payout", {
      p_actor_id: actorId,
      p_affiliate_id: affiliateId,
      p_ledger_ids: sentBatch,
      p_reason: DEMO_GAPS_VALUES.payoutReason,
    }),
  );
  const payoutId = Array.isArray(approved) ? approved[0]?.payout_id : approved?.payout_id;
  assert(payoutId, "DEMO_GAPS_PAYOUT_ID_MISSING");
  await ok(
    "DEMO_GAPS_PAYOUT_SENT_FAILED",
    client.rpc("record_commission_payout_sent", {
      p_actor_id: actorId,
      p_payout_id: payoutId,
      p_reference: DEMO_GAPS_VALUES.payoutReference,
      p_paid_on: new Date(now.getTime() - 3 * DAY_MS).toISOString().slice(0, 10),
    }),
  );
  await ok(
    "DEMO_GAPS_PAYOUT_PENDING_FAILED",
    client.rpc("approve_commission_payout", {
      p_actor_id: actorId,
      p_affiliate_id: affiliateId,
      p_ledger_ids: pendingBatch,
      p_reason: DEMO_GAPS_VALUES.payoutReason,
    }),
  );
  return { payoutsCreated: 2, payoutsExisting: 0 };
}

async function readBack(client, billing) {
  const subscription = await ok(
    "DEMO_GAPS_READBACK_SUBSCRIPTION_FAILED",
    client.from("billing_subscriptions").select("status, current_period_end")
      .eq("tenant_id", DEMO_IDS.tenant).maybeSingle(),
  );
  assert(subscription?.status === "active", "DEMO_GAPS_READBACK_SUBSCRIPTION_INVALID");

  /*
   * `coach_billing_projection` needs both halves, so both are read back: a tenant with a
   * subscription and no tier renders exactly the same empty screen as one with neither.
   */
  if (billing.loginTenantId) {
    const loginTenant = await ok(
      "DEMO_GAPS_READBACK_LOGIN_COACH_TENANT_FAILED",
      client.from("tenants").select("tier_id").eq("id", billing.loginTenantId).maybeSingle(),
    );
    assert(loginTenant?.tier_id === billing.tierId, "DEMO_GAPS_READBACK_LOGIN_COACH_TIER_INVALID");
    const loginSubscription = await ok(
      "DEMO_GAPS_READBACK_LOGIN_COACH_SUBSCRIPTION_FAILED",
      client.from("billing_subscriptions").select("status")
        .eq("tenant_id", billing.loginTenantId).maybeSingle(),
    );
    assert(
      loginSubscription?.status === "active",
      "DEMO_GAPS_READBACK_LOGIN_COACH_SUBSCRIPTION_INVALID",
    );
  }

  const smsStep = await ok(
    "DEMO_GAPS_READBACK_SMS_FAILED",
    client.from("provisioning_steps").select("state, completed_at")
      .eq("tenant_id", DEMO_IDS.tenant).eq("step_key", "sms_live").maybeSingle(),
  );
  assert(
    smsStep && smsStep.state !== "done" && smsStep.completed_at === null,
    "DEMO_GAPS_READBACK_SMS_MUST_NOT_BE_COMPLETE",
  );

  const referrals = await ok(
    "DEMO_GAPS_READBACK_REFERRAL_FAILED",
    client.from("referrals").select("id"),
  );
  assert(referrals.length >= referredBusinessFixtures().length, "DEMO_GAPS_READBACK_REFERRALS_MISSING");

  return {
    subscriptionEnd: subscription.current_period_end,
    smsState: smsStep.state,
    referralRows: referrals.length,
  };
}

export async function seedDemoGaps({ argumentsList = process.argv.slice(2), now = new Date() } = {}) {
  if (!argumentsList.includes("--confirm")) {
    throw new Error("DEMO_GAPS_CONFIRM_REQUIRED: pass --confirm to write demo fixtures");
  }
  const target = resolveDemoTarget(argumentsList);
  const client = createDemoClient(target);
  console.log(`Demo gaps target host: ${target.host}`);

  await requireKnownDemoTenant(client);
  const billing = await seedBillingSurface(client, now);
  const onboarding = await seedOnboardingEvidence(client, now);
  const affiliate = await seedAffiliateSurface(client, now, billing.tierId);
  const verified = await readBack(client, billing);

  console.log(
    `Demo gaps seeded: subscription_active=true period_end=${verified.subscriptionEnd} `
    + `subscription_written=${billing.changed} `
    + `login_coach_tenant=${billing.loginTenantId ?? "same"} `
    + `login_coach_subscription_written=${billing.loginChanged} `
    + `calendar_evidence=${onboarding.calendarSeeded} `
    + `referrals=${affiliate.referrals} ledger_entries=${affiliate.ledgerEntries} `
    + `payouts_created=${affiliate.payoutsCreated} sms_live=${verified.smsState} billable_events_written=0`,
  );
  return { billing, onboarding, affiliate, verified };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  seedDemoGaps().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
