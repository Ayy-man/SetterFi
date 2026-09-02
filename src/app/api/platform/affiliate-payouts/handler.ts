/**
 * Owner/admin payout-recording boundary.
 *
 * Approval and sent are distinct append-only RPC receipts. This route records an external payout
 * reference and date but owns no Stripe, bank, transfer, or settlement operation.
 */

import { createAffiliateService, type AffiliateService } from "@/lib/affiliates/service";
import { phase6AffiliatesLive } from "@/lib/env-contract";
import { createAffiliateRepository } from "@/lib/repositories/affiliates";
import {
  loadPlatformActor,
  type PlatformActor,
} from "@/lib/auth/actors";

const noStoreHeaders = { "Cache-Control": "no-store" };

type AffiliatePayoutDependencies = {
  enabled(): boolean;
  session(): Promise<PlatformActor | null>;
  approve: AffiliateService["approvePayout"];
  recordSent: AffiliateService["recordSent"];
  withActor?(actorId: string): Pick<AffiliatePayoutDependencies, "approve" | "recordSent">;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonBlank);
}

function calendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function createAffiliatePayoutHandler(dependencies: AffiliatePayoutDependencies) {
  return async function POST(request: Request) {
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
    // Role refusal precedes body parsing or repository work so read-only platform roles cannot use
    // malformed payloads as an oracle over payout records.
    if (actor.role !== "owner" && actor.role !== "admin") {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: noStoreHeaders });
    }
    if ([...new URL(request.url).searchParams.keys()].length > 0) {
      return Response.json(
        { error: "Payout query selectors are not accepted." },
        { status: 400, headers: noStoreHeaders },
      );
    }
    const payouts = dependencies.withActor?.(actor.userId) ?? dependencies;
    try {
      const body: unknown = await request.json();
      if (!isRecord(body) || !nonBlank(body.action)) throw new Error("PAYOUT_BODY_INVALID");
      if (body.action === "approve") {
        if (
          !hasExactKeys(body, ["action", "affiliateId", "ledgerIds", "reason"])
          || !nonBlank(body.affiliateId)
          || !stringArray(body.ledgerIds)
          || !nonBlank(body.reason)
        ) throw new Error("PAYOUT_APPROVAL_BODY_INVALID");
        const payout = await payouts.approve({
          affiliateId: body.affiliateId,
          ledgerIds: body.ledgerIds,
          reason: body.reason,
        });
        return Response.json({ payout }, { headers: noStoreHeaders });
      }
      if (body.action === "record_sent") {
        if (
          !hasExactKeys(body, ["action", "payoutId", "reference", "paidOn"])
          || !nonBlank(body.payoutId)
          || !nonBlank(body.reference)
          || !calendarDate(body.paidOn)
        ) throw new Error("PAYOUT_SENT_BODY_INVALID");
        const payout = await payouts.recordSent({
          payoutId: body.payoutId,
          reference: body.reference,
          paidOn: body.paidOn,
        });
        return Response.json({ payout }, { headers: noStoreHeaders });
      }
      throw new Error("PAYOUT_ACTION_INVALID");
    } catch {
      return Response.json(
        { error: "Affiliate payout record was refused." },
        { status: 409, headers: noStoreHeaders },
      );
    }
  };
}

const service = createAffiliateService(createAffiliateRepository());

export const POST = createAffiliatePayoutHandler({
  enabled: phase6AffiliatesLive,
  session: loadPlatformActor,
  approve: (input) => service.approvePayout(input),
  recordSent: (input) => service.recordSent(input),
  withActor: (actorId) => ({
    approve: (input) => service.approvePayout({ ...input, actorId }),
    recordSent: (input) => service.recordSent({ ...input, actorId }),
  }),
});
