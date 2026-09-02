/** Value-free, database-derived history for one versioned coach offer. */

export type OfferChangeTrailEvent = "draft_saved" | "published";

export type OfferChangeTrailEntry = {
  changeId: string;
  event: OfferChangeTrailEvent;
  changedKeys: readonly string[];
  contentHash: string;
  changedAt: string;
  actorId: string;
  actorName: string | null;
  auditId: string;
};

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OFFER_CHANGE_TRAIL_READ_INVALID");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("OFFER_CHANGE_TRAIL_READ_INVALID");
  return value;
}

/** Rejects malformed RPC data so a UI never turns an incomplete read into a confident history. */
export function parseOfferChangeTrail(value: unknown): OfferChangeTrailEntry[] {
  if (!Array.isArray(value)) throw new Error("OFFER_CHANGE_TRAIL_READ_INVALID");
  return value.map((candidate) => {
    const source = row(candidate);
    const event = string(source.event);
    if (event !== "draft_saved" && event !== "published") throw new Error("OFFER_CHANGE_TRAIL_READ_INVALID");
    if (!Array.isArray(source.changed_keys) || !source.changed_keys.every((key) => typeof key === "string" && key.trim())) {
      throw new Error("OFFER_CHANGE_TRAIL_READ_INVALID");
    }
    const contentHash = string(source.content_hash);
    if (!/^[0-9a-f]{64}$/.test(contentHash)) throw new Error("OFFER_CHANGE_TRAIL_READ_INVALID");
    if (source.actor_name !== null && typeof source.actor_name !== "string") throw new Error("OFFER_CHANGE_TRAIL_READ_INVALID");
    if (typeof source.audit_id !== "string" && typeof source.audit_id !== "number") throw new Error("OFFER_CHANGE_TRAIL_READ_INVALID");
    return {
      changeId: string(source.change_id),
      event,
      changedKeys: [...source.changed_keys],
      contentHash,
      changedAt: string(source.changed_at),
      actorId: string(source.actor_id),
      actorName: source.actor_name,
      auditId: String(source.audit_id),
    };
  });
}
