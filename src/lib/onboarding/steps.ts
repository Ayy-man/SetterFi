/**
 * The sole code-owned map from the database's seventeen step keys to execution policy.
 *
 * Lane 0 is the transactional bootstrap; A-E are the five independently runnable lanes. Keeping
 * lane membership here avoids a mutable database column that could disagree with the step key.
 */

import {
  PROVISIONING_STEPS,
  type ProvisioningState,
  type ProvisioningStep,
} from "./contracts";

export const EXECUTION_LANES = ["A", "B", "C", "D", "E"] as const;
export type ExecutionLane = (typeof EXECUTION_LANES)[number];
export type ProvisioningLane = "0" | ExecutionLane;
export type ProvisioningOwner = "automatic" | "coach" | "platform" | "provider";
export type RetryClass = "none" | "automatic" | "coach_action";
export type ProvisioningCompletionAuthority =
  | "complete_onboarding_signup"
  | "phase6_subscription_port"
  | "runner"
  | "provider_probe";

export type ProvisioningStepDefinition = {
  key: ProvisioningStep;
  lane: ProvisioningLane;
  owner: ProvisioningOwner;
  dependencies: readonly ProvisioningStep[];
  retryClass: RetryClass;
  maxAttempts: number;
  executorSymbol: string | null;
  completionAuthority: ProvisioningCompletionAuthority;
  wizardCritical: boolean;
  restingState?: Extract<ProvisioningState, "awaiting_platform">;
  restingCode?: "subscription_contract_unavailable";
};

export const PROVISIONING_STEP_REGISTRY: readonly ProvisioningStepDefinition[] = [
  {
    key: "account",
    lane: "0",
    owner: "automatic",
    dependencies: [],
    retryClass: "none",
    maxAttempts: 1,
    executorSymbol: null,
    completionAuthority: "complete_onboarding_signup",
    wizardCritical: true,
  },
  {
    key: "billing",
    lane: "0",
    owner: "platform",
    dependencies: ["account"],
    retryClass: "none",
    maxAttempts: 0,
    executorSymbol: null,
    completionAuthority: "phase6_subscription_port",
    wizardCritical: false,
    restingState: "awaiting_platform",
    restingCode: "subscription_contract_unavailable",
  },
  {
    key: "ghl_location",
    lane: "A",
    owner: "automatic",
    dependencies: ["account"],
    retryClass: "automatic",
    maxAttempts: 5,
    executorSymbol: "executeGhlLocation",
    completionAuthority: "runner",
    wizardCritical: false,
  },
  {
    key: "ghl_snapshot",
    lane: "A",
    owner: "automatic",
    dependencies: ["ghl_location"],
    retryClass: "automatic",
    maxAttempts: 5,
    executorSymbol: "executeGhlSnapshot",
    completionAuthority: "runner",
    wizardCritical: false,
  },
  {
    key: "phone_number",
    lane: "A",
    owner: "automatic",
    dependencies: ["ghl_snapshot"],
    retryClass: "automatic",
    maxAttempts: 5,
    executorSymbol: "executePhoneNumber",
    completionAuthority: "runner",
    wizardCritical: false,
  },
  {
    key: "sms_eligibility_screen",
    lane: "B",
    owner: "coach",
    dependencies: ["phone_number"],
    retryClass: "coach_action",
    maxAttempts: 0,
    executorSymbol: null,
    completionAuthority: "runner",
    wizardCritical: false,
  },
  {
    key: "business_profile",
    lane: "B",
    owner: "coach",
    dependencies: ["sms_eligibility_screen"],
    retryClass: "coach_action",
    maxAttempts: 0,
    executorSymbol: null,
    completionAuthority: "runner",
    wizardCritical: false,
  },
  {
    key: "optin_artifact",
    lane: "B",
    owner: "coach",
    dependencies: ["business_profile"],
    retryClass: "coach_action",
    maxAttempts: 0,
    executorSymbol: null,
    completionAuthority: "runner",
    wizardCritical: false,
  },
  {
    key: "a2p_brand",
    lane: "B",
    owner: "automatic",
    dependencies: ["phone_number", "business_profile", "optin_artifact"],
    retryClass: "automatic",
    maxAttempts: 5,
    executorSymbol: "executeA2pBrand",
    completionAuthority: "runner",
    wizardCritical: false,
  },
  {
    key: "a2p_campaign",
    lane: "B",
    owner: "automatic",
    dependencies: ["a2p_brand", "optin_artifact"],
    retryClass: "automatic",
    maxAttempts: 5,
    executorSymbol: "executeA2pCampaign",
    completionAuthority: "runner",
    wizardCritical: false,
  },
  {
    key: "sms_live",
    lane: "B",
    owner: "provider",
    dependencies: ["a2p_campaign"],
    retryClass: "automatic",
    maxAttempts: 21,
    executorSymbol: null,
    completionAuthority: "provider_probe",
    wizardCritical: false,
  },
  {
    key: "meta_connect",
    lane: "C",
    owner: "coach",
    dependencies: ["account"],
    retryClass: "coach_action",
    maxAttempts: 0,
    executorSymbol: "executeMetaConnect",
    completionAuthority: "runner",
    wizardCritical: true,
  },
  {
    key: "whatsapp_connect",
    lane: "C",
    owner: "coach",
    dependencies: ["account"],
    retryClass: "coach_action",
    maxAttempts: 0,
    executorSymbol: "executeWhatsappConnect",
    completionAuthority: "runner",
    wizardCritical: true,
  },
  {
    key: "calendar_connect",
    lane: "C",
    owner: "coach",
    dependencies: ["account"],
    retryClass: "coach_action",
    maxAttempts: 0,
    executorSymbol: "executeCalendarConnect",
    completionAuthority: "runner",
    wizardCritical: true,
  },
  {
    key: "offer_layer",
    lane: "D",
    owner: "coach",
    dependencies: ["account"],
    retryClass: "coach_action",
    maxAttempts: 0,
    executorSymbol: "executeOfferLayer",
    completionAuthority: "runner",
    wizardCritical: true,
  },
  {
    key: "test_pass",
    lane: "E",
    owner: "automatic",
    dependencies: ["calendar_connect", "offer_layer"],
    retryClass: "automatic",
    maxAttempts: 3,
    executorSymbol: "executeTestPass",
    completionAuthority: "runner",
    wizardCritical: true,
  },
  {
    key: "go_live",
    lane: "E",
    owner: "coach",
    dependencies: ["test_pass"],
    retryClass: "coach_action",
    maxAttempts: 0,
    executorSymbol: "executeGoLive",
    completionAuthority: "runner",
    wizardCritical: true,
  },
] as const;

export const WIZARD_CRITICAL_STEPS = PROVISIONING_STEP_REGISTRY
  .filter((definition) => definition.wizardCritical)
  .map((definition) => definition.key);

function registryMap(registry: readonly ProvisioningStepDefinition[]) {
  const definitions = new Map<ProvisioningStep, ProvisioningStepDefinition>();
  for (const definition of registry) {
    if (definitions.has(definition.key)) {
      throw new Error(`PROVISIONING_STEP_REGISTRY_DUPLICATE:${definition.key}`);
    }
    definitions.set(definition.key, definition);
  }
  if (
    definitions.size !== PROVISIONING_STEPS.length
    || PROVISIONING_STEPS.some((step) => !definitions.has(step))
  ) {
    throw new Error("PROVISIONING_STEP_REGISTRY_INCOMPLETE");
  }
  return definitions;
}

export function topologicalProvisioningSteps(
  registry: readonly ProvisioningStepDefinition[] = PROVISIONING_STEP_REGISTRY,
) {
  const definitions = registryMap(registry);
  const visiting = new Set<ProvisioningStep>();
  const visited = new Set<ProvisioningStep>();
  const ordered: ProvisioningStep[] = [];

  const visit = (step: ProvisioningStep) => {
    if (visited.has(step)) return;
    if (visiting.has(step)) throw new Error(`PROVISIONING_STEP_REGISTRY_CYCLE:${step}`);
    visiting.add(step);
    const definition = definitions.get(step)!;
    for (const dependency of definition.dependencies) {
      if (!definitions.has(dependency)) {
        throw new Error(`PROVISIONING_STEP_DEPENDENCY_MISSING:${step}:${dependency}`);
      }
      visit(dependency);
    }
    visiting.delete(step);
    visited.add(step);
    ordered.push(step);
  };

  for (const step of PROVISIONING_STEPS) visit(step);
  return ordered;
}

export function selectRunnableProvisioningSteps(
  states: Readonly<Partial<Record<ProvisioningStep, ProvisioningState>>>,
  registry: readonly ProvisioningStepDefinition[] = PROVISIONING_STEP_REGISTRY,
) {
  const definitions = registryMap(registry);
  return topologicalProvisioningSteps(registry).filter((step) => {
    const definition = definitions.get(step)!;
    return states[step] === "pending"
      && definition.executorSymbol !== null
      && definition.dependencies.every((dependency) => states[dependency] === "done");
  });
}
