// Round-robin fairness depends on persisted cursor state and transaction locks, so it is verified
// against the migrated database rather than inferred from query ordering in a unit mock.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL = process.env.RLS_TEST_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const TENANTS = [1, 2, 3, 4, 5].map((suffix) =>
  `81000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`);
const CONTACTS = [1, 2, 3, 4, 5].map((suffix) =>
  `82000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`);
const CONVERSATIONS = [1, 2, 3, 4, 5].map((suffix) =>
  `83000000-0000-4000-8000-${suffix.toString().padStart(12, "0")}`);

let db: Client;

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(
      `Job fairness suite could not reach Postgres at ${DB_URL}. Start the local Supabase stack; ` +
        "this suite fails rather than skips.",
      { cause },
    );
  }
});

afterAll(async () => db?.end());

beforeEach(async () => {
  await db.query("begin");
  for (let index = 0; index < TENANTS.length; index += 1) {
    const status = index === TENANTS.length - 1 ? "canceled" : "active";
    await db.query(`
      insert into public.tenants (id,slug,name,billing_contact_email)
        values ($1,$2,$3,$4)
    `, [
      TENANTS[index],
      `fairness-${index + 1}`,
      `Fairness ${index + 1}`,
      `fairness-${index + 1}@example.test`,
    ]);
    await db.query(`
      insert into public.contacts (id,tenant_id,last_channel,name)
        values ($1,$2,'sms',$3)
    `, [
      CONTACTS[index],
      TENANTS[index],
      `Fairness ${index + 1}`,
    ]);
    await db.query(`
      insert into public.conversations
        (id,tenant_id,contact_id,channel,status,status_reason,needs_human_at)
        values ($1,$2,$3,'sms','needs_human','lead_requested_human',now()-interval '25 hours')
    `, [
      CONVERSATIONS[index],
      TENANTS[index],
      CONTACTS[index],
    ]);
    await db.query(`
      insert into public.billing_subscriptions
        (tenant_id,stripe_customer_id,stripe_subscription_id,stripe_price_id,status,
         current_period_start,current_period_end,provider_updated_at)
        values ($1,$2,$3,'price_fairness',$4,now()-interval '1 day',now()+interval '29 days',now())
    `, [
      TENANTS[index],
      `customer-fairness-${index + 1}`,
      `subscription-fairness-${index + 1}`,
      status,
    ]);
  }
});

afterEach(async () => db.query("rollback"));

async function tenantBatch(job: string, limit: number) {
  const result = await db.query<{ tenant_id: string }>(
    "select * from public.claim_fair_tenant_batch($1,$2)",
    [job, limit],
  );
  return result.rows.map((row) => row.tenant_id);
}

describe("durable job scan fairness", () => {
  it("walks past the fixed head, wraps once, and keeps job cursors independent", async () => {
    await expect(tenantBatch("followups", 2)).resolves.toEqual(TENANTS.slice(0, 2));
    await expect(tenantBatch("followups", 2)).resolves.toEqual(TENANTS.slice(2, 4));
    await expect(tenantBatch("followups", 2)).resolves.toEqual([TENANTS[4], TENANTS[0]]);
    await expect(tenantBatch("compliance_lifecycle", 2)).resolves.toEqual(TENANTS.slice(0, 2));
  });

  it("rotates only eligible subscriptions for allowance work", async () => {
    const first = await db.query<{ tenant_id: string }>(`
      select * from public.claim_fair_billing_subscription_batch(
        'billing_allowances',2,array['active','trialing','past_due']::text[]
      )
    `);
    const second = await db.query<{ tenant_id: string }>(`
      select * from public.claim_fair_billing_subscription_batch(
        'billing_allowances',2,array['active','trialing','past_due']::text[]
      )
    `);
    const wrapped = await db.query<{ tenant_id: string }>(`
      select * from public.claim_fair_billing_subscription_batch(
        'billing_allowances',2,array['active','trialing','past_due']::text[]
      )
    `);
    expect(first.rows.map((row) => row.tenant_id)).toEqual(TENANTS.slice(0, 2));
    expect(second.rows.map((row) => row.tenant_id)).toEqual(TENANTS.slice(2, 4));
    expect(wrapped.rows.map((row) => row.tenant_id)).toEqual(TENANTS.slice(0, 2));
    expect([...first.rows, ...second.rows, ...wrapped.rows])
      .not.toContainEqual({ tenant_id: TENANTS[4] });
  });

  it("rotates persistent needs-human rows instead of reselecting the oldest hundred", async () => {
    const first = await db.query<{ conversation_id: string }>(
      "select * from public.claim_fair_needs_human_batch(3)",
    );
    const second = await db.query<{ conversation_id: string }>(
      "select * from public.claim_fair_needs_human_batch(3)",
    );
    expect(first.rows.map((row) => row.conversation_id)).toEqual(CONVERSATIONS.slice(0, 3));
    expect(second.rows.map((row) => row.conversation_id)).toEqual([
      CONVERSATIONS[3], CONVERSATIONS[4], CONVERSATIONS[0],
    ]);
  });

  it("walks past permanently failed Stripe receipts instead of pinning the retry head", async () => {
    for (let index = 0; index < 5; index += 1) {
      await db.query(`
        insert into public.webhook_events
          (id,provider,provider_event_id,event_type,signature_verified,payload,status,error)
        values ($1,'stripe',$2,'invoice.paid',true,'{}'::jsonb,'failed','PERMANENT_TEST_FAILURE')
      `, [
        `84000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`,
        `fairness-stripe-${index + 1}`,
      ]);
    }
    const first = await db.query<{ receipt_id: string }>(
      "select * from public.claim_fair_stripe_receipt_batch(2)",
    );
    const second = await db.query<{ receipt_id: string }>(
      "select * from public.claim_fair_stripe_receipt_batch(2)",
    );
    expect(first.rows.map((row) => row.receipt_id)).toEqual([
      "84000000-0000-4000-8000-000000000001",
      "84000000-0000-4000-8000-000000000002",
    ]);
    expect(second.rows.map((row) => row.receipt_id)).toEqual([
      "84000000-0000-4000-8000-000000000003",
      "84000000-0000-4000-8000-000000000004",
    ]);
  });

  it("walks past invalid GHL lifecycle receipts instead of pinning reconciliation", async () => {
    for (let index = 0; index < 5; index += 1) {
      await db.query(`
        insert into public.webhook_events
          (id,provider,provider_event_id,event_type,signature_verified,payload,status,error)
        values ($1,'ghl',$2,'INSTALL',true,'{}'::jsonb,'failed','INSTALL_RECEIPT_INVALID')
      `, [
        `85000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`,
        `fairness-ghl-lifecycle-${index + 1}`,
      ]);
    }
    const first = await db.query<{ receipt_id: string }>(
      "select * from public.claim_fair_ghl_lifecycle_receipt_batch(2)",
    );
    const second = await db.query<{ receipt_id: string }>(
      "select * from public.claim_fair_ghl_lifecycle_receipt_batch(2)",
    );
    expect(first.rows.map((row) => row.receipt_id)).toEqual([
      "85000000-0000-4000-8000-000000000001",
      "85000000-0000-4000-8000-000000000002",
    ]);
    expect(second.rows.map((row) => row.receipt_id)).toEqual([
      "85000000-0000-4000-8000-000000000003",
      "85000000-0000-4000-8000-000000000004",
    ]);
  });

  it("forces cursor RLS and gives only service_role transition custody", async () => {
    const table = await db.query<{
      forced: boolean;
      service_select: boolean;
      authenticated_select: boolean;
    }>(`
      select relforcerowsecurity forced,
        has_table_privilege('service_role','public.job_scan_cursors','select') service_select,
        has_table_privilege('authenticated','public.job_scan_cursors','select') authenticated_select
      from pg_class where oid='public.job_scan_cursors'::regclass
    `);
    expect(table.rows).toEqual([{
      forced: true,
      service_select: false,
      authenticated_select: false,
    }]);
    const functions = await db.query<{ name: string; anon: boolean; service: boolean }>(`
      select p.proname name,
        has_function_privilege('anon',p.oid,'execute') anon,
        has_function_privilege('service_role',p.oid,'execute') service
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in (
        'claim_fair_tenant_batch','claim_fair_billing_subscription_batch',
        'claim_fair_needs_human_batch','claim_fair_stripe_receipt_batch',
        'claim_fair_ghl_lifecycle_receipt_batch'
      ) order by 1
    `);
    expect(functions.rows).toEqual([
      { name: "claim_fair_billing_subscription_batch", anon: false, service: true },
      { name: "claim_fair_ghl_lifecycle_receipt_batch", anon: false, service: true },
      { name: "claim_fair_needs_human_batch", anon: false, service: true },
      { name: "claim_fair_stripe_receipt_batch", anon: false, service: true },
      { name: "claim_fair_tenant_batch", anon: false, service: true },
    ]);
  });
});
