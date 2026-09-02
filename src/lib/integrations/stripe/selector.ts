/** Stripe selection keeps demo tenants deterministic and requires an explicit non-demo arm. */

import {
  driverSelection,
  requireEnvironment,
  type EnvironmentSource,
} from "@/lib/env-contract";

import type { StripeDriver } from "./types";

export type StripeRealConfiguration = {
  secretKey: string;
  webhookSecret: string;
};

type StripeFactories = {
  mock: () => StripeDriver;
  real: (configuration: StripeRealConfiguration) => StripeDriver;
};

export const STRIPE_CONFIGURATION_NAMES = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
] as const;

export function resolveStripeDriver({
  factories,
  environment = process.env,
  isDemo = false,
}: {
  factories: StripeFactories;
  environment?: EnvironmentSource;
  isDemo?: boolean;
}): StripeDriver {
  // Demo isolation outranks deployment selection so a labelled tenant cannot construct a real arm.
  if (isDemo) return factories.mock();

  if (driverSelection("stripe", "SETTERFI_STRIPE_DRIVER", environment) === "mock") {
    return factories.mock();
  }

  const values = requireEnvironment("stripe", STRIPE_CONFIGURATION_NAMES, environment);
  return factories.real({
    secretKey: values.STRIPE_SECRET_KEY,
    webhookSecret: values.STRIPE_WEBHOOK_SECRET,
  });
}
