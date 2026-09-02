import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { DriverConfigurationError, type EnvironmentSource } from "@/lib/env-contract";

import {
  ROTATION_MANIFEST,
  ROTATION_PROVIDERS,
  rotationEnvironmentNames,
} from "./manifest";
import {
  verifyProviderRotation,
  type RotationAuditCommand,
  type RotationDependencies,
  type RotationVerificationCommand,
} from "./verify";

const NOW = new Date("2026-08-17T12:00:00.000Z");
const VERIFIED_AT = "2026-08-17T11:59:00.000Z";

function sentinelEnvironment(provider: (typeof ROTATION_PROVIDERS)[number]) {
  const manifest = ROTATION_MANIFEST[provider];
  const environment: Record<string, string> = {
    SETTERFI_CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64url"),
  };
  if (manifest.selectorName) environment[manifest.selectorName] = "real";
  for (const name of rotationEnvironmentNames(manifest)) {
    environment[name] = `SECRET_SENTINEL_${provider}_${name}`;
  }
  return environment satisfies EnvironmentSource;
}

function dependencies(provider: (typeof ROTATION_PROVIDERS)[number]) {
  const verificationCalls: RotationVerificationCommand[] = [];
  const auditCalls: RotationAuditCommand[] = [];
  const deps: RotationDependencies = {
    verify: async (command) => {
      verificationCalls.push(command);
      for (const name of command.environmentNames) {
        expect(command.openCredential(name)).toBe(`SECRET_SENTINEL_${provider}_${name}`);
      }
      return { receiptClass: ROTATION_MANIFEST[provider].receiptClass, verifiedAt: VERIFIED_AT };
    },
    writeAudit: async (command) => {
      auditCalls.push(command);
      return { auditId: 91 };
    },
    now: () => NOW,
  };
  return { deps, verificationCalls, auditCalls };
}

describe("provider rotation verification", () => {
  it.each(ROTATION_PROVIDERS)("runs a passing mock verification call for %s", async (provider) => {
    const verify = vi.fn(async () => ({
      receiptClass: ROTATION_MANIFEST[provider].receiptClass,
      verifiedAt: new Date(0).toISOString(),
    }));
    const writeAudit = vi.fn(async () => ({ auditId: 5 }));
    const result = await verifyProviderRotation(provider, "mock", {
      verify,
      writeAudit,
      now: () => new Date(0),
    }, {});

    expect(result).toMatchObject({ provider, result: "verified", auditId: 5 });
    expect(verify).toHaveBeenCalledOnce();
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "provider.rotation.verified",
      provider,
    }));
  });

  it.each(ROTATION_PROVIDERS)("skips %s in auto mode when names are missing", async (provider) => {
    const manifest = ROTATION_MANIFEST[provider];
    const environment = manifest.selectorName ? { [manifest.selectorName]: "real" } : {};
    const verify = vi.fn();
    const result = await verifyProviderRotation(provider, "auto", {
      verify,
      writeAudit: vi.fn(),
      now: () => NOW,
    }, environment);

    expect(result).toMatchObject({ provider, result: "skipped" });
    expect(verify).not.toHaveBeenCalled();
  });

  it.each(ROTATION_PROVIDERS)("fails closed for %s in explicit real mode", async (provider) => {
    await expect(verifyProviderRotation(provider, "real", undefined, {})).rejects.toBeInstanceOf(
      DriverConfigurationError,
    );
  });

  it.each(ROTATION_PROVIDERS)("never returns or audits sentinel values for %s", async (provider) => {
    const harness = dependencies(provider);
    const environment = sentinelEnvironment(provider);
    const result = await verifyProviderRotation(provider, "real", harness.deps, environment);
    const serialized = JSON.stringify({ result, audit: harness.auditCalls });

    expect(result.result).toBe("verified");
    expect(harness.verificationCalls).toHaveLength(1);
    expect(harness.auditCalls).toHaveLength(1);
    expect(serialized).not.toContain("SECRET_SENTINEL_");
    expect(serialized).not.toContain(environment.SETTERFI_CREDENTIAL_ENCRYPTION_KEY);
  });

  it("does not treat configured names as verification evidence", async () => {
    const provider = "openrouter" as const;
    const verify = vi.fn(async () => {
      throw new Error(`provider rejected SECRET_SENTINEL_${provider}_OPENROUTER_API_KEY`);
    });
    const writeAudit = vi.fn();
    const result = await verifyProviderRotation(provider, "real", {
      verify,
      writeAudit,
      now: () => NOW,
    }, sentinelEnvironment(provider));

    expect(result).toEqual({
      provider,
      environmentNames: ["OPENROUTER_API_KEY"],
      result: "failed",
      reason: "verification_failed",
    });
    expect(JSON.stringify(result)).not.toContain("SECRET_SENTINEL_");
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("requires an injected real verifier even when every name is configured", async () => {
    const result = await verifyProviderRotation(
      "openrouter",
      "real",
      undefined,
      sentinelEnvironment("openrouter"),
    );
    expect(result).toMatchObject({ result: "failed", reason: "verification_failed" });
  });

  it("keeps sentinel values out of CLI stdout and stderr", () => {
    const sentinel = "SECRET_SENTINEL_CLI_OUTPUT";
    const child = spawnSync(process.execPath, ["scripts/verify-provider-rotation.mjs", "--mode", "mock"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, OPENROUTER_API_KEY: sentinel, STRIPE_SECRET_KEY: sentinel },
    });

    expect(child.status).toBe(0);
    expect(child.stdout).not.toContain(sentinel);
    expect(child.stderr).not.toContain(sentinel);
    expect(child.stdout).toContain('"verified":8');
  });

  it("documents the safe CLI modes without credential-copy instructions", () => {
    const child = spawnSync(process.execPath, ["scripts/verify-provider-rotation.mjs", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(child.status).toBe(0);
    expect(child.stdout).toContain("--mode <mock|auto|real>");
    expect(child.stdout).toContain("never prints values");
    expect(child.stdout).not.toMatch(/\b(export|pbcopy|clipboard)\b/i);
    expect(child.stderr).toBe("");
  });

  it("rejects a wrong receipt class before writing the registry audit", async () => {
    const writeAudit = vi.fn();
    const result = await verifyProviderRotation("ghl", "mock", {
      verify: async () => ({ receiptClass: "wrong.read", verifiedAt: new Date(0).toISOString() }),
      writeAudit,
      now: () => new Date(0),
    }, {});

    expect(result).toMatchObject({ result: "failed", reason: "verification_failed" });
    expect(writeAudit).not.toHaveBeenCalled();
  });
});
