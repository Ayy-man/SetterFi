import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AUDIT_ACTION_KEYS,
  AUDIT_ACTIONS,
  PHASE7_AUDIT_KEYS,
  PHASE8_AUDIT_KEYS,
} from "@/lib/audit/actions";

const SEEDED_ACTION_MICROCOPY = [
  ["appointment.attendance_set", "Attendance logged"],
  ["appointment.attendance_set.system", "Attendance logged"],
  ["appointment.canceled", "Cancellation logged"],
  ["appointment.created", "Booking logged"],
  ["appointment.rescheduled", "Reschedule logged"],
  // Phase 6
  ["affiliate.payout.approved", "Payout approval logged"],
  ["affiliate.payout.sent", "Payout sent record logged"],
  ["billing.checkout.created", "Checkout logged"],
  ["billing.correction.approved", "Correction approval logged"],
  ["billing.correction.rejected", "Correction rejection logged"],
  ["billing.correction.requested", "Correction request logged"],
  ["billing.tenant.suspended", "Suspension logged"],
  ["billing.tenant.unsuspended", "Reactivation logged"],
  ["billing.tenant_override.updated", "Price override logged"],
  ["billing.tier.updated", "Tier update logged"],
  ["brain.import.accepted", "Import acceptance logged"],
  ["brain.published", "Publish logged"],
  ["brain.rolled_back", "Rollback logged"],
  ["calendar.connected", "Connection logged"],
  ["calendar.disconnected", "Disconnection logged"],
  ["capi.dataset.provisioned", "Conversion tracking setup logged"],
  ["channel.connect.completed", "Connection logged"],
  ["channel.connect.started", "Connection start logged"],
  ["channel.disconnected", "Disconnection logged"],
  ["channel.provider.switched", "Provider switch logged"],
  ["channel.went_live", "Channel activation logged"],
  ["consent.opt_in", "Consent logged"],
  ["consent.opt_out", "Opt-out logged"],
  ["compliance.control_reply.published", "Publication logged"],
  ["contact.created.manual", "Contact logged"],
  ["contact.delete", "Deletion logged"],
  ["contact.imported", "Import logged"],
  ["contact.note.added", "Note logged"],
  ["contact.tag.added", "Tag logged"],
  ["contact.tag.removed", "Tag removal logged"],
  ["contact.merged", "Merge logged"],
  ["contact.pipeline_stage.set", "Logged"],
  ["contact.unmerged", "Undo logged"],
  ["conversation.channel_continued", "Continuation logged"],
  ["conversation.closed", "Closure logged"],
  ["conversation.closed.stale", "Stale closure logged"],
  ["conversation.escalated", "Escalation logged"],
  ["conversation.guardrail.cleared", "Guardrail clear logged"],
  ["conversation.internal_note.added", "Internal note added"],
  ["conversation.message.sent.human", "Message sent"],
  ["conversation.scope_blocked", "Scope block logged"],
  ["conversation.takeover.claimed", "Takeover logged"],
  ["conversation.takeover.released", "Hand-back logged"],
  // Phase 7
  ["eval.case.promoted", "Eval case promotion logged"],
  ["eval.model_config.created", "Challenger model configuration created"],
  ["export.finished", "Export completion logged"],
  ["export.started", "Export start logged"],
  ["impersonation.ended", "View-as session end logged"],
  ["impersonation.started", "View-as session logged"],
  ["keyword_goal.deactivated", "Keyword goal deactivation logged"],
  ["keyword_goal.saved", "Keyword goal saved"],
  ["message_template.rejected", "Template rejection logged"],
  ["message_template.submitted", "Template submission logged"],
  ["offer.published", "Offer publish logged"],
  ["onboarding.a2p_blocked_permanent", "Permanent registration block logged"],
  ["onboarding.a2p_filing_confirmed", "Registration filing logged"],
  ["onboarding.step_failed", "Provisioning failure logged"],
  ["onboarding.step_retried", "Retry logged"],
  ["onboarding.step_unblocked", "Unblock logged"],
  ["platform_export.finished", "Platform export completion logged"],
  ["platform_export.started", "Platform export start logged"],
  ["quiet_hours.window.change", "Quiet-hours change logged"],
  ["referral.code_rejected", "Referral refusal logged"],
  ["send.refused.no_consent", "Consent refusal logged"],
  ["send.refused.suppressed", "Suppression refusal logged"],
  ["send.refused.window_expired", "Window refusal logged"],
  ["suppression.correct", "Suppression correction logged"],
  ["suppression.insert.manual", "Suppression logged"],
  ["suppression.push.failed", "Provider suppression failure logged"],
  ["suppression.push.provider", "Provider suppression logged"],
  ["tenant.billing_contact_changed", "Billing contact change logged"],
  ["tenant.demo_flag.changed", "Demo flag change logged"],
  // Phase 8
  ["tenant.success_owner.reassigned", "Reassignment logged"],
  ["tenant.went_live", "Go-live logged"],
  // Phase 3
  ["contact.delete.preview", "Deletion preview logged"],
  ["conversation.tripwire.refused", "Tripwire refusal logged"],
  ["followup.canceled.inbound", "Follow-ups canceled"],
  ["followup.claimed", "Follow-up claim logged"],
  ["followup.completed", "Follow-up completion logged"],
  ["followup.deferred.quiet_hours", "Follow-up deferral logged"],
  ["followup.discarded.window_closed", "Follow-up discard logged"],
  ["provider.rotation.verified", "Rotation verification logged"],
  ["suppression.clear.provider", "Provider suppression cleared"],
  ["suppression.insert.keyword", "Opt-out logged"],
  ["suppression.provider.confirmed", "Provider suppression confirmed"],
  ["suppression.provider.unconfirmed", "Provider suppression unconfirmed"],
  ["test_recipient.registered", "Test recipient logged"],
  // Phase 5
  ["consent.web_form_recorded", "Consent recorded"],
  ["onboarding.artifact_confirmed", "Consent page confirmation logged"],
  ["onboarding.content_acknowledged", "Content acknowledgement logged"],
  ["onboarding.content_admin_confirmed", "Content confirmation logged"],
  ["onboarding.signup_completed", "Signup logged"],
] as const;

const PHASE3_AUDIT_KEYS = [
  "contact.delete.preview",
  "conversation.tripwire.refused",
  "followup.canceled.inbound",
  "followup.claimed",
  "followup.completed",
  "followup.deferred.quiet_hours",
  "followup.discarded.window_closed",
  "provider.rotation.verified",
  "suppression.clear.provider",
  "suppression.insert.keyword",
  "suppression.provider.confirmed",
  "suppression.provider.unconfirmed",
  "test_recipient.registered",
] as const;

const PHASE5_AUDIT_KEYS = [
  "consent.web_form_recorded",
  "onboarding.artifact_confirmed",
  "onboarding.content_acknowledged",
  "onboarding.content_admin_confirmed",
  "onboarding.signup_completed",
] as const;

const PHASE6_AUDIT_KEYS = [
  "affiliate.payout.approved",
  "affiliate.payout.sent",
  "billing.checkout.created",
  "billing.correction.approved",
  "billing.correction.rejected",
  "billing.correction.requested",
  "billing.tenant.suspended",
  "billing.tenant.unsuspended",
  "billing.tenant_override.updated",
  "billing.tier.updated",
] as const;

function quotedConstValues(source: string, name: string) {
  // The array may close as `];` or as `].sort(...)`; the cross-check is about the entries it
  // holds, not how the test that owns it chooses to order them at runtime.
  const match = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\][^\\n]*;`));
  if (!match) throw new Error(`SOURCE_ARRAY_MISSING:${name}`);
  return [...match[1].matchAll(/"([a-z0-9_.]+)"/g)].map((entry) => entry[1]);
}

describe("AUDIT_ACTIONS", () => {
  // If this fails after you added an audit action: the registry is closed to new keys. The action
  // belongs in its migration and in `AUDIT_KEYS` in supabase/tests/phase1-schema.test.ts instead.
  it("equals the sorted Plan 01 seed contract instead of accepting invented keys", () => {
    expect(AUDIT_ACTION_KEYS).toEqual(SEEDED_ACTION_MICROCOPY.map(([key]) => key).sort());
  });

  it("keeps every registry-backed Logged label equal to the Plan 01 seed", () => {
    const expected = [...SEEDED_ACTION_MICROCOPY].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0);
    expect(AUDIT_ACTION_KEYS.map((key) => [key, AUDIT_ACTIONS[key].microcopy]))
      .toEqual(expected);
  });

  it("keeps the Phase 3 migration, TypeScript registry, and exact Phase 1 array byte-identical", () => {
    const migration = readFileSync(resolve(
      process.cwd(),
      "supabase/migrations/20260819000001_phase3_compliance_safety.sql",
    ), "utf8");
    const seedBlock = migration.match(
      /insert into public\.audit_actions[\s\S]*?insert into public\.alert_rules/,
    )?.[0] ?? "";
    const migrationKeys = [...seedBlock.matchAll(/\('([a-z0-9_.]+)', '(?:human|system)'/g)]
      .map((entry) => entry[1]);
    const phase1Test = readFileSync(resolve(
      process.cwd(),
      "supabase/tests/phase1-schema.test.ts",
    ), "utf8");
    const exactArrayKeys = quotedConstValues(phase1Test, "AUDIT_KEYS")
      .filter((key) => PHASE3_AUDIT_KEYS.includes(key as (typeof PHASE3_AUDIT_KEYS)[number]));
    const registryKeys = AUDIT_ACTION_KEYS
      .filter((key) => PHASE3_AUDIT_KEYS.includes(key as (typeof PHASE3_AUDIT_KEYS)[number]));

    expect(migrationKeys).toEqual([...PHASE3_AUDIT_KEYS]);
    expect(registryKeys).toEqual([...PHASE3_AUDIT_KEYS]);
    expect(exactArrayKeys).toEqual([...PHASE3_AUDIT_KEYS]);
  });

  it("keeps the Phase 5 migration, TypeScript registry, and exact Phase 1 array byte-identical", () => {
    const migration = readFileSync(resolve(
      process.cwd(),
      "supabase/migrations/20260821000001_phase5_self_serve_onboarding.sql",
    ), "utf8");
    const seedBlock = migration.match(
      /-- Phase 5\ninsert into public\.audit_actions[\s\S]*?\n\n-- -+\n-- 5\./,
    )?.[0] ?? "";
    const migrationKeys = [...seedBlock.matchAll(/\('([a-z0-9_.]+)', '(?:human|system)'/g)]
      .map((entry) => entry[1]);
    const phase1Test = readFileSync(resolve(
      process.cwd(),
      "supabase/tests/phase1-schema.test.ts",
    ), "utf8");
    const exactArrayKeys = quotedConstValues(phase1Test, "AUDIT_KEYS")
      .filter((key) => PHASE5_AUDIT_KEYS.includes(key as (typeof PHASE5_AUDIT_KEYS)[number]));
    const registryKeys = AUDIT_ACTION_KEYS
      .filter((key) => PHASE5_AUDIT_KEYS.includes(key as (typeof PHASE5_AUDIT_KEYS)[number]));

    expect(migrationKeys).toEqual([...PHASE5_AUDIT_KEYS]);
    expect(registryKeys).toEqual([...PHASE5_AUDIT_KEYS]);
    expect(exactArrayKeys).toEqual([...PHASE5_AUDIT_KEYS]);
  });

  it("keeps the Phase 6 migration, registry, microcopy, aria labels, and exact array aligned", () => {
    const migration = readFileSync(resolve(
      process.cwd(),
      "supabase/migrations/20260822000001_phase6_money.sql",
    ), "utf8");
    const phase1Test = readFileSync(resolve(
      process.cwd(),
      "supabase/tests/phase1-schema.test.ts",
    ), "utf8");
    const migrationKeys = [...migration.matchAll(
      /\('((?:affiliate|billing)\.[a-z0-9_.]+)', '(?:human|system)'/g,
    )].map((entry) => entry[1]);
    const exactArrayKeys = quotedConstValues(phase1Test, "AUDIT_KEYS")
      .filter((key) => PHASE6_AUDIT_KEYS.includes(key as (typeof PHASE6_AUDIT_KEYS)[number]));

    expect(migrationKeys).toEqual([...PHASE6_AUDIT_KEYS]);
    expect([...exactArrayKeys].sort()).toEqual([...PHASE6_AUDIT_KEYS].sort());
    for (const key of PHASE6_AUDIT_KEYS) {
      expect(migration).toContain(`'${AUDIT_ACTIONS[key].microcopy}'`);
      expect(migration).toContain(`'${AUDIT_ACTIONS[key].ariaLabel}'`);
    }
  });

  it("keeps the Phase 7 migration, registry, and exact Phase 1 array byte-identical", () => {
    expect(PHASE7_AUDIT_KEYS).toEqual([
      "eval.case.promoted",
      "eval.model_config.created",
    ]);
    for (const key of PHASE7_AUDIT_KEYS) {
      expect(AUDIT_ACTIONS[key]).toMatchObject({
        actorKind: "human",
        scope: "platform",
        coachVisible: false,
      });
    }

    const migrationPath = resolve(
      process.cwd(),
      "supabase/migrations/20260823000001_phase7_measurement.sql",
    );
    if (!existsSync(migrationPath)) {
      // Plans 01 and 02 are independently landable in Wave 1. Before Plan 02 lands, pin its
      // ownership contract; the merged tree automatically takes the strict SQL/exact-set arm.
      const plan = readFileSync(resolve(
        process.cwd(),
        ".planning/phases/07-measurement/07-02-PLAN.md",
      ), "utf8");
      for (const key of PHASE7_AUDIT_KEYS) expect(plan).toContain(key);
      expect(plan).toContain("add both Phase 7 audit keys to sorted `AUDIT_KEYS`");
      expect(plan).toContain("supabase/migrations/20260823000001_phase7_measurement.sql");
      return;
    }

    const migration = readFileSync(migrationPath, "utf8");
    const migrationKeys = [...migration.matchAll(
      /\('((?:eval\.case\.promoted|eval\.model_config\.created))', '(?:human|system)'/g,
    )].map((entry) => entry[1]);
    const phase1Test = readFileSync(resolve(
      process.cwd(),
      "supabase/tests/phase1-schema.test.ts",
    ), "utf8");
    const exactArrayKeys = quotedConstValues(phase1Test, "AUDIT_KEYS")
      .filter((key) => PHASE7_AUDIT_KEYS.includes(key as (typeof PHASE7_AUDIT_KEYS)[number]));
    const registryKeys = AUDIT_ACTION_KEYS
      .filter((key) => PHASE7_AUDIT_KEYS.includes(key as (typeof PHASE7_AUDIT_KEYS)[number]));

    expect(migrationKeys).toEqual([...PHASE7_AUDIT_KEYS]);
    expect(registryKeys).toEqual([...PHASE7_AUDIT_KEYS]);
    expect(exactArrayKeys).toEqual([...PHASE7_AUDIT_KEYS]);
    for (const key of PHASE7_AUDIT_KEYS) {
      expect(migration).toContain(`'${AUDIT_ACTIONS[key].microcopy}'`);
      expect(migration).toContain(`'${AUDIT_ACTIONS[key].ariaLabel}'`);
    }
  });

  it("keeps the Phase 8 reassignment action exact across SQL, registry, and catalog test", () => {
    expect(PHASE8_AUDIT_KEYS).toEqual(["tenant.success_owner.reassigned"]);
    const key = PHASE8_AUDIT_KEYS[0];
    expect(AUDIT_ACTIONS[key]).toEqual({
      actorKind: "human",
      scope: "tenant",
      reasonRequired: true,
      coachVisible: false,
      microcopy: "Reassignment logged",
      ariaLabel: "Success owner reassignment recorded in the audit log",
    });
    const migration = readFileSync(resolve(
      process.cwd(),
      "supabase/migrations/20260824000001_phase8_operate_handover.sql",
    ), "utf8");
    const phase1Test = readFileSync(resolve(
      process.cwd(),
      "supabase/tests/phase1-schema.test.ts",
    ), "utf8");
    expect(migration).toContain(`'${key}'`);
    expect(migration).toContain(`'${AUDIT_ACTIONS[key].microcopy}'`);
    expect(migration).toContain(`'${AUDIT_ACTIONS[key].ariaLabel}'`);
    expect(quotedConstValues(phase1Test, "AUDIT_KEYS")).toContain(key);
  });

  it("pins the distinct claim, release, and reason-required clear actions", () => {
    expect(AUDIT_ACTIONS["conversation.takeover.claimed"]).toMatchObject({
      reasonRequired: false,
      microcopy: "Takeover logged",
    });
    expect(AUDIT_ACTIONS["conversation.takeover.released"]).toMatchObject({
      reasonRequired: false,
      microcopy: "Hand-back logged",
    });
    expect(AUDIT_ACTIONS["conversation.guardrail.cleared"]).toMatchObject({
      reasonRequired: true,
      microcopy: "Guardrail clear logged",
    });
  });
});
