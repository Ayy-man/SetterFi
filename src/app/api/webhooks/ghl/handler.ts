import { after } from "next/server";

import { phase1Live } from "@/lib/env-contract";
import { createRealGhlDriver, normalizeGhlInstall } from "@/lib/integrations/ghl";
import { selectGhlMessagingDriver } from "@/lib/integrations/selector";
import type { GhlMessagingAdapter, NormalizedInboundEvent } from "@/lib/integrations/types";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  markGhlUninstalled,
  persistWebhookReceipt,
  processGhlUninstallReceipt,
  processLiveWebhookReceipt,
  tenantReceiptEventId,
  type WebhookReceiptRead,
  type WebhookReceiptWrite,
} from "@/lib/webhooks/process-inbound";

const MAX_WEBHOOK_BYTES = 256 * 1024;
const noStoreHeaders = { "Cache-Control": "no-store" };

type GhlWebhookDependencies = {
  driver: GhlMessagingAdapter;
  resolveTenant(locationId: string): Promise<string | null>;
  persistReceipt(input: WebhookReceiptWrite): Promise<WebhookReceiptRead>;
  processReceipt(receipt: WebhookReceiptRead): Promise<unknown>;
  processUninstall(receipt: WebhookReceiptRead): Promise<void>;
  schedule(callback: () => Promise<unknown>): void;
};

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status, headers: noStoreHeaders });
}

function eventType(event: NormalizedInboundEvent) {
  if (event.kind === "message") return "InboundMessage";
  return event.kind === "status" ? "Status" : "Ignored";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type GhlLifecycleEvent = "INSTALL" | "UNINSTALL";

/**
 * INSTALL and UNINSTALL are opposite events whose names share a substring, so the discrimination
 * has to be exact. A substring match reads "UNINSTALL" as an install, and the INSTALL reconciler
 * would then re-seal live credentials for an account that just revoked them.
 */
function lifecycleEvent(payload: unknown): GhlLifecycleEvent | null {
  if (!isRecord(payload)) return null;
  const kind = typeof payload.type === "string" ? payload.type : payload.eventType;
  if (typeof kind !== "string") return null;
  const normalized = kind.trim().toUpperCase();
  if (normalized === "INSTALL") return "INSTALL";
  if (normalized === "UNINSTALL") return "UNINSTALL";
  return null;
}

async function rawBody(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  return bytes.byteLength > MAX_WEBHOOK_BYTES ? null : bytes;
}

export function createGhlWebhookHandler(dependencies: GhlWebhookDependencies) {
  return async function POST(request: Request) {
    if (!phase1Live()) return json({ error: "Not found." }, 404);
    const bytes = await rawBody(request);
    if (!bytes) return json({ error: "Webhook body is too large." }, 413);
    const signature = request.headers.get("x-ghl-signature")
      ?? request.headers.get("x-wh-signature");
    if (!signature) {
      return json({ error: "Invalid webhook signature." }, 401);
    }
    let verified = false;
    try {
      verified = await dependencies.driver.verifyWebhook(bytes, signature);
    } catch {
      return json({ error: "Webhook verification unavailable." }, 503);
    }
    if (!verified) return json({ error: "Invalid webhook signature." }, 401);

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return json({ error: "Invalid webhook body." }, 400);
    }

    const lifecycle = lifecycleEvent(payload);
    if (lifecycle) {
      let install: ReturnType<typeof normalizeGhlInstall>;
      try {
        install = normalizeGhlInstall(payload);
      } catch {
        return json({ error: "Unsupported webhook event." }, 400);
      }
      if (lifecycle === "UNINSTALL" && !install.locationId) {
        return json({ error: "Unsupported webhook event." }, 400);
      }
      let tenantId: string | null;
      try {
        tenantId = install.locationId
          ? await dependencies.resolveTenant(install.locationId)
          : null;
      } catch {
        return json({ error: "Webhook tenant lookup unavailable." }, 503);
      }
      let receipt: WebhookReceiptRead;
      try {
        receipt = await dependencies.persistReceipt({
          provider: "ghl",
          providerEventId: tenantReceiptEventId({
            // Lifecycle identity must stay stable as an install moves from unresolved to installed
            // or uninstalled. Tenant scope is still persisted and checked separately.
            tenantId: null,
            eventId: install.eventId,
            providerMessageId: null,
            unresolvedScope: install.locationId ?? install.companyId,
          }),
          tenantId,
          eventType: lifecycle,
          payload: {
            raw: isRecord(payload) ? payload : {},
            normalized: install,
          },
        });
      } catch {
        return json({ error: "Webhook receipt unavailable." }, 503);
      }
      if (receipt.status === "received" || receipt.status === "failed") {
        try {
          dependencies.schedule(() => lifecycle === "UNINSTALL"
            ? dependencies.processUninstall(receipt)
            : dependencies.processReceipt(receipt));
        } catch {
          return json({ error: "Webhook scheduling unavailable." }, 503);
        }
      }
      return json({ received: true }, 200);
    }

    let normalized: Awaited<ReturnType<GhlMessagingAdapter["normalizeInbound"]>>;
    try {
      normalized = await dependencies.driver.normalizeInbound(payload);
    } catch {
      return json({ error: "Unsupported webhook event." }, 400);
    }
    if (normalized.events.length === 0) return json({ error: "Unsupported webhook event." }, 400);

    const resolved: Array<{ event: NormalizedInboundEvent; tenantId: string }> = [];
    try {
      for (const event of normalized.events) {
        const tenantId = await dependencies.resolveTenant(event.externalAccountId);
        if (!tenantId) return json({ error: "Unknown webhook location." }, 404);
        resolved.push({ event, tenantId });
      }
    } catch {
      return json({ error: "Webhook tenant lookup unavailable." }, 503);
    }

    for (const { event, tenantId } of resolved) {
      let receipt: WebhookReceiptRead;
      try {
        receipt = await dependencies.persistReceipt({
          provider: "ghl",
          providerEventId: tenantReceiptEventId({
            tenantId,
            eventId: event.eventId,
            providerMessageId: event.kind === "message" ? event.providerMessageId : null,
          }),
          tenantId,
          eventType: eventType(event),
          payload: {
            raw: isRecord(payload) ? payload : {},
            normalized: { events: [event] },
          },
        });
      } catch {
        return json({ error: "Webhook receipt unavailable." }, 503);
      }
      if (receipt.status === "received" || receipt.status === "failed") {
        try {
          dependencies.schedule(() => dependencies.processReceipt(receipt));
        } catch {
          return json({ error: "Webhook scheduling unavailable." }, 503);
        }
      }
    }
    return json({ received: true }, 200);
  };
}

async function resolveGhlTenant(locationId: string) {
  const client = createSupabaseServiceClient();
  const { data, error } = await client
    .from("ghl_installs")
    .select("tenant_id, install_state")
    .eq("location_id", locationId)
    .maybeSingle();
  if (error) throw new Error(`GHL_INSTALL_LOOKUP_FAILED:${error.message}`);
  if (!data || data.install_state === "uninstalled") return null;
  return typeof data.tenant_id === "string" ? data.tenant_id : null;
}

export { markGhlUninstalled };

const liveDriver = () => selectGhlMessagingDriver({
  factories: {
    mock: () => { throw new Error("GHL_LIVE_WEBHOOK_REQUIRES_REAL_DRIVER"); },
    real: createRealGhlDriver,
  },
});

export const POST = createGhlWebhookHandler({
  get driver() { return liveDriver(); },
  resolveTenant: resolveGhlTenant,
  persistReceipt: persistWebhookReceipt,
  // Approved disclosure/held content is intentionally absent until Plan 08 seeds it. The durable
  // row remains recoverable by the secreted reconcile job instead of acknowledging imaginary copy.
  processReceipt: processLiveWebhookReceipt,
  processUninstall: processGhlUninstallReceipt,
  schedule: (callback) => after(callback),
});
