import { describe, expect, it } from "vitest";

import {
  PLATFORM_SMOKE_CHECK_KEYS,
  platformSmokeCounters,
  platformSmokeErrorDetail,
  runPlatformSmoke,
  smokeErrorText,
  type PlatformSmokeLoaders,
} from "./smoke";

function passingLoaders(): PlatformSmokeLoaders {
  return Object.fromEntries(PLATFORM_SMOKE_CHECK_KEYS.map((key) => [key, async () => ({ key })])) as PlatformSmokeLoaders;
}

const input = { actorId: "owner-synthetic", nowIso: "2026-09-06T04:20:00.000Z" };

describe("platform smoke", () => {
  it("passes when every loader resolves, timing each check", async () => {
    let tick = 0;
    const result = await runPlatformSmoke({ ...input, loaders: passingLoaders(), now: () => (tick += 5) });
    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.key)).toEqual([...PLATFORM_SMOKE_CHECK_KEYS]);
    expect(result.checks.every((check) => check.ok && check.ms === 5 && check.error === undefined)).toBe(true);
    expect(platformSmokeCounters(result)).toEqual({ checks: PLATFORM_SMOKE_CHECK_KEYS.length, failed: 0 });
    expect(platformSmokeErrorDetail(result)).toBeNull();
  });

  it("names the failing check, keeps running the rest, and carries only the error name and message", async () => {
    class MeasurementEvidenceError extends Error {
      constructor(code: string) {
        super(code);
        this.name = "MeasurementEvidenceError";
      }
    }
    const loaders = passingLoaders();
    loaders["platform-measurement"] = async () => {
      throw new MeasurementEvidenceError("PLATFORM_PROVISIONING_PERFORMANCE_INVALID");
    };
    const result = await runPlatformSmoke({ ...input, loaders });
    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(PLATFORM_SMOKE_CHECK_KEYS.length);
    expect(result.checks[0]).toMatchObject({
      key: "platform-measurement",
      ok: false,
      error: "MeasurementEvidenceError: PLATFORM_PROVISIONING_PERFORMANCE_INVALID",
    });
    expect(result.checks.slice(1).every((check) => check.ok)).toBe(true);
    expect(platformSmokeCounters(result)).toEqual({
      checks: PLATFORM_SMOKE_CHECK_KEYS.length, failed: 1, failed_keys: ["platform-measurement"],
    });
    expect(platformSmokeErrorDetail(result)).toBe("platform-measurement: MeasurementEvidenceError: PLATFORM_PROVISIONING_PERFORMANCE_INVALID");
  });

  it("reduces a thrown error to its name and message, never a payload", () => {
    const withPayload = Object.assign(new Error("READ_FAILED"), { payload: { rows: [{ secret: "no" }] } });
    expect(smokeErrorText(withPayload)).toBe("READ_FAILED");
    expect(smokeErrorText({ rows: [1, 2, 3] })).toBe("non-error thrown");
    expect(smokeErrorText("x".repeat(1_000))).toHaveLength(300);
  });
});
