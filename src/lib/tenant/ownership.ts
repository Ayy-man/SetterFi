const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TenantOwnershipRequest =
  | { action: "offer"; recipientMembershipId: string }
  | { action: "accept"; offerId: string }
  | { action: "revoke"; offerId: string };

export function isTenantOwnershipId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Parses the deliberately small ownership-transfer command surface without accepting extras. */
export function parseTenantOwnershipRequest(value: unknown): TenantOwnershipRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.action === "offer" && Object.keys(body).length === 2 && isTenantOwnershipId(body.recipientMembershipId)) {
    return { action: "offer", recipientMembershipId: body.recipientMembershipId };
  }
  if ((body.action === "accept" || body.action === "revoke")
    && Object.keys(body).length === 2 && isTenantOwnershipId(body.offerId)) {
    return { action: body.action, offerId: body.offerId };
  }
  return null;
}
