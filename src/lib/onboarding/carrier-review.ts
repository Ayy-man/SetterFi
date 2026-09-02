import type { ProvisioningState } from "@/lib/onboarding/contracts";

/**
 * Where an A2P registration actually is, reduced to the six answers a reader can act on.
 *
 * This reduction lived in `coach-channel-status.tsx` and is a lib now because a route outside the
 * workspace needs the same answer. `/onboarding/sms-eligibility` reduced the registration to its
 * `submittedAt` alone and never read `state`, so once the `a2p_campaign` step reached `done`,
 * `failed` or `blocked` the page still rendered "With the carriers" over a `DayCounter` climbing
 * forever -- day 47 of a review that ended on day 19, on the one surface whose whole subject is
 * the A2P clock. Two workspace surfaces already gated the counter on state and that step did not,
 * and the fix is one reduction all three call rather than a fourth copy of it.
 *
 * It does not live in the component it came from because an onboarding route importing a
 * workspace component is the wrong dependency direction: onboarding runs before there is a
 * workspace to render, and `OnboardingStage` documents that it deliberately mounts none of the
 * workspace chrome. The reduction is data, so it belongs beside the `ProvisioningState` it reads.
 *
 * The raw `ProvisioningState` does not answer the question on its own: `running` means "filed and
 * waiting" when a `submittedAt` exists and "we are still assembling it" when one does not, so a
 * surface switching on `running` alone would tell half the tenants in that state that carriers are
 * reviewing something nobody has filed.
 *
 * `unchecked` is not folded into `not-filed`. A read that did not run has established nothing, and
 * saying "registration has not been filed" on the strength of a failed query is the confident
 * wrong answer the honest-states rule exists to stop. For the same reason `failed` is its own arm
 * rather than falling through to `not-filed`: a registration that was filed and did not complete
 * is not a registration that was never filed, and only one of those two sentences is true.
 */
export type CarrierReview =
  | { kind: "unchecked" }
  | { kind: "not-filed" }
  | { kind: "in-review"; submittedAt: string | null }
  | { kind: "live" }
  | { kind: "failed" }
  | { kind: "blocked" };

/**
 * Reduces the A2P registration projection to the answer a surface needs.
 *
 * `checked: false` wins over everything, including a registration object that happens to be
 * present, because a caller that could not complete its read has nothing to reduce.
 */
export function carrierReviewFrom(input: {
  checked: boolean;
  registrationState: ProvisioningState | null;
  submittedAt: string | null;
  terminalRejection: boolean;
}): CarrierReview {
  if (!input.checked) return { kind: "unchecked" };
  if (input.terminalRejection || input.registrationState === "blocked") return { kind: "blocked" };
  if (input.registrationState === null) return { kind: "not-filed" };
  if (input.registrationState === "done") return { kind: "live" };
  if (input.registrationState === "failed") return { kind: "failed" };
  if (
    input.registrationState === "awaiting_provider"
    || (input.registrationState === "running" && input.submittedAt !== null)
  ) {
    return { kind: "in-review", submittedAt: input.submittedAt };
  }
  return { kind: "not-filed" };
}
