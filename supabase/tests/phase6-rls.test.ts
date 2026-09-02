// Phase 6 money visibility contract. A green run means Postgres enforced the role boundaries;
// an absent database is a failure because skipped isolation tests are not evidence.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL =
  process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const TENANT_A = "71000000-0000-4000-8000-000000000001";
const TENANT_B = "71000000-0000-4000-8000-000000000002";
const TIER = "72000000-0000-4000-8000-000000000001";
const OWNER = "73000000-0000-4000-8000-000000000001";
const SUCCESS = "73000000-0000-4000-8000-000000000002";
const COACH = "73000000-0000-4000-8000-000000000003";
const COACH_B = "73000000-0000-4000-8000-000000000006";
const AFFILIATE_A = "73000000-0000-4000-8000-000000000004";
const AFFILIATE_B = "73000000-0000-4000-8000-000000000005";

let db: Client;

async function actAs(
  role: "authenticated" | "anon" | "service_role",
  claims: Record<string, string> = {},
) {
  await db.query(`set local role ${role}`);
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: claims.sub, app_metadata: claims }),
  ]);
}

async function resetRole() {
  await db.query("reset role");
  await db.query(`select set_config('request.jwt.claims', '{}', true)`);
}

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(
      `Phase 6 RLS suite could not reach Postgres at ${DB_URL}. ` +
        "Start the local stack with `supabase start`; this suite fails rather than skips.",
      { cause },
    );
  }
});

afterAll(async () => {
  await db?.end();
});

beforeEach(async () => {
  await db.query("begin");
  await db.query(`
    insert into public.tiers
      (id, name, price_cents, call_allowance, fair_use_cap, stripe_price_id)
    values ('${TIER}', 'Synthetic RLS tier', 111, 3, 6, 'price_rls');
    insert into public.tenants
      (id, slug, name, status, tier_id, billing_contact_email, is_demo)
    values
      ('${TENANT_A}', 'phase6-rls-a', 'Referred Alpha', 'active', '${TIER}', 'a@phase6.test', true),
      ('${TENANT_B}', 'phase6-rls-b', 'Referred Beta', 'active', '${TIER}', 'b@phase6.test', true);
    insert into public.users (id, email, role, tenant_id) values
      ('${OWNER}', 'owner@phase6.test', 'owner', null),
      ('${SUCCESS}', 'success@phase6.test', 'success', null),
      ('${COACH}', 'coach@phase6.test', 'coach', '${TENANT_A}'),
      ('${COACH_B}', 'coach-b@phase6.test', 'coach', '${TENANT_B}'),
      ('${AFFILIATE_A}', 'affiliate-a@phase6.test', 'affiliate', null),
      ('${AFFILIATE_B}', 'affiliate-b@phase6.test', 'affiliate', null);
    insert into public.affiliates (id, user_id, referral_code) values
      ('74000000-0000-4000-8000-000000000001', '${AFFILIATE_A}', 'RLS-A'),
      ('74000000-0000-4000-8000-000000000002', '${AFFILIATE_B}', 'RLS-B');
    select set_config('app.phase5_signup_referral', 'on', true);
    insert into public.referrals (id, affiliate_id, tenant_id) values
      ('75000000-0000-4000-8000-000000000001', '74000000-0000-4000-8000-000000000001', '${TENANT_A}'),
      ('75000000-0000-4000-8000-000000000002', '74000000-0000-4000-8000-000000000002', '${TENANT_B}');
    select set_config('app.phase5_signup_referral', 'off', true);
    insert into public.commission_ledger (
      id, referral_id, stripe_invoice_id, invoice_paid_at, base_cents,
      commission_cents, entry_kind
    ) values
      ('76000000-0000-4000-8000-000000000001', '75000000-0000-4000-8000-000000000001',
       'in_rls_a', now(), 1000, 100, 'accrual'),
      ('76000000-0000-4000-8000-000000000002', '75000000-0000-4000-8000-000000000002',
       'in_rls_b', now(), 2000, 200, 'accrual');
    insert into public.tenant_cost_rollups (
      tenant_id, window_start, window_end, recognized_subscription_cents,
      model_cents, messaging_cents, embedding_cents, total_cost_cents,
      complete, missing_sources, source_evidence
    ) values
      ('${TENANT_A}', '2026-08-01', '2026-09-01', 1000, 10, 20, 30, 60, true, '{}',
       '{"source":"synthetic"}'),
      ('${TENANT_B}', '2026-08-01', '2026-09-01', 2000, 20, 30, 40, 90, true, '{}',
       '{"source":"synthetic"}');
  `);
});

afterEach(async () => {
  await db.query("rollback");
});

describe("Phase 6 financial RLS", () => {
  it("returns only the coach session tenant billing row with no platform economics", async () => {
    await db.query(`
      insert into public.billing_subscriptions (
        tenant_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, status,
        current_period_start, current_period_end, provider_updated_at
      ) values
        ('${TENANT_A}', 'cus_portal_a', 'sub_portal_a', 'price_rls', 'active',
         '2026-08-01', '2026-09-01', '2026-08-02'),
        ('${TENANT_B}', 'cus_portal_b', 'sub_portal_b', 'price_rls', 'past_due',
         '2026-08-01', '2026-09-01', '2026-08-02');
    `);
    await actAs("authenticated", { role: "coach", tenant_id: TENANT_A, sub: COACH });
    const own = await db.query(`select * from public.coach_billing_projection('${TENANT_A}')`);
    const other = await db.query(`select * from public.coach_billing_projection('${TENANT_B}')`);

    expect(own.fields.map((field) => field.name)).toEqual([
      "tier_name", "price_cents", "period_start", "period_end", "timezone",
      "booked_count", "call_allowance", "subscription_state", "invoice_state",
      "account_state", "pending_tier_name", "pending_price_cents",
      "pending_effective_at", "notices", "correction_candidates", "outcome_prompts",
      "is_demo",
    ]);
    expect(own.rows).toHaveLength(1);
    expect(own.rows[0]).toMatchObject({
      tier_name: "Synthetic RLS tier",
      price_cents: 111,
      booked_count: "0",
      call_allowance: 3,
      subscription_state: "active",
      account_state: "active",
      is_demo: true,
    });
    expect(other.rows).toEqual([]);
    expect(Object.keys(own.rows[0])).not.toEqual(expect.arrayContaining([
      "tenant_id", "stripe_customer_id", "stripe_subscription_id", "margin_cents",
      "total_cost_cents", "model_cents", "messaging_cents", "embedding_cents",
    ]));
  });

  it("returns only the affiliate session payout rows with no coach performance fields", async () => {
    await db.query(`
      insert into public.commission_payouts (id, affiliate_id, total_cents, created_by) values
        ('77000000-0000-4000-8000-000000000001', '74000000-0000-4000-8000-000000000001', 100, '${OWNER}'),
        ('77000000-0000-4000-8000-000000000002', '74000000-0000-4000-8000-000000000001', 200, '${OWNER}'),
        ('77000000-0000-4000-8000-000000000003', '74000000-0000-4000-8000-000000000002', 300, '${OWNER}');
      do $$
      declare
        approved_a bigint;
        approved_b bigint;
        approved_other bigint;
        sent_b bigint;
      begin
        approved_a := app.write_audit_row(
          'affiliate.payout.approved', '${OWNER}', null, 'commission_payout',
          '77000000-0000-4000-8000-000000000001', 'Synthetic approval'
        );
        approved_b := app.write_audit_row(
          'affiliate.payout.approved', '${OWNER}', null, 'commission_payout',
          '77000000-0000-4000-8000-000000000002', 'Synthetic approval'
        );
        approved_other := app.write_audit_row(
          'affiliate.payout.approved', '${OWNER}', null, 'commission_payout',
          '77000000-0000-4000-8000-000000000003', 'Synthetic approval'
        );
        sent_b := app.write_audit_row(
          'affiliate.payout.sent', '${OWNER}', null, 'commission_payout',
          '77000000-0000-4000-8000-000000000002'
        );
        insert into public.commission_payout_events
          (payout_id, kind, actor_id, audit_id, created_at)
        values
          ('77000000-0000-4000-8000-000000000001', 'approved', '${OWNER}', approved_a, '2026-08-10'),
          ('77000000-0000-4000-8000-000000000002', 'approved', '${OWNER}', approved_b, '2026-08-11'),
          ('77000000-0000-4000-8000-000000000003', 'approved', '${OWNER}', approved_other, '2026-08-12');
        insert into public.commission_payout_events
          (payout_id, kind, reference, paid_on, actor_id, audit_id, created_at)
        values
          ('77000000-0000-4000-8000-000000000002', 'sent', 'SYNTHETIC-REFERENCE',
           '2026-08-13', '${OWNER}', sent_b, '2026-08-13');
      end
      $$;
    `);
    await actAs("authenticated", { role: "affiliate", sub: AFFILIATE_A });
    const payouts = await db.query(`
      select amount_cents, state, reference, recorded_on::text as recorded_on
      from public.affiliate_payout_history_projection()
    `);

    expect(payouts.fields.map((field) => field.name)).toEqual([
      "amount_cents", "state", "reference", "recorded_on",
    ]);
    expect(payouts.rows).toEqual([
      {
        amount_cents: "200",
        state: "sent",
        reference: "SYNTHETIC-REFERENCE",
        recorded_on: "2026-08-13",
      },
      {
        amount_cents: "100",
        state: "approved_for_payout",
        reference: null,
        recorded_on: null,
      },
    ]);
    expect(JSON.stringify(payouts.rows)).not.toMatch(
      /tenant|referral|revenue|lead|conversation|performance|margin|cost/i,
    );

    await resetRole();
    await actAs("authenticated", { role: "affiliate", sub: AFFILIATE_B });
    const other = await db.query(`
      select amount_cents, state, reference, recorded_on::text as recorded_on
      from public.affiliate_payout_history_projection()
    `);
    expect(other.rows).toEqual([{
      amount_cents: "300",
      state: "approved_for_payout",
      reference: null,
      recorded_on: null,
    }]);
  });

  /**
   * T15-13 (`docs/DECISIONS.md:277`): the `affiliates` row is the capability, so payout history is
   * selected by that row and never by `role = 'affiliate'`. `COACH_B` below is the user the
   * decision exists for — one login, `role = 'coach'`, a tenant of their own, and an affiliates
   * row. `COACH` is the control: same role, same claim shape, no affiliates row, no payouts. The
   * cross-affiliate half is what the role check never provided: the coach must not read
   * `AFFILIATE_A`'s payouts either.
   */
  it("gives a dual-role coach their own payouts, and a coach with no affiliates row none", async () => {
    await db.query(`
      insert into public.affiliates (id, user_id, referral_code) values
        ('74000000-0000-4000-8000-000000000003', '${COACH_B}', 'RLS-DUAL');
      insert into public.commission_payouts (id, affiliate_id, total_cents, created_by) values
        ('77000000-0000-4000-8000-000000000004', '74000000-0000-4000-8000-000000000003', 400, '${OWNER}'),
        ('77000000-0000-4000-8000-000000000005', '74000000-0000-4000-8000-000000000001', 500, '${OWNER}');
      do $$
      declare
        approved_dual bigint;
        approved_other bigint;
      begin
        approved_dual := app.write_audit_row(
          'affiliate.payout.approved', '${OWNER}', null, 'commission_payout',
          '77000000-0000-4000-8000-000000000004', 'Synthetic approval'
        );
        approved_other := app.write_audit_row(
          'affiliate.payout.approved', '${OWNER}', null, 'commission_payout',
          '77000000-0000-4000-8000-000000000005', 'Synthetic approval'
        );
        insert into public.commission_payout_events
          (payout_id, kind, actor_id, audit_id, created_at)
        values
          ('77000000-0000-4000-8000-000000000004', 'approved', '${OWNER}', approved_dual, '2026-08-14'),
          ('77000000-0000-4000-8000-000000000005', 'approved', '${OWNER}', approved_other, '2026-08-15');
      end
      $$;
    `);

    await actAs("authenticated", { role: "coach", tenant_id: TENANT_B, sub: COACH_B });
    const dual = await db.query(
      "select amount_cents, state from public.affiliate_payout_history_projection()",
    );
    await resetRole();
    await actAs("authenticated", { role: "coach", tenant_id: TENANT_A, sub: COACH });
    const plain = await db.query(
      "select amount_cents, state from public.affiliate_payout_history_projection()",
    );

    expect(dual.rows).toEqual([{ amount_cents: "400", state: "approved_for_payout" }]);
    expect(plain.rows).toEqual([]);
  });

  it("exposes exactly one owned three-column projection while hiding referral rows", async () => {
    await actAs("authenticated", { role: "affiliate", sub: AFFILIATE_A });
    const referrals = await db.query<{ count: string }>(
      `select count(*)::text from public.referrals`,
    );
    const projection = await db.query(
      `select * from public.affiliate_referral_projection()`,
    );
    expect(referrals.rows[0].count).toBe("0");
    expect(projection.fields.map((field) => field.name)).toEqual([
      "business_name", "account_status", "commission_earned_cents",
    ]);
    expect(projection.rows).toEqual([{
      business_name: "Referred Alpha",
      account_status: "paying",
      commission_earned_cents: "100",
    }]);
    /*
     * Three columns, at the database boundary this time, and the count is `CLAUDE.md`'s access
     * model: an affiliate "sees only referred-coach name, status, and commission earned — never
     * their performance data." `Affiliate.dc.html` draws a fourth column, Joined, and it was built
     * against `referrals.created_at` and removed before it shipped, because a drawing does not
     * widen what one customer may learn about another. Alec owns that call
     * (`docs/DECISIONS.md`). Only the *values* of `account_status` moved, and narrowing what a
     * field may say is inside this rule rather than a widening of it.
     */
    expect(Object.keys(projection.rows[0] as object)).toEqual([
      "business_name", "account_status", "commission_earned_cents",
    ]);
  });

  /**
   * The four states, proved against real rows rather than against the `case` expression.
   *
   * `phase6-schema` pins that all six enum values map; this pins that the mapping the affiliate
   * actually reads is the one intended -- above all that a coach whose payments have stalled never
   * comes back as `paying`. That was the live defect: `paused`, `overdue` and `suspended` all
   * folded into `active`, telling an affiliate money was still coming from an account that had
   * stopped paying for it.
   */
  it("reads every stalled tenant status as a payment problem and never as paying", async () => {
    const seen: Record<string, string | null> = {};
    for (const status of ["onboarding", "active", "paused", "overdue", "suspended", "churned"]) {
      await resetRole();
      await db.query(`update public.tenants set status = $1::public.tenant_status where id = $2`, [
        status, TENANT_A,
      ]);
      await actAs("authenticated", { role: "affiliate", sub: AFFILIATE_A });
      const projection = await db.query<{ account_status: string | null }>(
        `select account_status from public.affiliate_referral_projection()`,
      );
      seen[status] = projection.rows[0]?.account_status ?? null;
    }

    expect(seen).toEqual({
      onboarding: "setting_up",
      active: "paying",
      paused: "payment_problem",
      overdue: "payment_problem",
      suspended: "payment_problem",
      churned: "cancelled",
    });
    // Said the other way round, because this is the claim the affiliate makes plans on.
    expect(Object.entries(seen).filter(([, state]) => state === "paying").map(([status]) => status))
      .toEqual(["active"]);
  });

  it("keeps the affiliate-visible ledger column set exact without tenant or cost fields", async () => {
    await actAs("authenticated", { role: "affiliate", sub: AFFILIATE_A });
    const ledger = await db.query(`
      select id, referral_id, month, base_cents, commission_cents,
        created_at, stripe_invoice_id, invoice_paid_at, entry_kind,
        reverses_ledger_id, stripe_adjustment_id
      from public.commission_ledger order by id
    `);
    expect(ledger.fields.map((field) => field.name)).toEqual([
      "id", "referral_id", "month", "base_cents", "commission_cents", "created_at", "stripe_invoice_id",
      "invoice_paid_at", "entry_kind", "reverses_ledger_id", "stripe_adjustment_id",
    ]);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].referral_id).toBe("75000000-0000-4000-8000-000000000001");
    expect(Object.keys(ledger.rows[0])).not.toContain("tenant_id");
    await resetRole();
    const catalog = await db.query<{ column_name: string }>(`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'commission_ledger'
      order by column_name
    `);
    expect(catalog.rows.map((row) => row.column_name)).toEqual([
      "base_cents", "commission_cents", "created_at", "entry_kind", "id",
      "invoice_paid_at", "month", "referral_id", "reverses_ledger_id",
      "stripe_adjustment_id", "stripe_invoice_id",
    ]);
  });

  it.each([
    ["coach", COACH, { tenant_id: TENANT_A }],
    ["affiliate", AFFILIATE_A, {}],
    ["success", SUCCESS, {}],
  ] as const)("gives %s no platform-cost or margin rows", async (role, sub, extra) => {
    await actAs("authenticated", { role, sub, ...extra });
    const costs = await db.query<{ count: string }>(
      `select count(*)::text from public.tenant_cost_rollups`,
    );
    const margin = await db.query<{ count: string }>(
      `select count(*)::text from public.platform_margin_projection`,
    );
    expect(costs.rows[0].count).toBe("0");
    expect(margin.rows[0].count).toBe("0");
  });

  it("allows owner/admin complete economics while success remains outside the policy", async () => {
    await actAs("authenticated", { role: "owner", sub: OWNER });
    const costs = await db.query<{ count: string }>(
      `select count(*)::text from public.tenant_cost_rollups
       where tenant_id in ('${TENANT_A}', '${TENANT_B}')`,
    );
    const margin = await db.query<{ count: string }>(
      `select count(*)::text from public.platform_margin_projection
       where tenant_id in ('${TENANT_A}', '${TENANT_B}')`,
    );
    expect(costs.rows[0].count).toBe("2");
    expect(margin.rows[0].count).toBe("2");
  });

  it("denies anon before RLS and denies authenticated direct financial writes", async () => {
    await actAs("anon");
    await db.query("savepoint anon_money");
    await expect(db.query(
      `select count(*) from public.tenant_cost_rollups`,
    )).rejects.toThrow(/permission denied/);
    await db.query("rollback to savepoint anon_money");
    await resetRole();
    await actAs("authenticated", { role: "owner", sub: OWNER });
    await db.query("savepoint direct_money_write");
    await expect(db.query(`
      insert into public.tenant_cost_rollups (
        tenant_id, window_start, window_end, recognized_subscription_cents,
        complete, missing_sources
      ) values ('${TENANT_A}', '2026-09-01', '2026-10-01', 1000, false, '{model}')
    `)).rejects.toThrow(/permission denied/);
    await db.query("rollback to savepoint direct_money_write");
  });

  it("keeps service-role direct append-only writes revoked while RPC execution remains available", async () => {
    await actAs("service_role", {});
    await db.query("savepoint service_direct_write");
    await expect(db.query(`
      insert into public.tenant_cost_rollups (
        tenant_id, window_start, window_end, recognized_subscription_cents,
        complete, missing_sources
      ) values ('${TENANT_A}', '2026-09-01', '2026-10-01', 1000, false, '{model}')
    `)).rejects.toThrow(/permission denied/);
    await db.query("rollback to savepoint service_direct_write");
    const rpc = await db.query<{ complete: boolean }>(`
      select * from public.write_tenant_cost_rollup(
        '${TENANT_A}', '2026-09-01', '2026-10-01', 1000, 10, 20, 30, '{}',
        '{"source":"synthetic"}'
      )
    `);
    expect(rpc.rows[0].complete).toBe(true);
  });
});
