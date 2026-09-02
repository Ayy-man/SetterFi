import { after } from "next/server";

import {
  createLiveStripeDriver,
  processLiveStripeWebhookReceipt,
} from "@/lib/billing/stripe-events";
import { driverSelection, phase6StripeLive } from "@/lib/env-contract";
import type { StripeDriver } from "@/lib/integrations/stripe/types";
import {
  createStripeWebhookRepository,
  type StripeWebhookReceipt,
} from "@/lib/repositories/stripe-webhooks";

export const runtime = "nodejs";

const MAX_WEBHOOK_BYTES = 256 * 1024;
const noStoreHeaders = { "Cache-Control": "no-store" };

export type StripeWebhookDependencies = {
  enabled(): boolean;
  driver: Pick<StripeDriver, "verifyWebhook">;
  persistReceipt(event: ReturnType<StripeDriver["verifyWebhook"]>): Promise<StripeWebhookReceipt>;
  processReceipt(receiptId: string): Promise<unknown>;
  schedule(callback: () => Promise<void>): void;
};

function json(body: Record<string, unknown>, status: number) {
  return Response.json(body, { status, headers: noStoreHeaders });
}

async function rawBody(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  return bytes.byteLength > MAX_WEBHOOK_BYTES ? null : bytes;
}

export function createStripeWebhookHandler(dependencies: StripeWebhookDependencies) {
  return async function POST(request: Request) {
    let enabled: boolean;
    try {
      enabled = dependencies.enabled();
    } catch {
      return json({ error: "Webhook configuration unavailable." }, 503);
    }
    if (!enabled) return json({ error: "Not found." }, 404);

    // Signature presence is checked before the body is read. The driver verifies the exact bytes
    // and returns the normalized event, so no JSON parsing can precede signature verification.
    const signature = request.headers.get("stripe-signature");
    if (!signature) return json({ error: "Invalid webhook signature." }, 400);

    let bytes: Uint8Array | null;
    try {
      bytes = await rawBody(request);
    } catch {
      return json({ error: "Webhook body could not be read." }, 503);
    }
    if (!bytes) return json({ error: "Webhook body is too large." }, 413);

    let event: ReturnType<StripeDriver["verifyWebhook"]>;
    try {
      event = dependencies.driver.verifyWebhook(bytes, signature);
    } catch {
      return json({ error: "Invalid webhook signature." }, 400);
    }

    try {
      const receipt = await dependencies.persistReceipt(event);
      if (receipt.inserted || receipt.status === "received" || receipt.status === "failed") {
        dependencies.schedule(async () => {
          await dependencies.processReceipt(receipt.id);
        });
      }
      return json({
        received: true,
        eventId: receipt.eventId,
        duplicate: !receipt.inserted,
        status: receipt.status,
      }, 200);
    } catch {
      return json({ error: "Webhook inbox unavailable." }, 503);
    }
  };
}

const repository = createStripeWebhookRepository();

export const POST = createStripeWebhookHandler({
  enabled: () => phase6StripeLive()
    && driverSelection("stripe", "SETTERFI_STRIPE_DRIVER") === "real",
  get driver() { return createLiveStripeDriver(); },
  persistReceipt: (event) => repository.persistReceipt(event),
  processReceipt: processLiveStripeWebhookReceipt,
  schedule: (callback) => after(callback),
});
