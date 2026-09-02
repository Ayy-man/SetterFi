import { humanError } from "@/lib/copy/errors";
import type { PersistedOfferLayer, SavedOfferDraft } from "@/lib/offer/types";

export type CoachOfferInitialState = {
  draft: PersistedOfferLayer | null;
  published: PersistedOfferLayer | null;
};

export type NullableNumberFailureReason = "not_a_number" | "out_of_range";

export type NullableNumberResult =
  | { ok: true; value: number | null }
  | { ok: false; reason: NullableNumberFailureReason };

export function nullableNumber(value: string): NullableNumberResult {
  if (!value.trim()) return { ok: true, value: null };

  const number = Number(value);
  if (Number.isNaN(number)) return { ok: false, reason: "not_a_number" };
  if (!Number.isSafeInteger(number)) return { ok: false, reason: "out_of_range" };

  return { ok: true, value: number };
}

export function nullableNumberFieldError(field: string, reason: NullableNumberFailureReason) {
  const label = field.trim() || "This field";
  return reason === "not_a_number"
    ? `${label} must be a number.`
    : `${label} must be a whole number within the supported range.`;
}

export function offerStateView(input: CoachOfferInitialState) {
  if (input.draft && input.published) {
    return {
      label: `Draft v${input.draft.version} awaiting platform review`,
      detail: `Published v${input.published.version} remains live`,
      tone: "pending" as const,
    };
  }
  if (input.draft) {
    return {
      label: `Draft v${input.draft.version}`,
      detail: "Awaiting platform review",
      tone: "pending" as const,
    };
  }
  if (input.published) {
    return {
      label: `Published v${input.published.version}`,
      detail: "No draft changes",
      tone: "good" as const,
    };
  }
  return { label: "No offer draft", detail: "Setup is incomplete", tone: "pending" as const };
}

export function unresolvedOfferAnswers(offer: PersistedOfferLayer | null) {
  if (!offer) return 6;
  return [
    offer.programName.trim(),
    offer.creditMin,
    offer.fundingGoalMinCents,
    offer.voiceStyleAnswer?.trim(),
    offer.voiceObjectionAnswer?.trim(),
    offer.voiceFollowupAnswer?.trim(),
  ].filter((value) => value == null || value === "").length;
}

export function savedDraftView(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return { saved: false, label: "Draft save receipt incomplete", draft: null };
  }
  const value = payload as Partial<SavedOfferDraft> & { state?: unknown };
  const draft = value.draft;
  const complete = value.state === "draft" && draft?.status === "draft"
    && typeof draft.id === "string" && typeof draft.contentHash === "string"
    && Number.isSafeInteger(draft.version);
  return complete
    ? { saved: true, label: `Saved as draft v${draft!.version}`, draft: draft! }
    : { saved: false, label: "Draft save receipt incomplete", draft: null };
}

export function publishedOfferView(payload: unknown) {
  if (!payload || typeof payload !== "object") {
    return { published: false, logged: false, label: "Offer publish receipt incomplete", offer: null };
  }
  const value = payload as {
    state?: unknown;
    offer?: PersistedOfferLayer;
    receipt?: { auditId?: unknown; actionKey?: unknown; offerId?: unknown; offerVersion?: unknown; contentHash?: unknown };
  };
  const receipt = value.receipt;
  const complete = value.state === "published" && value.offer?.status === "published"
    && typeof receipt?.auditId === "string" && receipt.actionKey === "offer.published"
    && receipt.offerId === value.offer.id && receipt.offerVersion === value.offer.version
    && receipt.contentHash === value.offer.contentHash;
  return complete
    ? { published: true, logged: true, label: `Published v${value.offer!.version}`, offer: value.offer! }
    : { published: false, logged: false, label: "Offer publish receipt incomplete", offer: null };
}

export function offerRefusalView(code: string | null) {
  if (!code) return null;
  return humanError(code).body;
}
