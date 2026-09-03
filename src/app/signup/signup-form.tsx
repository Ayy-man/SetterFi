"use client";

import { useFormStatus } from "react-dom";

import {
  KitButton,
  type KitButtonSize,
  type KitButtonVariant,
} from "@/components/kit/atomics";

/*
 * What is left of the pre-rehaul signup form: the type the route's terms payload is shaped by, and
 * the submit both auth cards close with. The form itself is `RehaulSignupForm`, which is the only
 * thing `/signup` renders.
 */

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
