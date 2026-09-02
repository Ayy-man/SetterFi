/**
 * Central outbound authorization for every messaging provider.
 *
 * Consent and suppression run before capability lookup. A windowed provider can only receive
 * freeform traffic while its persisted provider window is open; post-window traffic must use the
 * capability it declares or stop before the driver sees a command.
 */

import { resolveOutboundCapabilityWindow } from "@/lib/integrations/connection-resolver";
import {
  createHumanTaggedCommand,
  type ApprovedTemplateCommand,
  type AuthorizedOutboundCommand,
  type HumanActorProof,
  type MessagingCapabilities,
  type MessagingChannel,
  type MessagingDriver,
} from "@/lib/integrations/types";
import { dispatchAuthorizedMessagingDriver } from "@/lib/sends/provider-dispatch";
import {
  continuationUnavailableEvent,
  createChannelEventEmitter,
  createChannelNotificationRepository,
} from "@/lib/notifications/channel-events";

export type ExistingSendAuthorization =
  | { allowed: true }
  | { allowed: false; reason: string };

export type MessageTemplateStatus =
  | "draft"
  | "pending"
  | "submitted"
  | "approved"
  | "rejected"
  | "paused"
  | "disabled";

export type OutboundMessageTemplate = {
  id: string;
  tenantId: string;
  channel: MessagingChannel;
  provider: MessagingDriver["provider"];
  providerTemplateName: string;
  locale: string;
  bodyHash: string;
  status: MessageTemplateStatus;
};

export type OutboundPolicyInput = {
  tenantId: string;
  conversationId: string;
  channel: MessagingChannel;
  recipientExternalId: string;
  body: string;
  isTest: boolean;
  actor?: { kind: "ai" } | { kind: "human"; proof: HumanActorProof };
  template?: {
    id: string;
    variables: Readonly<Record<string, string>>;
  };
};

export type OutboundMessagingDriver = Pick<MessagingDriver, "provider" | "send">;

export type OutboundPolicyDependencies = {
  authorizeExisting(input: OutboundPolicyInput): Promise<ExistingSendAuthorization>;
  resolveCapabilityWindow(input: {
    tenantId: string;
    conversationId: string;
    channel: MessagingChannel;
  }): Promise<{
    provider: MessagingDriver["provider"];
    capabilities: MessagingCapabilities;
    providerWindowExpiresAt: string | null;
  }>;
  loadTemplate(input: {
    tenantId: string;
    templateId: string;
  }): Promise<OutboundMessageTemplate | null>;
  recordWindowRefusal(input: {
    tenantId: string;
    conversationId: string;
    channel: MessagingChannel;
    reason: string;
  }): Promise<void>;
  emitWindowExpired(input: {
    tenantId: string;
    conversationId: string;
    channel: MessagingChannel;
    isTest: boolean;
    occurredAt: string;
  }): Promise<void>;
  emitContinuationUnavailable(input: {
    tenantId: string;
    conversationId: string;
    channel: MessagingChannel;
    reason: string;
    isTest: boolean;
    occurredAt: string;
  }): Promise<void>;
  driver: OutboundMessagingDriver;
  now(): Date;
};

export type OutboundPolicyResult =
  | { kind: "sent"; providerMessageId: string; command: AuthorizedOutboundCommand }
  | { kind: "refused"; reason: string };

export type OutboundAuthorizationResult =
  | { kind: "authorized"; command: AuthorizedOutboundCommand }
  | { kind: "refused"; reason: string };

export function isProviderWindowExpired(
  capabilities: MessagingCapabilities,
  providerWindowExpiresAt: string | null,
  now: Date,
) {
  if (!capabilities.windowed) return false;
  if (providerWindowExpiresAt === null) return true;
  const expiresAt = Date.parse(providerWindowExpiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
}

function approvedTemplateCommand(
  input: OutboundPolicyInput,
  template: OutboundMessageTemplate,
): ApprovedTemplateCommand {
  return {
    kind: "approved_template",
    channel: input.channel,
    recipientExternalId: input.recipientExternalId,
    templateId: template.id,
    providerTemplateName: template.providerTemplateName,
    locale: template.locale,
    bodyHash: template.bodyHash,
    variables: input.template?.variables ?? {},
  };
}

async function refuseExpiredWindow(
  input: OutboundPolicyInput,
  dependencies: OutboundPolicyDependencies,
  reason: string,
): Promise<Extract<OutboundPolicyResult, { kind: "refused" }>> {
  const occurredAt = dependencies.now().toISOString();
  await dependencies.recordWindowRefusal({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    channel: input.channel,
    reason,
  });
  await dependencies.emitWindowExpired({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    channel: input.channel,
    isTest: input.isTest,
    occurredAt,
  });
  await dependencies.emitContinuationUnavailable({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    channel: input.channel,
    reason,
    isTest: input.isTest,
    occurredAt,
  });
  return { kind: "refused", reason };
}

async function loadApprovedTemplate(
  input: OutboundPolicyInput,
  provider: OutboundMessagingDriver["provider"],
  dependencies: OutboundPolicyDependencies,
) {
  if (!input.template) return { kind: "missing" as const };
  const template = await dependencies.loadTemplate({
    tenantId: input.tenantId,
    templateId: input.template.id,
  });
  if (!template || template.tenantId !== input.tenantId || template.id !== input.template.id) {
    return { kind: "refused" as const, reason: "MESSAGE_TEMPLATE_NOT_FOUND" };
  }
  if (template.channel !== input.channel || template.provider !== provider) {
    return { kind: "refused" as const, reason: "MESSAGE_TEMPLATE_SCOPE_MISMATCH" };
  }
  if (template.status !== "approved") {
    return { kind: "refused" as const, reason: `MESSAGE_TEMPLATE_NOT_APPROVED:${template.status}` };
  }
  if (!template.providerTemplateName.trim() || !template.locale.trim() || !template.bodyHash.trim()) {
    return { kind: "refused" as const, reason: "MESSAGE_TEMPLATE_APPROVAL_INCOMPLETE" };
  }
  return { kind: "approved" as const, template };
}

function defaultDependencies(driver: OutboundMessagingDriver): OutboundPolicyDependencies {
  let continuationEmitter: ReturnType<typeof createChannelEventEmitter> | null = null;
  return {
    authorizeExisting: async () => ({
      allowed: false,
      reason: "EXISTING_SEND_AUTHORIZATION_REQUIRED",
    }),
    resolveCapabilityWindow: (input) => resolveOutboundCapabilityWindow(
      input.tenantId,
      input.conversationId,
      input.channel,
    ),
    loadTemplate: async () => null,
    recordWindowRefusal: async () => {
      throw new Error("WINDOW_REFUSAL_RECORDER_REQUIRED");
    },
    emitWindowExpired: async () => {
      throw new Error("WINDOW_REFUSAL_EVENT_EMITTER_REQUIRED");
    },
    emitContinuationUnavailable: async (input) => {
      if (input.isTest || input.channel === "webchat") return;
      const channel: Exclude<MessagingChannel, "webchat"> = input.channel;
      continuationEmitter ??= createChannelEventEmitter(createChannelNotificationRepository());
      await continuationEmitter(continuationUnavailableEvent({ ...input, channel }));
    },
    driver,
    now: () => new Date(),
  };
}

export async function authorizeWithOutboundPolicy(
  input: OutboundPolicyInput,
  provider: OutboundMessagingDriver["provider"],
  overrides: Partial<Omit<OutboundPolicyDependencies, "driver">> = {},
): Promise<OutboundAuthorizationResult> {
  const driver = { provider, send: async () => { throw new Error("OUTBOUND_POLICY_AUTHORIZATION_ONLY"); } };
  const dependencies = { ...defaultDependencies(driver), ...overrides, driver };
  const existing = await dependencies.authorizeExisting(input);
  if (!existing.allowed) return { kind: "refused", reason: existing.reason };

  const context = await dependencies.resolveCapabilityWindow(input);
  if (context.provider !== provider) throw new Error("OUTBOUND_DRIVER_PROVIDER_MISMATCH");
  const expired = isProviderWindowExpired(
    context.capabilities,
    context.providerWindowExpiresAt,
    dependencies.now(),
  );

  if (input.template) {
    if (!context.capabilities.templates || (expired && context.capabilities.postWindow !== "template")) {
      if (expired) return refuseExpiredWindow(input, dependencies, "MESSAGE_TEMPLATES_UNSUPPORTED");
      return { kind: "refused", reason: "MESSAGE_TEMPLATES_UNSUPPORTED" };
    }
    const loaded = await loadApprovedTemplate(input, context.provider, dependencies);
    if (loaded.kind !== "approved") {
      const reason = loaded.kind === "missing" ? "MESSAGE_TEMPLATE_NOT_FOUND" : loaded.reason;
      if (expired) return refuseExpiredWindow(input, dependencies, reason);
      return { kind: "refused", reason };
    }
    return { kind: "authorized", command: approvedTemplateCommand(input, loaded.template) };
  }
  if (!expired) {
    return {
      kind: "authorized",
      command: {
        kind: "freeform",
        channel: input.channel,
        recipientExternalId: input.recipientExternalId,
        body: input.body,
      },
    };
  }
  if (context.capabilities.postWindow === "human_tag" && input.actor?.kind === "human") {
    return {
      kind: "authorized",
      command: createHumanTaggedCommand({
        channel: input.channel,
        recipientExternalId: input.recipientExternalId,
        body: input.body,
      }, input.actor.proof),
    };
  }
  return refuseExpiredWindow(input, dependencies, "PROVIDER_WINDOW_EXPIRED");
}

/** Authorizes and sends, returning refusal before provider I/O for every closed-window branch. */
export async function sendWithOutboundPolicy(
  input: OutboundPolicyInput,
  driver: OutboundMessagingDriver,
  overrides: Partial<Omit<OutboundPolicyDependencies, "driver">> = {},
): Promise<OutboundPolicyResult> {
  const authorized = await authorizeWithOutboundPolicy(input, driver.provider, overrides);
  if (authorized.kind === "refused") return authorized;
  const sent = await dispatchAuthorizedMessagingDriver(driver, authorized.command);
  if (!sent.providerMessageId.trim()) throw new Error("PROVIDER_MESSAGE_ID_REQUIRED");
  return { kind: "sent", providerMessageId: sent.providerMessageId, command: authorized.command };
}
