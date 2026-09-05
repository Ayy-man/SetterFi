// Brain import hardening (migration 20261013000013). Live-Postgres-only, like the Phase 2 suite:
// the CHECK constraints, the RPC transitions and the same-transaction audit custody cannot be
// mocked.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL =
  process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const TENANT_A = "3a000000-0000-4000-8000-000000000010";
const TENANT_MISSING = "3a000000-0000-4000-8000-0000000000ff";
const ADMIN = "3a100000-0000-4000-8000-000000000010";

let db: Client;

function vector(x: number) {
  return `[${[x, ...Array<number>(1535).fill(0)].join(",")}]`;
}

async function actAs(pgRole: "authenticated" | "service_role", actorId: string, role: "admin" | "coach") {
  await db.query(`set local role ${pgRole}`);
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({
    sub: actorId,
    app_metadata: { role },
  })]);
}

async function resetRole() {
  await db.query("reset role");
  await db.query(`select set_config('request.jwt.claims', '{}', true)`);
}

async function expectDbError(sql: string, params: readonly unknown[], expected: string | RegExp) {
  await db.query("savepoint expected_failure");
  let error: unknown;
  try {
    await db.query(sql, params as unknown[]);
  } catch (cause) {
    error = cause;
  }
  await db.query("rollback to savepoint expected_failure");
  expect(error).toBeDefined();
  if (typeof expected === "string") expect(String(error)).toContain(expected);
  else expect(String(error)).toMatch(expected);
}

async function openBatch() {
  return (await db.query<{ id: string }>(`
    insert into public.brain_import_batches
      (source,collection_ref,source_hash,received_count,normalized_count,flagged_count,unchanged_count,created_by,brand_names)
    values ('mock','synthetic','${"a".repeat(64)}',1,1,1,0,$1,array['Legacy Strong']) returning id
  `, [ADMIN])).rows[0].id;
}

async function pendingItem(batch: string, sourceRef: string, flags: unknown[] = []) {
  return (await db.query<{ id: string }>(`
    insert into public.brain_import_items (batch_id,source_ref,operation,after_payload,flags)
    values ($1,$2,'new',$3,$4) returning id
  `, [batch, sourceRef, {
    inboundMessage: "Synthetic inbound", responseTemplate: "Synthetic response", category: "Credit",
  }, JSON.stringify(flags)])).rows[0].id;
}

const ACCEPT = `select * from public.accept_brain_import_item($1,$2,$3,$4,$5,$6::vector,$7,$8)`;
const REJECT = `select public.reject_brain_import_item($1,$2,$3,$4,$5) as audit_id`;

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(
      `Brain import hardening suite could not reach Postgres at ${DB_URL}. ` +
        "Start the local Supabase stack; this suite fails rather than skips.",
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
    insert into public.tenants (id, slug, name, billing_contact_email, is_demo) values
      ('${TENANT_A}', 'hardening-a', 'Hardening A', 'billing-a@hardening.test', true);
    insert into public.users (id, email, role, tenant_id) values
      ('${ADMIN}', 'admin@hardening.test', 'admin', null);
  `);
});

afterEach(async () => {
  await db.query("rollback");
});

describe("tenant_specific is a route", () => {
  it("ties tenant_id to the disposition on both tables in both directions", async () => {
    await expectDbError(
      `insert into public.brain_knowledge_entries
         (question, answer, category, status, source, source_ref, disposition, response_template)
       values ('q', 'a', 'Credit', 'draft', 'mock', 'no-tenant', 'tenant_specific', 'a')`,
      [], "brain_knowledge_entries_tenant_route_chk",
    );
    await expectDbError(
      `insert into public.brain_knowledge_entries
         (question, answer, category, status, source, source_ref, disposition, response_template, tenant_id)
       values ('q', 'a', 'Credit', 'draft', 'mock', 'shared-with-tenant', 'shared', 'a', $1)`,
      [TENANT_A], "brain_knowledge_entries_tenant_route_chk",
    );
    const batch = await openBatch();
    const item = await pendingItem(batch, "row");
    await expectDbError(
      `update public.brain_import_items set disposition = 'tenant_specific' where id = $1`,
      [item], "brain_import_items_tenant_route_chk",
    );
    await expectDbError(
      `update public.brain_import_items set disposition = 'shared', tenant_id = $2 where id = $1`,
      [item, TENANT_A], "brain_import_items_tenant_route_chk",
    );
  });

  it("refuses tenant_specific without a tenant, a tenant on any other disposition, and an unknown tenant", async () => {
    const batch = await openBatch();
    const item = await pendingItem(batch, "row");
    const before = (await db.query(`select count(*)::int c from public.brain_knowledge_entries`)).rows[0].c;
    await actAs("service_role", ADMIN, "admin");
    await expectDbError(ACCEPT, [batch, "row", item, "tenant_specific", "[]", vector(1), ADMIN, null],
      "BRAIN_IMPORT_TENANT_REQUIRED");
    await expectDbError(ACCEPT, [batch, "row", item, "shared", "[]", vector(1), ADMIN, TENANT_A],
      "BRAIN_IMPORT_TENANT_NOT_ALLOWED");
    await expectDbError(ACCEPT, [batch, "row", item, "tenant_specific", "[]", vector(1), ADMIN, TENANT_MISSING],
      "BRAIN_IMPORT_TENANT_NOT_FOUND");
    await resetRole();
    expect((await db.query(`select count(*)::int c from public.brain_knowledge_entries`)).rows[0].c).toBe(before);
    expect((await db.query(`select decision from public.brain_import_items where id = $1`, [item])).rows[0].decision)
      .toBe("pending");
  });

  it("writes a tenant-scoped draft entry and records the tenant on the item and in the audit payload", async () => {
    const batch = await openBatch();
    const item = await pendingItem(batch, "row");
    await actAs("service_role", ADMIN, "admin");
    const accepted = (await db.query<{ knowledge_entry_id: string; audit_id: string }>(
      ACCEPT, [batch, "row", item, "tenant_specific", "[]", vector(1), ADMIN, TENANT_A],
    )).rows[0];
    await resetRole();
    const entry = (await db.query(
      `select disposition, tenant_id, status from public.brain_knowledge_entries where id = $1`,
      [accepted.knowledge_entry_id],
    )).rows[0];
    expect(entry).toEqual({ disposition: "tenant_specific", tenant_id: TENANT_A, status: "draft" });
    const itemRow = (await db.query(
      `select decision, disposition, tenant_id from public.brain_import_items where id = $1`, [item],
    )).rows[0];
    expect(itemRow).toEqual({ decision: "accepted", disposition: "tenant_specific", tenant_id: TENANT_A });
    const audit = (await db.query(
      `select action, payload ->> 'tenant_id' tenant_id from public.audit_log where id = $1`, [accepted.audit_id],
    )).rows[0];
    expect(audit).toEqual({ action: "brain.import.accepted", tenant_id: TENANT_A });
  });

  it("still accepts the legacy seven-argument call for a shared row with no tenant", async () => {
    const batch = await openBatch();
    const item = await pendingItem(batch, "row");
    await actAs("service_role", ADMIN, "admin");
    const accepted = (await db.query<{ knowledge_entry_id: string }>(
      `select * from public.accept_brain_import_item($1,$2,$3,$4,$5,$6::vector,$7)`,
      [batch, "row", item, "shared", "[]", vector(1), ADMIN],
    )).rows[0];
    await resetRole();
    const entry = (await db.query(
      `select disposition, tenant_id from public.brain_knowledge_entries where id = $1`, [accepted.knowledge_entry_id],
    )).rows[0];
    expect(entry).toEqual({ disposition: "shared", tenant_id: null });
  });
});

describe("content flags on a shared row", () => {
  const ticked = [{
    id: "proof_claim:responseTemplate:0", code: "proof_claim", severity: "blocking", field: "responseTemplate",
    offset: 0, resolved: true, resolution: { kind: "admin_review", value: "shared" },
  }];
  const edited = [{ ...ticked[0], resolution: { kind: "edited", value: null } }];

  it("refuses a ticked-but-unedited content flag for shared and allows it for quarantine", async () => {
    const batch = await openBatch();
    const item = await pendingItem(batch, "row", ticked);
    await actAs("service_role", ADMIN, "admin");
    await expectDbError(ACCEPT, [batch, "row", item, "shared", "[]", vector(1), ADMIN, null],
      "BRAIN_IMPORT_CONTENT_FLAG_NOT_EDITED");
    const quarantined = (await db.query<{ knowledge_entry_id: string }>(
      ACCEPT, [batch, "row", item, "needs_rewrite", "[]", vector(1), ADMIN, null],
    )).rows[0];
    await resetRole();
    expect(quarantined.knowledge_entry_id).toBeTruthy();
  });

  it("accepts a shared row whose content flags were resolved by an edit", async () => {
    const batch = await openBatch();
    const item = await pendingItem(batch, "row", edited);
    await actAs("service_role", ADMIN, "admin");
    const accepted = (await db.query<{ knowledge_entry_id: string }>(
      ACCEPT, [batch, "row", item, "shared", "[]", vector(1), ADMIN, null],
    )).rows[0];
    await resetRole();
    expect(accepted.knowledge_entry_id).toBeTruthy();
  });
});

describe("rejection", () => {
  it("is registered as a reason-required platform audit action", async () => {
    const row = (await db.query(
      `select actor_kind, scope, reason_required from public.audit_actions where key = 'brain.import.rejected'`,
    )).rows[0];
    expect(row).toEqual({ actor_kind: "human", scope: "platform", reason_required: true });
  });

  it("requires a reason, refuses stale identity, and leaves the item pending on refusal", async () => {
    const batch = await openBatch();
    const item = await pendingItem(batch, "row");
    await actAs("service_role", ADMIN, "admin");
    await expectDbError(REJECT, [batch, "row", item, "   ", ADMIN], "BRAIN_IMPORT_REJECT_REASON_REQUIRED");
    await expectDbError(REJECT, [batch, "other-row", item, "Duplicate.", ADMIN], "BRAIN_IMPORT_ITEM_STALE");
    await resetRole();
    expect((await db.query(`select decision from public.brain_import_items where id = $1`, [item])).rows[0].decision)
      .toBe("pending");
    expect((await db.query(
      `select count(*)::int c from public.audit_log where action = 'brain.import.rejected'`,
    )).rows[0].c).toBe(0);
  });

  it("flips the decision and writes the audit row with the reason, then refuses a second decision", async () => {
    const batch = await openBatch();
    const item = await pendingItem(batch, "row");
    await actAs("service_role", ADMIN, "admin");
    const auditId = (await db.query<{ audit_id: string }>(REJECT, [batch, "row", item, "Duplicate.", ADMIN]))
      .rows[0].audit_id;
    await expectDbError(REJECT, [batch, "row", item, "Again.", ADMIN], "BRAIN_IMPORT_ITEM_NOT_PENDING");
    await expectDbError(ACCEPT, [batch, "row", item, "shared", "[]", vector(1), ADMIN, null],
      "BRAIN_IMPORT_ITEM_NOT_ACCEPTABLE");
    await resetRole();
    const itemRow = (await db.query(
      `select decision, decided_by from public.brain_import_items where id = $1`, [item],
    )).rows[0];
    expect(itemRow).toEqual({ decision: "rejected", decided_by: ADMIN });
    const audit = (await db.query(
      `select action, reason, target_id from public.audit_log where id = $1`, [auditId],
    )).rows[0];
    expect(audit).toEqual({ action: "brain.import.rejected", reason: "Duplicate.", target_id: item });
    expect((await db.query(`select count(*)::int c from public.brain_knowledge_entries`)).rows[0].c).toBe(0);
  });

  it("is not callable by authenticated users", async () => {
    const batch = await openBatch();
    const item = await pendingItem(batch, "row");
    await actAs("authenticated", ADMIN, "admin");
    await expectDbError(REJECT, [batch, "row", item, "Duplicate.", ADMIN], /permission denied/);
    await resetRole();
  });
});
