/** Email selection keeps demo tenants inspectable and requires an explicit non-demo arm. */

import {
  driverSelection,
  requireEnvironment,
  type EnvironmentSource,
} from "@/lib/env-contract";
import { EMAIL_CONFIGURATION_NAMES } from "@/lib/integrations/selector";

import type { EmailDriver } from "./types";

export type EmailRealConfiguration = {
  apiKey: string;
  from: string;
};

export type EmailDriverFactories = {
  mock: () => EmailDriver;
  real: (configuration: EmailRealConfiguration) => EmailDriver;
};

export function resolveEmailDriver({
  factories,
  environment = process.env,
  isDemo = false,
}: {
  factories: EmailDriverFactories;
  environment?: EnvironmentSource;
  isDemo?: boolean;
}): EmailDriver {
  // Demo isolation outranks environment inspection so a labelled tenant cannot construct real I/O.
  if (isDemo) return factories.mock();

  if (driverSelection("email", "SETTERFI_EMAIL_DRIVER", environment) === "mock") {
    return factories.mock();
  }

  const values = requireEnvironment("email", EMAIL_CONFIGURATION_NAMES, environment);
  return factories.real({
    apiKey: values.RESEND_API_KEY,
    from: values.SETTERFI_EMAIL_FROM,
  });
}
