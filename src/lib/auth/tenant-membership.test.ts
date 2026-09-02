import { describe, expect, it } from "vitest";

import {
  TENANT_MEMBERSHIP_INVITATION_TTL_MS,
  TenantMembershipInvitationError,
  issueTenantMembershipInvitation,
  normalizeTenantMemberEmail,
  tenantMembershipInvitationTokenHash,
} from "./tenant-membership";

describe("tenant membership invitations", () => {
  it("issues a 256-bit opaque secret while retaining only its hash for persistence", () => {
    const issued = issueTenantMembershipInvitation(" Assistant@Example.test ", {
      now: () => Date.parse("2030-01-01T00:00:00.000Z"),
      generateRandomBytes: () => Buffer.alloc(32, 7),
    });

    expect(issued).toMatchObject({
      email: "assistant@example.test",
      role: "coach_member",
      tokenHash: tenantMembershipInvitationTokenHash(issued.token),
      expiresAt: new Date(Date.parse("2030-01-01T00:00:00.000Z") + TENANT_MEMBERSHIP_INVITATION_TTL_MS).toISOString(),
    });
    expect(issued.token).toHaveLength(43);
    expect(issued.tokenHash).not.toContain(issued.token);
  });

  it.each(["", "no-at-sign", "person@localhost", "person @example.test"]) (
    "rejects an unusable recipient address: %s", (email) => {
      expect(() => normalizeTenantMemberEmail(email)).toThrow(TenantMembershipInvitationError);
    },
  );

  it("does not hash blank redemption input as a valid secret", () => {
    expect(() => tenantMembershipInvitationTokenHash(" ")).toThrow("TENANT_MEMBERSHIP_TOKEN_REQUIRED");
  });
});
