import { describe, expect, it } from "vitest";

import { createAffiliateReferralIdentity } from "./referral-link";

describe("affiliate referral identity", () => {
  it("accepts only the own-code projection", async () => {
    const identity = createAffiliateReferralIdentity({
      readOwnIdentity: async () => ({ referral_code: "SF-OWN" }),
    });

    await expect(identity.readOwn()).resolves.toEqual({ referralCode: "SF-OWN" });
  });

  it("refuses widened rows that could carry another affiliate or tenant identifier", async () => {
    const identity = createAffiliateReferralIdentity({
      readOwnIdentity: async () => ({
        referral_code: "SF-OWN", affiliate_id: "another-affiliate", tenant_id: "tenant-must-not-escape",
      }),
    });

    await expect(identity.readOwn()).rejects.toThrow("AFFILIATE_REFERRAL_IDENTITY_INVALID");
  });
});
