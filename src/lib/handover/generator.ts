/**
 * Deterministic Phase 8 handover generation.
 *
 * The caller supplies registry rows and source metadata. This module never reads the clock,
 * environment, database, or deployment state, so committed inputs always produce identical bytes.
 */

import { createHash } from "node:crypto";

import type { AdminGuide } from "@/lib/admin-help-guides";
import { foldedRouteFor } from "@/lib/admin-route-fold";

export const HANDOVER_CONTENT_FILES = [
  "operator-guide.md",
  "audit-action-registry.md",
  "alert-rule-registry.md",
  "failure-procedures.md",
  "running-costs.md",
  "escalation-path.md",
  "recording-01-diagnose.md",
  "recording-02-brain-publish-rollback.md",
] as const;

export type HandoverContentFile = (typeof HANDOVER_CONTENT_FILES)[number];

export type AuditActionHandoverRow = {
  key: string;
  actorKind: string;
  scope: string;
  reasonRequired: boolean;
  coachVisible: boolean;
  microcopy: string;
  ariaLabel: string;
};

export type AlertRuleHandoverRow = {
  eventKey: string;
  scope: string;
  name: string;
  category: string;
  audienceRoles: readonly string[];
  includeSuccessOwner: boolean;
  includeBillingContact: boolean;
  defaultDestinations: readonly string[];
  suppressible: boolean;
  defaultEnabled: boolean;
};

export type FailureProcedureSource = {
  id: string;
  title: string;
  detectionEvidence: readonly string[];
  reversible: string;
  action: readonly string[];
  verify: readonly string[];
  undo: readonly string[];
};

export type RunningCostSource = {
  label: string;
  unit: string;
  status: "input_required";
  inputName: string;
};

export type EscalationSource = {
  scope: string;
  owner: string;
  status: "input_required";
};

export type RecordingSource = {
  id: "diagnose" | "brain-publish-rollback";
  title: string;
  status: "recording_required";
  shots: readonly string[];
  proof: readonly string[];
};

export type HandoverSources = {
  procedures: readonly FailureProcedureSource[];
  runningCosts: readonly RunningCostSource[];
  escalation: readonly EscalationSource[];
  recordings: readonly RecordingSource[];
};

export type HandoverMetadata = {
  generatedAt: string;
  sourceCommit: string;
};

export type GeneratePhase8HandoverInput = HandoverMetadata & {
  guides: readonly AdminGuide[];
  guideNavMap: Readonly<Record<string, string>>;
  auditActions: readonly AuditActionHandoverRow[];
  alertRules: readonly AlertRuleHandoverRow[];
  sources: HandoverSources;
};

export type GeneratedPhase8Handover = {
  files: Readonly<Record<HandoverContentFile | "MANIFEST.md", string>>;
  hashes: Readonly<Record<HandoverContentFile, string>>;
};

function markdownCell(value: string) {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function list(values: readonly string[]) {
  return values.map((value) => `- ${value}`).join("\n");
}

function numbered(values: readonly string[]) {
  return values.map((value, index) => `${index + 1}. ${value}`).join("\n");
}

function hash(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function withFinalNewline(value: string) {
  return `${value.trimEnd()}\n`;
}

function assertNonempty(label: string, values: readonly string[]) {
  if (values.length === 0 || values.some((value) => value.trim().length === 0)) {
    throw new Error(`HANDOVER_SOURCE_FIELD_REQUIRED:${label}`);
  }
}

export function assertHandoverSources(sources: HandoverSources) {
  assertNonempty("procedures", sources.procedures.map((procedure) => procedure.id));
  for (const procedure of sources.procedures) {
    if (!procedure.title.trim() || !procedure.reversible.trim()) {
      throw new Error(`HANDOVER_SOURCE_FIELD_REQUIRED:${procedure.id}`);
    }
    assertNonempty(`${procedure.id}.detectionEvidence`, procedure.detectionEvidence);
    assertNonempty(`${procedure.id}.action`, procedure.action);
    assertNonempty(`${procedure.id}.verify`, procedure.verify);
    assertNonempty(`${procedure.id}.undo`, procedure.undo);
  }
  assertNonempty("runningCosts", sources.runningCosts.map((cost) => cost.inputName));
  if (sources.runningCosts.some((cost) => cost.status !== "input_required")) {
    throw new Error("HANDOVER_COST_INPUT_PRESENTED_AS_APPROVED");
  }
  assertNonempty("escalation", sources.escalation.map((entry) => entry.owner));
  if (sources.escalation.some((entry) => entry.status !== "input_required")) {
    throw new Error("HANDOVER_ESCALATION_INPUT_PRESENTED_AS_APPROVED");
  }
  expectRecording(sources, "diagnose");
  expectRecording(sources, "brain-publish-rollback");
}

function expectRecording(sources: HandoverSources, id: RecordingSource["id"]) {
  const recording = sources.recordings.find((entry) => entry.id === id);
  if (!recording || recording.status !== "recording_required") {
    throw new Error(`HANDOVER_RECORDING_REQUIRED:${id}`);
  }
  assertNonempty(`${id}.shots`, recording.shots);
  assertNonempty(`${id}.proof`, recording.proof);
  return recording;
}

export function assertHandoverMetadata(metadata: HandoverMetadata) {
  const parsed = new Date(metadata.generatedAt);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== metadata.generatedAt) {
    throw new Error("HANDOVER_GENERATED_AT_INVALID");
  }
  if (!/^[0-9a-f]{40}$/u.test(metadata.sourceCommit)) {
    throw new Error("HANDOVER_SOURCE_COMMIT_INVALID");
  }
}

export function assertAdminGuideCoverage(
  adminNavPaths: readonly string[],
  guides: readonly AdminGuide[],
  guideNavMap: Readonly<Record<string, string>>,
) {
  const guideIds = new Set(guides.map((guide) => guide.id));
  const canonicalPaths = [...new Set(adminNavPaths)].sort();
  const mappedPaths = Object.keys(guideNavMap).sort();
  if (new Set(guides.map((guide) => guide.id)).size !== guides.length) {
    throw new Error("HANDOVER_DUPLICATE_GUIDE_ID");
  }
  if (JSON.stringify(canonicalPaths) !== JSON.stringify(mappedPaths)) {
    const missing = canonicalPaths.find((path) => !(path in guideNavMap));
    const extra = mappedPaths.find((path) => !canonicalPaths.includes(path));
    throw new Error(`HANDOVER_ADMIN_GUIDE_COVERAGE:${missing ?? extra ?? "unknown"}`);
  }
  for (const [path, guideId] of Object.entries(guideNavMap)) {
    if (!path.startsWith("/admin/") || !guideIds.has(guideId)) {
      throw new Error(`HANDOVER_ADMIN_GUIDE_MAPPING:${path}:${guideId}`);
    }
  }
}

/**
 * Every guide names a route that renders, which is the direction `assertAdminGuideCoverage` cannot
 * ask.
 *
 * That guard walks route -> guide and proves each admin destination has help. It is silent about a
 * guide with no destination, and on 2026-09-01 one had shipped through the gap: `read-trace` told
 * an operator to open a trace from "any lead conversation", an affordance the product does not
 * have anywhere, and it reached the client inside `operator-guide.md`. It was not in the nav map,
 * so nothing in the coverage check ever looked at it.
 *
 * A guide with no surface is worse than a page with no guide. A missing guide leaves somebody
 * without instructions; a guide for a missing surface sends them looking for a control that is not
 * there, and in the handover package it is a claim about what was delivered.
 */
/**
 * Every route a guide is allowed to name: the admin rail, plus the pages the folded routes land
 * on.
 *
 * The rail fold turned pages into tabs and sheet sections, so a guide about Evals is now about a
 * tab of `/admin/brain` and the account-terms guide is about a section of `/account`. Deriving the
 * set from `foldedRouteFor` keeps the guard as strict as it was -- a folded source route such as
 * `/admin/brain/testing` is a key there, never a destination, so naming one still fails -- while
 * letting a guide name the destination it actually moved to.
 */
export function adminGuideSurfaceRoutes(adminNavPaths: readonly string[]): readonly string[] {
  const folded = Object.values(foldedRouteFor).map((route) => route.pathname);
  return [...new Set([...adminNavPaths, ...folded])];
}

export function assertAdminGuideSurfaces(
  adminNavPaths: readonly string[],
  guides: readonly AdminGuide[],
  guideSurfaces: Readonly<Record<string, readonly string[]>>,
) {
  const routes = new Set(adminNavPaths);
  const guideIds = new Set(guides.map((guide) => guide.id));

  for (const guide of guides) {
    const surfaces = guideSurfaces[guide.id];
    if (!surfaces || surfaces.length === 0) {
      throw new Error(`HANDOVER_GUIDE_WITHOUT_SURFACE:${guide.id}`);
    }
    for (const path of surfaces) {
      if (!routes.has(path)) {
        throw new Error(`HANDOVER_GUIDE_SURFACE_UNKNOWN:${guide.id}:${path}`);
      }
    }
  }

  // A surface row for a guide that no longer exists is a description of deleted code, and the next
  // reader takes it for a live mapping.
  for (const id of Object.keys(guideSurfaces)) {
    if (!guideIds.has(id)) throw new Error(`HANDOVER_GUIDE_SURFACE_ORPHAN:${id}`);
  }
}

function renderOperatorGuide(
  guides: readonly AdminGuide[],
  guideNavMap: Readonly<Record<string, string>>,
) {
  const guideById = new Map(guides.map((guide) => [guide.id, guide]));
  const coverage = Object.entries(guideNavMap)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, guideId]) => `- \`${path}\`: ${guideById.get(guideId)?.title ?? guideId}`)
    .join("\n");
  const bodies = guides.map((guide) => `## ${guide.title}

${guide.detail}

**Outcome:** ${guide.outcome}

${guide.steps.map((step, index) => `${index + 1}. **${step.heading}.** ${step.caption}`).join("\n")}

### Verify

${list(guide.verify)}

### If verification fails

${guide.troubleshoot}`).join("\n\n---\n\n");
  return withFinalNewline(`# SetterFi operator guide

This document is generated verbatim from the in-product admin guide registry. It is source
evidence only: it does not prove deployment, provider delivery, a recording, or live UAT.

## Admin navigation coverage

${coverage}

---

${bodies}`);
}

function renderAuditRegistry(rows: readonly AuditActionHandoverRow[]) {
  const body = [...rows]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((row) => `| ${markdownCell(row.key)} | ${row.actorKind} | ${row.scope} | ${row.reasonRequired ? "Yes" : "No"} | ${row.coachVisible ? "Yes" : "No"} | ${markdownCell(row.microcopy)} | ${markdownCell(row.ariaLabel)} |`)
    .join("\n");
  return withFinalNewline(`# Audit action registry

Generated from the migrated \`audit_actions\` table in sorted key order. A UI may render Logged
only from a persisted receipt for one of these registered actions.

| Key | Actor | Scope | Reason required | Coach visible | Microcopy | Accessibility label |
| --- | --- | --- | --- | --- | --- | --- |
${body}`);
}

function renderAlertRegistry(rows: readonly AlertRuleHandoverRow[]) {
  const body = [...rows]
    .sort((left, right) => `${left.eventKey}:${left.scope}`.localeCompare(`${right.eventKey}:${right.scope}`))
    .map((row) => {
      const audience = [
        ...row.audienceRoles,
        ...(row.includeSuccessOwner ? ["success_owner"] : []),
        ...(row.includeBillingContact ? ["billing_contact"] : []),
      ];
      return `| ${markdownCell(row.eventKey)} | ${row.scope} | ${markdownCell(row.name)} | ${row.category} | ${markdownCell(audience.join(", ") || "None")} | ${markdownCell(row.defaultDestinations.join(", "))} | ${row.suppressible ? "Optional" : "Required"} | ${row.defaultEnabled ? "Enabled" : "Disabled"} |`;
    })
    .join("\n");
  return withFinalNewline(`# Alert rule registry

Generated from the migrated \`alert_rules\` table in event-and-scope order. Destinations are
intent; provider delivery still requires a persisted attempt and its destination-specific receipt.

| Event | Scope | Name | Category | Audience | Default destinations | Preference | Default state |
| --- | --- | --- | --- | --- | --- | --- | --- |
${body}`);
}

function renderFailureProcedures(procedures: readonly FailureProcedureSource[]) {
  const body = procedures.map((procedure) => `## ${procedure.title}

### Detection evidence

${list(procedure.detectionEvidence)}

### Reversible

${procedure.reversible}

### Action

${numbered(procedure.action)}

### Verify

${list(procedure.verify)}

### Undo

${numbered(procedure.undo)}`).join("\n\n---\n\n");
  return withFinalNewline(`# Failure procedures

SetterFi has one environment. These procedures name the evidence, reversibility, verification,
and undo before an operator acts. Any step that requires database access belongs on the escalation
path rather than being improvised here.

${body}`);
}

function renderRunningCosts(costs: readonly RunningCostSource[]) {
  const rows = costs.map((cost) => `| ${markdownCell(cost.label)} | ${markdownCell(cost.unit)} | Input required | \`${cost.inputName}\` |`).join("\n");
  return withFinalNewline(`# Running costs

This owner/operator sheet excludes SetterFi margin and build economics. No rate is approved in the
repository, so every line remains **Input required** until Ayman or Alec supplies a dated provider
source. The two growth-sensitive inputs are listed first and must not be inferred.

| Cost line | Unit | State | Input name |
| --- | --- | --- | --- |
${rows}`);
}

function renderEscalationPath(escalation: readonly EscalationSource[]) {
  const rows = escalation.map((entry) => `| ${markdownCell(entry.scope)} | Input required | \`${entry.owner}\` |`).join("\n");
  return withFinalNewline(`# Escalation path

The named contacts and support window are human-owned launch inputs. Placeholders below are
explicitly **Input required** and are not approved contacts or commercial commitments.

| Scope | State | Required input |
| --- | --- | --- |
${rows}

Until these names are supplied, preserve the evidence, avoid a second mutation or provider send,
and route the incident to Ayman for ownership assignment.`);
}

function renderRecording(recording: RecordingSource) {
  return withFinalNewline(`# Recording shot list: ${recording.title}

**State: Recording required.** This file is an executable shot list, not evidence that a recording
exists.

## Shots

${numbered(recording.shots)}

## Proof before accepting the recording

${list(recording.proof)}`);
}

export function generatePhase8Handover(input: GeneratePhase8HandoverInput): GeneratedPhase8Handover {
  assertHandoverMetadata(input);
  assertHandoverSources(input.sources);
  const contentFiles: Record<HandoverContentFile, string> = {
    "operator-guide.md": renderOperatorGuide(input.guides, input.guideNavMap),
    "audit-action-registry.md": renderAuditRegistry(input.auditActions),
    "alert-rule-registry.md": renderAlertRegistry(input.alertRules),
    "failure-procedures.md": renderFailureProcedures(input.sources.procedures),
    "running-costs.md": renderRunningCosts(input.sources.runningCosts),
    "escalation-path.md": renderEscalationPath(input.sources.escalation),
    "recording-01-diagnose.md": renderRecording(expectRecording(input.sources, "diagnose")),
    "recording-02-brain-publish-rollback.md": renderRecording(expectRecording(input.sources, "brain-publish-rollback")),
  };
  const hashes = Object.fromEntries(
    HANDOVER_CONTENT_FILES.map((file) => [file, hash(contentFiles[file])]),
  ) as Record<HandoverContentFile, string>;
  const manifestRows = HANDOVER_CONTENT_FILES
    .map((file) => `| ${file} | \`${hashes[file]}\` |`)
    .join("\n");
  const manifest = withFinalNewline(`# SetterFi handover manifest

Generated at: \`${input.generatedAt}\`
Source commit: \`${input.sourceCommit}\`
Operator guides: ${input.guides.length}
Audit actions: ${input.auditActions.length}
Alert rules: ${input.alertRules.length}

This manifest proves deterministic source generation only. It is not provider, deployment,
recording, browser, or live-UAT evidence. Input-required placeholders remain unapproved.

| File | SHA-256 |
| --- | --- |
${manifestRows}`);
  return { files: { ...contentFiles, "MANIFEST.md": manifest }, hashes };
}

export function parseHandoverManifestMetadata(manifest: string): HandoverMetadata {
  const generatedAt = manifest.match(/^Generated at: `([^`]+)`$/mu)?.[1];
  const sourceCommit = manifest.match(/^Source commit: `([0-9a-f]+)`$/mu)?.[1];
  if (!generatedAt || !sourceCommit) throw new Error("HANDOVER_MANIFEST_METADATA_MISSING");
  const metadata = { generatedAt, sourceCommit };
  assertHandoverMetadata(metadata);
  return metadata;
}

export function handoverDrift(
  expected: Readonly<Record<string, string>>,
  generated: GeneratedPhase8Handover,
) {
  const files: readonly (HandoverContentFile | "MANIFEST.md")[] = [
    ...HANDOVER_CONTENT_FILES,
    "MANIFEST.md",
  ];
  return files.filter(
    (file) => expected[file] !== generated.files[file],
  );
}
