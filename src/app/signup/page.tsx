import type { Metadata } from "next";

import { GET as loadSignupCatalog } from "@/app/api/onboarding/signup/route";
import type { SignupAccountTerms } from "@/app/signup/signup-form";
import { referralCodeFromParam, type SignupTierChoice } from "@/components/onboarding/view-models";
import { loadCurrentAccountTerms } from "@/lib/account/terms";
import { REFERRAL_QUERY_PARAM } from "@/lib/affiliates/referral-attribution";
import { RehaulSignupForm } from "@/components/workspace/rehaul/signup-form";
import { accountTermsLive, phase5Live } from "@/lib/env-contract";

export const metadata: Metadata = {
  title: "Create your SetterFi account",
  description: "Create a SetterFi coach workspace.",
  robots: { index: false, follow: false },
};

function commercialTerms(value: unknown): SignupTierChoice["commercialTerms"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const terms = value as Record<string, unknown>;
  if (
    typeof terms.currency !== "string"
    || !/^[A-Z]{3}$/.test(terms.currency)
    || typeof terms.amountCents !== "number"
    || !Number.isSafeInteger(terms.amountCents)
    || terms.amountCents < 0
    || !["day", "week", "month", "year"].includes(String(terms.interval))
    || typeof terms.effectiveFrom !== "string"
    || !Number.isFinite(Date.parse(terms.effectiveFrom))
    || (terms.effectiveTo !== null
      && (typeof terms.effectiveTo !== "string" || !Number.isFinite(Date.parse(terms.effectiveTo))))
  ) return null;
  return {
    currency: terms.currency,
    amountCents: terms.amountCents,
    interval: terms.interval as "day" | "week" | "month" | "year",
    effectiveFrom: terms.effectiveFrom,
    effectiveTo: terms.effectiveTo as string | null,
  };
}

export function namedTierChoices(value: unknown): SignupTierChoice[] {
  if (!Array.isArray(value)) return [];
  const choices = value.flatMap((tier) => {
    if (
      !tier
      || typeof tier !== "object"
      || typeof (tier as Record<string, unknown>).id !== "string"
      || typeof (tier as Record<string, unknown>).label !== "string"
      || !(tier as { label: string }).label.trim()
      // Seeded sentinel tiers are placeholders, not offers a coach can honestly sign up for.
      || (tier as { label: string }).label.includes("SETTERFI_DEMO_PLACEHOLDER_")
    ) return [];
    const raw = tier as Record<string, unknown>;
    const terms = raw.commercialTerms === undefined ? undefined : commercialTerms(raw.commercialTerms);
    if (raw.commercialTerms !== undefined && !terms) return [];
    /*
     * The allowance is validated, never coerced. A plan card that states "0 booked calls included"
     * because a bad value fell through is a worse claim than a card that states nothing, so
     * anything that is not a non-negative whole number is dropped and the card goes quiet.
     */
    const allowance = raw.callAllowance;
    const callAllowance = typeof allowance === "number" && Number.isSafeInteger(allowance) && allowance >= 0
      ? allowance
      : undefined;
    return [{
      id: (tier as { id: string }).id,
      label: (tier as { label: string }).label.trim(),
      ...(callAllowance === undefined ? {} : { callAllowance }),
      ...(terms ? { commercialTerms: terms } : {}),
    }];
  });
  const ids = new Set<string>();
  const labels = new Set<string>();
  for (const choice of choices) {
    const label = choice.label.toLocaleLowerCase();
    if (ids.has(choice.id) || labels.has(label)) return [];
    ids.add(choice.id);
    labels.add(label);
  }
  return choices;
}

type SignupPageProps = {
  searchParams: Promise<Partial<Record<typeof REFERRAL_QUERY_PARAM, string | string[]>>>;
};

export default async function SignupPage({ searchParams }: SignupPageProps) {
  const enabled = phase5Live();
  // The parameter the affiliate's link carries, named once in `referral-attribution.ts` so this
  // read and the route that writes the link cannot drift apart. A repeated parameter is not a
  // code, and anything not shaped like one prefills nothing.
  const referralCode = referralCodeFromParam((await searchParams)[REFERRAL_QUERY_PARAM]);
  let tiers: readonly SignupTierChoice[] = [];
  if (enabled) {
    const response = await loadSignupCatalog();
    const payload = await response.json() as { tiers?: unknown };
    tiers = response.ok ? namedTierChoices(payload.tiers) : [];
  }
  /*
   * The same read `POST /api/onboarding/signup` validates against, so the key the form submits is
   * by construction the key the route expects. Both halves have to be true before anything is
   * asked of the signer-upper: the flag on, and a version actually published. A registry that
   * cannot be read is treated as nothing published, which is the state that asks for nothing.
   */
  let terms: SignupAccountTerms | null = null;
  if (enabled && accountTermsLive()) {
    try {
      const current = await loadCurrentAccountTerms();
      if (current.state === "published") {
        terms = {
          versionKey: current.versionKey,
          termsBody: current.termsBody,
          privacyBody: current.privacyBody,
        };
      }
    } catch {
      terms = null;
    }
  }

  return (
    <RehaulSignupForm enabled={enabled} referralCode={referralCode} terms={terms} tiers={tiers} />
  );
}
