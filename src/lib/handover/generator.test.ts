import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ADMIN_GUIDES,
  ADMIN_GUIDE_NAV_MAP,
  ADMIN_GUIDE_SURFACES,
} from "@/lib/admin-help-guides";
import { workspaceNavigation } from "@/lib/workspace-navigation";

import {
  HANDOVER_CONTENT_FILES,
  assertAdminGuideCoverage,
  assertAdminGuideSurfaces,
  generatePhase8Handover,
  handoverDrift,
  parseHandoverManifestMetadata,
  type AlertRuleHandoverRow,
  type AuditActionHandoverRow,
  type HandoverSources,
} from "./generator";

const metadata = {
  generatedAt: "2026-08-18T10:04:28.000Z",
  sourceCommit: "8a748f48ecc2142ca4d018b0ae957259d820006f",
};

const auditActions: AuditActionHandoverRow[] = [
  {
    key: "synthetic.action.logged",
    actorKind: "human",
    scope: "platform",
    reasonRequired: true,
    coachVisible: false,
    microcopy: "Synthetic action logged",
    ariaLabel: "Synthetic action recorded in the audit log",
  },
];

const alertRules: AlertRuleHandoverRow[] = [
  {
    eventKey: "synthetic.event",
    scope: "platform",
    name: "Synthetic event",
    category: "test",
    audienceRoles: ["owner"],
    includeSuccessOwner: false,
    includeBillingContact: false,
    defaultDestinations: ["bell"],
    suppressible: false,
    defaultEnabled: true,
  },
];

function sources(): HandoverSources {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), "scripts/phase8-handover-sources.json"), "utf8"),
  ) as HandoverSources;
}

function generate() {
  return generatePhase8Handover({
    ...metadata,
    guides: ADMIN_GUIDES,
    guideNavMap: ADMIN_GUIDE_NAV_MAP,
    auditActions,
    alertRules,
    sources: sources(),
  });
}

describe("Phase 8 handover generation", () => {
  it("maps every canonical admin navigation entry to exactly one operator guide", () => {
    const adminPaths = workspaceNavigation.admin.flatMap((group) =>
      group.items.map((item) => item.href)
    );
    const navigationGuideMap = ADMIN_GUIDE_NAV_MAP;
    expect(navigationGuideMap).not.toHaveProperty("/admin/settings");
    expect(navigationGuideMap).toHaveProperty("/admin/brain/testing", "run-evals");
    expect(() => assertAdminGuideCoverage(
      adminPaths,
      ADMIN_GUIDES,
      navigationGuideMap,
    )).not.toThrow();
    expect(() => assertAdminGuideCoverage(
      adminPaths,
      ADMIN_GUIDES,
      { ...navigationGuideMap, "/admin/system": undefined as never },
    )).toThrow(/HANDOVER_ADMIN_GUIDE_MAPPING:\/admin\/system/u);
    expect(Object.keys(ADMIN_GUIDE_NAV_MAP).some((path) => path.startsWith("/coach/"))).toBe(false);
  });

  /**
   * The other direction, which the check above cannot see.
   *
   * `read-trace` shipped for weeks telling operators to open a trace from "any lead conversation",
   * a control no surface offers, and it reached the client inside `operator-guide.md`. It was not
   * in the nav map, so route -> guide never looked at it. This asserts guide -> route: every guide
   * names at least one admin destination, and every destination it names is real.
   */
  it("gives every operator guide a surface that exists", () => {
    const adminPaths = workspaceNavigation.admin.flatMap((group) =>
      group.items.map((item) => item.href)
    );

    expect(() => assertAdminGuideSurfaces(
      adminPaths,
      ADMIN_GUIDES,
      ADMIN_GUIDE_SURFACES,
    )).not.toThrow();

    const phantom = { ...ADMIN_GUIDES[0], id: "read-a-trace-that-does-not-exist" };
    expect(() => assertAdminGuideSurfaces(
      adminPaths,
      [...ADMIN_GUIDES, phantom],
      ADMIN_GUIDE_SURFACES,
    )).toThrow(/HANDOVER_GUIDE_WITHOUT_SURFACE:read-a-trace-that-does-not-exist/u);

    expect(() => assertAdminGuideSurfaces(
      adminPaths,
      ADMIN_GUIDES,
      { ...ADMIN_GUIDE_SURFACES, "audit-log": ["/admin/conversations"] },
    )).toThrow(/HANDOVER_GUIDE_SURFACE_UNKNOWN:audit-log:\/admin\/conversations/u);

    expect(() => assertAdminGuideSurfaces(
      adminPaths,
      ADMIN_GUIDES,
      { ...ADMIN_GUIDE_SURFACES, "read-trace": ["/admin/overview"] },
    )).toThrow(/HANDOVER_GUIDE_SURFACE_ORPHAN:read-trace/u);
  });

  it("produces byte-identical files and hashes from identical injected inputs", () => {
    const first = generate();
    const second = generate();
    expect(second).toEqual(first);
    expect(handoverDrift(first.files, second)).toEqual([]);
    expect(Object.keys(first.files).sort()).toEqual(
      [...HANDOVER_CONTENT_FILES, "MANIFEST.md"].sort(),
    );
    for (const file of HANDOVER_CONTENT_FILES) {
      expect(first.hashes[file]).toMatch(/^[0-9a-f]{64}$/u);
      expect(first.files["MANIFEST.md"]).toContain(`| ${file} | \`${first.hashes[file]}\` |`);
    }
  });

  it("accepts only injected ISO metadata and a full source commit", () => {
    const manifest = generate().files["MANIFEST.md"];
    expect(parseHandoverManifestMetadata(manifest)).toEqual(metadata);
    expect(() => generatePhase8Handover({
      ...metadata,
      generatedAt: "today",
      guides: ADMIN_GUIDES,
      guideNavMap: ADMIN_GUIDE_NAV_MAP,
      auditActions,
      alertRules,
      sources: sources(),
    })).toThrow("HANDOVER_GENERATED_AT_INVALID");
    expect(() => generatePhase8Handover({
      ...metadata,
      sourceCommit: "8a748f4",
      guides: ADMIN_GUIDES,
      guideNavMap: ADMIN_GUIDE_NAV_MAP,
      auditActions,
      alertRules,
      sources: sources(),
    })).toThrow("HANDOVER_SOURCE_COMMIT_INVALID");
  });

  it("fails on a procedure without every detection, action, verify, and undo field", () => {
    const incomplete = structuredClone(sources()) as HandoverSources;
    (incomplete.procedures[0].verify as string[]).splice(0);
    expect(() => generatePhase8Handover({
      ...metadata,
      guides: ADMIN_GUIDES,
      guideNavMap: ADMIN_GUIDE_NAV_MAP,
      auditActions,
      alertRules,
      sources: incomplete,
    })).toThrow(/HANDOVER_SOURCE_FIELD_REQUIRED:provider-outage-or-rotation\.verify/u);
  });

  it("renders registry rows and input-required placeholders without inventing approval", () => {
    process.env.SETTERFI_HANDOVER_TEST_SECRET = "must-never-enter-generated-docs";
    try {
      const generated = generate();
      const all = Object.values(generated.files).join("\n");
      expect(generated.files["audit-action-registry.md"]).toContain("synthetic.action.logged");
      expect(generated.files["alert-rule-registry.md"]).toContain("synthetic.event");
      expect(generated.files["running-costs.md"]).toContain("Model spend per conversation");
      expect(generated.files["running-costs.md"]).toContain("SMS cost per segment");
      expect(generated.files["running-costs.md"]).toContain("Input required");
      expect(generated.files["escalation-path.md"]).toContain("Input required");
      expect(generated.files["recording-01-diagnose.md"]).toContain("Recording required");
      expect(generated.files["recording-02-brain-publish-rollback.md"]).toContain("Recording required");
      expect(all).not.toContain("must-never-enter-generated-docs");
      expect(all).not.toMatch(/\b(?:approved contact|recording complete|deployment verified)\b/iu);
    } finally {
      delete process.env.SETTERFI_HANDOVER_TEST_SECRET;
    }
  });

  it("preserves the in-product guide text verbatim in the generated operator guide", () => {
    const operatorGuide = generate().files["operator-guide.md"];
    for (const guide of ADMIN_GUIDES) {
      expect(operatorGuide).toContain(guide.title);
      expect(operatorGuide).toContain(guide.detail);
      expect(operatorGuide).toContain(guide.outcome);
      for (const step of guide.steps) {
        expect(operatorGuide).toContain(step.heading);
        expect(operatorGuide).toContain(step.caption);
      }
      for (const check of guide.verify) expect(operatorGuide).toContain(check);
      expect(operatorGuide).toContain(guide.troubleshoot);
    }
  });
});
