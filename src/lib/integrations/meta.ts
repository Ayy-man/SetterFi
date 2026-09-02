/**
 * Meta messaging owns webhook HMAC verification and channel-specific Graph payloads.
 *
 * Connection identifiers and access tokens remain injected per tenant. Normalization ends every
 * provider shape here, and every caller consumes the same provider-blind Contract A batch.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  DIRECT_META_MESSAGING_CAPABILITIES,
  type AuthorizedOutboundCommand,
  type MessagingChannel,
  type MessagingDriver,
  type NormalizedInboundAttribution,
  type NormalizedInboundBatch,
  type NormalizedInboundEvent,
  type NormalizedInboundMessage,
  type ProviderWindow,
} from "./types";

type JsonObject = Record<string, unknown>;
type FetchLike = typeof fetch;
type MetaChannel = "instagram" | "messenger" | "whatsapp";

export const META_GRAPH_VERSION = "v25.0";
const MOCK_APP_SECRET = createHash("sha256")
  .update("setterfi-meta-mock-signature-fixture")
  .digest("hex");

export type MetaDriverConfiguration = {
  appId: string;
  appSecret: string;
  systemUserToken: string;
  webhookVerifyToken: string;
};

export type MetaConnection = {
  senderId: string;
  accessToken: string;
  host: "https://graph.facebook.com" | "https://graph.instagram.com";
};

export type MetaMessagingDriver = MessagingDriver;

export class MetaProviderError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
    readonly bodyShape: string | null = null,
  ) {
    super(status === null ? code : `${code} (HTTP ${status})`);
    this.name = "MetaProviderError";
  }
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function objects(value: unknown) {
  return Array.isArray(value)
    ? value.map(object).filter((row): row is JsonObject => row !== null)
    : [];
}

function shape(value: unknown) {
  const row = object(value);
  return row ? Object.keys(row).sort().join(",") : Array.isArray(value) ? "array" : typeof value;
}

function stableId(prefix: string, values: readonly string[]) {
  let hash = 2_166_136_261;
  for (const character of values.join("|")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function metaTimestamp(value: unknown, seconds: boolean) {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(numeric)) throw new MetaProviderError("META_INBOUND_WINDOW_REQUIRED");
  const observed = new Date(seconds ? numeric * 1_000 : numeric);
  if (Number.isNaN(observed.getTime())) {
    throw new MetaProviderError("META_INBOUND_WINDOW_REQUIRED");
  }
  return observed;
}

function providerWindow(value: unknown, seconds: boolean): ProviderWindow {
  const observed = metaTimestamp(value, seconds);
  return {
    observedAt: observed.toISOString(),
    expiresAt: new Date(observed.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
    source: "derived_24h",
  };
}

function mandatoryIdentity(
  channel: MetaChannel,
  externalId: unknown,
) {
  const normalized = text(externalId);
  if (!normalized) throw new MetaProviderError("META_INBOUND_IDENTITY_REQUIRED");
  return {
    channel,
    provider: "meta_direct" as const,
    externalId: normalized,
    normalizedPhone: null,
    normalizedEmail: null,
  };
}

function mandatoryAccountId(value: unknown) {
  const normalized = text(value);
  if (!normalized) throw new MetaProviderError("META_INBOUND_ACCOUNT_REQUIRED");
  return normalized;
}

function messengerAttribution(value: unknown): NormalizedInboundAttribution | null {
  const referral = object(value);
  if (!referral) return null;
  const context = object(referral.ads_context_data);
  const adTitle = text(context?.ad_title);
  const postId = text(context?.post_id);
  return {
    adId: text(referral.ad_id),
    source: text(referral.source) === "ADS" ? "ADS" : null,
    ref: text(referral.ref),
    adsContextData: {
      ...(adTitle ? { adTitle } : {}),
      ...(postId ? { postId } : {}),
    },
    ctwaClid: null,
  };
}

function whatsAppAttribution(value: unknown): NormalizedInboundAttribution | null {
  const referral = object(value);
  if (!referral) return null;
  return {
    adId: null,
    source: null,
    ref: null,
    adsContextData: {},
    ctwaClid: text(referral.ctwa_clid),
  };
}

function ignored(
  eventId: string,
  externalAccountId: string,
  reason: string,
): NormalizedInboundEvent {
  return { kind: "ignored", eventId, externalAccountId, reason };
}

function status(
  eventId: string,
  externalAccountId: string,
  value: string,
): NormalizedInboundEvent {
  return { kind: "status", eventId, externalAccountId, status: value };
}

function normalizeMessengerOrInstagram(
  payload: JsonObject,
  seenMessageIds: Set<string>,
) {
  const product = text(payload.object)?.toLowerCase();
  if (product !== "page" && product !== "instagram") return [];
  const channel: MetaChannel = product === "instagram" ? "instagram" : "messenger";
  const normalized: NormalizedInboundEvent[] = [];

  for (const [entryIndex, entry] of objects(payload.entry).entries()) {
    for (const [eventIndex, event] of objects(entry.messaging).entries()) {
      const sender = object(event.sender);
      const recipient = object(event.recipient);
      const externalAccountId = mandatoryAccountId(entry.id ?? recipient?.id);
      const message = object(event.message);
      const eventTimestamp = typeof event.timestamp === "number" ? String(event.timestamp) : "";

      if (message) {
        const providerMessageId = text(message.mid);
        if (!providerMessageId) throw new MetaProviderError("META_INBOUND_MESSAGE_ID_REQUIRED");
        if (message.is_echo === true) {
          normalized.push(ignored(providerMessageId, externalAccountId, "echo"));
          continue;
        }
        if (seenMessageIds.has(providerMessageId)) {
          normalized.push(ignored(providerMessageId, externalAccountId, "duplicate"));
          continue;
        }
        const body = text(message.text);
        if (!body) {
          normalized.push(ignored(providerMessageId, externalAccountId, "unsupported_message"));
          continue;
        }
        const row: NormalizedInboundMessage = {
          kind: "message",
          eventId: providerMessageId,
          providerMessageId,
          body,
          externalAccountId,
          identity: mandatoryIdentity(channel, sender?.id),
          providerWindow: providerWindow(event.timestamp, false),
          attribution: messengerAttribution(event.referral),
        };
        seenMessageIds.add(providerMessageId);
        normalized.push(row);
        continue;
      }

      const delivery = object(event.delivery);
      if (delivery) {
        const mids = Array.isArray(delivery.mids)
          ? delivery.mids.map(text).filter((mid): mid is string => mid !== null)
          : [];
        const ids = mids.length > 0
          ? mids
          : [stableId("meta-delivery", [externalAccountId, eventTimestamp, String(eventIndex)])];
        normalized.push(...ids.map((id) => status(id, externalAccountId, "delivered")));
        continue;
      }

      const read = object(event.read);
      if (read) {
        const eventId = stableId("meta-read", [
          externalAccountId,
          String(read.watermark ?? eventTimestamp),
        ]);
        normalized.push(status(eventId, externalAccountId, "read"));
        continue;
      }

      normalized.push(ignored(
        stableId("meta-ignored", [externalAccountId, String(entryIndex), String(eventIndex), eventTimestamp]),
        externalAccountId,
        "unsupported_event",
      ));
    }
  }
  return normalized;
}

function normalizeWhatsApp(payload: JsonObject, seenMessageIds: Set<string>) {
  if (text(payload.object)?.toLowerCase() !== "whatsapp_business_account") return [];
  const normalized: NormalizedInboundEvent[] = [];

  for (const [entryIndex, entry] of objects(payload.entry).entries()) {
    for (const [changeIndex, change] of objects(entry.changes).entries()) {
      const value = object(change.value);
      const metadata = object(value?.metadata);
      const externalAccountId = mandatoryAccountId(metadata?.phone_number_id);

      for (const message of objects(value?.messages)) {
        const providerMessageId = text(message.id);
        if (!providerMessageId) throw new MetaProviderError("META_INBOUND_MESSAGE_ID_REQUIRED");
        if (seenMessageIds.has(providerMessageId)) {
          normalized.push(ignored(providerMessageId, externalAccountId, "duplicate"));
          continue;
        }
        const messageText = object(message.text);
        const body = text(messageText?.body);
        if (!body) {
          normalized.push(ignored(providerMessageId, externalAccountId, "unsupported_message"));
          continue;
        }
        const row: NormalizedInboundMessage = {
          kind: "message",
          eventId: providerMessageId,
          providerMessageId,
          body,
          externalAccountId,
          identity: mandatoryIdentity("whatsapp", message.from),
          providerWindow: providerWindow(message.timestamp, true),
          attribution: whatsAppAttribution(message.referral),
        };
        seenMessageIds.add(providerMessageId);
        normalized.push(row);
      }

      for (const delivery of objects(value?.statuses)) {
        const deliveryId = text(delivery.id)
          ?? stableId("meta-whatsapp-status", [
            externalAccountId,
            String(delivery.timestamp ?? ""),
            String(normalized.length),
          ]);
        normalized.push(status(deliveryId, externalAccountId, text(delivery.status) ?? "unknown"));
      }

      if (!Array.isArray(value?.messages) && !Array.isArray(value?.statuses)) {
        normalized.push(ignored(
          stableId("meta-whatsapp-ignored", [
            externalAccountId,
            String(entryIndex),
            String(changeIndex),
          ]),
          externalAccountId,
          "unsupported_event",
        ));
      }
    }
  }
  return normalized;
}

export function verifyMetaWebhookSignature(
  rawBody: Uint8Array,
  signature: string,
  appSecret: string,
) {
  if (!/^sha256=[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const received = Buffer.from(signature.slice("sha256=".length), "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function verifyMetaWebhookHandshake(
  query: URLSearchParams,
  webhookVerifyToken: string,
) {
  if (query.get("hub.mode") !== "subscribe") return null;
  if (query.get("hub.verify_token") !== webhookVerifyToken) return null;
  return query.get("hub.challenge");
}

export function normalizeMetaInbound(payload: unknown): NormalizedInboundBatch {
  const row = object(payload);
  if (!row) throw new MetaProviderError("META_INBOUND_ENVELOPE_INVALID");
  const seenMessageIds = new Set<string>();
  const events = [
    ...normalizeMessengerOrInstagram(row, seenMessageIds),
    ...normalizeWhatsApp(row, seenMessageIds),
  ];
  if (events.length === 0) throw new MetaProviderError("META_INBOUND_ENVELOPE_INVALID");
  return { events };
}

async function responseJson(response: Response, code: string) {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new MetaProviderError(`${code}_MALFORMED_JSON`, response.status, "non-json");
  }
  if (!response.ok) throw new MetaProviderError(code, response.status, shape(payload));
  return payload;
}

function missingConnection(channel: MetaChannel): never {
  throw new MetaProviderError(`META_CONNECTION_UNAVAILABLE:${channel}`);
}

function metaChannel(channel: MessagingChannel): MetaChannel {
  if (channel === "instagram" || channel === "messenger" || channel === "whatsapp") return channel;
  throw new MetaProviderError(`META_CHANNEL_UNSUPPORTED:${channel}`);
}

function sealedCommand(input: AuthorizedOutboundCommand): AuthorizedOutboundCommand {
  if (input.kind === "human_tag") {
    const actor = object(input.actor);
    if (!text(actor?.userId)) throw new MetaProviderError("META_HUMAN_ACTOR_REQUIRED");
  }
  return input;
}

function validateCommand(command: AuthorizedOutboundCommand) {
  const channel = metaChannel(command.channel);
  const recipientExternalId = text(command.recipientExternalId);
  if (!recipientExternalId) throw new MetaProviderError("META_RECIPIENT_REQUIRED");
  if (command.kind === "approved_template" && channel !== "whatsapp") {
    throw new MetaProviderError("META_TEMPLATE_CHANNEL_UNSUPPORTED");
  }
  if (command.kind === "human_tag" && channel === "whatsapp") {
    throw new MetaProviderError("META_HUMAN_TAG_CHANNEL_UNSUPPORTED");
  }
  return { channel, recipientExternalId };
}

function sendPayload(command: AuthorizedOutboundCommand) {
  const { channel, recipientExternalId } = validateCommand(command);
  if (channel === "whatsapp") {
    if (command.kind === "approved_template") {
      const parameters = Object.entries(command.variables).map(([, value]) => ({
        type: "text",
        text: value,
      }));
      return {
        messaging_product: "whatsapp",
        to: recipientExternalId,
        type: "template",
        template: {
          name: command.providerTemplateName,
          language: { code: command.locale },
          ...(parameters.length > 0
            ? { components: [{ type: "body", parameters }] }
            : {}),
        },
      };
    }
    if (command.kind !== "freeform") {
      throw new MetaProviderError("META_WHATSAPP_COMMAND_UNSUPPORTED");
    }
    return {
      messaging_product: "whatsapp",
      to: recipientExternalId,
      type: "text",
      text: { body: command.body },
    };
  }
  if (command.kind === "approved_template") {
    throw new MetaProviderError("META_TEMPLATE_CHANNEL_UNSUPPORTED");
  }
  return {
    recipient: { id: recipientExternalId },
    ...(command.kind === "human_tag"
      ? { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" }
      : channel === "messenger"
        ? { messaging_type: "RESPONSE" }
        : {}),
    message: { text: command.body },
  };
}

function createMetaDriver({
  verifyWebhook,
  send,
}: {
  verifyWebhook(rawBody: Uint8Array, signature: string): Promise<boolean>;
  send(command: AuthorizedOutboundCommand): Promise<{ providerMessageId: string }>;
}): MetaMessagingDriver {
  return {
    provider: "meta_direct",
    verifyWebhook,
    normalizeInbound: async (payload) => normalizeMetaInbound(payload),
    capabilities: (channel) => DIRECT_META_MESSAGING_CAPABILITIES[channel],
    send: async (input) => send(sealedCommand(input)),
  };
}

export function createMockMetaDriver(): MetaMessagingDriver {
  return createMetaDriver({
    // The mock verifies the same raw-byte HMAC contract so credential-free tests exercise the
    // production boundary instead of replacing signature verification with a magic string.
    verifyWebhook: async (rawBody, signature) =>
      verifyMetaWebhookSignature(rawBody, signature, MOCK_APP_SECRET),
    send: async (command) => {
      const { channel, recipientExternalId } = validateCommand(command);
      return {
        providerMessageId: stableId("mock-meta-message", [
          recipientExternalId,
          channel,
          command.kind,
          command.kind === "approved_template" ? command.providerTemplateName : command.body,
        ]),
      };
    },
  });
}

export function createRealMetaDriver(
  configuration: MetaDriverConfiguration,
  {
    fetch: fetcher = fetch,
    resolveConnection = async (channel) => missingConnection(channel),
  }: {
    fetch?: FetchLike;
    resolveConnection?: (channel: MetaChannel) => Promise<MetaConnection>;
  } = {},
): MetaMessagingDriver {
  return createMetaDriver({
    verifyWebhook: async (rawBody, signature) =>
      verifyMetaWebhookSignature(rawBody, signature, configuration.appSecret),
    send: async (command) => {
      const { channel } = validateCommand(command);
      const connection = await resolveConnection(channel);
      const url = `${connection.host}/${META_GRAPH_VERSION}/${encodeURIComponent(connection.senderId)}/messages`;
      const response = await fetcher(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${connection.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(sendPayload(command)),
      });
      const payload = object(await responseJson(response, "META_SEND_FAILED"));
      const providerMessageId = text(payload?.message_id) ?? text(payload?.messageId);
      if (!providerMessageId) {
        throw new MetaProviderError(
          "META_SEND_SUCCESS_ENVELOPE_INVALID",
          response.status,
          shape(payload),
        );
      }
      return { providerMessageId };
    },
  });
}
