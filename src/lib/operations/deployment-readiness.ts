/** Low-information deployment readiness for load balancers and release automation. */

import { authMode } from "@/lib/auth/mode";
import {
  driverSelection,
  environmentValue,
  phase1Live,
  phase3Live,
  phase4Live,
  phase5Live,
  phase6Live,
  phase6StripeLive,
  phase7AnalyticsLive,
  phase7EvalsLive,
  phase8AlertRuleEventsLive,
  phase8AlertsLive,
  phase8EngineEvalLive,
  phase9GhlOAuthLive,
  requireEnvironment,
  type DriverName,
  type DriverSelectorName,
  type EnvironmentName,
  type EnvironmentSource,
} from "@/lib/env-contract";
import {
  EMAIL_CONFIGURATION_NAMES,
  GHL_AGENCY_OAUTH_CONFIGURATION_NAMES,
  GHL_CONFIGURATION_NAMES,
  GHL_PROVISIONING_CONFIGURATION_NAMES,
  META_CONFIGURATION_NAMES,
} from "@/lib/integrations/selector";
import { STRIPE_CONFIGURATION_NAMES } from "@/lib/integrations/stripe/selector";
import { readJobReceipts, type SystemJobReceipt } from "@/lib/repositories/job-receipts";

export type DeploymentReadiness = {
  status: "ready" | "unready";
  configuration: boolean;
  database: boolean;
  automation: boolean;
  requiredProviders: boolean;
};

export type DeploymentReadinessDependencies = {
  environment?: EnvironmentSource;
  readReceipts?: () => Promise<readonly SystemJobReceipt[]>;
  timeoutMs?: number;
};

type ProviderRequirement = {
  driver: DriverName;
  selector: DriverSelectorName;
  names: readonly EnvironmentName[];
};

const DEFAULT_TIMEOUT_MS = 1_500;

function requiredJobs(environment: EnvironmentSource) {
  const jobs = new Set<string>();
  if (phase1Live(environment)) {
    jobs.add("appointment-reconcile");
    jobs.add("contact-deletion-recovery");
    jobs.add("ghl-install-reconcile");
    jobs.add("inbound-recovery");
  }
  if (phase1Live(environment) && phase3Live(environment)) {
    jobs.add("compliance-reconcile");
    jobs.add("followups");
    jobs.add("outbound-reconciliation");
  }
  if (phase5Live(environment)) {
    jobs.add("a2p-probe");
    jobs.add("provisioning-run");
  }
  if (phase6Live(environment)) {
    jobs.add("billing-allowances");
    jobs.add("billing-cost-rollup");
  }
  if (phase6StripeLive(environment)) jobs.add("stripe-webhooks");
  if (phase7AnalyticsLive(environment)) jobs.add("tenant-health-rollup");
  if (phase8AlertsLive(environment)) jobs.add("notification-deliveries");
  if (phase8AlertRuleEventsLive(environment)) {
    jobs.add("agent-inactivity-sweep");
    jobs.add("tier-change-reconcile");
  }
  if (phase8EngineEvalLive(environment)) jobs.add("engine-evals");
  return jobs;
}

function requiredProviderConfiguration(environment: EnvironmentSource) {
  const requirements: ProviderRequirement[] = [];
  if (phase1Live(environment)) {
    requirements.push(
      { driver: "ghl", selector: "SETTERFI_GHL_DRIVER", names: GHL_CONFIGURATION_NAMES },
      { driver: "openrouter", selector: "SETTERFI_OPENROUTER_DRIVER", names: ["OPENROUTER_API_KEY"] },
    );
  }
  if (phase4Live(environment)) {
    requirements.push({ driver: "meta", selector: "SETTERFI_META_DRIVER", names: META_CONFIGURATION_NAMES });
  }
  if (phase5Live(environment)) {
    requirements.push({
      driver: "ghl_provisioning",
      selector: "SETTERFI_GHL_PROVISIONING_DRIVER",
      names: GHL_PROVISIONING_CONFIGURATION_NAMES,
    });
  }
  if (phase6StripeLive(environment)) {
    requirements.push({ driver: "stripe", selector: "SETTERFI_STRIPE_DRIVER", names: STRIPE_CONFIGURATION_NAMES });
  }
  if (phase7EvalsLive(environment) || phase8EngineEvalLive(environment)) {
    requirements.push({ driver: "openrouter", selector: "SETTERFI_OPENROUTER_DRIVER", names: ["OPENROUTER_API_KEY"] });
  }
  if (phase8AlertsLive(environment)) {
    requirements.push(
      { driver: "email", selector: "SETTERFI_EMAIL_DRIVER", names: EMAIL_CONFIGURATION_NAMES },
    );
  }
  return requirements;
}

function configurationReady(environment: EnvironmentSource, jobs: ReadonlySet<string>) {
  try {
    authMode(environment);
  } catch {
    return false;
  }
  const baseline: EnvironmentName[] = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  if (jobs.size > 0) baseline.push("CRON_SECRET");
  return baseline.every((name) => Boolean(environmentValue(name, environment)));
}

function providersReady(environment: EnvironmentSource) {
  try {
    for (const requirement of requiredProviderConfiguration(environment)) {
      if (driverSelection(requirement.driver, requirement.selector, environment) !== "real") return false;
      requireEnvironment(requirement.driver, requirement.names, environment);
    }
    if (phase9GhlOAuthLive(environment)) {
      requireEnvironment("ghl", GHL_AGENCY_OAUTH_CONFIGURATION_NAMES, environment);
    }
    return true;
  } catch {
    return false;
  }
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("READINESS_PROBE_TIMEOUT")), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function loadDeploymentReadiness(
  dependencies: DeploymentReadinessDependencies = {},
): Promise<DeploymentReadiness> {
  const environment = dependencies.environment ?? process.env;
  const jobs = requiredJobs(environment);
  const configuration = configurationReady(environment, jobs);
  const requiredProviders = providersReady(environment);
  let database = false;
  let automation = jobs.size === 0;

  try {
    const receipts = await withTimeout(
      (dependencies.readReceipts ?? readJobReceipts)(),
      dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    database = true;
    automation = [...jobs].every((job) => receipts.some((receipt) =>
      receipt.job === job && receipt.outcome === "succeeded" && receipt.freshness === "fresh",
    ));
  } catch {
    database = false;
    automation = false;
  }

  const ready = configuration && database && automation && requiredProviders;
  return {
    status: ready ? "ready" : "unready",
    configuration,
    database,
    automation,
    requiredProviders,
  };
}
