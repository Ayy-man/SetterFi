/**
 * Authenticated provider cutover over Contract B.
 *
 * `/api/channels/meta/*` is the static Meta-provider namespace, while
 * `/api/channels/[channel]/*` is the messaging-channel namespace. Keeping the distinction here
 * prevents `/meta/switch` from backtracking into a provider route when `meta` is not a channel.
 */

import type { AuditActionKey } from "@/lib/audit/actions";
import { phase4Live } from "@/lib/env-contract";
import { MESSAGING_CHANNELS, type MessagingChannel } from "@/lib/integrations/types";
import {
  ProviderSwitchError,
  switchChannelProvider,
  type ProviderIdentityBackfill,
  type SwitchProviderResult,
} from "@/lib/services/provider-switch";
import {
  loadRouteActor,
  type RouteActor,
} from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";

const noStoreHeaders = { "Cache-Control": "no-store" };
const PROVIDER_SWITCH_ACTION = "channel.provider.switched" satisfies AuditActionKey;

type SwitchRouteDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  switchProvider(input: Parameters<typeof switchChannelProvider>[0]): Promise<SwitchProviderResult>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function isChannel(value: string): value is MessagingChannel {
  return MESSAGING_CHANNELS.includes(value as MessagingChannel);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseBackfill(value: unknown): ProviderIdentityBackfill[] {
  if (!Array.isArray(value)) throw new Error("IDENTITY_BACKFILL_INVALID");
  return value.map((item) => {
    if (!isRecord(item) ||
      !hasExactKeys(item, ["outgoingExternalId", "incomingExternalId", "contactId"]) ||
      !nonBlank(item.outgoingExternalId) || !nonBlank(item.incomingExternalId) ||
      !nonBlank(item.contactId)) {
      throw new Error("IDENTITY_BACKFILL_INVALID");
    }
    return {
      outgoingExternalId: item.outgoingExternalId.trim(),
      incomingExternalId: item.incomingExternalId.trim(),
      contactId: item.contactId.trim(),
    };
  });
}

export function createProviderSwitchHandler(dependencies: SwitchRouteDependencies) {
  return async function POST(request: Request, context: { params: Promise<{ channel: string }> }) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    const actor = await dependencies.session();
    if (!actor) {
      return Response.json(
        { error: "Authentication required." },
        { status: 401, headers: noStoreHeaders },
      );
    }
    if (hasImpersonationMarker(actor)) {
      return Response.json(
        { error: "Provider switch is unavailable while viewing as a coach." },
        { status: 403, headers: noStoreHeaders },
      );
    }

    try {
      const { channel } = await context.params;
      if (!isChannel(channel)) throw new Error("MESSAGING_CHANNEL_INVALID");
      const body: unknown = await request.json();
      if (!isRecord(body) || !hasExactKeys(body, [
        "outgoingConnectionId",
        "incomingConnectionId",
        "backfill",
        "reason",
        "idempotencyKey",
      ]) || !nonBlank(body.outgoingConnectionId) || !nonBlank(body.incomingConnectionId) ||
        !nonBlank(body.reason) || !nonBlank(body.idempotencyKey)) {
        throw new Error("PROVIDER_SWITCH_BODY_INVALID");
      }
      const result = await dependencies.switchProvider({
        expectedTenantId: actor.tenantId,
        channel,
        outgoingConnectionId: body.outgoingConnectionId.trim(),
        incomingConnectionId: body.incomingConnectionId.trim(),
        backfill: parseBackfill(body.backfill),
        actorUserId: actor.userId,
        reason: body.reason.trim(),
        idempotencyKey: body.idempotencyKey.trim(),
      });
      return Response.json({
        state: result.state,
        appliedIdentityCount: result.appliedIdentityCount,
        outgoingConnectionId: result.outgoingConnectionId,
        incomingConnectionId: result.incomingConnectionId,
        audit: { id: result.auditId, action: PROVIDER_SWITCH_ACTION },
      }, { headers: noStoreHeaders });
    } catch (error) {
      const code = error instanceof ProviderSwitchError
        ? error.code
        : "PROVIDER_SWITCH_REFUSED";
      return Response.json(
        { error: "Provider switch was refused.", code },
        { status: 409, headers: noStoreHeaders },
      );
    }
  };
}

export const POST = createProviderSwitchHandler({
  enabled: phase4Live,
  session: loadRouteActor,
  switchProvider: switchChannelProvider,
});
