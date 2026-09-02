/**
 * Coach-writable offer inputs and persisted transition results.
 *
 * The published shape and its bounds stay owned by the shared Brain contract. This module only
 * removes platform-owned fields and adds the draft/transition metadata needed by the repository.
 */

import {
  type PublishedCoachOffer,
  type PublishedOfferAsset,
  type PublishedOfferPrice,
  type PublishedOfferProof,
} from "@/lib/brain/contracts";

export const OFFER_CADENCE_PURPOSES = [
  "lead_magnet",
  "training",
  "value_nudge",
  "proof_point",
  "new_angle",
  "last_touch",
] as const;

export const OFFER_CADENCE_CHANNELS = ["durable", "window_bound", "none"] as const;

export type OfferCadencePurpose = (typeof OFFER_CADENCE_PURPOSES)[number];
export type OfferCadenceChannel = (typeof OFFER_CADENCE_CHANNELS)[number];

/**
 * The coach-facing wording for the two cadence enums. A coach picks a purpose from a dropdown
 * and reads it back in the touch list, so both surfaces have to say the same thing — these live
 * beside the enums rather than in either component so a new member cannot ship without a label.
 */
export const OFFER_CADENCE_PURPOSE_LABELS: Record<OfferCadencePurpose, string> = {
  lead_magnet: "Free lead magnet",
  training: "Free training",
  value_nudge: "Value reminder",
  proof_point: "Approved proof point",
  new_angle: "A new angle",
  last_touch: "Final check-in",
};

export const OFFER_CADENCE_CHANNEL_LABELS: Record<OfferCadenceChannel, string> = {
  durable: "Durable",
  window_bound: "Window-bound",
  none: "None",
};

export type CoachOfferPriceInput = Omit<PublishedOfferPrice, "id">;
export type CoachOfferProofInput = Omit<PublishedOfferProof, "id">;
export type CoachOfferAssetInput = Omit<PublishedOfferAsset, "id">;

export type CoachCadencePurposeInput = {
  channelClass: OfferCadenceChannel;
  touchNo: number;
  purpose: OfferCadencePurpose;
  assetId: string | null;
};

type CoachOwnedScalarFields = Pick<
  PublishedCoachOffer,
  | "programName"
  | "programDescription"
  | "creditMin"
  | "fundingGoalMinCents"
  | "fundingGoalMaxCents"
  | "monthlyRevenueMinCents"
  | "creditRepair"
  | "products"
  | "bookingHorizonDays"
  | "bookingMode"
  | "brandVoice"
  | "resultsTimelineMinDays"
  | "resultsTimelineMaxDays"
  | "refundPosture"
  | "voiceStyleAnswer"
  | "voiceObjectionAnswer"
  | "voiceFollowupAnswer"
>;

export type CoachOfferDraftInput = CoachOwnedScalarFields & {
  prices: readonly CoachOfferPriceInput[];
  proof: readonly CoachOfferProofInput[];
  assets: readonly CoachOfferAssetInput[];
  cadencePurposes: readonly CoachCadencePurposeInput[];
};

export type PersistedOfferLayer = Omit<PublishedCoachOffer, "status"> & {
  status: "draft" | "published" | "superseded";
  cadencePurposes: readonly CoachCadencePurposeInput[];
};

export type OfferPublishReceipt = {
  auditId: string;
  actionKey: "offer.published";
  offerId: string;
  offerVersion: number;
  contentHash: string;
};

export type SavedOfferDraft = {
  draft: PersistedOfferLayer & { status: "draft" };
};

export type PublishedOfferResult = {
  offer: PublishedCoachOffer;
  receipt: OfferPublishReceipt;
};
