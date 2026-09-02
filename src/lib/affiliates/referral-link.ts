/** RLS-scoped referral identity read; it deliberately has no tenant or referral projection. */

import { createSupabaseServerClient } from "@/lib/supabase/server";

export type AffiliateReferralIdentity = { referralCode: string };

export class AffiliateReferralIdentityError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export type AffiliateReferralIdentityDependencies = {
  readOwnIdentity(): Promise<unknown>;
};

async function liveDependencies(): Promise<AffiliateReferralIdentityDependencies> {
  const client = await createSupabaseServerClient();
  return {
    readOwnIdentity: async () => {
      const { data, error } = await client.from("affiliates")
        .select("referral_code")
        .maybeSingle();
      if (error) throw new AffiliateReferralIdentityError("AFFILIATE_REFERRAL_IDENTITY_FAILED");
      return data;
    },
  };
}

export function createAffiliateReferralIdentity(
  provided?: AffiliateReferralIdentityDependencies,
) {
  const dependencies = async () => provided ?? liveDependencies();
  return {
    async readOwn(): Promise<AffiliateReferralIdentity> {
      const data = await (await dependencies()).readOwnIdentity();
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new AffiliateReferralIdentityError("AFFILIATE_REFERRAL_IDENTITY_UNAVAILABLE");
      }
      const row = data as Record<string, unknown>;
      if (Object.keys(row).sort().join(",") !== "referral_code"
        || typeof row.referral_code !== "string" || !row.referral_code.trim()) {
        throw new AffiliateReferralIdentityError("AFFILIATE_REFERRAL_IDENTITY_INVALID");
      }
      return { referralCode: row.referral_code };
    },
  };
}
