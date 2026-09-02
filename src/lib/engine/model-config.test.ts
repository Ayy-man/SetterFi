import { describe, expect, it } from "vitest";

import {
  activeModelConfigurations,
  loadActiveModelPair,
  ModelConfigurationError,
} from "@/lib/engine/model-config";
import { selectModelDrivers } from "@/lib/integrations/selector";

const ROWS = [
  {
    id: "generator",
    role: "generator" as const,
    openrouterModel: "anthropic/claude-opus-4.1",
    params: {},
    active: true,
  },
  {
    id: "moderator",
    role: "moderator" as const,
    openrouterModel: "openai/gpt-5",
    params: {},
    active: true,
  },
];

/** Exactly what production holds: the live pair plus a parked A/B challenger. */
const CHALLENGER = {
  id: "challenger",
  role: "generator" as const,
  openrouterModel: "setterfi/demo-phase7-challenger",
  params: {},
  active: false,
};

describe("activeModelConfigurations", () => {
  it("drops a parked challenger so the driver selector still sees one generator", () => {
    expect(activeModelConfigurations([ROWS[0], ROWS[1], CHALLENGER])).toEqual([
      { role: "generator", model: "anthropic/claude-opus-4.1", params: {} },
      { role: "moderator", model: "openai/gpt-5", params: {} },
    ]);
  });

  // The regression: both webhook paths mapped every row into loadActiveConfigurations, so
  // requireModelPair counted two generators and threw DriverConfigurationError naming
  // SETTERFI_OPENROUTER_DRIVER — a 503 that no amount of correct environment could clear.
  it("lets the mock selector resolve a pair with the challenger row present", async () => {
    const mockModel = { name: "model" };
    const mockModerator = { name: "moderator" };
    const selected = await selectModelDrivers({
      loadActiveConfigurations: async () =>
        activeModelConfigurations([ROWS[0], ROWS[1], CHALLENGER]),
      factories: {
        mockModel: () => mockModel as never,
        mockModerator: () => mockModerator as never,
        realModel: () => mockModel as never,
        realModerator: () => mockModerator as never,
      },
      environment: { SETTERFI_OPENROUTER_DRIVER: "mock" },
    });

    expect(selected.generatorConfig.model).toBe("anthropic/claude-opus-4.1");
    expect(selected.moderatorConfig.model).toBe("openai/gpt-5");
  });
});

describe("loadActiveModelPair", () => {
  it("loads exactly one active generator and different-vendor moderator", () => {
    expect(loadActiveModelPair(ROWS)).toEqual({ generator: ROWS[0], moderator: ROWS[1] });
  });

  it("rejects a missing role or a same-vendor pair", () => {
    expect(() => loadActiveModelPair(ROWS.slice(0, 1))).toThrowError(ModelConfigurationError);
    expect(() => loadActiveModelPair([
      ROWS[0],
      { ...ROWS[1], openrouterModel: "anthropic/claude-sonnet" },
    ])).toThrow("MODEL_VENDORS_MUST_DIFFER");
  });
});
