import { describe, expect, it } from "vitest";

import {
  buildEmittedAlertRuleBindings,
  PHASE8_OWNER_ARRAYS,
  PREBUILT_ALERT_RULE_BINDINGS,
  PREBUILT_ALERT_RULES,
} from "./phase8-contracts";
import {
  ALERT_RULES_WITHOUT_EMITTER,
  EMITTED_ALERT_RULE_BINDING_COUNT,
  EMITTED_ALERT_RULE_BINDINGS,
  EMITTED_ALERT_RULE_KEYS,
} from "./source-contract";

describe("Phase 8 alert source contract", () => {
  it("keeps the traced emitted-owner catalog duplicate-free and sorted", () => {
    expect(EMITTED_ALERT_RULE_BINDING_COUNT).toBe(EMITTED_ALERT_RULE_BINDINGS.length);
    expect(new Set(EMITTED_ALERT_RULE_KEYS).size).toBe(EMITTED_ALERT_RULE_KEYS.length);
    expect(EMITTED_ALERT_RULE_KEYS).toEqual([...EMITTED_ALERT_RULE_KEYS].sort());
  });

  it("does not treat declared but uncalled event types as emitted bindings", () => {
    const bindings = buildEmittedAlertRuleBindings(PHASE8_OWNER_ARRAYS);
    expect(bindings).toContainEqual({ eventKey: "appointment.booked", scope: "tenant" });
    expect(bindings).toContainEqual({ eventKey: "billing.payment_failed", scope: "tenant" });
    expect(bindings).toContainEqual({ eventKey: "channel.disconnected", scope: "tenant" });
    expect(bindings).toContainEqual({ eventKey: "onboarding.a2p_cleared", scope: "tenant" });
    expect(bindings).toContainEqual({ eventKey: "agent.inactive_72h", scope: "tenant" });
    expect(bindings).toContainEqual({ eventKey: "onboarding.stalled", scope: "tenant" });
    expect(bindings).toContainEqual({ eventKey: "billing.payment_completed", scope: "tenant" });
    expect(bindings).not.toContainEqual({ eventKey: "conversation.needs_human", scope: "tenant" });
    expect(bindings).not.toContainEqual({ eventKey: "onboarding.stalled_external", scope: "tenant" });
  });

  it("pins the eight requested rules to seven durable notification events", () => {
    expect(PREBUILT_ALERT_RULES).toHaveLength(8);
    expect(PREBUILT_ALERT_RULE_BINDINGS).toEqual([
      { eventKey: "appointment.booked", scope: "tenant" },
      { eventKey: "billing.payment_failed", scope: "tenant" },
      { eventKey: "channel.disconnected", scope: "tenant" },
      { eventKey: "onboarding.a2p_cleared", scope: "tenant" },
      { eventKey: "agent.inactive_72h", scope: "tenant" },
      { eventKey: "onboarding.stalled", scope: "tenant" },
      { eventKey: "billing.payment_completed", scope: "tenant" },
      { eventKey: "billing.tier_upgraded", scope: "tenant" },
    ]);
    // Every prebuilt rule now has an emitter behind it, so the old check over the unbound set is
    // vacuously true. The invariant worth keeping is the one that holds in both directions: a rule
    // either has bindings and no reason, or no bindings and a stated reason. Anything else is a
    // rule claiming an emitter it does not have, or hiding one it does.
    expect(ALERT_RULES_WITHOUT_EMITTER.map((rule) => rule.id)).toEqual([]);
    expect(PREBUILT_ALERT_RULES.every((rule) => (
      rule.bindings.length > 0 ? rule.unboundReason === null : rule.unboundReason !== null
    ))).toBe(true);
  });

  it.each([
    ["alertEventKeys", "conversation.needs_human", "PHASE3_ALERT_EVENTS_MISSING"],
    ["channelEventKeys", "message_template.rejected", "PHASE4_CHANNEL_EVENTS_MISSING"],
    ["onboardingAlertKeys", "onboarding.stalled_system:platform", "PHASE5_ALERT_EMITTERS_MISSING"],
    ["billingEventKeys", "billing.payment_failed", "PHASE6_BILLING_EVENTS_MISSING"],
    ["channelEventKeys", "onboarding.a2p_cleared", "PHASE8_CHANNEL_EVENTS_MISSING"],
    ["billingEventKeys", "billing.payment_completed", "PHASE8_BILLING_EVENTS_MISSING"],
  ] as const)("fails loud when %s loses %s", (owner, missing, code) => {
    expect(() => buildEmittedAlertRuleBindings({
      ...PHASE8_OWNER_ARRAYS,
      [owner]: PHASE8_OWNER_ARRAYS[owner].filter((key) => key !== missing),
    })).toThrow(code);
  });
});
