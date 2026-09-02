#!/usr/bin/env node
/**
 * Proves the client-facing document set is clean before the repo is exported.
 *
 * The client export drops the internal paths (the planning directory, the internal ledgers under
 * `docs/`, the agent and tooling directories); the exclusion list lives with the export plan, which
 * is itself internal. What remains has to read as a coherent
 * repo with no edits afterwards, which means no shipping document may point at an excluded file,
 * name an internal tool, or carry a path from a developer's machine. This script greps the
 * shipping set for those patterns and exits non-zero on any hit, and it resolves every relative
 * link in the shipping set to a file that exists.
 *
 * Usage: `node scripts/check-handover-docs.mjs` from the repo root. Exit 0 means clean.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = process.cwd();

/** Every document that ships, by path. Directories are walked for `.md` and `.txt` files. */
const SHIPPING = [
  "README.md",
  "docs/ENGINEERING-BRIEF.md",
  "docs/PRODUCT.md",
  "docs/ARCHITECTURE.md",
  "docs/CONTEXT.md",
  "docs/BACKEND-SPEC.md",
  "docs/BRAIN-COMPILER.md",
  "docs/RETRIEVAL-EXPLAINER.md",
  "docs/INTAKE.md",
  "docs/NOTION-MAP.md",
  "docs/SETUP.md",
  "docs/META-APP-REVIEW-PACKAGE.md",
  "docs/LAUNCH-CHECKLIST.md",
  "docs/platform-diagram",
  "docs/operations",
  "docs/CLIENT-QUESTIONS-R2.md",
  "docs/BRAIN-CONTENT-ASK.md",
  "docs/KEYWORD-GOALS-CAPI-ANALYSIS.md",
  "docs/SIMPLIFICATION-SPEC.md",
  "docs/REDESIGN-CANVAS.md",
  "docs/DESIGN.md",
  "scripts/phase1-demo-runbook.md",
  "scripts/phase2-demo-runbook.md",
  "scripts/phase3-demo-runbook.md",
  "scripts/phase4-demo-runbook.md",
  "scripts/phase6-demo-runbook.md",
];

/**
 * Patterns that must not appear in a shipping document. Each names something the export drops or
 * something that only makes sense inside the build team's environment.
 */
const FORBIDDEN = [
  { name: "planning directory", pattern: /\.planning\// },
  { name: "GAPS ledger", pattern: /GAPS\.md/ },
  { name: "CURRENT-STATE (deleted)", pattern: /CURRENT-STATE\.md/ },
  { name: "DECISIONS ledger", pattern: /DECISIONS\.md/ },
  { name: "decision id", pattern: /\bDEC[0-9]+\b/ },
  { name: "DEMO-FEEDBACK ledger", pattern: /DEMO-FEEDBACK\.md/ },
  { name: "ROUND-4 ledger", pattern: /ROUND-4-LEDGER\.md/ },
  { name: "BUILD-PLAN (superseded)", pattern: /BUILD-PLAN\.md/ },
  { name: "audit recheck", pattern: /AUDIT-RECHECK/ },
  { name: "completeness audit", pattern: /PRODUCT-COMPLETENESS-AUDIT/ },
  { name: "export plan (internal)", pattern: /HANDOVER-EXPORT-PLAN\.md/ },
  { name: "deleted design doc", pattern: /DESIGN-SYSTEM\.md|DESIGN-EXPRESSIVE\.md|REDESIGN-PLAN\.md|DISTINCT-DIRECTION\.md/ },
  { name: "merged runbook (deleted)", pattern: /DEV-ONBOARDING\.md|GHL-MARKETPLACE-SETUP\.md|GHL-INSTALL-ON-CALL\.md|WHATSAPP-SETUP-RUNBOOK\.md|DM-ADS-CAPI\.md/ },
  { name: "old handover path", pattern: /docs\/handover\// },
  { name: "GSD command", pattern: /\/gsd-/ },
  { name: "GSD tool name", pattern: /get-shit-done/ },
  { name: "home-relative path", pattern: /~\/DEV/ },
  { name: "absolute user path", pattern: /\/Users\// },
  { name: "Vercel deployment id", pattern: /\bdpl_[A-Za-z0-9]+/ },
  { name: "preview deployment URL (team slug)", pattern: /[a-z0-9]+-[a-z0-9-]+-projects-[a-z0-9]{8}\.vercel\.app/ },
  { name: "hosted Supabase project ref", pattern: /\b[a-z]{20}\.supabase\.co\b/ },
  { name: "CLAUDE.md (excluded from the export)", pattern: /\bCLAUDE\.md/ },
];

/**
 * `MANIFEST.md` is the generated receipt inside `docs/operations/`. It ships, because `/admin/help`
 * reads it at runtime, so a reference to it from inside that package is a reference to a file that
 * exists. Anywhere else it is a stale pointer to the old package layout.
 */
const MANIFEST = { name: "MANIFEST outside the operations package", pattern: /MANIFEST\.md/ };

function walk(path) {
  const full = resolve(ROOT, path);
  if (!existsSync(full)) return [{ path, missing: true }];
  if (statSync(full).isFile()) return [{ path }];
  return readdirSync(full)
    .filter((name) => /\.(md|txt)$/u.test(name))
    .sort()
    .map((name) => ({ path: join(path, name) }));
}

const LINK = /\[[^\]]*\]\(([^)\s]+)\)/gu;

function checkLinks(path, text) {
  const failures = [];
  for (const match of text.matchAll(LINK)) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/u.test(target)) continue;
    const [file] = target.split("#");
    if (!file) continue;
    const resolved = resolve(ROOT, dirname(path), file);
    if (!existsSync(resolved)) {
      const line = text.slice(0, match.index).split("\n").length;
      failures.push(`${path}:${line}: link to missing file ${target}`);
    }
  }
  return failures;
}

function main() {
  const files = SHIPPING.flatMap(walk);
  const failures = [];
  let scanned = 0;
  for (const file of files) {
    if (file.missing) {
      failures.push(`${file.path}: shipping document does not exist`);
      continue;
    }
    scanned += 1;
    const text = readFileSync(resolve(ROOT, file.path), "utf8");
    const lines = text.split("\n");
    const rules = file.path.startsWith("docs/operations/") ? FORBIDDEN : [...FORBIDDEN, MANIFEST];
    lines.forEach((line, index) => {
      for (const rule of rules) {
        if (rule.pattern.test(line)) {
          failures.push(`${file.path}:${index + 1}: ${rule.name}: ${line.trim().slice(0, 120)}`);
        }
      }
    });
    failures.push(...checkLinks(file.path, text));
  }
  console.log(`check-handover-docs: scanned ${scanned} shipping documents`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    console.error(`check-handover-docs: ${failures.length} problem(s)`);
    process.exit(1);
  }
  console.log("check-handover-docs: clean");
}

main();
