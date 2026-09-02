import { describe, expect, it, vi } from "vitest";

import { DriverConfigurationError } from "@/lib/env-contract";

import {
  selectCalendarDriver,
  selectGhlMessagingDriver,
  selectGhlProvisioningDriver,
  selectMetaDriver,
  selectModelDrivers,
  META_CONFIGURATION_NAMES,
  META_OAUTH_CONFIGURATION_NAMES,
  META_WHATSAPP_CONFIGURATION_NAMES,
  GHL_PROVISIONING_CONFIGURATION_NAMES,
  type ActiveModelConfiguration,
} from "./selector";
import type {
  CalendarDriver,
  GhlMessagingAdapter,
  GhlProvisioningDriver,
  MetaDriver,
  ModelDriver,
  ModeratorDriver,
} from "./types";

const marker = <T>(value: string) => ({ value }) as T;

describe("provider selectors", () => {
  it("chooses deterministic mock factories only when their selectors are explicit", () => {
    expect(
      selectGhlMessagingDriver({
        environment: { SETTERFI_GHL_DRIVER: "mock" },
        factories: {
          mock: () => marker<GhlMessagingAdapter>("ghl-mock"),
          real: () => marker<GhlMessagingAdapter>("ghl-real"),
        },
      }),
    ).toMatchObject({ value: "ghl-mock" });
    expect(
      selectMetaDriver({
        environment: { SETTERFI_META_DRIVER: "mock" },
        factories: {
          mock: () => marker<MetaDriver>("meta-mock"),
          real: () => marker<MetaDriver>("meta-real"),
        },
      }),
    ).toMatchObject({ value: "meta-mock" });
  });

  it("makes calendar selection follow the GHL selector without a fourth switch", () => {
    expect(
      selectCalendarDriver({
        environment: { SETTERFI_GHL_DRIVER: "mock" },
        factories: {
          mock: () => marker<CalendarDriver>("calendar-mock"),
          real: () => marker<CalendarDriver>("calendar-real"),
        },
      }),
    ).toMatchObject({ value: "calendar-mock" });
  });

  it("fails explicit real selection synchronously with missing names and no factory call", () => {
    const real = vi.fn(() => marker<GhlMessagingAdapter>("real"));
    expect(() =>
      selectGhlMessagingDriver({
        environment: { SETTERFI_GHL_DRIVER: "real", GHL_CLIENT_ID: "configured" },
        factories: { mock: () => marker<GhlMessagingAdapter>("mock"), real },
      }),
    ).toThrow(/GHL_CLIENT_SECRET, GHL_WEBHOOK_PUBLIC_KEY/);
    expect(real).not.toHaveBeenCalled();
  });

  it("passes complete real configuration only to the selected factory", () => {
    const real = vi.fn(() => marker<MetaDriver>("real"));
    expect(
      selectMetaDriver({
        environment: {
          SETTERFI_META_DRIVER: "real",
          META_APP_ID: "app",
          META_APP_SECRET: "secret",
          META_SYSTEM_USER_TOKEN: "token",
          META_WEBHOOK_VERIFY_TOKEN: "verify",
          SETTERFI_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64url"),
        },
        factories: { mock: () => marker<MetaDriver>("mock"), real },
      }),
    ).toMatchObject({ value: "real" });
    expect(real).toHaveBeenCalledOnce();
  });

  it("pins the names-only Meta driver, OAuth and WhatsApp real-arm requirements", () => {
    expect(META_CONFIGURATION_NAMES).toEqual([
      "META_APP_ID",
      "META_APP_SECRET",
      "META_SYSTEM_USER_TOKEN",
      "META_WEBHOOK_VERIFY_TOKEN",
      "SETTERFI_CREDENTIAL_ENCRYPTION_KEY",
    ]);
    expect(META_OAUTH_CONFIGURATION_NAMES).toEqual([
      "APP_BASE_URL",
      "META_APP_ID",
      "META_APP_SECRET",
      "META_LOGIN_CONFIG_ID",
      "SETTERFI_CREDENTIAL_ENCRYPTION_KEY",
    ]);
    expect(META_WHATSAPP_CONFIGURATION_NAMES).toEqual([
      "META_WHATSAPP_SYSTEM_USER_TOKEN",
      "META_WABA_ID",
      "META_WHATSAPP_PHONE_NUMBER_ID",
      "SETTERFI_CREDENTIAL_ENCRYPTION_KEY",
    ]);
  });

  // Phase 5
  it("pins the GHL provisioning selector and passes only the narrowed real configuration", () => {
    // The pasted agency token is no longer required: the durable credential is the stored install,
    // and requiring a name real provisioning does not need would refuse a working deployment.
    expect(GHL_PROVISIONING_CONFIGURATION_NAMES).toEqual([
      "GHL_AGENCY_COMPANY_ID",
      "GHL_SNAPSHOT_ID",
      "GHL_NUMBER_POOL_ID",
    ]);
    const real = vi.fn(() => marker<GhlProvisioningDriver>("provisioning-real"));
    expect(selectGhlProvisioningDriver({
      environment: {
        SETTERFI_GHL_PROVISIONING_DRIVER: "real",
        GHL_AGENCY_ACCESS_TOKEN: "configured",
        GHL_AGENCY_COMPANY_ID: "configured",
        GHL_SNAPSHOT_ID: "configured",
        GHL_NUMBER_POOL_ID: "configured",
      },
      factories: {
        mock: () => marker<GhlProvisioningDriver>("provisioning-mock"),
        real,
      },
    })).toMatchObject({ value: "provisioning-real" });
    expect(real).toHaveBeenCalledWith({
      agencyAccessToken: "configured",
      agencyCompanyId: "configured",
      snapshotId: "configured",
      numberPoolId: "configured",
    });
  });

  // Phase 9
  it("builds the real provisioning driver with no pasted agency token at all", () => {
    const real = vi.fn(() => marker<GhlProvisioningDriver>("provisioning-real"));
    expect(selectGhlProvisioningDriver({
      environment: {
        SETTERFI_GHL_PROVISIONING_DRIVER: "real",
        GHL_AGENCY_COMPANY_ID: "configured",
        GHL_SNAPSHOT_ID: "configured",
        GHL_NUMBER_POOL_ID: "configured",
      },
      factories: {
        mock: () => marker<GhlProvisioningDriver>("provisioning-mock"),
        real,
      },
    })).toMatchObject({ value: "provisioning-real" });
    expect(real).toHaveBeenCalledWith({
      agencyAccessToken: undefined,
      agencyCompanyId: "configured",
      snapshotId: "configured",
      numberPoolId: "configured",
    });
  });

  it("names only the three variables real provisioning still needs when they are missing", () => {
    const real = vi.fn(() => marker<GhlProvisioningDriver>("provisioning-real"));
    expect(() => selectGhlProvisioningDriver({
      environment: { SETTERFI_GHL_PROVISIONING_DRIVER: "real" },
      factories: { mock: () => marker<GhlProvisioningDriver>("provisioning-mock"), real },
    })).toThrow("GHL_AGENCY_COMPANY_ID, GHL_SNAPSHOT_ID, GHL_NUMBER_POOL_ID");
    expect(real).not.toHaveBeenCalled();
  });
});

const modelConfigurations: ActiveModelConfiguration[] = [
  { role: "generator", model: "anthropic/generator", params: {} },
  { role: "moderator", model: "openai/moderator", params: {} },
];

describe("model driver selector", () => {
  const factories = {
    mockModel: () => marker<ModelDriver>("model-mock"),
    mockModerator: () => marker<ModeratorDriver>("moderator-mock"),
    realModel: () => marker<ModelDriver>("model-real"),
    realModerator: () => marker<ModeratorDriver>("moderator-real"),
  };

  it("loads the active role pair and chooses both explicitly selected mock arms", async () => {
    const selected = await selectModelDrivers({
      environment: { SETTERFI_OPENROUTER_DRIVER: "mock" },
      loadActiveConfigurations: async () => modelConfigurations,
      factories,
    });
    expect(selected.model).toMatchObject({ value: "model-mock" });
    expect(selected.moderator).toMatchObject({ value: "moderator-mock" });
    expect(selected.generatorConfig.role).toBe("generator");
    expect(selected.moderatorConfig.role).toBe("moderator");
  });

  it("rejects a same-vendor pair before constructing either driver", async () => {
    const mockModel = vi.fn(factories.mockModel);
    const mockModerator = vi.fn(factories.mockModerator);
    await expect(
      selectModelDrivers({
        environment: { SETTERFI_OPENROUTER_DRIVER: "mock" },
        loadActiveConfigurations: async () => [
          { role: "generator", model: "same/generator", params: {} },
          { role: "moderator", model: "same/moderator", params: {} },
        ],
        factories: { ...factories, mockModel, mockModerator },
      }),
    ).rejects.toThrowError(DriverConfigurationError);
    expect(mockModel).not.toHaveBeenCalled();
    expect(mockModerator).not.toHaveBeenCalled();
  });

  it("fails a partial real arm before loading model rows or constructing drivers", async () => {
    const loadActiveConfigurations = vi.fn(async () => modelConfigurations);
    await expect(
      selectModelDrivers({
        environment: { SETTERFI_OPENROUTER_DRIVER: "real" },
        loadActiveConfigurations,
        factories,
      }),
    ).rejects.toThrow(/OPENROUTER_API_KEY/);
    expect(loadActiveConfigurations).not.toHaveBeenCalled();
  });
});
