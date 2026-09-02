"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";

import { AuthNotice } from "@/components/auth/auth-shell";
import { PasswordField } from "@/components/auth/password-field";
import {
  KitButton,
  KitInput,
  Prose,
  StatusDot,
  Surface,
  kitButtonClass,
  type KitButtonSize,
  type KitButtonVariant,
} from "@/components/kit/atomics";
import { DeckPanel } from "@/components/kit/deck-panel";
import { DataState } from "@/components/kit/data-state";
import { Field } from "@/components/kit/field";
import { Checkbox } from "@/components/ui/checkbox";
import type { SignupOrchestrationResult } from "@/lib/onboarding/signup";
import {
  signupDescriptor,
  signupResultDescriptor,
  tierChoicePrice,
  type SignupTierChoice,
} from "@/components/onboarding/view-models";

/**
 * The published account terms, or nothing.
 *
 * This arrives only when `SETTERFI_ACCOUNT_TERMS_LIVE` is on *and* a version is actually
 * published. Either half missing and the form renders exactly as it did before there was a terms
 * mechanism at all, because that is the honest state: the server records no acceptance, so asking
 * for one would be a checkbox that agrees to nothing.
 */
export type SignupAccountTerms = {
  versionKey: string;
  termsBody: string;
  privacyBody: string;
};

type SignupFormProps = {
  enabled: boolean;
  /**
   * The code off the affiliate's `/signup?ref=` link, already shape-checked by
   * `referralCodeFromParam`. It prefills a visible field the signer-upper can edit or clear, and it
   * submits through `formData` on the same path a typed code takes -- there is no second route and
   * the parameter carries no authority of its own.
   */
  referralCode?: string | null;
  tiers: readonly SignupTierChoice[];
  /** The one published version, when acceptance is armed. See `SignupAccountTerms`. */
  terms?: SignupAccountTerms | null;
};

type PendingSubmitButtonProps = {
  /** Sizing the caller owns: /login makes this the full-width 60px submit the artboard draws. */
  className?: string;
  idleLabel: string;
  pendingLabel: string;
  size?: KitButtonSize;
  variant?: KitButtonVariant;
};

/**
 * `lg` and `primary` by default because the only place this renders at full size is the live action
 * of the form it closes -- the page's one fill. The demo shortcuts on /login pass `sm` / `ghost`,
 * which is what keeps four review buttons from reading as four things worth doing.
 */
export function PendingSubmitButton({
  className,
  idleLabel,
  pendingLabel,
  size = "lg",
  variant = "primary",
}: PendingSubmitButtonProps) {
  const { pending } = useFormStatus();
  return (
    <KitButton aria-live="polite" className={className} disabled={pending} size={size} type="submit" variant={variant}>
      {pending ? pendingLabel : idleLabel}
    </KitButton>
  );
}

function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

/**
 * The price as two things rather than one string: the figure a coach compares plans on, and the
 * period it is charged over.
 *
 * They were one 26px `"$497 / month"`, which sets the number at the size of a caption and gives
 * the slash the same weight as the amount. The canvas draws the figure large and the period as
 * ordinary words beside it, which is the ordering someone scanning three cards actually reads:
 * the number first, then what it buys.
 *
 * The formatting itself moved to `tierChoicePrice` in `view-models.ts` when the public marketing
 * page started quoting the same catalogue: two copies of the currency and fraction-digit rule is
 * two prices that can drift apart for the same tier.
 */
const tierPrice = tierChoicePrice;

export function SignupForm({ enabled, referralCode = null, terms = null, tiers }: SignupFormProps) {
  const [timezone, setTimezone] = useState("");
  // Never pre-ticked. A box the product ticked on the signer-upper's behalf is not an acceptance,
  // and the server records this against an immutable content hash, so it has to be their act.
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
      <div aria-live="polite">
        <DeckPanel eyebrow="Account status" hero headingId="signup-outcome" name={outcome.title}>
          <Prose className="text-[16px] leading-[1.55] text-[color:var(--muted)]">{outcome.detail}</Prose>
          {outcome.referral?.visible ? (
            <Prose className="mt-[var(--s-3)] text-[16px] leading-[1.55] text-[color:var(--body)]" role="status">
              {outcome.referral.message}
            </Prose>
          ) : null}
          {/*
            The account exists by the time this renders, so walking into it is the single live
            action and it takes the fill the submit button was carrying a moment ago.
          */}
          {outcome.nextHref ? (
            <Link
              className={kitButtonClass({
                className: "mt-[var(--s-5)] h-[var(--coach-target-primary)] w-full text-[18px]",
                size: "lg",
                variant: "primary",
              })}
              href={outcome.nextHref}
            >
              Continue
            </Link>
          ) : null}
        </DeckPanel>
      </div>
    );
  }

  if (!descriptor.enabled || descriptor.unavailableCode === "tier_catalog_unavailable") {
    return (
      <DataState
        body={descriptor.enabled
          ? "No named plan is available, so signup stays disabled instead of choosing one for you."
          : "Self-serve onboarding is currently off. No account or provider work has started."}
        kind="unavailable"
        title="Account setup is not available yet"
      />
    );
  }


  return (
    <form action={submit} className="flex flex-col gap-[var(--s-5)]">
      {error ? (
        <AuthNotice role="alert" tone="failure">
          {error}
        </AuthNotice>
      ) : null}

      {/*
        Two panels, numbered, because the artboard numbers them: a signer-upper who can see there
        are exactly two steps will finish the first one. The old form was four undifferentiated
        cards and gave no sense of how much was left.
      */}
      <DeckPanel eyebrow="Step one of two" headingId="signup-about" name="About you">
        <div className="grid gap-[var(--s-5)] @min-[520px]:grid-cols-2">
          <Field label="Full name" required><KitInput autoComplete="name" name="fullName" required /></Field>
          <Field label="Business name" required><KitInput autoComplete="organization" name="businessName" required /></Field>
          <Field label="Workspace address" hint="Lowercase letters, numbers, and hyphens." required>
            <KitInput name="slug" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" required />
          </Field>
          <Field label="Email" required><KitInput autoComplete="email" name="email" required type="email" /></Field>
          <PasswordField
            autoComplete="new-password"
            hint="Use at least eight characters."
            minLength={8}
          />
          <Field label="Business timezone" hint="This is the clock your reports use." required>
            <KitInput name="timezone" onChange={(event) => setTimezone(event.target.value)} required value={timezone} />
          </Field>
          {/*
            Prefilled and still editable. The alternative was raised -- lock it once it arrives
            from a link -- and the field stays writable because a readonly box a prospect cannot
            correct is worse than a wrong code they can: nothing here is trusted, and the RPC
            resolves whatever is submitted against `affiliates.referral_code` either way. The hint
            says where the value came from so it does not read as something they typed.
          */}
          <Field
            hint={referralCode ? "From the link you followed. You can change or clear it." : "Optional"}
            label="Referral code"
          >
            <KitInput defaultValue={referralCode ?? ""} name="referralCode" />
          </Field>
        </div>
      </DeckPanel>

      {/*
        The plan-move note reads in the header band rather than above the grid, which is where the
        canvas puts it: it is a fact about every card, not a preamble to the first one, and above
        the grid it read as a caption belonging to whichever card sat under it.
      */}
      <DeckPanel
        eyebrow="Step two of two"
        headingId="signup-plan"
        name="Pick a plan"
        sentence="You can move up or down a plan any month."
      >
        <fieldset className="min-w-0 border-0 p-0">
          {/* The panel's name is already the question, so the legend carries the same words for a
              screen reader rather than printing a second heading beside it. */}
          <legend className="sr-only">Pick a plan</legend>
          <div
            className="grid gap-[var(--s-3)]"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" }}
          >
            {descriptor.tierChoices.map((tier) => (
              /*
                Selected means the coach chose it, so the accent lands on the card they picked and
                nowhere else. Nothing is preselected: a default plan wearing the chosen-it face
                would be the product answering a question only the coach can.
              */
              <label
                className="flex min-h-[var(--coach-target)] cursor-pointer flex-col gap-[var(--s-3)] rounded-[18px_18px_13px_13px] border border-[var(--line)] bg-[var(--well)] p-[22px] text-[16px] text-[color:var(--body)] transition-colors duration-[var(--duration-quick)] hover:border-[var(--accent-edge)] has-checked:border-[var(--accent-edge)] has-checked:bg-[var(--accent-wash)] motion-reduce:transition-none"
                key={tier.id}
              >
                <span className="flex items-center gap-[var(--s-3)]">
                  <input
                    aria-label={tier.label}
                    checked={selectedTierId === tier.id}
                    className="size-[20px] shrink-0 accent-[var(--accent)]"
                    /* The 44px floor is the card's job, not the radio's: a 44px-tall radio inside
                       a 22px row would push the plan name off its own baseline. */
                    data-coach-target="exempt"
                    name="tierId"
                    onChange={() => setSelectedTierId(tier.id)}
                    required
                    type="radio"
                    value={tier.id}
                  />
                  <span className="text-[19px] font-[600] text-[color:var(--ink)]">{tier.label}</span>
                </span>
                {tierPrice(tier) ? (
                  <span className="flex flex-wrap items-baseline gap-[var(--s-2)]">
                    <span className="mono text-[38px] leading-[0.92] font-[500] tracking-[-0.075em] tabular-nums text-[color:var(--ink)]">
                      {tierPrice(tier)!.amount}
                    </span>
                    <span className="text-[16px] leading-[1.4] text-[color:var(--muted)]">
                      {tierPrice(tier)!.period}
                    </span>
                  </span>
                ) : null}
                {/*
                  What the money buys, which is the number the plans actually differ on. The price
                  varies least between tiers; the allowance is the choice.

                  The artboard's line is "10 booked calls included, then $34 each" and only the
                  first half is here. No column, contract field or env value in this product
                  records a per-call overage price, so the second half would be the signup page
                  inventing a number a customer is then owed at. Whether calls past the allowance
                  are billed at all, and at what price, is the owner's commercial call and has not
                  been made. So the card states the allowance and stops, which is a complete true
                  sentence rather than half of an invented one.

                  Absent rather than zero when the catalogue could not state it: `namedTierChoices`
                  drops anything that is not a non-negative whole number, and a card that says
                  nothing is honest where "0 booked calls included" is a claim.
                */}
                {tier.callAllowance === undefined ? null : (
                  <span className="text-[16px] leading-[1.4] text-[color:var(--muted)]">
                    <span className="mono tabular-nums text-[color:var(--ink)]">{tier.callAllowance}</span>
                    {tier.callAllowance === 1 ? " booked call included" : " booked calls included"}
                  </span>
                )}
              </label>
            ))}
          </div>
        </fieldset>
      </DeckPanel>

      {/*
        The honest-states rule, said before any money changes hands rather than discovered three
        weeks later. Two numbers a coach can check: a day for the Meta channels, about three weeks
        for texting, and the reason for the difference. No percentage and no finish date, because
        the carriers publish neither and inventing one here is the exact thing `CLAUDE.md` bans.
      */}
      <div
        className="flex items-start gap-[var(--s-4)] rounded-[16px_16px_12px_12px] border p-[20px_24px] text-[17px] leading-[1.55]"
        style={{
          background: "var(--waiting-wash)",
          borderColor: "var(--waiting-line)",
          color: "var(--body)",
        }}
      >
        <span className="mt-[6px]"><StatusDot size={6} tone="waiting" /></span>
        <Prose className="min-w-0">
          Instagram and Messenger answer within a day of signing up. Text messaging takes about
          three weeks, because the phone carriers review every new business before they let it
          send. We show you which day of that review you are on.
        </Prose>
      </div>

      <Surface variant="strip">
        <label className="flex items-start gap-[var(--s-3)] text-[16px] leading-[1.55] text-[color:var(--body)]">
          <Checkbox aria-labelledby="affiliate-opt-in-label" className="mt-[var(--s-1)]" name="affiliateOptIn" />
          <span id="affiliate-opt-in-label">Also enrol this account in the affiliate program.</span>
        </label>
        <Prose className="mt-[var(--s-2)] text-[15px] leading-[1.5] text-[color:var(--faint)]">
          Billing notices use this login email by default.
        </Prose>
      </Surface>

      {terms ? (
        <Surface data-slot="signup-account-terms" variant="strip">
          <label className="flex items-start gap-[var(--s-3)] text-[16px] leading-[1.55] text-[color:var(--body)]">
            <Checkbox
              aria-labelledby="account-terms-label"
              checked={termsAccepted}
              className="mt-[var(--s-1)]"
              name="acceptedTerms"
              onCheckedChange={(checked) => setTermsAccepted(checked === true)}
              required
            />
            <span id="account-terms-label">
              I accept the SetterFi terms of service and privacy policy.
            </span>
          </label>
          {/*
            The document itself, not a link to a page that might say something else. What opens
            here is the exact copy the server hashed, which is the copy the acceptance is recorded
            against, so the two cannot drift.
          */}
          <div className="mt-[var(--s-3)] flex flex-col gap-[var(--s-2)]">
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
          </div>
          <Prose className="mt-[var(--s-2)] text-[15px] leading-[1.5] text-[color:var(--faint)]">
            Version {terms.versionKey}. Your acceptance is recorded against this version.
          </Prose>
        </Surface>
      ) : null}

      <KitButton
        className="h-[var(--coach-target-primary)] w-full text-[19px]"
        disabled={!descriptor.canSubmit || !selectedTierId || (terms !== null && !termsAccepted) || submitting}
        size="lg"
        type="submit"
        variant="primary"
      >
        {submitting ? "Creating account" : "Create my account and start setup"}
      </KitButton>

      <p className="m-0 text-center text-[16px] leading-[1.5] text-[color:var(--muted)]">
        Already set up? <Link className="link-inline font-[500]" href="/login">Sign in</Link>
      </p>
    </form>
  );
}
