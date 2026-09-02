/**
 * Pure descriptors for Phase 5's coach and public onboarding surfaces.
 *
 * Pages consume only route-shaped results. Keeping copy and action availability here makes the
 * honest-state rules executable without a DOM harness or a second source of provisioning truth.
 */

import type { ArtifactView } from "@/app/api/onboarding/artifacts/handler";
import {
  a2pRegistrationDay,
  a2pRegistrationLabel,
  A2P_STALL_DAYS,
} from "@/lib/onboarding/a2p-clock";
import {
  READINESS_KEYS,
  type ContentScreenResult,
  type ProvisioningState,
  type ProvisioningStep,
  type ReadinessBlamingParty,
  type ReadinessResult,
} from "@/lib/onboarding/contracts";
import type { ReferralClientResult } from "@/lib/onboarding/referrals";
import type {
  SignupAccessState,
  SignupOrchestrationResult,
} from "@/lib/onboarding/signup";
import { PROVISIONING_STEP_REGISTRY, WIZARD_CRITICAL_STEPS } from "@/lib/onboarding/steps";
import type { CoachA2pRegistrationProjection } from "@/lib/repositories/onboarding-evidence";
import type { SelfSignupIntentStatus as SignupIntentStatus } from "@/lib/repositories/onboarding-signup";

export type SignupTierChoice = {
  id: string;
  label: string;
  /** Booked calls included in the plan. The canvas prices the product on this, not on the money. */
  callAllowance?: number;
  commercialTerms?: {
    currency: string;
    amountCents: number;
    interval: "day" | "week" | "month" | "year";
    effectiveFrom: string;
    effectiveTo: string | null;
  };
};

const TIER_INTERVAL_SUFFIX = {
  day: "a day",
  month: "a month",
  week: "a week",
  year: "a year",
} as const;

/**
 * A tier's price as the two things a card draws: the figure a coach compares plans on, and the
 * period it is charged over.
 *
 * It lives here rather than in either page because both `/signup` and the public marketing page
 * quote the same catalogue. The marketing page used to hard-code `$297` / `$497` / `$997` as
 * string literals while `/signup` projected the same plans from `public.list_signup_tier_catalog`,
 * so an operator editing a tier moved one page and silently left the other quoting a price with no
 * column behind it -- on the most externally visible surface in the product.
 *
 * `null` when the catalogue did not state a price, which is a real state: the priced read is
 * `list_signup_tier_offer_catalog` and it only serves the catalogue while `tierOfferTermsLive()`
 * is on. A caller must then say nothing about money rather than fall back to a figure of its own.
 */
export function tierChoicePrice(tier: SignupTierChoice) {
  if (!tier.commercialTerms) return null;
  try {
    const amount = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: tier.commercialTerms.currency,
      maximumFractionDigits: tier.commercialTerms.amountCents % 100 === 0 ? 0 : 2,
    }).format(tier.commercialTerms.amountCents / 100);
    return { amount, period: TIER_INTERVAL_SUFFIX[tier.commercialTerms.interval] };
  } catch {
    return null;
  }
}

export type SignupDescriptor = {
  enabled: boolean;
  tierChoices: readonly SignupTierChoice[];
  selectedTierId: null;
  timezone: string;
  timezoneEditable: true;
  timezoneRequired: true;
  billingEmailSource: "login_email";
  canSubmit: boolean;
  unavailableCode: string | null;
};

export function signupDescriptor(input: {
  enabled: boolean;
  tiers: readonly SignupTierChoice[];
  timezone: string;
}): SignupDescriptor {
  return {
    enabled: input.enabled,
    tierChoices: input.tiers,
    selectedTierId: null,
    timezone: input.timezone,
    timezoneEditable: true,
    timezoneRequired: true,
    billingEmailSource: "login_email",
    canSubmit: input.enabled && input.tiers.length > 0 && Boolean(input.timezone.trim()),
    unavailableCode: !input.enabled
      ? "phase5_disabled"
      : input.tiers.length === 0
        ? "tier_catalog_unavailable"
        : null,
  };
}

export type ReferralNotice =
  | { visible: false; message: null }
  | { visible: true; message: string };

export function referralNotice(referral: ReferralClientResult): ReferralNotice {
  if (referral.status !== "self_referral") return { visible: false, message: null };
  return {
    visible: true,
    message: "This referral code belongs to your own account, so it can’t be applied.",
  };
}

/**
 * The `?ref=` an affiliate's link carries, turned into something the referral-code field can be
 * prefilled with -- or into nothing at all.
 *
 * `GET /api/affiliate/referrals` builds `/signup?ref=<code>` and the portal draws it, but until now
 * nothing in the tree read the parameter back, so a prospect landed on a blank Referral code box,
 * submitted without it, and the affiliate lost the commission in silence. Nothing raised an error,
 * because from the schema's side nothing went wrong: `app.complete_onboarding_signup` simply never
 * received a code.
 *
 * This is a prefill and only a prefill. The value goes into a visible, editable field and reaches
 * the server through `formData` exactly as a hand-typed code does, so `?ref=` buys no trust it did
 * not already have: the RPC still resolves the code against `affiliates.referral_code` and still
 * rejects unknown, self- and revoked referrals on its own. The shape check here exists so a junk or
 * hostile parameter prefills nothing rather than seeding the field with someone's URL, and the
 * 64-character ceiling is the same one `POST /api/onboarding/signup` enforces -- a longer value the
 * route would reject anyway should never be put in front of a signer-upper as if it were valid.
 */
export function referralCodeFromParam(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // Generated codes are `SF-` plus twelve hex characters, but `affiliates.referral_code` is free
  // text, so this admits the general shape of a code rather than that one format.
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(trimmed) ? trimmed : null;
}

export type SignupResultDescriptor = {
  kind: SignupOrchestrationResult["state"];
  title: string;
  detail: string;
  nextHref: string | null;
  referral: ReferralNotice | null;
};

export function signupResultDescriptor(result: SignupOrchestrationResult): SignupResultDescriptor {
  if (result.state === "still_setting_up") {
    return {
      kind: result.state,
      title: "We’re still setting up your account",
      detail: "Your signup is saved. Try signing in again, or contact support if this continues.",
      nextHref: "/login?error=still-setting-up",
      referral: null,
    };
  }
  if (result.state === "confirmation_required") {
    return {
      kind: result.state,
      title: "Confirm your email",
      detail: "Use the confirmation link we sent before signing in.",
      nextHref: "/login",
      referral: referralNotice(result.referral),
    };
  }
  if (result.state === "session_refresh_required") {
    return {
      kind: result.state,
      title: "Your workspace is being attached",
      detail: "Sign in again so your new workspace is loaded.",
      nextHref: "/login?next=/onboarding",
      referral: referralNotice(result.referral),
    };
  }
  return {
    kind: result.state,
    title: "Your workspace is ready",
    detail: "Continue to connect the channels your leads already use.",
    nextHref: "/onboarding",
    referral: referralNotice(result.referral),
  };
}

export type LoginAccessDescriptor = {
  kind: SignupAccessState["state"];
  message: string | null;
  retryHref: string | null;
  supportHref: string | null;
};

export function loginAccessDescriptor(access: SignupAccessState): LoginAccessDescriptor {
  if (access.state === "not_onboarding") {
    return {
      kind: access.state,
      message: "Your account isn’t attached to a workspace yet. Contact your success manager.",
      retryHref: null,
      supportHref: null,
    };
  }
  if (access.state === "still_setting_up") {
    return {
      kind: access.state,
      message: "We’re still setting up your account. Your signup is saved.",
      retryHref: "/login",
      supportHref: "mailto:support@setterfi.com",
    };
  }
  return { kind: access.state, message: null, retryHref: "/onboarding", supportHref: null };
}

export function signupIntentDestination(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const intent = value as Partial<SignupIntentStatus>;
  if (typeof intent.intentId !== "string" || !intent.intentId.trim()) return null;
  if (!intent.state || !["started", "completed", "failed"].includes(intent.state)) return null;
  if (typeof intent.tenantId === "string" && intent.tenantId.trim()) return "/onboarding";
  if (intent.tenantId !== null) return null;
  return "/login?error=still-setting-up";
}

export const WIZARD_STEPS = WIZARD_CRITICAL_STEPS;

export const TEST_PASS_DETAIL =
  "Runs a real primary-calendar slot fetch and a simulated booking write. No appointment is created.";

export type ProvisioningStepDescriptor = {
  key: ProvisioningStep;
  state: ProvisioningState;
  owner: "automatic" | "coach" | "platform" | "provider";
  label: string;
  detail: string;
  canRetry: boolean;
  actionTarget: string | null;
};

/**
 * The coach-facing name of each provisioning step, exported because more than one surface names
 * the same step: the onboarding journey and the coach Dashboard's blocked-setup line both read it,
 * and a second copy of this map is a place for the two to disagree.
 */
export const STEP_LABELS: Record<ProvisioningStep, string> = {
  account: "Account",
  billing: "Subscription",
  ghl_location: "Workspace provisioning",
  ghl_snapshot: "Agent configuration",
  phone_number: "Text number",
  sms_eligibility_screen: "Text eligibility",
  business_profile: "Business profile",
  optin_artifact: "Opt-in pages",
  a2p_brand: "Business registration",
  a2p_campaign: "Campaign registration",
  sms_live: "Text messages (SMS)",
  meta_connect: "Instagram and Messenger",
  whatsapp_connect: "WhatsApp",
  calendar_connect: "Calendar",
  offer_layer: "Offer",
  test_pass: "Safe test",
  go_live: "Go live",
};

export function provisioningStepDescriptor(input: {
  key: ProvisioningStep;
  state: ProvisioningState;
  code?: string | null;
}): ProvisioningStepDescriptor {
  const definition = PROVISIONING_STEP_REGISTRY.find((candidate) => candidate.key === input.key);
  if (!definition) throw new Error(`PROVISIONING_STEP_DESCRIPTOR_MISSING:${input.key}`);
  const canRetry = definition.owner === "coach"
    && input.state !== "blocked"
    && ["awaiting_coach", "failed"].includes(input.state);
  const detail = input.state === "blocked"
    ? "This step is permanently blocked. Contact the operator for the next step."
    : input.state === "done"
      ? "Verified from persisted route evidence."
      : input.code === "offer_held"
        ? "Your offer is with our team for review. We’ll email you when it clears."
        : "This state comes from the onboarding service and changes only when its evidence changes.";
  return {
    key: input.key,
    state: input.state,
    owner: definition.owner,
    label: STEP_LABELS[input.key],
    detail,
    canRetry,
    actionTarget: canRetry ? `/api/onboarding/steps/${input.key}` : null,
  };
}

export type ReadinessCheckDescriptor = {
  key: (typeof READINESS_KEYS)[number];
  ready: boolean;
  title: string;
  detail: string;
  blamingParty: ReadinessBlamingParty;
  evidenceAt: string | null;
};

const READINESS_TITLES: Record<(typeof READINESS_KEYS)[number], string> = {
  tenant_active: "Workspace activation",
  messaging_channel_live: "Lead channel",
  primary_calendar_healthy: "Primary calendar",
  published_offer_ready: "Published offer",
  platform_brain_published: "The Brain",
  test_passed: "Safe test",
  subscription_ready: "Subscription",
};

function readinessDetail(code: string) {
  if (code === "offer_held") {
    return "Your offer is with our team for review. We’ll email you when it clears.";
  }
  if (code === "platform_brain_publish_pending") {
    return "We’re finishing a platform update. Your agent can go live as soon as it’s done.";
  }
  if (code === "subscription_contract_unavailable") {
    return "Subscription status is unavailable, so go-live stays disabled.";
  }
  return code.replaceAll("_", " ");
}

export function readinessDescriptors(result: ReadinessResult): readonly ReadinessCheckDescriptor[] {
  const byKey = new Map(result.checks.map((check) => [check.key, check]));
  return READINESS_KEYS.map((key) => {
    const check = byKey.get(key);
    if (!check) throw new Error(`READINESS_DESCRIPTOR_MISSING:${key}`);
    return {
      key,
      ready: check.ready,
      title: READINESS_TITLES[key],
      detail: check.ready ? "Verified" : readinessDetail(check.code),
      blamingParty: check.blamingParty,
      evidenceAt: check.evidenceAt,
    };
  });
}

export type A2pDescriptor =
  | {
      kind: "not_filed";
      label: "Waiting to file";
      detail: string;
      extra: null;
      showTimer: false;
      canRetry: false;
    }
  | {
      kind: "registering";
      label: string;
      detail: "Carrier review usually takes 2–3 weeks.";
      extra: string | null;
      showTimer: true;
      canRetry: false;
    }
  | {
      kind: "blocked";
      label: "Text messages aren’t available for this account.";
      detail: string;
      extra: "Contact the operator to review what happened.";
      showTimer: false;
      canRetry: false;
    };

export function a2pDescriptor(input: {
  submittedAt: string | null;
  now: number;
  terminalMessage?: string | null;
}): A2pDescriptor {
  if (input.terminalMessage) {
    return {
      kind: "blocked",
      label: "Text messages aren’t available for this account.",
      detail: input.terminalMessage,
      extra: "Contact the operator to review what happened.",
      showTimer: false,
      canRetry: false,
    };
  }
  if (!input.submittedAt) {
    return {
      kind: "not_filed",
      label: "Waiting to file",
      detail: "Registration starts after the required business and consent evidence is approved.",
      extra: null,
      showTimer: false,
      canRetry: false,
    };
  }
  const day = a2pRegistrationDay(input.submittedAt, input.now);
  if (day === null) throw new Error("A2P_SUBMISSION_TIMESTAMP_INVALID");
  return {
    kind: "registering",
    label: a2pRegistrationLabel(day),
    detail: "Carrier review usually takes 2–3 weeks.",
    extra: day >= A2P_STALL_DAYS
      ? "This is running longer than usual and we’ve flagged it for review."
      : null,
    showTimer: true,
    canRetry: false,
  };
}

export function a2pProjectionDescriptor(
  registration: CoachA2pRegistrationProjection | null,
  now: number,
) {
  const terminalMessage = registration?.terminalRejection
    ? `The carrier registration was permanently declined (${registration.terminalCode}).`
    : null;
  return a2pDescriptor({
    submittedAt: registration?.submittedAt ?? null,
    now,
    terminalMessage,
  });
}

/**
 * Seeded demo rows carry sentinel values like
 * `SETTERFI_DEMO_PLACEHOLDER_PHASE5_TEMPLATE_V1` so nothing mistakes them for
 * filed evidence. They are a storage convention, never copy: rendering the
 * token verbatim told a coach nothing and read as a bug. The raw value stays on
 * the descriptor for exports and machine lines; screens read the label.
 */
const DEMO_PLACEHOLDER_PREFIX = "SETTERFI_DEMO_PLACEHOLDER_";

export function isDemoPlaceholderToken(value: string) {
  return value.startsWith(DEMO_PLACEHOLDER_PREFIX);
}

export function templateVersionLabel(templateVersion: string) {
  return isDemoPlaceholderToken(templateVersion)
    ? "Demo placeholder, replaced when your real opt-in copy is filed"
    : templateVersion;
}

export type ArtifactDescriptor = {
  artifactId: string;
  version: number;
  templateVersion: string;
  /** Display form of `templateVersion`; never a raw demo sentinel. */
  templateLabel: string;
  campaignDescriptionHash: string;
  termsUrl: string;
  privacyUrl: string;
  controls: ArtifactView["controls"];
  demoOnly: boolean;
  confirmed: boolean;
};

export function artifactDescriptor(artifact: ArtifactView): ArtifactDescriptor {
  return {
    artifactId: artifact.artifactId,
    version: artifact.version,
    templateVersion: artifact.templateVersion,
    templateLabel: templateVersionLabel(artifact.templateVersion),
    campaignDescriptionHash: artifact.campaignDescriptionHash,
    termsUrl: artifact.termsUrl,
    privacyUrl: artifact.privacyUrl,
    controls: artifact.controls,
    demoOnly: artifact.placeholder,
    confirmed: artifact.confirmedAt !== null,
  };
}

export type HostedArtifactView = ArtifactView & {
  tenantSlug: string;
  businessName: string;
  isDemo: boolean;
  termsBody: string | null;
  termsBodyHash: string | null;
  privacyBody: string | null;
  privacyBodyHash: string | null;
  artifactHash: string;
};

export type HostedConsentSubmission = {
  artifactId: string;
  consentToken: string | null;
  marketing: boolean;
  nonMarketing: boolean;
};

/** An all-unchecked form is a valid submission and deliberately carries no identity evidence. */
export function hostedConsentSubmission(input: {
  artifactId: string;
  marketing: boolean;
  nonMarketing: boolean;
  consentToken?: string | null;
}): HostedConsentSubmission {
  const selected = input.marketing || input.nonMarketing;
  return {
    artifactId: input.artifactId,
    consentToken: selected ? input.consentToken?.trim() || null : null,
    marketing: input.marketing,
    nonMarketing: input.nonMarketing,
  };
}

export type ContentScreenDescriptor = {
  kind: "missing" | "clean" | "coach_action" | "waiting_admin" | "confirmed";
  matches: ContentScreenResult["matches"];
  filingAvailable: boolean;
  stale: boolean;
};

export function contentScreenDescriptor(
  screen: ContentScreenResult | null,
  currentInputHash: string | null,
): ContentScreenDescriptor {
  if (!screen) return { kind: "missing", matches: [], filingAvailable: false, stale: false };
  if (currentInputHash !== null && screen.inputHash !== currentInputHash) {
    return { kind: "coach_action", matches: screen.matches, filingAvailable: false, stale: true };
  }
  if (screen.state === "clean") {
    return { kind: "clean", matches: [], filingAvailable: true, stale: false };
  }
  if (!screen.coachAcknowledgedAt) {
    return { kind: "coach_action", matches: screen.matches, filingAvailable: false, stale: false };
  }
  if (!screen.adminConfirmedAt) {
    return { kind: "waiting_admin", matches: screen.matches, filingAvailable: false, stale: false };
  }
  return { kind: "confirmed", matches: screen.matches, filingAvailable: true, stale: false };
}
