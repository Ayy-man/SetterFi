import { describe, expect, it, vi } from "vitest";

import { DriverConfigurationError } from "@/lib/env-contract";
import { EMAIL_CONFIGURATION_NAMES } from "@/lib/integrations/selector";

import { createMockEmailDriver } from "./mock";
import { resolveEmailDriver } from "./selector";
import type { EmailDriver } from "./types";

function configuredValue(name: string) {
  return `configured-value-for-${name.toLowerCase()}`;
}

const marker = (value: string) => ({ value }) as unknown as EmailDriver;

describe("email driver selector", () => {
  it("uses the inspectable mock when explicitly selected", () => {
    expect(resolveEmailDriver({
      environment: { SETTERFI_EMAIL_DRIVER: "mock" },
      factories: { mock: () => marker("mock"), real: () => marker("real") },
    })).toMatchObject({ value: "mock" });
  });

  it("forces demo traffic to mock before inspecting an explicit real environment", () => {
    const mock = vi.fn(() => marker("mock"));
    const real = vi.fn(() => marker("real"));
    expect(resolveEmailDriver({
      environment: { SETTERFI_EMAIL_DRIVER: "real" },
      isDemo: true,
      factories: { mock, real },
    })).toMatchObject({ value: "mock" });
    expect(mock).toHaveBeenCalledOnce();
    expect(real).not.toHaveBeenCalled();
  });

  it("fails explicit real selection with every missing Plan 08-01 name and no value", () => {
    const real = vi.fn(() => marker("real"));
    expect(() => resolveEmailDriver({
      environment: { SETTERFI_EMAIL_DRIVER: "real" },
      factories: { mock: () => marker("mock"), real },
    })).toThrow(/RESEND_API_KEY, SETTERFI_EMAIL_FROM/);
    expect(real).not.toHaveBeenCalled();

    const credentialValue = configuredValue("RESEND_API_KEY");
    try {
      resolveEmailDriver({
        environment: {
          SETTERFI_EMAIL_DRIVER: "real",
          RESEND_API_KEY: credentialValue,
        },
        factories: { mock: () => marker("mock"), real },
      });
    } catch (error) {
      expect(error).toBeInstanceOf(DriverConfigurationError);
      expect(error).toMatchObject({ variableNames: ["SETTERFI_EMAIL_FROM"] });
      expect(String(error)).not.toContain(credentialValue);
    }
  });

  it("passes only narrowed Plan 08-01 configuration to the real factory", () => {
    const real = vi.fn(() => marker("real"));
    const environment = {
      SETTERFI_EMAIL_DRIVER: "real",
      RESEND_API_KEY: configuredValue("RESEND_API_KEY"),
      SETTERFI_EMAIL_FROM: configuredValue("SETTERFI_EMAIL_FROM"),
    } as const;
    expect(resolveEmailDriver({
      environment,
      factories: { mock: () => marker("mock"), real },
    })).toMatchObject({ value: "real" });
    expect(real).toHaveBeenCalledWith({
      apiKey: environment.RESEND_API_KEY,
      from: environment.SETTERFI_EMAIL_FROM,
    });
    expect(EMAIL_CONFIGURATION_NAMES).toEqual(["RESEND_API_KEY", "SETTERFI_EMAIL_FROM"]);
  });
});

describe("mock email sink", () => {
  it("returns deterministic acceptance and retains seeded copy as flagged evidence", async () => {
    const driver = createMockEmailDriver();
    const outcome = await driver.deliverEmail({
      deliveryId: "delivery-synthetic",
      attemptNumber: 2,
      to: "recipient@example.test",
      from: "sender@example.test",
      subject: "SETTERFI_DEMO_PLACEHOLDER_SUBJECT",
      text: "SETTERFI_DEMO_PLACEHOLDER_BODY",
    });

    expect(outcome).toEqual({
      kind: "accepted",
      providerReference: "mock-email:delivery-synthetic:2",
    });
    expect(driver.records).toEqual([expect.objectContaining({
      placeholderCopy: true,
      providerReference: "mock-email:delivery-synthetic:2",
    })]);
  });
});
