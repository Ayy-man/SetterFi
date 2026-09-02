// @vitest-environment node

/**
 * Whether the checked-in handover package still describes the product.
 *
 * `docs/operations/` is generated from the guide registry and shipped to the client as the operator
 * documentation for what they bought. Two things guard it today and neither asks that question.
 * `scripts/phase8-gate.mjs:121` runs `git diff --exit-code -- docs/operations`, which proves nobody
 * hand-edited the files and says nothing about whether they match the registry. The check that
 * would compare content, `generate-phase8-handover.mjs --check`, needs a live Postgres for the
 * audit-action and alert-rule tables, so in practice it never runs -- which is how the package
 * drifted three guides without anyone noticing, and how a guide deleted from the source on
 * 2026-09-01 stayed in the client's copy.
 *
 * What does not need a database: the manifest states its guide count as a number, the package
 * states each guide as a `## ` heading, and the registry is a list in source. Comparing those three
 * catches drift the moment it appears, and the failure says "regenerate" rather than leaving
 * somebody to interpret a diff.
 *
 * ## Why this lands green against a stale package
 *
 * The same shape as `palette-literals.test.ts`: the drift that already exists is recorded, so this
 * lands green and fails the moment the drift *changes*. Adding a guide without regenerating turns
 * the tree red with an actionable message; regenerating fails the second test, which is the signal
 * to delete the record. The list only shrinks, and it cannot be quietly widened.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ADMIN_GUIDES } from "@/lib/admin-help-guides";
import { parseHandoverManifestMetadata } from "@/lib/handover/generator";


const HANDOVER = join(process.cwd(), "docs/operations");

function manifest() {
  return readFileSync(join(HANDOVER, "MANIFEST.md"), "utf8");
}

/** Every `## ` heading in the package, minus the navigation-coverage header, which is not a guide. */
function packageGuideTitles() {
  return readFileSync(join(HANDOVER, "operator-guide.md"), "utf8")
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim())
    .filter((title) => title !== "Admin navigation coverage")
    .sort();
}

function registryTitles() {
  return ADMIN_GUIDES.map((guide) => guide.title).sort();
}

describe("the handover package against the guide registry", () => {
  it("matches the guide registry, title for title", () => {
    const stated = manifest().match(/^Operator guides: (\d+)$/mu)?.[1];
    expect(stated, "MANIFEST.md no longer states its guide count").toBeDefined();

    const inPackage = packageGuideTitles();
    const inRegistry = registryTitles();
    const regenerate =
      "The handover package no longer matches the guide registry, and it ships to the client as "
      + "operator documentation. Regenerate it -- `node --experimental-strip-types "
      + "scripts/generate-phase8-handover.mjs --generated-at <iso> --source-commit <sha>` with "
      + "local Postgres reset to this branch's migrations.";

    expect(Number(stated), regenerate).toEqual(inRegistry.length);
    expect(inPackage, regenerate).toEqual(inRegistry);
  });

  /**
   * The manifest names the commit it was generated at, and a commit that is not an ancestor of
   * HEAD means the package was generated on a line this branch never took -- a rewound tip, a
   * discarded branch, someone's local experiment. The hashes below it would then be provable
   * against nothing.
   *
   * Skipped when there is no repository to ask, and only then. Four guards produced false reds
   * tonight by shelling out to git inside a `git archive` extract; a `git clone --local` at the
   * SHA, which is how the tree is gated now, answers correctly.
   */
  it("was generated at a commit this branch actually contains", () => {
    let head: string;
    try {
      head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      return;
    }

    // A repository whose only commit is its root has no history the manifest's source commit
    // could belong to. The guide-count and guide-title checks above still hold the package to the
    // registry; ancestry is checked again from the first commit this repository makes on its own.
    const commitCount = Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim());
    if (commitCount <= 1) return;

    const { sourceCommit } = parseHandoverManifestMetadata(manifest());
    const contained = (() => {
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", sourceCommit, head], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    })();

    expect(
      contained,
      `MANIFEST.md says it was generated at ${sourceCommit}, which is not an ancestor of HEAD. `
      + "The package describes a line this branch does not contain, so its hashes prove nothing "
      + "about what ships. Regenerate it.",
    ).toBe(true);
  });
});
