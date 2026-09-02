import { after } from "next/server";

import {
  driverSelection,
  phase4Live,
  requireEnvironment,
} from "@/lib/env-contract";
import {
  createMockMetaDriver,
  createRealMetaDriver,
  verifyMetaWebhookHandshake,
} from "@/lib/integrations/meta";
import { selectMetaDriver } from "@/lib/integrations/selector";
import type {
  MessagingChannel,
  MetaDriver,
  NormalizedInboundEvent,
} from "@/lib/integrations/types";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  persistWebhookReceipt,
  processLiveWebhookReceipt,
  tenantReceiptEventId,
  type WebhookReceiptRead,
  type WebhookReceiptWrite,
} from "@/lib/webhooks/process-inbound";

const MAX_WEBHOOK_BYTES = 256 * 1024;
const noStoreHeaders = { "Cache-Control": "no-store" };

type MetaChannel = Extract<MessagingChannel, "instagram" | "messenger" | "whatsapp">;

type MetaWebhookDependencies = {
  driver: Pick<MetaDriver, "verifyWebhook" | "normalizeInbound">;
  resolveTenant(externalAccountId: string, channel: MetaChannel | null): Promise<string | null>;
  persistReceipt(input: WebhookReceiptWrite): Promise<WebhookReceiptRead>;
  processReceipt(receipt: WebhookReceiptRead): Promise<void>;
  schedule(callback: () => Promise<void>): void;
};

type MetaVerificationDependencies = {
  verifyToken(): string;
};

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status, headers: noStoreHeaders });
}

function eventType(event: NormalizedInboundEvent) {
  if (event.kind === "message") return "InboundMessage";
  return event.kind === "status" ? "Status" : "Ignored";
}

function eventChannel(event: NormalizedInboundEvent): MetaChannel | null {
  if (event.kind !== "message") return null;
  const channel = event.identity.channel;
  return channel === "instagram" || channel === "messenger" || channel === "whatsapp"
    ? channel
    : null;
}

async function rawBody(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  return bytes.byteLength > MAX_WEBHOOK_BYTES ? null : bytes;
}

export function createMetaWebhookVerificationHandler(dependencies: MetaVerificationDependencies) {
  return async function GET(request: Request) {
    if (!phase4Live()) return json({ error: "Not found." }, 404);
    try {
      const challenge = verifyMetaWebhookHandshake(
        new URL(request.url).searchParams,
        dependencies.verifyToken(),
      );
      if (challenge === null) return json({ error: "Webhook verification refused." }, 403);
      return new Response(challenge, { status: 200, headers: noStoreHeaders });
    } catch {
      return json({ error: "Webhook verification unavailable." }, 503);
    }
  };
}

export function createMetaWebhookHandler(dependencies: MetaWebhookDependencies) {
  return async function POST(request: Request) {
    if (!phase4Live()) return json({ error: "Not found." }, 404);

    let bytes: Uint8Array | null;
    try {
      bytes = await rawBody(request);
    } catch {
      return json({ error: "Webhook body could not be read." }, 503);
    }
    if (!bytes) return json({ error: "Webhook body is too large." }, 413);

    const signature = request.headers.get("x-hub-signature-256");
    try {
      if (!signature || !(await dependencies.driver.verifyWebhook(bytes, signature))) {
        return json({ error: "Invalid webhook signature." }, 401);
      }
    } catch {
      return json({ error: "Webhook verification unavailable." }, 503);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return json({ error: "Invalid webhook body." }, 400);
    }

    let events: readonly NormalizedInboundEvent[];
    try {
      events = (await dependencies.driver.normalizeInbound(payload)).events;
      if (events.length === 0 || events.some((event) => eventChannel(event) === null && event.kind === "message")) {
        return json({ error: "Unsupported webhook event." }, 400);
      }
    } catch {
      return json({ error: "Unsupported webhook event." }, 400);
    }

    try {
      // Resolve the complete batch before the first write. One ambiguous active account must not
      // leave a partially accepted provider envelope that Meta cannot replay coherently.
      const resolved = await Promise.all(events.map(async (event) => ({
        event,
        tenantId: await dependencies.resolveTenant(event.externalAccountId, eventChannel(event)),
      })));
      if (resolved.some(({ tenantId }) => tenantId === null)) {
        return json({ error: "Unknown webhook connection." }, 404);
      }

      for (const { event, tenantId } of resolved) {
        if (!tenantId) throw new Error("META_CONNECTION_UNRESOLVED");
        const receipt = await dependencies.persistReceipt({
          provider: "meta",
          providerEventId: tenantReceiptEventId({
            tenantId,
            eventId: event.eventId,
            providerMessageId: event.kind === "message" ? event.providerMessageId : null,
          }),
          tenantId,
          eventType: eventType(event),
          payload: { normalized: { events: [event] } },
        });
        if (receipt.inserted || receipt.status === "received" || receipt.status === "failed") {
          dependencies.schedule(() => dependencies.processReceipt(receipt));
        }
      }
      return json({ received: true }, 200);
    } catch {
      // Provider retries are the recovery path for lookup, receipt, and scheduling outages. A 4xx
      // here would convert a transient infrastructure failure into permanent event loss.
      return json({ error: "Webhook processing unavailable." }, 503);
    }
  };
}

async function resolveMetaTenant(externalAccountId: string, channel: MetaChannel | null) {
  const client = createSupabaseServiceClient();
  let query = client
    .from("channel_connections")
    .select("tenant_id, channel")
    .eq("provider", "meta_direct")
    .eq("external_account_id", externalAccountId)
    .in("state", ["ready", "live"]);
  if (channel) query = query.eq("channel", channel);
  const { data, error } = await query;
  if (error) throw new Error("META_CONNECTION_LOOKUP_FAILED");
  const rows = data ?? [];
  if (rows.length !== 1) return null;
  return typeof rows[0].tenant_id === "string" ? rows[0].tenant_id : null;
}

function liveWebhookVerifyToken() {
  if (driverSelection("meta", "SETTERFI_META_DRIVER") !== "real") {
    throw new Error("META_WEBHOOK_REAL_DRIVER_REQUIRED");
  }
  return requireEnvironment("meta", ["META_WEBHOOK_VERIFY_TOKEN"]).META_WEBHOOK_VERIFY_TOKEN;
}

const liveDriver = () => {
  if (driverSelection("meta", "SETTERFI_META_DRIVER") !== "real") {
    throw new Error("META_WEBHOOK_REAL_DRIVER_REQUIRED");
  }
  return selectMetaDriver({
    factories: { mock: createMockMetaDriver, real: createRealMetaDriver },
  });
};

export const GET = createMetaWebhookVerificationHandler({ verifyToken: liveWebhookVerifyToken });

export const POST = createMetaWebhookHandler({
  get driver() { return liveDriver(); },
  resolveTenant: resolveMetaTenant,
  persistReceipt: persistWebhookReceipt,
  processReceipt: processLiveWebhookReceipt,
  schedule: (callback) => after(callback),
});
