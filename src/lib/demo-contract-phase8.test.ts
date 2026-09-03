import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PHASE8_DEMO_IDS,
  PHASE8_DEMO_VALUES,
  PHASE8_MOCK_DRIVER_NAMES,
  assertPhase8Demo,
  withPhase8MockDrivers,
} from "../../scripts/seed-phase8-demo.mjs";
import { DEMO_ALERT_COPY } from "../../scripts/fixtures/names.mjs";

const root = process.cwd();
const original = Object.fromEntries(PHASE8_MOCK_DRIVER_NAMES.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("Phase 8 demo contract", () => {
  it("fails by the named upstream seams and forces every outbound selector to mock", async () => {
    const source = readFileSync(resolve(root, "scripts/seed-phase8-demo.mjs"), "utf8");
    for (const code of ["PHASE5_DEMO_SEED_MISSING", "PHASE6_DEMO_SEED_MISSING", "PHASE7_DEMO_SEED_MISSING"]) {
      expect(source).toContain(code);
    }
    for (const name of PHASE8_MOCK_DRIVER_NAMES) process.env[name] = "real";
    await withPhase8MockDrivers(async () => {
      for (const name of PHASE8_MOCK_DRIVER_NAMES) expect(process.env[name]).toBe("mock");
    });
    for (const name of PHASE8_MOCK_DRIVER_NAMES) expect(process.env[name]).toBe("real");
  });

  it("keeps content synthetic, fixed-id reset narrow, and approval absent", () => {
    const seed = readFileSync(resolve(root, "scripts/seed-phase8-demo.mjs"), "utf8");
    const reset = readFileSync(resolve(root, "scripts/reset-phase8-demo.mjs"), "utf8");
    expect(seed).not.toMatch(/approved\s*[=:]\s*true/u);
    // Every seeded value still has to announce itself as synthetic. The `(demo)` marker does that
    // in copy a coach can read, where the raw sentinel only ever read as a broken screen.
    for (const value of Object.values(PHASE8_DEMO_VALUES)) expect(value).toMatch(/\(demo\)|example\.invalid/u);
    expect(reset).toContain("PHASE8_DEMO_RESET_ANCESTRY_REFUSED");
    expect(reset).not.toMatch(/delete from public\.tenants|truncate|db reset/iu);
    expect(reset).toContain("session_replication_role=replica");
  });

  it("requires persisted support visibility, mock receipts, retries, and both export scopes", () => {
    const snapshot = {
      tenant: { is_demo: true, success_owner: PHASE8_DEMO_IDS.success,
        billing_contact_email: PHASE8_DEMO_VALUES.billingEmail },
      counts: { threads: 1, messages: 3, coach_messages: 2, preferences: 1, demo_rules: 1,
        notifications: 3, deliveries: 3, attempts: 3 },
      deliveries: [
        { id: PHASE8_DEMO_IDS.emailDelivery, status: "accepted", attempts: 1, provider_reference: "mock-email:phase8" },
      ],
      attempts: [
        { id: PHASE8_DEMO_IDS.emailAttempt, recipient_email: PHASE8_DEMO_VALUES.billingEmail, outcome: "accepted" },
      ],
      audit: [
        { action: "platform_export.started", reason: PHASE8_DEMO_VALUES.namedExportReason,
          target_type: "platform_export_tenant", target_id: PHASE8_DEMO_IDS.tenant },
        { action: "platform_export.finished", reason: PHASE8_DEMO_VALUES.namedExportReason },
        { action: "platform_export.started", reason: PHASE8_DEMO_VALUES.resourceExportReason,
          target_type: "platform_export", target_id: "notification-deliveries" },
        { action: "platform_export.finished", reason: PHASE8_DEMO_VALUES.resourceExportReason },
        { action: "platform_export.started", reason: PHASE8_DEMO_VALUES.abortedExportReason },
      ],
      exclusionCounts: { tenants: 0, contacts: 0, conversations: 0, messages: 0 },
    };
    expect(assertPhase8Demo(snapshot)).toBe(snapshot);
  });

  it("makes the runner prove replay, CSV and JSON framing, unmatched abort, and zero reset", () => {
    const source = readFileSync(resolve(root, "scripts/run-phase8-demo.mjs"), "utf8");
    expect(source).toContain("PHASE8_DEMO_REPLAY_CHANGED_COUNTS");
    expect(source).toContain("PHASE8_DEMO_EXPORT_FRAMING_FAILED");
    expect(source).toContain("exports=named+resource+aborted");
    expect(source).toContain("resetPhase8Demo");
  });

  it("keeps every ROADMAP criterion named and the database gate in the required order", () => {
    const gate = readFileSync(resolve(root, "scripts/phase8-gate.mjs"), "utf8");
    for (const value of [
      "Support isolation/reassignment",
      "Registry/destinations/attempts",
      "Rendered exports/scoping/audits",
      "Handover usability/generation",
      "supabase/tests/phase8-rls.test.ts",
      "src/lib/support/service.test.ts",
      "src/lib/notifications/delivery.test.ts",
      "src/lib/exports/rendered-tables.test.ts",
      "src/lib/handover/generator.test.ts",
      "PHASE8_CRITERION_TEST_MISSING",
      "PHASE8_CRITERION_4_BLOCKED",
    ]) expect(gate).toContain(value);
    const ordered = [
      'run("npm", ["test"',
      'run("npm", ["run", "demo:env-check"]',
      'run("npm", ["run", "db:migrate"]',
      'run("npm", ["run", "generate:handover"',
      'run("npm", ["run", "test:rls"]',
      'run("npm", ["run", "verify"]',
      'run("npm", ["run", "build"]',
    ].map((value) => gate.indexOf(value));
    expect(ordered.every((index) => index >= 0)).toBe(true);
    expect(ordered).toEqual([...ordered].sort((left, right) => left - right));
    expect(gate).not.toContain("supabase db reset");
  });
});
