import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function source(path: string) {
  return readFileSync(resolve(ROOT, path), "utf8");
}

const pages = [
  "src/app/(workspace)/coach/page.tsx",
  "src/app/(workspace)/coach/home/page.tsx",
  "src/app/(workspace)/coach/pipelines/page.tsx",
] as const;

const adminPages = [
  "src/app/(workspace)/admin/overview/page.tsx",
  "src/app/(workspace)/admin/agent-performance/page.tsx",
] as const;

describe("Phase 7 coach route ownership", () => {
  it("owns every coach measurement route as a force-dynamic page", () => {
    for (const page of pages) {
      expect(existsSync(resolve(ROOT, page))).toBe(true);
      expect(source(page)).toContain('export const dynamic = "force-dynamic"');
    }
    expect(existsSync(resolve(ROOT, "src/app/(workspace)/coach/home/loading.tsx"))).toBe(true);
    expect(existsSync(resolve(ROOT, "src/app/(workspace)/coach/pipelines/loading.tsx"))).toBe(true);
  });

  it("checks the nested analytics flag before every measurement repository loader", () => {
    for (const page of pages.filter((path) => !path.endsWith("/pipelines/page.tsx"))) {
      const pageSource = source(page);
      const gate = pageSource.indexOf("if (!phase7AnalyticsLive())");
      expect(gate, page).toBeGreaterThan(-1);
      expect(pageSource).toContain("Measurement is not enabled");
      expect(pageSource).not.toMatch(/workspace-fixtures|fixture-workspace-shell|WorkspaceScreen/u);
      const loader = pageSource.indexOf("loadCoachMeasurement");
      if (loader >= 0) expect(loader, page).toBeGreaterThan(gate);
      const repositoryImport = pageSource.indexOf('import("@/lib/repositories/analytics")');
      if (repositoryImport >= 0) expect(repositoryImport, page).toBeGreaterThan(gate);
    }
  });

  it("keeps the shared Leads board independent of analytics and gates only its write path", () => {
    const pipeline = source("src/app/(workspace)/coach/pipelines/page.tsx");
    expect(pipeline).not.toContain("phase7AnalyticsLive");
    expect(pipeline).not.toContain("Measurement is not enabled");
    expect(pipeline).toContain("if (!phase1Live())");
    expect(pipeline.indexOf("listAllContacts(context.tenantId")).toBeGreaterThan(
      pipeline.indexOf("if (!phase1Live())"),
    );
    expect(pipeline).toContain("writeEnabled={pipelineWriteLive()}");
  });

  it("enforces server claims, tenant scope, and impersonation custody on every route", () => {
    for (const page of pages) {
      const pageSource = source(page);
      expect(pageSource, page).toContain("getClaims");
      expect(pageSource, page).toContain("canAccessWorkspace");
      expect(pageSource, page).toContain("claims.impersonatingTenant ?? claims.tenantId");
      expect(pageSource, page).toContain("impersonation_sessions");
      expect(pageSource, page).toContain("impersonatedReadContext");
    }
  });

  it("removes only coach measurement ownership from the shared catch-all", () => {
    const routePath = "src/app/(workspace)/[role]/[[...screen]]/page.tsx";
    expect(existsSync(resolve(ROOT, routePath))).toBe(false);
    expect(existsSync(resolve(ROOT, "src/components/workspace/workspace-screens.tsx"))).toBe(false);
  });

  it("keeps the Phase 8 fixture owners present and adds no test component files", () => {
    for (const path of [
      "src/app/(workspace)/[role]/[[...screen]]/page.tsx",
      "src/lib/workspace-fixtures.ts",
      "src/components/workspace/workspace-screens.tsx",
      "src/components/workspace/fixture-workspace-shell.tsx",
    ]) expect(existsSync(resolve(ROOT, path)), path).toBe(false);
    expect(pages.some((page) => page.endsWith(".test.tsx"))).toBe(false);
    expect(existsSync(resolve(ROOT, "src/components/workspace/live/measurement-routes.test.tsx"))).toBe(false);
  });
});

describe("persisted test-data labels", () => {
  it("carries repository isTest through deriveConversationView to a rendered provenance label", () => {
    const viewModel = source("src/components/workspace/live/view-models.ts");
    const conversations = source("src/components/workspace/live/coach-conversations.tsx");
    expect(viewModel).toContain("export function deriveConversationView");
    expect(viewModel).toContain("isTest: row.isTest");
    expect(conversations).toContain("deriveConversationView");

    // The label has to be handed to something that renders. This assertion used to read
    // `toContain("<DemoBadge ... />")`, which a commented-out line satisfied just as well as a
    // live one - so it stayed green while nothing rendered, and kept dead code alive to do it.
    // Strip comments before asserting, and pin the prop that actually reaches PageHeader.
    const live = conversations
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(live).toMatch(/row\.isTest/);
    expect(live).toMatch(/provenance=\{/);
    // Behaviour that this label actually appears on screen is asserted in
    // coach-conversations.test.tsx, which renders it.
  });

  it("keeps provider branding and coach-visible economics out of measurement surfaces", () => {
    const measurement = source("src/components/workspace/live/coach-measurement.tsx");
    const pipeline = source("src/components/workspace/live/coach-pipeline.tsx");
    expect(`${measurement}\n${pipeline}`).not.toMatch(/GoHighLevel|\bGHL\b|margin|provider cost|cost economics/iu);
  });
});

describe("Phase 7 admin route ownership", () => {
  it("owns the admin root, Overview, and Agent Performance as dedicated routes", () => {
    const adminRoot = "src/app/(workspace)/admin/page.tsx";
    expect(existsSync(resolve(ROOT, adminRoot))).toBe(true);
    expect(source(adminRoot)).toContain('export const dynamic = "force-dynamic"');
    expect(source(adminRoot)).toContain('redirect("/admin/overview")');
    for (const page of adminPages) {
      expect(existsSync(resolve(ROOT, page))).toBe(true);
      expect(source(page)).toContain('export const dynamic = "force-dynamic"');
    }
    expect(existsSync(resolve(ROOT, "src/app/(workspace)/admin/overview/loading.tsx"))).toBe(true);
    expect(existsSync(resolve(ROOT, "src/app/(workspace)/admin/agent-performance/loading.tsx"))).toBe(true);
  });

  it("checks the analytics flag before any platform repository load", () => {
    for (const page of adminPages) {
      const pageSource = source(page);
      const gate = pageSource.indexOf("if (!phase7AnalyticsLive())");
      const loader = pageSource.indexOf("loadPlatformMeasurement");
      expect(gate, page).toBeGreaterThan(-1);
      expect(loader, page).toBeGreaterThan(gate);
      expect(pageSource).toContain("Measurement is not enabled");
      expect(pageSource).not.toMatch(/workspace-fixtures|fixture-workspace-shell|WorkspaceScreen/u);
    }
  });

  it("admits only owner, admin, and success before loading cross-tenant evidence", () => {
    for (const page of adminPages) {
      const pageSource = source(page);
      expect(pageSource).toContain("loadPlatformActor");
      expect(pageSource).toContain('actor.role !== "owner"');
      expect(pageSource).toContain('actor.role !== "admin"');
      expect(pageSource).toContain('actor.role !== "success"');
      expect(pageSource.indexOf("forbidden()"), page).toBeLessThan(
        pageSource.indexOf("loadPlatformMeasurement"),
      );
    }
  });

  it("removes only the admin measurement owners from the shared catch-all", () => {
    expect(existsSync(resolve(ROOT, "src/app/(workspace)/[role]/[[...screen]]/page.tsx"))).toBe(false);
    expect(existsSync(resolve(ROOT, "src/components/workspace/workspace-screens.tsx"))).toBe(false);
  });

  it("keeps success economics off the wire on both split measurement surfaces", () => {
    const overview = source("src/components/workspace/live/admin-overview.tsx");
    const performance = source("src/components/workspace/live/admin-agent-performance.tsx");
    const performancePage = source("src/app/(workspace)/admin/agent-performance/page.tsx");
    const tables = source("src/components/workspace/live/admin-measurement-tables.tsx");
    const reducer = source("src/components/workspace/live/admin-measurement-view-models.ts");

    // Overview stays a server component, so the unprojected snapshot never reaches a browser.
    expect(overview.trimStart().startsWith('"use client"')).toBe(false);
    expect(overview).toContain("adminMeasurementView(measurement, role)");
    expect(overview).toContain('role === "success"');
    expect(overview).toContain('role !== "success"');

    // Agent performance is a client component, so its page must project before the boundary
    // and hand over only the projected view, never the raw measurement.
    expect(performance).toContain('"use client"');
    expect(performance).toContain("view: AdminMeasurementView");
    expect(performance).toContain('const economicsVisible = view.role !== "success"');
    expect(performance).not.toMatch(/measurement: PlatformMeasurement;/u);
    expect(performance).not.toContain("adminMeasurementView(");
    expect(performancePage).toContain("adminMeasurementView(measurement, actor.role)");
    expect(performancePage).not.toMatch(/<AdminAgentPerformanceSurface[^>]*measurement=\{measurement\}/u);

    // The shared tables only ever receive already-projected rows.
    expect(tables).toContain('"use client"');
    expect(tables).not.toContain("PlatformMeasurement");

    // The projection itself is where the role gate lives.
    expect(reducer).toContain('role !== "success" || !isEconomicsMetric');

    /*
     * This used to read `toContain("snapshot.tenantPerformance.map(({ tenantId, bookedAppointments })")`
     * and it went red on a change that strengthened the thing it protects: the fields were
     * alphabetised and the owner arm was given its own explicit projection. A destructuring pattern
     * is field ORDER, which means nothing in JavaScript, so that assertion measured the spelling of
     * the rule rather than the rule.
     *
     * What it was guarding is worth keeping: a success reviewer's tenant rows carry the tenant and
     * the booking count and no economics. So that is asserted directly, in whatever order the
     * fields are written -- and the guard is widened to the property that actually protects every
     * reader, which is that no collection is spread out of the snapshot at all. A spread admits
     * whatever the row grows, and these rows arrive from an RPC, so a column added upstream is
     * present at runtime long before any type mentions it. The runtime half of this lives in
     * `admin-measurement-view-models.test.ts`, which plants an unadmitted economics field on all
     * six collections; this is the source-level half, and it is what stops the spread coming back.
     */
    // Both ends measured from the declaration, never by absolute index: an earlier `return {` in
    // the file sits before it, so `indexOf("return {")` on the whole source ends the slice before
    // it starts and hands back an empty string that every assertion below passes vacuously.
    const projectionStart = reducer.indexOf("const tenantPerformance =");
    expect(projectionStart, "the tenantPerformance projection moved or was renamed").toBeGreaterThan(-1);
    const tenantProjection = reducer.slice(
      projectionStart,
      projectionStart + reducer.slice(projectionStart).indexOf("return {"),
    );
    expect(tenantProjection).toContain("snapshot.tenantPerformance.map");

    const [successArm] = [...tenantProjection.matchAll(/\(\{([^}]*)\}\)/gu)].map((match) =>
      match[1].split(",").map((field) => field.trim()).filter(Boolean).sort(),
    );
    expect(successArm).toEqual(["bookedAppointments", "tenantId"]);

    // No collection is spread out of the snapshot, for any role.
    expect(reducer).not.toMatch(/snapshot\.\w+\.map\(\((\w+)\) => \(\{\s*\.\.\.\1/u);
    expect(`${overview}\n${performance}\n${tables}\n${reducer}`)
      .not.toMatch(/workspace-fixtures|admin-demo-feedback-fixtures|GoHighLevel|\bGHL\b/u);
  });
});
