import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { RESOURCE_COLUMNS, type ExportResource } from "@/app/api/exports/[resource]/handler";
import { LIVE_RENDERED_TABLE_EXPORTS } from "./rendered-tables";

type DerivedEntry = {
  surface: string;
  resource: ExportResource;
  formats: readonly ["csv", "json"];
  columns: readonly string[];
  filterKeys: readonly string[];
  sort: "last_activity_desc" | "created_desc" | "version_desc" | "event_asc";
};

const roots = [
  "src/components/workspace/live",
  "src/components/workspace/rehaul",
  "src/app/(workspace)",
] as const;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(target)
      : entry.isFile() && /\.[jt]sx$/.test(entry.name) && !entry.name.endsWith(".test.tsx")
        ? [target]
        : [];
  });
}

function propertyName(node: ts.PropertyName | undefined) {
  return node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : null;
}

function literal(node: ts.Expression | undefined): string | null {
  if (!node) return null;
  // `mode: "server" as const` and friends still name a literal; unwrap the assertion first.
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) {
    return literal(node.expression);
  }
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function declarations(source: ts.SourceFile) {
  const values = new Map<string, ts.Expression>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      values.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return values;
}

function resolve(node: ts.Expression, values: Map<string, ts.Expression>): ts.Expression {
  if (ts.isIdentifier(node) && values.has(node.text)) return resolve(values.get(node.text)!, values);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return resolve(node.expression, values);
  }
  return node;
}

function arrayStrings(node: ts.Expression, values: Map<string, ts.Expression>): string[] | null {
  const value = resolve(node, values);
  if (!ts.isArrayLiteralExpression(value)) return null;
  const columns: string[] = [];
  for (const element of value.elements) {
    if (ts.isStringLiteral(element)) columns.push(element.text);
    else if (ts.isSpreadElement(element)) {
      const spread = resolve(element.expression, values);
      if (ts.isConditionalExpression(spread)) {
        for (const branch of [spread.whenTrue, spread.whenFalse]) {
          const branchColumns = arrayStrings(branch, values);
          if (branchColumns) columns.push(...branchColumns);
        }
      } else {
        const spreadColumns = arrayStrings(spread, values);
        if (!spreadColumns) return null;
        columns.push(...spreadColumns);
      }
    }
  }
  return [...new Set(columns)];
}

function objectProperties(
  node: ts.Expression | undefined,
  values: Map<string, ts.Expression>,
): Map<string, ts.Expression> {
  const properties = new Map<string, ts.Expression>();
  if (!node) return properties;
  const value = resolve(node, values);
  if (!ts.isObjectLiteralExpression(value)) return properties;
  for (const property of value.properties) {
    if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
      const name = propertyName(property.name);
      if (name) properties.set(name, ts.isPropertyAssignment(property) ? property.initializer : property.name);
    } else if (ts.isSpreadAssignment(property)) {
      const spread = resolve(property.expression, values);
      if (ts.isConditionalExpression(spread)) {
        for (const branch of [spread.whenTrue, spread.whenFalse]) {
          for (const [name, expression] of objectProperties(branch, values)) properties.set(name, expression);
        }
      } else {
        for (const [name, expression] of objectProperties(spread, values)) properties.set(name, expression);
      }
    }
  }
  return properties;
}

function defaultSort(resource: ExportResource): DerivedEntry["sort"] {
  if (resource === "conversations" || resource === "contacts") return "last_activity_desc";
  if (resource === "brain-snapshots" || resource === "brain-snapshot-diffs") return "version_desc";
  return "created_desc";
}

function deriveEntry(
  file: string,
  resource: ExportResource,
  query: ts.Expression | undefined,
  values: Map<string, ts.Expression>,
  occurrence: number,
): DerivedEntry {
  const queryProperties = objectProperties(query, values);
  const sourceColumns = queryProperties.get("columns");
  const columns = sourceColumns ? arrayStrings(sourceColumns, values) : null;
  const filterKeys = [...queryProperties.keys()]
    .filter((key) => !["columns", "order", "reason", "tenantId"].includes(key))
    .sort();
  const order = literal(queryProperties.get("order")) as DerivedEntry["sort"] | null;
  return {
    surface: `${file}#${resource}${occurrence > 1 ? `#${occurrence}` : ""}`,
    resource,
    formats: ["csv", "json"],
    columns: columns ?? RESOURCE_COLUMNS[resource],
    filterKeys,
    sort: order ?? defaultSort(resource),
  };
}

function jsxAttribute(node: ts.JsxAttributes, name: string) {
  const attribute = node.properties.find(
    (candidate): candidate is ts.JsxAttribute => ts.isJsxAttribute(candidate) && candidate.name.getText() === name,
  );
  if (!attribute?.initializer) return undefined;
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer;
  return ts.isJsxExpression(attribute.initializer) ? attribute.initializer.expression : undefined;
}

function deriveRenderedExports(): DerivedEntry[] {
  const entries: DerivedEntry[] = [];
  for (const absoluteFile of roots.flatMap((root) => sourceFiles(path.join(process.cwd(), root)))) {
    const file = path.relative(process.cwd(), absoluteFile);
    const source = ts.createSourceFile(
      file,
      readFileSync(absoluteFile, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const values = declarations(source);
    const occurrences = new Map<string, number>();
    const add = (resource: string | null, query: ts.Expression | undefined) => {
      if (!resource || !(resource in RESOURCE_COLUMNS)) return;
      const occurrence = (occurrences.get(resource) ?? 0) + 1;
      occurrences.set(resource, occurrence);
      entries.push(deriveEntry(file, resource as ExportResource, query, values, occurrence));
    };
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText() === "ExportMenu") {
        const mode = literal(jsxAttribute(node.attributes, "mode"));
        if (mode === "server") {
          add(literal(jsxAttribute(node.attributes, "resource")), jsxAttribute(node.attributes, "query"));
        }
      }
      if (ts.isObjectLiteralExpression(node)) {
        const properties = objectProperties(node, values);
        if (literal(properties.get("mode")) === "server") {
          add(literal(properties.get("resource")), properties.get("query"));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return entries.sort((left, right) => left.surface.localeCompare(right.surface));
}

describe("live rendered table export inventory", () => {
  it("discovers a non-vacuous source-owned server ExportMenu inventory", () => {
    const derived = deriveRenderedExports();
    expect(derived.length).toBeGreaterThan(0);
    expect(new Set(derived.map((entry) => entry.surface)).size).toBe(derived.length);
  });

  /**
   * The third side of the triangle, and the one that was missing.
   *
   * The bidirectional check below compares the TSX against the inventory, so the two can be wrong
   * together and still agree. That is not hypothetical: renaming `commissionEarnedCents` to
   * `commissionEarnedUsd` in `RESOURCE_COLUMNS` left `affiliate-money.tsx` and the inventory both
   * naming the old column, they matched each other, this suite stayed green -- and the affiliate
   * referral export was broken outright, because `parseExportQuery` throws
   * `EXPORT_COLUMNS_INVALID` when a requested column is not in `RESOURCE_COLUMNS[resource]`. A
   * guard that checks two of three sides reports on the pair it happens to hold.
   *
   * So every column a screen asks for is checked against what the resource can actually serve.
   * This is the assertion that fails the moment a resource's columns are renamed without the
   * callers moving with them, which is the only way that rename can break a customer's download.
   */
  it("asks every resource only for columns it can serve", () => {
    for (const entry of LIVE_RENDERED_TABLE_EXPORTS) {
      const servable = RESOURCE_COLUMNS[entry.resource];
      expect(servable, `${entry.resource} has no column contract`).toBeTruthy();
      for (const column of entry.columns) {
        expect(
          servable,
          `${entry.surface} requests "${column}", which ${entry.resource} cannot serve -- the export throws EXPORT_COLUMNS_INVALID`,
        ).toContain(column);
      }
    }
  });

  it("matches every rendered source bidirectionally with exact columns, filters, and sort", () => {
    const derived = deriveRenderedExports();
    const inventory = [...LIVE_RENDERED_TABLE_EXPORTS]
      .map((entry) => ({ ...entry, columns: [...entry.columns], filterKeys: [...entry.filterKeys] }))
      .sort((left, right) => left.surface.localeCompare(right.surface));
    expect(inventory).toEqual(derived);
  });

  /*
   * The Leads export, and the fact that there is exactly one of it.
   *
   * There is no written rule behind this guard -- `8d260eb` landed it with an empty body and no
   * docstring -- so what it holds is re-derived from what it asserts: the Leads export carries the
   * complete filtered set rather than the page on screen, it is local rather than server-backed,
   * and it is bound to the same rows the surface above it describes.
   *
   * It used to assert that by counting: two `ExportMenu`s and exactly three `exportRows` prop
   * passes. Both artboards draw one Download, on the filter row, so the two controls became one --
   * but the count was doing real work, and dropping it for "renders an ExportMenu" would go vacuous
   * the moment a second export appeared bound to something else, a paginated slice or `contacts`
   * instead of `filteredContacts`. So the count survives as exclusivity: one export control across
   * all three Leads files, bound to the one expression, which is bound to the complete filtered set.
   */
  it("keeps the single Leads export bound to the complete shared filtered rows", () => {
    const files = [
      "src/components/workspace/live/leads-surface.tsx",
      "src/components/workspace/live/coach-contacts.tsx",
      "src/components/workspace/live/coach-pipeline.tsx",
    ] as const;
    const sources = new Map(
      files.map((file) => [file, readFileSync(path.join(process.cwd(), file), "utf8")]),
    );

    // Both spellings of an export control: the standalone menu and the table's own prop.
    const controls = files.flatMap((file) => {
      const source = sources.get(file)!;
      return [
        ...source.matchAll(/<ExportMenu\b/gu),
        ...source.matchAll(/\bexportResource=\{/gu),
      ].map(() => file);
    });
    expect(controls).toEqual(["src/components/workspace/live/leads-surface.tsx"]);

    const surface = sources.get("src/components/workspace/live/leads-surface.tsx")!;
    expect(surface).toMatch(/const exportRows = useMemo\(\(\) => leadExportRows\(filteredContacts\)/u);
    expect(surface).toMatch(/mode="local"/u);
    expect(surface).not.toMatch(/mode="server"/u);
    expect(surface).toMatch(/rows=\{exportRows\}/u);
    // One binding, so there is no second consumer to be bound to something else.
    expect(surface.match(/rows=\{[^}]*\}/gu)).toEqual(["rows={exportRows}"]);

    expect(LIVE_RENDERED_TABLE_EXPORTS.map((entry) => entry.surface)).not.toContain(
      "src/components/workspace/live/coach-contacts.tsx#contacts",
    );
    expect(LIVE_RENDERED_TABLE_EXPORTS.map((entry) => entry.surface)).not.toContain(
      "src/components/workspace/live/coach-pipeline.tsx#coach-pipeline",
    );
  });

  it("has no invented marker contract in either scanned source tree", () => {
    for (const file of roots.flatMap((root) => sourceFiles(path.join(process.cwd(), root)))) {
      expect(readFileSync(file, "utf8")).not.toContain("data-export-table");
    }
  });
});
