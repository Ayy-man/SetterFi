/** End-to-end local Phase 8 demo proof. Seeds twice, compares receipts, then resets. */

import { pathToFileURL } from "node:url";

import pg from "pg";

import { resolveDemoTarget } from "./seed-phase1-demo.mjs";
import { resetPhase2Demo } from "./reset-phase2-demo.mjs";
import { resetPhase6Demo } from "./reset-phase6-demo.mjs";
import { resetPhase7Demo } from "./reset-phase7-demo.mjs";
import { resetPhase8Demo } from "./reset-phase8-demo.mjs";
import {
  assertPhase8Demo,
  PHASE8_DEMO_IDS,
  readPhase8Demo,
  seedPhase8Demo,
} from "./seed-phase8-demo.mjs";

function csvCell(value) {
  const text = String(value ?? "");
  const safe = /^[=+@-]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

async function verifyRenderedFormats(argumentsList) {
  const target = resolveDemoTarget(argumentsList);
  const database = new pg.Client({ connectionString: target.databaseUrl });
  await database.connect();
  try {
    const rows = (await database.query(
      `select thread_id::text,author_id::text,body,created_at::text
       from public.coach_support_messages where thread_id=$1 order by created_at,id`,
      [PHASE8_DEMO_IDS.thread],
    )).rows;
    const json = JSON.stringify(rows);
    const csv = ["thread,author,body,createdAt", ...rows.map((row) =>
      [row.thread_id, row.author_id, row.body, row.created_at].map(csvCell).join(","))].join("\n");
    if (rows.length !== 2 || JSON.parse(json).length !== 2 || csv.split("\n").length !== 3) {
      throw new Error("PHASE8_DEMO_EXPORT_FRAMING_FAILED");
    }
    return { csvRows: 2, jsonRows: 2 };
  } finally {
    await database.end();
  }
}

async function resetUpstreamChain(argumentsList) {
  await resetPhase7Demo({ argumentsList });
  await resetPhase6Demo({ argumentsList });
  await resetPhase2Demo({ argumentsList });

  // Phase 2 deliberately retains immutable publish history in its standalone reset. The Phase 8
  // full runner owns the chain it created, so remove only that synthetic marker and its receipts.
  const target = resolveDemoTarget(argumentsList);
  const database = new pg.Client({ connectionString: target.databaseUrl });
  await database.connect();
  try {
    await database.query("begin");
    const tenant = (await database.query(
      "select is_demo from public.tenants where id=$1",
      [PHASE8_DEMO_IDS.tenant],
    )).rows[0];
    if (!tenant?.is_demo) throw new Error("PHASE8_CHAIN_RESET_ANCESTRY_REFUSED");
    const drafts = (await database.query(
      "select id from public.brain_draft_versions where payload->>'demoSeed'='phase2'",
    )).rows.map((row) => row.id);
    const runs = (await database.query(
      "select id from public.eval_runs where brain_draft_version_id=any($1::uuid[])",
      [drafts],
    )).rows.map((row) => row.id);
    await database.query("set local session_replication_role=replica");
    await database.query("delete from public.eval_case_results where run_id=any($1::uuid[])", [runs]);
    await database.query("delete from public.eval_runs where id=any($1::uuid[])", [runs]);
    await database.query(
      `delete from public.audit_log where action='brain.published'
       and actor_id=$1 and reason='Seed synthetic Phase 2 demo baseline'`,
      [PHASE8_DEMO_IDS.admin],
    );
    await database.query("delete from public.brain_snapshots where payload->>'demoSeed'='phase2'");
    await database.query("delete from public.brain_draft_versions where id=any($1::uuid[])", [drafts]);
    await database.query("set local session_replication_role=origin");
    const remaining = (await database.query(
      `select
        (select count(*)::int from public.brain_snapshots where payload->>'demoSeed'='phase2') snapshots,
        (select count(*)::int from public.brain_draft_versions where payload->>'demoSeed'='phase2') drafts,
        (select count(*)::int from public.audit_log where action='brain.published' and actor_id=$1
          and reason='Seed synthetic Phase 2 demo baseline') audits`,
      [PHASE8_DEMO_IDS.admin],
    )).rows[0];
    if (!Object.values(remaining).every((count) => count === 0)) {
      throw new Error(`PHASE8_CHAIN_RESET_INCOMPLETE:${JSON.stringify(remaining)}`);
    }
    await database.query("commit");
    return remaining;
  } catch (error) {
    await database.query("rollback");
    throw error;
  } finally {
    await database.end();
  }
}

export async function runPhase8Demo({ argumentsList = process.argv.slice(2) } = {}) {
  const first = await seedPhase8Demo({ argumentsList, quiet: true });
  const second = await seedPhase8Demo({ argumentsList, quiet: true });
  const firstCounts = JSON.stringify(first.counts);
  const secondCounts = JSON.stringify(second.counts);
  if (firstCounts !== secondCounts) throw new Error("PHASE8_DEMO_REPLAY_CHANGED_COUNTS");

  const target = resolveDemoTarget(argumentsList);
  const database = new pg.Client({ connectionString: target.databaseUrl });
  await database.connect();
  let readback;
  try {
    readback = assertPhase8Demo(await readPhase8Demo(database));
  } finally {
    await database.end();
  }
  const formats = await verifyRenderedFormats(argumentsList);
  const reset = await resetPhase8Demo({ argumentsList, quiet: true });
  const upstreamReset = await resetUpstreamChain(argumentsList);
  console.log(`Phase 8 demo: PASS replay=${secondCounts} csv=${formats.csvRows} json=${formats.jsonRows} support=coach+platform+internal-hidden exports=named+resource+aborted reset=${JSON.stringify(reset)} upstream_reset=${JSON.stringify(upstreamReset)} provider=SKIPPED:mock-only`);
  return { first, second, readback, formats, reset, upstreamReset };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPhase8Demo().catch((error) => {
    console.error(error instanceof Error ? error.message : "PHASE8_DEMO_RUN_FAILED");
    process.exitCode = 1;
  });
}
