// Phase 2 schema contract. This suite is intentionally live-Postgres-only: catalog grants,
// forced RLS, transition locks, vector ordering, and transactional audit custody cannot be mocked.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

import {
  COMPLIANCE_RULE_IDS,
  OFFER_BOUNDS,
  OFFER_PRODUCTS,
  brainObjectionDraftEntity,
} from "@/lib/brain/contracts";

const DB_URL =
  process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const TENANT_A = "30000000-0000-4000-8000-000000000010";
const TENANT_B = "30000000-0000-4000-8000-000000000020";
const ADMIN = "31000000-0000-4000-8000-000000000010";
const COACH_A = "31000000-0000-4000-8000-000000000020";
const COACH_B = "31000000-0000-4000-8000-000000000030";
const OFFER_A = "32000000-0000-4000-8000-000000000010";
const MODEL = "33000000-0000-4000-8000-000000000010";
const CONTACT = "35000000-0000-4000-8000-000000000010";
const CONVERSATION = "35000000-0000-4000-8000-000000000020";
const MESSAGE = "35000000-0000-4000-8000-000000000030";

const NEW_TABLES = [
  "admin_action_templates",
  "brain_draft_versions",
  "brain_import_batches",
  "brain_import_items",
  "brain_mission",
  "brain_objection_usage_events",
  "brain_snapshot_entries",
  "brain_snapshot_objections",
  "brain_snapshots",
  "compliance_rules",
  "contact_notes",
  "holding_replies",
  "offer_assets",
  "offer_prices",
  "offer_proof_entries",
];

const PLATFORM_TABLES = [
  "brain_draft_versions",
  "brain_import_batches",
  "brain_import_items",
  "brain_mission",
  "brain_snapshot_entries",
  "brain_snapshot_objections",
  "brain_snapshots",
  "compliance_rules",
  "holding_replies",
];

const TRANSITION_RPCS = [
  "accept_brain_import_item",
  "create_brain_draft_version",
  "finish_platform_export",
  "match_published_brain_entries",
  "publish_brain_draft",
  "publish_offer_draft",
  "record_eval_run",
  "rollback_brain_snapshot",
  "save_offer_draft",
  "start_platform_export",
];

const EXPECTED_INDEXES = [
  "admin_action_templates_tenant_idx",
  "brain_draft_versions_hash_idx",
  "brain_knowledge_entries_source_ref_uidx",
  "brain_mission_one_draft_uidx",
  "brain_mission_one_published_uidx",
  "brain_objection_usage_events_message_uidx",
  "brain_objection_usage_events_objection_idx",
  "brain_objection_usage_events_tenant_idx",
  "brain_snapshot_entries_embedding_hnsw",
  "brain_snapshot_entries_snapshot_idx",
  "brain_snapshot_objections_keywords_idx",
  "brain_snapshot_objections_snapshot_idx",
  "brain_snapshots_hash_idx",
  "contact_notes_contact_idx",
  "eval_case_results_run_case_uidx",
  "offer_assets_offer_idx",
  "offer_layers_one_draft_uidx",
  "offer_layers_one_published_uidx",
  "offer_layers_tenant_status_idx",
  "offer_prices_offer_idx",
  "offer_proof_entries_offer_idx",
].sort();

const SUITES = [
  "compliance_guardrails",
  "pricing_discipline",
  "jailbreak_injection",
  "output_integrity",
  "qualification_accuracy",
  "voice_tone",
] as const;

let db: Client;

function vector(x: number, y = 0) {
  return `[${[x, y, ...Array<number>(1534).fill(0)].join(",")}]`;
}

function suiteResults(failingSuite?: (typeof SUITES)[number]) {
  return SUITES.map((suite) => ({
    suite,
    cases: [{ caseKey: `${suite}-synthetic`, passed: suite !== failingSuite, trace: { synthetic: true } }],
  }));
}

async function actAs(
  pgRole: "authenticated" | "anon" | "service_role",
  actorId: string,
  role: "admin" | "coach",
  tenantId?: string,
) {
  await db.query(`set local role ${pgRole}`);
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({
    sub: actorId,
    app_metadata: { role, tenant_id: tenantId },
  })]);
}

async function resetRole() {
  await db.query("reset role");
  await db.query(`select set_config('request.jwt.claims', '{}', true)`);
}

async function expectDbError(
  sql: string,
  params: readonly unknown[],
  expected: string | RegExp,
) {
  await db.query("savepoint expected_phase2_failure");
  let error: unknown;
  try {
    await db.query(sql, params as unknown[]);
  } catch (cause) {
    error = cause;
  }
  await db.query("rollback to savepoint expected_phase2_failure");
  expect(error).toBeDefined();
  if (typeof expected === "string") expect(String(error)).toContain(expected);
  else expect(String(error)).toMatch(expected);
}

async function insertDraft(payload: Record<string, unknown>) {
  await resetRole();
  const hash = (await db.query<{ hash: string }>(
    `select app.phase2_json_hash($1::jsonb) as hash`, [payload],
  )).rows[0].hash;
  const id = (await db.query<{ id: string }>(
    `insert into public.brain_draft_versions (content_hash, payload, created_by)
     values ($1, $2, $3) returning id`,
    [hash, payload, ADMIN],
  )).rows[0].id;
  return { id, hash };
}

async function recordEval(
  draft: { id: string; hash: string },
  kind: "checker" | "engine" = "checker",
  failingSuite?: (typeof SUITES)[number],
) {
  await actAs("service_role", ADMIN, "admin");
  const id = (await db.query<{ id: string }>(
    `select public.record_eval_run($1, $2, $3, $4, $5, $6) as id`,
    [draft.id, draft.hash, kind, kind === "engine" ? MODEL : null, "synthetic-v1",
      JSON.stringify(suiteResults(failingSuite))],
  )).rows[0].id;
  await resetRole();
  return id;
}

async function publishDraft(draft: { id: string; hash: string }, evalRunId: string, reason: string) {
  await actAs("service_role", ADMIN, "admin");
  const row = (await db.query<{ snapshot_id: string; brain_version: number; audit_id: string }>(
    `select * from public.publish_brain_draft($1, $2, $3, $4, $5)`,
    [ADMIN, draft.id, draft.hash, evalRunId, reason],
  )).rows[0];
  await resetRole();
  return row;
}

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(
      `Phase 2 schema suite could not reach Postgres at ${DB_URL}. ` +
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
      ('${TENANT_A}', 'phase2-a', 'Phase 2 A', 'billing-a@phase2.test', true),
      ('${TENANT_B}', 'phase2-b', 'Phase 2 B', 'billing-b@phase2.test', false);
    insert into public.users (id, email, role, tenant_id) values
      ('${ADMIN}', 'admin@phase2.test', 'admin', null),
      ('${COACH_A}', 'coach-a@phase2.test', 'coach', '${TENANT_A}'),
      ('${COACH_B}', 'coach-b@phase2.test', 'coach', '${TENANT_B}');
    insert into public.tenant_settings (tenant_id, link_whitelist) values
      ('${TENANT_A}', array['phase2.test']), ('${TENANT_B}', array['phase2.test']);
    update public.tenant_settings
      set link_whitelist = array['phase2.test'] where tenant_id in ('${TENANT_A}', '${TENANT_B}');
    insert into public.brain_documents (title, section, body_md, status)
      values ('Synthetic document', 'knowledge', 'Synthetic body', 'draft');
    insert into public.brain_objections (label, response, category, status)
      values ('Synthetic objection', 'Synthetic response', 'clarity', 'draft');
    insert into public.qualification_rules (rule_key, label, position, outcome, status)
      values ('phase2-synthetic', 'Synthetic rule', 9000, 'BOOK', 'draft');
    insert into public.flow_configs (tenant_id, questions, version, status)
      values ('${TENANT_A}', '[]', 1, 'draft');
    insert into public.contacts (id, tenant_id, last_channel, name)
      values ('${CONTACT}', '${TENANT_A}', 'sms', 'Synthetic contact');
    insert into public.conversations (id, tenant_id, contact_id, channel)
      values ('${CONVERSATION}', '${TENANT_A}', '${CONTACT}', 'sms');
    insert into public.messages (id, tenant_id, conversation_id, direction, author, body)
      values ('${MESSAGE}', '${TENANT_A}', '${CONVERSATION}', 'in', 'lead', 'Synthetic message');
    insert into public.message_traces (message_id, tenant_id)
      values ('${MESSAGE}', '${TENANT_A}');
    insert into public.offer_layers
      (id, tenant_id, status, version, program_name, products, content_hash)
      values ('${OFFER_A}', '${TENANT_A}', 'draft', 1, 'Synthetic program', '{}', null);
    insert into public.offer_cadence_purposes
      (tenant_id, offer_id, channel_class, touch_no, purpose)
      values ('${TENANT_A}', '${OFFER_A}', 'window_bound', 1, 'value_nudge');
    insert into public.brain_knowledge_entries
      (question, answer, category, status, source, source_ref, disposition, response_template)
      values ('Synthetic question', 'Synthetic template', 'general', 'draft', 'mock',
        'phase2-touched-row', 'needs_rewrite', 'Synthetic template');
    insert into public.model_configs (id, label, openrouter_model, role, active)
      values ('${MODEL}', 'Synthetic model', 'mock/phase2', 'generator', false);
    insert into public.eval_cases
      (category, turns, expectation, suite, kind, created_by)
      values ('qualification', '["Synthetic turn"]', '{}', 'qualification_accuracy', 'engine', '${ADMIN}');
  `);
});

afterEach(async () => {
  await db.query("rollback");
});

describe("Phase 2 catalog and custody", () => {
  it("owns the exact new table, altered-column, index, enum, and cadence-PK contract", async () => {
    const tables = await db.query<{ relname: string; relforcerowsecurity: boolean }>(`
      select c.relname, c.relforcerowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname = any($1::text[])
      order by c.relname
    `, [NEW_TABLES]);
    expect(tables.rows.map((row) => row.relname)).toEqual(NEW_TABLES);
    expect(tables.rows.every((row) => row.relforcerowsecurity)).toBe(true);

    const columns = await db.query<{ table_name: string; column_name: string }>(`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and (table_name, column_name) in (
        ('brain_knowledge_entries','embedding'), ('offer_layers','status'),
        ('offer_cadence_purposes','offer_id'), ('eval_cases','turns'),
        ('eval_runs','brain_draft_version_id'), ('eval_case_results','case_key'),
        ('message_traces','moderator_class'), ('message_traces','moderator_model_config_id'),
        ('message_traces','moderator_rule_id'), ('message_traces','retrieval_candidates'),
        ('tenant_settings','link_whitelist')
      ) order by table_name, column_name
    `);
    expect(columns.rows).toEqual([
      { table_name: "brain_knowledge_entries", column_name: "embedding" },
      { table_name: "eval_case_results", column_name: "case_key" },
      { table_name: "eval_cases", column_name: "turns" },
      { table_name: "eval_runs", column_name: "brain_draft_version_id" },
      { table_name: "message_traces", column_name: "moderator_class" },
      { table_name: "message_traces", column_name: "moderator_model_config_id" },
      { table_name: "message_traces", column_name: "moderator_rule_id" },
      { table_name: "message_traces", column_name: "retrieval_candidates" },
      { table_name: "offer_cadence_purposes", column_name: "offer_id" },
      { table_name: "offer_layers", column_name: "status" },
      { table_name: "tenant_settings", column_name: "link_whitelist" },
    ]);

    const indexes = await db.query<{ indexname: string }>(`
      select indexname from pg_indexes where schemaname='public' and indexname=any($1::text[])
      order by indexname
    `, [EXPECTED_INDEXES]);
    expect(indexes.rows.map((row) => row.indexname)).toEqual(EXPECTED_INDEXES);

    const status = await db.query<{ enumlabel: string }>(`
      select e.enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid
      where t.typname='publish_status' order by e.enumsortorder
    `);
    expect(status.rows.map((row) => row.enumlabel)).toEqual(["draft", "published", "superseded"]);

    const pk = await db.query<{ columns: string[] }>(`
      select array_agg(a.attname::text order by u.ordinality)::text[] as columns
      from pg_constraint c
      cross join unnest(c.conkey) with ordinality u(attnum, ordinality)
      join pg_attribute a on a.attrelid=c.conrelid and a.attnum=u.attnum
      where c.conrelid='public.offer_cadence_purposes'::regclass and c.contype='p'
    `);
    expect(pk.rows[0].columns).toEqual(["tenant_id", "channel_class", "touch_no"]);
  });

  it("gives authenticated users SELECT only on every new table and eval history", async () => {
    const grants = await db.query<{ table_name: string; privileges: string[] }>(`
      select table_name, array_agg(privilege_type::text order by privilege_type)::text[] as privileges
      from information_schema.role_table_grants
      where table_schema='public' and grantee='authenticated'
        and table_name = any($1::text[])
      group by table_name order by table_name
    `, [[...NEW_TABLES, "eval_runs", "eval_case_results"]]);
    expect(grants.rows.map((row) => row.table_name)).toEqual(
      [...NEW_TABLES, "eval_case_results", "eval_runs"].sort(),
    );
    expect(grants.rows.every((row) => row.privileges.join(",") === "SELECT")).toBe(true);

    const policies = await db.query<{ tablename: string; commands: string[] }>(`
      select tablename, array_agg(cmd::text order by cmd)::text[] as commands from pg_policies
      where schemaname='public' and tablename=any($1::text[])
      group by tablename order by tablename
    `, [PLATFORM_TABLES]);
    expect(policies.rows.map((row) => row.tablename)).toEqual(PLATFORM_TABLES);
    expect(policies.rows.every((row) => row.commands.join(",") === "SELECT")).toBe(true);
  });

  it("pins every transition RPC search path and execute grant to service_role", async () => {
    const functions = await db.query<{ proname: string; proconfig: string[]; grantees: string[] }>(`
      select p.proname, p.proconfig,
        array(
          select coalesce(r.rolname, 'PUBLIC')::text
          from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
          left join pg_roles r on r.oid=acl.grantee
          where acl.privilege_type='EXECUTE' and r.rolname <> 'postgres'
          order by coalesce(r.rolname, 'PUBLIC')
        )::text[] as grantees
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=any($1::text[])
      order by p.proname
    `, [TRANSITION_RPCS]);
    expect(functions.rows.map((row) => row.proname)).toEqual(TRANSITION_RPCS);
    expect(functions.rows.every((row) => row.proconfig.includes('search_path=""'))).toBe(true);
    expect(functions.rows.every((row) => row.grantees.join(",") === "service_role")).toBe(true);
  });

  it("keeps compliance identifiers and offer bounds identical in SQL and TypeScript", async () => {
    const ids = await db.query<{ id: string }>(`select id from public.compliance_rules order by id`);
    expect(ids.rows.map((row) => row.id)).toEqual([...COMPLIANCE_RULE_IDS]);
    expect((COMPLIANCE_RULE_IDS as readonly string[]).includes("UNKNOWN-999")).toBe(false);
    expect(OFFER_BOUNDS).toMatchObject({
      price: { maxRows: 8, labelMax: 60 },
      proof: { maxRows: 12, titleMax: 90, detailMax: 280 },
      asset: { maxRows: 12 }, voiceAnswerMax: 180, productsMax: 12,
    });
    expect(OFFER_PRODUCTS).toEqual([
      "personal CC", "personal loans", "biz CC", "biz line of credit", "biz term loans",
    ]);
  });

  it("refuses an objection category outside the five and lets pricing carry a hard gate", async () => {
    await resetRole();

    // The vocabulary rule lives in the database, not in a fixture array a test reads back
    // to itself. 'trust' is the value the hosted row carried before the backfill, so this
    // is the exact write the constraint exists to stop.
    await db.query("savepoint expected_objection_category_failure");
    let error: unknown;
    try {
      await db.query(`
        insert into public.brain_objections (label, response, category, status)
        values ('Rejected objection', 'Rejected response', 'trust', 'draft')
      `);
    } catch (cause) {
      error = cause;
    }
    await db.query("rollback to savepoint expected_objection_category_failure");
    expect((error as { code?: string } | undefined)?.code).toBe("23514");
    expect(String(error)).toContain("brain_objections_category_check");

    // The locked decision, asserted where it is actually enforced: the gate is orthogonal
    // to the category, so an objection can be both 'pricing' and gated on the same row.
    const gated = await db.query<{ category: string; hard_gate: boolean }>(`
      insert into public.brain_objections (label, response, category, status, hard_gate)
      values ('Gated pricing objection', 'Gated response', 'pricing', 'draft', true)
      returning category, hard_gate
    `);
    expect(gated.rows[0]).toEqual({ category: "pricing", hard_gate: true });

    // No category value is 'hard_gate', and the flag defaults off rather than null.
    const defaulted = await db.query<{ hard_gate: boolean }>(`
      insert into public.brain_objections (label, response, category, status)
      values ('Ungated objection', 'Ungated response', 'timing', 'draft')
      returning hard_gate
    `);
    expect(defaulted.rows[0].hard_gate).toBe(false);

    const notNull = await db.query<{ is_nullable: string }>(`
      select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'brain_objections'
        and column_name = 'category'
    `);
    expect(notNull.rows[0].is_nullable).toBe("NO");
  });
});

describe("offer, eval, and tenant write boundaries", () => {
  it("refuses direct coach writes, link-whitelist updates, and cross-tenant config reads", async () => {
    await actAs("authenticated", COACH_A, "coach", TENANT_A);
    await expectDbError(
      `insert into public.offer_prices (offer_id, tenant_id, label, amount_cents)
       values ($1,$2,'Synthetic price',100)`,
      [OFFER_A, TENANT_A], /permission denied/,
    );
    await expectDbError(
      `update public.tenant_settings set link_whitelist=array['other.test'] where tenant_id=$1`,
      [TENANT_A], /permission denied/,
    );
    const timezone = await db.query(
      `update public.tenant_settings set timezone='UTC' where tenant_id=$1 returning timezone`,
      [TENANT_A],
    );
    expect(timezone.rows[0].timezone).toBe("UTC");
    const settings = await db.query(`select tenant_id from public.tenant_settings order by tenant_id`);
    expect(settings.rows.map((row) => row.tenant_id)).toEqual([TENANT_A]);
  });

  it("round-trips schema-only template/note rows through service_role and isolates coach reads", async () => {
    await resetRole();
    const contactA = (await db.query<{ id: string }>(
      `insert into public.contacts (tenant_id,last_channel,name,is_test)
       values ($1,'sms','Synthetic A',true) returning id`, [TENANT_A],
    )).rows[0].id;
    const contactB = (await db.query<{ id: string }>(
      `insert into public.contacts (tenant_id,last_channel,name)
       values ($1,'sms','Synthetic B') returning id`, [TENANT_B],
    )).rows[0].id;

    await actAs("service_role", ADMIN, "admin");
    await db.query(
      `insert into public.admin_action_templates (tenant_id,name,body,created_by) values
       ($1,'Synthetic A','Synthetic action A',$3), ($2,'Synthetic B','Synthetic action B',$3)`,
      [TENANT_A, TENANT_B, ADMIN],
    );
    await db.query(
      `insert into public.contact_notes (tenant_id,contact_id,body,created_by) values
       ($1,$3,'Synthetic note A',$5), ($2,$4,'Synthetic note B',$5)`,
      [TENANT_A, TENANT_B, contactA, contactB, ADMIN],
    );
    const persisted = await db.query<{ templates: string; notes: string; test_notes: string }>(`
      select (select count(*)::text from public.admin_action_templates) templates,
        (select count(*)::text from public.contact_notes) notes,
        (select count(*)::text from public.contact_notes where is_test) test_notes
    `);
    expect(persisted.rows[0]).toEqual({ templates: "2", notes: "2", test_notes: "1" });

    await actAs("authenticated", COACH_A, "coach", TENANT_A);
    expect((await db.query(`select count(*)::int count from public.admin_action_templates`)).rows[0].count)
      .toBe(1);
    expect((await db.query(`select count(*)::int count from public.contact_notes`)).rows[0].count)
      .toBe(1);
    await expectDbError(
      `insert into public.admin_action_templates (tenant_id,name,body,created_by)
       values ($1,'Blocked','Blocked',$2)`, [TENANT_A, COACH_A], /permission denied/,
    );
  });

  it("enforces the exact offer vocabulary, bounds, child caps, URL rules, and platform-field allowlist", async () => {
    await actAs("service_role", COACH_A, "coach", TENANT_A);
    const call = `select public.save_offer_draft($1,$2,$3,$4,$5)`;
    await expectDbError(call, [TENANT_A, COACH_A, OFFER_A, null, {
      products: ["invented product"], contentHash: "a".repeat(64),
    }], "offer_layers_products_chk");
    await expectDbError(call, [TENANT_A, COACH_A, OFFER_A, null, {
      voiceStyleAnswer: "x".repeat(OFFER_BOUNDS.voiceAnswerMax + 1), contentHash: "a".repeat(64),
    }], "offer_layers_voice_len_chk");
    await expectDbError(call, [TENANT_A, COACH_A, OFFER_A, null, {
      prices: Array.from({ length: OFFER_BOUNDS.price.maxRows + 1 }, (_, index) => ({
        label: `P${index}`, amountCents: 100,
      })), contentHash: "a".repeat(64),
    }], "OFFER_PRICE_CAP_EXCEEDED");
    await expectDbError(call, [TENANT_A, COACH_A, OFFER_A, null, {
      proof: Array.from({ length: OFFER_BOUNDS.proof.maxRows + 1 }, (_, index) => ({
        title: `P${index}`, detail: "Synthetic proof",
      })), contentHash: "a".repeat(64),
    }], "OFFER_PROOF_CAP_EXCEEDED");
    await expectDbError(call, [TENANT_A, COACH_A, OFFER_A, null, {
      assets: Array.from({ length: OFFER_BOUNDS.asset.maxRows + 1 }, (_, index) => ({
        slug: `asset-${index}`, label: `Asset ${index}`, url: `https://phase2.test/${index}`,
      })), contentHash: "a".repeat(64),
    }], "OFFER_ASSET_CAP_EXCEEDED");
    await expectDbError(call, [TENANT_A, COACH_A, OFFER_A, null, {
      prices: [{ label: "x".repeat(OFFER_BOUNDS.price.labelMax + 1), amountCents: 100 }],
      contentHash: "a".repeat(64),
    }], /offer_prices_label_check/);
    await expectDbError(call, [TENANT_A, COACH_A, OFFER_A, null, {
      proof: [{ title: "x".repeat(OFFER_BOUNDS.proof.titleMax + 1), detail: "Synthetic" }],
      contentHash: "a".repeat(64),
    }], /offer_proof_entries_title_check/);
    await expectDbError(call, [TENANT_A, COACH_A, OFFER_A, null, {
      proof: [{ title: "Synthetic", detail: "x".repeat(OFFER_BOUNDS.proof.detailMax + 1) }],
      contentHash: "a".repeat(64),
    }], /offer_proof_entries_detail_check/);
    await expectDbError(call, [TENANT_A, COACH_A, OFFER_A, null, {
      assets: [{ slug: "bad", label: "Bad", url: "http://phase2.test/bad" }],
      contentHash: "a".repeat(64),
    }], /offer_assets_url_check|OFFER_ASSET_HOST_NOT_WHITELISTED/);
    await expectDbError(call, [TENANT_A, COACH_A, OFFER_A, null, {
      status: "published", contentHash: "a".repeat(64),
    }], "OFFER_PLATFORM_FIELD_FORBIDDEN:status");

    const valid = {
      programName: "Synthetic program",
      products: [...OFFER_PRODUCTS],
      prices: [{ label: "Synthetic price", amountCents: 100, billingPeriod: "one_time" }],
      proof: [{ title: "Synthetic proof", detail: "Synthetic detail" }],
      assets: [{ slug: "guide", label: "Guide", url: "https://phase2.test/guide" }],
      contentHash: "b".repeat(64),
    };
    expect((await db.query<{ id: string }>(`${call} as id`, [TENANT_A, COACH_A, OFFER_A, null, valid])).rows[0].id)
      .toBe(OFFER_A);
  });

  it("rolls offer publication back when either the transition or audit receipt fails", async () => {
    await resetRole();
    const baseOfferPublishAudits = (await db.query<{ count: number }>(
      `select count(*)::int count from public.audit_log where action='offer.published'`,
    )).rows[0].count;
    await db.query(`update public.offer_layers set content_hash=$2 where id=$1`,
      [OFFER_A, "a".repeat(64)]);
    await actAs("service_role", COACH_A, "coach", TENANT_A);
    await expectDbError(
      `select * from public.publish_offer_draft($1,$2,$3,$4)`,
      [TENANT_A, COACH_A, OFFER_A, "b".repeat(64)], "OFFER_DRAFT_HASH_MISMATCH",
    );
    await resetRole();
    expect((await db.query(`select status::text from public.offer_layers where id=$1`, [OFFER_A]))
      .rows[0].status).toBe("draft");
    expect((await db.query(`select count(*)::int count from public.audit_log where action='offer.published'`))
      .rows[0].count).toBe(baseOfferPublishAudits);

    // Existing demo publication receipts legitimately reference this registry row. Flip its actor
    // contract inside the test transaction to force the same audit failure without deleting
    // shared immutable evidence.
    await db.query(`update public.audit_actions set actor_kind='system' where key='offer.published'`);
    try {
      await actAs("service_role", COACH_A, "coach", TENANT_A);
      await expectDbError(
        `select * from public.publish_offer_draft($1,$2,$3,$4)`,
        [TENANT_A, COACH_A, OFFER_A, "a".repeat(64)], /audit|actor/i,
      );
    } finally {
      await resetRole();
      await db.query(`update public.audit_actions set actor_kind='human' where key='offer.published'`);
    }
    expect((await db.query(`select status::text from public.offer_layers where id=$1`, [OFFER_A]))
      .rows[0].status).toBe("draft");
    expect((await db.query(`select count(*)::int count from public.audit_log where action='offer.published'`))
      .rows[0].count).toBe(baseOfferPublishAudits);
  });

  it("enforces one draft/one published offer and immutable published history", async () => {
    await resetRole();
    await expectDbError(
      `insert into public.offer_layers (id,tenant_id,status,version,products)
       values (gen_random_uuid(),$1,'draft',2,'{}')`,
      [TENANT_A], "offer_layers_one_draft_uidx",
    );
    await db.query(
      `insert into public.offer_layers (id,tenant_id,status,version,products,content_hash)
       values (gen_random_uuid(),$1,'published',2,'{}',$2)`,
      [TENANT_A, "a".repeat(64)],
    );
    await expectDbError(
      `insert into public.offer_layers (id,tenant_id,status,version,products,content_hash)
       values (gen_random_uuid(),$1,'published',3,'{}',$2)`,
      [TENANT_A, "b".repeat(64)], "offer_layers_one_published_uidx",
    );
    await expectDbError(
      `update public.offer_layers set program_name='Changed' where tenant_id=$1 and status='published'`,
      [TENANT_A], "OFFER_HISTORY_IMMUTABLE",
    );
  });

  it("makes eval history select-only and atomically records checker and engine shapes", async () => {
    const draft = await insertDraft({ compiledPlatform: "Synthetic", platformTokens: 1 });
    await actAs("authenticated", ADMIN, "admin");
    await expectDbError(
      `insert into public.eval_runs
       (brain_draft_version_id,content_hash,rules_version,source,kind,corpus_revision)
       values ($1,$2,'x','repo_corpus','checker','x')`,
      [draft.id, draft.hash], /permission denied/,
    );
    await resetRole();
    const checker = await recordEval(draft, "checker");
    const engine = await recordEval(draft, "engine");
    const rows = await db.query<{ id: string; kind: string; model_config_id: string | null; results: string }>(`
      select r.id, r.kind, r.model_config_id, count(c.id)::text results
      from public.eval_runs r join public.eval_case_results c on c.run_id=r.id
      where r.id=any($1::uuid[]) group by r.id order by r.kind
    `, [[checker, engine]]);
    expect(rows.rows).toEqual([
      { id: checker, kind: "checker", model_config_id: null, results: "6" },
      { id: engine, kind: "engine", model_config_id: MODEL, results: "6" },
    ]);

    const before = await db.query<{ runs: string; results: string }>(`
      select (select count(*)::text from public.eval_runs) runs,
        (select count(*)::text from public.eval_case_results) results
    `);
    await actAs("service_role", ADMIN, "admin");
    await expectDbError(
      `select public.record_eval_run($1,$2,'checker',null,'synthetic-v1',$3)`,
      [draft.id, `${draft.hash.slice(0, -1)}0`, JSON.stringify(suiteResults())], "EVAL_DRAFT_HASH_MISMATCH",
    );
    await resetRole();
    const after = await db.query<{ runs: string; results: string }>(`
      select (select count(*)::text from public.eval_runs) runs,
        (select count(*)::text from public.eval_case_results) results
    `);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});

describe("Brain transitions, import, retrieval, and export evidence", () => {
  it("refuses unresolved imports and invalid dispositions before any entry or audit mutation", async () => {
    await resetRole();
    const batch = (await db.query<{ id: string }>(`
      insert into public.brain_import_batches
        (source,collection_ref,source_hash,received_count,normalized_count,flagged_count,unchanged_count,created_by)
      values ('mock','synthetic','${"a".repeat(64)}',1,1,1,0,$1) returning id
    `, [ADMIN])).rows[0].id;
    const item = (await db.query<{ id: string }>(`
      insert into public.brain_import_items (batch_id,source_ref,operation,after_payload,flags)
      values ($1,'synthetic-row','new',$2,$3) returning id
    `, [batch, {
      inboundMessage: "Synthetic inbound", responseTemplate: "Synthetic response", category: "general",
    }, JSON.stringify([{ code: "unbound_figure", severity: "blocking", resolved: false }])])).rows[0].id;
    const before = await db.query<{ entries: string; audits: string }>(`
      select (select count(*)::text from public.brain_knowledge_entries) entries,
        (select count(*)::text from public.audit_log where action='brain.import.accepted') audits
    `);
    await actAs("service_role", ADMIN, "admin");
    const call = `select * from public.accept_brain_import_item($1,$2,$3,$4,$5,$6::vector,$7)`;
    await expectDbError(call, [batch, "synthetic-row", item, "shared", "[]", vector(1), ADMIN],
      "BRAIN_IMPORT_BLOCKING_FLAGS_UNRESOLVED");
    await expectDbError(call, [batch, "synthetic-row", item, "invented", "[]", vector(1), ADMIN],
      "BRAIN_IMPORT_DISPOSITION_INVALID");
    await resetRole();
    const after = await db.query<{ entries: string; audits: string }>(`
      select (select count(*)::text from public.brain_knowledge_entries) entries,
        (select count(*)::text from public.audit_log where action='brain.import.accepted') audits
    `);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("binds publish to an exact passing eval and rolls back domain state when audit custody fails", async () => {
    const baseSnapshotCount = (await db.query<{ count: number }>(
      `select count(*)::int count from public.brain_snapshots`,
    )).rows[0].count;
    const passingDraft = await insertDraft({ compiledPlatform: "Passing", platformTokens: 1 });
    const passingEval = await recordEval(passingDraft);
    const failingDraft = await insertDraft({ compiledPlatform: "Failing", platformTokens: 1 });
    const failingEval = await recordEval(failingDraft, "checker", "output_integrity");

    await actAs("service_role", ADMIN, "admin");
    await expectDbError(
      `select * from public.publish_brain_draft($1,$2,$3,$4,'Synthetic reason')`,
      [ADMIN, failingDraft.id, failingDraft.hash, failingEval], "BRAIN_SAFETY_EVAL_FAILED",
    );
    await expectDbError(
      `select * from public.publish_brain_draft($1,$2,$3,$4,'Synthetic reason')`,
      [ADMIN, passingDraft.id, `${passingDraft.hash.slice(0, -1)}0`, passingEval], "BRAIN_DRAFT_HASH_MISMATCH",
    );
    await resetRole();
    expect((await db.query(`select count(*)::int count from public.brain_snapshots`)).rows[0].count)
      .toBe(baseSnapshotCount);

    await db.query(`update public.audit_actions set actor_kind='system' where key='brain.published'`);
    await actAs("service_role", ADMIN, "admin");
    await expectDbError(
      `select * from public.publish_brain_draft($1,$2,$3,$4,'Synthetic reason')`,
      [ADMIN, passingDraft.id, passingDraft.hash, passingEval], /audit|AUDIT/i,
    );
    await resetRole();
    await db.query(`update public.audit_actions set actor_kind='human' where key='brain.published'`);
    expect((await db.query(`select count(*)::int count from public.brain_snapshots`)).rows[0].count)
      .toBe(baseSnapshotCount);
  });

  it("keeps drafts/snapshots append-only and implements rollback as version N+1", async () => {
    const baseVersion = (await db.query<{ version: number }>(
      `select coalesce(max(version),0)::int version from public.brain_snapshots`,
    )).rows[0].version;
    const first = await insertDraft({ compiledPlatform: "First", platformTokens: 1 });
    const firstSnapshot = await publishDraft(first, await recordEval(first), "First synthetic publish");
    const second = await insertDraft({ compiledPlatform: "Second", platformTokens: 2 });
    const secondSnapshot = await publishDraft(second, await recordEval(second), "Second synthetic publish");
    expect([firstSnapshot.brain_version, secondSnapshot.brain_version])
      .toEqual([baseVersion + 1, baseVersion + 2]);

    await actAs("service_role", ADMIN, "admin");
    const rollback = (await db.query<{ snapshot_id: string; brain_version: number; audit_id: string }>(
      `select * from public.rollback_brain_snapshot($1,$2,$3,'Synthetic rollback')`,
      [ADMIN, secondSnapshot.brain_version, firstSnapshot.brain_version],
    )).rows[0];
    await resetRole();
    expect(rollback.brain_version).toBe(baseVersion + 3);
    const persisted = await db.query<{ version: number; rollback_of_snapshot_id: string; content_hash: string }>(
      `select version,rollback_of_snapshot_id,content_hash from public.brain_snapshots where id=$1`,
      [rollback.snapshot_id],
    );
    expect(persisted.rows[0]).toEqual({
      version: baseVersion + 3,
      rollback_of_snapshot_id: firstSnapshot.snapshot_id,
      content_hash: first.hash,
    });
    await expectDbError(`update public.brain_snapshots set reason='Changed' where id=$1`,
      [rollback.snapshot_id], "PHASE2_IMMUTABLE_HISTORY");
    await expectDbError(`delete from public.brain_draft_versions where id=$1`,
      [first.id], "PHASE2_IMMUTABLE_HISTORY");
  });

  it("scores exact normalized category by 0.05, preserves recall/ties, excludes drafts, and ignores scan plans", async () => {
    const draft = await insertDraft({ compiledPlatform: "Retrieval", platformTokens: 1 });
    const snapshot = await publishDraft(draft, await recordEval(draft), "Retrieval synthetic publish");
    await resetRole();
    const entries = [
      ["34000000-0000-4000-8000-000000000010", " Credit ", vector(1), "Exact category"],
      ["34000000-0000-4000-8000-000000000020", "misfiled", vector(0.999, 0.045), "Misfiled"],
      ["34000000-0000-4000-8000-000000000030", "other", vector(0, 1), "Tie A"],
      ["34000000-0000-4000-8000-000000000040", "other", vector(0, 1), "Tie B"],
    ] as const;
    for (const [id, category, embedding, response] of entries) {
      await db.query(
        `insert into public.brain_snapshot_entries
          (snapshot_id,entry_id,category,inbound_message,response_template,embedding,disposition)
         values ($1,$2,$3,'Synthetic inbound',$4,$5::vector,'shared')`,
        [snapshot.snapshot_id, id, category, response, embedding],
      );
    }
    await expectDbError(
      `update public.brain_snapshot_entries set response_template='Changed'
       where snapshot_id=$1 and entry_id=$2`,
      [snapshot.snapshot_id, entries[0][0]], "PHASE2_IMMUTABLE_HISTORY",
    );
    await expectDbError(
      `delete from public.brain_snapshot_entries where snapshot_id=$1 and entry_id=$2`,
      [snapshot.snapshot_id, entries[0][0]], "PHASE2_IMMUTABLE_HISTORY",
    );
    await db.query(
      `insert into public.brain_knowledge_entries
        (question,answer,category,status,source,source_ref,disposition,response_template,embedding)
       values ('Draft perfect','Draft perfect','credit','draft','mock','draft-perfect','shared','Draft perfect',$1::vector)`,
      [vector(1)],
    );

    await actAs("service_role", ADMIN, "admin");
    const query = `select entry_id,similarity,category_boost,score
      from public.match_published_brain_entries($1,$2::vector,' credit ',10)`;
    const ordinary = await db.query(query, [snapshot.snapshot_id, vector(1)]);
    expect(ordinary.rows[0]).toMatchObject({
      entry_id: entries[0][0], similarity: 1, category_boost: 0.05, score: 1.05,
    });
    expect(ordinary.rows.map((row) => row.entry_id)).toContain(entries[1][0]);
    expect(ordinary.rows.find((row) => row.entry_id === entries[1][0]).category_boost).toBe(0);
    expect(ordinary.rows.slice(-2).map((row) => row.entry_id)).toEqual([entries[2][0], entries[3][0]]);
    expect(ordinary.rows).toHaveLength(4);

    await db.query("set local enable_indexscan=off");
    await db.query("set local enable_bitmapscan=off");
    const forcedSequential = await db.query(query, [snapshot.snapshot_id, vector(1)]);
    expect(forcedSequential.rows.map((row) => row.entry_id))
      .toEqual(ordinary.rows.map((row) => row.entry_id));
  });

  it("enforces platform-export actor, reason, id, and single-finish state", async () => {
    await actAs("service_role", COACH_A, "coach", TENANT_A);
    await expectDbError(
      `select public.start_platform_export($1,'brain', '{}',array['id'],'Synthetic reason')`,
      [COACH_A], "PHASE2_PLATFORM_ACTOR_FORBIDDEN",
    );
    await actAs("service_role", ADMIN, "admin");
    await expectDbError(
      `select public.start_platform_export($1,'brain','{}',array['id'],'')`,
      [ADMIN], "PLATFORM_EXPORT_REASON_REQUIRED",
    );
    const start = (await db.query<{ id: string }>(
      `select public.start_platform_export($1,'brain','{}',array['id'],'Synthetic export') as id`,
      [ADMIN],
    )).rows[0].id;
    const finish = (await db.query<{ id: string }>(
      `select public.finish_platform_export($1,$2,2,128,'Synthetic completion') as id`,
      [ADMIN, start],
    )).rows[0].id;
    expect(Number(finish)).toBeGreaterThan(Number(start));
    await expectDbError(
      `select public.finish_platform_export($1,$2,2,128,'Again')`,
      [ADMIN, start], "PLATFORM_EXPORT_ALREADY_FINISHED",
    );
    await expectDbError(
      `select public.finish_platform_export($1,999999,0,0,'Missing')`,
      [ADMIN], "PLATFORM_EXPORT_START_NOT_FOUND",
    );

    // Phase 8: named-tenant exports bind both audit records to the same tenant target.
    const tenantStart = (await db.query<{ id: string }>(
      `select public.start_platform_export($1,'support-threads','{}',array['id'],'Synthetic tenant export',$2) as id`,
      [ADMIN, TENANT_A],
    )).rows[0].id;
    await expectDbError(
      `select public.finish_platform_export($1,$2,1,64,'Wrong tenant',$3)`,
      [ADMIN, tenantStart, TENANT_B], "PLATFORM_EXPORT_START_NOT_FOUND",
    );
    await db.query(
      `select public.finish_platform_export($1,$2,1,64,'Synthetic tenant completion',$3)`,
      [ADMIN, tenantStart, TENANT_A],
    );
    const tenantAudit = await db.query<{ action: string; target_id: string }>(`
      select action, target_id from public.audit_log
      where target_type = 'platform_export_tenant' and target_id = $1::text
      order by id
    `, [TENANT_A]);
    expect(tenantAudit.rows).toEqual([
      { action: "platform_export.started", target_id: TENANT_A },
      { action: "platform_export.finished", target_id: TENANT_A },
    ]);
  });
});

// Phase 10: the objection snapshot boundary. Every payload here is built through
// brainObjectionDraftEntity so the TypeScript key names and the SQL that reads them are bound by
// a failing test rather than by a convention nobody re-checks — the failure mode STATE.md records
// for 07-10 and 07-11, where a definition file and its SQL were each green in isolation.
describe("Phase 10 objection snapshot boundary", () => {
  const OBJECTION_ONE = "81000000-0000-4000-8000-000000000101";
  const OBJECTION_TWO = "81000000-0000-4000-8000-000000000102";
  const OBJECTION_THREE = "81000000-0000-4000-8000-000000000103";

  function pricingObjection() {
    return brainObjectionDraftEntity({
      id: OBJECTION_ONE,
      label: "Too expensive",
      pattern: "expensive|too much",
      matchKeywords: ["Price", "cost", "  BUDGET "],
      response: "Here is exactly what the program costs and what it includes.",
      category: "pricing",
      hardGate: true,
    });
  }

  function timingObjection() {
    return brainObjectionDraftEntity({
      id: OBJECTION_TWO,
      label: "Not right now",
      matchKeywords: ["later", "busy"],
      response: "We can hold a slot and start whenever you are ready.",
      category: "timing",
    });
  }

  function payload(entities: readonly unknown[], compiledPlatform: string) {
    return { entities, compiledPlatform, platformTokens: entities.length, knowledgeMode: "inline" };
  }

  async function objectionRows(snapshotId: string) {
    return (await db.query(`
      select objection_id, label, pattern, match_keywords, response, category, hard_gate
      from public.brain_snapshot_objections where snapshot_id = $1 order by objection_id
    `, [snapshotId])).rows;
  }

  it("copies the drafted objections into the published snapshot field for field", async () => {
    const draft = await insertDraft(
      payload([pricingObjection(), timingObjection()], "Objection publish"),
    );
    const snapshot = await publishDraft(draft, await recordEval(draft), "Objection synthetic publish");

    expect(await objectionRows(snapshot.snapshot_id)).toEqual([
      {
        objection_id: OBJECTION_ONE,
        label: "Too expensive",
        pattern: "expensive|too much",
        // The builder's normalized, sorted form — the exact array the content hash covered.
        match_keywords: ["budget", "cost", "price"],
        response: "Here is exactly what the program costs and what it includes.",
        category: "pricing",
        hard_gate: true,
      },
      {
        objection_id: OBJECTION_TWO,
        label: "Not right now",
        pattern: null,
        match_keywords: ["busy", "later"],
        response: "We can hold a slot and start whenever you are ready.",
        category: "timing",
        hard_gate: false,
      },
    ]);
  });

  it("publishes a payload carrying no entities key at all without error or objection rows", async () => {
    // Every pre-existing publish test in this file passes a payload with no `entities`. If the
    // new insert dereferenced that key unguarded, all of them would start failing.
    const draft = await insertDraft({ compiledPlatform: "No entities", platformTokens: 1 });
    const snapshot = await publishDraft(draft, await recordEval(draft), "Entity-free synthetic publish");
    expect(await objectionRows(snapshot.snapshot_id)).toEqual([]);
  });

  it("publishes the evaluated draft value even after the live objection is tampered with", async () => {
    const draft = await insertDraft(payload([pricingObjection()], "Objection tamper"));
    const evalRunId = await recordEval(draft);

    await resetRole();
    await db.query(`
      insert into public.brain_objections (id, label, response, category, hard_gate, status)
      values ($1, 'Tampered label', 'Tampered response', 'clarity', false, 'draft')
      on conflict (id) do update set
        label = excluded.label, response = excluded.response,
        category = excluded.category, hard_gate = excluded.hard_gate
    `, [OBJECTION_ONE]);

    const snapshot = await publishDraft(draft, evalRunId, "Tampered synthetic publish");
    const rows = await objectionRows(snapshot.snapshot_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      objection_id: OBJECTION_ONE,
      label: "Too expensive",
      response: "Here is exactly what the program costs and what it includes.",
      category: "pricing",
      hard_gate: true,
    });
    const persisted = await db.query<{ content_hash: string }>(
      `select content_hash from public.brain_snapshots where id = $1`, [snapshot.snapshot_id],
    );
    expect(persisted.rows[0].content_hash).toBe(draft.hash);
  });

  it("refuses to publish when shared knowledge changes after the evaluated draft was created", async () => {
    await resetRole();
    const entry = (await db.query<{ id: string }>(`
      insert into public.brain_knowledge_entries
        (question, answer, category, status, source, source_ref, disposition,
         response_template, embedding)
      values ('Bound question', 'Bound answer', 'general', 'draft', 'mock',
        'knowledge-binding', 'shared', 'Bound answer', $1::vector)
      returning id
    `, [vector(1)])).rows[0];
    const draft = await insertDraft({ compiledPlatform: "Knowledge binding", platformTokens: 1 });
    const evalRun = await recordEval(draft);

    await resetRole();
    await db.query(
      `update public.brain_knowledge_entries set question='Changed question' where id=$1`,
      [entry.id],
    );
    await actAs("service_role", ADMIN, "admin");
    await expectDbError(
      `select * from public.publish_brain_draft($1,$2,$3,$4,'Knowledge changed')`,
      [ADMIN, draft.id, draft.hash, evalRun], "BRAIN_KNOWLEDGE_CHANGED_SINCE_DRAFT",
    );
  });

  it("refuses every update and delete against snapshot objections, database owner included", async () => {
    const draft = await insertDraft(payload([pricingObjection()], "Objection immutability"));
    const snapshot = await publishDraft(draft, await recordEval(draft), "Immutability synthetic publish");

    await resetRole();
    await expectDbError(
      `update public.brain_snapshot_objections set response = 'Rewritten' where snapshot_id = $1`,
      [snapshot.snapshot_id], "PHASE2_IMMUTABLE_HISTORY",
    );
    await expectDbError(
      `delete from public.brain_snapshot_objections where snapshot_id = $1`,
      [snapshot.snapshot_id], "PHASE2_IMMUTABLE_HISTORY",
    );
  });

  it("rolls objections forward into an appended snapshot and leaves the prior two untouched", async () => {
    const setA = await insertDraft(payload([pricingObjection(), timingObjection()], "Rollback A"));
    const snapshotA = await publishDraft(setA, await recordEval(setA), "Rollback A publish");
    const setB = await insertDraft(payload([
      brainObjectionDraftEntity({
        id: OBJECTION_THREE, label: "Partner referral", matchKeywords: ["partner"],
        response: "We can introduce you to a partner who handles that.",
        category: "partner", hardGate: false,
      }),
    ], "Rollback B"));
    const snapshotB = await publishDraft(setB, await recordEval(setB), "Rollback B publish");

    const beforeA = await objectionRows(snapshotA.snapshot_id);
    const beforeB = await objectionRows(snapshotB.snapshot_id);

    await actAs("service_role", ADMIN, "admin");
    const rollback = (await db.query<{ snapshot_id: string; brain_version: number }>(
      `select * from public.rollback_brain_snapshot($1,$2,$3,'Objection rollback')`,
      [ADMIN, snapshotB.brain_version, snapshotA.brain_version],
    )).rows[0];
    await resetRole();

    expect(rollback.brain_version).toBe(snapshotB.brain_version + 1);
    expect(await objectionRows(rollback.snapshot_id)).toEqual(beforeA);
    expect(await objectionRows(snapshotA.snapshot_id)).toEqual(beforeA);
    expect(await objectionRows(snapshotB.snapshot_id)).toEqual(beforeB);
    const maxVersion = (await db.query<{ version: number }>(
      `select max(version)::int version from public.brain_snapshots`,
    )).rows[0].version;
    expect(maxVersion).toBe(rollback.brain_version);
  });

  it("keeps both new tables forced, policy-covered, and unwritable by authenticated callers", async () => {
    const forced = await db.query<{
      relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean;
    }>(`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname='public' and c.relname = any($1::text[]) order by c.relname
    `, [["brain_objection_usage_events", "brain_snapshot_objections"]]);
    expect(forced.rows).toEqual([
      { relname: "brain_objection_usage_events", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "brain_snapshot_objections", relrowsecurity: true, relforcerowsecurity: true },
    ]);

    const writes = await db.query<{ count: string }>(`
      select count(*)::text from information_schema.role_table_grants
      where table_schema='public' and grantee='authenticated'
        and table_name = any($1::text[])
        and privilege_type in ('INSERT','UPDATE','DELETE')
    `, [["brain_objection_usage_events", "brain_snapshot_objections"]]);
    expect(writes.rows[0].count).toBe("0");
  });

  it("adds exactly one branch to the deployed inherit_is_test body and drops none", async () => {
    // Read the deployed definition, not migration text: several migrations `create or replace`
    // this function, so only the catalog knows which body is live.
    const definition = (await db.query<{ def: string }>(
      `select pg_get_functiondef('app.inherit_is_test()'::regprocedure) as def`,
    )).rows[0].def;
    const branches = [...definition.matchAll(/when '([a-z_]+)' then/g)].map((match) => match[1]);
    expect([...branches].sort()).toEqual([
      "appointment_reschedules",
      "appointments",
      "billable_events",
      "brain_knowledge_usage_events",
      "brain_objection_usage_events",
      "contact_notes",
      "contacts",
      "conversation_step_events",
      "conversations",
      "followups",
      "messages",
      "support_messages",
      "support_threads",
      "unmatched_objections",
    ]);
    expect(new Set(branches).size).toBe(branches.length);
  });

  it("earns is_test through real lineage and excludes only what the lineage marks", async () => {
    // TENANT_B is the real cohort because TENANT_A is is_demo, which would mark every descendant
    // test for the wrong reason and let this assertion pass while proving nothing.
    const realContact = "35000000-0000-4000-8000-000000000110";
    const realConversation = "35000000-0000-4000-8000-000000000111";
    const realMessage = "35000000-0000-4000-8000-000000000112";
    const extraMessage = "35000000-0000-4000-8000-000000000113";
    const testSession = "36000000-0000-4000-8000-000000000110";
    const testContact = "35000000-0000-4000-8000-000000000120";
    const testConversation = "35000000-0000-4000-8000-000000000121";
    const testMessage = "35000000-0000-4000-8000-000000000122";
    const demoConversation = "35000000-0000-4000-8000-000000000131";
    const demoMessage = "35000000-0000-4000-8000-000000000132";

    const draft = await insertDraft(payload([pricingObjection()], "Objection segregation"));
    const snapshot = await publishDraft(draft, await recordEval(draft), "Segregation synthetic publish");

    await resetRole();
    // Real cohort: no test_session_id, and TENANT_B is not a demo tenant.
    await db.query(
      `insert into public.contacts (id, tenant_id, last_channel, name)
       values ($1, '${TENANT_B}', 'sms', 'Real lead')`, [realContact]);
    await db.query(
      `insert into public.conversations (id, tenant_id, contact_id, channel)
       values ($1, '${TENANT_B}', $2, 'sms')`, [realConversation, realContact]);
    await db.query(
      `insert into public.messages (id, tenant_id, conversation_id, direction, author, body)
       values ($1, '${TENANT_B}', $3, 'out', 'agent', 'Real agent reply'),
              ($2, '${TENANT_B}', $3, 'out', 'agent', 'Second real agent reply')`,
      [realMessage, extraMessage, realConversation]);

    // Test cohort: a real test_agent_sessions row is what earns the flag.
    await db.query(
      `insert into public.test_agent_sessions (id, tenant_id, started_by)
       values ($1, '${TENANT_B}', '${COACH_B}')`, [testSession]);
    await db.query(
      `insert into public.contacts (id, tenant_id, last_channel, name, test_session_id)
       values ($1, '${TENANT_B}', 'sms', 'Test lead', $2)`, [testContact, testSession]);
    await db.query(
      `insert into public.conversations (id, tenant_id, contact_id, channel)
       values ($1, '${TENANT_B}', $2, 'sms')`, [testConversation, testContact]);
    await db.query(
      `insert into public.messages (id, tenant_id, conversation_id, direction, author, body)
       values ($1, '${TENANT_B}', $2, 'out', 'agent', 'Test agent reply')`,
      [testMessage, testConversation]);

    // Demo cohort rides the shared TENANT_A contact, which belongs to a demo tenant.
    await db.query(
      `insert into public.conversations (id, tenant_id, contact_id, channel)
       values ($1, '${TENANT_A}', '${CONTACT}', 'sms')`, [demoConversation]);
    await db.query(
      `insert into public.messages (id, tenant_id, conversation_id, direction, author, body)
       values ($1, '${TENANT_A}', $2, 'out', 'agent', 'Demo agent reply')`,
      [demoMessage, demoConversation]);

    // Every event omits is_test entirely; the trigger is the only thing that may set it.
    const events = (await db.query<{ id: string; is_test: boolean }>(`
      insert into public.brain_objection_usage_events
        (tenant_id, conversation_id, agent_message_id, snapshot_id, objection_id,
         handling_outcome, hard_gate)
      values
        ('${TENANT_B}', $1, $2, $7, $8, 'held_safely', true),
        ('${TENANT_B}', $3, $4, $7, $8, 'held_safely', true),
        ('${TENANT_A}', $5, $6, $7, $8, 'held_safely', true)
      returning id, is_test
    `, [realConversation, realMessage, testConversation, testMessage,
      demoConversation, demoMessage, snapshot.snapshot_id, OBJECTION_ONE])).rows;

    // Assert the flags were inherited before asserting anything about exclusion.
    const lineage = await db.query<{ label: string; is_test: boolean }>(`
      select 'real_contact' label, is_test from public.contacts where id = $1
      union all select 'real_conversation', is_test from public.conversations where id = $2
      union all select 'real_message', is_test from public.messages where id = $3
      union all select 'test_contact', is_test from public.contacts where id = $4
      union all select 'test_conversation', is_test from public.conversations where id = $5
      union all select 'test_message', is_test from public.messages where id = $6
      order by label
    `, [realContact, realConversation, realMessage, testContact, testConversation, testMessage]);
    expect(lineage.rows).toEqual([
      { label: "real_contact", is_test: false },
      { label: "real_conversation", is_test: false },
      { label: "real_message", is_test: false },
      { label: "test_contact", is_test: true },
      { label: "test_conversation", is_test: true },
      { label: "test_message", is_test: true },
    ]);
    // The demo event is true because a demo tenant's contact inherits the flag at the root of
    // the lineage, so every descendant carries it — the view's is_demo clause is not what
    // excludes it. That clause is proven separately below.
    expect(events.map((row) => row.is_test)).toEqual([false, true, true]);

    const visible = await db.query<{ event_id: string }>(`
      select event_id from public.analytics_brain_objection_usage_events
      where event_id = any($1::uuid[])
    `, [events.map((row) => row.id)]);
    expect(visible.rows.map((row) => row.event_id)).toEqual([events[0].id]);

    // The only assertion that proves the trigger overwrites rather than accepts a supplied value.
    const supplied = await db.query<{ is_test: boolean }>(`
      insert into public.brain_objection_usage_events
        (tenant_id, conversation_id, agent_message_id, snapshot_id, objection_id,
         handling_outcome, hard_gate, is_test)
      values ('${TENANT_B}', $1, $2, $3, $4, 'held_safely', true, true)
      returning is_test
    `, [realConversation, extraMessage, snapshot.snapshot_id, OBJECTION_ONE]);
    expect(supplied.rows[0].is_test).toBe(false);

    // And the is_demo clause carries its own weight: flipping a tenant to demo after its rows
    // exist hides them, even though every one of them still has is_test = false.
    await db.query(`update public.tenants set is_demo = true where id = '${TENANT_B}'`);
    const afterFlip = await db.query<{ count: string }>(`
      select count(*)::text from public.analytics_brain_objection_usage_events
      where tenant_id = '${TENANT_B}'
    `);
    expect(afterFlip.rows[0].count).toBe("0");
    const stillReal = await db.query<{ is_test: boolean }>(
      `select is_test from public.brain_objection_usage_events where id = $1`, [events[0].id]);
    expect(stillReal.rows[0].is_test).toBe(false);
  });
});
