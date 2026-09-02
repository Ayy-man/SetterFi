/** Deterministic, synthetic Phase 2 extension of the guarded Phase 1 demo tenant. */

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import pg from "pg";

import {
  createDemoClient,
  DEMO_IDS,
  DEMO_VALUES,
  resolveDemoTarget,
  seedPhase1Demo,
} from "./seed-phase1-demo.mjs";

export const PHASE2_DEMO_IDS = Object.freeze({
  admin: "82000000-0000-4000-8000-000000000001",
  batch: "82000000-0000-4000-8000-000000000002",
  knowledge: "82000000-0000-4000-8000-000000000003",
});

const FLAG_CODES = [
  "source_shape",
  "first_person_pii",
  "unbound_figure",
  "unknown_placeholder",
  "bare_x",
  "multi_category",
  "prose_shape",
];
const UNIT_EMBEDDING = `[1,${Array.from({ length: 1535 }, () => "0").join(",")}]`;

function itemId(index) {
  return `82000000-0000-4000-8001-${String(index).padStart(12, "0")}`;
}

function syntheticReviewRows() {
  return Array.from({ length: 46 }, (_, offset) => {
    const sequence = offset + 1;
    const code = FLAG_CODES[offset % FLAG_CODES.length];
    const token = code === "unbound_figure" ? "42" : code === "unknown_placeholder" ? "{{firstname}}" : code === "bare_x" ? "3x" : "synthetic";
    return {
      id: itemId(sequence),
      sourceRef: `mock:review:${String(sequence).padStart(2, "0")}`,
      payload: {
        category: sequence % 2 === 0 ? "qualification" : "process",
        inboundMessage: `Synthetic review prompt ${sequence}`,
        responseTemplate: `Synthetic bounded response ${sequence} with ${token}.`,
        matchKeywords: ["synthetic", `case-${sequence}`],
      },
      flags: [{
        id: `flag-${sequence}`,
        code,
        severity: "blocking",
        field: "responseTemplate",
        offset: 35,
        resolved: sequence === 1,
      }],
      accepted: sequence === 1,
    };
  });
}

function offerPayload(label) {
  const payload = {
    programName: "Synthetic funding readiness",
    programDescription: `Synthetic ${label} offer for local verification.`,
    creditMin: 640,
    fundingGoalMinCents: 5_000_000,
    fundingGoalMaxCents: 15_000_000,
    monthlyRevenueMinCents: null,
    products: ["biz line of credit"],
    creditRepair: "no_good_credit_only",
    bookingHorizonDays: 21,
    bookingMode: "direct",
    brandVoice: "professional",
    resultsTimelineMinDays: null,
    resultsTimelineMaxDays: null,
    refundPosture: "none",
    voiceStyleAnswer: "Use clear, direct language and ask one bounded question at a time.",
    voiceObjectionAnswer: "Acknowledge the concern and explain the next verified step.",
    voiceFollowupAnswer: "Restate the open question without adding an outcome claim.",
    prices: [{ label: "Synthetic review fee", amountCents: 10_000, billingPeriod: "one_time" }],
    proof: [{ title: "Synthetic workflow", detail: "Local test evidence for the bounded demo path." }],
    assets: [{ slug: "synthetic-guide", label: "Synthetic guide", url: "https://example.invalid/synthetic-guide" }],
    cadencePurposes: label === "published"
      ? [{ channelClass: "durable", touchNo: 1, purpose: "value_nudge", assetId: null }]
      : [],
  };
  return { ...payload, contentHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
}

function evalSuites() {
  return [
    "compliance_guardrails",
    "pricing_discipline",
    "jailbreak_injection",
    "output_integrity",
    "qualification_accuracy",
    "voice_tone",
  ].map((suite) => ({
    suite,
    cases: [{ caseKey: `synthetic-${suite}`, passed: true, response: "Synthetic checker pass.", trace: { arm: "mock" }, latencyMs: 0, costCents: 0 }],
  }));
}

async function requireSuccess(label, promise) {
  const result = await promise;
  if (result.error) throw new Error(`${label}:${result.error.message}`);
  return result.data;
}

async function verifyPhase1Demo(client) {
  const tenant = await requireSuccess(
    "PHASE2_DEMO_TENANT_READ_FAILED",
    client.from("tenants").select("id, slug, is_demo").eq("id", DEMO_IDS.tenant).maybeSingle(),
  );
  if (!tenant || tenant.id !== DEMO_IDS.tenant || tenant.slug !== DEMO_VALUES.slug || tenant.is_demo !== true) {
    throw new Error("PHASE2_DEMO_TENANT_ANCESTRY_REFUSED");
  }
  return tenant;
}

async function seedImports(database) {
  const rows = syntheticReviewRows();
  await database.query("delete from public.brain_import_batches where id = $1", [PHASE2_DEMO_IDS.batch]);
  await database.query(
    `insert into public.brain_import_batches
      (id, source, collection_ref, source_hash, received_count, normalized_count, flagged_count,
       unchanged_count, status, created_by, completed_at)
     values ($1, 'mock', 'synthetic:phase2:46', $2, 46, 46, 46, 0, 'open', $3, now())`,
    [PHASE2_DEMO_IDS.batch, createHash("sha256").update("synthetic:phase2:46").digest("hex"), PHASE2_DEMO_IDS.admin],
  );
  for (const row of rows) {
    await database.query(
      `insert into public.brain_import_items
        (id, batch_id, source_ref, operation, after_payload, flags, disposition, number_bindings,
         decision, decided_by, decided_at)
       values ($1, $2, $3, 'new', $4::jsonb, $5::jsonb, $6, '[]'::jsonb, $7, $8, $9)`,
      [row.id, PHASE2_DEMO_IDS.batch, row.sourceRef, JSON.stringify(row.payload), JSON.stringify(row.flags),
        row.accepted ? "shared" : null, row.accepted ? "accepted" : "pending",
        row.accepted ? PHASE2_DEMO_IDS.admin : null, row.accepted ? new Date(0) : null],
    );
  }
  await database.query(
    `insert into public.brain_knowledge_entries
      (id, question, answer, category, match_keywords, status, source, source_ref, disposition,
       response_template, embedding, import_item_id, version)
     values ($1, 'Synthetic review prompt 1', 'Synthetic bounded response 1.', 'process',
       array['synthetic','case-1'], 'draft', 'mock', 'mock:review:01', 'shared',
       'Synthetic bounded response 1.', $2::vector, $3, 1)
     on conflict (id) do update set
       question = excluded.question, answer = excluded.answer, category = excluded.category,
       match_keywords = excluded.match_keywords, status = 'draft', published_at = null,
       source = excluded.source, source_ref = excluded.source_ref, disposition = excluded.disposition,
       response_template = excluded.response_template, embedding = excluded.embedding,
       import_item_id = excluded.import_item_id`,
    [PHASE2_DEMO_IDS.knowledge, UNIT_EMBEDDING, itemId(1)],
  );
}

async function seedQualification(database) {
  const rows = [
    ["strong-credit", "Synthetic strong credit", 1, "BOOK", 680, null, null],
    ["revenue-qualified", "Synthetic revenue qualified", 2, "BOOK", null, null, 10_000_000],
    ["startup-nurture", "Synthetic startup nurture", 3, "SOFT_DQ", null, null, null],
    ["low-credit", "Synthetic low credit", 4, "HARD_DQ", null, 579, null],
  ];
  for (const row of rows) {
    await database.query(
      `insert into public.qualification_rules
        (rule_key, label, position, outcome, min_score, max_score, min_annual_revenue_cents,
         status, version, published_at)
       values ($1, $2, $3, $4::public.outcome, $5, $6, $7, 'draft', 1, null)
       on conflict (rule_key) do update set label = excluded.label, position = excluded.position,
         outcome = excluded.outcome, min_score = excluded.min_score, max_score = excluded.max_score,
         min_annual_revenue_cents = excluded.min_annual_revenue_cents, status = 'draft', published_at = null`,
      row,
    );
  }
}

async function seedBrain(database) {
  const payload = {
    demoSeed: "phase2",
    compiledPlatform: "[SYNTHETIC PLATFORM]\nUse only verified local demo content.",
    platformTokens: 12,
    knowledgeMode: "retrieved",
    sourceHash: createHash("sha256").update("synthetic-phase2-source").digest("hex"),
  };
  let draft = (await database.query(
    "select id, content_hash from public.brain_draft_versions where payload ->> 'demoSeed' = 'phase2' order by created_at limit 1",
  )).rows[0];
  if (!draft) {
    const hash = (await database.query("select app.phase2_json_hash($1::jsonb) hash", [JSON.stringify(payload)])).rows[0].hash;
    const result = await database.query(
      "select public.create_brain_draft_version($1, $2, $3::jsonb) id",
      [PHASE2_DEMO_IDS.admin, hash, JSON.stringify(payload)],
    );
    draft = { id: result.rows[0].id, content_hash: hash };
  }
  let evalRun = (await database.query(
    "select id from public.eval_runs where brain_draft_version_id = $1 and kind = 'checker' order by created_at limit 1",
    [draft.id],
  )).rows[0]?.id;
  if (!evalRun) {
    evalRun = (await database.query(
      "select public.record_eval_run($1, $2, 'checker', null, 'phase2-synthetic-v1', $3::jsonb) id",
      [draft.id, draft.content_hash, JSON.stringify(evalSuites())],
    )).rows[0].id;
  }
  let snapshot = (await database.query(
    "select id, version from public.brain_snapshots where payload ->> 'demoSeed' = 'phase2' order by version limit 1",
  )).rows[0];
  if (!snapshot) {
    snapshot = (await database.query(
      "select snapshot_id id, brain_version version from public.publish_brain_draft($1, $2, $3, $4, $5)",
      [PHASE2_DEMO_IDS.admin, draft.id, draft.content_hash, evalRun, "Seed synthetic Phase 2 demo baseline"],
    )).rows[0];
  }
  return { draft, evalRun, snapshot };
}

async function seedOffers(database) {
  let published = (await database.query(
    "select id, version from public.offer_layers where tenant_id = $1 and status = 'published'",
    [DEMO_IDS.tenant],
  )).rows[0];
  let draft = (await database.query(
    "select id, content_hash from public.offer_layers where tenant_id = $1 and status = 'draft'",
    [DEMO_IDS.tenant],
  )).rows[0];
  if (!published) {
    const payload = offerPayload("published");
    const saved = await database.query(
      "select public.save_offer_draft($1, $2, $3, $4, $5::jsonb) id",
      [DEMO_IDS.tenant, DEMO_IDS.coach, draft?.id ?? null, draft?.content_hash ?? null, JSON.stringify(payload)],
    );
    draft = { id: saved.rows[0].id, content_hash: payload.contentHash };
    published = (await database.query(
      "select offer_id id, offer_version version from public.publish_offer_draft($1, $2, $3, $4)",
      [DEMO_IDS.tenant, DEMO_IDS.coach, draft.id, draft.content_hash],
    )).rows[0];
    draft = null;
  }
  if (!draft) {
    const payload = offerPayload("draft");
    draft = (await database.query(
      "select public.save_offer_draft($1, $2, null, null, $3::jsonb) id",
      [DEMO_IDS.tenant, DEMO_IDS.coach, JSON.stringify(payload)],
    )).rows[0];
  }
  return { published, draft };
}

async function readBackPhase2(database, evalRun) {
  const reviewRows = Number((await database.query(
    "select count(*) count from public.brain_import_items where batch_id = $1",
    [PHASE2_DEMO_IDS.batch],
  )).rows[0].count);
  const flagCodes = Number((await database.query(
    `select count(distinct flag ->> 'code') count
     from public.brain_import_items item, jsonb_array_elements(item.flags) flag
     where item.batch_id = $1`,
    [PHASE2_DEMO_IDS.batch],
  )).rows[0].count);
  const qualification = await database.query(
    "select count(*)::int count, bool_and(status = 'draft') all_draft from public.qualification_rules where rule_key = any($1::text[])",
    [["strong-credit", "low-credit", "startup-nurture", "revenue-qualified"]],
  );
  const evalCases = await database.query(
    "select count(*)::int count, bool_and(passed) all_passed from public.eval_case_results where run_id = $1",
    [evalRun],
  );
  const offerStates = await database.query(
    "select status, count(*)::int count from public.offer_layers where tenant_id = $1 and status in ('draft','published') group by status",
    [DEMO_IDS.tenant],
  );
  const states = Object.fromEntries(offerStates.rows.map((row) => [row.status, row.count]));
  if (reviewRows !== 46 || flagCodes !== FLAG_CODES.length || qualification.rows[0].count !== 4 ||
    qualification.rows[0].all_draft !== true || evalCases.rows[0].count !== 6 ||
    evalCases.rows[0].all_passed !== true || states.draft !== 1 || states.published !== 1) {
    throw new Error("PHASE2_DEMO_READBACK_INVALID");
  }
  return { reviewRows, flagCodes, qualificationRows: qualification.rows[0].count, evalCases: evalCases.rows[0].count };
}

export async function seedPhase2Demo({ argumentsList = process.argv.slice(2) } = {}) {
  const target = resolveDemoTarget(argumentsList);
  console.log(`Demo database target host: ${target.host}`);
  await seedPhase1Demo({ argumentsList, announce: false });
  const client = createDemoClient(target);
  await verifyPhase1Demo(client);
  if (!target.databaseUrl) throw new Error("SUPABASE_DB_PASSWORD_REQUIRED_FOR_HOSTED_PHASE2_SEED");

  const database = new pg.Client({ connectionString: target.databaseUrl });
  await database.connect();
  try {
    await database.query("begin");
    await database.query(
      `insert into public.users (id, email, full_name, role, tenant_id)
       values ($1, 'phase2-admin@example.invalid', 'Synthetic Phase 2 admin', 'admin', null)
       on conflict (id) do update set role = 'admin', tenant_id = null`,
      [PHASE2_DEMO_IDS.admin],
    );
    await seedImports(database);
    await seedQualification(database);
    const brain = await seedBrain(database);
    const offers = await seedOffers(database);
    const readback = await readBackPhase2(database, brain.evalRun);
    await database.query("commit");
    console.log(`Phase 2 seed read-back: review_rows=${readback.reviewRows} flag_codes=${readback.flagCodes} qualification_rows=${readback.qualificationRows}:DRAFT eval_cases=${readback.evalCases}:passed brain=v${brain.snapshot.version} offer_published=v${offers.published.version} offer_draft=present arm=Mock`);
    return { brain, offers, readback };
  } catch (error) {
    await database.query("rollback");
    throw error;
  } finally {
    await database.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedPhase2Demo().catch((error) => {
    console.error(error instanceof Error ? error.message : "PHASE2_DEMO_SEED_FAILED");
    process.exitCode = 1;
  });
}
