import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE_ROOTS = ["src/lib", "src/app/api"] as const;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const TEST_FILE = /(?:^|\/)\w[\w.-]*\.(?:test|spec)\.[^.]+$/;
const WILDCARD_SELECT = /\.select\s*\(\s*(["'])\*\1(?:\s*,|\s*\))/g;

const WILDCARD_SELECT_ALLOWLIST: ReadonlySet<string> = new Set([
  // Add a normalized project-relative path only when dynamic field access makes an explicit list wrong.
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")))) return [];
    return [path];
  });
}

function wildcardSelectLocations(path: string): string[] {
  const source = readFileSync(path, "utf8");
  return [...source.matchAll(WILDCARD_SELECT)].map((match) => {
    const line = source.slice(0, match.index).split("\n").length;
    return `${relative(process.cwd(), path)}:${line}`;
  });
}

describe("Supabase explicit-column contract", () => {
  it("reports every production select(*) with its file and line", () => {
    const violations = SOURCE_ROOTS.flatMap((root) => sourceFiles(resolve(process.cwd(), root)))
      .filter((path) => !TEST_FILE.test(relative(process.cwd(), path)))
      .filter((path) => !WILDCARD_SELECT_ALLOWLIST.has(relative(process.cwd(), path)))
      .flatMap(wildcardSelectLocations);

    expect(violations, `select(*) found at:\n${violations.join("\n")}`).toEqual([]);
  });
});
