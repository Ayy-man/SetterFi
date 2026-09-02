import { describe, expect, it } from "vitest";

import { PROVISIONING_STEPS, READINESS_KEYS, type ProvisioningState } from "./contracts";
import {
  EXECUTION_LANES,
  PROVISIONING_STEP_REGISTRY,
  WIZARD_CRITICAL_STEPS,
  selectRunnableProvisioningSteps,
  topologicalProvisioningSteps,
  type ProvisioningStepDefinition,
} from "./steps";

describe("provisioning step registry", () => {
  it("matches the database's exact seventeen values once each", () => {
    expect(PROVISIONING_STEP_REGISTRY.map(({ key }) => key)).toEqual(PROVISIONING_STEPS);
    expect(new Set(PROVISIONING_STEP_REGISTRY.map(({ key }) => key)).size).toBe(17);
  });

  it("keeps Lane 0 separate from the five independently runnable lanes", () => {
    expect(EXECUTION_LANES).toEqual(["A", "B", "C", "D", "E"]);
    expect(PROVISIONING_STEP_REGISTRY.filter(({ lane }) => lane === "0").map(({ key }) => key))
      .toEqual(["account", "billing"]);
  });

  it("gives account and billing their declared non-executor semantics", () => {
    expect(PROVISIONING_STEP_REGISTRY.find(({ key }) => key === "account")).toMatchObject({
      owner: "automatic",
      dependencies: [],
      executorSymbol: null,
      completionAuthority: "complete_onboarding_signup",
      maxAttempts: 1,
    });
    expect(PROVISIONING_STEP_REGISTRY.find(({ key }) => key === "billing")).toMatchObject({
      owner: "platform",
      executorSymbol: null,
      completionAuthority: "phase6_subscription_port",
      restingState: "awaiting_platform",
      restingCode: "subscription_contract_unavailable",
    });
  });

  it("keeps every SMS Lane B step out of the wizard's critical path", () => {
    const smsSteps = PROVISIONING_STEP_REGISTRY
      .filter(({ lane }) => lane === "B")
      .map(({ key }) => key);
    expect(smsSteps).toHaveLength(6);
    expect(smsSteps.every((step) => !WIZARD_CRITICAL_STEPS.includes(step))).toBe(true);
  });

  it("topologically orders the full acyclic registry and rejects cycles", () => {
    const ordered = topologicalProvisioningSteps();
    expect(ordered).toHaveLength(17);
    for (const definition of PROVISIONING_STEP_REGISTRY) {
      for (const dependency of definition.dependencies) {
        expect(ordered.indexOf(dependency)).toBeLessThan(ordered.indexOf(definition.key));
      }
    }

    const cyclic = PROVISIONING_STEP_REGISTRY.map((definition) =>
      definition.key === "account"
        ? { ...definition, dependencies: ["go_live"] as const }
        : definition
    ) satisfies readonly ProvisioningStepDefinition[];
    expect(() => topologicalProvisioningSteps(cyclic)).toThrow(/PROVISIONING_STEP_REGISTRY_CYCLE/);
  });

  it("rejects missing and duplicate registry values rather than silently drifting", () => {
    expect(() => topologicalProvisioningSteps(PROVISIONING_STEP_REGISTRY.slice(1)))
      .toThrow("PROVISIONING_STEP_REGISTRY_INCOMPLETE");
    expect(() => topologicalProvisioningSteps([
      ...PROVISIONING_STEP_REGISTRY,
      PROVISIONING_STEP_REGISTRY[0],
    ])).toThrow(/PROVISIONING_STEP_REGISTRY_DUPLICATE:account/);
  });

  it("selects runnable executor steps deterministically without retrying blocked work", () => {
    const states: Partial<Record<(typeof PROVISIONING_STEPS)[number], ProvisioningState>> = {
      account: "done",
      billing: "awaiting_platform",
      ghl_location: "pending",
      meta_connect: "pending",
      whatsapp_connect: "blocked",
      calendar_connect: "pending",
      offer_layer: "pending",
    };
    expect(selectRunnableProvisioningSteps(states)).toEqual([
      "ghl_location",
      "meta_connect",
      "calendar_connect",
      "offer_layer",
    ]);
  });
});

describe("readiness contract", () => {
  it("pins exactly seven keys with any-live messaging and no SMS-only predicate", () => {
    expect(READINESS_KEYS).toEqual([
      "tenant_active",
      "messaging_channel_live",
      "primary_calendar_healthy",
      "published_offer_ready",
      "platform_brain_published",
      "test_passed",
      "subscription_ready",
    ]);
    expect(READINESS_KEYS).toHaveLength(7);
    expect(READINESS_KEYS.some((key) => key.includes("sms"))).toBe(false);
  });
});
