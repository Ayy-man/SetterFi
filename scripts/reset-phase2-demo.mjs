/** Guarded reset for mutable synthetic Phase 2 demo rows. Immutable history is retained. */

import { pathToFileURL } from "node:url";

import pg from "pg";

import {
  createDemoClient,
  DEMO_IDS,
  DEMO_VALUES,
  resolveDemoTarget,
} from "./seed-phase1-demo.mjs";
import { PHASE2_DEMO_IDS } from "./seed-phase2-demo.mjs";

const QUALIFICATION_KEYS = ["strong-credit", "low-credit", "startup-nurture", "revenue-qualified"];

async function requireSuccess(label, promise) {
  const result = await promise;
  if (result.error) throw new Error(`${label}:${result.error.message}`);
  return result.data;
}

async function verifyDemoAncestry(client) {
  const tenant = await requireSuccess(
    "PHASE2_RESET_TENANT_READ_FAILED",
    client.from("tenants").select("id, slug, is_demo").eq("id", DEMO_IDS.tenant).maybeSingle(),
  );
  if (!tenant || tenant.id !== DEMO_IDS.tenant || tenant.slug !== DEMO_VALUES.slug || tenant.is_demo !== true) {
    throw new Error("PHASE2_RESET_REFUSED_NOT_PHASE1_DEMO");
  }
}

export async function resetPhase2Demo({ argumentsList = process.argv.slice(2) } = {}) {
  const target = resolveDemoTarget(argumentsList);
  console.log(`Demo database target host: ${target.host}`);
  const client = createDemoClient(target);
  await verifyDemoAncestry(client);
  if (!target.databaseUrl) throw new Error("SUPABASE_DB_PASSWORD_REQUIRED_FOR_HOSTED_PHASE2_RESET");

  const database = new pg.Client({ connectionString: target.databaseUrl });
  await database.connect();
  try {
    await database.query("begin");
    await database.query(
      "delete from public.offer_layers where tenant_id = $1 and status = 'draft'",
      [DEMO_IDS.tenant],
    );
    await database.query(
      "delete from public.brain_knowledge_entries where source = 'mock' and source_ref like 'mock:review:%'",
    );
    await database.query("delete from public.brain_import_batches where id = $1", [PHASE2_DEMO_IDS.batch]);
    await database.query("delete from public.qualification_rules where rule_key = any($1::text[]) and status = 'draft'", [QUALIFICATION_KEYS]);

    const checks = {
      offerDrafts: Number((await database.query(
        "select count(*) count from public.offer_layers where tenant_id = $1 and status = 'draft'",
        [DEMO_IDS.tenant],
      )).rows[0].count),
      importBatches: Number((await database.query(
        "select count(*) count from public.brain_import_batches where id = $1",
        [PHASE2_DEMO_IDS.batch],
      )).rows[0].count),
      importItems: Number((await database.query(
        "select count(*) count from public.brain_import_items where batch_id = $1",
        [PHASE2_DEMO_IDS.batch],
      )).rows[0].count),
      knowledgeDrafts: Number((await database.query(
        "select count(*) count from public.brain_knowledge_entries where source = 'mock' and source_ref like 'mock:review:%'",
      )).rows[0].count),
      qualificationDrafts: Number((await database.query(
        "select count(*) count from public.qualification_rules where rule_key = any($1::text[]) and status = 'draft'",
        [QUALIFICATION_KEYS],
      )).rows[0].count),
    };
    if (Object.values(checks).some((count) => count !== 0)) {
      throw new Error(`PHASE2_RESET_READBACK_NOT_CLEAN:${JSON.stringify(checks)}`);
    }
    await database.query("commit");
    console.log(`Phase 2 reset read-back: ${Object.entries(checks).map(([name, count]) => `${name}=${count}`).join(" ")} immutable_history=retained`);
    return { counts: checks };
  } catch (error) {
    await database.query("rollback");
    throw error;
  } finally {
    await database.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  resetPhase2Demo().catch((error) => {
    console.error(error instanceof Error ? error.message : "PHASE2_DEMO_RESET_FAILED");
    process.exitCode = 1;
  });
}
