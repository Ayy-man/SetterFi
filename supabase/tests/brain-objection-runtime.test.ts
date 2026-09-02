// Phase 10 objection runtime. Live-Postgres-only on purpose: function custody, staleness refusal,
// deterministic ranking, trigger transactionality, forced RLS and trigger-inherited test
// segregation are all database behaviours that a mock would only restate.
//
// Every published payload is built through `brainObjectionDraftEntity`, so a key rename on either
// the TypeScript or the SQL side fails a test here instead of quietly publishing an objection with
// empty fields.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

import { brainObjectionDraftEntity } from "@/lib/brain/contracts";

const DB_URL =
  process.env.RLS_TEST_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// TENANT_A is the demo tenant and exists only so the cross-tenant read case has a second
// principal. Every measured row hangs off TENANT_B, because a demo tenant marks its whole lineage
// is_test and would make a segregation assertion pass for the wrong reason.
const TENANT_A = "3a000000-0000-4000-8000-000000000010";
const TENANT_B = "3a000000-0000-4000-8000-000000000020";
const ADMIN = "3b000000-0000-4000-8000-000000000010";
const COACH_A = "3b000000-0000-4000-8000-000000000020";
const COACH_B = "3b000000-0000-4000-8000-000000000030";
const MODEL = "3c000000-0000-4000-8000-000000000010";

const CONTACT_B = "3d000000-0000-4000-8000-000000000010";
const CONVERSATION_B = "3d000000-0000-4000-8000-000000000020";
const MESSAGE_ONE = "3d000000-0000-4000-8000-000000000030";
const MESSAGE_TWO = "3d000000-0000-4000-8000-000000000040";
const MESSAGE_THREE = "3d000000-0000-4000-8000-000000000050";

// Ids are ordered on purpose: PRICING < SHARED, so the ascending-id tie-break is observable when
// the two are level on hit count.
const OBJECTION_PRICING = "8a000000-0000-4000-8000-000000000101";
const OBJECTION_TIMING = "8a000000-0000-4000-8000-000000000102";
const OBJECTION_SHARED = "8a000000-0000-4000-8000-000000000103";

const SUITES = [
  "compliance_guardrails",
  "pricing_discipline",
  "jailbreak_injection",
  "output_integrity",
  "qualification_accuracy",
  "voice_tone",
] as const;

let db: Client;

function suiteResults() {
  return SUITES.map((suite) => ({
    suite,
    cases: [{ caseKey: `${suite}-synthetic`, passed: true, trace: { synthetic: true } }],
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
  await db.query("savepoint expected_objection_failure");
  let error: unknown;
  try {
    await db.query(sql, params as unknown[]);
  } catch (cause) {
    error = cause;
  }
  await db.query("rollback to savepoint expected_objection_failure");
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

async function recordEval(draft: { id: string; hash: string }) {
  await actAs("service_role", ADMIN, "admin");
  const id = (await db.query<{ id: string }>(
    `select public.record_eval_run($1, $2, $3, $4, $5, $6) as id`,
    [draft.id, draft.hash, "checker", null, "synthetic-v1", JSON.stringify(suiteResults())],
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

/** The hard-gated one. Its `pattern` deliberately covers a word no keyword covers. */
function pricingObjection() {
  return brainObjectionDraftEntity({
    id: OBJECTION_PRICING,
    label: "Too expensive",
    pattern: "expensive|too much",
    matchKeywords: ["Price", "cost", "  BUDGET "],
    response: "Here is exactly what the program costs and what it includes.",
    category: "pricing",
    hardGate: true,
  });
}

/** The multi-word keyword case, and the one non-hard objection every recording case uses. */
function timingObjection() {
  return brainObjectionDraftEntity({
    id: OBJECTION_TIMING,
    label: "Not right now",
    matchKeywords: ["later", "not right now"],
    response: "We can hold a slot and start whenever you are ready.",
    category: "timing",
  });
}

/** Shares `cost` with the pricing objection and sorts after it, so the tie-break is visible. */
function sharedKeywordObjection() {
  return brainObjectionDraftEntity({
    id: OBJECTION_SHARED,
    label: "What does it cover",
    matchKeywords: ["cost"],
    response: "The program covers the full build, not just the review.",
    category: "clarity",
  });
}

function payload(entities: readonly unknown[], compiledPlatform: string) {
  return { entities, compiledPlatform, platformTokens: entities.length, knowledgeMode: "inline" };
}

async function publishFixture(reason = "Objection runtime fixture") {
  const draft = await insertDraft(
    payload([pricingObjection(), timingObjection(), sharedKeywordObjection()], reason),
  );
  return publishDraft(draft, await recordEval(draft), reason);
}

type MatchRow = {
  snapshot_id: string;
  objection_id: string;
  label: string;
  response: string;
  category: string;
  hard_gate: boolean;
  matched_keywords: string[];
  keyword_hits: number;
};

async function match(snapshotId: string, message: string, limit?: number) {
  const sql = limit === undefined
    ? `select * from public.match_published_brain_objections($1, $2)`
    : `select * from public.match_published_brain_objections($1, $2, $3)`;
  const params = limit === undefined ? [snapshotId, message] : [snapshotId, message, limit];
  return (await db.query<MatchRow>(sql, params)).rows;
}

async function insertTrace(input: {
  messageId: string;
  tenantId?: string;
  snapshotId: string | null;
  objectionId: string | null;
  outcome: string | null;
  hardGate: boolean | null;
}) {
  return db.query(
    `insert into public.message_traces
       (message_id, tenant_id, objection_snapshot_id, objection_id,
        objection_handling_outcome, objection_hard_gate)
     values ($1, $2, $3, $4, $5, $6)`,
    [input.messageId, input.tenantId ?? TENANT_B, input.snapshotId, input.objectionId,
      input.outcome, input.hardGate],
  );
}

const TRACE_INSERT_SQL = `
  insert into public.message_traces
    (message_id, tenant_id, objection_snapshot_id, objection_id,
     objection_handling_outcome, objection_hard_gate)
  values ($1, $2, $3, $4, $5, $6)
`;

async function eventsFor(messageId: string) {
  return (await db.query(`
    select tenant_id, conversation_id, agent_message_id, snapshot_id, objection_id,
      handling_outcome, hard_gate, is_test
    from public.brain_objection_usage_events where agent_message_id = $1
  `, [messageId])).rows;
}

beforeAll(async () => {
  db = new Client({ connectionString: DB_URL });
  try {
    await db.connect();
  } catch (cause) {
    throw new Error(
      `Phase 10 objection runtime suite could not reach Postgres at ${DB_URL}. ` +
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
      ('${TENANT_A}', 'objection-a', 'Objection A', 'billing-a@objection.test', true),
      ('${TENANT_B}', 'objection-b', 'Objection B', 'billing-b@objection.test', false);
    insert into public.users (id, email, role, tenant_id) values
      ('${ADMIN}', 'admin@objection.test', 'admin', null),
      ('${COACH_A}', 'coach-a@objection.test', 'coach', '${TENANT_A}'),
      ('${COACH_B}', 'coach-b@objection.test', 'coach', '${TENANT_B}');
    insert into public.tenant_settings (tenant_id, link_whitelist) values
      ('${TENANT_A}', array['objection.test']), ('${TENANT_B}', array['objection.test']);
    insert into public.model_configs (id, label, openrouter_model, role, active)
      values ('${MODEL}', 'Objection synthetic model', 'mock/phase10', 'generator', false);
    insert into public.contacts (id, tenant_id, last_channel, name)
      values ('${CONTACT_B}', '${TENANT_B}', 'sms', 'Objection lead');
    insert into public.conversations (id, tenant_id, contact_id, channel)
      values ('${CONVERSATION_B}', '${TENANT_B}', '${CONTACT_B}', 'sms');
    insert into public.messages (id, tenant_id, conversation_id, direction, author, body) values
      ('${MESSAGE_ONE}', '${TENANT_B}', '${CONVERSATION_B}', 'out', 'agent', 'First agent reply'),
      ('${MESSAGE_TWO}', '${TENANT_B}', '${CONVERSATION_B}', 'out', 'agent', 'Second agent reply'),
      ('${MESSAGE_THREE}', '${TENANT_B}', '${CONVERSATION_B}', 'out', 'agent', 'Third agent reply');
  `);
});

afterEach(async () => {
  await db.query("rollback");
});

describe("match_published_brain_objections custody", () => {
  it("is definer-owned, search-path pinned, and executable only by service_role", async () => {
    const proc = (await db.query<{
      prosecdef: boolean; proconfig: string[] | null; provolatile: string;
    }>(`
      select p.prosecdef, p.proconfig, p.provolatile
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'match_published_brain_objections'
    `)).rows;
    expect(proc).toHaveLength(1);
    expect(proc[0].prosecdef).toBe(true);
    expect(proc[0].proconfig).toContain('search_path=""');
    expect(proc[0].provolatile).toBe("s");

    const grants = (await db.query<{ grantee: string }>(`
      select distinct grantee from information_schema.role_routine_grants
      where routine_schema = 'public'
        and routine_name = 'match_published_brain_objections'
        and privilege_type = 'EXECUTE'
      order by grantee
    `)).rows.map((row) => row.grantee);
    expect(grants).toContain("service_role");
    expect(grants).not.toContain("authenticated");
    expect(grants).not.toContain("anon");
    expect(grants).not.toContain("PUBLIC");

    const snapshot = await publishFixture();
    await actAs("authenticated", COACH_B, "coach", TENANT_B);
    await expectDbError(
      `select * from public.match_published_brain_objections($1, $2)`,
      [snapshot.snapshot_id, "the cost"],
      /permission denied/i,
    );
    await resetRole();
  });
});

describe("match_published_brain_objections refusal and bounds", () => {
  it("refuses a stale snapshot and never consults the mutable objection library", async () => {
    const first = await publishFixture("First objection publish");

    // A second publish makes the first snapshot stale without deleting it, which is the only way
    // to prove the refusal is about currency rather than about a missing row.
    const secondDraft = await insertDraft(payload([timingObjection()], "Second objection publish"));
    const second = await publishDraft(
      secondDraft, await recordEval(secondDraft), "Second objection publish",
    );
    expect(second.brain_version).toBeGreaterThan(first.brain_version);

    await expectDbError(
      `select * from public.match_published_brain_objections($1, $2)`,
      [first.snapshot_id, "the cost and the budget"],
      "BRAIN_SNAPSHOT_STALE",
    );

    // A live-library row whose keywords would match every probe below. If it ever surfaces, the
    // runtime is reading the mutable table instead of the immutable snapshot.
    await db.query(`
      insert into public.brain_objections (label, response, category, status, match_keywords)
      values ('Live library decoy', 'Decoy response', 'pricing', 'published',
        array['cost', 'budget', 'price', 'later'])
    `);
    const rows = await match(second.snapshot_id, "the cost and the budget and later");
    expect(rows.map((row) => row.objection_id)).toEqual([OBJECTION_TIMING]);
    expect(rows.every((row) => row.snapshot_id === second.snapshot_id)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("Decoy");
  });

  it("refuses a limit outside 1..10 and a blank inbound message", async () => {
    const snapshot = await publishFixture();
    await expectDbError(
      `select * from public.match_published_brain_objections($1, $2, $3)`,
      [snapshot.snapshot_id, "the cost", 0],
      "BRAIN_OBJECTION_LIMIT_INVALID",
    );
    await expectDbError(
      `select * from public.match_published_brain_objections($1, $2, $3)`,
      [snapshot.snapshot_id, "the cost", 11],
      "BRAIN_OBJECTION_LIMIT_INVALID",
    );
    await expectDbError(
      `select * from public.match_published_brain_objections($1, $2)`,
      [snapshot.snapshot_id, "   "],
      "BRAIN_OBJECTION_MESSAGE_REQUIRED",
    );
    expect(await match(snapshot.snapshot_id, "the cost", 1)).toHaveLength(1);
  });
});

describe("match_published_brain_objections ranking", () => {
  it("ranks by keyword hits, returns the snapshot row field for field, and repeats identically",
    async () => {
      const snapshot = await publishFixture();
      const message = "The price and the cost are too high for my budget";
      const rows = await match(snapshot.snapshot_id, message);

      expect(rows.map((row) => row.objection_id)).toEqual([OBJECTION_PRICING, OBJECTION_SHARED]);
      expect(rows.map((row) => row.keyword_hits)).toEqual([3, 1]);
      expect(rows[0].matched_keywords).toEqual(["budget", "cost", "price"]);
      expect(rows[1].matched_keywords).toEqual(["cost"]);

      // The returned column set is the contract the TypeScript repository parses.
      expect(Object.keys(rows[0]).sort()).toEqual([
        "category", "hard_gate", "keyword_hits", "label", "matched_keywords",
        "objection_id", "response", "snapshot_id",
      ]);

      const stored = (await db.query(`
        select label, response, category, hard_gate
        from public.brain_snapshot_objections
        where snapshot_id = $1 and objection_id = $2
      `, [snapshot.snapshot_id, OBJECTION_PRICING])).rows[0];
      expect({
        label: rows[0].label,
        response: rows[0].response,
        category: rows[0].category,
        hard_gate: rows[0].hard_gate,
      }).toEqual(stored);

      const again = await match(snapshot.snapshot_id, message);
      expect(again).toEqual(rows);
    });

  it("breaks a hit-count tie on ascending objection id", async () => {
    const snapshot = await publishFixture();
    const rows = await match(snapshot.snapshot_id, "what is the cost");
    expect(rows.map((row) => row.keyword_hits)).toEqual([1, 1]);
    expect(rows.map((row) => row.objection_id)).toEqual([OBJECTION_PRICING, OBJECTION_SHARED]);
    expect(OBJECTION_PRICING < OBJECTION_SHARED).toBe(true);
  });

  it("matches on token boundaries and multi-word keywords, and returns nothing on a miss",
    async () => {
      const snapshot = await publishFixture();

      // `cost` must not match inside `costume`; a substring match here would fire the hard-gated
      // pricing objection on a message that is not about pricing at all.
      expect(await match(snapshot.snapshot_id, "This costume is fine")).toEqual([]);
      expect(
        (await match(snapshot.snapshot_id, "I am not right now ready")).map((r) => r.objection_id),
      ).toEqual([OBJECTION_TIMING]);
      expect(
        (await match(snapshot.snapshot_id, "Price?!")).map((r) => r.objection_id),
      ).toEqual([OBJECTION_PRICING]);
      expect(
        (await match(snapshot.snapshot_id, "BUDGET")).map((r) => r.objection_id),
      ).toEqual([OBJECTION_PRICING]);
      expect(await match(snapshot.snapshot_id, "Where do I sign")).toEqual([]);
    });

  it("snapshots `pattern` and never consults it", async () => {
    const snapshot = await publishFixture();
    const stored = (await db.query<{ pattern: string | null }>(`
      select pattern from public.brain_snapshot_objections
      where snapshot_id = $1 and objection_id = $2
    `, [snapshot.snapshot_id, OBJECTION_PRICING])).rows[0];
    expect(stored.pattern).toBe("expensive|too much");

    // The pattern matches this message and no keyword does. Whether regex should take precedence
    // over keywords is an unmade product decision, so the runtime must not quietly make it.
    expect(await match(snapshot.snapshot_id, "That sounds expensive")).toEqual([]);
    expect(await match(snapshot.snapshot_id, "That is too much")).toEqual([]);
  });
});

describe("message_traces objection validation", () => {
  it("refuses a mis-declared gate, a missing outcome, and an objection the snapshot never had",
    async () => {
      const snapshot = await publishFixture();

      await expectDbError(TRACE_INSERT_SQL, [
        MESSAGE_ONE, TENANT_B, snapshot.snapshot_id, OBJECTION_PRICING, "held_safely", false,
      ], "BRAIN_OBJECTION_GATE_MISDECLARED");

      await expectDbError(TRACE_INSERT_SQL, [
        MESSAGE_ONE, TENANT_B, snapshot.snapshot_id, OBJECTION_TIMING, null, false,
      ], "BRAIN_OBJECTION_OUTCOME_REQUIRED");

      // An objection the named snapshot never carried is refused by the validation trigger, not
      // by message_traces_objection_fk: BEFORE ROW triggers run ahead of constraint checking, so
      // the trigger's lookup — which targets exactly the FK's referenced key — always answers
      // first. The FK is still the thing that makes a snapshot objection undeletable while a trace
      // names it, so its presence and its restrict semantics are asserted from the catalog rather
      // than through a path the trigger now shadows.
      await expectDbError(TRACE_INSERT_SQL, [
        MESSAGE_ONE, TENANT_B, snapshot.snapshot_id,
        "8a000000-0000-4000-8000-0000000009ff", "answered", false,
      ], "BRAIN_OBJECTION_SNAPSHOT_ROW_MISSING");

      const fk = (await db.query<{ confdeltype: string; referenced: string }>(`
        select c.confdeltype, r.relname as referenced
        from pg_constraint c join pg_class r on r.oid = c.confrelid
        where c.conrelid = 'public.message_traces'::regclass
          and c.conname = 'message_traces_objection_fk'
      `)).rows;
      expect(fk).toEqual([{ confdeltype: "r", referenced: "brain_snapshot_objections" }]);

      // The honest declaration is accepted.
      await insertTrace({
        messageId: MESSAGE_ONE, snapshotId: snapshot.snapshot_id,
        objectionId: OBJECTION_TIMING, outcome: "answered", hardGate: false,
      });
      const stored = (await db.query<{ objection_id: string }>(
        `select objection_id from public.message_traces where message_id = $1`, [MESSAGE_ONE],
      )).rows;
      expect(stored.map((row) => row.objection_id)).toEqual([OBJECTION_TIMING]);
    });
});

describe("brain_objection_usage_events recorder", () => {
  it("writes exactly one event from the trace and takes hard_gate from the snapshot", async () => {
    const snapshot = await publishFixture();
    await insertTrace({
      messageId: MESSAGE_ONE, snapshotId: snapshot.snapshot_id,
      objectionId: OBJECTION_TIMING, outcome: "answered", hardGate: false,
    });

    const events = await eventsFor(MESSAGE_ONE);
    expect(events).toEqual([{
      tenant_id: TENANT_B,
      conversation_id: CONVERSATION_B,
      agent_message_id: MESSAGE_ONE,
      snapshot_id: snapshot.snapshot_id,
      objection_id: OBJECTION_TIMING,
      handling_outcome: "answered",
      hard_gate: false,
      is_test: false,
    }]);
  });

  it("writes nothing for a trace that names no objection", async () => {
    await publishFixture();
    await insertTrace({
      messageId: MESSAGE_TWO, snapshotId: null, objectionId: null, outcome: null, hardGate: null,
    });
    expect(await eventsFor(MESSAGE_TWO)).toEqual([]);
    const total = (await db.query<{ count: string }>(
      `select count(*)::text from public.brain_objection_usage_events`,
    )).rows[0].count;
    expect(total).toBe("0");
  });

  it("takes the trace down with it when the event cannot be written", async () => {
    const snapshot = await publishFixture();
    // Pre-place the event this trace would create. The unique index on agent_message_id then
    // fires inside the trace's own statement, which is the whole point of recording by trigger.
    await db.query(`
      insert into public.brain_objection_usage_events
        (tenant_id, conversation_id, agent_message_id, snapshot_id, objection_id,
         handling_outcome, hard_gate)
      values ($1, $2, $3, $4, $5, 'answered', false)
    `, [TENANT_B, CONVERSATION_B, MESSAGE_ONE, snapshot.snapshot_id, OBJECTION_TIMING]);

    await expectDbError(TRACE_INSERT_SQL, [
      MESSAGE_ONE, TENANT_B, snapshot.snapshot_id, OBJECTION_TIMING, "answered", false,
    ], "brain_objection_usage_events_message_uidx");

    const traces = (await db.query<{ count: string }>(
      `select count(*)::text from public.message_traces where message_id = $1`, [MESSAGE_ONE],
    )).rows[0].count;
    expect(traces).toBe("0");
    expect(await eventsFor(MESSAGE_ONE)).toHaveLength(1);
  });

  it("records once when the same outbound message is traced twice", async () => {
    const snapshot = await publishFixture();
    await insertTrace({
      messageId: MESSAGE_ONE, snapshotId: snapshot.snapshot_id,
      objectionId: OBJECTION_TIMING, outcome: "answered", hardGate: false,
    });
    await expectDbError(TRACE_INSERT_SQL, [
      MESSAGE_ONE, TENANT_B, snapshot.snapshot_id, OBJECTION_TIMING, "answered", false,
    ], "message_traces_pkey");
    expect(await eventsFor(MESSAGE_ONE)).toHaveLength(1);
  });
});

describe("brain_objection_usage_events custody", () => {
  // New coverage rather than red: 10-01 landed the append-only trigger and the select-only RLS
  // but left both unasserted. These two cases are expected to pass the moment they are written.
  it("refuses every update and delete, the database owner included", async () => {
    const snapshot = await publishFixture();
    await db.query(`
      insert into public.brain_objection_usage_events
        (tenant_id, conversation_id, agent_message_id, snapshot_id, objection_id,
         handling_outcome, hard_gate)
      values ($1, $2, $3, $4, $5, 'answered', false)
    `, [TENANT_B, CONVERSATION_B, MESSAGE_ONE, snapshot.snapshot_id, OBJECTION_TIMING]);

    await resetRole();
    await expectDbError(
      `update public.brain_objection_usage_events set handling_outcome = 'held_safely'
       where agent_message_id = $1`,
      [MESSAGE_ONE], "PHASE2_IMMUTABLE_HISTORY",
    );
    await expectDbError(
      `delete from public.brain_objection_usage_events where agent_message_id = $1`,
      [MESSAGE_ONE], "PHASE2_IMMUTABLE_HISTORY",
    );
    expect(await eventsFor(MESSAGE_ONE)).toHaveLength(1);
  });

  it("shows a coach only their own tenant's events and lets no one insert", async () => {
    const snapshot = await publishFixture();
    const eventId = (await db.query<{ id: string }>(`
      insert into public.brain_objection_usage_events
        (tenant_id, conversation_id, agent_message_id, snapshot_id, objection_id,
         handling_outcome, hard_gate)
      values ($1, $2, $3, $4, $5, 'answered', false) returning id
    `, [TENANT_B, CONVERSATION_B, MESSAGE_ONE, snapshot.snapshot_id, OBJECTION_TIMING]))
      .rows[0].id;

    await actAs("authenticated", COACH_B, "coach", TENANT_B);
    const own = await db.query<{ id: string }>(
      `select id from public.brain_objection_usage_events where id = $1`, [eventId]);
    expect(own.rows.map((row) => row.id)).toEqual([eventId]);

    await actAs("authenticated", COACH_A, "coach", TENANT_A);
    const other = await db.query<{ id: string }>(
      `select id from public.brain_objection_usage_events where id = $1`, [eventId]);
    expect(other.rows).toEqual([]);

    await actAs("authenticated", COACH_B, "coach", TENANT_B);
    await expectDbError(`
      insert into public.brain_objection_usage_events
        (tenant_id, conversation_id, agent_message_id, snapshot_id, objection_id,
         handling_outcome, hard_gate)
      values ($1, $2, $3, $4, $5, 'answered', false)
    `, [TENANT_B, CONVERSATION_B, MESSAGE_TWO, snapshot.snapshot_id, OBJECTION_TIMING],
      /permission denied/i);
    await resetRole();
  });
});

// Phase 10-03: the engine now sends a hard-gated objection's published response, so a gated
// objection reaches this table on turns that were themselves successful. What the database must
// still refuse is the pair "hard-gated" and "answered" — by two independent mechanisms, because
// an application can lie about the gate in two different directions.
describe("a hard-gated objection cannot be recorded as answered", () => {
  it("refuses the honest declaration at the check constraint", async () => {
    const snapshot = await publishFixture();
    // The declared gate matches the snapshot row, so the BEFORE ROW validator passes and hands
    // off to constraint checking. The constraint is therefore what names the failure.
    await expectDbError(TRACE_INSERT_SQL, [
      MESSAGE_ONE, TENANT_B, snapshot.snapshot_id, OBJECTION_PRICING, "answered", true,
    ], "message_traces_objection_gate_chk");
  });

  it("refuses the understated declaration at the validation trigger", async () => {
    const snapshot = await publishFixture();
    // Understating the gate would slip past the check constraint, so it never gets there: BEFORE
    // ROW triggers run ahead of constraint checking, and the validator compares the declaration
    // against the snapshot row. Two different lies, two different errors — asserted by name so a
    // later refactor that merges them is visible here rather than silent.
    await expectDbError(TRACE_INSERT_SQL, [
      MESSAGE_ONE, TENANT_B, snapshot.snapshot_id, OBJECTION_PRICING, "answered", false,
    ], "BRAIN_OBJECTION_GATE_MISDECLARED");
  });

  it("accepts held_safely and records one gated event whose hard_gate came from the snapshot",
    async () => {
      const snapshot = await publishFixture();
      await insertTrace({
        messageId: MESSAGE_ONE, snapshotId: snapshot.snapshot_id,
        objectionId: OBJECTION_PRICING, outcome: "held_safely", hardGate: true,
      });

      expect(await eventsFor(MESSAGE_ONE)).toEqual([{
        tenant_id: TENANT_B,
        conversation_id: CONVERSATION_B,
        agent_message_id: MESSAGE_ONE,
        snapshot_id: snapshot.snapshot_id,
        objection_id: OBJECTION_PRICING,
        handling_outcome: "held_safely",
        hard_gate: true,
        is_test: false,
      }]);

      // The accepted residual, asserted rather than patched: the event's hard_gate is not
      // constrained at the table to equal its snapshot row's. The recorder is the only writer —
      // the table grants INSERT to no role — so what guarantees it is that the recorder reads
      // hard_gate from brain_snapshot_objections and never from the trace's own declaration.
      const definition = (await db.query<{ def: string }>(
        `select pg_get_functiondef('app.record_brain_objection_usage()'::regprocedure) as def`,
      )).rows[0].def;
      expect(definition).toContain("brain_snapshot_objections");
      expect(definition).not.toContain("objection_hard_gate");
    });
});

describe("trigger-created events earn is_test through the conversation", () => {
  // phase2-schema.test.ts:1038 already proves caller-supplied is_test is overwritten and that the
  // analytics view excludes both test lineage and demo tenancy for rows inserted DIRECTLY. What is
  // unproven there, and proven here, is that the same holds for a row the recorder trigger creates.
  it("inherits the flag on the trigger's row and excludes it from analytics", async () => {
    const testSession = "3e000000-0000-4000-8000-000000000010";
    const testContact = "3e000000-0000-4000-8000-000000000020";
    const testConversation = "3e000000-0000-4000-8000-000000000030";
    const testMessage = "3e000000-0000-4000-8000-000000000040";

    const snapshot = await publishFixture();
    await resetRole();

    // A real test_agent_sessions row is what earns the flag; every descendant omits is_test.
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

    const lineage = await db.query<{ label: string; is_test: boolean }>(`
      select 'real_contact' label, is_test from public.contacts where id = $1
      union all select 'real_conversation', is_test from public.conversations where id = $2
      union all select 'real_message', is_test from public.messages where id = $3
      union all select 'test_contact', is_test from public.contacts where id = $4
      union all select 'test_conversation', is_test from public.conversations where id = $5
      union all select 'test_message', is_test from public.messages where id = $6
      order by label
    `, [CONTACT_B, CONVERSATION_B, MESSAGE_ONE, testContact, testConversation, testMessage]);
    expect(lineage.rows).toEqual([
      { label: "real_contact", is_test: false },
      { label: "real_conversation", is_test: false },
      { label: "real_message", is_test: false },
      { label: "test_contact", is_test: true },
      { label: "test_conversation", is_test: true },
      { label: "test_message", is_test: true },
    ]);

    // Neither trace names is_test; only the trigger chain may set it on the event.
    await insertTrace({
      messageId: MESSAGE_ONE, snapshotId: snapshot.snapshot_id,
      objectionId: OBJECTION_TIMING, outcome: "answered", hardGate: false,
    });
    await insertTrace({
      messageId: testMessage, snapshotId: snapshot.snapshot_id,
      objectionId: OBJECTION_TIMING, outcome: "answered", hardGate: false,
    });

    const created = (await db.query<{ id: string; agent_message_id: string; is_test: boolean }>(`
      select id, agent_message_id, is_test from public.brain_objection_usage_events
      where agent_message_id = any($1::uuid[]) order by is_test
    `, [[MESSAGE_ONE, testMessage]])).rows;
    expect(created.map((row) => row.is_test)).toEqual([false, true]);

    const visible = (await db.query<{ event_id: string }>(`
      select event_id from public.analytics_brain_objection_usage_events
      where event_id = any($1::uuid[])
    `, [created.map((row) => row.id)])).rows;
    expect(visible.map((row) => row.event_id)).toEqual([created[0].id]);

    // The is_demo clause has to carry its own weight: flip the tenant after the rows exist and the
    // real event leaves the view while its stored is_test is still false.
    await db.query(`update public.tenants set is_demo = true where id = '${TENANT_B}'`);
    const afterFlip = (await db.query<{ count: string }>(`
      select count(*)::text from public.analytics_brain_objection_usage_events
      where tenant_id = '${TENANT_B}'
    `)).rows[0].count;
    expect(afterFlip).toBe("0");
    const stillReal = (await db.query<{ is_test: boolean }>(
      `select is_test from public.brain_objection_usage_events where id = $1`, [created[0].id],
    )).rows[0];
    expect(stillReal.is_test).toBe(false);

    // The recorder must not decide the flag at all — if the word appears in its body, something
    // is setting is_test explicitly and inherit_is_test has stopped being the single decider.
    const definition = (await db.query<{ def: string }>(
      `select pg_get_functiondef('app.record_brain_objection_usage()'::regprocedure) as def`,
    )).rows[0].def;
    expect(definition).not.toContain("is_test");
  });
});

// Phase 10-04: the coach-facing rollup. Everything below reads
// `public.analytics_brain_objection_usage_events` through the RPC, never the base table, so a
// test row or a demo tenant is absent by construction rather than by a filter someone remembered.
type RollupRow = {
  objectionId: string;
  label: string;
  state: string;
  bookedRate: number | null;
  conversationCount: number;
  hardGate: boolean;
};

type Rollup = {
  tenantId: string;
  asOf: string;
  windowStart: string;
  windowEnd: string;
  attributionState: string;
  rows: RollupRow[];
};

const ROLLUP_AS_OF = "2026-08-22T12:00:00.000Z";
/**
 * Events must land inside the trailing window of ROLLUP_AS_OF, which is a literal the
 * window-boundary test asserts against. Defaulting to now() made the whole rollup suite pass
 * until the wall clock crossed the pinned as-of and then fail everywhere at once.
 */
const DEFAULT_USED_AT = "2026-08-21T12:00:00.000Z";

/** Events are inserted directly as owner: the table grants INSERT to no role at all. */
async function insertEvent(input: {
  snapshotId: string;
  objectionId: string;
  conversationId?: string;
  messageId: string;
  tenantId?: string;
  outcome?: "answered" | "held_safely";
  hardGate?: boolean;
  usedAt?: string;
}) {
  await db.query(`
    insert into public.brain_objection_usage_events
      (tenant_id, conversation_id, agent_message_id, snapshot_id, objection_id,
       handling_outcome, hard_gate, used_at)
    values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
  `, [
    input.tenantId ?? TENANT_B,
    input.conversationId ?? CONVERSATION_B,
    input.messageId,
    input.snapshotId,
    input.objectionId,
    input.outcome ?? "answered",
    input.hardGate ?? false,
    input.usedAt ?? DEFAULT_USED_AT,
  ]);
}

async function readRollup(input: {
  actorId: string;
  tenantId: string;
  asOf?: string;
  limit?: number;
  includeHardGated?: boolean;
}) {
  await resetRole();
  const { rows } = await db.query<{ payload: Rollup }>(
    `select public.read_coach_top_objections_for_actor($1, $2, $3, $4, $5) as payload`,
    [input.actorId, input.tenantId, input.asOf ?? ROLLUP_AS_OF, input.limit ?? 5,
      input.includeHardGated ?? false],
  );
  return rows[0].payload;
}

describe("read_coach_top_objections rollup", () => {
  it("counts distinct conversations, not events, and labels from the snapshot", async () => {
    const snapshot = await publishFixture();
    const secondConversation = "3f000000-0000-4000-8000-000000000010";
    const secondMessage = "3f000000-0000-4000-8000-000000000020";
    await resetRole();
    await db.query(
      `insert into public.conversations (id, tenant_id, contact_id, channel)
       values ($1, '${TENANT_B}', '${CONTACT_B}', 'sms')`, [secondConversation]);
    await db.query(
      `insert into public.messages (id, tenant_id, conversation_id, direction, author, body)
       values ($1, '${TENANT_B}', $2, 'out', 'agent', 'Another agent reply')`,
      [secondMessage, secondConversation]);

    // Two hits on one conversation and one on another: three events, two conversations.
    await insertEvent({ snapshotId: snapshot.snapshot_id, objectionId: OBJECTION_TIMING, messageId: MESSAGE_ONE });
    await insertEvent({ snapshotId: snapshot.snapshot_id, objectionId: OBJECTION_TIMING, messageId: MESSAGE_TWO });
    await insertEvent({
      snapshotId: snapshot.snapshot_id, objectionId: OBJECTION_TIMING,
      conversationId: secondConversation, messageId: secondMessage,
    });

    const payload = await readRollup({ actorId: COACH_B, tenantId: TENANT_B });
    expect(Object.keys(payload).sort()).toEqual([
      "asOf", "attributionState", "rows", "tenantId", "windowEnd", "windowStart",
    ]);
    expect(payload.tenantId).toBe(TENANT_B);
    expect(payload.attributionState).toBe("awaiting_definition");
    expect(payload.rows).toEqual([{
      objectionId: OBJECTION_TIMING,
      label: "Not right now",
      state: "awaiting_definition",
      bookedRate: null,
      conversationCount: 2,
      hardGate: false,
    }]);

    // The label came from the snapshot's composite row, so a live-library rename cannot move it.
    await db.query(`
      insert into public.brain_objections (id, label, response, category, status, match_keywords)
      values ($1, 'Renamed in the live library', 'Decoy', 'timing', 'published', array['later'])
      on conflict (id) do update set label = excluded.label
    `, [OBJECTION_TIMING]);
    const again = await readRollup({ actorId: COACH_B, tenantId: TENANT_B });
    expect(again.rows[0].label).toBe("Not right now");
    expect(JSON.stringify(again)).not.toContain("Renamed in the live library");
  });

  it("leaves hard-gated rows unfetched by default and holds them safely when asked for", async () => {
    const snapshot = await publishFixture();
    await insertEvent({ snapshotId: snapshot.snapshot_id, objectionId: OBJECTION_TIMING, messageId: MESSAGE_ONE });
    await insertEvent({
      snapshotId: snapshot.snapshot_id, objectionId: OBJECTION_PRICING, messageId: MESSAGE_TWO,
      outcome: "held_safely", hardGate: true,
    });

    const shipped = await readRollup({ actorId: COACH_B, tenantId: TENANT_B });
    expect(shipped.rows.map((row) => row.objectionId)).toEqual([OBJECTION_TIMING]);

    // The decision waiting on Alec, asserted so the day it flips this is a constant change.
    const widened = await readRollup({
      actorId: COACH_B, tenantId: TENANT_B, includeHardGated: true,
    });
    expect(widened.rows.map((row) => row.objectionId).sort())
      .toEqual([OBJECTION_PRICING, OBJECTION_TIMING].sort());
    const gated = widened.rows.find((row) => row.objectionId === OBJECTION_PRICING);
    expect(gated).toMatchObject({ state: "held_safely", bookedRate: null, hardGate: true });
  });

  it("authorizes the actor before it filters, and grants execute to service_role alone", async () => {
    const snapshot = await publishFixture();
    await insertEvent({ snapshotId: snapshot.snapshot_id, objectionId: OBJECTION_TIMING, messageId: MESSAGE_ONE });

    await resetRole();
    await expectDbError(
      `select public.read_coach_top_objections_for_actor($1, $2, $3, 5, false)`,
      [COACH_A, TENANT_B, ROLLUP_AS_OF],
      "PHASE7_COACH_READER_TENANT_MISMATCH",
    );
    await expectDbError(
      `select public.read_coach_top_objections_for_actor(null, $1, $2, 5, false)`,
      [TENANT_B, ROLLUP_AS_OF],
      "PHASE7_SESSION_ACTOR_REQUIRED",
    );

    for (const routine of ["read_coach_top_objections", "read_coach_top_objections_for_actor"]) {
      const grants = (await db.query<{ grantee: string }>(`
        select distinct grantee from information_schema.role_routine_grants
        where routine_schema = 'public' and routine_name = $1 and privilege_type = 'EXECUTE'
      `, [routine])).rows.map((row) => row.grantee);
      expect(grants).toContain("service_role");
      expect(grants).not.toContain("authenticated");
      expect(grants).not.toContain("anon");
      expect(grants).not.toContain("PUBLIC");
    }

    await actAs("authenticated", COACH_B, "coach", TENANT_B);
    await expectDbError(
      `select public.read_coach_top_objections($1, $2, 5, false)`,
      [TENANT_B, ROLLUP_AS_OF],
      /permission denied/i,
    );
    await resetRole();
  });

  it("excludes a test conversation's event and returns an honest empty panel for a demo tenant",
    async () => {
      const testSession = "3e000000-0000-4000-8000-000000000110";
      const testContact = "3e000000-0000-4000-8000-000000000120";
      const testConversation = "3e000000-0000-4000-8000-000000000130";
      const testMessage = "3e000000-0000-4000-8000-000000000140";
      const demoContact = "3e000000-0000-4000-8000-000000000210";
      const demoConversation = "3e000000-0000-4000-8000-000000000220";
      const demoMessage = "3e000000-0000-4000-8000-000000000230";

      const snapshot = await publishFixture();
      await resetRole();
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
      await db.query(
        `insert into public.contacts (id, tenant_id, last_channel, name)
         values ($1, '${TENANT_A}', 'sms', 'Demo lead')`, [demoContact]);
      await db.query(
        `insert into public.conversations (id, tenant_id, contact_id, channel)
         values ($1, '${TENANT_A}', $2, 'sms')`, [demoConversation, demoContact]);
      await db.query(
        `insert into public.messages (id, tenant_id, conversation_id, direction, author, body)
         values ($1, '${TENANT_A}', $2, 'out', 'agent', 'Demo agent reply')`,
        [demoMessage, demoConversation]);

      await insertEvent({
        snapshotId: snapshot.snapshot_id, objectionId: OBJECTION_TIMING, messageId: MESSAGE_ONE,
      });
      await insertEvent({
        snapshotId: snapshot.snapshot_id, objectionId: OBJECTION_TIMING,
        conversationId: testConversation, messageId: testMessage,
      });
      await insertEvent({
        snapshotId: snapshot.snapshot_id, objectionId: OBJECTION_TIMING,
        tenantId: TENANT_A, conversationId: demoConversation, messageId: demoMessage,
      });

      // The inherited flags first: the exclusion has to be the view's, not the insert's. A demo
      // tenant marks its whole lineage is_test, so the demo event carries the flag too — which is
      // exactly why the is_demo clause is asserted separately below rather than here.
      const flags = new Map((await db.query<{ agent_message_id: string; is_test: boolean }>(`
        select agent_message_id, is_test from public.brain_objection_usage_events
        where agent_message_id = any($1::uuid[])
      `, [[MESSAGE_ONE, testMessage, demoMessage]])).rows
        .map((row) => [row.agent_message_id, row.is_test] as const));
      expect(flags.get(MESSAGE_ONE)).toBe(false);
      expect(flags.get(testMessage)).toBe(true);
      expect(flags.get(demoMessage)).toBe(true);

      const real = await readRollup({ actorId: COACH_B, tenantId: TENANT_B });
      expect(real.rows).toEqual([{
        objectionId: OBJECTION_TIMING,
        label: "Not right now",
        state: "awaiting_definition",
        bookedRate: null,
        conversationCount: 1,
        hardGate: false,
      }]);

      // A demo tenant's own coach is authorized and still sees nothing, because the analytics view
      // excludes tenants.is_demo. An empty panel is the honest answer, not an error.
      const demo = await readRollup({ actorId: COACH_A, tenantId: TENANT_A });
      expect(demo.rows).toEqual([]);
      expect(demo.attributionState).toBe("awaiting_definition");

      // The is_demo clause has to carry its own weight, so flip the real tenant after its rows
      // exist: the panel empties while the event's stored is_test is still false.
      await resetRole();
      await db.query(`update public.tenants set is_demo = true where id = '${TENANT_B}'`);
      const flipped = await readRollup({ actorId: COACH_B, tenantId: TENANT_B });
      expect(flipped.rows).toEqual([]);
      const stillReal = (await db.query<{ is_test: boolean }>(
        `select is_test from public.brain_objection_usage_events where agent_message_id = $1`,
        [MESSAGE_ONE],
      )).rows[0];
      expect(stillReal.is_test).toBe(false);
    });

  it("uses a trailing half-open window and clamps the limit", async () => {
    const snapshot = await publishFixture();
    await resetRole();
    const stamps = [
      // 31 days before asOf: outside the trailing window.
      {
        suffix: "31", usedAt: "2026-07-22T12:00:00.000Z",
        conversationId: "3f000000-0000-4000-8000-000000000310",
        messageId: "3f000000-0000-4000-8000-000000000311",
      },
      // 29 days before asOf: inside it.
      {
        suffix: "29", usedAt: "2026-07-24T12:00:00.000Z",
        conversationId: "3f000000-0000-4000-8000-000000000290",
        messageId: "3f000000-0000-4000-8000-000000000291",
      },
      // Exactly at asOf: excluded by the half-open upper bound.
      {
        suffix: "00", usedAt: ROLLUP_AS_OF,
        conversationId: "3f000000-0000-4000-8000-000000000000",
        messageId: "3f000000-0000-4000-8000-000000000001",
      },
    ];
    for (const stamp of stamps) {
      const { conversationId, messageId } = stamp;
      await db.query(
        `insert into public.conversations (id, tenant_id, contact_id, channel)
         values ($1, '${TENANT_B}', '${CONTACT_B}', 'sms')`, [conversationId]);
      await db.query(
        `insert into public.messages (id, tenant_id, conversation_id, direction, author, body)
         values ($1, '${TENANT_B}', $2, 'out', 'agent', $3)`,
        [messageId, conversationId, `Reply ${stamp.suffix}`]);
      await insertEvent({
        snapshotId: snapshot.snapshot_id, objectionId: OBJECTION_TIMING,
        conversationId, messageId, usedAt: stamp.usedAt,
      });
    }

    const payload = await readRollup({ actorId: COACH_B, tenantId: TENANT_B });
    expect(payload.windowStart).toBe("2026-07-23T12:00:00.000Z");
    expect(payload.windowEnd).toBe("2026-08-22T12:00:00.000Z");
    expect(payload.asOf).toBe("2026-08-22T12:00:00.000Z");
    expect(payload.rows).toEqual([expect.objectContaining({ conversationCount: 1 })]);

    // A limit outside 1..20 is clamped rather than raised, because a coach panel asking for zero
    // rows is a caller bug that must not blank the surface.
    const clamped = await readRollup({ actorId: COACH_B, tenantId: TENANT_B, limit: 0 });
    expect(clamped.rows).toHaveLength(1);
  });

  it("returns no rate anywhere and names no appointment source in its body", async () => {
    const snapshot = await publishFixture();
    await insertEvent({ snapshotId: snapshot.snapshot_id, objectionId: OBJECTION_TIMING, messageId: MESSAGE_ONE });
    await insertEvent({
      snapshotId: snapshot.snapshot_id, objectionId: OBJECTION_PRICING, messageId: MESSAGE_TWO,
      outcome: "held_safely", hardGate: true,
    });

    for (const includeHardGated of [false, true]) {
      const payload = await readRollup({
        actorId: COACH_B, tenantId: TENANT_B, includeHardGated,
      });
      expect(payload.attributionState).toBe("awaiting_definition");
      // Assert the shape of the set before asserting over it: every() is true of an empty array,
      // so an empty rollup would have satisfied both predicates below without proving anything.
      expect(payload.rows).toHaveLength(includeHardGated ? 2 : 1);
      expect(payload.rows.every((row) => row.bookedRate === null)).toBe(true);
      expect(payload.rows.every((row) => ["awaiting_definition", "held_safely"].includes(row.state)))
        .toBe(true);
    }

    // The proof no attribution window was quietly invented: nothing in the body reaches an
    // appointment. When Alec approves the rule, this assertion is what a later plan must change.
    const definition = (await db.query<{ def: string }>(`
      select pg_get_functiondef(
        'public.read_coach_top_objections(uuid,timestamptz,int,boolean)'::regprocedure
      ) as def
    `)).rows[0].def;
    expect(definition).not.toContain("appointment");
    expect(definition).toContain("analytics_brain_objection_usage_events");
    expect(definition).not.toContain("from public.brain_objection_usage_events");
  });
});
