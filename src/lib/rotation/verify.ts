import {
  DriverConfigurationError,
  environmentValue,
  type DriverName,
  type EnvironmentName,
  type EnvironmentSource,
} from "@/lib/env-contract";
import {
  decryptCredential,
  encryptCredential,
  type CredentialEnvelopeV1,
} from "@/lib/integrations/credential-envelope";

import {
  ROTATION_MANIFEST,
  rotationEnvironmentNames,
  type RotationProvider,
} from "./manifest";

export type RotationMode = "mock" | "auto" | "real";

export type RotationVerificationReceipt = {
  receiptClass: string;
  verifiedAt: string;
};

export type RotationVerificationCommand = {
  provider: RotationProvider;
  mode: "mock" | "real";
  environmentNames: readonly EnvironmentName[];
  openCredential(name: EnvironmentName): string;
};

export type RotationAuditCommand = {
  action: "provider.rotation.verified";
  provider: RotationProvider;
  environmentNames: readonly EnvironmentName[];
  receiptClass: string;
  verifiedAt: string;
};

export type RotationDependencies = {
  verify(command: RotationVerificationCommand): Promise<RotationVerificationReceipt>;
  writeAudit(command: RotationAuditCommand): Promise<{ auditId: number }>;
  now(): Date;
};

export type RotationResult =
  | {
      provider: RotationProvider;
      environmentNames: readonly EnvironmentName[];
      result: "verified";
      receiptClass: string;
      timestamp: string;
      auditId: number;
    }
  | {
      provider: RotationProvider;
      environmentNames: readonly EnvironmentName[];
      result: "skipped";
      reason: "selector_not_real" | "missing_environment";
      missingNames: readonly EnvironmentName[];
    }
  | {
      provider: RotationProvider;
      environmentNames: readonly EnvironmentName[];
      result: "failed";
      reason: "verification_failed" | "audit_write_failed";
    };

const ENVELOPE_KEY_NAME = "SETTERFI_CREDENTIAL_ENCRYPTION_KEY" as const;

function mockDependencies(): RotationDependencies {
  return {
    verify: async (command) => ({
      receiptClass: ROTATION_MANIFEST[command.provider].receiptClass,
      verifiedAt: new Date(0).toISOString(),
    }),
    writeAudit: async (command) => ({
      auditId: Object.keys(ROTATION_MANIFEST).indexOf(command.provider) + 1,
    }),
    now: () => new Date(0),
  };
}

function missingNames(names: readonly EnvironmentName[], environment: EnvironmentSource) {
  return names.filter((name) => !environmentValue(name, environment));
}

function envelopeEnvironment(mode: "mock" | "real", environment: EnvironmentSource) {
  return {
    ...environment,
    SETTERFI_META_DRIVER: mode,
  } satisfies EnvironmentSource;
}

function sealCredentials(input: {
  provider: RotationProvider;
  mode: "mock" | "real";
  names: readonly EnvironmentName[];
  environment: EnvironmentSource;
}) {
  const envelopeEnv = envelopeEnvironment(input.mode, input.environment);
  return new Map<EnvironmentName, CredentialEnvelopeV1>(input.names.map((name) => {
    const value = input.mode === "mock"
      ? `synthetic:${input.provider}:${name}`
      : environmentValue(name, input.environment)!;
    return [name, encryptCredential(value, envelopeEnv)];
  }));
}

export async function verifyProviderRotation(
  provider: RotationProvider,
  mode: RotationMode,
  dependencies?: RotationDependencies,
  environment: EnvironmentSource = process.env,
): Promise<RotationResult> {
  const manifest = ROTATION_MANIFEST[provider];
  const names = rotationEnvironmentNames(manifest);
  let activeMode: "mock" | "real";
  if (mode === "mock") {
    activeMode = "mock";
  } else {
    if (mode === "auto" && manifest.selectorName &&
      environmentValue(manifest.selectorName, environment) !== "real") {
      return {
        provider,
        environmentNames: names,
        result: "skipped",
        reason: "selector_not_real",
        missingNames: [manifest.selectorName],
      };
    }
    const missing = missingNames([...names, ENVELOPE_KEY_NAME], environment);
    if (missing.length > 0) {
      if (mode === "auto") {
        return {
          provider,
          environmentNames: names,
          result: "skipped",
          reason: "missing_environment",
          missingNames: missing,
        };
      }
      throw new DriverConfigurationError(manifest.driverName as DriverName, missing);
    }
    activeMode = "real";
  }

  const deps = dependencies ?? (activeMode === "mock" ? mockDependencies() : null);
  if (!deps) {
    return { provider, environmentNames: names, result: "failed", reason: "verification_failed" };
  }
  const sealed = sealCredentials({ provider, mode: activeMode, names, environment });
  let receipt: RotationVerificationReceipt;
  try {
    receipt = await deps.verify({
      provider,
      mode: activeMode,
      environmentNames: names,
      openCredential: (name) => {
        const envelope = sealed.get(name);
        if (!envelope) throw new Error("ROTATION_ENVIRONMENT_NAME_NOT_MANIFESTED");
        return decryptCredential(envelope, envelopeEnvironment(activeMode, environment));
      },
    });
  } catch {
    return { provider, environmentNames: names, result: "failed", reason: "verification_failed" };
  }
  if (receipt.receiptClass !== manifest.receiptClass ||
    !Number.isFinite(Date.parse(receipt.verifiedAt)) ||
    Date.parse(receipt.verifiedAt) > deps.now().getTime()) {
    return { provider, environmentNames: names, result: "failed", reason: "verification_failed" };
  }
  try {
    const audit = await deps.writeAudit({
      action: "provider.rotation.verified",
      provider,
      environmentNames: names,
      receiptClass: receipt.receiptClass,
      verifiedAt: receipt.verifiedAt,
    });
    if (!Number.isSafeInteger(audit.auditId) || audit.auditId <= 0) {
      return { provider, environmentNames: names, result: "failed", reason: "audit_write_failed" };
    }
    return {
      provider,
      environmentNames: names,
      result: "verified",
      receiptClass: receipt.receiptClass,
      timestamp: receipt.verifiedAt,
      auditId: audit.auditId,
    };
  } catch {
    return { provider, environmentNames: names, result: "failed", reason: "audit_write_failed" };
  }
}
