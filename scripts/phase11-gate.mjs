/** Phase 11 completion gate. Run this before declaring a Phase 11 task done. */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import ts from "typescript";

const ROOT = process.cwd();
const SOURCE_SCRIPT_KINDS = new Map([
  [".js", ts.ScriptKind.JS],
  [".jsx", ts.ScriptKind.JSX],
  [".ts", ts.ScriptKind.TS],
  [".tsx", ts.ScriptKind.TSX],
]);

function fail(code, detail) {
  throw new Error(detail ? `${code}:${detail}` : code);
}

function runStage(name, args, failureCode) {
  console.log(`GATE step: ${name}`);
  const result = spawnSync("npm", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.error) fail(failureCode, result.error.message);
  if (result.status !== 0) fail(failureCode);
}

function rgMatches(args, failureCode) {
  const result = spawnSync("rg", args, {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.error) fail(failureCode, result.error.message);
  if (result.status !== 0 && result.status !== 1) fail(failureCode, `rg:${result.status}`);
  return result.status === 0 ? result.stdout.trimEnd().split("\n") : [];
}

function scriptKind(file) {
  const extension = [...SOURCE_SCRIPT_KINDS.keys()].find((candidate) => file.endsWith(candidate));
  return extension ? SOURCE_SCRIPT_KINDS.get(extension) : undefined;
}

function isCopyNode(node) {
  return ts.isStringLiteral(node)
    || ts.isNoSubstitutionTemplateLiteral(node)
    || ts.isTemplateHead(node)
    || ts.isTemplateMiddle(node)
    || ts.isTemplateTail(node)
    || ts.isJsxText(node);
}

function firstCopyMatch(files, pattern) {
  for (const file of files) {
    const kind = scriptKind(file);
    if (kind === undefined) continue;

    const source = readFileSync(resolve(ROOT, file), "utf8");
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
    let match = null;

    function visit(node) {
      if (match) return;
      if (isCopyNode(node)) {
        const nodeSource = source.slice(node.getStart(sourceFile), node.getEnd());
        const offset = nodeSource.search(pattern);
        if (offset !== -1) {
          const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile) + offset);
          match = { file, line: position.line + 1 };
          return;
        }
      }
      ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    if (match) return match;
  }

  return null;
}

function requireHonestStates() {
  const files = rgMatches([
    "-l",
    "Still filling|Action refused|, cents",
    "src/",
    "--glob",
    "!src/lib/audit/actions.ts",
    // Tests list the banned vocabulary on purpose; only shipped copy is in scope.
    "--glob",
    "!**/*.test.*",
  ], "PHASE11_HONEST_STATES_FAILED");
  const firstMatch = firstCopyMatch(files, /Still filling|Action refused|, cents/u);

  if (firstMatch) fail("PHASE11_HONEST_STATES_FAILED", `${firstMatch.file}:${firstMatch.line}`);
}

function requireNoEmDashCopy() {
  const files = rgMatches([
    "-l",
    "\\x{2014}",
    "src/",
    "--glob",
    "!**/*.test.*",
  ], "PHASE11_EMDASH_FAILED");
  const firstMatch = firstCopyMatch(files, /\u2014/u);

  if (firstMatch) fail("PHASE11_EMDASH_FAILED", `${firstMatch.file}:${firstMatch.line}`);
}

function requireSourceCopy() {
  console.log("GATE step: source copy");
  requireHonestStates();
  requireNoEmDashCopy();
}

function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: node scripts/phase11-gate.mjs");
    return;
  }

  runStage("typecheck", ["run", "typecheck"], "PHASE11_TYPECHECK_FAILED");
  runStage("lint", ["run", "lint"], "PHASE11_LINT_FAILED");
  runStage("unit tests", ["run", "test"], "PHASE11_UNIT_FAILED");
  runStage("component tests", ["run", "test:ui"], "PHASE11_COMPONENT_FAILED");
  runStage("end-to-end tests", ["run", "e2e"], "PHASE11_E2E_FAILED");
  requireSourceCopy();
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "PHASE11_GATE_FAILED");
  process.exitCode = 1;
}
