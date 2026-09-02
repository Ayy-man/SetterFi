import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Which files render at coach density, found by what they do rather than where they sit.
 *
 * This walk was written for `coach-type-floor.test.ts` and lives here because a second guard needs
 * the same subject. The alternative was a third copy scoped by directory or filename prefix, and
 * that is the mistake this walk exists to avoid: a directory is the folder a file was typed in, not
 * the density it renders at. `OnboardingStage` wraps `CoachScale`, so every onboarding page is a
 * 16px surface with 44px targets and none of it is under `(workspace)/coach`; `/account/security`
 * renders under the coach shell from a fourth workspace group. Selecting on the stamp finds both,
 * and finds the next one nobody remembers to add to a list.
 *
 * Nothing in the application imports this module -- it reads the source tree off disk and is for
 * guards only.
 */

const ROOT = process.cwd();
const SOURCE_EXTENSIONS = [".ts", ".tsx"];

/** Every source file under a directory, recursively. Empty when the directory does not exist. */
export function entryFiles(directory: string): string[] {
  const absolute = resolve(ROOT, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { recursive: true, encoding: "utf8" })
    .map((entry) => resolve(absolute, entry))
    .filter((path) => statSync(path).isFile() && SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext)));
}

/** Every module specifier a file imports, in all three import forms. */
export function importSpecifiers(source: string): string[] {
  return [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ].flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

/** A specifier resolved to a file on disk, or null for a package import. */
export function resolveSpecifier(specifier: string, fromFile: string): string | null {
  const base = specifier.startsWith("@/")
    ? resolve(ROOT, "src", specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(fromFile), specifier)
      : null;
  if (!base) return null;

  for (const candidate of [
    ...SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
    SOURCE_EXTENSIONS.some((ext) => base.endsWith(ext)) ? base : null,
  ]) {
    if (candidate && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Everything reachable by import from every source file under a directory. */
export function reachable(directory: string): Set<string> {
  const seen = new Set<string>();
  const queue = entryFiles(directory);

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || /\.test\.tsx?$/.test(file)) continue;
    seen.add(file);

    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      const resolved = resolveSpecifier(specifier, file);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }

  return seen;
}

/** Every file that puts a subtree at coach density, by the stamp it writes. */
export function densityRoots(): string[] {
  return entryFiles("src")
    .filter((file) => !/\.test\.tsx?$/.test(file))
    .filter((file) => {
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(?<!:)\/\/[^\n]*/g, " ");
      return /role=["']coach["']/.test(source) || /<CoachScale/.test(source)
        || /<OnboardingStage/.test(source);
    });
}

/**
 * Modules a coach-density surface reaches and an admin route does not, repo-relative and sorted.
 *
 * The admin subtraction is what makes a rule enforceable: a module both shells render cannot be
 * held to a coach-only rule, because the console legitimately needs the other behaviour.
 */
export function coachOnlyModules(): string[] {
  const admin = reachable("src/app/(workspace)/admin");
  const seen = new Set<string>();
  const queue = densityRoots();

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || /\.test\.tsx?$/.test(file)) continue;
    seen.add(file);
    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      const resolved = resolveSpecifier(specifier, file);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }

  return [...seen]
    .filter((file) => !admin.has(file))
    .map((file) => relative(ROOT, file))
    .sort();
}
