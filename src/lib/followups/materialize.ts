/**
 * Materializes absolute cadence positions from current provider capability.
 *
 * The stored followups.channel_class value is accepted only as an advisory
 * receipt and is never read when choosing the active touch list.
 */

import type { MessagingChannel } from "@/lib/booking/types";
import type { OfferCadencePurpose } from "@/lib/offer/types";
import {
  resolveChannelCapability,
  type CadenceClass,
  type ChannelCapabilityFeed,
} from "@/lib/sends/channel-capabilities";

import { DURABLE_TOUCHES, WINDOW_BOUND_TOUCHES } from "./touch-lists";

const QUIET_GAP_MS = 2 * 60 * 60 * 1_000;

export type CadencePurposeOverride = {
  channelClass: CadenceClass;
  touchNo: number;
  purpose: OfferCadencePurpose;
};

export type MaterializeCadenceInput = {
  tenantId: string;
  conversationId: string;
  channel: MessagingChannel;
  cadenceAnchorAt: string;
  providerWindowExpiresAt: string | null;
  materializedAt: string;
  lastOutboundAt: string | null;
  capabilityFeed?: ChannelCapabilityFeed;
  purposeOverrides?: readonly CadencePurposeOverride[];
  storedChannelClass?: CadenceClass;
};

export type MaterializedFollowup = {
  tenantId: string;
  conversationId: string;
  touchNo: number;
  purpose: OfferCadencePurpose;
  scheduledAt: string;
  cadenceAnchorAt: string;
  channelClass: Exclude<CadenceClass, "none">;
};

function validInstant(value: string, name: string) {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) throw new Error(`CADENCE_${name}_INVALID`);
  return instant;
}

function isValidWindowedFeed(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { windowed?: unknown; postWindow?: unknown; templates?: unknown };
  return candidate.windowed === true &&
    (candidate.postWindow === "none" || candidate.postWindow === "human_tag" ||
      candidate.postWindow === "template") &&
    typeof candidate.templates === "boolean";
}

function resolveMaterializedClass(
  channel: MessagingChannel,
  feed: ChannelCapabilityFeed,
): CadenceClass {
  const capability = resolveChannelCapability(channel, feed);
  if (capability.postWindow === "freeform" ||
    (capability.postWindow === "template" && capability.templateSend)) {
    return "durable";
  }

  // A closed post-window capability can still permit automation inside a known
  // provider window. Missing or malformed feed data cannot assert that window.
  return isValidWindowedFeed(feed[channel]) ? "window_bound" : "none";
}

function purposeFor(
  channelClass: Exclude<CadenceClass, "none">,
  touchNo: number,
  fallback: OfferCadencePurpose,
  overrides: readonly CadencePurposeOverride[],
) {
  return overrides.find((candidate) =>
    candidate.channelClass === channelClass && candidate.touchNo === touchNo
  )?.purpose ?? fallback;
}

export function materializeCadence(input: MaterializeCadenceInput): MaterializedFollowup[] {
  const anchor = validInstant(input.cadenceAnchorAt, "ANCHOR");
  const materializedAt = validInstant(input.materializedAt, "MATERIALIZED_AT");
  const lastOutboundAt = input.lastOutboundAt
    ? validInstant(input.lastOutboundAt, "LAST_OUTBOUND")
    : null;
  const feed = input.capabilityFeed ?? {};
  const channelClass = resolveMaterializedClass(input.channel, feed);
  const overrides = input.purposeOverrides ?? [];
  if (channelClass === "none") return [];

  const positions = channelClass === "durable"
    ? DURABLE_TOUCHES.map((touch) => ({
        touchNo: touch.touchNo,
        purpose: touch.purpose,
        scheduledAt: anchor + touch.offsetMs,
      }))
    : (() => {
        if (!input.providerWindowExpiresAt) return [];
        const windowClose = validInstant(input.providerWindowExpiresAt, "WINDOW_CLOSE");
        return WINDOW_BOUND_TOUCHES.map((touch) => ({
          touchNo: touch.touchNo,
          purpose: touch.purpose,
          scheduledAt: windowClose - touch.beforeWindowCloseMs,
        })).filter((touch) => touch.scheduledAt >= anchor && touch.scheduledAt < windowClose);
      })();

  // Positions already in the past are skipped, not queued. The quiet-gap floor
  // may shift only a still-future position after a recent human or agent send.
  // A position the coach set to "Nothing" is dropped here, before anything is
  // queued, so no template is ever looked up for it.
  return positions
    .filter((touch) => touch.scheduledAt > materializedAt)
    .map((touch) => ({
      ...touch,
      purpose: purposeFor(channelClass, touch.touchNo, touch.purpose, overrides),
    }))
    .filter((touch) => touch.purpose !== "none")
    .map((touch): MaterializedFollowup => ({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      touchNo: touch.touchNo,
      purpose: touch.purpose,
      scheduledAt: new Date(Math.max(
        touch.scheduledAt,
        lastOutboundAt === null ? touch.scheduledAt : lastOutboundAt + QUIET_GAP_MS,
      )).toISOString(),
      cadenceAnchorAt: new Date(anchor).toISOString(),
      channelClass,
    }))
    .filter((touch) => input.providerWindowExpiresAt === null || channelClass === "durable" ||
      Date.parse(touch.scheduledAt) < Date.parse(input.providerWindowExpiresAt));
}
