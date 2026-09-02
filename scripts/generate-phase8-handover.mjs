/** Deterministic Phase 8 handover caller. Registry values enter; environment values never do. */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import pg from "pg";

import {
  ADMIN_GUIDES,
  ADMIN_GUIDE_NAV_MAP,
} from "../src/lib/admin-help-guides.ts";
import {
  HANDOVER_CONTENT_FILES,
  generatePhase8Handover,
  handoverDrift,
  parseHandoverManifestMetadata,
} from "../src/lib/handover/generator.ts";

const ROOT = process.cwd();
const OUTPUT_DIR = resolve(ROOT, "docs/operations");
const SOURCES_FILE = resolve(ROOT, "scripts/phase8-handover-sources.json");
const DEFAULT_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function metadata(argv) {
  if (argv.includes("--check")) {
    const manifest = await readFile(resolve(OUTPUT_DIR, "MANIFEST.md"), "utf8");
    return { ...parseHandoverManifestMetadata(manifest), check: true };
  }
  const generatedAt = argument(argv, "--generated-at");
  const sourceCommit = argument(argv, "--source-commit");
  if (!generatedAt || !sourceCommit) {
    throw new Error("HANDOVER_METADATA_REQUIRED:--generated-at:--source-commit");
  }
  return { generatedAt, sourceCommit, check: false };
}

function pgTextArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || value === "{}") return [];
  return value.slice(1, -1).split(",").map((entry) => entry.replace(/^"|"$/gu, ""));
}

async function registryRows() {
  const client = new pg.Client({
    connectionString: process.env.RLS_TEST_DB_URL || DEFAULT_DB_URL,
  });
  await client.connect();
  try {
    const [audit, alerts] = await Promise.all([
      client.query(`
        select key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label
        from public.audit_actions
        order by key asc
      `),
      client.query(`
        select event_key, scope, name, category, audience_roles, include_success_owner,
               include_billing_contact, default_destinations, suppressible, default_enabled
        from public.alert_rules
        order by event_key asc, scope asc
      `),
    ]);
    return {
      auditActions: audit.rows.map((row) => ({
        key: row.key,
        actorKind: row.actor_kind,
        scope: row.scope,
        reasonRequired: row.reason_required,
        coachVisible: row.coach_visible,
        microcopy: row.microcopy,
        ariaLabel: row.aria_label,
      })),
      alertRules: alerts.rows.map((row) => ({
        eventKey: row.event_key,
        scope: row.scope,
        name: row.name,
        category: row.category,
        audienceRoles: pgTextArray(row.audience_roles),
        includeSuccessOwner: row.include_success_owner,
        includeBillingContact: row.include_billing_contact,
        defaultDestinations: pgTextArray(row.default_destinations),
        suppressible: row.suppressible,
        defaultEnabled: row.default_enabled,
      })),
    };
  } finally {
    await client.end();
  }
}

async function existingFiles() {
  return Object.fromEntries(await Promise.all(
    [...HANDOVER_CONTENT_FILES, "MANIFEST.md"].map(async (file) => [
      file,
      await readFile(resolve(OUTPUT_DIR, file), "utf8"),
    ]),
  ));
}

export async function generatePhase8HandoverCli(argv = process.argv.slice(2)) {
  const sourceMetadata = await metadata(argv);
  const sources = JSON.parse(await readFile(SOURCES_FILE, "utf8"));
  const registries = await registryRows();
  const generated = generatePhase8Handover({
    generatedAt: sourceMetadata.generatedAt,
    sourceCommit: sourceMetadata.sourceCommit,
    guides: ADMIN_GUIDES,
    guideNavMap: ADMIN_GUIDE_NAV_MAP,
    ...registries,
    sources,
  });

  if (sourceMetadata.check) {
    const drift = handoverDrift(await existingFiles(), generated);
    if (drift.length > 0) throw new Error(`HANDOVER_DRIFT:${drift.join(",")}`);
  } else {
    await mkdir(OUTPUT_DIR, { recursive: true });
    await Promise.all(Object.entries(generated.files).map(([file, content]) =>
      writeFile(resolve(OUTPUT_DIR, file), content, "utf8")
    ));
  }

  process.stdout.write(`${JSON.stringify({
    alertRules: registries.alertRules.length,
    auditActions: registries.auditActions.length,
    checked: sourceMetadata.check,
    files: Object.keys(generated.files).length,
    guides: ADMIN_GUIDES.length,
  })}\n`);
  return generated;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generatePhase8HandoverCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "HANDOVER_GENERATION_FAILED"}\n`);
    process.exitCode = 1;
  });
}
