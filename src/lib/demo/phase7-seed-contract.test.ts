import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const seed = readFileSync(resolve(root, "scripts/seed-phase7-demo.mjs"), "utf8");
const reset = readFileSync(resolve(root, "scripts/reset-phase7-demo.mjs"), "utf8");
const run = readFileSync(resolve(root, "scripts/run-phase7-demo.mjs"), "utf8");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const envVerifier = readFileSync(resolve(root, "scripts/verify-env-contract.mjs"), "utf8");

describe("Phase 7 demo seed contract", () => {
  it("requires the Phase 6 evidence and never writes Phase 6 money tables", () => {
    expect(seed).toContain("PHASE6_DEMO_SEED_MISSING");
    for (const table of [
      "billing_subscriptions", "tier_price_versions", "tenant_price_overrides",
      "commission_ledger", "commission_payouts", "tenant_cost_rollups",
    ]) {
      expect(seed).not.toMatch(new RegExp(`(?:insert\\s+into|update|delete\\s+from)\\s+public\\.${table}`, "i"));
    }
  });

  it("uses real Phase 7 writers and an explicit read-only idempotency arm", () => {
    for (const writer of [
      "record_conversation_step_events", "record_provider_appointment",
      "create_challenger_model_config", "start_eval_comparison", "record_eval_run",
      "finish_eval_comparison", "create_test_agent_session", "persist_test_agent_turn",
      "promote_eval_case",
    ]) expect(seed).toContain(writer);
    expect(seed).toContain('argumentsList.includes("--verify-idempotent")');
    expect(run).toContain("read_only=true");
  });

  it("keeps bodies synthetic, unapproved, and demo segregated", () => {
    expect(seed).not.toMatch(/approved\s*[=:]\s*true/i);
    expect(seed).not.toContain("legacy-strong-notion");
    expect(seed).toContain("SETTERFI_DEMO_PLACEHOLDER_");
    expect(seed).toContain("source_tenant_id");
    expect(run).toContain("non_placeholder_messages");
    expect(run).toContain("approved_consent");
  });

  it("refuses wrong ancestry and resets only the Phase 7 labelled fixture", () => {
    expect(seed).toContain("PHASE7_DEMO_TENANT_ANCESTRY_REFUSED");
    expect(reset).toContain("PHASE7_DEMO_TENANT_ANCESTRY_REFUSED");
    expect(reset).not.toContain("resetPhase6Demo");
    expect(reset).toContain("fixed_fixture_scope_only=true");
  });

  /**
   * The demo's story runs on a rolling clock, not on dates.
   *
   * Every timestamp in this seed used to be a `2026-06-*` literal. Coach Home defaults to a
   * one-month window, so once the calendar moved past July every figure on the page read "not
   * yet" and the client read a working product as a broken one. `350eb9e` replaced the literals
   * with `demoDay(dayOffset, minuteOffset)`, anchored `DEMO_SPAN_START_DAYS` days before now.
   *
   * That commit missed one: `record_provider_appointment` still pinned the demo's single booked
   * call to `2026-08-15T15:00:00Z`, so the headline figure on Home was the one still on a fixed
   * date. Nothing here noticed, because this file reads the seed's source text and had no opinion
   * about dates. It has one now.
   */
  it("writes no story timestamp as a date literal", () => {
    // Everything after the last import, so a date inside a module specifier cannot register.
    const body = seed.slice(seed.lastIndexOf("import "));
    const literals = [...body.matchAll(/'(\d{4}-\d{2}-\d{2}T[^']*)'/gu)].map((m) => m[1]);

    // The one permitted literal is not a story timestamp: it is the far-future `token_expires_at`
    // on the seeded `ghl_installs` row, whose only job is to mean "this install is not expired".
    const storyDates = literals.filter((value) => !value.startsWith("2030-01-01"));

    expect(storyDates, `date literals that should be demoDay() calls: ${storyDates.join(", ")}`)
      .toEqual([]);
  });

  it("lands every offset it actually calls inside Home's one-month window", async () => {
    // Read the offsets out of the seed rather than restating them, so an offset added later is
    // covered without anyone remembering to add it here.
    const offsets = [...seed.matchAll(/demoDay\((\d+)(?:,\s*(\d+))?\)/gu)]
      .map((m) => [Number(m[1]), Number(m[2] ?? 0)] as const);
    expect(offsets.length).toBeGreaterThan(15);

    const { demoDay } = await import("../../../scripts/seed-phase7-demo.mjs");
    const now = Date.now();
    const windowMs = 31 * 24 * 60 * 60 * 1000;

    for (const [day, minute] of offsets) {
      const at = Date.parse(demoDay(day, minute));
      expect(Number.isNaN(at), `demoDay(${day}, ${minute}) is not a date`).toBe(false);
      expect(at, `demoDay(${day}, ${minute}) is in the future`).toBeLessThanOrEqual(now);
      expect(now - at, `demoDay(${day}, ${minute}) falls outside the one-month window`)
        .toBeLessThan(windowMs);
    }
  });

  it("registers all three package scripts in the names-only verifier", () => {
    for (const name of ["demo:seed-phase7", "demo:run-phase7", "demo:reset-phase7"]) {
      expect(packageJson.scripts[name]).toBeTypeOf("string");
      expect(envVerifier).toContain(`"${name}"`);
    }
  });
});
