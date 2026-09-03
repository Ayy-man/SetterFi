// @vitest-environment node

/**
 * A server file must not import a runtime value out of a `"use client"` module.
 *
 * This is the one class of defect in the tree that every other gate is blind to. Next replaces
 * every export of a `"use client"` module with a client *reference* when a server module imports
 * it, so a frozen array arrives as something with no `.find`, and a plain function arrives as
 * something that cannot be called. Nothing says so at author time: `tsc` reports the declared
 * type, because the declared type is what the module really exports and the substitution happens
 * in the bundler; and Vitest loads both files into one plain module graph where `"use client"` is
 * an inert string at the top of a file, so a render test exercises the real array and passes. The
 * failure appears only in a Next runtime, on the deployed page, as a 500.
 *
 * Two shipped to production together on 2026-09-03 and took two console tabs down:
 *
 *   - `admin/billing/page.tsx` called `OWNER_MONEY_TABS.find(...)`, imported from the `"use
 *     client"` `owner-money.tsx`. Production threw `TypeError: OWNER_MONEY_TABS.find is not a
 *     function`.
 *   - `admin/brain/page.tsx` called `ownerBrainTab(...)`, imported from the `"use client"`
 *     `owner-brain.tsx`. Production threw "Attempted to call ownerBrainTab() from the server but
 *     ownerBrainTab is on the client".
 *
 * Both were fixed by moving the identity into `src/lib/console-tabs.ts`, a module with no
 * directive, which both sides import. That is the shape to reach for: when a server page and a
 * client screen need the same constant, the constant belongs to neither of them.
 *
 * **What this file checks and what it does not.** It reads every file under `src/app` that does
 * not itself carry the directive -- pages, layouts, route handlers, the server half of the tree --
 * resolves each `@/`-aliased named import to a file, and fails when the source carries `"use
 * client"` and the imported name is not a type-only import and not a React component. A component
 * is the legitimate case and the overwhelmingly common one: a server page rendering `<OwnerMoney
 * />` is exactly how the boundary is meant to be crossed. PascalCase is the signal, which is a
 * convention rather than a proof -- a PascalCase export that is not a component would slip
 * through, and a component named in camelCase would be reported here. Both are worth the trade.
 *
 * It does not follow re-exports: a directive-free barrel that re-exports a client module's value
 * launders it past this check, and there is no cheap way to see through one. It also says nothing
 * about the third member of this family, which is a *function passed as a prop* into a client
 * component -- `admin/system/page.tsx` did that with the nav's `liveWhen` predicates on the same
 * day, and the rule for it lives in the `AppShellProps` doc comment rather than in a scan, because
 * whether a given prop crosses the boundary is a question about the value, not about the import.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const APP = join(SRC, "app");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    // Test files sitting under src/app are not part of the server graph: Vitest loads them in one
    // plain module graph where the boundary does not exist, so importing a client value there is
    // exactly how those modules are meant to be tested.
    if (/\.test\.tsx?$/.test(full)) return [];
    return full.endsWith(".ts") || full.endsWith(".tsx") ? [full] : [];
  });
}

function hasUseClient(source: string) {
  return /^\s*["']use client["']/.test(source);
}

/** Resolve an `@/x/y` specifier to the file it loads, or null when it is not in this tree. */
function resolveAlias(specifier: string): string | null {
  if (!specifier.startsWith("@/")) return null;
  const base = join(SRC, specifier.slice(2));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not this extension; try the next.
    }
  }
  return null;
}

/** A component by convention: PascalCase. Everything else is a value the server would evaluate. */
function isComponentName(name: string) {
  return /^[A-Z][a-z]/.test(name);
}

type Offence = { file: string; name: string; from: string };

function offencesIn(file: string): Offence[] {
  const source = readFileSync(file, "utf8");
  if (hasUseClient(source)) return [];
  const found: Offence[] = [];
  const importRe = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(importRe)) {
    const [, typeOnly, clause, specifier] = match;
    if (typeOnly) continue;
    const target = resolveAlias(specifier);
    if (!target) continue;
    if (!hasUseClient(readFileSync(target, "utf8"))) continue;
    for (const raw of clause.split(",")) {
      const entry = raw.trim();
      if (!entry || entry.startsWith("type ")) continue;
      const name = entry.split(/\s+as\s+/)[0].trim();
      if (!name || isComponentName(name)) continue;
      found.push({ file: file.slice(SRC.length + 1), name, from: specifier });
    }
  }
  return found;
}

describe("the server half of src/app", () => {
  it("imports no runtime value out of a \"use client\" module", () => {
    const offences = walk(APP).flatMap(offencesIn);
    expect(
      offences.map((o) => `${o.file} imports \`${o.name}\` from the client module ${o.from}`),
    ).toEqual([]);
  });
});
