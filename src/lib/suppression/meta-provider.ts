import { createHash } from "node:crypto";

import type {
  SuppressionProviderInput,
  SuppressionProviderPort,
} from "@/lib/sends/contracts";

export class MetaSuppressionProviderError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MetaSuppressionProviderError";
  }
}

function assertMetaIdentity(input: SuppressionProviderInput) {
  if (input.provider !== "meta_direct" ||
    !["whatsapp", "messenger", "instagram"].includes(input.channel)) {
    throw new MetaSuppressionProviderError("META_SUPPRESSION_IDENTITY_UNSUPPORTED");
  }
}

function operationId(input: SuppressionProviderInput) {
  return createHash("sha256")
    .update(`meta-direct-clear:${input.tenantId}:${input.identityId}:${input.idempotencyKey}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

/**
 * Meta Direct has no remote per-recipient DND record for SetterFi to mutate. STOP therefore stays
 * locally authoritative and retryable, while START can truthfully read back that no provider-held
 * suppression exists before clearing SetterFi's local suppression.
 */
export function createMetaSuppressionProviderPort(
  now: () => Date = () => new Date(),
): SuppressionProviderPort {
  return {
    suppress: async (input) => {
      assertMetaIdentity(input);
      throw new MetaSuppressionProviderError("META_REMOTE_SUPPRESSION_UNAVAILABLE");
    },
    clear: async (input) => {
      assertMetaIdentity(input);
      return { providerOperationId: operationId(input), acceptedAt: now().toISOString() };
    },
    readBack: async (input) => {
      assertMetaIdentity(input);
      return {
        providerOperationId: operationId(input),
        suppressed: false,
        observedAt: now().toISOString(),
      };
    },
  };
}
