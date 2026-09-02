/** Slack selection keeps demo tenants and an empty environment on the URL-free mock sink. */

import {
  driverSelection,
  requireEnvironment,
  type EnvironmentSource,
} from "@/lib/env-contract";
import { SLACK_CONFIGURATION_NAMES } from "@/lib/integrations/selector";

import type { SlackDriver } from "./types";

export type SlackRealConfiguration = {
  platformFallbackUrl: string;
};

export type SlackDriverFactories = {
  mock: () => SlackDriver;
  real: (configuration: SlackRealConfiguration) => SlackDriver;
};

export function resolveSlackDriver({
  factories,
  environment = process.env,
  isDemo = false,
}: {
  factories: SlackDriverFactories;
  environment?: EnvironmentSource;
  isDemo?: boolean;
}): SlackDriver {
  // Demo isolation outranks environment inspection so a labelled tenant cannot construct real I/O.
  if (isDemo) return factories.mock();

  if (driverSelection("slack", "SETTERFI_SLACK_DRIVER", environment) === "mock") {
    return factories.mock();
  }

  const values = requireEnvironment("slack", SLACK_CONFIGURATION_NAMES, environment);
  return factories.real({ platformFallbackUrl: values.SLACK_WEBHOOK_URL });
}
