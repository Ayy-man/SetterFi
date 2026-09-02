import { describe, expect, it, vi } from "vitest";

import { DriverConfigurationError } from "@/lib/env-contract";
import { SLACK_CONFIGURATION_NAMES } from "@/lib/integrations/selector";

import { createMockSlackDriver } from "./mock";
import { resolveSlackDriver } from "./selector";
import type { SlackDriver } from "./types";

function configuredValue(name: string) {
  return `https://example.test/configured-value-for-${name.toLowerCase()}`;
}

const marker = (value: string) => ({ value }) as unknown as SlackDriver;

describe("Slack driver selector", () => {
  it("uses the URL-free mock when explicitly selected", () => {
    expect(resolveSlackDriver({
      environment: { SETTERFI_SLACK_DRIVER: "mock" },
      factories: { mock: () => marker("mock"), real: () => marker("real") },
    })).toMatchObject({ value: "mock" });
  });

  it("forces demo traffic to mock before inspecting an explicit real environment", () => {
    const mock = vi.fn(() => marker("mock"));
    const real = vi.fn(() => marker("real"));
    expect(resolveSlackDriver({
      environment: { SETTERFI_SLACK_DRIVER: "real" },
      isDemo: true,
      factories: { mock, real },
    })).toMatchObject({ value: "mock" });
    expect(mock).toHaveBeenCalledOnce();
    expect(real).not.toHaveBeenCalled();
  });

  it("fails explicit real selection with the missing fallback name and no value", () => {
    const real = vi.fn(() => marker("real"));
    expect(() => resolveSlackDriver({
      environment: { SETTERFI_SLACK_DRIVER: "real" },
      factories: { mock: () => marker("mock"), real },
    })).toThrow(/SLACK_WEBHOOK_URL/);
    expect(real).not.toHaveBeenCalled();

    const destinationValue = configuredValue("SLACK_WEBHOOK_URL");
    try {
      resolveSlackDriver({
        environment: {
          SETTERFI_SLACK_DRIVER: "invalid-selector",
          SLACK_WEBHOOK_URL: destinationValue,
        },
        factories: { mock: () => marker("mock"), real },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(DriverConfigurationError);
      expect(String(error)).toContain("SETTERFI_SLACK_DRIVER");
      expect(String(error)).not.toContain(destinationValue);
    }
  });

  it("passes only the Plan 08-01 fallback to the configured real factory", () => {
    const real = vi.fn(() => marker("real"));
    const environment = {
      SETTERFI_SLACK_DRIVER: "real",
      SLACK_WEBHOOK_URL: configuredValue("SLACK_WEBHOOK_URL"),
    } as const;
    expect(resolveSlackDriver({
      environment,
      factories: { mock: () => marker("mock"), real },
    })).toMatchObject({ value: "real" });
    expect(real).toHaveBeenCalledWith({ platformFallbackUrl: environment.SLACK_WEBHOOK_URL });
    expect(SLACK_CONFIGURATION_NAMES).toEqual(["SLACK_WEBHOOK_URL"]);
  });
});

describe("mock Slack sink", () => {
  it("returns a deterministic receipt and flags placeholder copy without retaining the URL", async () => {
    const driver = createMockSlackDriver();
    await expect(driver.postSlack({
      deliveryId: "delivery-synthetic",
      attemptNumber: 3,
      text: "SETTERFI_DEMO_PLACEHOLDER_SLACK",
      destinationUrl: configuredValue("TENANT_SLACK_WEBHOOK_URL"),
    })).resolves.toEqual({
      kind: "delivered",
      providerReference: "mock-slack:delivery-synthetic:3",
    });
    expect(driver.records).toEqual([{
      deliveryId: "delivery-synthetic",
      attemptNumber: 3,
      text: "SETTERFI_DEMO_PLACEHOLDER_SLACK",
      placeholderCopy: true,
      providerReference: "mock-slack:delivery-synthetic:3",
    }]);
    expect(JSON.stringify(driver.records)).not.toContain("TENANT_SLACK_WEBHOOK_URL");
  });
});
