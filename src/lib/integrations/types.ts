/**
 * Provider-neutral messaging contracts.
 *
 * Provider payloads end at normalization. The durable processor and every outbound policy caller
 * compile against these shapes so switching plumbing cannot change the engine input.
 */

export const IDENTITY_PROVIDERS = ["meta_direct", "ghl"] as const;
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];

export const MESSAGING_CHANNELS = [
  "instagram",
  "messenger",
  "sms",
  "whatsapp",
  "webchat",
] as const;
export type MessagingChannel = (typeof MESSAGING_CHANNELS)[number];

export type NormalizedIdentity = {
  channel: MessagingChannel;
  provider: IdentityProvider;
  externalId: string;
  normalizedPhone: string | null;
  normalizedEmail: string | null;
};

export type ProviderWindow = {
  observedAt: string;
  expiresAt: string;
  source: "provider" | "derived_24h";
};

export type NormalizedInboundAttribution = {
  adId: string | null;
  source: "ADS" | null;
  ref: string | null;
  adsContextData: {
    adTitle?: string;
    postId?: string;
  };
  ctwaClid: string | null;
};

export type NormalizedInboundMessage = {
  kind: "message";
  eventId: string;
  providerMessageId: string;
  body: string;
  externalAccountId: string;
  identity: NormalizedIdentity;
  providerWindow: ProviderWindow | null;
  attribution?: NormalizedInboundAttribution | null;
};

export type NormalizedInboundIgnored = {
  kind: "ignored";
  eventId: string;
  externalAccountId: string;
  reason: string;
};

export type NormalizedInboundStatus = {
  kind: "status";
  eventId: string;
  externalAccountId: string;
  status: string;
};

export type NormalizedInboundEvent =
  | NormalizedInboundMessage
  | NormalizedInboundIgnored
  | NormalizedInboundStatus;

export type NormalizedInboundBatch = {
  events: readonly NormalizedInboundEvent[];
};

export type MessagingCapabilities = {
  windowed: boolean;
  postWindow: "none" | "human_tag" | "template";
  templates: boolean;
};

type OutboundBase = {
  channel: MessagingChannel;
  recipientExternalId: string;
  /** Stable application send key; adapters forward it only when their API supports idempotency. */
  idempotencyKey?: string;
};

export type FreeformCommand = OutboundBase & {
  kind: "freeform";
  body: string;
};

export type ApprovedTemplateCommand = OutboundBase & {
  kind: "approved_template";
  templateId: string;
  providerTemplateName: string;
  locale: string;
  bodyHash: string;
  variables: Readonly<Record<string, string>>;
};

const HUMAN_ACTOR_PROOF = Symbol("setterfi-human-actor-proof");

export type HumanActorProof = {
  readonly userId: string;
  readonly [HUMAN_ACTOR_PROOF]: true;
};

export type HumanTaggedCommand = OutboundBase & {
  kind: "human_tag";
  body: string;
  actor: HumanActorProof;
};

export type AuthorizedOutboundCommand =
  | FreeformCommand
  | ApprovedTemplateCommand
  | HumanTaggedCommand;

export type MessagingSendResult = { providerMessageId: string };

export type MessagingDriver = {
  readonly provider: IdentityProvider;
  verifyWebhook(rawBody: Uint8Array, signature: string): Promise<boolean>;
  normalizeInbound(payload: unknown): Promise<NormalizedInboundBatch>;
  capabilities(channel: MessagingChannel): MessagingCapabilities;
  send(command: AuthorizedOutboundCommand): Promise<MessagingSendResult>;
};

/** Provider-specific selectors retain this name while sharing the Contract A driver shape. */
export type MetaDriver = MessagingDriver;

export type GhlMessagingAdapter = MessagingDriver & {
  reconcileInstall(input: { eventId: string; locationId: string }): Promise<{
    companyId: string;
    accessToken: string;
    refreshToken: string;
    tokenExpiresAt: string;
  }>;
};

const NON_WINDOWED_CAPABILITIES: MessagingCapabilities = {
  windowed: false,
  postWindow: "none",
  templates: false,
};

export const GHL_MESSAGING_CAPABILITIES: Readonly<
  Record<MessagingChannel, MessagingCapabilities>
> = {
  instagram: NON_WINDOWED_CAPABILITIES,
  messenger: NON_WINDOWED_CAPABILITIES,
  sms: NON_WINDOWED_CAPABILITIES,
  whatsapp: NON_WINDOWED_CAPABILITIES,
  webchat: NON_WINDOWED_CAPABILITIES,
};

export const DIRECT_META_MESSAGING_CAPABILITIES: Readonly<
  Record<MessagingChannel, MessagingCapabilities>
> = {
  instagram: { windowed: true, postWindow: "none", templates: false },
  messenger: { windowed: true, postWindow: "none", templates: false },
  sms: NON_WINDOWED_CAPABILITIES,
  whatsapp: { windowed: true, postWindow: "template", templates: true },
  webchat: NON_WINDOWED_CAPABILITIES,
};

export function resolveMessagingCapabilities(
  provider: IdentityProvider,
  channel: MessagingChannel,
): MessagingCapabilities {
  return provider === "ghl"
    ? GHL_MESSAGING_CAPABILITIES[channel]
    : DIRECT_META_MESSAGING_CAPABILITIES[channel];
}

export function authorizeHumanActor(input: { userId: string; authorized: boolean }): HumanActorProof {
  const userId = input.userId.trim();
  if (!input.authorized || !userId) throw new Error("HUMAN_ACTOR_PROOF_REQUIRED");
  return { userId, [HUMAN_ACTOR_PROOF]: true };
}

export function createHumanTaggedCommand(
  input: Omit<HumanTaggedCommand, "kind" | "actor">,
  actor: HumanActorProof,
): HumanTaggedCommand {
  if (actor[HUMAN_ACTOR_PROOF] !== true) throw new Error("HUMAN_ACTOR_PROOF_REQUIRED");
  return { kind: "human_tag", ...input, actor };
}

export interface CalendarDriver {
  fetchSlots(input: {
    locationId: string;
    calendarId: string;
    startAt: string;
    endAt: string;
    timezone: string;
    signal?: AbortSignal;
  }): Promise<Array<{ id: string; startAt: string; endAt: string; timezone: string }>>;
  createAppointment(input: {
    locationId: string;
    calendarId: string;
    contactId: string;
    startAt: string;
    endAt: string;
    timezone: string;
    signal?: AbortSignal;
  }): Promise<{ externalId: string }>;
  updateAppointment(input: {
    locationId: string;
    externalId: string;
    startAt: string;
    endAt: string;
    timezone: string;
  }): Promise<{ externalId: string }>;
  cancelAppointment(input: { locationId: string; externalId: string }): Promise<void>;
  listAppointments(input: {
    locationId: string;
    calendarId: string;
    startAt: string;
    endAt: string;
    signal?: AbortSignal;
  }): Promise<Array<{
    externalId: string;
    contactId: string;
    startAt: string;
    endAt: string;
    status: string;
  }>>;
}

export interface ModelDriver {
  generate(
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    config: { model: string; params: Record<string, unknown> },
  ): Promise<{
    draft: string;
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    provider: { name: string; generationId: string | null; latencyMs: number; cost: number | null };
  }>;
}

export interface ModeratorDriver {
  moderate(inputs: {
    draft: string;
    leadMessage: string;
    numberAllowlist: string[];
    complianceLexicon: string[];
    linkWhitelist: string[];
    roleBoundary: string;
  }): Promise<{
    verdict: "allow" | "block";
    class: "NUM" | "CLAIM" | "ECHO" | "LINK" | "SCOPE" | "LEN" | "JUDGE" | "REVOKE";
    rule_id?: string;
    reason: string;
  }>;
}

// Phase 5
export type {
  A2pSubmission,
  ApprovedA2pInput,
  ApprovedCampaignInput,
  GhlLocation,
  GhlLocationRequest,
  GhlNumberRequest,
  GhlProvisioningDriver,
  GhlSnapshotRequest,
  GhlSnapshotStatus,
  OwnedProbeInput,
  PostalAddress,
  ProvisioningContext,
  PurchasedNumber,
} from "@/lib/onboarding/provider-contracts";
