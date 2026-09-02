/**
 * Provider-neutral command boundary for connection management.
 *
 * No command fabricates a successful provider result.  In particular, mock selection is only
 * allowed for a demo tenant and still produces `not_verified`, while production mock selection is
 * rejected by the shared environment contract before this module can return a receipt.
 */

import {
  driverSelection,
  phase8AlertRuleEventsLive,
  type DriverSelection,
  type EnvironmentSource,
} from "@/lib/env-contract";
import {
  channelDisconnectedEvent,
  createLiveChannelNotificationPort,
  type ChannelNotificationPort,
} from "@/lib/notifications/channel-events";

export type ProviderConnectionProvider = "ghl" | "meta_direct";
export type ProviderConnectionCommand = "test" | "reconnect" | "disconnect" | "template_sync" | "replay";
export type CommandOutcome = "verified" | "not_verified" | "started" | "replayed";

export type ProviderConnection = {
  id: string;
  tenantId: string;
  provider: ProviderConnectionProvider;
  channel: "sms" | "instagram" | "messenger" | "whatsapp";
  isDemo: boolean;
};

export type ProviderTemplateReceipt = {
  providerTemplateId: string;
  name: string;
  approvalState: "approved" | "submitted" | "rejected" | "paused" | "disabled" | "unknown";
};

export type ProviderCommandResult = {
  outcome: CommandOutcome;
  code: string;
  evidence: Record<string, unknown>;
  providerRevoked?: boolean;
};

export class ProviderConnectionCommandError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProviderConnectionCommandError";
  }
}

export function selectConnectionCommandDriver(
  connection: Pick<ProviderConnection, "provider" | "isDemo">,
  environment: EnvironmentSource = process.env,
): DriverSelection {
  const selection = connection.provider === "ghl"
    ? driverSelection("ghl", "SETTERFI_GHL_DRIVER", environment)
    : driverSelection("meta", "SETTERFI_META_DRIVER", environment);
  if (selection === "mock" && !connection.isDemo) {
    throw new ProviderConnectionCommandError("MOCK_DRIVER_REFUSED_FOR_REAL_TENANT");
  }
  return selection;
}

export type ProviderConnectionCommandDependencies = {
  loadConnection(tenantId: string, connectionId: string): Promise<ProviderConnection | null>;
  execute(input: { connection: ProviderConnection; command: Exclude<ProviderConnectionCommand, "reconnect">; sourceReceiptId?: string }): Promise<ProviderCommandResult>;
  beginReauthorization(input: { connection: ProviderConnection; actorId: string; idempotencyKey: string }): Promise<ProviderCommandResult>;
  claimReplay(input: { tenantId: string; connectionId: string; sourceReceiptId: string; idempotencyKey: string }): Promise<{ replayed: boolean; alreadyCompleted: boolean }>;
  record(input: {
    tenantId: string;
    connectionId: string;
    command: ProviderConnectionCommand;
    actorId: string;
    idempotencyKey: string;
    result: ProviderCommandResult;
  }): Promise<{ receiptId: string; auditId: number; replayed: boolean; outcome: CommandOutcome }>;
  channelEvents?: ChannelNotificationPort;
  environment?: EnvironmentSource;
};

export type ProviderConnectionCommandReceipt = {
  receiptId: string;
  auditId: number;
  replayed: boolean;
  outcome: CommandOutcome;
  code: string;
};

function failureCode(error: unknown) {
  return error instanceof ProviderConnectionCommandError
    ? error.code
    : "PROVIDER_COMMAND_UNAVAILABLE";
}

function failedResult(error: unknown): ProviderCommandResult {
  return {
    outcome: "not_verified",
    code: failureCode(error),
    evidence: { verified: false },
    providerRevoked: false,
  };
}

export function createProviderConnectionCommandService(dependencies: ProviderConnectionCommandDependencies) {
  const run = async (input: {
    tenantId: string;
    connectionId: string;
    actorId: string;
    command: ProviderConnectionCommand;
    idempotencyKey: string;
    sourceReceiptId?: string;
  }): Promise<ProviderConnectionCommandReceipt> => {
    const connection = await dependencies.loadConnection(input.tenantId, input.connectionId);
    if (!connection) throw new ProviderConnectionCommandError("CHANNEL_CONNECTION_NOT_FOUND");
    if (!input.idempotencyKey.trim()) throw new ProviderConnectionCommandError("IDEMPOTENCY_KEY_REQUIRED");
    if (input.command === "replay" && !input.sourceReceiptId?.trim()) {
      throw new ProviderConnectionCommandError("SOURCE_RECEIPT_REQUIRED");
    }

    let result: ProviderCommandResult;
    try {
      const selection = selectConnectionCommandDriver(connection, dependencies.environment);
      if (selection === "mock") {
        // A synthetic arm is useful only to prove the refusal path. It never gets to look like a
        // provider verification, even on a demo tenant.
        result = { outcome: "not_verified", code: "MOCK_PROVIDER_NOT_VERIFIED", evidence: { verified: false, driver: "mock" } };
      } else if (input.command === "reconnect") {
        result = await dependencies.beginReauthorization({ connection, actorId: input.actorId, idempotencyKey: input.idempotencyKey });
      } else if (input.command === "replay") {
        const claim = await dependencies.claimReplay({
          tenantId: input.tenantId,
          connectionId: input.connectionId,
          sourceReceiptId: input.sourceReceiptId!,
          idempotencyKey: input.idempotencyKey,
        });
        if (claim.alreadyCompleted) {
          result = { outcome: "replayed", code: "REPLAY_ALREADY_COMPLETED", evidence: { sourceReceiptId: input.sourceReceiptId } };
        } else if (!claim.replayed) {
          result = { outcome: "not_verified", code: "REPLAY_ALREADY_CLAIMED", evidence: { sourceReceiptId: input.sourceReceiptId } };
        } else {
          result = await dependencies.execute({ connection, command: "replay", sourceReceiptId: input.sourceReceiptId });
        }
      } else {
        result = await dependencies.execute({ connection, command: input.command });
      }
    } catch (error) {
      result = failedResult(error);
    }

    // A failed revoke is deliberately recorded as a failed attempt, but the migration refuses the
    // local state transition unless the real provider call returned a verified revocation.
    const recorded = await dependencies.record({
      tenantId: input.tenantId,
      connectionId: input.connectionId,
      command: input.command,
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
      result,
    });
    if (
      input.command === "disconnect"
      && result.providerRevoked === true
      && recorded.outcome === "verified"
      && phase8AlertRuleEventsLive(dependencies.environment)
    ) {
      const channelEvents = dependencies.channelEvents ?? createLiveChannelNotificationPort();
      await channelEvents.emit(channelDisconnectedEvent({
        tenantId: connection.tenantId,
        connectionId: connection.id,
        channel: connection.channel,
        commandReceiptId: recorded.receiptId,
        occurredAt: new Date().toISOString(),
        isTest: connection.isDemo,
      }));
    }
    return { ...recorded, code: result.code };
  };

  return { run };
}
