/**
 * Locally authoritative STOP, HELP, START, and provider-reconciliation orchestration.
 *
 * Local STOP commits before any provider work. START changes local state only after provider
 * read-back, and every control response re-enters the single sendToLead permission gateway.
 */

import type { MessagingChannel } from "@/lib/booking/types";
import type {
  SendPurpose,
  SendToLeadRequest,
  SendToLeadResult,
  SuppressionProviderPort,
} from "@/lib/sends/contracts";
import type { SendTarget } from "@/lib/sends/send-to-lead";
import {
  classifySuppressionKeyword,
  type SuppressionKeywordResult,
} from "@/lib/suppression/keywords";
import { hashSuppressionIdentifier } from "@/lib/suppression/identifier-hash";
import {
  normalizeSuppressionIdentifier,
  suppressionIdentifierLast4,
} from "@/lib/suppression/normalize";

export type SuppressionIdentity = SendTarget & {
  providerIdentityId: string;
  suppressionId: string | null;
};

export type KeywordSuppressionWrite = {
  suppressionIds: readonly string[];
  confirmationReserved: boolean;
  auditId: number;
};

export type SuppressionRepository = {
  loadContactIdentities(tenantId: string, contactId: string): Promise<readonly SuppressionIdentity[]>;
  recordKeywordSuppression(input: {
    tenantId: string;
    contactId: string;
    channels: readonly MessagingChannel[];
    identifierHashes: readonly string[];
    identifierLast4s: readonly string[];
    source: "stop_keyword" | "stop_intent";
    confirmationKey: string;
  }): Promise<KeywordSuppressionWrite>;
  recordProviderResult(input: {
    tenantId: string;
    suppressionId: string;
    confirmed: boolean;
    error: string | null;
  }): Promise<number>;
  clearIdentitySuppression(input: {
    tenantId: string;
    contactId: string;
    identityId: string;
    identifierHash: string;
    providerConfirmed: true;
  }): Promise<number>;
  markStopConfirmationSent(input: {
    tenantId: string;
    contactId: string;
    confirmationKey: string;
    sentAt: string;
  }): Promise<boolean>;
};

export type SuppressionGateway = {
  send(request: SendToLeadRequest): Promise<SendToLeadResult>;
};

export type SuppressionServiceDependencies = {
  repository: SuppressionRepository;
  provider: SuppressionProviderPort;
  gateway: SuppressionGateway;
  hashIdentifier?: typeof hashSuppressionIdentifier;
  classify?: typeof classifySuppressionKeyword;
  now?: () => string;
};

export type InboundControlInput = {
  tenantId: string;
  contactId: string;
  conversationId: string;
  inboundIdentityId: string;
  channel: MessagingChannel;
  body: string;
  providerMessageId: string;
  occurredAt: string;
  isTest: boolean;
};

export type ProviderSuppressionState = "confirmed" | "unconfirmed";

export type SuppressionControlResult =
  | { kind: "none" }
  | { kind: "help"; confirmation: SendToLeadResult }
  | {
      kind: "stop";
      localAuditId: number;
      provider: ProviderSuppressionState;
      confirmation: SendToLeadResult | "not_reserved" | "expired";
    }
  | {
      kind: "start";
      provider: ProviderSuppressionState;
      localAuditId: number | null;
      confirmation: SendToLeadResult | null;
    };

const CONTROL_PLACEHOLDERS: Readonly<Record<"stop" | "help" | "start", string>> = {
  stop: "SETTERFI_DEMO_PLACEHOLDER_STOP_COPY",
  help: "SETTERFI_DEMO_PLACEHOLDER_HELP_COPY",
  start: "SETTERFI_DEMO_PLACEHOLDER_START_COPY",
};

function controlPurpose(kind: "stop" | "help" | "start"): SendPurpose {
  return `${kind}_confirmation`;
}

function controlRequest(
  input: InboundControlInput,
  kind: "stop" | "help" | "start",
): SendToLeadRequest {
  return {
    tenantId: input.tenantId,
    contactId: input.contactId,
    conversationId: input.conversationId,
    nominatedIdentityId: input.inboundIdentityId,
    purpose: controlPurpose(kind),
    content: { kind: "freeform", body: CONTROL_PLACEHOLDERS[kind] },
    idempotencyKey: `control:${kind}:${input.providerMessageId}`,
    occurredAt: input.occurredAt,
    isTest: input.isTest,
  };
}

function normalizedIdentity(identity: SuppressionIdentity) {
  const identifier = normalizeSuppressionIdentifier(identity.channel, identity.normalizedIdentifier);
  if (!identifier) throw new Error("SUPPRESSION_IDENTIFIER_INVALID");
  return { identity, identifier };
}

async function recordProviderFailure(
  dependencies: SuppressionServiceDependencies,
  tenantId: string,
  suppressionId: string,
  error: string,
) {
  await dependencies.repository.recordProviderResult({
    tenantId,
    suppressionId,
    confirmed: false,
    error,
  });
  return false;
}

async function reconcileIdentity(
  identity: SuppressionIdentity,
  suppressionId: string,
  operation: "suppress" | "clear",
  idempotencyKey: string,
  dependencies: SuppressionServiceDependencies,
) {
  const input = {
    tenantId: identity.tenantId,
    identityId: identity.identityId,
    provider: identity.provider,
    channel: identity.channel,
    providerIdentityId: identity.providerIdentityId,
    idempotencyKey,
  };
  try {
    const mutation = operation === "suppress"
      ? await dependencies.provider.suppress(input)
      : await dependencies.provider.clear(input);
    const readBack = await dependencies.provider.readBack(input);
    const confirmed = readBack.providerOperationId === mutation.providerOperationId &&
      readBack.suppressed === (operation === "suppress");
    if (!confirmed) {
      return recordProviderFailure(
        dependencies,
        identity.tenantId,
        suppressionId,
        "PROVIDER_SUPPRESSION_READBACK_MISMATCH",
      );
    }
    if (operation === "suppress") {
      await dependencies.repository.recordProviderResult({
        tenantId: identity.tenantId,
        suppressionId,
        confirmed: true,
        error: null,
      });
    }
    return true;
  } catch {
    return recordProviderFailure(
      dependencies,
      identity.tenantId,
      suppressionId,
      "PROVIDER_SUPPRESSION_READBACK_FAILED",
    );
  }
}

async function handleStop(
  input: InboundControlInput,
  classification: Extract<SuppressionKeywordResult, { kind: "stop" }>,
  dependencies: SuppressionServiceDependencies,
): Promise<SuppressionControlResult> {
  const identities = (await dependencies.repository.loadContactIdentities(input.tenantId, input.contactId))
    .map(normalizedIdentity);
  if (identities.length === 0) throw new Error("SUPPRESSION_IDENTITIES_REQUIRED");
  const hash = dependencies.hashIdentifier ?? hashSuppressionIdentifier;
  const confirmationKey = `stop:${input.channel}:${input.providerMessageId}`;
  const local = await dependencies.repository.recordKeywordSuppression({
    tenantId: input.tenantId,
    contactId: input.contactId,
    channels: identities.map(({ identity }) => identity.channel),
    identifierHashes: identities.map(({ identifier }) => hash(identifier)),
    identifierLast4s: identities.map(({ identifier }) => suppressionIdentifierLast4(identifier)),
    source: classification.tier === "keyword" ? "stop_keyword" : "stop_intent",
    confirmationKey,
  });
  if (local.suppressionIds.length !== identities.length) {
    throw new Error("SUPPRESSION_WRITE_READBACK_MISMATCH");
  }

  let confirmation: SendToLeadResult | "not_reserved" | "expired" = "not_reserved";
  if (local.confirmationReserved) {
    const now = (dependencies.now ?? (() => new Date().toISOString()))();
    const ageMs = Date.parse(now) - Date.parse(input.occurredAt);
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 5 * 60_000) {
      confirmation = "expired";
    } else {
      confirmation = await dependencies.gateway.send(controlRequest(input, "stop"));
      if (confirmation.kind === "sent") {
        await dependencies.repository.markStopConfirmationSent({
          tenantId: input.tenantId,
          contactId: input.contactId,
          confirmationKey,
          sentAt: confirmation.receipt.persistedAt,
        });
      }
    }
  }

  const providerResults = await Promise.all(identities.map(({ identity }, index) =>
    reconcileIdentity(
      identity,
      local.suppressionIds[index],
      "suppress",
      `${confirmationKey}:${identity.identityId}`,
      dependencies,
    )
  ));
  return {
    kind: "stop",
    localAuditId: local.auditId,
    provider: providerResults.every(Boolean) ? "confirmed" : "unconfirmed",
    confirmation,
  };
}

async function handleStart(
  input: InboundControlInput,
  dependencies: SuppressionServiceDependencies,
): Promise<SuppressionControlResult> {
  const identities = await dependencies.repository.loadContactIdentities(input.tenantId, input.contactId);
  const identity = identities.find((candidate) =>
    candidate.identityId === input.inboundIdentityId && candidate.channel === input.channel
  );
  if (!identity || !identity.suppressionId) {
    return { kind: "start", provider: "unconfirmed", localAuditId: null, confirmation: null };
  }
  const { identifier } = normalizedIdentity(identity);
  const hash = dependencies.hashIdentifier ?? hashSuppressionIdentifier;
  const identifierHash = hash(identifier);
  const remoteTargets = new Map<string, SuppressionIdentity>();
  for (const candidate of identities) {
    if (!candidate.suppressionId || candidate.channel !== identity.channel) continue;
    const normalized = normalizedIdentity(candidate);
    if (hash(normalized.identifier) !== identifierHash) continue;
    remoteTargets.set(
      `${candidate.provider}:${candidate.channel}:${candidate.providerIdentityId}`,
      candidate,
    );
  }
  const providerResults = await Promise.all([...remoteTargets.values()].map((candidate) =>
    reconcileIdentity(
      candidate,
      candidate.suppressionId!,
      "clear",
      `start:${input.channel}:${input.providerMessageId}:${candidate.identityId}`,
      dependencies,
    )
  ));
  if (providerResults.length === 0 || !providerResults.every(Boolean)) {
    return { kind: "start", provider: "unconfirmed", localAuditId: null, confirmation: null };
  }
  const localAuditId = await dependencies.repository.clearIdentitySuppression({
    tenantId: input.tenantId,
    contactId: input.contactId,
    identityId: identity.identityId,
    identifierHash,
    providerConfirmed: true,
  });
  return {
    kind: "start",
    provider: "confirmed",
    localAuditId,
    confirmation: await dependencies.gateway.send(controlRequest(input, "start")),
  };
}

export async function processSuppressionControl(
  input: InboundControlInput,
  dependencies: SuppressionServiceDependencies,
): Promise<SuppressionControlResult> {
  const classification = (dependencies.classify ?? classifySuppressionKeyword)(input.channel, input.body);
  if (classification.kind === "none") return { kind: "none" };
  if (classification.kind === "stop") return handleStop(input, classification, dependencies);
  if (classification.kind === "start") return handleStart(input, dependencies);
  return {
    kind: "help",
    confirmation: await dependencies.gateway.send(controlRequest(input, "help")),
  };
}

export function createMockSuppressionProviderPort(
  now: () => string = () => new Date().toISOString(),
): SuppressionProviderPort {
  const state = new Map<string, { operationId: string; suppressed: boolean }>();
  return {
    async suppress(input) {
      const operationId = `mock-suppression:${input.idempotencyKey}`;
      state.set(input.identityId, { operationId, suppressed: true });
      return { providerOperationId: operationId, acceptedAt: now() };
    },
    async clear(input) {
      const operationId = `mock-suppression:${input.idempotencyKey}`;
      state.set(input.identityId, { operationId, suppressed: false });
      return { providerOperationId: operationId, acceptedAt: now() };
    },
    async readBack(input) {
      const saved = state.get(input.identityId);
      if (!saved) throw new Error("MOCK_SUPPRESSION_STATE_MISSING");
      return {
        providerOperationId: saved.operationId,
        suppressed: saved.suppressed,
        observedAt: now(),
      };
    },
  };
}
