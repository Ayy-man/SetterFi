import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A client component may not reach a server-only module through a value import.
 *
 * `@/lib/supabase/server` imports `next/headers`, which exists only on the server. Turbopack
 * traces the import graph of every `"use client"` entry into the browser bundle and refuses the
 * production build with "You're importing a module that depends on next/headers" — but nothing
 * else notices. `tsc` is happy, because the types are real and the boundary is not a type. Vitest
 * is happy, because it renders components in one process where `next/headers` resolves. So this
 * defect ships a green gate and fails only in `next build`, which is how it reached production
 * eight deployments in a row.
 *
 * Types are exempt on purpose rather than by omission: `import type` is erased before bundling,
 * so a client component naming a server module's types creates no runtime edge. That is why the
 * fix for the original violation was to split the two formatters out rather than to sever the
 * import — the types stayed, the functions moved.
 */

const CLIENT_ROOTS = ["src/app", "src/components"] as const;
const MODULE_ROOTS = ["src/app", "src/components", "src/lib"] as const;
const SOURCE_EXTENSIONS = [".ts", ".tsx"] as const;
const TEST_FILE = /(?:^|\/)\w[\w.-]*\.(?:test|spec)\.[^.]+$/;

/** Server-only leaves. Anything importing one of these transitively is server-only too. */
const SERVER_ONLY = ["next/headers", "server-only"] as const;

/** An import statement, split into its clause and its specifier. */
const IMPORT = /import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']|import\s+["']([^"']+)["']/g;

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.isFile()) return [];
    return SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension)) ? [path] : [];
  });
}

/** Resolve a `@/`-aliased specifier to a file on disk, or null for a package or a missing file. */
function resolveAlias(specifier: string): string | null {
  if (!specifier.startsWith("@/")) return null;
  const base = resolve(process.cwd(), "src", specifier.slice(2));
  for (const candidate of [
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

type Edge = { readonly specifier: string; readonly typeOnly: boolean };

function importsOf(path: string): Edge[] {
  const source = readFileSync(path, "utf8");
  return [...source.matchAll(IMPORT)].map((match) => {
    const clause = match[1] ?? "";
    const specifier = match[2] ?? match[3] ?? "";
    // `import type { X }` and `import type X` are erased; `import { type X, y }` is not, because
    // `y` survives. Only a clause that is type-only in whole carries no runtime edge.
    return { specifier, typeOnly: /^type\s/.test(clause.trim()) };
  });
}

/** Does this module reach a server-only leaf through imports that survive to runtime? */
function reachesServerOnly(path: string, seen = new Set<string>()): boolean {
  if (seen.has(path)) return false;
  seen.add(path);
  return importsOf(path).some((edge) => {
    if (edge.typeOnly) return false;
    if (SERVER_ONLY.some((leaf) => edge.specifier === leaf)) return true;
    const next = resolveAlias(edge.specifier);
    return next !== null && reachesServerOnly(next, seen);
  });
}

function violations(path: string): string[] {
  const source = readFileSync(path, "utf8");
  if (!/^\s*(["'])use client\1/m.test(source)) return [];
  return importsOf(path).flatMap((edge) => {
    if (edge.typeOnly) return [];
    const target = resolveAlias(edge.specifier);
    if (target === null || !reachesServerOnly(target)) return [];
    const line = source.slice(0, source.indexOf(edge.specifier)).split("\n").length;
    return [`${relative(process.cwd(), path)}:${line} → ${edge.specifier}`];
  });
}

describe("client/server import boundary", () => {
  it("keeps every server-only module out of every client component's runtime graph", () => {
    const found = CLIENT_ROOTS.flatMap((root) => sourceFiles(resolve(process.cwd(), root)))
      .filter((path) => !TEST_FILE.test(relative(process.cwd(), path)))
      .flatMap(violations);

    expect(
      found,
      `a "use client" file reaches next/headers through a value import at:\n${found.join("\n")}\n` +
        `Move the values it needs into a client-safe module, or make the import \`import type\`.`,
    ).toEqual([]);
  });

  it("can see a violation, so an empty result means something", () => {
    // The scanner is only worth having if it fails on the shape it is meant to catch. This pins
    // the detection itself against the real server module, so a refactor that broke resolution
    // would turn this red instead of quietly making the guard above vacuous.
    const serverClient = resolve(process.cwd(), "src/lib/supabase/server.ts");
    expect(existsSync(serverClient)).toBe(true);
    expect(reachesServerOnly(serverClient)).toBe(true);
  });
});
