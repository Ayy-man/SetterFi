/**
 * Reconciliation executors for coach-owned connection and offer steps.
 *
 * OAuth launches and provider assets remain owned by Phase 4. These executors only read the
 * persisted connection authority, verify ready Meta credentials through its declared resolver,
 * and return a normalized outcome for the runner to commit.
 */

import {
  resolveMetaConnection as resolveMergedMetaConnection,
} from "@/lib/integrations/connection-resolver";
import { whatsappEmbeddedSignupEnabled } from "@/lib/env-contract";
import type { MessagingChannel } from "@/lib/integrations/types";
import type {
  OfferReadinessPort,
  ProvisioningStep,
  StepAttempt,
  StepExecutor,
  StepOutcome,
} from "@/lib/onboarding/contracts";
import {
  listChannelConnections,
  type ChannelConnectionState,
} from "@/lib/repositories/channel-connections";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type CoachConnectionSnapshot = {
  connectionId: string;
  channel: MessagingChannel;
  state: ChannelConnectionState;
};

export type CalendarConnectionSnapshot = {
  connectionId: string;
  state: "disconnected" | "connecting" | "ready" | "error" | "expired";
};

export type CoachLaneDependencies = {
  loadConnections(
    tenantId: string,
    channels: readonly MessagingChannel[],
  ): Promise<readonly CoachConnectionSnapshot[]>;
  resolveMetaConnection?: typeof resolveMergedMetaConnection;
  whatsappCapability(tenantId: string): Promise<"enabled" | "disabled" | "weekly_cap_queued">;
  loadPrimaryCalendar(tenantId: string): Promise<CalendarConnectionSnapshot | null>;
  offerReadiness: OfferReadinessPort;
};

const META_CHANNELS = ["instagram", "messenger"] as const;

function requireStep(attempt: StepAttempt, expected: ProvisioningStep) {
  if (attempt.stepKey !== expected) throw new Error(`ONBOARDING_EXECUTOR_STEP_MISMATCH:${expected}`);
}

function newestConnection(connections: readonly CoachConnectionSnapshot[]) {
  return connections[0] ?? null;
}

async function verifiedMetaDone(
  attempt: StepAttempt,
  connection: CoachConnectionSnapshot,
  resolver: CoachLaneDependencies["resolveMetaConnection"],
): Promise<StepOutcome> {
  if (typeof resolver !== "function") throw new Error("PHASE4_META_CONNECT_SEAM_MISSING");
  await resolver(attempt.tenantId, connection.channel);
  return {
    kind: "done",
    externalRef: { connection_id: connection.connectionId, channel: connection.channel },
  };
}

function terminalConnection(connection: CoachConnectionSnapshot): StepOutcome | null {
  return connection.state === "blocked_permanent"
    ? {
        kind: "blocked",
        code: "CHANNEL_CONNECTION_BLOCKED_PERMANENT",
        safeMessage: "This connection is permanently unavailable until support corrects it.",
      }
    : null;
}

export function createMetaConnectExecutor(dependencies: CoachLaneDependencies): StepExecutor {
  return async (attempt) => {
    requireStep(attempt, "meta_connect");
    const connection = newestConnection(await dependencies.loadConnections(
      attempt.tenantId,
      META_CHANNELS,
    ));
    if (!connection) return { kind: "awaiting_coach", code: "meta_connection_required" };
    const terminal = terminalConnection(connection);
    if (terminal) return terminal;
    if (connection.state === "ready" || connection.state === "live") {
      return verifiedMetaDone(attempt, connection, dependencies.resolveMetaConnection);
    }
    if (connection.state === "pending_review") {
      return {
        kind: "awaiting_provider",
        party: "meta",
        externalRef: { connection_id: connection.connectionId, channel: connection.channel },
      };
    }
    return { kind: "awaiting_coach", code: "meta_connection_action_required" };
  };
}

export function createWhatsappConnectExecutor(dependencies: CoachLaneDependencies): StepExecutor {
  return async (attempt) => {
    requireStep(attempt, "whatsapp_connect");
    const capability = await dependencies.whatsappCapability(attempt.tenantId);
    if (capability === "disabled") {
      return {
        kind: "blocked",
        code: "WHATSAPP_EMBEDDED_SIGNUP_DISABLED",
        safeMessage: "WhatsApp setup is not available for this account.",
      };
    }
    if (capability === "weekly_cap_queued") {
      return { kind: "awaiting_platform", code: "whatsapp_weekly_cap_queued" };
    }
    const connection = newestConnection(await dependencies.loadConnections(
      attempt.tenantId,
      ["whatsapp"],
    ));
    if (!connection) return { kind: "awaiting_coach", code: "whatsapp_connection_required" };
    const terminal = terminalConnection(connection);
    if (terminal) return terminal;
    if (connection.state === "ready" || connection.state === "live") {
      return verifiedMetaDone(attempt, connection, dependencies.resolveMetaConnection);
    }
    if (connection.state === "pending_review") {
      return {
        kind: "awaiting_provider",
        party: "meta",
        externalRef: { connection_id: connection.connectionId, channel: "whatsapp" },
      };
    }
    return { kind: "awaiting_coach", code: "whatsapp_connection_action_required" };
  };
}

export function createCalendarConnectExecutor(dependencies: CoachLaneDependencies): StepExecutor {
  return async (attempt) => {
    requireStep(attempt, "calendar_connect");
    const connection = await dependencies.loadPrimaryCalendar(attempt.tenantId);
    if (!connection || connection.state !== "ready") {
      return { kind: "awaiting_coach", code: "primary_calendar_connection_required" };
    }
    return { kind: "done", externalRef: { calendar_connection_id: connection.connectionId } };
  };
}

export function createOfferLayerExecutor(dependencies: CoachLaneDependencies): StepExecutor {
  return async (attempt) => {
    requireStep(attempt, "offer_layer");
    const offer = await dependencies.offerReadiness(attempt.tenantId);
    if (offer.reviewState === "held") {
      return { kind: "awaiting_platform", code: "offer_held" };
    }
    if (offer.reviewState === "unavailable") {
      return { kind: "awaiting_platform", code: "offer_review_contract_unavailable" };
    }
    if (!offer.published || !offer.programName?.trim() || !offer.bookingMode?.trim()) {
      return { kind: "awaiting_coach", code: "offer_required_fields_incomplete" };
    }
    return {
      kind: "done",
      externalRef: { offer_evidence_at: offer.evidenceAt },
    };
  };
}

export function createCoachLaneExecutors(dependencies: CoachLaneDependencies) {
  return {
    meta_connect: createMetaConnectExecutor(dependencies),
    whatsapp_connect: createWhatsappConnectExecutor(dependencies),
    calendar_connect: createCalendarConnectExecutor(dependencies),
    offer_layer: createOfferLayerExecutor(dependencies),
  } as const satisfies Readonly<Partial<Record<ProvisioningStep, StepExecutor>>>;
}

/** Live adapter uses Phase 4's metadata reader and credential-resolving seam without copying them. */
export function createLiveCoachLaneDependencies({
  offerReadiness,
  whatsappCapability = async () => whatsappEmbeddedSignupEnabled() ? "enabled" : "disabled",
}: {
  offerReadiness: OfferReadinessPort;
  whatsappCapability?: CoachLaneDependencies["whatsappCapability"];
}): CoachLaneDependencies {
  const client = createSupabaseServiceClient();
  return {
    loadConnections: async (tenantId, channels) => (
      await listChannelConnections(tenantId)
    ).filter((connection) => channels.includes(connection.channel)).map((connection) => ({
      connectionId: connection.id,
      channel: connection.channel,
      state: connection.state,
    })),
    resolveMetaConnection: resolveMergedMetaConnection,
    whatsappCapability,
    loadPrimaryCalendar: async (tenantId) => {
      const { data, error } = await client
        .from("calendar_connections")
        .select("id, state")
        .eq("tenant_id", tenantId)
        .eq("is_primary", true)
        .maybeSingle();
      if (error) throw new Error(`PRIMARY_CALENDAR_READ_FAILED:${error.message}`);
      if (!data) return null;
      return { connectionId: data.id, state: data.state } as CalendarConnectionSnapshot;
    },
    offerReadiness,
  };
}
