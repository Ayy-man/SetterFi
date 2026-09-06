// Migration 20261013000014: number provenance on knowledge entries and their snapshot copies, and
// question variants in ranking. Live-Postgres-only: trigger custody, immutability, forced RLS and
// vector ordering are database behaviours a mock would only restate.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

const DB_URL =
  process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const ADMIN = "4b000000-0000-4000-8000-000000000010";
const ENTRY_BOUND = "44000000-0000-4000-8000-000000000010";
const ENTRY_PLAIN = "44000000-0000-4000-8000-000000000020";
const BATCH = "45000000-0000-4000-8000-000000000010";
const ITEM = "45000000-0000-4000-8000-000000000020";

const SUITES = [
  "compliance_guardrails", "pricing_discipline", "jailbreak_injection",
  "output_integrity", "qualification_accuracy", "voice_tone",
] as const;

const BOUND_TEMPLATE = "The readiness review is $297 and funding starts near {{target_funding_amount}}.";
const BINDINGS = [
  { kind: "currency", value: 297, field: "responseTemplate", offset: 24, binding: "offer_prices" },
];

let db: Client;

function vector(x: number, y = 0) {
  return `[${[x, y, ...Array<number>(1534).fill(0)].join(",")}]`;
}

async function actAs(pgRole: "authenticated" | "service_role", actorId: string, role: "admin" | "coach") {
  await db.query(`set local role ${pgRole}`);
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({
    sub: actorId, app_metadata: { role },
  })]);
}

async function resetRole() {
  await db.query("reset role");
  await db.query(`select set_config('request.jwt.claims', '{}', true)`);
}

async function expectDbError(sql: string, params: readonly unknown[], expected: string) {
  await db.query("savepoint expected_failure");
  let error: unknown;
  try {
    await db.query(sql, params as unknown[]);
  } catch (cause) {
    error = cause;
  }
  await db.query("rollback to savepoint expected_failure");
  expect(String(error)).toContain(expected);
}

async function insertEntry(id: string, template: string, embedding: string, extra: Record<string, unknown> = {}) {
  await db.query(
    `insert into public.brain_knowledge_entries
       (id, question, answer, category, status, source, source_ref, disposition, response_template,
        embedding, number_bindings, rewrite_hash)
     values ($1, $2, $3, 'Funding Qs', 'draft', 'mock', $4, 'shared', $3, $5::vector,
       coalesce($6::jsonb, '[]'::jsonb), $7)`,
    [id, `Question for ${id}`, template, `mock:${id}`, embedding,
      extra.bindings === undefined ? null : JSON.stringify(extra.bindings), extra.rewriteHash ?? null],
  );
}

async function publish(reason: string) {
  const payload = { entities: [], compiledPlatform: reason, platformTokens: 1, knowledgeMode: "inline" };
  await resetRole();
  const hash = (await db.query<{ hash: string }>(
    `select app.phase2_json_hash($1::jsonb) as hash`, [payload],
  )).rows[0].hash;
  const draftId = (await db.query<{ id: string }>(
    `insert into public.brain_draft_versions (content_hash, payload, created_by)
     values ($1, $2, $3) returning id`,
    [hash, payload, ADMIN],
  )).rows[0].id;
  await actAs("service_role", ADMIN, "admin");
  const evalRunId = (await db.query<{ id: string }>(
    `select public.record_eval_run($1, $2, $3, $4, $5, $6) as id`,
    [draftId, hash, "checker", null, "synthetic-v1", JSON.stringify(SUITES.map((suite) => ({
      suite, cases: [{ caseKey: `${suite}-synthetic`, passed: true, trace: {} }],
    })))],
  )).rows[0].id;
  const row = (await db.query<{ snapshot_id: string; brain_version: number }>(
    `select * from public.publish_brain_draft($1, $2, $3, $4, $5)`,
    [ADMIN, draftId, hash, evalRunId, reason],
  )).rows[0];
  await resetRole();
  return row;
}

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(`Provenance suite could not reach Postgres at ${DB_URL}.`, { cause });
  }
});

afterAll(async () => {
  await db?.end();
});

beforeEach(async () => {
  await db.query("begin");
  await db.query(`
    insert into public.users (id, email, role, tenant_id)
      values ('${ADMIN}', 'admin@provenance.test', 'admin', null);
  `);
});

afterEach(async () => {
  await db.query("rollback");
});

describe("number bindings on knowledge entries", () => {
  it("hashes the reviewed template identically to the TypeScript side and constrains the columns", async () => {
    const { hash } = (await db.query<{ hash: string }>(
      `select app.brain_rewrite_hash($1) as hash`, [BOUND_TEMPLATE],
    )).rows[0];
    // sha256 of the UTF-8 template; `rewriteHash` in src/lib/brain/provenance.ts produces this value.
    const { expected } = (await db.query<{ expected: string }>(
      `select encode(extensions.digest(convert_to($1, 'UTF8'), 'sha256'), 'hex') as expected`, [BOUND_TEMPLATE],
    )).rows[0];
    expect(hash).toBe(expected);
    await expectDbError(
      `insert into public.brain_knowledge_entries
         (question, answer, category, status, source, disposition, response_template, number_bindings)
       values ('q', 'a', 'c', 'draft', 'mock', 'needs_rewrite', 'a', '{"not":"array"}'::jsonb)`,
      [], "brain_knowledge_entries_number_bindings_chk",
    );
    await expectDbError(
      `insert into public.brain_knowledge_entries
         (question, answer, category, status, source, disposition, response_template, rewrite_hash)
       values ('q', 'a', 'c', 'draft', 'mock', 'needs_rewrite', 'a', 'not-a-hash')`,
      [], "brain_knowledge_entries_rewrite_hash_chk",
    );
  });

  it("copies accepted import bindings onto the knowledge entry without touching the accept RPC", async () => {
    await db.query(
      `insert into public.brain_import_batches
         (id, source, collection_ref, source_hash, received_count, normalized_count, flagged_count,
          unchanged_count, created_by)
       values ($1, 'mock', 'collection', $2, 1, 1, 0, 0, $3)`,
      [BATCH, "e".repeat(64), ADMIN],
    );
    await db.query(
      `insert into public.brain_import_items (id, batch_id, source_ref, operation, after_payload)
       values ($1, $2, 'mock:item', 'new', $3::jsonb)`,
      [ITEM, BATCH, JSON.stringify({
        inboundMessage: "How much is it?", responseTemplate: BOUND_TEMPLATE, category: "Funding Qs",
      })],
    );
    await db.query(
      `insert into public.brain_knowledge_entries
         (id, question, answer, category, status, source, source_ref, disposition, response_template,
          embedding, import_item_id)
       values ($1, 'How much is it?', $2, 'Funding Qs', 'draft', 'mock', 'mock:item', 'shared', $2,
         $3::vector, $4)`,
      [ENTRY_BOUND, BOUND_TEMPLATE, vector(1), ITEM],
    );
    // The acceptance write the RPC performs, replayed directly: decision flips and bindings land.
    await db.query(
      `update public.brain_import_items
       set disposition = 'shared', number_bindings = $2::jsonb, decision = 'accepted',
           decided_by = $3, decided_at = now()
       where id = $1`,
      [ITEM, JSON.stringify(BINDINGS), ADMIN],
    );
    const entry = (await db.query<{ number_bindings: unknown; rewrite_hash: string }>(
      `select number_bindings, rewrite_hash from public.brain_knowledge_entries where id = $1`, [ENTRY_BOUND],
    )).rows[0];
    const { hash } = (await db.query<{ hash: string }>(
      `select app.brain_rewrite_hash($1) as hash`, [BOUND_TEMPLATE],
    )).rows[0];
    expect(entry.number_bindings).toEqual(BINDINGS);
    expect(entry.rewrite_hash).toBe(hash);
  });
});

describe("publish and rollback carry provenance and variants", () => {
  it("copies bindings, rewrite hash and variants into the immutable snapshot and back out on rollback", async () => {
    const { hash } = (await db.query<{ hash: string }>(
      `select app.brain_rewrite_hash($1) as hash`, [BOUND_TEMPLATE],
    )).rows[0];
    await insertEntry(ENTRY_BOUND, BOUND_TEMPLATE, vector(1), { bindings: BINDINGS, rewriteHash: hash });
    await insertEntry(ENTRY_PLAIN, "Plain answer with no figures.", vector(0, 1));
    await db.query(
      `insert into public.brain_knowledge_entry_variants (entry_id, variant, embedding, created_by)
       values ($1, 'what is the price', $2::vector, $3), ($1, 'how much does it cost', $4::vector, $3)`,
      [ENTRY_BOUND, vector(0.6, 0.8), ADMIN, vector(0.8, 0.6)],
    );

    const first = await publish("Provenance publish");
    const entries = (await db.query<{ entry_id: string; number_bindings: unknown; rewrite_hash: string | null }>(
      `select entry_id, number_bindings, rewrite_hash from public.brain_snapshot_entries
       where snapshot_id = $1 order by entry_id`, [first.snapshot_id],
    )).rows;
    expect(entries).toEqual([
      { entry_id: ENTRY_BOUND, number_bindings: BINDINGS, rewrite_hash: hash },
      { entry_id: ENTRY_PLAIN, number_bindings: [], rewrite_hash: null },
    ]);
    const variants = (await db.query<{ entry_id: string; variant: string }>(
      `select entry_id, variant from public.brain_snapshot_entry_variants where snapshot_id = $1 order by variant`,
      [first.snapshot_id],
    )).rows;
    expect(variants).toEqual([
      { entry_id: ENTRY_BOUND, variant: "how much does it cost" },
      { entry_id: ENTRY_BOUND, variant: "what is the price" },
    ]);
    await expectDbError(
      `update public.brain_snapshot_entry_variants set variant = 'edited' where snapshot_id = $1`,
      [first.snapshot_id], "PHASE2_IMMUTABLE_HISTORY",
    );

    // A second publish with the variants gone from the library, then a rollback to the first: the
    // rollback reproduces the first snapshot's variants, not the library's current state.
    await db.query(`delete from public.brain_knowledge_entries where id = $1`, [ENTRY_BOUND]);
    const second = await publish("Without the bound entry");
    expect((await db.query(
      `select count(*)::int as count from public.brain_snapshot_entry_variants where snapshot_id = $1`,
      [second.snapshot_id],
    )).rows[0].count).toBe(0);
    await actAs("service_role", ADMIN, "admin");
    const rolled = (await db.query<{ snapshot_id: string }>(
      `select * from public.rollback_brain_snapshot($1, $2, $3, 'Back to provenance')`,
      [ADMIN, second.brain_version, first.brain_version],
    )).rows[0];
    await resetRole();
    const restored = (await db.query<{ variant: string }>(
      `select variant from public.brain_snapshot_entry_variants where snapshot_id = $1 order by variant`,
      [rolled.snapshot_id],
    )).rows.map((row) => row.variant);
    expect(restored).toEqual(["how much does it cost", "what is the price"]);
    expect((await db.query<{ number_bindings: unknown }>(
      `select number_bindings from public.brain_snapshot_entries where snapshot_id = $1 and entry_id = $2`,
      [rolled.snapshot_id, ENTRY_BOUND],
    )).rows[0].number_bindings).toEqual(BINDINGS);
  });
});

describe("variants in ranking", () => {
  it("lets the best variant win for an entry, returns one row per entry, and keeps category a boost", async () => {
    await insertEntry(ENTRY_BOUND, BOUND_TEMPLATE, vector(1));
    await insertEntry(ENTRY_PLAIN, "Plain answer.", vector(0.9, Math.sqrt(1 - 0.81)));
    // The bound entry's own question points along x; its variant points along y. A query along y
    // should still find the bound entry first, through the variant, and say which variant matched.
    await db.query(
      `insert into public.brain_knowledge_entry_variants (entry_id, variant, embedding)
       values ($1, 'variant along y', $2::vector), ($1, 'variant along x', $3::vector)`,
      [ENTRY_BOUND, vector(0, 1), vector(1, 0)],
    );
    const snapshot = await publish("Variant ranking");
    await actAs("service_role", ADMIN, "admin");
    const rows = (await db.query<{
      entry_id: string; similarity: number; category_boost: number; score: number;
      matched_variant: string | null; number_bindings: unknown; rewrite_hash: string | null;
    }>(
      `select entry_id, similarity, category_boost, score, matched_variant, number_bindings, rewrite_hash
       from public.match_published_brain_entries($1, $2::vector, 'funding qs', 10)`,
      [snapshot.snapshot_id, vector(0, 1)],
    )).rows;
    await resetRole();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      entry_id: ENTRY_BOUND, matched_variant: "variant along y", category_boost: 0.05, number_bindings: [],
    });
    expect(rows[0].similarity).toBeCloseTo(1, 6);
    expect(rows[0].score).toBe(rows[0].similarity + rows[0].category_boost);
    expect(rows[1]).toMatchObject({ entry_id: ENTRY_PLAIN, matched_variant: null });
    expect(rows[1].similarity).toBeLessThan(0.7);

    // Along x the entry's own question wins and no variant is reported, even though one ties it:
    // the question is the entry's own text and takes precedence on a tie.
    await actAs("service_role", ADMIN, "admin");
    const alongX = (await db.query<{ entry_id: string; matched_variant: string | null }>(
      `select entry_id, matched_variant from public.match_published_brain_entries($1, $2::vector, null, 10)`,
      [snapshot.snapshot_id, vector(1, 0)],
    )).rows;
    await resetRole();
    expect(alongX[0]).toEqual({ entry_id: ENTRY_BOUND, matched_variant: null });
  });

  it("keeps variants immutable except when their entry is removed, and forces RLS on both tables", async () => {
    await insertEntry(ENTRY_BOUND, BOUND_TEMPLATE, vector(1));
    await db.query(
      `insert into public.brain_knowledge_entry_variants (entry_id, variant, embedding) values ($1, 'v', $2::vector)`,
      [ENTRY_BOUND, vector(0, 1)],
    );
    await expectDbError(
      `update public.brain_knowledge_entry_variants set variant = 'w' where entry_id = $1`,
      [ENTRY_BOUND], "BRAIN_VARIANT_IMMUTABLE",
    );
    await expectDbError(
      `delete from public.brain_knowledge_entry_variants where entry_id = $1`,
      [ENTRY_BOUND], "BRAIN_VARIANT_IMMUTABLE",
    );
    await db.query(`delete from public.brain_knowledge_entries where id = $1`, [ENTRY_BOUND]);
    expect((await db.query(
      `select count(*)::int as count from public.brain_knowledge_entry_variants where entry_id = $1`, [ENTRY_BOUND],
    )).rows[0].count).toBe(0);

    const forced = (await db.query<{ relname: string; relforcerowsecurity: boolean }>(`
      select c.relname, c.relforcerowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any($1::text[]) order by c.relname
    `, [["brain_knowledge_entry_variants", "brain_snapshot_entry_variants"]])).rows;
    expect(forced).toEqual([
      { relname: "brain_knowledge_entry_variants", relforcerowsecurity: true },
      { relname: "brain_snapshot_entry_variants", relforcerowsecurity: true },
    ]);
    const writes = (await db.query<{ count: string }>(`
      select count(*)::text from information_schema.role_table_grants
      where table_schema = 'public' and grantee = 'authenticated'
        and table_name = any($1::text[]) and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
    `, [["brain_knowledge_entry_variants", "brain_snapshot_entry_variants"]])).rows[0].count;
    expect(writes).toBe("0");
  });
});
