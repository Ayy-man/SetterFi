/**
 * The only conversion from provider capability into Phase 3 cadence classes.
 *
 * Phase 4 owns provider/window discovery. This module consumes its frozen capability shape and
 * collapses malformed, missing, or unsupported runtime values toward no post-window automation.
 */

import type { MessagingChannel } from "@/lib/booking/types";
import {
  resolveOutboundCapabilityWindow,
  type ConnectionResolverDependencies,
} from "@/lib/integrations/connection-resolver";
import type { MessagingCapabilities } from "@/lib/integrations/types";

export const POST_WINDOW_CAPABILITIES = [
  "none",
  "human_agent_only",
  "template",
  "freeform",
] as const;

export type PostWindowCapability = (typeof POST_WINDOW_CAPABILITIES)[number];

export type ChannelCapability = {
  postWindow: PostWindowCapability;
  templateSend: boolean;
};

export type ChannelCapabilityFeed = Partial<Record<MessagingChannel, MessagingCapabilities>>;
export type CadenceClass = "durable" | "window_bound" | "none";

const CHANNELS = new Set<string>(["sms", "instagram", "messenger", "whatsapp"]);
const CLOSED_CAPABILITY: ChannelCapability = { postWindow: "none", templateSend: false };
const DEFAULT_CAPABILITIES: Readonly<Record<MessagingChannel, ChannelCapability>> = {
  sms: { postWindow: "freeform", templateSend: false },
  instagram: CLOSED_CAPABILITY,
  messenger: CLOSED_CAPABILITY,
  whatsapp: CLOSED_CAPABILITY,
};

function isMessagingChannel(value: string): value is MessagingChannel {
  return CHANNELS.has(value);
}

function isMessagingCapabilities(value: unknown): value is MessagingCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<MessagingCapabilities>;
  return typeof candidate.windowed === "boolean" &&
    (candidate.postWindow === "none" || candidate.postWindow === "human_tag" ||
      candidate.postWindow === "template") &&
    typeof candidate.templates === "boolean";
}

function fromProviderCapability(capability: MessagingCapabilities): ChannelCapability {
  if (!capability.windowed) return { postWindow: "freeform", templateSend: false };
  if (capability.postWindow === "template" && capability.templates) {
    return { postWindow: "template", templateSend: true };
  }
  if (capability.postWindow === "human_tag") {
    return { postWindow: "human_agent_only", templateSend: false };
  }
  return CLOSED_CAPABILITY;
}

export function resolveChannelCapability(
  runtimeChannel: string,
  feed: ChannelCapabilityFeed = {},
): ChannelCapability {
  if (!isMessagingChannel(runtimeChannel)) return CLOSED_CAPABILITY;
  const supplied = feed[runtimeChannel];
  return isMessagingCapabilities(supplied)
    ? fromProviderCapability(supplied)
    : DEFAULT_CAPABILITIES[runtimeChannel];
}

export function deriveCadenceClass(
  runtimeChannel: string,
  feed: ChannelCapabilityFeed = {},
): CadenceClass {
  if (!isMessagingChannel(runtimeChannel)) return "none";
  const capability = resolveChannelCapability(runtimeChannel, feed);
  return capability.postWindow === "freeform" ||
    (capability.postWindow === "template" && capability.templateSend)
    ? "durable"
    : "window_bound";
}

export async function loadChannelCapabilityFeed(
  tenantId: string,
  conversationId: string,
  channel: MessagingChannel,
  dependencies?: ConnectionResolverDependencies,
): Promise<ChannelCapabilityFeed> {
  const resolved = await resolveOutboundCapabilityWindow(
    tenantId,
    conversationId,
    channel,
    dependencies,
  );
  return { [channel]: resolved.capabilities };
}
