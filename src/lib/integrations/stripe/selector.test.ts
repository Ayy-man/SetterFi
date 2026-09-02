import { describe, expect, it, vi } from "vitest";

import {
  DriverConfigurationError,
  realArmSkipReason,
} from "@/lib/env-contract";

import {
  resolveStripeDriver,
  STRIPE_CONFIGURATION_NAMES,
} from "./selector";
import type { StripeDriver } from "./types";

const marker = (value: string) => ({ value }) as unknown as StripeDriver;

describe("Stripe driver selector", () => {
  it("chooses the deterministic mock factory when explicitly selected", () => {
    expect(resolveStripeDriver({
      environment: { SETTERFI_STRIPE_DRIVER: "mock" },
      factories: {
        mock: () => marker("mock"),
        real: () => marker("real"),
      },
    })).toMatchObject({ value: "mock" });
  });

  it("fails explicit real selection with names only and before constructing a driver", () => {
    const real = vi.fn(() => marker("real"));
    expect(() => resolveStripeDriver({
      environment: { SETTERFI_STRIPE_DRIVER: "real" },
      factories: { mock: () => marker("mock"), real },
    })).toThrow(/STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET/);
    expect(real).not.toHaveBeenCalled();

    try {
      resolveStripeDriver({
        environment: {
          SETTERFI_STRIPE_DRIVER: "real",
          STRIPE_SECRET_KEY: "synthetic-secret-value",
        },
        factories: { mock: () => marker("mock"), real },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(DriverConfigurationError);
      expect(error).toMatchObject({ variableNames: ["STRIPE_WEBHOOK_SECRET"] });
      expect(String(error)).not.toContain("synthetic-secret-value");
    }
  });

  it("passes only narrowed configuration to the explicit real factory", () => {
    const real = vi.fn(() => marker("real"));
    expect(resolveStripeDriver({
      environment: {
        SETTERFI_STRIPE_DRIVER: "real",
        STRIPE_SECRET_KEY: "synthetic-secret",
        STRIPE_WEBHOOK_SECRET: "synthetic-webhook-secret",
      },
      factories: { mock: () => marker("mock"), real },
    })).toMatchObject({ value: "real" });
    expect(real).toHaveBeenCalledWith({
      secretKey: "synthetic-secret",
      webhookSecret: "synthetic-webhook-secret",
    });
  });

  it("keeps demo tenants on mock even when deployment selects a configured real arm", () => {
    const mock = vi.fn(() => marker("mock"));
    const real = vi.fn(() => marker("real"));
    expect(resolveStripeDriver({
      environment: {
        SETTERFI_STRIPE_DRIVER: "real",
        STRIPE_SECRET_KEY: "synthetic-secret",
        STRIPE_WEBHOOK_SECRET: "synthetic-webhook-secret",
      },
      isDemo: true,
      factories: { mock, real },
    })).toMatchObject({ value: "mock" });
    expect(mock).toHaveBeenCalledOnce();
    expect(real).not.toHaveBeenCalled();
  });

  it("rejects a production-wide mock while retaining authoritative tenant-scoped demo routing", () => {
    const factories = { mock: () => marker("mock"), real: () => marker("real") };
    expect(() => resolveStripeDriver({
      environment: {
        NODE_ENV: "production",
        SETTERFI_DEMO_LOGINS: "true",
        SETTERFI_STRIPE_DRIVER: "mock",
      },
      factories,
    })).toThrowError(DriverConfigurationError);
    expect(resolveStripeDriver({
      environment: { NODE_ENV: "production", SETTERFI_STRIPE_DRIVER: "real" },
      isDemo: true,
      factories,
    })).toMatchObject({ value: "mock" });
  });

  it("pins both real-arm names and reports missing configuration as a skip", () => {
    expect(STRIPE_CONFIGURATION_NAMES).toEqual([
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
    ]);
    expect(realArmSkipReason(
      "stripe",
      "SETTERFI_STRIPE_DRIVER",
      STRIPE_CONFIGURATION_NAMES,
      {},
    )).toBe("SETTERFI_STRIPE_DRIVER=real is required");
    expect(realArmSkipReason(
      "stripe",
      "SETTERFI_STRIPE_DRIVER",
      STRIPE_CONFIGURATION_NAMES,
      { SETTERFI_STRIPE_DRIVER: "real", STRIPE_SECRET_KEY: "synthetic" },
    )).toBe("STRIPE_WEBHOOK_SECRET is missing");
  });

  it("rejects an invalid selector without reflecting its value", () => {
    try {
      resolveStripeDriver({
        environment: { SETTERFI_STRIPE_DRIVER: "invalid-synthetic-selector" },
        factories: {
          mock: () => marker("mock"),
          real: () => marker("real"),
        },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(DriverConfigurationError);
      expect(String(error)).toContain("SETTERFI_STRIPE_DRIVER");
      expect(String(error)).not.toContain("invalid-synthetic-selector");
    }
  });
});
