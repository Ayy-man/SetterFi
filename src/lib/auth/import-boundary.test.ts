import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

type RouteImport = {
  file: string;
  module: string;
};

// W3-DELETE-PRIMS must sweep the six remaining non-actor page imports:
// src/app/signup/page.tsx
// src/app/opt-in/[tenantSlug]/page.tsx
// src/app/opt-in/[tenantSlug]/terms/page.tsx
// src/app/opt-in/[tenantSlug]/privacy/page.tsx
// src/app/(workspace)/admin/corrections/page.tsx
// src/app/(workspace)/admin/provisioning/page.tsx
const ACTOR_ROUTE_MODULES = [
  "@/app/api/conversations/[id]/claim/route",
  "@/app/api/notifications/handler",
  "@/app/api/platform/impersonation/start/route",
] as const;

function routeModuleName(node: ts.Node): string | null {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isExportDeclaration(node) &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0])
  ) {
    return node.arguments[0].text;
  }
  return null;
}

function actorRouteImportsOutsideApi() {
  const root = process.cwd();
  const files = ts.sys.readDirectory(path.join(root, "src"), [".ts", ".tsx"]);
  const imports: RouteImport[] = [];

  for (const file of files) {
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (relative.startsWith("src/app/api/")) continue;
    const source = ts.sys.readFile(file);
    if (source === undefined) throw new Error("SOURCE_CONTRACT_READ_FAILED");
    if (!source.includes("@/app/api/")) continue;
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      const moduleName = routeModuleName(node);
      if (moduleName && ACTOR_ROUTE_MODULES.includes(moduleName as (typeof ACTOR_ROUTE_MODULES)[number])) {
        imports.push({ file: relative, module: moduleName });
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }

  return imports.sort((left, right) =>
    left.file.localeCompare(right.file) || left.module.localeCompare(right.module)
  );
}

const ACTOR_ROUTE_IMPORTS_OUTSIDE_API = actorRouteImportsOutsideApi();

describe("auth actor import boundary", () => {
  it("detects static re-exports from route modules", () => {
    const sourceFile = ts.createSourceFile(
      "synthetic-route-re-export.ts",
      'export { loadPlatformActor } from "@/app/api/platform/impersonation/start/route";',
      ts.ScriptTarget.Latest,
      true,
    );
    const routeModules: string[] = [];
    function visit(node: ts.Node) {
      const moduleName = routeModuleName(node);
      if (moduleName) routeModules.push(moduleName);
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);

    expect(routeModules).toEqual(["@/app/api/platform/impersonation/start/route"]);
  });

  it("keeps actor helpers out of route modules for all non-API callers", () => {
    expect(ACTOR_ROUTE_IMPORTS_OUTSIDE_API).toEqual([]);
  });
});
