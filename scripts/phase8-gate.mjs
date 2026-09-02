/** Goal-backward Phase 8 gate. Human-only evidence remains a blocking verdict. */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import pg from "pg";

const ROOT = process.cwd();
const criteria = Object.freeze([
  ["Support isolation/reassignment", [
    "supabase/tests/phase8-rls.test.ts",
    "src/lib/support/service.test.ts",
    "src/components/workspace/live/support-view-models.test.ts",
    "src/lib/notifications/phase8-vertical-slice.test.ts",
  ]],
  ["Registry/destinations/attempts", [
    "supabase/tests/phase8-schema.test.ts",
    "src/lib/notifications/source-contract.test.ts",
    "src/lib/notifications/resolver.test.ts",
    "src/lib/notifications/delivery.test.ts",
    "src/components/workspace/live/notification-view-models.test.ts",
  ]],
  ["Rendered exports/scoping/audits", [
    "src/lib/exports/rendered-tables.test.ts",
    "src/app/api/exports/routes.test.ts",
    "supabase/tests/phase8-rls.test.ts",
  ]],
  ["Handover usability/generation", ["src/lib/handover/generator.test.ts"]],
]);

function run(command, args) {
  console.log(`GATE step: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`PHASE8_GATE_STEP_FAILED:${command}:${result.status}`);
}

function requireFiles() {
  for (const [name, files] of criteria) {
    console.log(`${name} -> ${files.join(", ")}`);
    for (const file of files) if (!existsSync(resolve(ROOT, file))) {
      throw new Error(`PHASE8_CRITERION_TEST_MISSING:${name}:${file}`);
    }
  }
  for (const [file, code] of [
    ["scripts/seed-phase5-demo.mjs", "PHASE5_DEMO_SEED_MISSING"],
    ["scripts/seed-phase6-demo.mjs", "PHASE6_DEMO_SEED_MISSING"],
    ["scripts/seed-phase7-demo.mjs", "PHASE7_DEMO_SEED_MISSING"],
  ]) if (!existsSync(resolve(ROOT, file))) throw new Error(code);
}

function requireFinishedRoutes() {
  const retired = [
    "src/app/(workspace)/[role]/[[...screen]]/page.tsx",
    "src/lib/workspace-fixtures.ts",
    "src/components/workspace/workspace-screens.tsx",
    "src/components/workspace/fixture-workspace-shell.tsx",
  ];
  for (const file of retired) if (existsSync(resolve(ROOT, file))) {
    throw new Error(`PHASE8_FIXTURE_OWNER_REMAINS:${file}`);
  }
  const scan = spawnSync("rg", ["-l", "from\\s+['\"][^'\"]*(workspace-fixtures|workspace-screens|fixture-workspace-shell)", "src"], {
    cwd: ROOT, encoding: "utf8",
  });
  if (scan.error) throw scan.error;
  if (scan.status !== 0 && scan.status !== 1) throw new Error(`PHASE8_FIXTURE_SCAN_FAILED:${scan.status}`);
  const output = scan.stdout.trim();
  if (output) throw new Error(`PHASE8_FIXTURE_IMPORT_REMAINS:${output.replaceAll("\n", ",")}`);
}

function manifestMetadata() {
  const manifest = readFileSync(resolve(ROOT, "docs/operations/MANIFEST.md"), "utf8");
  const generatedAt = manifest.match(/^Generated at: `([^`]+)`$/mu)?.[1];
  const sourceCommit = manifest.match(/^Source commit: `([^`]+)`$/mu)?.[1];
  if (!generatedAt || !sourceCommit) throw new Error("HANDOVER_MANIFEST_METADATA_MISSING");
  return { generatedAt, sourceCommit };
}

async function handoverBlockers() {
  const costs = readFileSync(resolve(ROOT, "docs/operations/running-costs.md"), "utf8");
  const recordingOne = readFileSync(resolve(ROOT, "docs/operations/recording-01-diagnose.md"), "utf8");
  const recordingTwo = readFileSync(resolve(ROOT, "docs/operations/recording-02-brain-publish-rollback.md"), "utf8");
  const database = new pg.Client({
    connectionString: process.env.RLS_TEST_DB_URL
      || "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  });
  await database.connect();
  let unapprovedAlertCopy;
  try {
    unapprovedAlertCopy = Number((await database.query(
      `select count(*)::int count from public.alert_rules where
        email_subject is null or email_body is null or slack_text is null
        or email_subject like 'SETTERFI_DEMO_PLACEHOLDER_%'
        or email_body like 'SETTERFI_DEMO_PLACEHOLDER_%'
        or slack_text like 'SETTERFI_DEMO_PLACEHOLDER_%'`,
    )).rows[0].count);
  } finally {
    await database.end();
  }
  return [
    recordingOne.includes("Recording required") ? "actual walkthrough recording 1" : null,
    recordingTwo.includes("Recording required") ? "actual walkthrough recording 2" : null,
    costs.includes("Input required") ? "required cost inputs" : null,
    unapprovedAlertCopy > 0 ? "approved alert copy" : null,
  ].filter(Boolean);
}

async function main() {
  requireFiles();
  requireFinishedRoutes();
  run("npm", ["test", "--", "src/components/workspace/live/fixture-retirement.test.ts",
    "src/lib/notifications/source-contract.test.ts", "src/app/api/exports/routes.test.ts"]);
  console.log("Evidence lane local-source: PASS route-ownership, fixture-retirement, emitter exact-set, Phase 7 arms, Phase 8 flag-off");

  run("npm", ["run", "demo:env-check"]);
  run("npm", ["run", "db:migrate"]);
  const metadata = manifestMetadata();
  run("npm", ["run", "generate:handover", "--", "--generated-at", metadata.generatedAt,
    "--source-commit", metadata.sourceCommit]);
  run("git", ["diff", "--exit-code", "--", "docs/operations"]);
  console.log("Evidence lane local-DB: PASS migration no-op required, handover regeneration deterministic");

  run("npm", ["run", "test:rls"]);
  run("npm", ["run", "verify"]);
  run("npm", ["run", "build"]);
  console.log("Evidence lane local-build: PASS RLS, typecheck, lint, unit tests, production build");
  console.log("Evidence lane provider: SKIPPED — real credentials and provider receipts are absent by design");
  console.log("Evidence lane deployment: SKIPPED — no deployment or cron execution was performed");

  const blockers = await handoverBlockers();
  console.log(`Evidence lane recordings: ${blockers.some((value) => value.startsWith("actual walkthrough")) ? "BLOCKED — actual walkthroughs are absent" : "PASS"}`);
  console.log(`Evidence lane copy: ${blockers.includes("approved alert copy") ? "BLOCKED — alert copy remains unapproved" : "PASS"}`);
  console.log(`Evidence lane cost-inputs: ${blockers.includes("required cost inputs") ? "BLOCKED — required owner inputs are absent" : "PASS"}`);
  if (blockers.length > 0) {
    throw new Error(`PHASE8_CRITERION_4_BLOCKED:${blockers.join("|")}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "PHASE8_GATE_FAILED");
  process.exitCode = 1;
});
