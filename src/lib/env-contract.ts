import { isProductionDeployment } from "@/lib/auth/mode";

/**
 * The single names-only inventory for deployment configuration.
 *
 * Provider modules receive narrowed values from here instead of reading the process environment,
 * which keeps missing-key errors useful without ever copying a secret into an error or snapshot.
 */

export const ENV_CONTRACT_NAMES = [
  "SHADCNBLOCKS_API_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ACCESS_TOKEN",
  "SUPABASE_DB_PASSWORD",
  "SETTERFI_ACCESS_PASSWORD",
  "SETTERFI_AUTH_MODE",
  "SETTERFI_DEMO_LOGINS",
  "SETTERFI_DEMO_LOGIN_PASSWORD",
  "SETTERFI_PRODUCTION_DEMO_LOGINS",
  "SETTERFI_PHASE1_LIVE",
  "SETTERFI_PIPELINE_WRITE_LIVE",
  "SETTERFI_BOOKING_CONFIRM_LIVE",
  "SETTERFI_APPOINTMENT_LIFECYCLE_LIVE",
  "SETTERFI_INBOX_VERBS_LIVE",
  "SETTERFI_PHASE2_LIVE",
  "SETTERFI_PLATFORM_CONVERSATION_QUEUE_LIVE",
  "SETTERFI_PHASE4_LIVE",
  "SETTERFI_CONTACT_MANAGEMENT_LIVE",
  "SETTERFI_WHATSAPP_EMBEDDED_SIGNUP",
  "SETTERFI_GHL_DRIVER",
  "SETTERFI_OPENROUTER_DRIVER",
  "SETTERFI_META_DRIVER",
  "SETTERFI_NOTION_DRIVER",
  "SETTERFI_EMBEDDINGS_DRIVER",
  "SETTERFI_TAG_SECRET",
  "SETTERFI_SUPPRESSION_PEPPER",
  "SETTERFI_CREDENTIAL_ENCRYPTION_KEY",
  "CRON_SECRET",
  "GHL_CLIENT_ID",
  "GHL_CLIENT_SECRET",
  "GHL_WEBHOOK_PUBLIC_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "NOTION_API_KEY",
  "NOTION_KB_ROOT_ID",
  "NOTION_EXPORT_PATH",
  "META_APP_ID",
  "META_APP_SECRET",
  "META_LOGIN_CONFIG_ID",
  "META_SYSTEM_USER_TOKEN",
  "META_WEBHOOK_VERIFY_TOKEN",
  "META_WHATSAPP_SYSTEM_USER_TOKEN",
  "META_WABA_ID",
  "META_WHATSAPP_PHONE_NUMBER_ID",
  "APP_BASE_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "SETTERFI_GHL_TEST_ACCESS_TOKEN",
  "SETTERFI_GHL_TEST_LOCATION_ID",
  "SETTERFI_GHL_TEST_CALENDAR_ID",
  "SETTERFI_GHL_TEST_CONTACT_ID",
  // Phase 3
  "SETTERFI_PHASE3_LIVE",
  "SETTERFI_SUPPRESSION_SYNC_LIVE",
  "SETTERFI_CONTACT_DELETE_LIVE",
  // Phase 5
  "SETTERFI_PHASE5_LIVE",
  "SETTERFI_SIGNUP_REPAIR_LIVE",
  "SETTERFI_GHL_PROVISIONING_DRIVER",
  "GHL_AGENCY_ACCESS_TOKEN",
  "GHL_AGENCY_COMPANY_ID",
  "GHL_SNAPSHOT_ID",
  "GHL_NUMBER_POOL_ID",
  "SETTERFI_A2P_PROBE_TARGET",
  "SETTERFI_A2P_PROBE_TARGET_HASH",
  "SETTERFI_DEMO_PLACEHOLDER_CONSENT_VERSION",
  "SETTERFI_DEMO_PLACEHOLDER_CAMPAIGN_COPY_VERSION",
  // Phase 6
  "SETTERFI_PHASE6_LIVE",
  "SETTERFI_PHASE6_AFFILIATES_LIVE",
  "SETTERFI_PHASE6_STRIPE_LIVE",
  "SETTERFI_CHECKOUT_ATTEMPTS_LIVE",
  "SETTERFI_STRIPE_DRIVER",
  "SETTERFI_DEMO_PLACEHOLDER_TIER_PRICES",
  "SETTERFI_DEMO_PLACEHOLDER_ALLOWANCE_NOTICE",
  "SETTERFI_DEMO_PLACEHOLDER_DISPUTE_PATH",
  "SETTERFI_DEMO_PLACEHOLDER_AFFILIATE_TERMS",
  // Phase 7
  "SETTERFI_PHASE7_LIVE",
  "SETTERFI_PHASE7_ANALYTICS_LIVE",
  "SETTERFI_PHASE7_EVALS_LIVE",
  "SETTERFI_PHASE7_MEET_AGENT_LIVE",
  // A synthetic platform snapshot is allowed only on the explicitly demo-login review build.
  // It never changes the real analytics_* aggregate.
  "SETTERFI_PLATFORM_PREVIEW_DATA",
  // Phase 8
  "SETTERFI_PHASE8_LIVE",
  "SETTERFI_PHASE8_ALERTS_LIVE",
  "SETTERFI_PHASE8_ALERT_RULE_EVENTS_LIVE",
  "SETTERFI_PHASE8_SUPPORT_LIVE",
  "SETTERFI_PHASE8_EXPORTS_LIVE",
  "SETTERFI_PHASE8_ENGINE_EVAL_LIVE",
  "SETTERFI_EMAIL_DRIVER",
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SIGNING_SECRET",
  "SETTERFI_EMAIL_FROM",
  // Phase 9
  // GHL_AGENCY_ACCESS_TOKEN survives as a bootstrap-only path: a hand-pasted agency token that
  // works until the stored install exists, and stops being consulted the moment it does. The
  // provider rotates that token every ~24 hours, so nothing durable may depend on it.
  "SETTERFI_PHASE9_LIVE",
  "SETTERFI_PHASE9_GHL_OAUTH_LIVE",
  "GHL_AGENCY_CLIENT_ID",
  "GHL_AGENCY_CLIENT_SECRET",
  "GHL_INSTALL_URL",
  "GHL_AGENCY_INSTALL_URL",
  // Phase 10 (Brain objection runtime)
  "SETTERFI_BRAIN_OBJECTIONS_LIVE",
  // Account security controls
  "SETTERFI_ACCOUNT_SECURITY_LIVE",
  // A second factor rides behind the session/password controls it protects.
  "SETTERFI_ACCOUNT_MFA_LIVE",
  // Email change is separate from the rest of account security because it currently moves only
  // the application row, not the auth identity.
  "SETTERFI_ACCOUNT_EMAIL_CHANGE_LIVE",
  // Team membership remains separately inert while the single-workspace claims contract is in place.
  "SETTERFI_TENANT_MEMBERSHIP_LIVE",
  // Tenant ownership transfer is a separate authority from membership: it moves the one role that
  // can end another member's access, so it stays inert on its own gate.
  "SETTERFI_TENANT_OWNERSHIP_LIVE",
  // The account contract the customer accepts at signup, versioned and receipted.
  "SETTERFI_ACCOUNT_TERMS_LIVE",
  // Effective-dated commercial terms on the tier catalogue.
  "SETTERFI_TIER_OFFER_TERMS_LIVE",
  // The repaired offer-layer read. Off, the engine sees what it has been seeing. Deliberately at
  // the end rather than beside Phase 10: the inventory test pins that block at exactly one name.
  "SETTERFI_OFFER_LAYER_ENGINE_INPUT_LIVE",
  // The public marketing page at `/`. Off, `/` is the role picker it has always been and stays
  // behind the gate; on, `/` is a public sales page anyone can load without a session. That is a
  // change to who can reach what rather than a change to how a page looks, which is why it is a
  // flag on a project with one environment that deploys straight to the client's Vercel project.
  "SETTERFI_PUBLIC_LANDING_LIVE",
  // Meta Conversions API for Business Messaging stays mock unless this exact capability is armed.
  "SETTERFI_CAPI_LIVE",
  // Google Calendar connect. The coach-facing OAuth routes do not exist as far as a browser is
  // concerned until this is armed, which is what lets the work ship to the single production
  // project without changing anything for the client.
  "SETTERFI_GOOGLE_CALENDAR_OAUTH_LIVE",
  "GOOGLE_CALENDAR_CLIENT_ID",
  "GOOGLE_CALENDAR_CLIENT_SECRET",
  // The first-customer build gate's disarm switch, and the only value that softens it. Unset or
  // "true", an invalid first-customer environment FAILS the production build (the F-P0-ENV-GATE
  // behaviour). Exactly "false", the verifier still runs and prints every missing/invalid name in
  // the build log, but the build proceeds. Added 2026-09-02 on Ayman's ruling: all feature gates
  // were opened before the real Stripe/Meta/OpenAI/Resend credentials exist, which made every
  // production deploy fail; the debt stays visible in each build's log until the credential list
  // is filled, and deleting this variable re-arms the gate.
  "SETTERFI_FIRST_CUSTOMER_ENFORCE",
] as const;

export type EnvironmentName = (typeof ENV_CONTRACT_NAMES)[number];
export type EnvironmentSource = Readonly<Record<string, string | undefined>>;
export type DriverSelection = "mock" | "real";
export type DriverName =
  | "ghl"
  | "calendar"
  | "openrouter"
  | "meta"
  | "notion"
  | "embeddings"
  // Phase 3
  | "suppression"
  // Phase 5
  | "ghl_provisioning"
  // Phase 6
  | "stripe"
  // Phase 8
  | "email";
export type DriverSelectorName = Extract<
  EnvironmentName,
  | "SETTERFI_GHL_DRIVER"
  | "SETTERFI_OPENROUTER_DRIVER"
  | "SETTERFI_META_DRIVER"
  | "SETTERFI_NOTION_DRIVER"
  | "SETTERFI_EMBEDDINGS_DRIVER"
  // Phase 5
  | "SETTERFI_GHL_PROVISIONING_DRIVER"
  // Phase 6
  | "SETTERFI_STRIPE_DRIVER"
  // Phase 8
  | "SETTERFI_EMAIL_DRIVER"
>;

export class DriverConfigurationError extends Error {
  readonly code = "DRIVER_CONFIGURATION_ERROR";

  constructor(
    readonly driver: DriverName,
    readonly variableNames: readonly EnvironmentName[],
  ) {
    super(`Driver ${driver} is missing or has invalid configuration: ${variableNames.join(", ")}`);
    this.name = "DriverConfigurationError";
  }
}

export function environmentValue(
  name: EnvironmentName,
  environment: EnvironmentSource = process.env,
) {
  const value = environment[name]?.trim();
  return value ? value : undefined;
}

/**
 * Whether /login offers the seeded demo accounts as one-click buttons. Off unless the
 * value is exactly "true": the buttons serialise a working password into the page's
 * HTML, so anywhere a real coach can reach, this stays unset.
 */
export function demoLoginsEnabled(environment: EnvironmentSource = process.env) {
  return environmentValue("SETTERFI_DEMO_LOGINS", environment) === "true";
}

/** Provider delivery is opt-in; an unset or non-exact value always selects the mock arm. */
export function capiLive(environment: EnvironmentSource = process.env) {
  return environmentValue("SETTERFI_CAPI_LIVE", environment) === "true";
}

/**
 * Unset, or set to anything other than exactly "true", and all four Google Calendar routes answer
 * 404 and the onboarding page renders no Connect button. There is one environment on this project
 * and it is the client's, so the flag is the only thing standing between an unreviewed OAuth flow
 * and a coach who can reach it.
 */
export function googleCalendarOAuthLive(environment: EnvironmentSource = process.env) {
  return environmentValue("SETTERFI_GOOGLE_CALENDAR_OAUTH_LIVE", environment) === "true";
}

/**
 * A temporary review deployment may expose the demo buttons in Vercel Production, but only behind
 * the shared access cookie. Requiring all four values prevents a partial configuration from making
 * credentials public or silently weakening the normal Supabase-only production mode.
 */
export function productionDemoLoginsEnabled(environment: EnvironmentSource = process.env) {
  return isProductionDeployment(environment)
    && demoLoginsEnabled(environment)
    && environmentValue("SETTERFI_PRODUCTION_DEMO_LOGINS", environment) === "true"
    && Boolean(environmentValue("SETTERFI_DEMO_LOGIN_PASSWORD", environment))
    && Boolean(environmentValue("SETTERFI_ACCESS_PASSWORD", environment));
}

export function phase1Live(environment: EnvironmentSource = process.env) {
  return environmentValue("SETTERFI_PHASE1_LIVE", environment) === "true";
}

export function pipelineWriteLive(environment: EnvironmentSource = process.env) {
  return phase1Live(environment)
    && environmentValue("SETTERFI_PIPELINE_WRITE_LIVE", environment) === "true";
}

export function bookingConfirmLive(environment: EnvironmentSource = process.env) {
  return phase1Live(environment)
    && environmentValue("SETTERFI_BOOKING_CONFIRM_LIVE", environment) === "true";
}

/**
 * Cancelling or moving a booked appointment writes to a real calendar and a real lead's day, which
 * is a wider blast radius than confirming one. It switches on separately from booking confirmation
 * rather than arriving with it.
 */
export function appointmentLifecycleLive(environment: EnvironmentSource = process.env) {
  return bookingConfirmLive(environment)
    && environmentValue("SETTERFI_APPOINTMENT_LIFECYCLE_LIVE", environment) === "true";
}

export function inboxVerbsLive(environment: EnvironmentSource = process.env) {
  return phase1Live(environment)
    && environmentValue("SETTERFI_INBOX_VERBS_LIVE", environment) === "true";
}

/** Signed-in session management and password changes stay unavailable until explicitly released. */
export function accountSecurityLive(environment: EnvironmentSource = process.env) {
  return environmentValue("SETTERFI_ACCOUNT_SECURITY_LIVE", environment) === "true";
}

export function phase2Live(environment: EnvironmentSource = process.env) {
  return environmentValue("SETTERFI_PHASE2_LIVE", environment) === "true";
}

/**
 * The cross-tenant human queue reads other tenants' conversations, so it nests under Phase 2 —
 * the conversation surface it reads — and switches on separately from it.
 */
export function platformConversationQueueLive(environment: EnvironmentSource = process.env) {
  return phase2Live(environment)
    && environmentValue("SETTERFI_PLATFORM_CONVERSATION_QUEUE_LIVE", environment) === "true";
}

export function phase4Live(environment: EnvironmentSource = process.env) {
  return environmentValue("SETTERFI_PHASE4_LIVE", environment) === "true";
}

/**
 * Coach-authored contact writes — creation, tags, notes, CSV import — ride on the Phase 4 contact
 * surface, so they nest under it and switch on separately from it.
 */
export function contactManagementLive(environment: EnvironmentSource = process.env) {
  return phase4Live(environment)
    && environmentValue("SETTERFI_CONTACT_MANAGEMENT_LIVE", environment) === "true";
}

export function whatsappEmbeddedSignupEnabled(
  environment: EnvironmentSource = process.env,
) {
  return phase4Live(environment)
    && environmentValue("SETTERFI_WHATSAPP_EMBEDDED_SIGNUP", environment) === "true";
}

// Phase 3
export function phase3Live(environment: EnvironmentSource = process.env) {
  return environmentValue("SETTERFI_PHASE3_LIVE", environment) === "true";
}

export function suppressionSyncLive(environment: EnvironmentSource = process.env) {
  return environmentValue("SETTERFI_SUPPRESSION_SYNC_LIVE", environment) === "true";
}

export function contactDeleteLive(environment: EnvironmentSource = process.env) {
  return environmentValue("SETTERFI_CONTACT_DELETE_LIVE", environment) === "true";
}

// Phase 5
export function phase5Live(environment: EnvironmentSource = process.env) {
  return environmentValue("SETTERFI_PHASE5_LIVE", environment) === "true";
}

export function signupRepairLive(environment: EnvironmentSource = process.env) {
  return phase5Live(environment)
    && environmentValue("SETTERFI_SIGNUP_REPAIR_LIVE", environment) === "true";
}

// Phase 6
export function phase6Live(environment: EnvironmentSource = process.env) {
  return environmentValue("SETTERFI_PHASE6_LIVE", environment) === "true";
}

export function phase6AffiliatesLive(environment: EnvironmentSource = process.env) {
  return phase6Live(environment)
    && environmentValue("SETTERFI_PHASE6_AFFILIATES_LIVE", environment) === "true";
}

export function phase6StripeLive(environment: EnvironmentSource = process.env) {
  return phase6Live(environment)
    && environmentValue("SETTERFI_PHASE6_STRIPE_LIVE", environment) === "true";
}

export function checkoutAttemptsLive(environment: EnvironmentSource = process.env) {
  return phase6StripeLive(environment)
    && environmentValue("SETTERFI_CHECKOUT_ATTEMPTS_LIVE", environment) === "true";
}

// Phase 7
export function phase7Live(environment: EnvironmentSource = process.env) {
  return environmentValue("SETTERFI_PHASE7_LIVE", environment) === "true";
}

export function phase7AnalyticsLive(environment: EnvironmentSource = process.env) {
  return phase7Live(environment)
    && environmentValue("SETTERFI_PHASE7_ANALYTICS_LIVE", environment) === "true";
}

export function phase7EvalsLive(environment: EnvironmentSource = process.env) {
  return phase7Live(environment)
    && environmentValue("SETTERFI_PHASE7_EVALS_LIVE", environment) === "true";
}

export function phase7MeetAgentLive(environment: EnvironmentSource = process.env) {
  return phase7Live(environment)
    && environmentValue("SETTERFI_PHASE7_MEET_AGENT_LIVE", environment) === "true";
}

/**
 * Synthetic platform metrics for a demo-login build.
 *
 * The opt-in is the explicit `SETTERFI_PLATFORM_PREVIEW_DATA=true`, and it only counts on a build
 * that also runs demo logins: a deployment serving real customers without demo logins can never
 * select this source, whatever else was copied into its environment. Until 2026-09-04 a production
 * deployment was refused as well, which left the owner console reading zeros on the one URL the
 * owner actually opens while the seeded review data sat on a preview branch. The owner asked for
 * the numbers where they look, so the deployment target no longer decides; the two flags do. The
 * snapshot keeps its synthetic label on every surface that reads it.
 */
export function platformPreviewDataEnabled(environment: EnvironmentSource = process.env) {
  return phase7AnalyticsLive(environment)
    && demoLoginsEnabled(environment)
    && environmentValue("SETTERFI_PLATFORM_PREVIEW_DATA", environment) === "true";
}

// Phase 8
export function phase8Live(environment: EnvironmentSource = process.env) {
  return environmentValue("SETTERFI_PHASE8_LIVE", environment) === "true";
}

function phase8ChildLive(
  name: Extract<EnvironmentName,
    | "SETTERFI_PHASE8_ALERTS_LIVE"
    | "SETTERFI_PHASE8_ALERT_RULE_EVENTS_LIVE"
    | "SETTERFI_PHASE8_SUPPORT_LIVE"
    | "SETTERFI_PHASE8_EXPORTS_LIVE"
    | "SETTERFI_PHASE8_ENGINE_EVAL_LIVE">,
  environment: EnvironmentSource,
) {
  return phase8Live(environment) && environmentValue(name, environment) === "true";
}

export function phase8AlertsLive(environment: EnvironmentSource = process.env) {
  return phase8ChildLive("SETTERFI_PHASE8_ALERTS_LIVE", environment);
}

/**
 * Newly connected producer paths remain inert until alert delivery itself is live and this
 * narrower arm is enabled. That lets existing alert configuration ship before source facts start
 * creating durable notification rows.
 */
export function phase8AlertRuleEventsLive(environment: EnvironmentSource = process.env) {
  return phase8AlertsLive(environment)
    && environmentValue("SETTERFI_PHASE8_ALERT_RULE_EVENTS_LIVE", environment) === "true";
}

export function phase8SupportLive(environment: EnvironmentSource = process.env) {
  return phase8ChildLive("SETTERFI_PHASE8_SUPPORT_LIVE", environment);
}

export function phase8ExportsLive(environment: EnvironmentSource = process.env) {
  return phase8ChildLive("SETTERFI_PHASE8_EXPORTS_LIVE", environment);
}

export function phase8EngineEvalLive(environment: EnvironmentSource = process.env) {
  return phase8ChildLive("SETTERFI_PHASE8_ENGINE_EVAL_LIVE", environment);
}

// Phase 9
export function phase9Live(environment: EnvironmentSource = process.env) {
  return environmentValue("SETTERFI_PHASE9_LIVE", environment) === "true";
}

export function phase9GhlOAuthLive(environment: EnvironmentSource = process.env) {
  return phase9Live(environment)
    && environmentValue("SETTERFI_PHASE9_GHL_OAUTH_LIVE", environment) === "true";
}

// Phase 10
/**
 * Whether the Brain's objection runtime is live. It nests under Phase 2 rather than a Phase 10
 * parent because the published snapshot is Phase 2's surface and objections are part of it,
 * switching Phase 2 off must not leave an objection runtime half-live underneath it.
 */
export function brainObjectionsLive(environment: EnvironmentSource = process.env) {
  return phase2Live(environment)
    && environmentValue("SETTERFI_BRAIN_OBJECTIONS_LIVE", environment) === "true";
}

/**
 * A second factor is only meaningful alongside the session and password controls it guards, so it
 * stays behind the same gate rather than becoming reachable on its own.
 */
export function accountMfaLive(environment: EnvironmentSource = process.env) {
  return accountSecurityLive(environment)
    && environmentValue("SETTERFI_ACCOUNT_MFA_LIVE", environment) === "true";
}

/**
 * Deliberately NOT folded into accountSecurityLive. The confirmation now moves Supabase Auth's
 * identity before it writes `public.users.email`, so the two stores no longer split: auth leads,
 * the request stays pending if the projection write fails, an `auth.email_change.diverged` receipt
 * names the direction, and reopening the link converges. What still holds the flag off is delivery,
 * not identity: confirmation and refusal links go out through the email driver seam, and production
 * has no real provider credentials behind it, so a coach would be asked to confirm from a mailbox
 * nothing reached. Turning session listing and password change on must not turn that on as a side
 * effect; this stays off until that driver is configured.
 */
export function accountEmailChangeLive(environment: EnvironmentSource = process.env) {
  return accountSecurityLive(environment)
    && environmentValue("SETTERFI_ACCOUNT_EMAIL_CHANGE_LIVE", environment) === "true";
}

/**
 * The inbound pipeline read five offer_layers columns that were dropped in Phase 2, so a coach's
 * voice answers, proof and assets have never reached the engine. Repairing the read is correct,
 * but it changes what every agent says in production the moment it deploys — no coach has seen
 * their agent run with the offer layer actually loaded. This gate keeps that a deliberate switch
 * on a watched tenant rather than a side effect of a deploy, per the project's env-flag contract.
 */
export function offerLayerEngineInputLive(environment: EnvironmentSource = process.env) {
  return environmentValue("SETTERFI_OFFER_LAYER_ENGINE_INPUT_LIVE", environment) === "true";
}

export function tenantMembershipLive(environment: EnvironmentSource = process.env) {
  return environmentValue("SETTERFI_TENANT_MEMBERSHIP_LIVE", environment) === "true";
}

/**
 * Ownership transfer hands over the only role that can remove other members, so it is gated apart
 * from membership rather than riding on it: a workspace can safely invite teammates long before
 * anyone is willing to let the account change hands.
 */
export function tenantOwnershipLive(environment: EnvironmentSource = process.env) {
  return tenantMembershipLive(environment)
    && environmentValue("SETTERFI_TENANT_OWNERSHIP_LIVE", environment) === "true";
}

/**
 * Terms acceptance is recorded against a published version. Until the copy is approved there is no
 * version to accept, so the gate stays off and signup records nothing rather than a placeholder.
 */
export function accountTermsLive(environment: EnvironmentSource = process.env) {
  return environmentValue("SETTERFI_ACCOUNT_TERMS_LIVE", environment) === "true";
}

/**
 * Effective-dated tier terms change what a signup is quoted, so the catalogue keeps serving its
 * current shape until this is explicitly true.
 */
export function tierOfferTermsLive(environment: EnvironmentSource = process.env) {
  return environmentValue("SETTERFI_TIER_OFFER_TERMS_LIVE", environment) === "true";
}

export function driverSelection(
  driver: DriverName,
  selector: DriverSelectorName,
  environment: EnvironmentSource = process.env,
): DriverSelection {
  const value = environmentValue(selector, environment);
  if (value === "mock") {
    // Global selectors have no authoritative tenant context, so a production process can never
    // translate provider work into fake success. Tenant-scoped demo routing belongs in selectors
    // that receive an already-authorized `isDemo` decision.
    if (environment.NODE_ENV === "production") {
      throw new DriverConfigurationError(driver, [selector]);
    }
    return "mock";
  }
  if (value === "real") return "real";
  throw new DriverConfigurationError(driver, [selector]);
}

export function requireEnvironment(
  driver: DriverName,
  names: readonly EnvironmentName[],
  environment: EnvironmentSource = process.env,
) {
  const missing = names.filter((name) => !environmentValue(name, environment));
  if (missing.length > 0) throw new DriverConfigurationError(driver, missing);

  return Object.fromEntries(
    names.map((name) => [name, environmentValue(name, environment)!]),
  ) as Record<(typeof names)[number], string>;
}

/**
 * The public marketing page, and the only flag in this file that changes the *reachability* of a
 * route rather than the behaviour behind one.
 *
 * Off -- the default, and what every deployment does until someone decides otherwise -- `/` renders
 * the three-way role picker and the proxy gates it exactly as it does today. On, `/` renders the
 * marketing page and the proxy lets a signed-out browser have it, because a front door behind a
 * login is not a front door.
 *
 * It hangs off no phase gate. Every other flag here reads a phase flag first, because the
 * behaviour it releases depends on that phase's machinery being live; this page queries nothing,
 * reads no session and shows no tenant's data, so there is no phase whose absence would make it
 * unsafe -- only the decision to open the front door.
 */
export function publicLandingLive(environment: EnvironmentSource = process.env) {
  return environmentValue("SETTERFI_PUBLIC_LANDING_LIVE", environment) === "true";
}

export function realArmSkipReason(
  driver: DriverName,
  selector: DriverSelectorName,
  requiredNames: readonly EnvironmentName[],
  environment: EnvironmentSource = process.env,
) {
  if (environmentValue(selector, environment) !== "real") {
    return `${selector}=real is required`;
  }
  const missing = requiredNames.find((name) => !environmentValue(name, environment));
  return missing ? `${missing} is missing` : null;
}

/**
 * Supabase project agreement.
 *
 * The Supabase API keys are JWTs whose payload carries a `ref` claim naming the project they were
 * minted for. When that ref disagrees with the project in `NEXT_PUBLIC_SUPABASE_URL`, every call is
 * rejected by the API and the surfaces above it report the failure in their own vocabulary — /login
 * says "Check your email and password", which is a dishonest state for a configuration fault and
 * has already cost real debugging time.
 *
 * The likeliest source of the disagreement on a developer machine is a shell export: real process
 * environment variables win over `.env.local` in Next.js, so a `SUPABASE_*` line in a shell profile
 * silently replaces the project's own value for every server started from that shell.
 *
 * These functions never touch key material. Only the decoded `ref` claim and the variable name are
 * carried into a message, so an error, log line or snapshot can be pasted anywhere.
 */
const SUPABASE_PROJECT_KEY_NAMES = [
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const satisfies readonly EnvironmentName[];

export type SupabaseProjectRefMismatch = {
  readonly variableName: EnvironmentName;
  readonly keyProjectRef: string;
  readonly urlProjectRef: string;
};

export class SupabaseProjectRefMismatchError extends Error {
  readonly code = "SUPABASE_PROJECT_REF_MISMATCH";

  constructor(readonly mismatches: readonly SupabaseProjectRefMismatch[]) {
    super(
      `${mismatches
        .map(({ variableName, keyProjectRef, urlProjectRef }) =>
          `${variableName} is a key for Supabase project ${keyProjectRef}, but `
          + `NEXT_PUBLIC_SUPABASE_URL points at project ${urlProjectRef}`)
        .join("; ")}. `
      + "Supabase rejects every call made this way, and the surfaces above it report it as a "
      + "sign-in or permission failure rather than a configuration one. A shell export is the "
      + "likely source: a real environment variable beats .env.local in Next.js, so check the "
      + "shell profile for the name above before changing any .env file.",
    );
    this.name = "SupabaseProjectRefMismatchError";
  }
}

function decodeBase64Url(segment: string) {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/")
    .padEnd(segment.length + ((4 - (segment.length % 4)) % 4), "=");
  const binary = typeof atob === "function"
    ? atob(padded)
    : Buffer.from(padded, "base64").toString("binary");
  // The payload is UTF-8 JSON; ASCII covers every claim we read, and a decode failure here is
  // treated as "no ref", never as a mismatch.
  return decodeURIComponent(
    Array.from(binary, (character) =>
      `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""),
  );
}

/**
 * The project ref a Supabase API key was minted for, or null when none can be read.
 *
 * Null covers the new-style `sb_publishable_…` / `sb_secret_…` keys, which are opaque rather than
 * JWTs and carry no ref, as well as anything unparseable. An unreadable ref is not evidence of a
 * mismatch, so it is never reported as one.
 */
export function supabaseKeyProjectRef(key: string | undefined) {
  if (!key) return null;
  if (key.startsWith("sb_publishable_") || key.startsWith("sb_secret_")) return null;
  const segments = key.split(".");
  if (segments.length !== 3) return null;
  try {
    const payload: unknown = JSON.parse(decodeBase64Url(segments[1]));
    if (!payload || typeof payload !== "object") return null;
    const ref = (payload as { ref?: unknown }).ref;
    return typeof ref === "string" && ref.trim() ? ref.trim() : null;
  } catch {
    return null;
  }
}

/** The project ref in a Supabase project URL (`https://<ref>.supabase.co`), or null. */
export function supabaseUrlProjectRef(url: string | undefined) {
  if (!url) return null;
  try {
    const { hostname } = new URL(url);
    if (!hostname.endsWith(".supabase.co") && !hostname.endsWith(".supabase.in")) return null;
    const ref = hostname.split(".")[0];
    return ref ? ref : null;
  } catch {
    return null;
  }
}

/**
 * Every configured Supabase key whose project ref disagrees with the configured project URL.
 *
 * A missing URL, a missing key, a non-JWT key, or an unparseable one all yield no finding: the
 * check only reports a ref it actually read against a ref it actually read.
 */
export function supabaseProjectRefMismatches(
  environment: EnvironmentSource = process.env,
): readonly SupabaseProjectRefMismatch[] {
  const urlProjectRef = supabaseUrlProjectRef(
    environmentValue("NEXT_PUBLIC_SUPABASE_URL", environment),
  );
  if (!urlProjectRef) return [];

  return SUPABASE_PROJECT_KEY_NAMES.flatMap((variableName) => {
    const keyProjectRef = supabaseKeyProjectRef(environmentValue(variableName, environment));
    if (!keyProjectRef || keyProjectRef === urlProjectRef) return [];
    return [{ variableName, keyProjectRef, urlProjectRef }];
  });
}

/**
 * Throws when a configured Supabase key names a different project than the configured URL.
 *
 * This throws rather than returning a diagnostic somebody has to remember to read, and it throws in
 * every deployment mode. The project's honest-states rule is the reason: a mismatch means the API
 * rejects every request, so nothing downstream can work, and the alternative to a loud, specific
 * error is not a working app — it is a working-looking app that tells a coach their password is
 * wrong. There is also no legitimate configuration in which a key for one project belongs beside
 * another project's URL, so this cannot fire on a valid deployment; the only way to reach it is a
 * half-finished rotation or an inherited shell export, both of which want to stop the process.
 */
export function assertSupabaseProjectAgreement(environment: EnvironmentSource = process.env) {
  const mismatches = supabaseProjectRefMismatches(environment);
  if (mismatches.length > 0) throw new SupabaseProjectRefMismatchError(mismatches);
}
