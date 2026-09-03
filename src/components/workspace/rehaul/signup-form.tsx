"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { AuthNotice } from "@/components/auth/auth-shell";
import { PasswordField } from "@/components/auth/password-field";
import { KitButton, KitInput, Prose, kitButtonClass } from "@/components/kit/atomics";
import { Field } from "@/components/kit/field";
import { Checkbox } from "@/components/ui/checkbox";
import { AUTH_FIELDS_CLASS, AUTH_SUBMIT_CLASS, AuthCard } from "@/components/workspace/rehaul/auth-card";
import { signupDescriptor, signupResultDescriptor, type SignupTierChoice } from "@/components/onboarding/view-models";
import type { SignupAccountTerms } from "@/app/signup/signup-form";
import type { SignupOrchestrationResult } from "@/lib/onboarding/signup";

/**
 * /signup, drawn from `Signup.body.html`.
 *
 * The account-creating half is the live form's, character for character: the same
 * `POST /api/onboarding/signup` with the same body, the same `signupDescriptor` gate on
 * `canSubmit`, the same terms-acceptance gate against the published version key, the same
 * `signupResultDescriptor` reading of what came back, the same browser-timezone read on mount. No
 * field was dropped and none was added.
 *
 * Three things the artboard settles differently from the live page:
 *
 *   - **One card, not three panels.** The two numbered deck panels and the separate plan grid
 *     become the 440px card's body, in the artboard's order: the two-up name row, email, password,
 *     the two-up slug and timezone row, then the plan chips.
 *   - **Plan chips carry the name and nothing else.** The artboard draws three equal chips with a
 *     radio and a word. The live cards draw a price and an allowance, and the price is already
 *     conditional on a `commercialTerms` the catalogue usually does not carry -- so quoting one
 *     here would mean a chip that shows money for one tier and not the next. The tier id submitted
 *     is unchanged, and what a plan costs is settled where it is charged.
 *   - **No help text.** The hints under the slug, the password, the timezone and the referral code
 *     are gone, along with the carrier-review paragraph. That paragraph is a true and important
 *     thing, and it belongs on the first screen inside the product where the day counter that
 *     proves it also lives, not on a form that has not created an account yet.
 *
 * The referral field stays, below the plan with the two consents, because a prospect who followed
 * an affiliate's link has to be able to see and correct what that link prefilled.
 */
export function RehaulSignupForm({
  enabled,
  referralCode = null,
  terms = null,
  tiers,
}: {
  enabled: boolean;
  referralCode?: string | null;
  terms?: SignupAccountTerms | null;
  tiers: readonly SignupTierChoice[];
}) {
  const [timezone, setTimezone] = useState("");
  // Never pre-ticked: the server records this against an immutable content hash, so it has to be
  // the signer-upper's own act.
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [selectedTierId, setSelectedTierId] = useState<string | null>(null);
  const [result, setResult] = useState<SignupOrchestrationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const namedTiers = useMemo(
    () => tiers.filter((tier) => tier.label.trim()).map((tier) => ({ ...tier, label: tier.label.trim() })),
    [tiers],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => setTimezone(browserTimezone()), 0);
    return () => window.clearTimeout(timer);
  }, []);
  const descriptor = useMemo(
    () => signupDescriptor({ enabled, tiers: namedTiers, timezone }),
    [enabled, namedTiers, timezone],
  );

  async function submit(formData: FormData) {
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/onboarding/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: String(formData.get("email") ?? ""),
          password: String(formData.get("password") ?? ""),
          fullName: String(formData.get("fullName") ?? ""),
          businessName: String(formData.get("businessName") ?? ""),
          slug: String(formData.get("slug") ?? ""),
          tierId: selectedTierId,
          timezone,
          referralCode: String(formData.get("referralCode") ?? "") || null,
          affiliateOptIn: formData.get("affiliateOptIn") === "on",
          // Only ever sent when a published version exists. The route refuses a key it cannot
          // produce, so an unarmed form that volunteered the field would fail every signup.
          ...(terms ? { acceptedTermsVersionKey: terms.versionKey } : {}),
        }),
      });
      const payload: unknown = await response.json();
      if (!response.ok || !payload || typeof payload !== "object" || !("state" in payload)) {
        setError("Signup could not be completed. Check the details and try again.");
        return;
      }
      setResult(payload as SignupOrchestrationResult);
    } catch {
      setError("Signup could not be completed. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    const outcome = signupResultDescriptor(result);
    return (
      <AuthCard title={outcome.title}>
        <div aria-live="polite" className="flex flex-col gap-[var(--s-3)]">
          <Prose className="text-[16px] leading-[1.55] text-[color:var(--muted)]">{outcome.detail}</Prose>
          {outcome.referral?.visible ? (
            <Prose className="text-[16px] leading-[1.55] text-[color:var(--body)]" role="status">
              {outcome.referral.message}
            </Prose>
          ) : null}
        </div>
        {/* The account exists by the time this renders, so walking into it takes the fill. */}
        {outcome.nextHref ? (
          <Link
            className={kitButtonClass({ className: AUTH_SUBMIT_CLASS, size: "lg", variant: "primary" })}
            href={outcome.nextHref}
          >
            Continue
          </Link>
        ) : null}
      </AuthCard>
    );
  }

  if (!descriptor.enabled || descriptor.unavailableCode === "tier_catalog_unavailable") {
    return (
      <AuthCard title="Account setup is not available yet">
        <Prose className="text-[16px] leading-[1.55] text-[color:var(--muted)]">
          {descriptor.enabled
            ? "No named plan is available, so signup stays disabled instead of choosing one for you."
            : "Self-serve onboarding is currently off. No account or provider work has started."}
        </Prose>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      above={error ? <AuthNotice role="alert" tone="failure">{error}</AuthNotice> : null}
      below={
        <p className="m-0 text-center text-[16px] leading-[1.5] text-[color:var(--muted)]">
          Already set up? <Link className="link-inline font-[500]" href="/login">Sign in</Link>
        </p>
      }
      title="Start with SetterFi"
    >
      {/*
        The two-up rows measure the form, and they name it. `AuthCard` declares an anonymous
        `@container` on its body, which resolves today and binds to whichever bare container is
        nearest the moment anything wraps this form.
      */}
      <form action={submit} className={`@container/signup flex flex-col gap-[18px] ${AUTH_FIELDS_CLASS}`}>
        <div className="grid gap-[14px] @min-[380px]/signup:grid-cols-2">
          <Field label="Full name" required><KitInput autoComplete="name" name="fullName" required /></Field>
          <Field label="Business name" required><KitInput autoComplete="organization" name="businessName" required /></Field>
        </div>

        <Field label="Email" required><KitInput autoComplete="email" name="email" required type="email" /></Field>

        <PasswordField autoComplete="new-password" minLength={8} />

        <div className="grid gap-[14px] @min-[380px]/signup:grid-cols-2">
          <Field label="Workspace address" required>
            <KitInput className="mono" name="slug" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required />
          </Field>
          <Field label="Business timezone" required>
            <KitInput name="timezone" onChange={(event) => setTimezone(event.target.value)} required value={timezone} />
          </Field>
        </div>

        <fieldset className="m-0 flex min-w-0 flex-col gap-[var(--distance-small)] border-0 p-0">
          <legend className="mb-[var(--distance-small)] p-0 text-[length:var(--t-body)] leading-[var(--t-body-lh)] font-medium text-[color:var(--ink)]">
            Plan
          </legend>
          <div className="grid gap-[10px]" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 118px), 1fr))" }}>
            {descriptor.tierChoices.map((tier) => (
              /*
                Nothing is preselected. A default plan wearing the chosen-it face would be the
                product answering the one question only the coach can.
              */
              <label
                className="flex h-[48px] min-w-0 cursor-pointer items-center justify-center gap-[9px] rounded-[10px] border border-[var(--line)] bg-[var(--well)] px-[10px] text-[16px] text-[color:var(--body)] transition-colors duration-[var(--duration-quick)] hover:border-[var(--accent-edge)] has-checked:border-[var(--accent-edge)] has-checked:bg-[var(--accent-wash)] has-checked:font-[500] has-checked:text-[color:var(--accent-text)] motion-reduce:transition-none"
                key={tier.id}
              >
                <input
                  aria-label={tier.label}
                  checked={selectedTierId === tier.id}
                  className="size-[18px] shrink-0 accent-[var(--accent)]"
                  /* The 48px floor is the chip's job: a 44px radio would burst its own row. */
                  data-coach-target="exempt"
                  name="tierId"
                  onChange={() => setSelectedTierId(tier.id)}
                  required
                  type="radio"
                  value={tier.id}
                />
                <span className="truncate">{tier.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {/*
          Prefilled and still editable: nothing here is trusted, the RPC resolves whatever is
          submitted against `affiliates.referral_code` either way, and a readonly box a prospect
          cannot correct is worse than a wrong code they can.
        */}
        <Field label="Referral code">
          <KitInput defaultValue={referralCode ?? ""} name="referralCode" />
        </Field>

        <label className="flex items-center gap-[var(--s-3)] text-[16px] leading-[1.55] text-[color:var(--body)]">
          <Checkbox aria-labelledby="rehaul-affiliate-opt-in-label" name="affiliateOptIn" />
          <span id="rehaul-affiliate-opt-in-label">Also enrol this account in the affiliate program.</span>
        </label>

        {terms ? (
          <div className="flex flex-col gap-[var(--s-2)]" data-slot="signup-account-terms">
            <label className="flex items-start gap-[var(--s-3)] text-[16px] leading-[1.55] text-[color:var(--body)]">
              <Checkbox
                aria-labelledby="rehaul-account-terms-label"
                checked={termsAccepted}
                className="mt-[var(--s-1)]"
                name="acceptedTerms"
                onCheckedChange={(checked) => setTermsAccepted(checked === true)}
                required
              />
              <span id="rehaul-account-terms-label">
                I accept the SetterFi terms of service and privacy policy.
              </span>
            </label>
            {/*
              The document itself rather than a link to a page that might say something else: what
              opens here is the exact copy the server hashed, which is the copy the acceptance is
              recorded against.
            */}
            <details data-slot="signup-terms-document">
              <summary className="flex w-fit cursor-pointer select-none items-center text-[16px] text-[color:var(--body)] underline underline-offset-2">
                Read the terms of service
              </summary>
              <Prose className="mt-[var(--s-2)] text-[15px] leading-[1.55] whitespace-pre-wrap text-[color:var(--muted)]">
                {terms.termsBody}
              </Prose>
            </details>
            <details data-slot="signup-privacy-document">
              <summary className="flex w-fit cursor-pointer select-none items-center text-[16px] text-[color:var(--body)] underline underline-offset-2">
                Read the privacy policy
              </summary>
              <Prose className="mt-[var(--s-2)] text-[15px] leading-[1.55] whitespace-pre-wrap text-[color:var(--muted)]">
                {terms.privacyBody}
              </Prose>
            </details>
            <Prose className="text-[15px] leading-[1.5] text-[color:var(--faint)]">
              Version {terms.versionKey}. Your acceptance is recorded against this version.
            </Prose>
          </div>
        ) : null}

        <KitButton
          className={AUTH_SUBMIT_CLASS}
          disabled={!descriptor.canSubmit || !selectedTierId || (terms !== null && !termsAccepted) || submitting}
          size="lg"
          type="submit"
          variant="primary"
        >
          {submitting ? "Creating account" : "Create my account"}
        </KitButton>
      </form>
    </AuthCard>
  );
}

function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}
