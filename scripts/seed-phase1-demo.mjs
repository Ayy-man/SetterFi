/**
 * Deterministic Phase 1 demo seed.
 *
 * The local stack is the default authority. Hosted writes require an explicit flag and an existing
 * `is_demo=true` row, so this script cannot turn an arbitrary hosted tenant into test data.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { createClient } from "@supabase/supabase-js";

import { COACH_NAMES, DEMO_ONBOARDING_COPY, LEAD_NAMES, assertUniqueDisplayNames } from "./fixtures/names.mjs";
import { isShowcaseLeadId } from "./fixtures/showcase-leads-namespace.mjs";
import { DEMO_CONNECTED_CHANNELS, DEMO_CONNECTED_CHANNEL_NAMES } from "./fixtures/demo-channels.mjs";

export const LOCAL_API_URL = "http://127.0.0.1:54321";
export const DEMO_IDS = Object.freeze({
  tenant: "81000000-0000-4000-8000-000000000001",
  coach: "81000000-0000-4000-8000-000000000002",
  contact: "81000000-0000-4000-8000-000000000003",
  identity: "81000000-0000-4000-8000-000000000004",
  flow: "81000000-0000-4000-8000-000000000005",
  calendar: "81000000-0000-4000-8000-000000000006",
  brainFunding: "81000000-0000-4000-8000-000000000007",
  brainGuarantee: "81000000-0000-4000-8000-000000000008",
  objection: "81000000-0000-4000-8000-000000000009",
  duplicateContact: "81000000-0000-4000-8000-000000000010",
  mergedContact: "81000000-0000-4000-8000-000000000011",
  instagramGhlIdentity: "81000000-0000-4000-8000-000000000012",
  instagramMetaIdentity: "81000000-0000-4000-8000-000000000013",
  whatsappIdentity: "81000000-0000-4000-8000-000000000014",
  duplicatePhoneIdentity: "81000000-0000-4000-8000-000000000015",
  mergedIdentity: "81000000-0000-4000-8000-000000000016",
  openWindowConversation: "81000000-0000-4000-8000-000000000020",
  expiredWindowConversation: "81000000-0000-4000-8000-000000000021",
  runnerConversation: "81000000-0000-4000-8000-000000000022",
  instagramGhlConnection: "81000000-0000-4000-8000-000000000030",
  instagramMetaConnection: "81000000-0000-4000-8000-000000000031",
  whatsappMetaConnection: "81000000-0000-4000-8000-000000000032",
  smsGhlConnection: "81000000-0000-4000-8000-000000000033",
  duplicateCandidate: "81000000-0000-4000-8000-000000000040",
  templateDraft: "81000000-0000-4000-8000-000000000050",
  templateSubmitted: "81000000-0000-4000-8000-000000000051",
  templateApproved: "81000000-0000-4000-8000-000000000052",
  templateRejected: "81000000-0000-4000-8000-000000000053",
  templatePaused: "81000000-0000-4000-8000-000000000054",
  templateDisabled: "81000000-0000-4000-8000-000000000055",
  templatePermissionCandidate: "81000000-0000-4000-8000-000000000056",
  templateBookingCandidate: "81000000-0000-4000-8000-000000000057",
  templateReminderCandidate: "81000000-0000-4000-8000-000000000058",
  templateReengagementCandidate: "81000000-0000-4000-8000-000000000059",
  ghlInstall: "81000000-0000-4000-8000-000000000060",
  testRecipient: "81000000-0000-4000-8000-000000000061",
});

export const DEMO_VALUES = Object.freeze({
  slug: "setterfi-phase1-demo",
  locationId: "phase1-demo-location",
  calendarId: "phase1-demo-calendar",
  providerIdentityId: "phase1-demo-lead",
  instagramAccountId: "phase4-demo-instagram-account",
  whatsappPhoneId: "phase4-demo-whatsapp-phone",
  appointmentExternalId: "mock-demo-appointment-phase4-gate",
  ghlInitialEventId: "phase4-demo-ghl-event-initial",
  ghlInitialMessageId: "phase4-demo-ghl-message-initial",
  ghlHeldEventId: "phase4-demo-ghl-event-held",
  ghlHeldMessageId: "phase4-demo-ghl-message-held",
  ghlResumedEventId: "phase4-demo-ghl-event-resumed",
  ghlResumedMessageId: "phase4-demo-ghl-message-resumed",
  metaMessageId: "phase4-demo-meta-message-initial",
  billingEmail: "phase1-demo@example.invalid",
  coachPersonaName: "Marcus Whitfield",
});

/**
 * The GHL location every `ghl`-provider demo row binds to. Under the real driver the seeds point at
 * a live test location, so the install, the calendar and every contact identity have to resolve the
 * same value or `app.enforce_contact_identity_provider_account` rejects the identity write.
 */
export function resolveDemoGhlLocationId() {
  const locationId = process.env.SETTERFI_GHL_DRIVER === "real"
    ? process.env.SETTERFI_GHL_TEST_LOCATION_ID?.trim()
    : DEMO_VALUES.locationId;
  if (!locationId) throw new Error("REAL_GHL_TEST_RESOURCE_NAMES_REQUIRED");
  return locationId;
}

/**
 * `contact_identities` rows with `provider = 'ghl'` are bound to an install by
 * `contact_identities_provider_account_guard` (migration 20260905000010). The demo seeds write
 * their identities before any channel connection exists, so they bind explicitly rather than
 * relying on the trigger's connection lookup.
 */
export function demoGhlIdentityBinding() {
  return {
    provider_account_id: resolveDemoGhlLocationId(),
    ghl_install_id: DEMO_IDS.ghlInstall,
  };
}

/** Idempotent; must run before the first `ghl` identity upsert on the demo tenant. */
export async function ensureDemoGhlInstall(client) {
  await requireSuccess(
    "DEMO_GHL_INSTALL_UPSERT_FAILED",
    client.from("ghl_installs").upsert({
      id: DEMO_IDS.ghlInstall,
      tenant_id: DEMO_IDS.tenant,
      location_id: resolveDemoGhlLocationId(),
      company_id: "phase1-demo-company",
      token_expires_at: "2030-01-01T00:00:00.000Z",
      install_state: "installed",
      last_error: null,
    }, { onConflict: "id" }),
  );
}

const PHASE4_IDENTITY_IDS = [
  DEMO_IDS.identity,
  DEMO_IDS.instagramGhlIdentity,
  DEMO_IDS.instagramMetaIdentity,
  DEMO_IDS.whatsappIdentity,
  DEMO_IDS.duplicatePhoneIdentity,
  DEMO_IDS.mergedIdentity,
];

const PHASE4_CONNECTION_IDS = [
  DEMO_IDS.instagramGhlConnection,
  DEMO_IDS.instagramMetaConnection,
  DEMO_IDS.whatsappMetaConnection,
  DEMO_IDS.smsGhlConnection,
];

const PHASE4_TEMPLATE_IDS = [
  DEMO_IDS.templateDraft,
  DEMO_IDS.templateSubmitted,
  DEMO_IDS.templateApproved,
  DEMO_IDS.templateRejected,
  DEMO_IDS.templatePaused,
  DEMO_IDS.templateDisabled,
  DEMO_IDS.templatePermissionCandidate,
  DEMO_IDS.templateBookingCandidate,
  DEMO_IDS.templateReminderCandidate,
  DEMO_IDS.templateReengagementCandidate,
];

export const DEMO_PHASE4_IDS = Object.freeze({
  contacts: [DEMO_IDS.duplicateContact, DEMO_IDS.mergedContact],
  identities: PHASE4_IDENTITY_IDS,
  connections: PHASE4_CONNECTION_IDS,
  conversations: [DEMO_IDS.openWindowConversation, DEMO_IDS.expiredWindowConversation],
  templates: PHASE4_TEMPLATE_IDS,
  candidates: [DEMO_IDS.duplicateCandidate],
  testRecipients: [DEMO_IDS.testRecipient],
});

// Phase 3 demo rows are separate from the Phase 4 exact sets so both lifecycle baselines remain
// independently countable. Every value is synthetic and every child inherits the demo tenant's
// is_test marker through the database contract.
export const DEMO_PHASE3_IDS = Object.freeze({
  admin: "81000000-0000-4000-8000-000000000100",
  contacts: [
    "81000000-0000-4000-8000-000000000101",
    "81000000-0000-4000-8000-000000000102",
    "81000000-0000-4000-8000-000000000103",
    "81000000-0000-4000-8000-000000000104",
    "81000000-0000-4000-8000-000000000105",
    "81000000-0000-4000-8000-000000000106",
    "81000000-0000-4000-8000-000000000107",
    "81000000-0000-4000-8000-000000000108",
    "81000000-0000-4000-8000-000000000109",
    "81000000-0000-4000-8000-000000000110",
  ],
  deletedContact: "81000000-0000-4000-8000-000000000111",
  stopIdentity: "81000000-0000-4000-8000-000000000112",
  conversations: [
    "81000000-0000-4000-8000-000000000121",
    "81000000-0000-4000-8000-000000000122",
    "81000000-0000-4000-8000-000000000123",
    "81000000-0000-4000-8000-000000000124",
    "81000000-0000-4000-8000-000000000125",
    "81000000-0000-4000-8000-000000000126",
    "81000000-0000-4000-8000-000000000127",
    "81000000-0000-4000-8000-000000000128",
    "81000000-0000-4000-8000-000000000129",
  ],
  followups: [
    "81000000-0000-4000-8000-000000000151",
    "81000000-0000-4000-8000-000000000152",
  ],
  suppressions: [
    "81000000-0000-4000-8000-000000000161",
    "81000000-0000-4000-8000-000000000162",
  ],
  tombstone: "81000000-0000-4000-8000-000000000171",
  testRecipient: "81000000-0000-4000-8000-000000000181",
  messengerConnection: "81000000-0000-4000-8000-000000000191",
});

export const DEMO_PHASE3_VALUES = Object.freeze({
  stopProviderIdentityId: "phase3-demo-stop-lead",
  stopNormalizedPhone: "+15550003101",
  stopEventId: "phase3-demo-stop-event",
  stopMessageId: "phase3-demo-stop-message",
  deletionPreviewToken: "81000000-0000-4000-8000-000000000182",
});

const PIPELINE_STAGES = Object.freeze([
  "new_lead",
  "qualifying",
  "booked",
  "qualified_no_buy",
  "long_term_followup",
  "no_show",
  "disqualified",
]);

export const PHASE3_CONTACT_FIXTURES = Object.freeze([
  {
    name: LEAD_NAMES[3],
    channel: "sms",
    /* Opted out and suppressed: a hard disqualification, so the stage says so rather than new_lead. */
    pipelineStage: "disqualified",
    outcome: "HARD_DQ",
    dqReason: "The lead opted out by text message.",
    businessContext: "The lead opted out. Provider suppression is confirmed.",
  },
  {
    name: LEAD_NAMES[4],
    channel: "whatsapp",
    pipelineStage: "qualifying",
    outcome: "HARD_DQ",
    dqReason: "The lead opted out by text message.",
    businessContext: "The lead opted out. Provider confirmation is still pending.",
  },
  {
    name: LEAD_NAMES[5],
    channel: "instagram",
    pipelineStage: "booked",
    outcome: "BOOK",
    dqReason: null,
    businessContext: "Follow-up moved outside quiet hours.",
  },
  {
    name: LEAD_NAMES[6],
    channel: "messenger",
    /*
     * Never progressed, and not booked: this lead's thread ends with the agent refusing further
     * messaging until a consent basis exists, so a booking behind it would contradict the refusal
     * the same tenant's calendar and audit trail record.
     */
    pipelineStage: "new_lead",
    outcome: null,
    dqReason: null,
    businessContext: "Follow-up stopped because no consent basis was present.",
  },
  {
    name: LEAD_NAMES[7],
    channel: "sms",
    pipelineStage: "qualified_no_buy",
    outcome: null,
    dqReason: null,
    businessContext: "A legal-threat tripwire moved the conversation to a person.",
  },
  {
    name: LEAD_NAMES[8],
    channel: "instagram",
    pipelineStage: "qualified_no_buy",
    outcome: "HARD_DQ",
    dqReason: "Repeated out-of-scope requests ended the automated conversation.",
    businessContext: "Repeated out-of-scope requests ended the automated conversation.",
  },
  {
    name: LEAD_NAMES[9],
    channel: "whatsapp",
    pipelineStage: "long_term_followup",
    outcome: "SOFT_DQ",
    dqReason: "The initial cadence ended without a booking.",
    businessContext: "The initial cadence ended and the lead moved to long-term follow-up.",
  },
  {
    name: LEAD_NAMES[10],
    channel: "sms",
    pipelineStage: "long_term_followup",
    outcome: null,
    dqReason: null,
    businessContext: "The conversation closed after no reply.",
  },
  {
    name: LEAD_NAMES[11],
    channel: "messenger",
    pipelineStage: "no_show",
    outcome: "BOOK",
    dqReason: null,
    businessContext: "A new inbound message reopened the conversation.",
  },
  {
    name: LEAD_NAMES[12],
    channel: "instagram",
    pipelineStage: "disqualified",
    outcome: "HARD_DQ",
    dqReason: "A deletion request is awaiting review.",
    businessContext: "A deletion preview is ready for review.",
  },
]);

const FIXED_CONTACT_IDS = Object.freeze([
  DEMO_IDS.contact,
  DEMO_IDS.duplicateContact,
  DEMO_IDS.mergedContact,
  ...DEMO_PHASE3_IDS.contacts,
]);

function demoTemplate({ id, suffix, status, lifecycle = {} }) {
  const providerTemplateName = `SETTERFI_DEMO_PLACEHOLDER_${suffix}`;
  const body = `SETTERFI_DEMO_PLACEHOLDER_${suffix}_BODY`;
  return {
    id,
    tenant_id: DEMO_IDS.tenant,
    channel: "whatsapp",
    provider: "meta_direct",
    provider_template_id: status === "draft" ? null : `demo-${suffix.toLowerCase()}`,
    provider_template_name: providerTemplateName,
    name: providerTemplateName,
    category: "utility",
    locale: "en_US",
    body,
    body_hash: createHash("sha256").update(body).digest("hex"),
    variables: [],
    status,
    status_updated_at: "2026-08-17T00:00:00.000Z",
    is_demo: true,
    ...lifecycle,
  };
}

// The cadence purposes that send something. "none" is a switched-off touch and never reaches copy.
const DEMO_FOLLOWUP_PURPOSES = Object.freeze([
  "lead_magnet", "training", "value_nudge", "proof_point", "new_angle", "last_touch",
]);

/** A stable id for one demo follow-up template, so every re-run upserts the same row. */
function demoFollowupTemplateId(tenantId, channel, purpose) {
  const hex = createHash("sha256").update(`demo-followup-template:${tenantId}:${channel}:${purpose}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The follow-up copy the scheduler's gate reads (`message_templates.name = followup:<purpose>`,
 * matched on channel). Without these rows every due demo touch blocks on missing copy and the
 * simulated cadence never sends. They are approved demo placeholders: the body is a sentinel the
 * database ties to `is_demo`, and the send path persists `[approved template:<id>]` rather than
 * the sentinel, so no reader ever sees this text as lead-facing copy.
 */
export function demoFollowupTemplateRows(tenantId) {
  return DEMO_CONNECTED_CHANNELS.flatMap(({ channel, provider }) =>
    DEMO_FOLLOWUP_PURPOSES.map((purpose) => {
      const suffix = `FOLLOWUP_${purpose.toUpperCase()}`;
      const body = `SETTERFI_DEMO_PLACEHOLDER_${suffix}_BODY`;
      return {
        id: demoFollowupTemplateId(tenantId, channel, purpose),
        tenant_id: tenantId,
        channel,
        provider,
        provider_template_id: `demo-followup-${purpose}-${channel}`,
        provider_template_name: `SETTERFI_DEMO_PLACEHOLDER_${suffix}`,
        name: `followup:${purpose}`,
        category: "utility",
        locale: "en_US",
        body,
        body_hash: createHash("sha256").update(body).digest("hex"),
        variables: [],
        status: "approved",
        submitted_at: "2026-09-05T00:00:00.000Z",
        approved_at: "2026-09-05T00:00:00.000Z",
        status_updated_at: "2026-09-05T00:00:00.000Z",
        is_demo: true,
      };
    }));
}

/** Every demo tenant runs the cadence, so every demo tenant gets the same approved follow-up copy. */
async function seedDemoFollowupTemplates(client) {
  const tenants = await requireSuccess(
    "DEMO_FOLLOWUP_TEMPLATE_TENANTS_READ_FAILED",
    client.from("tenants").select("id").eq("is_demo", true).order("id"),
  );
  if (!tenants.some((row) => row.id === DEMO_IDS.tenant)) {
    throw new Error("DEMO_FOLLOWUP_TEMPLATE_TENANT_MISSING");
  }
  const rows = tenants.flatMap((row) => demoFollowupTemplateRows(row.id));
  await requireSuccess(
    "DEMO_FOLLOWUP_TEMPLATES_UPSERT_FAILED",
    client.from("message_templates").upsert(rows, { onConflict: "id" }),
  );
  const readback = await requireSuccess(
    "DEMO_FOLLOWUP_TEMPLATE_READBACK_FAILED",
    client.from("message_templates").select("id,status,is_demo,name")
      .in("id", rows.map((row) => row.id)),
  );
  if (
    readback.length !== rows.length
    || readback.some((row) => row.status !== "approved" || row.is_demo !== true
      || !row.name.startsWith("followup:"))
  ) {
    throw new Error("DEMO_FOLLOWUP_TEMPLATE_READBACK_INVALID");
  }
  return rows.length;
}

function publishedDemoOffer() {
  const payload = {
    programName: "Synthetic funding readiness",
    programDescription: "Synthetic published offer for the credential-independent demo.",
    creditMin: 640,
    fundingGoalMinCents: 5_000_000,
    fundingGoalMaxCents: 15_000_000,
    monthlyRevenueMinCents: null,
    products: ["biz line of credit"],
    creditRepair: "no_good_credit_only",
    bookingHorizonDays: 21,
    bookingMode: "direct",
    brandVoice: "professional",
    resultsTimelineMinDays: null,
    resultsTimelineMaxDays: null,
    refundPosture: "none",
    voiceStyleAnswer: "Use clear, direct language and ask one bounded question at a time.",
    voiceObjectionAnswer: "Acknowledge the concern and explain the next verified step.",
    voiceFollowupAnswer: "Restate the open question without adding an outcome claim.",
    prices: [{ label: "Synthetic review fee", amountCents: 10_000, billingPeriod: "one_time" }],
    proof: [{ title: "Synthetic workflow", detail: "Local test evidence for the bounded demo path." }],
    assets: [{
      slug: "synthetic-guide",
      label: "Synthetic guide",
      url: "https://example.invalid/synthetic-guide",
    }],
    cadencePurposes: [{
      channelClass: "durable",
      touchNo: 1,
      purpose: "value_nudge",
      assetId: null,
    }],
  };
  return {
    ...payload,
    contentHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  };
}

const PHASE4_TEMPLATE_ROWS = [
  demoTemplate({ id: DEMO_IDS.templateDraft, suffix: "LIFECYCLE_DRAFT", status: "draft" }),
  demoTemplate({
    id: DEMO_IDS.templateSubmitted,
    suffix: "LIFECYCLE_SUBMITTED",
    status: "submitted",
    lifecycle: { submitted_at: "2026-08-17T00:00:00.000Z" },
  }),
  demoTemplate({
    id: DEMO_IDS.templateApproved,
    suffix: "LIFECYCLE_APPROVED",
    status: "approved",
    lifecycle: {
      submitted_at: "2026-08-16T00:00:00.000Z",
      approved_at: "2026-08-17T00:00:00.000Z",
    },
  }),
  demoTemplate({
    id: DEMO_IDS.templateRejected,
    suffix: "LIFECYCLE_REJECTED",
    status: "rejected",
    lifecycle: {
      submitted_at: "2026-08-16T00:00:00.000Z",
      rejected_at: "2026-08-17T00:00:00.000Z",
      // The template name and body stay sentinels (`message_templates.ts` and the Phase 4 check
      // constraint both match them by prefix). The rejection detail is plain copy on screen.
      rejection_detail: DEMO_ONBOARDING_COPY.templateRejectionDetail,
    },
  }),
  demoTemplate({
    id: DEMO_IDS.templatePaused,
    suffix: "LIFECYCLE_PAUSED",
    status: "paused",
    lifecycle: {
      submitted_at: "2026-08-15T00:00:00.000Z",
      approved_at: "2026-08-16T00:00:00.000Z",
      paused_at: "2026-08-17T00:00:00.000Z",
    },
  }),
  demoTemplate({
    id: DEMO_IDS.templateDisabled,
    suffix: "LIFECYCLE_DISABLED",
    status: "disabled",
    lifecycle: {
      submitted_at: "2026-08-14T00:00:00.000Z",
      approved_at: "2026-08-15T00:00:00.000Z",
      disabled_at: "2026-08-17T00:00:00.000Z",
    },
  }),
  demoTemplate({
    id: DEMO_IDS.templatePermissionCandidate,
    suffix: "CANDIDATE_PERMISSION_TO_TEXT_COPY_REQUIRED",
    status: "draft",
  }),
  demoTemplate({
    id: DEMO_IDS.templateBookingCandidate,
    suffix: "CANDIDATE_BOOKING_CONFIRMATION_COPY_REQUIRED",
    status: "draft",
  }),
  demoTemplate({
    id: DEMO_IDS.templateReminderCandidate,
    suffix: "CANDIDATE_RESCHEDULE_REMINDER_COPY_REQUIRED",
    status: "draft",
  }),
  demoTemplate({
    id: DEMO_IDS.templateReengagementCandidate,
    suffix: "CANDIDATE_REENGAGEMENT_COPY_REQUIRED",
    status: "draft",
  }),
];

/**
 * The label names the model, not the role.
 *
 * Both labels used to be the role itself ("Generator", "Moderator"), so once the evals page put
 * the role in its own badge every arm read "Generator [Generator]" -- the same tautology, now
 * twice. The label is the one place the configured model is legible, so it says which model this
 * arm actually runs; `role` stays the badge and `openrouter_model` stays the truth it is named
 * after. Change the label whenever `openrouter_model` changes, or the card starts lying.
 */
const MODEL_ROWS = [
  {
    id: "10000000-0000-4000-8000-000000000001",
    label: "Opus 4.1 baseline (demo)",
    openrouter_model: "anthropic/claude-opus-4.1",
    params: {},
    is_default: true,
    active: true,
    role: "generator",
  },
  {
    id: "10000000-0000-4000-8000-000000000002",
    label: "GPT-5 moderator (demo)",
    openrouter_model: "openai/gpt-5",
    params: {},
    is_default: false,
    active: true,
    role: "moderator",
  },
];

const PROVISIONING_BASELINE = [
  { step_key: "account", state: "done" },
  { step_key: "ghl_location", state: "done" },
  { step_key: "calendar_connect", state: "done" },
  { step_key: "offer_layer", state: "done" },
  { step_key: "test_pass", state: "pending" },
  { step_key: "a2p_campaign", state: "awaiting_provider", awaiting_party: "carrier" },
  { step_key: "sms_live", state: "pending" },
  { step_key: "go_live", state: "pending" },
];

const DEMO_PROVISIONING_TRANSITION_AT = "2026-08-18T00:00:00.000Z";

function provisioningBaselineRow(row) {
  return {
    tenant_id: DEMO_IDS.tenant,
    ...row,
    next_attempt_at: DEMO_PROVISIONING_TRANSITION_AT,
    last_transition_at: DEMO_PROVISIONING_TRANSITION_AT,
    idempotency_key: `${DEMO_IDS.tenant}:${row.step_key}`,
    completed_at: row.state === "done" ? DEMO_PROVISIONING_TRANSITION_AT : null,
  };
}

function isLoopback(hostname) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function argumentValue(argumentsList, name) {
  const prefix = `${name}=`;
  return argumentsList.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function localStatus() {
  try {
    return JSON.parse(
      execFileSync("supabase", ["status", "-o", "json"], {
        cwd: process.cwd(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch {
    throw new Error("LOCAL_SUPABASE_UNAVAILABLE: start the shared stack with `supabase start`");
  }
}

export function resolveDemoTarget(argumentsList = process.argv.slice(2), environment = process.env) {
  const targetUrl = argumentValue(argumentsList, "--target")
    ?? environment.NEXT_PUBLIC_SUPABASE_URL?.trim()
    ?? LOCAL_API_URL;
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new Error("DEMO_TARGET_URL_INVALID");
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("DEMO_TARGET_URL_INVALID");
  const hosted = !isLoopback(parsed.hostname);
  if (hosted && !argumentsList.includes("--confirm-hosted")) {
    throw new Error(`HOSTED_DEMO_TARGET_REFUSED:${parsed.hostname}: pass --confirm-hosted`);
  }

  let serviceRoleKey;
  let databaseUrl;
  if (!hosted) {
    const status = localStatus();
    // Prefer the legacy service-role JWT because supabase-js accepts it as both the API key and
    // bearer token. New secret keys remain a fallback for local CLI versions that omit the JWT.
    serviceRoleKey = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
    databaseUrl = status.DB_URL;
  } else {
    serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY?.trim();
    const databasePassword = environment.SUPABASE_DB_PASSWORD?.trim();
    const projectRef = parsed.hostname.endsWith(".supabase.co")
      ? parsed.hostname.slice(0, -".supabase.co".length)
      : null;
    if (databasePassword && projectRef) {
      databaseUrl = `postgresql://postgres:${encodeURIComponent(databasePassword)}@db.${projectRef}.supabase.co:5432/postgres`;
    }
  }
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY_REQUIRED");
  return {
    url: parsed.toString().replace(/\/$/, ""),
    host: parsed.hostname,
    hosted,
    serviceRoleKey,
    databaseUrl,
  };
}

export function createDemoClient(target) {
  return createClient(target.url, target.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function announceTarget(target) {
  console.log(`Demo database target host: ${target.host}`);
}

async function requireSuccess(label, promise) {
  const result = await promise;
  if (result.error) throw new Error(`${label}:${result.error.message}`);
  return result.data;
}

async function normalizeAdditionalDemoContacts(client) {
  const contacts = await requireSuccess(
    "DEMO_ADDITIONAL_CONTACT_READ_FAILED",
    client.from("contacts").select("id").eq("tenant_id", DEMO_IDS.tenant).order("id"),
  );
  const fixedIds = new Set(FIXED_CONTACT_IDS);
  // Showcase-lead rows are skipped by id. They arrive named, staged and dated by
  // `seed-showcase-leads.mjs`, they number two hundred, and renaming them from the ten-name tail
  // below would both destroy the dataset and trip the capacity check on the next run.
  const additional = contacts.filter(
    (contact) => !fixedIds.has(contact.id) && !isShowcaseLeadId(contact.id),
  );
  const availableNames = LEAD_NAMES.slice(30);
  if (additional.length > availableNames.length) {
    throw new Error(`DEMO_CONTACT_NAME_CAPACITY_EXCEEDED:${additional.length}`);
  }
  /*
   * A lead's channel is taken from the identity it actually has, and only falls back to the cycle
   * when the row carries none. The cycle used to include `webchat`, which no connection, provider
   * or identity path in this product can produce, so those rows rendered "no channel saved" in the
   * coach's own contacts table. `fixtures/demo-channels.mjs` holds the four that exist.
   */
  const identities = await requireSuccess(
    "DEMO_ADDITIONAL_CONTACT_IDENTITY_READ_FAILED",
    client.from("contact_identities").select("contact_id, channel, created_at")
      .eq("tenant_id", DEMO_IDS.tenant).order("created_at"),
  );
  const identityChannel = new Map();
  for (const identity of identities) {
    if (!identityChannel.has(identity.contact_id)) {
      identityChannel.set(identity.contact_id, identity.channel);
    }
  }
  const channels = DEMO_CONNECTED_CHANNEL_NAMES;
  for (let index = 0; index < additional.length; index += 1) {
    await requireSuccess(
      "DEMO_ADDITIONAL_CONTACT_UPDATE_FAILED",
      client.from("contacts").update({
        name: availableNames[index],
        last_channel: identityChannel.get(additional[index].id)
          ?? channels[index % channels.length],
        pipeline_stage: PIPELINE_STAGES[index % PIPELINE_STAGES.length],
        stage_set_by: "system",
        outcome: null,
        dq_reason: null,
        business_context: "Demo review contact. This row is excluded from real analytics.",
      }).eq("id", additional[index].id).eq("tenant_id", DEMO_IDS.tenant),
    );
  }
  return additional.length;
}

async function assertPhase1ContactReviewData(client) {
  const contacts = await requireSuccess(
    "DEMO_CONTACT_REVIEW_READBACK_FAILED",
    client.from("contacts")
      .select("id,name,is_test,pipeline_stage,last_channel,outcome,merged_into_contact_id")
      .eq("tenant_id", DEMO_IDS.tenant).order("id"),
  );
  if (contacts.length < FIXED_CONTACT_IDS.length || contacts.some((contact) => contact.is_test !== true)) {
    throw new Error("DEMO_CONTACT_REVIEW_EXACT_SET_INVALID");
  }
  /*
   * The stage-distribution check at the bottom is about THIS fixture's own review contacts and is
   * calibrated to a book of about seventeen -- it fails the moment any one stage holds fifteen.
   * `seed-showcase-leads.mjs` adds two hundred more on the same tenant, so that check is measured
   * over the fixture's rows alone. The name checks stay tenant-wide on purpose: a duplicate
   * display name or a state-shaped name is a defect whoever wrote the row.
   */
  const fixtureContacts = contacts.filter((contact) => !isShowcaseLeadId(contact.id));
  assertUniqueDisplayNames(
    contacts.map((contact) => contact.name ?? ""),
    "DEMO_CONTACT_DISPLAY_NAMES_NOT_UNIQUE",
  );
  if (contacts.some((contact) => /^(demo|test|synthetic|setterfi)\b/i.test(contact.name ?? ""))) {
    throw new Error("DEMO_CONTACT_STATE_NAME_VISIBLE");
  }

  const visibleContacts = fixtureContacts.filter((contact) => contact.merged_into_contact_id === null);
  const stageCounts = Object.fromEntries(PIPELINE_STAGES.map((stage) => [stage, 0]));
  for (const contact of visibleContacts) stageCounts[contact.pipeline_stage] += 1;
  const counts = Object.values(stageCounts);
  if (counts.some((count) => count === 0) || counts.filter((count) => count >= 2).length < 5
    || Math.max(...counts) >= 15) {
    throw new Error(`DEMO_CONTACT_PIPELINE_DISTRIBUTION_INVALID:${JSON.stringify(stageCounts)}`);
  }
  return { contacts: contacts.length, stageCounts };
}

async function verifyHostedDemoTenant(client) {
  const data = await requireSuccess(
    "HOSTED_DEMO_TENANT_READ_FAILED",
    client.from("tenants").select("id, is_demo").eq("id", DEMO_IDS.tenant).maybeSingle(),
  );
  if (!data || data.is_demo !== true) throw new Error("HOSTED_TARGET_IS_NOT_EXISTING_DEMO_TENANT");
}

async function verifyAgentContent(client) {
  const data = await requireSuccess(
    "PLATFORM_AGENT_CONTENT_READ_FAILED",
    client.from("platform_settings").select("agent_content, approved").eq("singleton", true).single(),
  );
  const content = data?.agent_content;
  const replies = content?.heldReplies;
  const requiredReplies = ["NUM", "CLAIM", "ECHO", "LINK", "SCOPE", "LEN", "JUDGE", "REVOKE"];
  if (
    !content || typeof content !== "object" || !replies || typeof replies !== "object" ||
    typeof content.automatedExperienceDisclosure !== "string" ||
    requiredReplies.some((key) => typeof replies[key] !== "string")
  ) {
    throw new Error("PLATFORM_AGENT_CONTENT_SEED_REQUIRED");
  }
  if (data.approved === false) {
    const draftStrings = [content.automatedExperienceDisclosure, ...requiredReplies.map((key) => replies[key])];
    if (draftStrings.some((value) => !value.startsWith("[DRAFT]"))) {
      throw new Error("UNAPPROVED_PLATFORM_AGENT_CONTENT_MUST_BE_DRAFT");
    }
  }
  return { approved: data.approved };
}

async function ensurePublishedDemoOffer(client) {
  const published = await requireSuccess(
    "DEMO_PUBLISHED_OFFER_READ_FAILED",
    client.from("offer_layers").select("id").eq("tenant_id", DEMO_IDS.tenant)
      .eq("status", "published").maybeSingle(),
  );
  if (published) return published.id;

  const draft = await requireSuccess(
    "DEMO_OFFER_DRAFT_READ_FAILED",
    client.from("offer_layers").select("id, content_hash").eq("tenant_id", DEMO_IDS.tenant)
      .eq("status", "draft").maybeSingle(),
  );
  const payload = publishedDemoOffer();
  if (draft && draft.content_hash !== payload.contentHash) {
    throw new Error("DEMO_OFFER_DRAFT_CONFLICT");
  }
  const draftId = await requireSuccess(
    "DEMO_OFFER_DRAFT_SAVE_FAILED",
    client.rpc("save_offer_draft", {
      p_expected_tenant: DEMO_IDS.tenant,
      p_actor_id: DEMO_IDS.coach,
      p_draft_id: draft?.id ?? null,
      p_expected_content_hash: draft?.content_hash ?? null,
      p_offer: payload,
    }),
  );
  const rows = await requireSuccess(
    "DEMO_OFFER_PUBLISH_FAILED",
    client.rpc("publish_offer_draft", {
      p_expected_tenant: DEMO_IDS.tenant,
      p_actor_id: DEMO_IDS.coach,
      p_draft_id: draftId,
      p_expected_content_hash: payload.contentHash,
    }),
  );
  if (!rows?.[0]?.offer_id) throw new Error("DEMO_PUBLISHED_OFFER_READBACK_INVALID");
  return rows[0].offer_id;
}

async function ensureDemoAudit(client, input) {
  const existing = await requireSuccess(
    "PHASE3_DEMO_AUDIT_READ_FAILED",
    client.from("audit_log").select("id").eq("tenant_id", DEMO_IDS.tenant)
      .eq("action", input.action).eq("target_id", input.targetId)
      .contains("payload", { evidenceId: input.evidenceId }).limit(2),
  );
  if (existing.length > 1) throw new Error(`PHASE3_DEMO_AUDIT_AMBIGUOUS:${input.evidenceId}`);
  if (existing[0]?.id) return Number(existing[0].id);
  const inserted = await requireSuccess(
    "PHASE3_DEMO_AUDIT_INSERT_FAILED",
    client.from("audit_log").insert({
      actor_id: input.actorId,
      tenant_id: DEMO_IDS.tenant,
      action: input.action,
      target_type: input.targetType,
      target_id: input.targetId,
      reason: input.reason ?? null,
      payload: { evidenceId: input.evidenceId, ...input.payload },
    }).select("id").single(),
  );
  return Number(inserted.id);
}

async function seedPhase3Demo(client) {
  await requireSuccess(
    "PHASE3_DEMO_ADMIN_UPSERT_FAILED",
    client.from("users").upsert({
      id: DEMO_PHASE3_IDS.admin,
      email: "phase3-demo-admin@example.invalid",
      full_name: "Phase 3 demo admin",
      role: "admin",
      tenant_id: null,
    }, { onConflict: "id" }),
  );
  await requireSuccess(
    "PHASE3_DEMO_CONTACTS_UPSERT_FAILED",
    client.from("contacts").upsert(DEMO_PHASE3_IDS.contacts.map((id, index) => {
      const fixture = PHASE3_CONTACT_FIXTURES[index];
      return {
        id,
        tenant_id: DEMO_IDS.tenant,
        last_channel: fixture.channel,
        name: fixture.name,
        business_context: fixture.businessContext,
        outcome: fixture.outcome,
        dq_reason: fixture.dqReason,
        opted_out: index < 2,
        pipeline_stage: fixture.pipelineStage,
        stage_set_by: "system",
        timezone: "America/New_York",
        timezone_source: "provided",
        deletion_preview_token: index === 9 ? DEMO_PHASE3_VALUES.deletionPreviewToken : null,
        deletion_previewed_at: index === 9 ? "2026-08-17T10:00:00.000Z" : null,
        deletion_preview_actor_id: index === 9 ? DEMO_PHASE3_IDS.admin : null,
      };
    }), { onConflict: "id" }),
  );
  await requireSuccess(
    "PHASE3_DEMO_STOP_IDENTITY_UPSERT_FAILED",
    client.from("contact_identities").upsert({
      id: DEMO_PHASE3_IDS.stopIdentity,
      tenant_id: DEMO_IDS.tenant,
      contact_id: DEMO_PHASE3_IDS.contacts[0],
      provider: "ghl",
      channel: PHASE3_CONTACT_FIXTURES[0].channel,
      provider_identity_id: DEMO_PHASE3_VALUES.stopProviderIdentityId,
      normalized_phone: DEMO_PHASE3_VALUES.stopNormalizedPhone,
      consent_state: "conversation",
      consent_source: "inbound_message",
      consent_captured_at: "2026-08-17T10:00:00.000Z",
      consent_expires_at: "2099-08-17T10:00:00.000Z",
      consent_evidence: { kind: "synthetic_demo_inbound" },
      ...demoGhlIdentityBinding(),
    }, { onConflict: "id" }),
  );
  const conversationStates = [
    { status: "opted_out", status_reason: "stop_keyword" },
    { status: "opted_out", status_reason: "stop_keyword" },
    { status: "agent", status_reason: null },
    { status: "agent", status_reason: null },
    {
      status: "needs_human",
      status_reason: "tripwire_escalate",
      needs_human_at: "2026-08-17T10:00:00.000Z",
      tripwire_count: 1,
      tripwire_classes: ["legal_threat"],
    },
    { status: "scope_blocked", status_reason: "scope_exit_cap", scope_attack_count: 3 },
    { status: "nurture", status_reason: "cadence_exhausted" },
    { status: "closed", status_reason: "stale" },
    { status: "agent", status_reason: null, last_lead_inbound_at: "2026-08-17T11:00:00.000Z" },
  ];
  await requireSuccess(
    "PHASE3_DEMO_CONVERSATIONS_UPSERT_FAILED",
    client.from("conversations").upsert(DEMO_PHASE3_IDS.conversations.map((id, index) => ({
      id,
      tenant_id: DEMO_IDS.tenant,
      contact_id: DEMO_PHASE3_IDS.contacts[index],
      channel: PHASE3_CONTACT_FIXTURES[index].channel,
      disclosure_pending: false,
      last_message_at: "2026-08-17T12:00:00.000Z",
      scope_attack_count: 0,
      tripwire_count: 0,
      tripwire_classes: [],
      needs_human_at: null,
      last_lead_inbound_at: null,
      ...conversationStates[index],
    })), { onConflict: "id" }),
  );
  await requireSuccess(
    "PHASE3_DEMO_FOLLOWUPS_UPSERT_FAILED",
    client.from("followups").upsert([
      {
        id: DEMO_PHASE3_IDS.followups[0],
        tenant_id: DEMO_IDS.tenant,
        conversation_id: DEMO_PHASE3_IDS.conversations[2],
        touch_no: 1,
        purpose: "value_nudge",
        scheduled_at: "2099-08-18T12:00:00.000Z",
        original_scheduled_at: "2099-08-18T08:00:00.000Z",
        deferred_count: 1,
        canceled_reason: null,
        cadence_anchor_at: "2099-08-17T12:00:00.000Z",
        channel_class: "durable",
        status: "scheduled",
      },
      {
        id: DEMO_PHASE3_IDS.followups[1],
        tenant_id: DEMO_IDS.tenant,
        conversation_id: DEMO_PHASE3_IDS.conversations[3],
        touch_no: 1,
        purpose: "value_nudge",
        scheduled_at: "2026-08-17T12:00:00.000Z",
        original_scheduled_at: "2026-08-17T12:00:00.000Z",
        deferred_count: 0,
        cadence_anchor_at: "2026-08-17T10:00:00.000Z",
        channel_class: "durable",
        status: "canceled",
        canceled_reason: "no_consent",
      },
    ], { onConflict: "id" }),
  );

  const confirmedHash = createHash("sha256").update("phase3-demo-confirmed").digest("hex");
  const unconfirmedHash = createHash("sha256").update("phase3-demo-unconfirmed").digest("hex");
  await requireSuccess(
    "PHASE3_DEMO_SUPPRESSIONS_UPSERT_FAILED",
    client.from("suppression_entries").upsert([
      {
        id: DEMO_PHASE3_IDS.suppressions[0],
        tenant_id: DEMO_IDS.tenant,
        channel: "sms",
        identifier_hash: confirmedHash,
        identifier_last4: "3101",
        contact_id: DEMO_PHASE3_IDS.contacts[0],
        source: "stop_keyword",
        reason: "Synthetic STOP state",
        provider_sync_state: "confirmed",
        provider_synced_at: "2026-08-17T10:00:00.000Z",
        provider_sync_attempts: 1,
        provider_last_checked_at: "2026-08-17T10:00:00.000Z",
      },
      {
        id: DEMO_PHASE3_IDS.suppressions[1],
        tenant_id: DEMO_IDS.tenant,
        channel: "sms",
        identifier_hash: unconfirmedHash,
        identifier_last4: "3102",
        contact_id: DEMO_PHASE3_IDS.contacts[1],
        source: "stop_keyword",
        reason: "Synthetic STOP state",
        provider_sync_state: "pending",
        provider_sync_error: "SETTERFI_DEMO_PROVIDER_READBACK_PENDING",
        provider_sync_attempts: 1,
        provider_last_checked_at: "2026-08-17T10:00:00.000Z",
        provider_next_retry_at: "2099-08-18T10:05:00.000Z",
      },
    ], { onConflict: "id" }),
  );
  await requireSuccess(
    "PHASE3_DEMO_TEST_RECIPIENT_UPSERT_FAILED",
    client.from("tenant_test_recipients").upsert({
      id: DEMO_PHASE3_IDS.testRecipient,
      tenant_id: DEMO_IDS.tenant,
      channel: "sms",
      identifier_hash: createHash("sha256").update("phase3-demo-test-recipient").digest("hex"),
      identifier_last4: "3181",
      verified_at: "2026-08-17T10:00:00.000Z",
      verified_by: DEMO_PHASE3_IDS.admin,
    }, { onConflict: "id" }),
  );
  await requireSuccess(
    "PHASE3_DEMO_MESSENGER_CONNECTION_UPSERT_FAILED",
    client.from("channel_connections").upsert({
      id: DEMO_PHASE3_IDS.messengerConnection,
      tenant_id: DEMO_IDS.tenant,
      channel: "messenger",
      provider: "meta_direct",
      state: "ready",
      external_ref: { kind: "fixed_phase3_demo_connection", testOnly: true },
      external_account_id: DEMO_VALUES.instagramAccountId,
      external_account_label: "Demo Messenger account",
      oauth_completed_at: "2026-08-17T00:00:00.000Z",
      asset_verified_at: "2026-08-17T00:00:00.000Z",
      webhook_subscribed_at: "2026-08-17T00:00:00.000Z",
    }, { onConflict: "id" }),
  );

  await ensureDemoAudit(client, {
    action: "followup.deferred.quiet_hours",
    targetType: "conversation",
    targetId: DEMO_PHASE3_IDS.conversations[2],
    actorId: null,
    evidenceId: "phase3-demo-deferred",
    payload: { followupId: DEMO_PHASE3_IDS.followups[0], timezoneSource: "contact" },
  });
  await ensureDemoAudit(client, {
    action: "send.refused.no_consent",
    targetType: "conversation",
    targetId: DEMO_PHASE3_IDS.conversations[3],
    actorId: null,
    evidenceId: "phase3-demo-no-consent",
    payload: { purpose: "follow_up", reason: "no_consent_basis" },
  });
  await ensureDemoAudit(client, {
    action: "conversation.tripwire.refused",
    targetType: "conversation",
    targetId: DEMO_PHASE3_IDS.conversations[4],
    actorId: null,
    evidenceId: "phase3-demo-escalated",
    payload: { class: "legal_threat", severity: "escalate" },
  });
  await ensureDemoAudit(client, {
    action: "conversation.scope_blocked",
    targetType: "conversation",
    targetId: DEMO_PHASE3_IDS.conversations[5],
    actorId: null,
    evidenceId: "phase3-demo-scope-blocked",
    payload: { scopeAttackCount: 3 },
  });
  await ensureDemoAudit(client, {
    action: "contact.delete.preview",
    targetType: "contact",
    targetId: DEMO_PHASE3_IDS.contacts[9],
    actorId: DEMO_PHASE3_IDS.admin,
    evidenceId: "phase3-demo-deletion-preview",
    payload: { previewOnly: true, testOnly: true },
  });
  const deletionAuditId = await ensureDemoAudit(client, {
    action: "contact.delete",
    targetType: "contact",
    targetId: DEMO_PHASE3_IDS.deletedContact,
    actorId: DEMO_PHASE3_IDS.admin,
    reason: "Synthetic demo privacy request",
    evidenceId: "phase3-demo-deleted",
    payload: { provider_receipt: { driver: "mock", readAbsent: true }, tombstoneCount: 1 },
  });
  await requireSuccess(
    "PHASE3_DEMO_TOMBSTONE_UPSERT_FAILED",
    client.from("suppression_tombstones").upsert({
      id: DEMO_PHASE3_IDS.tombstone,
      tenant_id: DEMO_IDS.tenant,
      channel: "sms",
      identifier_hash: createHash("sha256").update("phase3-demo-deleted").digest("hex"),
      identifier_last4: "3171",
      deleted_at: "2026-08-17T10:00:00.000Z",
      deletion_audit_id: deletionAuditId,
    }, { onConflict: "id" }),
  );

  const reads = await Promise.all([
    requireSuccess("PHASE3_DEMO_CONTACT_READBACK_FAILED", client.from("contacts").select("id,is_test").in("id", DEMO_PHASE3_IDS.contacts)),
    requireSuccess("PHASE3_DEMO_IDENTITY_READBACK_FAILED", client.from("contact_identities").select("id,contact_id").eq("id", DEMO_PHASE3_IDS.stopIdentity).single()),
    requireSuccess("PHASE3_DEMO_CONVERSATION_READBACK_FAILED", client.from("conversations").select("id,status,status_reason,is_test").in("id", DEMO_PHASE3_IDS.conversations)),
    requireSuccess("PHASE3_DEMO_FOLLOWUP_READBACK_FAILED", client.from("followups").select("id,status,canceled_reason,is_test").in("id", DEMO_PHASE3_IDS.followups)),
    requireSuccess("PHASE3_DEMO_SUPPRESSION_READBACK_FAILED", client.from("suppression_entries").select("id,provider_sync_state").in("id", DEMO_PHASE3_IDS.suppressions)),
    requireSuccess("PHASE3_DEMO_TOMBSTONE_READBACK_FAILED", client.from("suppression_tombstones").select("id,deletion_audit_id").eq("id", DEMO_PHASE3_IDS.tombstone).single()),
  ]);
  const [contacts, identity, conversations, followups, suppressions, tombstone] = reads;
  if (
    contacts.length !== DEMO_PHASE3_IDS.contacts.length
    || contacts.some((row) => row.is_test !== true)
    || identity.contact_id !== DEMO_PHASE3_IDS.contacts[0]
    || conversations.length !== DEMO_PHASE3_IDS.conversations.length
    || conversations.some((row) => row.is_test !== true)
    || followups.length !== DEMO_PHASE3_IDS.followups.length
    || followups.some((row) => row.is_test !== true)
    || suppressions.map((row) => row.provider_sync_state).sort().join(",") !== "confirmed,pending"
    || tombstone.deletion_audit_id !== deletionAuditId
  ) throw new Error("PHASE3_DEMO_EXACT_READBACK_INVALID");
  return {
    contacts: contacts.length,
    conversations: conversations.length,
    followups: followups.length,
    suppressions: suppressions.length,
    tombstones: 1,
    testRecipients: 1,
  };
}

export async function seedPhase1Demo({ argumentsList = process.argv.slice(2), announce = true } = {}) {
  const target = resolveDemoTarget(argumentsList);
  const client = createDemoClient(target);
  if (target.hosted) await verifyHostedDemoTenant(client);
  if (announce) announceTarget(target);

  await requireSuccess(
    "DEMO_TENANT_UPSERT_FAILED",
    client.from("tenants").upsert({
      id: DEMO_IDS.tenant,
      slug: DEMO_VALUES.slug,
      name: COACH_NAMES[0],
      status: "active",
      ghl_location_id: DEMO_VALUES.locationId,
      is_demo: true,
      billing_contact_email: DEMO_VALUES.billingEmail,
      billing_contact_name: DEMO_VALUES.coachPersonaName,
    }, { onConflict: "id" }),
  );
  const tenant = await requireSuccess(
    "DEMO_TENANT_READBACK_FAILED",
    client.from("tenants").select("id, slug, is_demo").eq("id", DEMO_IDS.tenant).single(),
  );
  if (tenant.is_demo !== true || tenant.slug !== DEMO_VALUES.slug) {
    throw new Error("DEMO_TENANT_READBACK_INVALID");
  }

  const phase2Probe = await client.from("brain_import_batches").select("id").limit(1);
  const phase2Schema = !phase2Probe.error;
  if (phase2Probe.error && phase2Probe.error.code !== "42P01") {
    throw new Error(`PHASE2_SCHEMA_PROBE_FAILED:${phase2Probe.error.message}`);
  }

  await requireSuccess(
    "DEMO_USER_UPSERT_FAILED",
    client.from("users").upsert({
      id: DEMO_IDS.coach,
      email: DEMO_VALUES.billingEmail,
      full_name: DEMO_VALUES.coachPersonaName,
      role: "coach",
      tenant_id: DEMO_IDS.tenant,
    }, { onConflict: "id" }),
  );
  await requireSuccess(
    "DEMO_TENANT_SETTINGS_UPSERT_FAILED",
    client.from("tenant_settings").upsert({
      tenant_id: DEMO_IDS.tenant,
      timezone: "America/New_York",
      quiet_hours_start: "08:00",
      quiet_hours_end: "20:00",
      link_whitelist: ["example.invalid"],
      notification_prefs: {},
    }, { onConflict: "tenant_id" }),
  );
  if (phase2Schema) await ensurePublishedDemoOffer(client);
  if (!phase2Schema) {
    await requireSuccess(
      "DEMO_OFFER_UPSERT_FAILED",
      client.from("offer_layers").upsert({
        tenant_id: DEMO_IDS.tenant,
        program_name: "Demo funding readiness",
        credit_min: 640,
        credit_min_enforced: true,
        funding_goal_min_cents: 5_000_000,
        products: ["Business funding readiness"],
        pricing_gate: true,
        booking_horizon_days: 21,
        booking_mode: "direct",
        brand_voice: "professional",
        voice_answers: [],
        proof: [],
        assets: [],
        cadence: [],
        version: 1,
        published_at: new Date(0).toISOString(),
      }, { onConflict: "tenant_id" }),
    );
  }
  await requireSuccess(
    "DEMO_FLOW_UPSERT_FAILED",
    client.from("flow_configs").upsert({
      id: DEMO_IDS.flow,
      tenant_id: DEMO_IDS.tenant,
      questions: [
        { id: "credit", field: "credit_range", type: "enum" },
        { id: "goal", field: "funding_goal", type: "enum" },
        { id: "timeline", field: "timeline", type: "enum" },
      ],
      version: 1,
      status: "published",
      published_at: new Date(0).toISOString(),
    }, { onConflict: "id" }),
  );

  await requireSuccess(
    "DEMO_BRAIN_UPSERT_FAILED",
    client.from("brain_knowledge_entries").upsert([
      {
        id: DEMO_IDS.brainFunding,
        question: "How does funding readiness work?",
        answer: "Eligibility depends on the verified business and credit details collected in the conversation.",
        category: "qualification",
        match_keywords: ["funding", "eligibility", "readiness"],
        status: phase2Schema ? "draft" : "published",
        version: 1,
        published_at: phase2Schema ? null : new Date(0).toISOString(),
        ...(phase2Schema ? {
          source: "legacy_manual",
          disposition: "needs_rewrite",
          response_template: "Eligibility depends on the verified business and credit details collected in the conversation.",
        } : {}),
      },
      {
        id: DEMO_IDS.brainGuarantee,
        question: "Can approval be guaranteed?",
        answer: "Approval and outcomes cannot be guaranteed.",
        category: "compliance",
        match_keywords: ["guarantee", "approval"],
        status: phase2Schema ? "draft" : "published",
        version: 1,
        published_at: phase2Schema ? null : new Date(0).toISOString(),
        ...(phase2Schema ? {
          source: "legacy_manual",
          disposition: "needs_rewrite",
          response_template: "Approval and outcomes cannot be guaranteed.",
        } : {}),
      },
    ], { onConflict: "id" }),
  );
  await requireSuccess(
    "DEMO_OBJECTION_UPSERT_FAILED",
    client.from("brain_objections").upsert({
      id: DEMO_IDS.objection,
      label: "Needs more information",
      match_keywords: ["not sure", "more information"],
      response: "We can explain the process and collect only the details needed to assess fit.",
      category: "clarity",
      status: "published",
      version: 1,
      published_at: new Date(0).toISOString(),
    }, { onConflict: "id" }),
  );
  await requireSuccess(
    "DEMO_MODEL_CONFIG_UPSERT_FAILED",
    client.from("model_configs").upsert(MODEL_ROWS, { onConflict: "id" }),
  );

  // The install has to exist before any `ghl` identity is written: the identity guard binds each
  // one to a `ghl_installs` row on the same tenant and raises
  // `GHL_IDENTITY_ACCOUNT_BINDING_REQUIRED` when none matches.
  await ensureDemoGhlInstall(client);

  await requireSuccess(
    "DEMO_CONTACT_UPSERT_FAILED",
    client.from("contacts").upsert({
      id: DEMO_IDS.contact,
      tenant_id: DEMO_IDS.tenant,
      last_channel: "sms",
      name: LEAD_NAMES[0],
      business_context: "Exploring a working-capital plan for an established consulting business.",
      outcome: null,
      dq_reason: null,
      pipeline_stage: "new_lead",
      stage_set_by: "system",
    }, { onConflict: "id" }),
  );
  await requireSuccess(
    "DEMO_IDENTITY_UPSERT_FAILED",
    client.from("contact_identities").upsert({
      id: DEMO_IDS.identity,
      tenant_id: DEMO_IDS.tenant,
      contact_id: DEMO_IDS.contact,
      provider: "ghl",
      channel: "sms",
      provider_identity_id: DEMO_VALUES.providerIdentityId,
      consent_state: "conversation",
      consent_source: "inbound_message",
      consent_captured_at: new Date(0).toISOString(),
      consent_evidence: { kind: "fixed_demo_identity", testOnly: true },
      ...demoGhlIdentityBinding(),
    }, { onConflict: "id" }),
  );

  await requireSuccess(
    "PHASE4_DEMO_CONTACTS_UPSERT_FAILED",
    client.from("contacts").upsert([
      {
        id: DEMO_IDS.duplicateContact,
        tenant_id: DEMO_IDS.tenant,
        last_channel: "whatsapp",
        name: LEAD_NAMES[1],
        business_context: "Comparing funding options after an inbound text message.",
        outcome: null,
        dq_reason: null,
        pipeline_stage: "qualifying",
        stage_set_by: "system",
      },
      {
        id: DEMO_IDS.mergedContact,
        tenant_id: DEMO_IDS.tenant,
        last_channel: "messenger",
        name: LEAD_NAMES[2],
        business_context: "Prior profile retained as merge history.",
        outcome: null,
        dq_reason: null,
        pipeline_stage: "new_lead",
        stage_set_by: "system",
      },
    ], { onConflict: "id" }),
  );
  await requireSuccess(
    "PHASE4_DEMO_IDENTITIES_UPSERT_FAILED",
    client.from("contact_identities").upsert([
      {
        id: DEMO_IDS.instagramGhlIdentity,
        tenant_id: DEMO_IDS.tenant,
        contact_id: DEMO_IDS.contact,
        provider: "ghl",
        channel: "instagram",
        provider_identity_id: "phase4-demo-ghl-instagram-lead",
        consent_state: "conversation",
        consent_source: "inbound_message",
        consent_captured_at: "2026-08-17T00:00:00.000Z",
        consent_evidence: { kind: "fixed_demo_identity", testOnly: true },
        // The Instagram GHL connection carries its own placeholder account id, so the guard's
        // connection lookup would find no install for this channel. Bind to the tenant's install.
        ...demoGhlIdentityBinding(),
      },
      {
        id: DEMO_IDS.instagramMetaIdentity,
        tenant_id: DEMO_IDS.tenant,
        contact_id: DEMO_IDS.contact,
        provider: "meta_direct",
        channel: "instagram",
        provider_identity_id: "phase4-demo-meta-instagram-lead",
        consent_state: "conversation",
        consent_source: "inbound_message",
        consent_captured_at: "2026-08-17T00:00:00.000Z",
        consent_evidence: { kind: "fixed_demo_identity", testOnly: true },
        provider_window_expires_at: "2099-08-18T00:00:00.000Z",
      },
      {
        id: DEMO_IDS.whatsappIdentity,
        tenant_id: DEMO_IDS.tenant,
        contact_id: DEMO_IDS.contact,
        provider: "meta_direct",
        channel: "whatsapp",
        provider_identity_id: "phase4-demo-whatsapp-lead",
        normalized_phone: "+15550000001",
        consent_state: "opted_in",
        consent_source: "lead_confirmed_sms",
        consent_captured_at: "2026-08-17T00:00:00.000Z",
        consent_evidence: { kind: "fixed_demo_identity", testOnly: true },
        provider_window_expires_at: "2099-08-18T00:00:00.000Z",
      },
      {
        id: DEMO_IDS.duplicatePhoneIdentity,
        tenant_id: DEMO_IDS.tenant,
        contact_id: DEMO_IDS.duplicateContact,
        provider: "meta_direct",
        channel: "whatsapp",
        provider_identity_id: "phase4-demo-whatsapp-duplicate",
        normalized_phone: "+15550000001",
        consent_state: "none",
        consent_source: null,
        consent_evidence: { kind: "fixed_demo_duplicate_signal", testOnly: true },
        provider_window_expires_at: "2000-01-01T00:00:00.000Z",
      },
      {
        id: DEMO_IDS.mergedIdentity,
        tenant_id: DEMO_IDS.tenant,
        contact_id: DEMO_IDS.contact,
        provider: "meta_direct",
        channel: "messenger",
        provider_identity_id: "phase4-demo-merged-history",
        consent_state: "conversation",
        consent_source: "inbound_message",
        consent_captured_at: "2026-08-17T00:00:00.000Z",
        consent_evidence: { kind: "fixed_demo_merge_history", testOnly: true },
      },
    ], { onConflict: "id" }),
  );
  await requireSuccess(
    "PHASE4_DEMO_CONNECTIONS_UPSERT_FAILED",
    client.from("channel_connections").upsert([
      {
        id: DEMO_IDS.smsGhlConnection,
        tenant_id: DEMO_IDS.tenant,
        channel: "sms",
        provider: "ghl",
        state: "live",
        external_ref: { kind: "fixed_demo_connection", testOnly: true },
        external_account_id: DEMO_VALUES.locationId,
        external_account_label: "Demo SMS account",
      },
      {
        id: DEMO_IDS.instagramGhlConnection,
        tenant_id: DEMO_IDS.tenant,
        channel: "instagram",
        provider: "ghl",
        state: "live",
        external_ref: { kind: "fixed_demo_connection", testOnly: true },
        external_account_id: "phase4-demo-ghl-instagram-account",
        external_account_label: "Demo Instagram account",
      },
      {
        id: DEMO_IDS.instagramMetaConnection,
        tenant_id: DEMO_IDS.tenant,
        channel: "instagram",
        provider: "meta_direct",
        state: "ready",
        external_ref: { kind: "fixed_demo_connection", testOnly: true },
        external_account_id: DEMO_VALUES.instagramAccountId,
        external_account_label: "Demo Instagram account",
        oauth_completed_at: "2026-08-17T00:00:00.000Z",
        asset_verified_at: "2026-08-17T00:00:00.000Z",
        webhook_subscribed_at: "2026-08-17T00:00:00.000Z",
      },
      {
        id: DEMO_IDS.whatsappMetaConnection,
        tenant_id: DEMO_IDS.tenant,
        channel: "whatsapp",
        provider: "meta_direct",
        state: "ready",
        external_ref: { kind: "fixed_demo_connection", testOnly: true },
        external_account_id: DEMO_VALUES.whatsappPhoneId,
        external_account_label: "Demo WhatsApp number",
        oauth_completed_at: "2026-08-17T00:00:00.000Z",
        asset_verified_at: "2026-08-17T00:00:00.000Z",
        webhook_subscribed_at: "2026-08-17T00:00:00.000Z",
      },
    ], { onConflict: "id" }),
  );
  await requireSuccess(
    "PHASE4_DEMO_CONVERSATIONS_UPSERT_FAILED",
    client.from("conversations").upsert([
      {
        id: DEMO_IDS.openWindowConversation,
        tenant_id: DEMO_IDS.tenant,
        contact_id: DEMO_IDS.contact,
        channel: "instagram",
        status: "agent",
        disclosure_pending: false,
        provider_window_expires_at: "2099-08-18T00:00:00.000Z",
      },
      {
        id: DEMO_IDS.expiredWindowConversation,
        tenant_id: DEMO_IDS.tenant,
        contact_id: DEMO_IDS.duplicateContact,
        channel: "whatsapp",
        status: "agent",
        disclosure_pending: false,
        provider_window_expires_at: "2000-01-01T00:00:00.000Z",
      },
    ], { onConflict: "id" }),
  );
  await requireSuccess(
    "PHASE4_DEMO_CANDIDATE_UPSERT_FAILED",
    client.from("contact_duplicate_candidates").upsert({
      id: DEMO_IDS.duplicateCandidate,
      tenant_id: DEMO_IDS.tenant,
      contact_a_id: DEMO_IDS.contact,
      contact_b_id: DEMO_IDS.duplicateContact,
      source: "field_match",
      evidence_key: "phase4-demo-normalized-phone-match",
      evidence: { kind: "fixed_demo_candidate", testOnly: true },
      state: "open",
      resolved_at: null,
      resolved_by: null,
    }, { onConflict: "id" }),
  );
  await requireSuccess(
    "PHASE4_DEMO_TEMPLATES_UPSERT_FAILED",
    client.from("message_templates").upsert(PHASE4_TEMPLATE_ROWS, { onConflict: "id" }),
  );
  await seedDemoFollowupTemplates(client);

  const mergeContacts = await requireSuccess(
    "PHASE4_DEMO_MERGE_CONTACTS_READ_FAILED",
    client.from("contacts").select("*").in("id", [DEMO_IDS.contact, DEMO_IDS.mergedContact]),
  );
  const winnerSnapshot = mergeContacts.find((row) => row.id === DEMO_IDS.contact);
  const loserSnapshot = mergeContacts.find((row) => row.id === DEMO_IDS.mergedContact);
  if (!winnerSnapshot || !loserSnapshot) throw new Error("PHASE4_DEMO_MERGE_CONTACTS_MISSING");
  const existingMergeAudits = await requireSuccess(
    "PHASE4_DEMO_MERGE_AUDIT_READ_FAILED",
    client.from("audit_log").select("id")
      .eq("tenant_id", DEMO_IDS.tenant)
      .eq("action", "contact.merged")
      .eq("target_id", DEMO_IDS.contact)
      .contains("payload", { evidenceId: "phase4-demo-merge-history" })
      .limit(2),
  );
  if (existingMergeAudits.length > 1) throw new Error("PHASE4_DEMO_MERGE_AUDIT_AMBIGUOUS");
  const mergeAuditId = existingMergeAudits[0]?.id ?? (await requireSuccess(
    "PHASE4_DEMO_MERGE_AUDIT_INSERT_FAILED",
    client.from("audit_log").insert({
      actor_id: DEMO_IDS.coach,
      tenant_id: DEMO_IDS.tenant,
      action: "contact.merged",
      target_type: "contact",
      target_id: DEMO_IDS.contact,
      reason: "Synthetic demo merge history",
      payload: {
        source: "human_asserted",
        evidenceId: "phase4-demo-merge-history",
        prior: {
          winner: winnerSnapshot,
          loser: loserSnapshot,
          identities: [],
          conversations: [],
          candidates: [],
        },
        new: {
          winnerId: DEMO_IDS.contact,
          loserMergedInto: DEMO_IDS.contact,
          optedOut: false,
          outcome: null,
        },
      },
    }).select("id").single(),
  )).id;
  await requireSuccess(
    "PHASE4_DEMO_MERGED_CONTACT_UPDATE_FAILED",
    client.from("contacts").update({
      merged_into_contact_id: DEMO_IDS.contact,
      merged_at: "2026-08-17T00:00:00.000Z",
      merge_audit_id: mergeAuditId,
    }).eq("id", DEMO_IDS.mergedContact).eq("tenant_id", DEMO_IDS.tenant),
  );

  const calendarId = process.env.SETTERFI_GHL_DRIVER === "real"
    ? process.env.SETTERFI_GHL_TEST_CALENDAR_ID?.trim()
    : DEMO_VALUES.calendarId;
  const locationId = resolveDemoGhlLocationId();
  if (!calendarId) throw new Error("REAL_GHL_TEST_RESOURCE_NAMES_REQUIRED");
  await requireSuccess(
    "DEMO_CALENDAR_UPSERT_FAILED",
    client.from("calendar_connections").upsert({
      id: DEMO_IDS.calendar,
      tenant_id: DEMO_IDS.tenant,
      provider: "ghl",
      external_calendar_id: calendarId,
      external_location_id: locationId,
      calendar_name: "Phase 1 demo calendar",
      booking_url: "https://example.invalid/demo-calendar",
      timezone: "America/New_York",
      state: "ready",
      is_primary: true,
    }, { onConflict: "id" }),
  );
  // Written earlier in this run, ahead of the identities that bind to it; re-upserted here so the
  // row still reconciles if the calendar's location resolution ever diverges.
  await ensureDemoGhlInstall(client);
  await requireSuccess(
    "DEMO_PROVISIONING_UPSERT_FAILED",
    client.from("provisioning_steps").upsert(
      PROVISIONING_BASELINE.map(provisioningBaselineRow),
      { onConflict: "tenant_id,step_key" },
    ),
  );

  const content = await verifyAgentContent(client);
  const phase3 = await seedPhase3Demo(client);
  const additionalContacts = await normalizeAdditionalDemoContacts(client);
  const contactReview = await assertPhase1ContactReviewData(client);
  const child = await requireSuccess(
    "DEMO_CHILD_READBACK_FAILED",
    client.from("contacts").select("id, is_test").eq("id", DEMO_IDS.contact).single(),
  );
  if (child.is_test !== true) throw new Error("DEMO_CHILD_TEST_INHERITANCE_FAILED");

  const phase4Connections = await requireSuccess(
    "PHASE4_DEMO_CONNECTION_READBACK_FAILED",
    client.from("channel_connections").select("id, provider, channel, state, external_account_id")
      .in("id", PHASE4_CONNECTION_IDS).order("id"),
  );
  const phase4Identities = await requireSuccess(
    "PHASE4_DEMO_IDENTITY_READBACK_FAILED",
    client.from("contact_identities").select("id, contact_id, provider, channel")
      .in("id", PHASE4_IDENTITY_IDS).order("id"),
  );
  const phase4Conversations = await requireSuccess(
    "PHASE4_DEMO_WINDOW_READBACK_FAILED",
    client.from("conversations").select("id, provider_window_expires_at")
      .in("id", [DEMO_IDS.openWindowConversation, DEMO_IDS.expiredWindowConversation]).order("id"),
  );
  const phase4Templates = await requireSuccess(
    "PHASE4_DEMO_TEMPLATE_READBACK_FAILED",
    client.from("message_templates")
      .select("id, provider_template_name, body, status, is_demo, approved_at")
      .in("id", PHASE4_TEMPLATE_IDS).order("id"),
  );
  const phase4Candidate = await requireSuccess(
    "PHASE4_DEMO_CANDIDATE_READBACK_FAILED",
    client.from("contact_duplicate_candidates").select("id, state, source")
      .eq("id", DEMO_IDS.duplicateCandidate).single(),
  );
  const phase4Merged = await requireSuccess(
    "PHASE4_DEMO_MERGE_READBACK_FAILED",
    client.from("contacts").select("id, merged_into_contact_id, merge_audit_id")
      .eq("id", DEMO_IDS.mergedContact).single(),
  );
  const phase4Audit = await requireSuccess(
    "PHASE4_DEMO_AUDIT_READBACK_FAILED",
    client.from("audit_log").select("id, action, tenant_id, target_id, payload")
      .eq("id", mergeAuditId).single(),
  );
  const templateStates = phase4Templates.map((row) => row.status).sort();
  const expectedTemplateStates = [
    "approved",
    "disabled",
    "draft",
    "draft",
    "draft",
    "draft",
    "draft",
    "paused",
    "rejected",
    "submitted",
  ];
  const approvedTemplates = phase4Templates.filter((row) => row.status === "approved");
  if (
    phase4Connections.length !== PHASE4_CONNECTION_IDS.length
    || phase4Identities.length !== PHASE4_IDENTITY_IDS.length
    || phase4Conversations.length !== 2
    || phase4Templates.length !== PHASE4_TEMPLATE_IDS.length
    || JSON.stringify(templateStates) !== JSON.stringify(expectedTemplateStates)
    || approvedTemplates.length !== 1
    || approvedTemplates.some((row) =>
      row.is_demo !== true
      || !row.provider_template_name.startsWith("SETTERFI_DEMO_PLACEHOLDER_")
      || !row.body?.startsWith("SETTERFI_DEMO_PLACEHOLDER_")
      || !row.approved_at
    )
    || phase4Templates.some((row) =>
      !row.provider_template_name.startsWith("SETTERFI_DEMO_PLACEHOLDER_")
      || !row.body?.startsWith("SETTERFI_DEMO_PLACEHOLDER_")
      || row.is_demo !== true
    )
    || phase4Candidate.state !== "open"
    || phase4Candidate.source !== "field_match"
    || phase4Merged.merged_into_contact_id !== DEMO_IDS.contact
    || Number(phase4Merged.merge_audit_id) !== Number(mergeAuditId)
    || phase4Audit.action !== "contact.merged"
    || phase4Audit.tenant_id !== DEMO_IDS.tenant
    || phase4Audit.target_id !== DEMO_IDS.contact
    || phase4Audit.payload?.evidenceId !== "phase4-demo-merge-history"
  ) {
    throw new Error("PHASE4_DEMO_EXACT_READBACK_INVALID");
  }

  console.log(
    `Demo seed ready: tenant=${DEMO_VALUES.slug} is_demo=true child_is_test=true ` +
      `agent_content=${content.approved ? "APPROVED" : "DRAFT"} ` +
      `phase4_connections=${phase4Connections.length} phase4_identities=${phase4Identities.length} ` +
      `phase4_windows=${phase4Conversations.length} phase4_templates=${phase4Templates.length} ` +
      `phase4_candidates=1 phase4_merge_audits=1 ` +
      `phase3_contacts=${phase3.contacts} phase3_conversations=${phase3.conversations} ` +
      `phase3_followups=${phase3.followups} phase3_suppressions=${phase3.suppressions} ` +
      `phase3_tombstones=${phase3.tombstones} phase3_test_recipients=${phase3.testRecipients} ` +
      `review_contacts=${contactReview.contacts} renamed_additional_contacts=${additionalContacts} ` +
      `pipeline_stages=${JSON.stringify(contactReview.stageCounts)}`,
  );
  return {
    client,
    target,
    tenantId: DEMO_IDS.tenant,
    locationId,
    calendarId,
    phase4: {
      connections: phase4Connections.length,
      identities: phase4Identities.length,
      windows: phase4Conversations.length,
      templates: phase4Templates.length,
      candidates: 1,
      mergeAudits: 1,
    },
    phase3,
    contactReview,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedPhase1Demo().catch((error) => {
    console.error(error instanceof Error ? error.message : "DEMO_SEED_FAILED");
    process.exitCode = 1;
  });
}
