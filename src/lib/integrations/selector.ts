/**
 * Provider selection is the only bridge between deployment configuration and driver instances.
 *
 * Factories stay injected so selection can be proved without importing a provider module or making
 * network calls, while explicit real selection validates every named variable synchronously.
 */

import {
  DriverConfigurationError,
  driverSelection,
  environmentValue,
  requireEnvironment,
  type EnvironmentSource,
} from "@/lib/env-contract";

import type {
  CalendarDriver,
  GhlMessagingAdapter,
  GhlProvisioningDriver,
  MessagingDriver,
  ModelDriver,
  ModeratorDriver,
} from "./types";

export type GhlRealConfiguration = {
  clientId: string;
  clientSecret: string;
  webhookPublicKey: string;
};

export type MetaRealConfiguration = {
  appId: string;
  appSecret: string;
  systemUserToken: string;
  webhookVerifyToken: string;
};

// Phase 5
export type GhlProvisioningRealConfiguration = {
  /** Bootstrap only — the durable credential is the stored `app='provisioning'` install. */
  agencyAccessToken?: string;
  agencyCompanyId: string;
  snapshotId: string;
  numberPoolId: string;
};

export type ActiveModelConfiguration = {
  role: "generator" | "moderator";
  model: string;
  params: Record<string, unknown>;
};

type Factories<TDriver, TConfiguration> = {
  mock: () => TDriver;
  real: (configuration: TConfiguration) => TDriver;
};

export const GHL_CONFIGURATION_NAMES = [
  "GHL_CLIENT_ID",
  "GHL_CLIENT_SECRET",
  "GHL_WEBHOOK_PUBLIC_KEY",
] as const;

export const META_CONFIGURATION_NAMES = [
  "META_APP_ID",
  "META_APP_SECRET",
  "META_SYSTEM_USER_TOKEN",
  "META_WEBHOOK_VERIFY_TOKEN",
  "SETTERFI_CREDENTIAL_ENCRYPTION_KEY",
] as const;

export const META_OAUTH_CONFIGURATION_NAMES = [
  "APP_BASE_URL",
  "META_APP_ID",
  "META_APP_SECRET",
  "META_LOGIN_CONFIG_ID",
  "SETTERFI_CREDENTIAL_ENCRYPTION_KEY",
] as const;

export const META_WHATSAPP_CONFIGURATION_NAMES = [
  "META_WHATSAPP_SYSTEM_USER_TOKEN",
  "META_WABA_ID",
  "META_WHATSAPP_PHONE_NUMBER_ID",
  "SETTERFI_CREDENTIAL_ENCRYPTION_KEY",
] as const;

// Phase 5, narrowed in Phase 9: the durable provisioning credential is the stored agency install,
// so `GHL_AGENCY_ACCESS_TOKEN` is a bootstrap rather than a requirement and is passed through below.
export const GHL_PROVISIONING_CONFIGURATION_NAMES = [
  "GHL_AGENCY_COMPANY_ID",
  "GHL_SNAPSHOT_ID",
  "GHL_NUMBER_POOL_ID",
] as const;

// Phase 9
export const GHL_AGENT_OAUTH_CONFIGURATION_NAMES = [
  "APP_BASE_URL",
  "GHL_CLIENT_ID",
  "GHL_CLIENT_SECRET",
  "GHL_INSTALL_URL",
  "SETTERFI_CREDENTIAL_ENCRYPTION_KEY",
] as const;

export const GHL_AGENCY_OAUTH_CONFIGURATION_NAMES = [
  "APP_BASE_URL",
  "GHL_AGENCY_CLIENT_ID",
  "GHL_AGENCY_CLIENT_SECRET",
  "GHL_AGENCY_INSTALL_URL",
  "SETTERFI_CREDENTIAL_ENCRYPTION_KEY",
] as const;

// Phase 8
export const EMAIL_CONFIGURATION_NAMES = [
  "RESEND_API_KEY",
  "SETTERFI_EMAIL_FROM",
] as const;

export const SLACK_CONFIGURATION_NAMES = [
  "SLACK_WEBHOOK_URL",
] as const;

export function selectGhlProvisioningDriver({
  factories,
  environment = process.env,
}: {
  factories: Factories<GhlProvisioningDriver, GhlProvisioningRealConfiguration>;
  environment?: EnvironmentSource;
}) {
  if (
    driverSelection(
      "ghl_provisioning",
      "SETTERFI_GHL_PROVISIONING_DRIVER",
      environment,
    ) === "mock"
  ) {
    return factories.mock();
  }
  const values = requireEnvironment(
    "ghl_provisioning",
    GHL_PROVISIONING_CONFIGURATION_NAMES,
    environment,
  );
  return factories.real({
    // Bootstrap only: it answers while no agency install has been stored, and is ignored once one
    // has, because the stored grant is the credential that renews itself.
    agencyAccessToken: environmentValue("GHL_AGENCY_ACCESS_TOKEN", environment) ?? undefined,
    agencyCompanyId: values.GHL_AGENCY_COMPANY_ID,
    snapshotId: values.GHL_SNAPSHOT_ID,
    numberPoolId: values.GHL_NUMBER_POOL_ID,
  });
}

function selectGhlArm<TDriver>(
  driver: "ghl" | "calendar",
  factories: Factories<TDriver, GhlRealConfiguration>,
  environment: EnvironmentSource,
) {
  if (driverSelection(driver, "SETTERFI_GHL_DRIVER", environment) === "mock") {
    return factories.mock();
  }
  const values = requireEnvironment(driver, GHL_CONFIGURATION_NAMES, environment);
  return factories.real({
    clientId: values.GHL_CLIENT_ID,
    clientSecret: values.GHL_CLIENT_SECRET,
    webhookPublicKey: values.GHL_WEBHOOK_PUBLIC_KEY,
  });
}

export function selectGhlMessagingDriver({
  factories,
  environment = process.env,
}: {
  factories: Factories<GhlMessagingAdapter, GhlRealConfiguration>;
  environment?: EnvironmentSource;
}) {
  return selectGhlArm("ghl", factories, environment);
}

export function selectCalendarDriver({
  factories,
  environment = process.env,
}: {
  factories: Factories<CalendarDriver, GhlRealConfiguration>;
  environment?: EnvironmentSource;
}) {
  return selectGhlArm("calendar", factories, environment);
}

export function selectMetaDriver({
  factories,
  environment = process.env,
}: {
    factories: Factories<MessagingDriver, MetaRealConfiguration>;
  environment?: EnvironmentSource;
}) {
  if (driverSelection("meta", "SETTERFI_META_DRIVER", environment) === "mock") {
    return factories.mock();
  }
  const values = requireEnvironment("meta", META_CONFIGURATION_NAMES, environment);
  return factories.real({
    appId: values.META_APP_ID,
    appSecret: values.META_APP_SECRET,
    systemUserToken: values.META_SYSTEM_USER_TOKEN,
    webhookVerifyToken: values.META_WEBHOOK_VERIFY_TOKEN,
  });
}

function vendorPrefix(model: string) {
  const separator = model.indexOf("/");
  return separator > 0 ? model.slice(0, separator) : model;
}

function requireModelPair(rows: readonly ActiveModelConfiguration[]) {
  const generator = rows.filter((row) => row.role === "generator");
  const moderator = rows.filter((row) => row.role === "moderator");
  if (generator.length !== 1 || moderator.length !== 1) {
    throw new DriverConfigurationError("openrouter", ["SETTERFI_OPENROUTER_DRIVER"]);
  }
  if (vendorPrefix(generator[0].model) === vendorPrefix(moderator[0].model)) {
    throw new DriverConfigurationError("openrouter", ["SETTERFI_OPENROUTER_DRIVER"]);
  }
  return { generator: generator[0], moderator: moderator[0] };
}

export async function selectModelDrivers({
  loadActiveConfigurations,
  factories,
  environment = process.env,
}: {
  loadActiveConfigurations: () => Promise<readonly ActiveModelConfiguration[]>;
  factories: {
    mockModel: (configuration: ActiveModelConfiguration) => ModelDriver;
    mockModerator: (configuration: ActiveModelConfiguration) => ModeratorDriver;
    realModel: (configuration: ActiveModelConfiguration, apiKey: string) => ModelDriver;
    realModerator: (configuration: ActiveModelConfiguration, apiKey: string) => ModeratorDriver;
  };
  environment?: EnvironmentSource;
}) {
  const selection = driverSelection(
    "openrouter",
    "SETTERFI_OPENROUTER_DRIVER",
    environment,
  );
  const apiKey =
    selection === "real"
      ? requireEnvironment("openrouter", ["OPENROUTER_API_KEY"], environment).OPENROUTER_API_KEY
      : null;
  const configurations = requireModelPair(await loadActiveConfigurations());

  return {
    generatorConfig: configurations.generator,
    moderatorConfig: configurations.moderator,
    model:
      selection === "real"
        ? factories.realModel(configurations.generator, apiKey!)
        : factories.mockModel(configurations.generator),
    moderator:
      selection === "real"
        ? factories.realModerator(configurations.moderator, apiKey!)
        : factories.mockModerator(configurations.moderator),
  };
}
