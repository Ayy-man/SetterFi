import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isTenantOwnershipId, parseTenantOwnershipRequest } from "./ownership";

const membershipId = "11111111-1111-4111-8111-111111111111";
const offerId = "22222222-2222-4222-8222-222222222222";

describe("tenant ownership command parsing", () => {
  it("accepts only a single, UUID-addressed transfer command", () => {
    expect(isTenantOwnershipId(offerId)).toBe(true);
    expect(parseTenantOwnershipRequest({ action: "offer", recipientMembershipId: membershipId })).toEqual({ action: "offer", recipientMembershipId: membershipId });
    expect(parseTenantOwnershipRequest({ action: "accept", offerId })).toEqual({ action: "accept", offerId });
    expect(parseTenantOwnershipRequest({ action: "revoke", offerId })).toEqual({ action: "revoke", offerId });
  });

  it("rejects injected tenant ids, role choices, malformed ids, and unsupported actions", () => {
    expect(parseTenantOwnershipRequest({ action: "offer", recipientMembershipId: membershipId, tenantId: "tenant-b" })).toBeNull();
    expect(parseTenantOwnershipRequest({ action: "offer", recipientMembershipId: membershipId, role: "coach" })).toBeNull();
    expect(parseTenantOwnershipRequest({ action: "accept", offerId: "offer-b" })).toBeNull();
    expect(parseTenantOwnershipRequest({ action: "transfer", offerId })).toBeNull();
  });
});

describe("tenant ownership migration invariants", () => {
  const migration = readFileSync(join(process.cwd(), "supabase/migrations/20260925000001_tenant_ownership_transfer.sql"), "utf8");

  it("enforces one pending offer in the database and leaves acceptance with exactly one coach", () => {
    expect(migration).toContain("create unique index tenant_ownership_transfers_one_pending_per_tenant_idx");
    expect(migration).toContain("on public.tenant_ownership_transfers (tenant_id) where status = 'pending'");
    expect(migration).toContain("if owner_count <> 1 then raise exception 'TENANT_OWNERSHIP_OWNER_INVARIANT_FAILED'; end if;");
    expect(migration).toContain("when workspace_user.id = p_actor_id then 'coach'::public.user_role");
    expect(migration).toContain("when workspace_user.id = previous_owner.id then 'coach_member'::public.user_role");
  });

  it("scopes every offer lookup to the actor's expected tenant before it can be read or accepted", () => {
    expect(migration).toContain("ownership_transfer.id = p_transfer_id\n    and ownership_transfer.tenant_id = p_expected_tenant");
    expect(migration).toContain("ownership_transfer.tenant_id = p_expected_tenant\n    and (ownership_transfer.offered_by = p_actor_id or ownership_transfer.recipient_user_id = p_actor_id)");
  });
});
