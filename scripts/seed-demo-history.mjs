/**
 * Puts the demo platform on a twelve-month grid.
 *
 * Every demo tenant was seeded within the same few weeks, so the owner Overview drew one tall bar
 * at the right edge of "Signups by period" and nothing behind it, and the active-subscription and
 * revenue trends had nothing to slope across. `scripts/fixtures/demo-history.mjs` holds the
 * schedule; this applies it.
 *
 * What it writes, and nothing else:
 *
 *   - `public.tenants.created_at` for the eight already-seeded demo tenants, moved onto the grid.
 *   - The sixteen cohort tenants the curve needs, upserted by id.
 *   - `public.billing_subscriptions` for the subscribed tenants, with the mirror's period opened
 *     at signup so the active-subscription series can count it in every period since.
 *   - One `public.tenant_cost_rollups` row per subscribed tenant per period from its signup
 *     onwards, which is what the recognised-revenue series sums.
 *
 * Safety. Every tenant it touches is re-read from the database and refused unless `is_demo` is
 * true, whatever the fixture claims, and the whole run is one transaction. It never updates a row
 * belonging to a tenant that is not a demo tenant, and it never deletes anything.
 *
 * Idempotence. Rerunning on the same day writes the same instants and changes nothing.
 * `tenant_cost_rollups` is append-only at the database (`app.reject_phase6_append_only`), so
 * rollups are inserted with `on conflict do nothing` and an existing window is left standing
 * rather than corrected.
 *
 * Run it as `node --env-file-if-exists=.env.local scripts/seed-demo-history.mjs --confirm-hosted`.
 */

import { pathToFileURL } from "node:url";

import pg from "pg";

import { resolveDemoTarget } from "./seed-phase1-demo.mjs";
import {
  DEMO_HISTORY_COHORT,
  DEMO_HISTORY_EXISTING,
  DEMO_HISTORY_PERIODS,
  DEMO_HISTORY_SCHEDULE,
  demoHistoryAnchor,
  demoHistoryInstant,
  demoHistoryPeriodOf,
  demoRollupCosts,
  demoRollupWindow,
  demoSignupsByPeriod,
} from "./fixtures/demo-history.mjs";

function assert(condition, code, detail) {
  if (!condition) throw new Error(detail === undefined ? code : `${code}:${JSON.stringify(detail)}`);
}

/**
 * Resolve every scheduled slug to a tenant row and refuse anything that is not a demo tenant.
 *
 * The fixture's `is_demo` claim is a claim. This is the check, and it runs before a single write,
 * so a slug that has been reused by a real tenant stops the script instead of backdating a real
 * client's signup date.
 */
async function resolveExistingTenants(database) {
  const slugs = DEMO_HISTORY_EXISTING.map((entry) => entry.slug);
  const { rows } = await database.query(
    "select id, slug, name, is_demo, created_at from public.tenants where slug = any($1::text[])",
    [slugs],
  );
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  const missing = slugs.filter((slug) => !bySlug.has(slug));
  assert(missing.length === 0, "DEMO_HISTORY_TENANT_MISSING", missing);
  const real = rows.filter((row) => !row.is_demo).map((row) => row.slug);
  assert(real.length === 0, "DEMO_HISTORY_TENANT_NOT_DEMO", real);
  return bySlug;
}

export async function seedDemoHistory({ argumentsList = process.argv.slice(2) } = {}) {
  const target = resolveDemoTarget(argumentsList);
  assert(Boolean(target.databaseUrl), "SUPABASE_DB_PASSWORD_REQUIRED_FOR_DEMO_HISTORY_SEED");
  const anchor = demoHistoryAnchor();
  const database = new pg.Client({ connectionString: target.databaseUrl });
  await database.connect();
  try {
    await database.query("begin");
    const existing = await resolveExistingTenants(database);

    // 1. The already-seeded tenants move onto the grid. Only `created_at` changes; the seeders
    //    that own these rows keep owning their name, status, tier and everything else.
    for (const entry of DEMO_HISTORY_EXISTING) {
      const row = existing.get(entry.slug);
      await database.query(
        `update public.tenants set created_at = $2::timestamptz, updated_at = now()
         where id = $1 and is_demo`,
        [row.id, demoHistoryInstant(anchor, entry.signupDaysBefore, 9 * 60)],
      );
    }

    // 2. The cohort the curve needs. Upserted by id so a rerun converges, and `is_demo` is part of
    //    the insert rather than a later update: a demo tenant that exists for even one statement
    //    without its flag is a demo tenant inside a platform aggregate.
    for (const tenant of DEMO_HISTORY_COHORT) {
      await database.query(
        `insert into public.tenants
           (id, slug, name, status, is_demo, billing_contact_email, tier_id, created_at, updated_at)
         values ($1, $2, $3, $4::tenant_status, true, $5, $6, $7::timestamptz, now())
         on conflict (id) do update set
           slug = excluded.slug, name = excluded.name, status = excluded.status,
           is_demo = true, billing_contact_email = excluded.billing_contact_email,
           tier_id = excluded.tier_id, created_at = excluded.created_at, updated_at = now()`,
        [
          tenant.id, tenant.slug, tenant.name, tenant.status, tenant.billingContactEmail,
          tenant.tier.id, demoHistoryInstant(anchor, tenant.signupDaysBefore, 9 * 60),
        ],
      );
    }

    /*
     * 3. The subscription mirror.
     *
     * `app.phase7_platform_active_subscription_history` counts a subscription in a period when
     * its status is `active` and `current_period_start .. current_period_end` straddles that
     * period's end. A mirror row holding one calendar month can therefore only ever be counted in
     * the newest period, which is exactly why the trend was a single bar. Opening the demo
     * mirror's period at signup and closing it a month out states the thing the demo means:
     * this coach has been subscribed continuously since they signed up, and renews next month.
     *
     * The churner is the exception. Its period closes on the churn date and its status is
     * `canceled`, so the money surfaces stop counting it as live rather than carrying a churned
     * tenant's revenue forward.
     */
    const subscribers = [
      ...DEMO_HISTORY_EXISTING
        .map((entry) => ({ entry, row: existing.get(entry.slug) }))
        .map(({ entry, row }) => ({ tenantId: row.id, entry })),
      ...DEMO_HISTORY_COHORT
        .filter((tenant) => tenant.subscribed)
        .map((tenant) => ({ tenantId: tenant.id, entry: tenant, cohort: tenant })),
    ];

    let subscriptionsMoved = 0;
    for (const { tenantId, entry, cohort } of subscribers) {
      const churned = entry.churnDaysBefore !== undefined;
      const periodStart = demoHistoryInstant(anchor, entry.signupDaysBefore, 9 * 60 + 5);
      const periodEnd = churned
        ? demoHistoryInstant(anchor, entry.churnDaysBefore)
        : demoHistoryInstant(anchor, -30);
      const status = churned ? "canceled" : null;

      if (cohort) {
        await database.query(
          `insert into public.billing_subscriptions
             (tenant_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, status,
              current_period_start, current_period_end, cancel_at_period_end, provider_updated_at,
              created_at, updated_at)
           values ($1, $2, $3, $4, 'active', $5::timestamptz, $6::timestamptz, false,
                   $5::timestamptz, $5::timestamptz, now())
           on conflict (tenant_id) do update set
             stripe_price_id = excluded.stripe_price_id,
             current_period_start = excluded.current_period_start,
             current_period_end = excluded.current_period_end,
             provider_updated_at = excluded.provider_updated_at,
             created_at = excluded.created_at, updated_at = now()`,
          [tenantId, cohort.stripeCustomerId, cohort.stripeSubscriptionId,
            demoPriceIdFor(cohort.tier), periodStart, periodEnd],
        );
        subscriptionsMoved += 1;
        continue;
      }

      // An already-seeded tenant may have no subscription at all (the two workspaces that are not
      // coach tenants), and that is not an error: it has no row to move.
      const moved = await database.query(
        `update public.billing_subscriptions subscription
         set current_period_start = $2::timestamptz,
             current_period_end = $3::timestamptz,
             status = coalesce($4, subscription.status),
             cancel_at_period_end = ($4 is not null),
             provider_updated_at = $2::timestamptz,
             created_at = $2::timestamptz,
             updated_at = now()
         from public.tenants tenant
         where tenant.id = subscription.tenant_id and tenant.id = $1 and tenant.is_demo
         returning subscription.id`,
        [tenantId, periodStart, periodEnd, status],
      );
      subscriptionsMoved += moved.rowCount;
    }

    /*
     * 4. Recognised-revenue receipts, one per subscribed tenant per period from its signup
     * onwards. `app.phase7_platform_recognized_revenue_history` groups these by `window_start`,
     * and a period with no receipt reports `needs_more_history` rather than a measured zero, so a
     * gap here shows on the chart as a gap rather than as a bad month.
     */
    let rollupsInserted = 0;
    // Already-seeded tenants keep whatever tier their own seeder gave them; read it rather than
    // assume it, so a receipt never quotes a price the tenant is not on.
    const seededPrices = await database.query(
      `select tenant.id as tenant_id, tier.price_cents
       from public.tenants tenant
       join public.tiers tier on tier.id = tenant.tier_id
       where tenant.is_demo and tenant.tier_id is not null`,
    );
    const priceByTenant = new Map(seededPrices.rows.map((row) => [row.tenant_id, Number(row.price_cents)]));
    for (const { tenantId, entry } of subscribers) {
      const priceCents = priceByTenant.get(tenantId) ?? entry.tier?.priceCents ?? null;
      if (priceCents === null) continue;
      const firstPeriod = demoHistoryPeriodOf(entry.signupDaysBefore);
      const lastPeriod = entry.churnDaysBefore === undefined
        ? DEMO_HISTORY_PERIODS - 1
        : demoHistoryPeriodOf(entry.churnDaysBefore);
      for (let period = firstPeriod; period <= lastPeriod; period += 1) {
        const window = demoRollupWindow(anchor, period);
        const costs = demoRollupCosts(priceCents, firstPeriod, period);
        const inserted = await database.query(
          `insert into public.tenant_cost_rollups
             (tenant_id, window_start, window_end, recognized_subscription_cents,
              model_cents, messaging_cents, embedding_cents, total_cost_cents, complete,
              missing_sources, source_evidence, computed_at)
           select $1, $2::timestamptz, $3::timestamptz, $4, $5, $6, $7, $8, true, '{}'::text[],
                  '{"source": "Demo history backfill, complete period"}'::jsonb, $3::timestamptz
           where exists (select 1 from public.tenants where id = $1 and is_demo)
           on conflict (tenant_id, window_start, window_end) do nothing
           returning id`,
          [tenantId, window.start, window.end, priceCents,
            costs.model, costs.messaging, costs.embedding, costs.total],
        );
        rollupsInserted += inserted.rowCount;
      }
    }

    await database.query("commit");
    const curve = demoSignupsByPeriod(DEMO_HISTORY_SCHEDULE);
    console.log(`Demo history seed: anchor=${anchor.toISOString()} tenants=${DEMO_HISTORY_SCHEDULE.length} `
      + `cohort=${DEMO_HISTORY_COHORT.length} subscriptions=${subscriptionsMoved} `
      + `rollups_inserted=${rollupsInserted} signups_by_period=${curve.join(",")}`);
    return { anchor: anchor.toISOString(), subscriptionsMoved, rollupsInserted, curve };
  } catch (error) {
    await database.query("rollback");
    throw error;
  } finally {
    await database.end();
  }
}

/** The demo price id convention, mirrored from `seed-phase6-demo.mjs`. */
function demoPriceIdFor(rung) {
  return `SETTERFI_DEMO_PLACEHOLDER_PRICE_${rung.name.replace(/\s*\(demo\)$/u, "").toUpperCase()}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedDemoHistory().catch((error) => {
    console.error(error instanceof Error ? error.message : "DEMO_HISTORY_SEED_FAILED");
    process.exitCode = 1;
  });
}
