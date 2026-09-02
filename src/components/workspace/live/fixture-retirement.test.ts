import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { workspaceNavigation } from "@/lib/workspace-navigation";
import nextConfig from "../../../../next.config";

const ROOT = process.cwd();
const SOURCE_ROOT = resolve(ROOT, "src");
const WORKSPACE_ROOT = resolve(ROOT, "src/app/(workspace)");
const CATCH_ALL = "src/app/(workspace)/[role]/[[...screen]]/page.tsx";
const WORKSPACE_FIXTURES = `src/lib/workspace-${"fixtures"}.ts`;

const RETIRED_FILES = [
  CATCH_ALL,
  WORKSPACE_FIXTURES,
  "src/components/workspace/workspace-screens.tsx",
  "src/components/workspace/fixture-workspace-shell.tsx",
  "src/components/workspace/admin-client-heartbeats.tsx",
  "src/components/workspace/affiliate-dashboard.tsx",
] as const;

const FIXTURE_MODULES = [
  WORKSPACE_FIXTURES,
  "src/components/workspace/workspace-screens.tsx",
  "src/components/workspace/fixture-workspace-shell.tsx",
] as const;

const REQUIRED_PHASE8_PATHS = [
  "/coach/help",
  "/admin/support",
  "/admin/inbox",
  "/admin/platform-clients",
  "/admin/audit",
  "/admin/alerts",
  "/admin/settings",
  "/coach/settings",
  "/admin/help",
  "/admin/system",
] as const;

function relativePath(file: string) {
  return relative(ROOT, file).replaceAll("\\", "/");
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = resolve(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

function routeForPage(file: string) {
  const filePath = relative(WORKSPACE_ROOT, file).replaceAll("\\", "/");
  if (!filePath.endsWith("/page.tsx") && filePath !== "page.tsx") return null;
  const parts = filePath === "page.tsx" ? [] : filePath.slice(0, -"/page.tsx".length).split("/");
  if (parts.some((part) => part.startsWith("[") || part.startsWith("("))) return null;
  return `/${parts.join("/")}`.replace(/\/$/u, "") || "/";
}

function staticPageOwners() {
  const owners = new Map<string, string[]>();
  for (const file of filesUnder(WORKSPACE_ROOT).filter((candidate) => candidate.endsWith("/page.tsx"))) {
    const route = routeForPage(file);
    if (!route) continue;
    owners.set(route, [...(owners.get(route) ?? []), relativePath(file)]);
  }
  return owners;
}

async function configuredRedirects() {
  return await nextConfig.redirects?.() ?? [];
}

async function finalRouteOwners() {
  const owners = staticPageOwners();
  for (const redirect of await configuredRedirects()) {
    owners.set(redirect.source, ["next.config.ts"]);
  }
  return owners;
}

function finalNavigationTargets() {
  const targets = new Set<string>(REQUIRED_PHASE8_PATHS);
  for (const groups of Object.values(workspaceNavigation)) {
    for (const item of groups.flatMap((group) => group.items)) {
      targets.add(item.href);
      for (const matchPath of item.matchPaths ?? []) targets.add(matchPath);
    }
  }
  return [...targets].sort();
}

async function ownershipProblems() {
  const owners = await finalRouteOwners();
  return finalNavigationTargets().flatMap((route) => {
    const routeOwners = owners.get(route) ?? [];
    return routeOwners.length === 1 ? [] : [{ route, owners: routeOwners }];
  });
}

function importSpecifiers(text: string) {
  const specifiers = new Set<string>();
  for (const pattern of [
    /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ]) {
    for (const match of text.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers];
}

function importedModule(importer: string, specifier: string) {
  if (specifier.startsWith("@/")) return resolve(SOURCE_ROOT, specifier.slice(2));
  if (specifier.startsWith(".")) return resolve(dirname(importer), specifier);
  return null;
}

function withoutTypeScriptExtension(file: string) {
  return [".ts", ".tsx"].includes(extname(file)) ? file.slice(0, -extname(file).length) : file;
}

function fixtureImporters(root: string) {
  const targets = new Set(FIXTURE_MODULES.map((file) => withoutTypeScriptExtension(resolve(ROOT, file))));
  return filesUnder(root).filter((file) => /\.tsx?$/u.test(file)).flatMap((file) => {
    const importsFixture = importSpecifiers(readFileSync(file, "utf8")).some((specifier) => {
      const imported = importedModule(file, specifier);
      return imported ? targets.has(withoutTypeScriptExtension(imported)) : false;
    });
    return importsFixture ? [relativePath(file)] : [];
  }).sort();
}

describe("final workspace route ownership audit", () => {
  it("derives every href and matchPath and includes all ten Phase 8 paths", () => {
    const targets = finalNavigationTargets();
    for (const path of REQUIRED_PHASE8_PATHS) expect(targets, path).toContain(path);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("gives every final navigation target exactly one page or redirect owner", async () => {
    expect(await ownershipProblems()).toEqual([]);
  });

  it("gives every Phase 8 path one dedicated page or explicit redirect owner", async () => {
    const owners = await finalRouteOwners();
    const redirects = await configuredRedirects();
    for (const path of REQUIRED_PHASE8_PATHS) {
      expect(owners.get(path), path).toHaveLength(1);
      if (path === "/admin/inbox") {
        expect(redirects).toContainEqual(expect.objectContaining({
          source: "/admin/inbox",
          destination: "/admin/support",
          permanent: false,
        }));
        expect(owners.get("/admin/support")).toHaveLength(1);
      }
    }
  });
});

describe("fixture retirement contract", () => {
  it("has no source importer of a retired fixture module", () => {
    expect(fixtureImporters(SOURCE_ROOT)).toEqual([]);
  });

  it("removes all fixture owners and their two dead consumers", () => {
    for (const file of RETIRED_FILES) expect(existsSync(resolve(ROOT, file)), file).toBe(false);
  });

  it("contains no production reference to a retired dispatcher identifier", () => {
    const forbidden = [
      ["Workspace", "Screen"].join(""),
      ["Fixture", "Workspace", "Shell"].join(""),
      ["workspace", "fixtures"].join("-"),
      ["generate", "Static", "Params"].join(""),
    ];
    const references = filesUnder(SOURCE_ROOT)
      .filter((file) => /\.tsx?$/u.test(file) && !/\.test\.tsx?$/u.test(file))
      .flatMap((file) => forbidden.some((identifier) => readFileSync(file, "utf8").includes(identifier))
        ? [relativePath(file)]
        : []);
    expect(references).toEqual([]);
  });
});
