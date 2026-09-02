import { canAccessWorkspace, type UserRole } from "@/lib/auth/claims";
import {
  listContacts,
  type ContactCursor,
  type ContactRead,
} from "@/lib/repositories/contacts";
import {
  listConversations,
  type ConversationCursor,
  type ConversationRead,
} from "@/lib/repositories/conversations";
import {
  brainObjectionsLive,
  phase1Live,
  phase2Live,
  phase3Live,
  phase4Live,
  phase5Live,
  phase6AffiliatesLive,
  phase6Live,
  phase7AnalyticsLive,
  phase7EvalsLive,
  phase8ExportsLive,
  type EnvironmentSource,
} from "@/lib/env-contract";
import {
  loadCoachLeadComposition,
  loadCoachMeasurement,
  loadCoachTopObjections,
  type CoachMeasurement,
} from "@/lib/repositories/analytics";
import {
  COACH_COMPOSITION_COLUMNS,
  COACH_TOP_OBJECTION_COLUMNS,
  coachCompositionExportRows,
  coachMeasurementView,
  coachTopObjectionExportRows,
  coachPipelineView,
} from "@/components/workspace/live/measurement-view-models";
import {
  AFFILIATE_ACCOUNT_STATE_LABELS,
  type AffiliateAccountState,
} from "@/lib/billing/contracts";
import { createAffiliateRepository } from "@/lib/repositories/affiliates";
import { disclosureHostIsReachable } from "@/lib/onboarding/disclosure-url";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { loadRouteActor } from "@/lib/auth/actors";
import { loadCapabilityActor } from "@/lib/auth/actors";
import { loadEvalComparisonExport } from "@/lib/repositories/eval-comparisons";
import {
  loadPlatformMeasurement,
  type PlatformMeasurement,
} from "@/lib/repositories/platform-analytics";

export const runtime = "nodejs";
export const maxDuration = 300;

const PAGE_SIZE = 500;
const MAX_ROWS = 100_000;
const encoder = new TextEncoder();

export const BASE_TENANT_EXPORT_RESOURCES = [
  "conversations",
  "contacts",
] as const;
// Phase 7
export const PHASE7_TENANT_EXPORT_RESOURCES = [
  "coach-measurement-keywords",
  "coach-measurement-steps",
  "coach-pipeline",
] as const;
// The composition series is coach-scoped like the three above but reads no measurement
// window, so it sits outside PHASE7_TENANT_EXPORT_RESOURCES. That constant is what makes
// `window`/`from`/`to` legal query keys and what routes a request into a window-scoped read.
export const COACH_COMPOSITION_EXPORT_RESOURCES = [
  "coach-lead-composition",
] as const;
// Phase 10. The objection rollup is coach-scoped and window-independent like the composition, and
// it gets its own ownership array for the same reason that one does, plus one more: every member
// of PHASE2_EXPORT_RESOURCES needs a row in PHASE2_EXPORT_SPECS, and this resource has no table to
// name there. It reads a repository, not a Phase 2 table.
export const COACH_OBJECTION_EXPORT_RESOURCES = [
  "coach-top-objections",
] as const;
export const PHASE7_PLATFORM_EXPORT_RESOURCES = [
  "eval-comparisons",
  "eval-comparison-results",
  "platform-subscriptions",
  "platform-tenant-performance",
  "platform-guardrail-rules",
  "platform-followup-performance",
  "platform-provisioning-performance",
] as const;
export const PHASE7_ECONOMICS_EXPORT_RESOURCES = [
  "eval-comparisons",
  "eval-comparison-results",
  "platform-subscriptions",
  "platform-tenant-performance",
] as const;
export const PHASE7_OPERATIONAL_EXPORT_RESOURCES = [
  "platform-guardrail-rules",
  "platform-followup-performance",
  "platform-provisioning-performance",
] as const;
// Phase 8
export const PHASE8_EXPORT_RESOURCES = [
  "alert-rules",
  "audit-log",
  "coach-support-messages",
  "notification-deliveries",
  "notification-rules",
  "support-messages",
  "support-threads",
  "success-client-book",
] as const;
export const PHASE8_TENANT_EXPORT_RESOURCES = [
  "coach-support-messages",
] as const;
export const PHASE8_PLATFORM_EXPORT_RESOURCES = [
  "alert-rules",
  "audit-log",
  "notification-deliveries",
  "notification-rules",
  "support-messages",
  "support-threads",
  "success-client-book",
] as const;
export const PHASE7_REQUIRED_PLATFORM_EXPORT_ARMS = [
  "eval-comparisons",
  "eval-comparison-results",
  "platform-subscriptions",
  "platform-tenant-performance",
  "platform-guardrail-rules",
  "platform-followup-performance",
  "platform-provisioning-performance",
] as const;
export const PHASE7_EXPORT_EXCLUSION_VIEWS = [
  "analytics_tenants",
  "analytics_contacts",
  "analytics_conversations",
  "analytics_messages",
  "analytics_appointments",
  "analytics_billable_events",
  "analytics_conversation_step_events",
  "analytics_billing_subscriptions",
  "analytics_commission_ledger",
] as const;
export const TENANT_EXPORT_RESOURCES = [
  ...BASE_TENANT_EXPORT_RESOURCES,
  "keyword-goals",
  "offer-prices",
  "offer-proof",
  "offer-assets",
  // Phase 3
  "followups",
  // Phase 4
  "contact-identities",
  "suspected-duplicates",
  "message-templates",
  "channel-connections",
  "merge-history",
  // Phase 7
  ...PHASE7_TENANT_EXPORT_RESOURCES,
  ...COACH_COMPOSITION_EXPORT_RESOURCES,
  // Phase 8
  ...PHASE8_TENANT_EXPORT_RESOURCES,
  // Phase 10: audience, not ownership.
  ...COACH_OBJECTION_EXPORT_RESOURCES,
] as const;
export const PLATFORM_EXPORT_RESOURCES = [
  "brain-import-batches",
  "brain-import-items",
  "brain-knowledge-entries",
  "brain-objections",
  "brain-snapshots",
  "brain-snapshot-diffs",
  "eval-gate-results",
  // Phase 3
  "suppression-tombstones",
  // Phase 5
  "provisioning-steps",
  "signup-intents",
  "onboarding-runs",
  "business-profiles",
  "onboarding-optin-artifacts",
  "onboarding-content-screens",
  "a2p-probe-receipts",
  // Phase 7
  ...PHASE7_PLATFORM_EXPORT_RESOURCES,
  // Phase 8
  ...PHASE8_PLATFORM_EXPORT_RESOURCES,
] as const;
export const PHASE2_EXPORT_RESOURCES = [
  "keyword-goals",
  "offer-prices",
  "offer-proof",
  "offer-assets",
  "brain-import-batches",
  "brain-import-items",
  "brain-knowledge-entries",
  "brain-objections",
  "brain-snapshots",
  "brain-snapshot-diffs",
  "eval-gate-results",
] as const;
export const PHASE4_EXPORT_RESOURCES = [
  "contact-identities",
  "suspected-duplicates",
  "message-templates",
  "channel-connections",
  "merge-history",
] as const;
// Phase 3
export const PHASE3_EXPORT_RESOURCES = [
  "followups",
  "suppression-tombstones",
] as const;
// Phase 5
export const PHASE5_EXPORT_RESOURCES = [
  "provisioning-steps",
  "signup-intents",
  "onboarding-runs",
  "business-profiles",
  "onboarding-optin-artifacts",
  "onboarding-content-screens",
  "a2p-probe-receipts",
] as const;
// Phase 6
export const PHASE6_EXPORT_RESOURCES = [
  "billing-tiers",
  "platform-billing",
  "billing-corrections",
  "affiliate-payouts",
  "billing-cost-rollups",
  "affiliate-referrals",
] as const;
const PHASE6_OWNER_ADMIN_EXPORT_RESOURCES = [
  "billing-tiers",
  "platform-billing",
  "billing-corrections",
  "affiliate-payouts",
  "billing-cost-rollups",
] as const;
export const OWNER_ADMIN_EXPORT_RESOURCES = [
  ...PHASE6_OWNER_ADMIN_EXPORT_RESOURCES,
  // Phase 7
  ...PHASE7_ECONOMICS_EXPORT_RESOURCES,
] as const;
export const EXPORT_RESOURCES = [
  ...BASE_TENANT_EXPORT_RESOURCES,
  ...PHASE2_EXPORT_RESOURCES,
  // Phase 3
  ...PHASE3_EXPORT_RESOURCES,
  // Phase 4
  ...PHASE4_EXPORT_RESOURCES,
  // Phase 5
  ...PHASE5_EXPORT_RESOURCES,
  // Phase 6
  ...PHASE6_EXPORT_RESOURCES,
  // Phase 7
  ...PHASE7_TENANT_EXPORT_RESOURCES,
  ...COACH_COMPOSITION_EXPORT_RESOURCES,
  ...PHASE7_PLATFORM_EXPORT_RESOURCES,
  // Phase 8
  ...PHASE8_EXPORT_RESOURCES,
  // Phase 10
  ...COACH_OBJECTION_EXPORT_RESOURCES,
] as const;
export type ExportResource = (typeof EXPORT_RESOURCES)[number];
export type TenantExportResource = (typeof TENANT_EXPORT_RESOURCES)[number];
export type PlatformExportResource = (typeof PLATFORM_EXPORT_RESOURCES)[number];
type ExportFormat = "csv" | "json";
type ExportValue = string | number | boolean | null;
type ExportRow = Record<string, ExportValue>;

type ExportActor = {
  userId: string;
  tenantId: string | null;
  role: UserRole;
  /**
   * The `affiliates` row, as the hook stamps it. T15-13 (`docs/DECISIONS.md:277`) makes that row
   * the affiliate capability rather than `role = 'affiliate'`, and the affiliate export is the
   * one resource on this route whose authority is that capability. Absent for every other actor,
   * which is why it is optional rather than defaulted.
   */
  affiliateAccess?: boolean;
};

type ExportFilter = {
  search: string;
  channel?: string;
  outcome?: string;
  stage?: string;
  status?: string;
  order: "last_activity_desc" | "created_desc" | "version_desc" | "event_asc" | "updated_desc" | "at_desc";
  objection?: string;
  window?: "1d" | "1w" | "1m" | "3m" | "all" | "custom";
  from?: string;
  to?: string;
  scope?: "all" | "tenant" | "platform";
  category?: string;
  destination?: "all" | "bell" | "email" | "slack";
  book?: "mine" | "all";
  action?: string;
  assignee?: string;
  threadId?: string;
};

export type ExportCursor = {
  nextPage(): Promise<ExportRow[]>;
  close(): Promise<void>;
};

type ExportAuditMode = "tenant" | "platform" | "platform_tenant" | "affiliate";

type ExportDependencies = {
  enabled(resource: ExportResource): boolean;
  session(): Promise<ExportActor | null>;
  openCursor(input: {
    resource: ExportResource;
    actorId: string;
    tenantId: string | null;
    filter: ExportFilter;
    pageSize: number;
  }): Promise<ExportCursor>;
  start(input: {
    tenantId: string | null;
    actorId: string;
    resource: ExportResource;
    format: ExportFormat;
    filter: ExportFilter;
    columns: string[];
    reason: string | null;
    auditMode: ExportAuditMode;
    subjectTenantId: string | null;
  }): Promise<string>;
  finish(input: {
    tenantId: string | null;
    actorId: string;
    startedAuditId: string;
    resource: ExportResource;
    rowCount: number;
    byteCount: number;
    reason: string | null;
    auditMode: ExportAuditMode;
    subjectTenantId: string | null;
  }): Promise<void>;
};

export const RESOURCE_COLUMNS = {
  conversations: [
    "lead",
    "channel",
    "status",
    "lastMessage",
    "lastActivity",
    "demoData",
    "testData",
  ],
  contacts: [
    "name",
    "channels",
    "creditRange",
    "fundingGoal",
    "timeline",
    "decision",
    "pipelineStage",
    "lastActivity",
    "demoData",
    "testData",
  ],
  "keyword-goals": [
    "id", "keyword", "goal", "resourceUrl", "resourceMessage", "postBookingUrl",
    "postBookingMessage", "active", "createdAt", "updatedAt",
  ],
  "brain-import-batches": [
    "id", "source", "status", "receivedCount", "normalizedCount", "flaggedCount",
    "unchangedCount", "createdAt", "completedAt",
  ],
  "brain-import-items": [
    "id", "batchId", "sourceRef", "operation", "decision", "disposition", "flagCount", "decidedAt",
  ],
  "brain-knowledge-entries": [
    "id", "category", "source", "sourceRef", "disposition", "status", "question", "responseTemplate",
  ],
  // `pattern` is deliberately absent: it is the internal regex matcher, not a rendered column,
  // and exporting it would hand out the matching logic with the content.
  "brain-objections": [
    "id", "label", "category", "hardGate", "status", "matchKeywords", "response", "publishedAt",
  ],
  "brain-snapshots": [
    "id", "version", "contentHash", "sourceHash", "knowledgeMode", "platformTokens",
    "publishedAt", "rollbackOfSnapshotId",
  ],
  "brain-snapshot-diffs": [
    "version", "contentHash", "sourceHash", "knowledgeMode", "publishedAt", "rollbackOfSnapshotId",
  ],
  "eval-gate-results": [
    "id", "draftId", "contentHash", "kind", "corpusRevision", "suitesComplete", "createdAt",
  ],
  "offer-prices": ["id", "offerId", "label", "amountCents", "billingPeriod", "createdAt"],
  "offer-proof": ["id", "offerId", "title", "detail", "createdAt"],
  "offer-assets": ["id", "offerId", "slug", "label", "url", "createdAt"],
  // Phase 3
  followups: [
    "id", "conversationId", "contactId", "channel", "purpose", "touchNo", "status",
    "scheduledAt", "sentAt", "canceledReason", "pausedAt", "deferredCount", "attemptCount", "testData",
  ],
  "suppression-tombstones": [
    "id", "tenantId", "channel", "identifierLast4", "deletionAuditId", "createdAt",
  ],
  // Phase 4
  "contact-identities": [
    "id", "contactId", "channel", "address", "consentState", "windowExpiresAt", "createdAt",
    "dataLabel", "testData",
  ],
  "suspected-duplicates": [
    "id", "contactAId", "contactAName", "contactBId", "contactBName", "source",
    "evidenceKey", "state", "createdAt", "testBoundary", "dataLabel",
  ],
  "message-templates": [
    "id", "channel", "name", "category", "locale", "body", "status", "submittedAt",
    "approvedAt", "rejectedAt", "dataLabel",
  ],
  "channel-connections": [
    "id", "channel", "state", "accountLabel", "oauthCompletedAt", "assetVerifiedAt",
    "webhookSubscribedAt", "signedRoundTripAt", "updatedAt", "dataLabel",
  ],
  "merge-history": [
    "auditId", "action", "targetType", "targetId", "reason", "actorId", "createdAt",
  ],
  // Phase 5
  "provisioning-steps": [
    "id", "tenantId", "step", "state", "awaitingParty", "attempts", "startedAt",
    "lastAttemptAt", "completedAt", "errorCode", "errorMessage", "blockedReason",
    "nextAttemptAt", "lastTransitionAt", "createdAt", "updatedAt", "dataLabel",
  ],
  "signup-intents": [
    "id", "email", "tenantId", "tierId", "timezone", "state", "error", "createdAt", "updatedAt", "dataLabel",
  ],
  "onboarding-runs": [
    "id", "tenantId", "startedAt", "readinessMetAt", "wentLiveAt", "stalledFlaggedAt", "createdAt", "updatedAt", "dataLabel",
  ],
  "business-profiles": [
    "id", "tenantId", "legalName", "entityType", "hasEin", "websiteUrl", "addressLine1",
    "addressLine2", "city", "region", "postalCode", "countryCode", "createdAt", "updatedAt", "dataLabel",
  ],
  "onboarding-optin-artifacts": [
    "id", "tenantId", "version", "templateVersion", "marketingLanguageHash",
    "nonMarketingLanguageHash", "termsUrl", "privacyUrl", "privacyUrlReachable",
    "campaignDescriptionHash",
    "artifactHash", "placeholder", "isCurrent", "confirmedAt", "createdAt", "updatedAt", "dataLabel",
  ],
  "onboarding-content-screens": [
    "id", "tenantId", "inputHash", "result", "matchCount", "matchedPages", "isCurrent",
    "acknowledgedAt", "adminConfirmedAt", "createdAt", "updatedAt", "dataLabel",
  ],
  "a2p-probe-receipts": [
    "id", "tenantId", "result", "providerCode", "observedAt", "createdAt", "dataLabel",
  ],
  // Phase 6
  "billing-tiers": [
    "id", "name", "priceCents", "callAllowance", "fairUseCap", "fairUseNote", "active",
    "updatedAt",
  ],
  "platform-billing": [
    "tenantId", "businessName", "accountStatus", "subscriptionStatus", "providerUpdatedAt",
    "currentPeriodEnd", "cancelAtPeriodEnd", "pendingTierId", "pendingEffectiveAt", "dataLabel",
  ],
  "billing-corrections": [
    "requestId", "tenantId", "businessName", "billableEventId", "quantityDelta", "reason",
    "requestedAt", "requestAuditId", "decision", "decisionId", "decisionReason", "decisionAuditId",
    "offsetEventId", "dataLabel",
  ],
  "affiliate-payouts": [
    "ledgerId", "affiliateId", "affiliateName", "businessName", "commissionCents", "entryKind",
    "reversesLedgerId", "payoutId", "payoutTotalCents", "payoutState", "approvedEventId",
    "approvedAt", "approvedBy", "approvedAuditId", "sentEventId", "sentAuditId", "reference",
    "paidOn", "createdAt", "dataLabel",
  ],
  "billing-cost-rollups": [
    "rollupId", "tenantId", "businessName", "windowStart", "windowEnd", "revenueCents",
    "modelCostCents", "messagingCostCents", "embeddingCostCents", "complete", "missingSources",
    "sourceEvidenceAt", "dataLabel",
  ],
  /*
   * Three columns, and the count is the hard rule rather than a shape that happens to fit: an
   * affiliate sees the referred coach's name, that coach's status, and their own commission --
   * never that coach's performance. `AFFILIATE_REFERRAL_FIELDS` in `billing/contracts.ts` states
   * it and `affiliates.ts` rejects a fourth key by name.
   *
   * `commissionEarnedUsd`, not `commissionEarnedCents`. This is the only customer-facing export
   * in the set, and cents are a storage unit: the header named one and the cell carried a raw
   * integer, so an affiliate owed $894.00 opened their own CSV and read 89400. The column is
   * formatted at the cursor below, in the same pass that turns the status slug into the word the
   * screen shows -- one class of defect, an internal representation reaching a customer, so both
   * halves move together or the file is still half in storage units.
   */
  "affiliate-referrals": ["businessName", "accountStatus", "commissionEarnedUsd"],
  // Phase 7
  "coach-measurement-keywords": [
    "keyword", "conversations", "qualifiedContacts", "respondedConversations", "bookedContacts",
    "optInDenominator", "qualifiedDenominator", "bookedDenominator", "dataLabel",
  ],
  "coach-measurement-steps": [
    "stepKey", "stepLabel", "enteredContacts", "completedContacts", "askedContacts",
    "answeredContacts", "responseRate", "dataLabel",
  ],
  "coach-pipeline": [
    "contactId", "displayName", "stage", "attributedToAgent", "latestAppointmentStatus",
    "changedAt", "dataLabel",
  ],
  "coach-lead-composition": [...COACH_COMPOSITION_COLUMNS],
  "coach-top-objections": [...COACH_TOP_OBJECTION_COLUMNS],
  // Phase 7 platform
  "eval-comparisons": [
    "comparisonId", "status", "brainDraftVersionId", "contentHash", "brainVersion",
    "offerVersion", "rulesVersion", "knowledgeMode", "corpusRevision", "caseSetHash",
    "modelConfigAId", "modelConfigBId", "runAId", "runBId", "createdAt", "finishedAt",
  ],
  "eval-comparison-results": [
    "comparisonId", "arm", "suite", "passed", "total", "passRate", "falseBlocks",
    "negativeCases", "providerCostCredits", "costPerCaseCredits", "costPerThousandCredits",
    "latencyP50Ms", "latencyP95Ms", "state",
  ],
  "platform-subscriptions": [
    "dataOrigin", "tenantId", "subscriptionId", "status", "stripePriceId", "periodStart", "periodEnd",
  ],
  "platform-tenant-performance": [
    "dataOrigin", "tenantId", "bookedAppointments", "grossMrrCents", "commissionCents", "marginCents", "marginState",
  ],
  "platform-guardrail-rules": ["dataOrigin", "ruleKey", "label", "fires", "blocks", "holds"],
  "platform-followup-performance": ["dataOrigin", "touchNo", "sent", "replied", "crossChannel", "exhausted"],
  "platform-provisioning-performance": ["dataOrigin", "stepKey", "state", "attempts", "failures", "medianDaysToClear"],
  // Phase 8
  "alert-rules": [
    "event", "scope", "name", "category", "audience", "destinations", "required", "enabled",
  ],
  "audit-log": ["action", "actor", "target", "reason", "at", "testData"],
  "coach-support-messages": ["thread", "author", "createdAt", "testData"],
  "notification-deliveries": [
    "event", "destination", "state", "attempts", "lastAttemptAt", "deliveredAt", "testData",
  ],
  "notification-rules": ["event", "scope", "bell", "email", "slack", "required"],
  "support-messages": ["thread", "author", "internal", "createdAt", "testData"],
  "support-threads": ["subject", "client", "status", "assignee", "updatedAt", "testData"],
  "success-client-book": ["client", "status", "successOwner", "supportStatus", "updatedAt"],
} as const satisfies Record<ExportResource, readonly string[]>;

const CONVERSATION_STATUSES = [
  "agent",
  "needs_human",
  "human",
  "nurture",
  "closed",
  "scope_blocked",
  "opted_out",
] as const;
const CHANNELS = ["sms", "instagram", "messenger", "whatsapp", "webchat"] as const;
const CONTACT_STATUSES = ["total", "active", "booked", "qualified", "disqualified"] as const;
const OUTCOMES = ["all", "qualified", "dq"] as const;
const ALLOWED_QUERY_KEYS = new Set([
  "format",
  "tenantId",
  "search",
  "channel",
  "outcome",
  "stage",
  "status",
  "order",
  "columns",
  "reason",
  "window",
  "from",
  "to",
  "scope",
  "category",
  "destination",
  "book",
  "action",
  "assignee",
  "threadId",
  "objection",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function includesValue<T extends string>(values: readonly T[], value: string): value is T {
  return values.includes(value as T);
}

function parseResource(value: string): ExportResource | null {
  return includesValue(EXPORT_RESOURCES, value) ? value : null;
}

function isPlatformResource(resource: ExportResource) {
  return includesValue(PLATFORM_EXPORT_RESOURCES, resource)
    || includesValue(OWNER_ADMIN_EXPORT_RESOURCES, resource);
}

function isPhase2Resource(
  resource: ExportResource,
): resource is (typeof PHASE2_EXPORT_RESOURCES)[number] {
  return includesValue(PHASE2_EXPORT_RESOURCES, resource);
}

function isPhase4Resource(
  resource: ExportResource,
): resource is (typeof PHASE4_EXPORT_RESOURCES)[number] {
  return includesValue(PHASE4_EXPORT_RESOURCES, resource);
}

function isPhase3Resource(
  resource: ExportResource,
): resource is (typeof PHASE3_EXPORT_RESOURCES)[number] {
  return includesValue(PHASE3_EXPORT_RESOURCES, resource);
}

// Phase 5
function isPhase5Resource(
  resource: ExportResource,
): resource is (typeof PHASE5_EXPORT_RESOURCES)[number] {
  return includesValue(PHASE5_EXPORT_RESOURCES, resource);
}

// Phase 6
export function isPhase6Resource(
  resource: ExportResource,
): resource is (typeof PHASE6_EXPORT_RESOURCES)[number] {
  return includesValue(PHASE6_EXPORT_RESOURCES, resource);
}

// Phase 7
export function isPhase7TenantResource(
  resource: ExportResource,
): resource is (typeof PHASE7_TENANT_EXPORT_RESOURCES)[number] {
  return includesValue(PHASE7_TENANT_EXPORT_RESOURCES, resource);
}

export function isCoachTopObjectionsResource(
  resource: ExportResource,
): resource is (typeof COACH_OBJECTION_EXPORT_RESOURCES)[number] {
  return includesValue(COACH_OBJECTION_EXPORT_RESOURCES, resource);
}

export function isCoachCompositionResource(
  resource: ExportResource,
): resource is (typeof COACH_COMPOSITION_EXPORT_RESOURCES)[number] {
  return includesValue(COACH_COMPOSITION_EXPORT_RESOURCES, resource);
}

export function isPhase7PlatformResource(
  resource: ExportResource,
): resource is (typeof PHASE7_PLATFORM_EXPORT_RESOURCES)[number] {
  return includesValue(PHASE7_PLATFORM_EXPORT_RESOURCES, resource);
}

export function isPhase7EconomicsResource(
  resource: ExportResource,
): resource is (typeof PHASE7_ECONOMICS_EXPORT_RESOURCES)[number] {
  return includesValue(PHASE7_ECONOMICS_EXPORT_RESOURCES, resource);
}

// Phase 8
export function isPhase8Resource(
  resource: ExportResource,
): resource is (typeof PHASE8_EXPORT_RESOURCES)[number] {
  return includesValue(PHASE8_EXPORT_RESOURCES, resource);
}

function isPhase8TenantResource(
  resource: ExportResource,
): resource is (typeof PHASE8_TENANT_EXPORT_RESOURCES)[number] {
  return includesValue(PHASE8_TENANT_EXPORT_RESOURCES, resource);
}

function assertPhase7ExportArms() {
  const missingPlatform = PHASE7_REQUIRED_PLATFORM_EXPORT_ARMS.filter(
    (resource) => !includesValue(PHASE7_PLATFORM_EXPORT_RESOURCES, resource),
  );
  const missingCoach = [
    "coach-measurement-keywords",
    "coach-measurement-steps",
    "coach-pipeline",
  ].filter((resource) => !PHASE7_TENANT_EXPORT_RESOURCES.includes(resource as never));
  if (missingPlatform.length > 0 || missingCoach.length > 0) {
    throw new Error(`PHASE7_EXPORT_ARMS_MISSING:${[...missingPlatform, ...missingCoach].join(",")}`);
  }
}

assertPhase7ExportArms();

function isOwnerAdminResource(
  resource: ExportResource,
): resource is (typeof OWNER_ADMIN_EXPORT_RESOURCES)[number] {
  return includesValue(OWNER_ADMIN_EXPORT_RESOURCES, resource);
}

function defaultOrder(resource: ExportResource): ExportFilter["order"] {
  if (resource === "brain-snapshots" || resource === "brain-snapshot-diffs") return "version_desc";
  if (resource === "alert-rules" || resource === "notification-rules") return "event_asc";
  // The composition is a time series read forwards, so its natural order is the ascending one.
  if (isCoachCompositionResource(resource)) return "event_asc";
  if (isCoachTopObjectionsResource(resource)) return "created_desc";
  if (resource === "support-threads" || resource === "success-client-book") return "updated_desc";
  if (resource === "audit-log") return "at_desc";
  if (isPhase2Resource(resource) || isPhase3Resource(resource) || isPhase4Resource(resource)
    || isPhase5Resource(resource) || isPhase6Resource(resource) || isPhase7TenantResource(resource)
    || isPhase7PlatformResource(resource) || isPhase8Resource(resource)) return "created_desc";
  return "last_activity_desc";
}

function parseRequest(request: Request, resource: ExportResource) {
  const url = new URL(request.url);
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_QUERY_KEYS.has(key)) throw new Error(`EXPORT_QUERY_NOT_ALLOWED:${key}`);
  }

  const requestedFormat = url.searchParams.get("format") ?? "csv";
  if (requestedFormat !== "csv" && requestedFormat !== "json") throw new Error("EXPORT_FORMAT_INVALID");
  const format: ExportFormat = requestedFormat;
  const search = (url.searchParams.get("search") ?? "").trim();
  if (search.length > 200) throw new Error("EXPORT_SEARCH_TOO_LONG");
  const phase7TenantResource = isPhase7TenantResource(resource);
  const measurementQueryKeys = ["window", "from", "to"] as const;
  if (!phase7TenantResource && measurementQueryKeys.some((key) => url.searchParams.has(key))) {
    throw new Error("EXPORT_MEASUREMENT_WINDOW_NOT_SUPPORTED");
  }
  // `objection` narrows one resource and one only. Every other resource fails closed here rather
  // than ignoring a parameter the caller believed was applied.
  if (resource !== "conversations" && url.searchParams.has("objection")) {
    throw new Error("EXPORT_FILTER_NOT_SUPPORTED");
  }
  const resourceDefaultOrder = defaultOrder(resource);
  const order = url.searchParams.get("order") ?? resourceDefaultOrder;
  if (order !== resourceDefaultOrder) throw new Error("EXPORT_ORDER_INVALID");

  const filter: ExportFilter = { search, order };
  if (phase7TenantResource) {
    if (["search", "channel", "outcome", "stage", "status", "order"].some((key) => url.searchParams.has(key))) {
      throw new Error("EXPORT_FILTER_NOT_SUPPORTED");
    }
    const window = url.searchParams.get("window") ?? "1m";
    if (!["1d", "1w", "1m", "3m", "all", "custom"].includes(window)) {
      throw new Error("EXPORT_MEASUREMENT_WINDOW_INVALID");
    }
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const validDate = (value: string | null) => {
      if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
      const parsed = new Date(`${value}T00:00:00.000Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    };
    if (window === "custom") {
      if (!validDate(from) || !validDate(to) || from! > to!) {
        throw new Error("EXPORT_MEASUREMENT_CUSTOM_WINDOW_INVALID");
      }
      filter.from = from!;
      filter.to = to!;
    } else if (from !== null || to !== null) {
      throw new Error("EXPORT_MEASUREMENT_CUSTOM_WINDOW_NOT_SUPPORTED");
    }
    filter.window = window as NonNullable<ExportFilter["window"]>;
  } else if (resource === "conversations") {
    const channel = url.searchParams.get("channel") ?? "all";
    const outcome = url.searchParams.get("outcome") ?? "all";
    const stage = url.searchParams.get("stage") ?? "all";
    if (channel !== "all" && !includesValue(CHANNELS, channel)) {
      throw new Error("EXPORT_CHANNEL_INVALID");
    }
    if (!includesValue(OUTCOMES, outcome)) throw new Error("EXPORT_OUTCOME_INVALID");
    if (stage !== "all" && !includesValue(CONVERSATION_STATUSES, stage)) {
      throw new Error("EXPORT_STAGE_INVALID");
    }
    filter.channel = channel;
    filter.outcome = outcome;
    filter.stage = stage;
    const objection = (url.searchParams.get("objection") ?? "").trim();
    if (objection && !UUID.test(objection)) throw new Error("EXPORT_OBJECTION_INVALID");
    if (objection) filter.objection = objection;
  } else if (resource === "contacts") {
    const status = url.searchParams.get("status") ?? "total";
    if (!includesValue(CONTACT_STATUSES, status)) throw new Error("EXPORT_STATUS_INVALID");
    filter.status = status;
  } else if (resource === "followups") {
    const status = url.searchParams.get("status") ?? "all";
    if (!["all", "scheduled", "sent", "canceled"].includes(status)) {
      throw new Error("EXPORT_STATUS_INVALID");
    }
    filter.status = status;
  } else if (resource === "suppression-tombstones") {
    if (url.searchParams.has("status") || url.searchParams.has("channel")) {
      throw new Error("EXPORT_FILTER_NOT_SUPPORTED");
    }
  } else if (resource === "contact-identities") {
    const channel = url.searchParams.get("channel") ?? "all";
    const status = url.searchParams.get("status") ?? "all";
    if (channel !== "all" && !includesValue(CHANNELS, channel)) {
      throw new Error("EXPORT_CHANNEL_INVALID");
    }
    if (!["all", "none", "reply_only", "conversation", "opted_in", "unverified", "suppressed"].includes(status)) {
      throw new Error("EXPORT_STATUS_INVALID");
    }
    filter.channel = channel;
    filter.status = status;
  } else if (resource === "suspected-duplicates") {
    const status = url.searchParams.get("status") ?? "all";
    if (!["all", "open", "merged", "dismissed"].includes(status)) {
      throw new Error("EXPORT_STATUS_INVALID");
    }
    if (url.searchParams.has("channel")) throw new Error("EXPORT_CHANNEL_NOT_SUPPORTED");
    filter.status = status;
  } else if (resource === "message-templates") {
    const channel = url.searchParams.get("channel") ?? "all";
    const status = url.searchParams.get("status") ?? "all";
    if (channel !== "all" && !includesValue(CHANNELS, channel)) {
      throw new Error("EXPORT_CHANNEL_INVALID");
    }
    if (!["all", "draft", "submitted", "approved", "rejected", "paused", "disabled"].includes(status)) {
      throw new Error("EXPORT_STATUS_INVALID");
    }
    filter.channel = channel;
    filter.status = status;
  } else if (resource === "channel-connections") {
    const channel = url.searchParams.get("channel") ?? "all";
    const status = url.searchParams.get("status") ?? "all";
    if (channel !== "all" && !includesValue(CHANNELS, channel)) {
      throw new Error("EXPORT_CHANNEL_INVALID");
    }
    if (!["all", "disconnected", "connecting", "pending_review", "ready", "live", "error", "expired", "blocked_permanent", "flagged", "restricted"].includes(status)) {
      throw new Error("EXPORT_STATUS_INVALID");
    }
    filter.channel = channel;
    filter.status = status;
  } else if (resource === "merge-history") {
    if (url.searchParams.has("channel") || url.searchParams.has("status")) {
      throw new Error("EXPORT_FILTER_NOT_SUPPORTED");
    }
  } else if (isPhase8Resource(resource)) {
    const scope = url.searchParams.get("scope") ?? "all";
    const destination = url.searchParams.get("destination") ?? "all";
    const book = url.searchParams.get("book") ?? "all";
    const status = url.searchParams.get("status") ?? "all";
    const category = url.searchParams.get("category")?.trim() ?? "";
    const action = url.searchParams.get("action")?.trim() ?? "";
    const assignee = url.searchParams.get("assignee")?.trim() ?? "";
    const threadId = url.searchParams.get("threadId")?.trim() ?? "";
    if (!["all", "tenant", "platform"].includes(scope)) throw new Error("EXPORT_SCOPE_INVALID");
    if (!["all", "bell", "email", "slack"].includes(destination)) {
      throw new Error("EXPORT_DESTINATION_INVALID");
    }
    if (!["mine", "all"].includes(book)) throw new Error("EXPORT_BOOK_INVALID");
    if (category.length > 100 || action.length > 150 || assignee.length > 100 || threadId.length > 100) {
      throw new Error("EXPORT_FILTER_INVALID");
    }
    const allowedByResource: Record<(typeof PHASE8_EXPORT_RESOURCES)[number], readonly string[]> = {
      "alert-rules": ["scope", "category", "status"],
      "audit-log": ["search", "action"],
      "coach-support-messages": ["search", "threadId"],
      "notification-deliveries": ["destination", "status"],
      "notification-rules": ["scope", "category"],
      "support-messages": ["search", "threadId"],
      "support-threads": ["search", "status", "book", "assignee"],
      "success-client-book": ["search", "status", "book", "assignee"],
    };
    const phase8FilterKeys = [
      "search", "channel", "outcome", "stage", "status", "window", "from", "to",
      "scope", "category", "destination", "book", "action", "assignee", "threadId",
    ];
    const allowed = allowedByResource[resource];
    if (phase8FilterKeys.some((key) => url.searchParams.has(key) && !allowed.includes(key))) {
      throw new Error("EXPORT_FILTER_NOT_SUPPORTED");
    }
    const statusValues = resource === "alert-rules"
      ? ["all", "enabled", "disabled"]
      : resource === "notification-deliveries"
        ? ["all", "pending", "sending", "accepted", "delivered", "failed", "unavailable"]
        : resource === "support-threads"
          ? ["all", "open", "waiting_on_coach", "resolved"]
          : resource === "success-client-book"
            ? ["all", "onboarding", "active", "paused", "overdue", "suspended", "churned"]
            : ["all"];
    if (url.searchParams.has("status") && !statusValues.includes(status)) {
      throw new Error("EXPORT_STATUS_INVALID");
    }
    if (url.searchParams.has("scope")) filter.scope = scope as NonNullable<ExportFilter["scope"]>;
    if (url.searchParams.has("destination")) {
      filter.destination = destination as NonNullable<ExportFilter["destination"]>;
    }
    if (url.searchParams.has("book")) filter.book = book as NonNullable<ExportFilter["book"]>;
    if (url.searchParams.has("status")) filter.status = status;
    if (category) filter.category = category;
    if (action) filter.action = action;
    if (assignee) filter.assignee = assignee;
    if (threadId) filter.threadId = threadId;
  } else if (isPhase5Resource(resource) || isPhase6Resource(resource) || isPhase7PlatformResource(resource)) {
    if (search || ["channel", "outcome", "stage", "status"].some((key) => url.searchParams.has(key))) {
      throw new Error("EXPORT_FILTER_NOT_SUPPORTED");
    }
  } else if (resource === "brain-import-batches") {
    const status = url.searchParams.get("status") ?? "all";
    if (!["all", "open", "applied", "discarded", "failed"].includes(status)) {
      throw new Error("EXPORT_STATUS_INVALID");
    }
    filter.status = status;
  } else if (resource === "brain-import-items") {
    const status = url.searchParams.get("status") ?? "all";
    if (!["all", "pending", "accepted", "rejected"].includes(status)) {
      throw new Error("EXPORT_STATUS_INVALID");
    }
    filter.status = status;
  } else if (resource === "brain-knowledge-entries") {
    const status = url.searchParams.get("status") ?? "all";
    if (!["all", "draft", "published", "archived"].includes(status)) {
      throw new Error("EXPORT_STATUS_INVALID");
    }
    filter.status = status;
  } else if (resource === "brain-objections") {
    // The Phase 2 publish_status enum is draft | published | superseded. The knowledge branch
    // above still names `archived`, which this enum dropped. Do not copy it here.
    const status = url.searchParams.get("status") ?? "all";
    if (!["all", "draft", "published", "superseded"].includes(status)) {
      throw new Error("EXPORT_STATUS_INVALID");
    }
    filter.status = status;
  } else if (url.searchParams.has("status")) {
    throw new Error("EXPORT_STATUS_NOT_SUPPORTED");
  }

  const allowedColumns = RESOURCE_COLUMNS[resource];
  const requestedColumns = (url.searchParams.get("columns") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  let columns = requestedColumns.length ? requestedColumns : [...allowedColumns];
  if (new Set(columns).size !== columns.length || columns.some((column) => !includesValue(allowedColumns, column))) {
    throw new Error("EXPORT_COLUMNS_INVALID");
  }
  // A platform review preview must never leave the platform as an unlabeled CSV/JSON file. The
  // live cursor supplies this field for both sources, and this append keeps it mandatory even
  // when a screen's legacy export query names only its business columns.
  if (isPhase7PlatformResource(resource) && !isEvalComparisonResource(resource) && !columns.includes("dataOrigin")) {
    columns = ["dataOrigin", ...columns];
  }

  return {
    format,
    filter,
    columns,
    requestedTenantId: url.searchParams.get("tenantId"),
    reason: url.searchParams.get("reason")?.trim() || null,
  };
}

function spreadsheetSafeValue(value: ExportValue) {
  const serialized = value === null ? "" : String(value);
  return /^\s*[=+\-@]/.test(serialized) || /^[\t\r\n]/.test(serialized)
    ? `'${serialized}`
    : serialized;
}

function csvCell(value: ExportValue) {
  return `"${spreadsheetSafeValue(value).replaceAll('"', '""')}"`;
}

function projectRow(row: ExportRow, columns: string[]) {
  return Object.fromEntries(columns.map((column) => [column, row[column] ?? null])) as ExportRow;
}

function streamExport(input: {
  cursor: ExportCursor;
  signal: AbortSignal;
  format: ExportFormat;
  columns: string[];
  finish(rowCount: number, byteCount: number): Promise<void>;
}) {
  let canceled = false;
  let closed = false;

  async function closeCursor() {
    if (closed) return;
    closed = true;
    await input.cursor.close();
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let rowCount = 0;
      let byteCount = 0;
      let firstJsonRow = true;

      function emit(value: string) {
        const bytes = encoder.encode(value);
        byteCount += bytes.byteLength;
        controller.enqueue(bytes);
      }

      // The declared projection is known before data access, so clients receive framing while the
      // first tenant-scoped page is still resolving instead of waiting on an in-memory payload.
      emit(input.format === "csv" ? `\uFEFF${input.columns.map(csvCell).join(",")}\r\n` : "[");

      const abort = () => {
        canceled = true;
        void closeCursor();
      };
      input.signal.addEventListener("abort", abort, { once: true });

      void (async () => {
        try {
          while (!canceled && !input.signal.aborted) {
            const page = await input.cursor.nextPage();
            if (page.length === 0) break;
            if (page.length > PAGE_SIZE) throw new Error("EXPORT_PAGE_SIZE_EXCEEDED");
            for (const source of page) {
              rowCount += 1;
              if (rowCount > MAX_ROWS) throw new Error("EXPORT_ROW_LIMIT_EXCEEDED");
              const row = projectRow(source, input.columns);
              if (input.format === "csv") {
                emit(`${input.columns.map((column) => csvCell(row[column])).join(",")}\r\n`);
              } else {
                emit(`${firstJsonRow ? "" : ","}${JSON.stringify(row)}`);
                firstJsonRow = false;
              }
            }
          }
          if (canceled || input.signal.aborted) return;
          if (input.format === "json") emit("]");
          await closeCursor();
          await input.finish(rowCount, byteCount);
          controller.close();
        } catch (error) {
          await closeCursor();
          if (!canceled) controller.error(error);
        } finally {
          input.signal.removeEventListener("abort", abort);
        }
      })();
    },
    async cancel() {
      canceled = true;
      await closeCursor();
    },
  });
}

function channelLabel(channel: ConversationRead["channel"] | ContactRead["channels"][number]["channel"]) {
  return channel === "sms" ? "SMS" : channel.charAt(0).toUpperCase() + channel.slice(1);
}

const STATUS_LABELS: Record<ConversationRead["status"], string> = {
  agent: "Agent active",
  needs_human: "Handoff requested",
  human: "Human handling",
  nurture: "Nurture",
  closed: "Closed",
  scope_blocked: "Scope blocked",
  opted_out: "Opted out",
};

function conversationMatches(row: ConversationRead, filter: ExportFilter) {
  const outcome = row.qualification.outcome;
  const matchesOutcome = filter.outcome === "all"
    || (filter.outcome === "qualified" ? outcome === "BOOK" : outcome !== "BOOK");
  const latestMessage = row.messages.at(-1)?.body ?? "";
  const haystack = `${row.contactName} ${row.channel} ${STATUS_LABELS[row.status]} ${latestMessage}`.toLowerCase();
  return (filter.channel === "all" || row.channel === filter.channel)
    && matchesOutcome
    && (filter.stage === "all" || row.status === filter.stage)
    && haystack.includes(filter.search.toLowerCase());
}

function contactMatches(row: ContactRead, filter: ExportFilter) {
  const stage = row.pipelineStage.toLowerCase();
  const matchesStatus = filter.status === "total"
    || (filter.status === "active" && !stage.includes("closed"))
    || (filter.status === "booked" && stage.includes("book"))
    || (filter.status === "qualified" && row.outcome === "BOOK")
    || (filter.status === "disqualified" && (row.outcome === "SOFT_DQ" || row.outcome === "HARD_DQ"));
  const channels = row.channels.map((channel) => `${channel.channel} ${channel.address}`).join(" ");
  const haystack = `${row.name} ${channels} ${row.credit ?? ""} ${row.pipelineStage} ${row.outcome ?? ""}`.toLowerCase();
  return matchesStatus && haystack.includes(filter.search.toLowerCase());
}

function conversationExportRow(row: ConversationRead): ExportRow {
  return {
    lead: row.contactName,
    channel: channelLabel(row.channel),
    status: STATUS_LABELS[row.status],
    lastMessage: row.messages.at(-1)?.body ?? "No messages yet",
    lastActivity: row.lastActivityAt,
    demoData: row.isDemo,
    testData: row.isTest,
  };
}

function contactExportRow(row: ContactRead): ExportRow {
  return {
    name: row.name,
    channels: row.channels.map((channel) => `${channelLabel(channel.channel)}: ${channel.address}`).join("; "),
    creditRange: row.credit,
    fundingGoal: row.goal,
    timeline: row.timeline,
    decision: row.outcome,
    pipelineStage: row.pipelineStage,
    lastActivity: row.lastActivityAt,
    demoData: row.isDemo,
    testData: row.isTest,
  };
}

type Phase2ExportSpec = {
  table: string;
  select: string;
  orderColumn: string;
  searchColumn?: string;
  statusColumn?: string;
  tenantScoped: boolean;
  row(value: Record<string, unknown>): ExportRow;
};

function scalar(value: unknown): ExportValue {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
}

function mappedRow(value: Record<string, unknown>, fields: Readonly<Record<string, string>>): ExportRow {
  return Object.fromEntries(Object.entries(fields).map(([output, source]) => [output, scalar(value[source])]));
}

const PHASE2_EXPORT_SPECS: Record<(typeof PHASE2_EXPORT_RESOURCES)[number], Phase2ExportSpec> = {
  "keyword-goals": {
    table: "keyword_goals",
    select: "id,tenant_id,keyword,goal,resource_url,resource_message,post_booking_url,post_booking_message,active,created_at,updated_at",
    orderColumn: "created_at",
    searchColumn: "keyword",
    statusColumn: "active",
    tenantScoped: true,
    row: (value) => mappedRow(value, {
      id: "id", keyword: "keyword", goal: "goal", resourceUrl: "resource_url",
      resourceMessage: "resource_message", postBookingUrl: "post_booking_url",
      postBookingMessage: "post_booking_message", active: "active", createdAt: "created_at",
      updatedAt: "updated_at",
    }),
  },
  "brain-import-batches": {
    table: "brain_import_batches",
    select: "id,source,status,received_count,normalized_count,flagged_count,unchanged_count,created_at,completed_at",
    orderColumn: "created_at",
    searchColumn: "id",
    statusColumn: "status",
    tenantScoped: false,
    row: (value) => mappedRow(value, {
      id: "id", source: "source", status: "status", receivedCount: "received_count",
      normalizedCount: "normalized_count", flaggedCount: "flagged_count", unchangedCount: "unchanged_count",
      createdAt: "created_at", completedAt: "completed_at",
    }),
  },
  "brain-import-items": {
    table: "brain_import_items",
    select: "id,batch_id,source_ref,operation,decision,disposition,flags,decided_at,created_at",
    orderColumn: "created_at",
    searchColumn: "source_ref",
    statusColumn: "decision",
    tenantScoped: false,
    row: (value) => ({
      ...mappedRow(value, {
        id: "id", batchId: "batch_id", sourceRef: "source_ref", operation: "operation",
        decision: "decision", disposition: "disposition", decidedAt: "decided_at",
      }),
      flagCount: Array.isArray(value.flags) ? value.flags.length : 0,
    }),
  },
  "brain-knowledge-entries": {
    table: "brain_knowledge_entries",
    select: "id,category,source,source_ref,disposition,status,question,response_template,created_at",
    orderColumn: "created_at",
    searchColumn: "question",
    statusColumn: "status",
    tenantScoped: false,
    row: (value) => mappedRow(value, {
      id: "id", category: "category", source: "source", sourceRef: "source_ref",
      disposition: "disposition", status: "status", question: "question", responseTemplate: "response_template",
    }),
  },
  "brain-objections": {
    table: "brain_objections",
    select: "id,label,category,hard_gate,status,match_keywords,response,published_at,created_at",
    orderColumn: "created_at",
    searchColumn: "label",
    statusColumn: "status",
    tenantScoped: false,
    row: (value) => ({
      ...mappedRow(value, {
        id: "id", label: "label", category: "category", hardGate: "hard_gate",
        status: "status", response: "response", publishedAt: "published_at",
      }),
      // ExportValue is scalar-only, so the keyword array has to be joined here rather than
      // handed through as an array, which typechecks nowhere and would emit "[object Object]".
      matchKeywords: Array.isArray(value.match_keywords) ? value.match_keywords.join("; ") : "",
    }),
  },
  "brain-snapshots": {
    table: "brain_snapshots",
    select: "id,version,content_hash,source_hash,knowledge_mode,platform_tokens,published_at,rollback_of_snapshot_id",
    orderColumn: "version",
    searchColumn: "content_hash",
    tenantScoped: false,
    row: (value) => mappedRow(value, {
      id: "id", version: "version", contentHash: "content_hash", sourceHash: "source_hash",
      knowledgeMode: "knowledge_mode", platformTokens: "platform_tokens", publishedAt: "published_at",
      rollbackOfSnapshotId: "rollback_of_snapshot_id",
    }),
  },
  "brain-snapshot-diffs": {
    table: "brain_snapshots",
    select: "version,content_hash,source_hash,knowledge_mode,published_at,rollback_of_snapshot_id",
    orderColumn: "version",
    searchColumn: "content_hash",
    tenantScoped: false,
    row: (value) => mappedRow(value, {
      version: "version", contentHash: "content_hash", sourceHash: "source_hash",
      knowledgeMode: "knowledge_mode", publishedAt: "published_at",
      rollbackOfSnapshotId: "rollback_of_snapshot_id",
    }),
  },
  "eval-gate-results": {
    table: "eval_runs",
    select: "id,brain_draft_version_id,content_hash,kind,corpus_revision,suites_complete,created_at",
    orderColumn: "created_at",
    searchColumn: "content_hash",
    tenantScoped: false,
    row: (value) => mappedRow(value, {
      id: "id", draftId: "brain_draft_version_id", contentHash: "content_hash", kind: "kind",
      corpusRevision: "corpus_revision", suitesComplete: "suites_complete", createdAt: "created_at",
    }),
  },
  "offer-prices": {
    table: "offer_prices",
    select: "id,offer_id,label,amount_cents,billing_period,created_at",
    orderColumn: "created_at",
    searchColumn: "label",
    tenantScoped: true,
    row: (value) => mappedRow(value, {
      id: "id", offerId: "offer_id", label: "label", amountCents: "amount_cents",
      billingPeriod: "billing_period", createdAt: "created_at",
    }),
  },
  "offer-proof": {
    table: "offer_proof_entries",
    select: "id,offer_id,title,detail,created_at",
    orderColumn: "created_at",
    searchColumn: "title",
    tenantScoped: true,
    row: (value) => mappedRow(value, {
      id: "id", offerId: "offer_id", title: "title", detail: "detail", createdAt: "created_at",
    }),
  },
  "offer-assets": {
    table: "offer_assets",
    select: "id,offer_id,slug,label,url,created_at",
    orderColumn: "created_at",
    searchColumn: "label",
    tenantScoped: true,
    row: (value) => mappedRow(value, {
      id: "id", offerId: "offer_id", slug: "slug", label: "label", url: "url", createdAt: "created_at",
    }),
  },
};

type Phase4ExportSpec = {
  table: string;
  select: string;
  orderColumn: string;
  searchColumn?: string;
  statusColumn?: string;
  channelColumn?: string;
  actions?: readonly string[];
  row(value: Record<string, unknown>): ExportRow;
};

type Phase3ExportSpec = {
  table: string;
  select: string;
  orderColumn: string;
  tenantScoped: boolean;
  statusColumn?: string;
  row(value: Record<string, unknown>): ExportRow;
};

// Phase 5
type Phase5ExportSpec = {
  table: string;
  select: string;
  orderColumn: string;
  row(value: Record<string, unknown>): ExportRow;
};

function related(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return related(value[0]);
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function text(value: unknown) {
  return typeof value === "string" ? value : null;
}

function truth(value: unknown) {
  return value === true;
}

function dataLabel(isDemo: boolean, isTest = false) {
  return isDemo ? "Demo" : isTest ? "Test" : null;
}

// Phase 5
const PHASE5_EXPORT_SPECS: Record<(typeof PHASE5_EXPORT_RESOURCES)[number], Phase5ExportSpec> = {
  "provisioning-steps": {
    table: "provisioning_steps",
    select: "id,tenant_id,step_key,state,awaiting_party,attempts,started_at,last_attempt_at,completed_at,error_code,error_message,blocked_reason,next_attempt_at,last_transition_at,created_at,updated_at,tenant:tenants(is_demo)",
    orderColumn: "created_at",
    row: (value) => ({
      ...mappedRow(value, {
        id: "id", tenantId: "tenant_id", step: "step_key", state: "state",
        awaitingParty: "awaiting_party", attempts: "attempts", startedAt: "started_at",
        lastAttemptAt: "last_attempt_at", completedAt: "completed_at", errorCode: "error_code",
        errorMessage: "error_message", blockedReason: "blocked_reason", nextAttemptAt: "next_attempt_at",
        lastTransitionAt: "last_transition_at", createdAt: "created_at", updatedAt: "updated_at",
      }),
      dataLabel: dataLabel(truth(related(value.tenant)?.is_demo)),
    }),
  },
  "signup-intents": {
    table: "signup_intents",
    select: "id,email,tenant_id,tier_id,timezone,state,error,created_at,updated_at,tenant:tenants(is_demo)",
    orderColumn: "created_at",
    row: (value) => ({
      ...mappedRow(value, {
        id: "id", email: "email", tenantId: "tenant_id", tierId: "tier_id", timezone: "timezone",
        state: "state", error: "error", createdAt: "created_at", updatedAt: "updated_at",
      }),
      dataLabel: dataLabel(truth(related(value.tenant)?.is_demo)),
    }),
  },
  "onboarding-runs": {
    table: "onboarding_runs",
    select: "id,tenant_id,started_at,readiness_met_at,went_live_at,stalled_flagged_at,created_at,updated_at,tenant:tenants(is_demo)",
    orderColumn: "created_at",
    row: (value) => ({
      ...mappedRow(value, {
        id: "id", tenantId: "tenant_id", startedAt: "started_at", readinessMetAt: "readiness_met_at",
        wentLiveAt: "went_live_at", stalledFlaggedAt: "stalled_flagged_at", createdAt: "created_at", updatedAt: "updated_at",
      }),
      dataLabel: dataLabel(truth(related(value.tenant)?.is_demo)),
    }),
  },
  "business-profiles": {
    table: "business_profiles",
    select: "id,tenant_id,legal_name,entity_type,has_ein,website_url,address_line1,address_line2,city,region,postal_code,country_code,created_at,updated_at,tenant:tenants(is_demo)",
    orderColumn: "created_at",
    row: (value) => ({
      ...mappedRow(value, {
        id: "id", tenantId: "tenant_id", legalName: "legal_name", entityType: "entity_type",
        hasEin: "has_ein", websiteUrl: "website_url", addressLine1: "address_line1",
        addressLine2: "address_line2", city: "city", region: "region", postalCode: "postal_code",
        countryCode: "country_code", createdAt: "created_at", updatedAt: "updated_at",
      }),
      dataLabel: dataLabel(truth(related(value.tenant)?.is_demo)),
    }),
  },
  "onboarding-optin-artifacts": {
    table: "onboarding_optin_artifacts",
    select: "id,tenant_id,version,template_version,marketing_language_hash,non_marketing_language_hash,terms_url,privacy_url,campaign_description_hash,artifact_hash,placeholder,is_current,confirmed_at,created_at,updated_at,tenant:tenants(is_demo)",
    orderColumn: "created_at",
    row: (value) => ({
      ...mappedRow(value, {
        id: "id", tenantId: "tenant_id", version: "version", templateVersion: "template_version",
        marketingLanguageHash: "marketing_language_hash", nonMarketingLanguageHash: "non_marketing_language_hash",
        termsUrl: "terms_url", privacyUrl: "privacy_url", campaignDescriptionHash: "campaign_description_hash",
        artifactHash: "artifact_hash", placeholder: "placeholder", isCurrent: "is_current",
        confirmedAt: "confirmed_at", createdAt: "created_at", updatedAt: "updated_at",
      }),
      // Derived, never substituted: `privacyUrl` still carries whatever is stored, including a
      // placeholder that should never have shipped. This row is A2P filing evidence -- evidence of
      // what was filed -- so blanking the field would be a lie about history rather than a withheld
      // link. The flag is how someone finds the bad value; emptying the field is how it stays lost.
      privacyUrlReachable: disclosureHostIsReachable(text(value.privacy_url) ?? ""),
      dataLabel: dataLabel(truth(related(value.tenant)?.is_demo)),
    }),
  },
  "onboarding-content-screens": {
    table: "onboarding_content_screens",
    select: "id,tenant_id,input_hash,result,matches,is_current,acknowledged_at,admin_confirmed_at,created_at,updated_at,tenant:tenants(is_demo)",
    orderColumn: "created_at",
    row: (value) => {
      const matches = Array.isArray(value.matches) ? value.matches : [];
      const pages = [...new Set(matches.flatMap((match) => {
        if (!match || typeof match !== "object" || Array.isArray(match)) return [];
        const page = (match as Record<string, unknown>).page;
        return typeof page === "string" ? [page] : [];
      }))];
      return {
        ...mappedRow(value, {
          id: "id", tenantId: "tenant_id", inputHash: "input_hash", result: "result",
          isCurrent: "is_current", acknowledgedAt: "acknowledged_at",
          adminConfirmedAt: "admin_confirmed_at", createdAt: "created_at", updatedAt: "updated_at",
        }),
        matchCount: matches.length,
        matchedPages: pages.join("; "),
        dataLabel: dataLabel(truth(related(value.tenant)?.is_demo)),
      };
    },
  },
  "a2p-probe-receipts": {
    table: "a2p_probe_receipts",
    select: "id,tenant_id,result,provider_code,observed_at,created_at,tenant:tenants(is_demo)",
    orderColumn: "created_at",
    row: (value) => ({
      ...mappedRow(value, {
        id: "id", tenantId: "tenant_id", result: "result", providerCode: "provider_code",
        observedAt: "observed_at", createdAt: "created_at",
      }),
      dataLabel: dataLabel(truth(related(value.tenant)?.is_demo)),
    }),
  },
};

/** Test seam for Phase 5 allowlisted projections; excluded raw fields can never enter the stream. */
export function phase5ExportRow(
  resource: (typeof PHASE5_EXPORT_RESOURCES)[number],
  value: Record<string, unknown>,
) {
  return PHASE5_EXPORT_SPECS[resource].row(value);
}

async function openPhase5Cursor(input: {
  resource: (typeof PHASE5_EXPORT_RESOURCES)[number];
  filter: ExportFilter;
  pageSize: number;
}): Promise<ExportCursor> {
  const spec = PHASE5_EXPORT_SPECS[input.resource];
  const client = createSupabaseServiceClient();
  let offset = 0;
  let exhausted = false;
  return {
    async nextPage() {
      if (exhausted) return [];
      const query = client.from(spec.table).select(spec.select);
      const { data, error } = await query.order(spec.orderColumn, { ascending: false })
        .range(offset, offset + input.pageSize - 1);
      if (error) throw new Error(`EXPORT_PAGE_READ_FAILED:${error.message}`);
      const rows = (data ?? []).map((row) => phase5ExportRow(
        input.resource,
        row as unknown as Record<string, unknown>,
      ));
      offset += rows.length;
      exhausted = rows.length < input.pageSize;
      return rows;
    },
    async close() {},
  };
}

// Phase 6
type Phase6ExportSpec = {
  table: string;
  select: string;
  orderColumn: string;
  row(value: Record<string, unknown>): ExportRow;
};

function relatedRows(value: unknown) {
  return Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row))
    : [];
}

const PHASE6_EXPORT_SPECS: Record<(typeof PHASE6_OWNER_ADMIN_EXPORT_RESOURCES)[number], Phase6ExportSpec> = {
  "billing-tiers": {
    table: "tiers",
    select: "id,name,price_cents,call_allowance,fair_use_cap,fair_use_note,active,updated_at",
    orderColumn: "updated_at",
    row: (value) => mappedRow(value, {
      id: "id", name: "name", priceCents: "price_cents", callAllowance: "call_allowance",
      fairUseCap: "fair_use_cap", fairUseNote: "fair_use_note", active: "active", updatedAt: "updated_at",
    }),
  },
  "platform-billing": {
    table: "tenants",
    select: "id,name,status,is_demo,billing_subscriptions(status,provider_updated_at,current_period_end,cancel_at_period_end),allowance_actions(pending_tier_id,effective_at,state)",
    orderColumn: "updated_at",
    row: (value) => {
      const subscription = related(value.billing_subscriptions);
      const pending = relatedRows(value.allowance_actions)
        .find((row) => row.state === "scheduled" || row.state === "awaiting_consent") ?? null;
      return {
        tenantId: scalar(value.id),
        businessName: scalar(value.name),
        accountStatus: scalar(value.status),
        subscriptionStatus: scalar(subscription?.status),
        providerUpdatedAt: scalar(subscription?.provider_updated_at),
        currentPeriodEnd: scalar(subscription?.current_period_end),
        cancelAtPeriodEnd: scalar(subscription?.cancel_at_period_end),
        pendingTierId: scalar(pending?.pending_tier_id),
        pendingEffectiveAt: scalar(pending?.effective_at),
        dataLabel: dataLabel(truth(value.is_demo)),
      };
    },
  },
  "billing-corrections": {
    table: "billing_correction_requests",
    select: "id,tenant_id,billable_event_id,quantity_delta,reason,audit_id,created_at,tenant:tenants(name,is_demo),billing_correction_decisions(id,decision,reason,offset_event_id,audit_id)",
    orderColumn: "created_at",
    row: (value) => {
      const tenant = related(value.tenant);
      const decision = related(value.billing_correction_decisions);
      return {
        requestId: scalar(value.id), tenantId: scalar(value.tenant_id),
        businessName: scalar(tenant?.name), billableEventId: scalar(value.billable_event_id),
        quantityDelta: scalar(value.quantity_delta), reason: scalar(value.reason),
        requestedAt: scalar(value.created_at), requestAuditId: scalar(value.audit_id),
        decision: scalar(decision?.decision), decisionId: scalar(decision?.id),
        decisionReason: scalar(decision?.reason),
        decisionAuditId: scalar(decision?.audit_id), offsetEventId: scalar(decision?.offset_event_id),
        dataLabel: dataLabel(truth(tenant?.is_demo)),
      };
    },
  },
  "affiliate-payouts": {
    table: "commission_ledger",
    select: "id,referral_id,commission_cents,entry_kind,reverses_ledger_id,created_at,referral:referrals(affiliate_id,tenant:tenants(name,is_demo),affiliate:affiliates(id,user:users(full_name))),commission_payout_items(payout_id,commission_payouts(id,total_cents,commission_payout_events(id,kind,reference,paid_on,audit_id,created_at,actor:users(full_name))))",
    orderColumn: "created_at",
    row: (value) => {
      const referral = related(value.referral);
      const tenant = related(referral?.tenant);
      const affiliate = related(referral?.affiliate);
      const affiliateUser = related(affiliate?.user);
      const payoutItem = related(value.commission_payout_items);
      const payout = related(payoutItem?.commission_payouts);
      const events = relatedRows(payout?.commission_payout_events);
      const approved = events.find((row) => row.kind === "approved") ?? null;
      const sent = events.find((row) => row.kind === "sent") ?? null;
      return {
        ledgerId: scalar(value.id), affiliateId: scalar(referral?.affiliate_id),
        affiliateName: scalar(affiliateUser?.full_name), businessName: scalar(tenant?.name),
        commissionCents: scalar(value.commission_cents), entryKind: scalar(value.entry_kind),
        reversesLedgerId: scalar(value.reverses_ledger_id), payoutId: scalar(payout?.id),
        payoutTotalCents: scalar(payout?.total_cents),
        payoutState: sent ? "sent" : approved ? "approved_for_payout" : "pending_approval",
        approvedEventId: scalar(approved?.id), approvedAt: scalar(approved?.created_at),
        approvedBy: scalar(related(approved?.actor)?.full_name),
        approvedAuditId: scalar(approved?.audit_id),
        sentEventId: scalar(sent?.id), sentAuditId: scalar(sent?.audit_id),
        reference: scalar(sent?.reference), paidOn: scalar(sent?.paid_on),
        createdAt: scalar(value.created_at), dataLabel: dataLabel(truth(tenant?.is_demo)),
      };
    },
  },
  "billing-cost-rollups": {
    table: "tenant_cost_rollups",
    select: "id,tenant_id,window_start,window_end,recognized_subscription_cents,model_cents,messaging_cents,embedding_cents,complete,missing_sources,computed_at,tenant:tenants(name,is_demo)",
    orderColumn: "window_end",
    row: (value) => {
      const tenant = related(value.tenant);
      return {
        rollupId: scalar(value.id), tenantId: scalar(value.tenant_id), businessName: scalar(tenant?.name),
        windowStart: scalar(value.window_start), windowEnd: scalar(value.window_end),
        revenueCents: scalar(value.recognized_subscription_cents), modelCostCents: scalar(value.model_cents),
        messagingCostCents: scalar(value.messaging_cents), embeddingCostCents: scalar(value.embedding_cents),
        complete: truth(value.complete),
        missingSources: Array.isArray(value.missing_sources) ? value.missing_sources.join("; ") : "",
        sourceEvidenceAt: scalar(value.computed_at), dataLabel: dataLabel(truth(tenant?.is_demo)),
      };
    },
  },
};

/** Test seam for Phase 6 allowlisted projections. */
export function phase6ExportRow(
  resource: (typeof PHASE6_OWNER_ADMIN_EXPORT_RESOURCES)[number],
  value: Record<string, unknown>,
) {
  return PHASE6_EXPORT_SPECS[resource].row(value);
}

async function openPhase6Cursor(input: {
  resource: (typeof PHASE6_EXPORT_RESOURCES)[number];
  pageSize: number;
}): Promise<ExportCursor> {
  if (input.resource === "affiliate-referrals") {
    let rows: ExportRow[] | null = null;
    let offset = 0;
    return {
      async nextPage() {
        if (!rows) {
          rows = (await createAffiliateRepository().listOwnReferrals()).map((row) => ({
            businessName: row.business_name,
            // The word the affiliate's own screen shows for this state, not the stored enum. An
            // unrecognised value falls through as itself rather than as an empty cell or a guess:
            // the repository already validates against `AFFILIATE_ACCOUNT_STATES` and throws on a
            // miss, so reaching this fallback means the contract moved and the raw value is the
            // most honest thing left to print.
            accountStatus: AFFILIATE_ACCOUNT_STATE_LABELS[
              row.account_status as AffiliateAccountState
            ] ?? row.account_status,
            // Cents are how the money is stored, not how it is owed. Two decimal places and no
            // currency symbol: the symbol would make the cell a string in every spreadsheet that
            // opens it, and this is a file people sum.
            commissionEarnedUsd: (row.commission_earned_cents / 100).toFixed(2),
          }));
        }
        const page = rows.slice(offset, offset + input.pageSize);
        offset += page.length;
        return page;
      },
      async close() {},
    };
  }
  const spec = PHASE6_EXPORT_SPECS[input.resource];
  const client = createSupabaseServiceClient();
  let offset = 0;
  let exhausted = false;
  return {
    async nextPage() {
      if (exhausted) return [];
      const { data, error } = await client.from(spec.table).select(spec.select)
        .order(spec.orderColumn, { ascending: false })
        .range(offset, offset + input.pageSize - 1);
      if (error) throw new Error(`EXPORT_PAGE_READ_FAILED:${error.message}`);
      const rows = (data ?? []).map((row) => spec.row(row as unknown as Record<string, unknown>));
      offset += rows.length;
      exhausted = rows.length < input.pageSize;
      return rows;
    },
    async close() {},
  };
}

// Phase 3
const PHASE3_EXPORT_SPECS: Record<(typeof PHASE3_EXPORT_RESOURCES)[number], Phase3ExportSpec> = {
  followups: {
    table: "followups",
    select: `
      id,tenant_id,conversation_id,purpose,touch_no,status,scheduled_at,sent_at,canceled_reason,
      paused_at,deferred_count,attempt_count,is_test,created_at,
      conversation:conversations!inner(contact_id,channel)
    `,
    orderColumn: "created_at",
    tenantScoped: true,
    statusColumn: "status",
    row: (value) => {
      const conversation = related(value.conversation);
      return {
        id: scalar(value.id),
        conversationId: scalar(value.conversation_id),
        contactId: scalar(conversation?.contact_id),
        channel: scalar(conversation?.channel),
        purpose: scalar(value.purpose),
        touchNo: scalar(value.touch_no),
        status: scalar(value.status),
        scheduledAt: scalar(value.scheduled_at),
        sentAt: scalar(value.sent_at),
        canceledReason: scalar(value.canceled_reason),
        pausedAt: scalar(value.paused_at),
        deferredCount: scalar(value.deferred_count),
        attemptCount: scalar(value.attempt_count),
        testData: truth(value.is_test),
      };
    },
  },
  "suppression-tombstones": {
    table: "suppression_tombstones",
    select: "id,tenant_id,channel,identifier_last4,deletion_audit_id,created_at",
    orderColumn: "created_at",
    tenantScoped: false,
    row: (value) => mappedRow(value, {
      id: "id",
      tenantId: "tenant_id",
      channel: "channel",
      identifierLast4: "identifier_last4",
      deletionAuditId: "deletion_audit_id",
      createdAt: "created_at",
    }),
  },
};

async function openPhase3Cursor(input: {
  resource: (typeof PHASE3_EXPORT_RESOURCES)[number];
  tenantId: string | null;
  filter: ExportFilter;
  pageSize: number;
}): Promise<ExportCursor> {
  const spec = PHASE3_EXPORT_SPECS[input.resource];
  if (spec.tenantScoped && !input.tenantId) throw new Error("EXPORT_TENANT_REQUIRED");
  const client = createSupabaseServiceClient();
  let offset = 0;
  let exhausted = false;
  return {
    async nextPage() {
      if (exhausted) return [];
      let query = client.from(spec.table).select(spec.select);
      if (spec.tenantScoped) query = query.eq("tenant_id", input.tenantId!);
      if (spec.statusColumn && input.filter.status && input.filter.status !== "all") {
        query = query.eq(spec.statusColumn, input.filter.status);
      }
      const { data, error } = await query.order(spec.orderColumn, { ascending: false })
        .range(offset, offset + input.pageSize - 1);
      if (error) throw new Error(`EXPORT_PAGE_READ_FAILED:${error.message}`);
      const rows = (data ?? []).map((row) => spec.row(row as unknown as Record<string, unknown>));
      offset += rows.length;
      exhausted = rows.length < input.pageSize;
      return rows;
    },
    async close() {},
  };
}

const PHASE4_EXPORT_SPECS: Record<(typeof PHASE4_EXPORT_RESOURCES)[number], Phase4ExportSpec> = {
  "contact-identities": {
    table: "contact_identities",
    select: `
      id,tenant_id,contact_id,channel,provider_identity_id,normalized_phone,normalized_email,
      consent_state,provider_window_expires_at,created_at,
      contact:contacts!inner(id,tenant_id,is_test,tenant:tenants!inner(is_demo))
    `,
    orderColumn: "created_at",
    searchColumn: "provider_identity_id",
    statusColumn: "consent_state",
    channelColumn: "channel",
    row: (value) => {
      const contact = related(value.contact);
      const tenant = related(contact?.tenant);
      const isDemo = truth(tenant?.is_demo);
      const isTest = truth(contact?.is_test);
      return {
        id: scalar(value.id),
        contactId: scalar(value.contact_id),
        channel: scalar(value.channel),
        address: text(value.normalized_phone) ?? text(value.normalized_email) ?? scalar(value.provider_identity_id),
        consentState: scalar(value.consent_state),
        windowExpiresAt: scalar(value.provider_window_expires_at),
        createdAt: scalar(value.created_at),
        dataLabel: dataLabel(isDemo, isTest),
        testData: isTest,
      };
    },
  },
  "suspected-duplicates": {
    table: "contact_duplicate_candidates",
    select: `
      id,tenant_id,contact_a_id,contact_b_id,source,evidence_key,state,created_at,
      tenant:tenants!inner(is_demo),
      contact_a:contacts!contact_duplicate_candidates_contact_a_id_fkey(id,tenant_id,name,is_test),
      contact_b:contacts!contact_duplicate_candidates_contact_b_id_fkey(id,tenant_id,name,is_test)
    `,
    orderColumn: "created_at",
    searchColumn: "evidence_key",
    statusColumn: "state",
    row: (value) => {
      const tenant = related(value.tenant);
      const contactA = related(value.contact_a);
      const contactB = related(value.contact_b);
      const testA = truth(contactA?.is_test);
      const testB = truth(contactB?.is_test);
      const testBoundary = testA === testB ? testA ? "test" : "real" : "mixed";
      return {
        id: scalar(value.id),
        contactAId: scalar(value.contact_a_id),
        contactAName: scalar(contactA?.name),
        contactBId: scalar(value.contact_b_id),
        contactBName: scalar(contactB?.name),
        source: scalar(value.source),
        evidenceKey: scalar(value.evidence_key),
        state: scalar(value.state),
        createdAt: scalar(value.created_at),
        testBoundary,
        dataLabel: dataLabel(truth(tenant?.is_demo), testA || testB),
      };
    },
  },
  "message-templates": {
    table: "message_templates",
    select: `
      id,tenant_id,channel,provider_template_name,category,locale,body,status,submitted_at,
      approved_at,rejected_at,created_at,is_demo
    `,
    orderColumn: "created_at",
    searchColumn: "provider_template_name",
    statusColumn: "status",
    channelColumn: "channel",
    row: (value) => ({
      id: scalar(value.id),
      channel: scalar(value.channel),
      name: scalar(value.provider_template_name),
      category: scalar(value.category),
      locale: scalar(value.locale),
      body: scalar(value.body),
      status: scalar(value.status),
      submittedAt: scalar(value.submitted_at),
      approvedAt: scalar(value.approved_at),
      rejectedAt: scalar(value.rejected_at),
      dataLabel: truth(value.is_demo) ? "Demo" : null,
    }),
  },
  "channel-connections": {
    table: "channel_connections",
    select: `
      id,tenant_id,channel,state,external_account_label,oauth_completed_at,asset_verified_at,
      webhook_subscribed_at,signed_round_trip_at,updated_at,created_at,
      tenant:tenants!inner(is_demo)
    `,
    orderColumn: "created_at",
    searchColumn: "external_account_label",
    statusColumn: "state",
    channelColumn: "channel",
    row: (value) => ({
      id: scalar(value.id),
      channel: scalar(value.channel),
      state: scalar(value.state),
      accountLabel: scalar(value.external_account_label),
      oauthCompletedAt: scalar(value.oauth_completed_at),
      assetVerifiedAt: scalar(value.asset_verified_at),
      webhookSubscribedAt: scalar(value.webhook_subscribed_at),
      signedRoundTripAt: scalar(value.signed_round_trip_at),
      updatedAt: scalar(value.updated_at),
      dataLabel: truth(related(value.tenant)?.is_demo) ? "Demo" : null,
    }),
  },
  "merge-history": {
    table: "audit_log",
    select: "id,tenant_id,action,target_type,target_id,reason,actor_id,created_at",
    orderColumn: "created_at",
    searchColumn: "reason",
    actions: ["contact.merged", "contact.unmerged"],
    row: (value) => mappedRow(value, {
      auditId: "id",
      action: "action",
      targetType: "target_type",
      targetId: "target_id",
      reason: "reason",
      actorId: "actor_id",
      createdAt: "created_at",
    }),
  },
};

/** Test seam for the resource-specific join projection; raw query rows never reach the stream. */
export function phase4ExportRow(
  resource: (typeof PHASE4_EXPORT_RESOURCES)[number],
  value: Record<string, unknown>,
) {
  return PHASE4_EXPORT_SPECS[resource].row(value);
}

async function openPhase4Cursor(input: {
  resource: (typeof PHASE4_EXPORT_RESOURCES)[number];
  tenantId: string | null;
  filter: ExportFilter;
  pageSize: number;
}): Promise<ExportCursor> {
  if (!input.tenantId) throw new Error("EXPORT_TENANT_REQUIRED");
  const spec = PHASE4_EXPORT_SPECS[input.resource];
  const client = createSupabaseServiceClient();
  let offset = 0;
  let exhausted = false;
  return {
    async nextPage() {
      if (exhausted) return [];
      let query = client.from(spec.table).select(spec.select).eq("tenant_id", input.tenantId!);
      if (spec.actions) query = query.in("action", [...spec.actions]);
      if (spec.statusColumn && input.filter.status && input.filter.status !== "all") {
        query = query.eq(spec.statusColumn, input.filter.status);
      }
      if (spec.channelColumn && input.filter.channel && input.filter.channel !== "all") {
        query = query.eq(spec.channelColumn, input.filter.channel);
      }
      if (spec.searchColumn && input.filter.search) {
        query = query.ilike(spec.searchColumn, `%${input.filter.search}%`);
      }
      const { data, error } = await query
        .order(spec.orderColumn, { ascending: false })
        .range(offset, offset + input.pageSize - 1);
      if (error) throw new Error(`EXPORT_PAGE_READ_FAILED:${error.message}`);
      const rows = (data ?? []).map((row) => phase4ExportRow(
        input.resource,
        row as unknown as Record<string, unknown>,
      ));
      offset += rows.length;
      exhausted = rows.length < input.pageSize;
      return rows;
    },
    async close() {},
  };
}

async function openPhase2Cursor(input: {
  resource: (typeof PHASE2_EXPORT_RESOURCES)[number];
  tenantId: string | null;
  filter: ExportFilter;
  pageSize: number;
}): Promise<ExportCursor> {
  const spec = PHASE2_EXPORT_SPECS[input.resource];
  if (spec.tenantScoped && !input.tenantId) throw new Error("EXPORT_TENANT_REQUIRED");
  const client = createSupabaseServiceClient();
  let offset = 0;
  let exhausted = false;
  return {
    async nextPage() {
      if (exhausted) return [];
      let query = client.from(spec.table).select(spec.select);
      if (spec.tenantScoped) query = query.eq("tenant_id", input.tenantId!);
      if (spec.statusColumn && input.filter.status && input.filter.status !== "all") {
        query = query.eq(spec.statusColumn, input.filter.status);
      }
      if (spec.searchColumn && input.filter.search) {
        query = query.ilike(spec.searchColumn, `%${input.filter.search}%`);
      }
      const { data, error } = await query
        .order(spec.orderColumn, { ascending: false })
        .range(offset, offset + input.pageSize - 1);
      if (error) throw new Error(`EXPORT_PAGE_READ_FAILED:${error.message}`);
      const rows = (data ?? []).map((row) => spec.row(row as unknown as Record<string, unknown>));
      offset += rows.length;
      exhausted = rows.length < input.pageSize;
      return rows;
    },
    async close() {},
  };
}

/** Test seam for Phase 7 projections shared with the rendered coach view models. */
export function phase7MeasurementExportRows(
  resource: (typeof PHASE7_TENANT_EXPORT_RESOURCES)[number],
  snapshot: CoachMeasurement,
): ExportRow[] {
  const measurement = coachMeasurementView(snapshot);
  const keywordDenominator = measurement.keywords.reduce(
    (total, row) => total + row.conversations,
    0,
  );
  const rows = resource === "coach-measurement-keywords"
    ? measurement.keywords.map((row) => ({
        ...row,
        optInDenominator: keywordDenominator,
        qualifiedDenominator: row.conversations,
        bookedDenominator: row.conversations,
      }))
    : resource === "coach-measurement-steps"
      ? measurement.steps
      : coachPipelineView(snapshot).stages.flatMap((stage) => stage.rows);
  return rows.map((row) => Object.fromEntries(Object.entries(row)) as ExportRow);
}

type Phase7PlatformMeasurementResource = Exclude<
  (typeof PHASE7_PLATFORM_EXPORT_RESOURCES)[number],
  "eval-comparisons" | "eval-comparison-results"
>;

/** Exact projection shared by the platform KPI surfaces and their role-tiered exports. */
export function phase7PlatformExportRows(
  resource: Phase7PlatformMeasurementResource,
  snapshot: PlatformMeasurement,
): ExportRow[] {
  const rows = resource === "platform-subscriptions"
    ? snapshot.subscriptions
    : resource === "platform-tenant-performance"
      ? snapshot.tenantPerformance
      : resource === "platform-guardrail-rules"
        ? snapshot.guardrailRules
        : resource === "platform-followup-performance"
          ? snapshot.followupPerformance
          : snapshot.provisioningPerformance;
  const dataOrigin = snapshot.origin === "synthetic_preview" ? "Synthetic review preview" : "Real analytics";
  return rows.map((row) => ({
    dataOrigin,
    ...Object.fromEntries(Object.entries(row)),
  }) as ExportRow);
}

function isEvalComparisonResource(
  resource: ExportResource,
): resource is "eval-comparisons" | "eval-comparison-results" {
  return resource === "eval-comparisons" || resource === "eval-comparison-results";
}

async function openPhase7PlatformCursor(input: {
  resource: (typeof PHASE7_PLATFORM_EXPORT_RESOURCES)[number];
  actorId: string;
  pageSize: number;
}): Promise<ExportCursor> {
  if (!isEvalComparisonResource(input.resource)) {
    const snapshot = await loadPlatformMeasurement(input.actorId, new Date().toISOString());
    const rows = phase7PlatformExportRows(input.resource, snapshot);
    let offset = 0;
    return {
      async nextPage() {
        const page = rows.slice(offset, offset + input.pageSize);
        offset += page.length;
        return page;
      },
      async close() {},
    };
  }

  const client = createSupabaseServiceClient();
  const buffer: ExportRow[] = [];
  let comparisonOffset = 0;
  let exhausted = false;
  return {
    async nextPage() {
      while (buffer.length < input.pageSize && !exhausted) {
        const { data, error } = await client.from("eval_comparisons").select("id")
          .order("created_at", { ascending: false })
          .range(comparisonOffset, comparisonOffset + 49);
        if (error) throw new Error(`EVAL_COMPARISON_EXPORT_READ_FAILED:${error.message}`);
        const ids = (data ?? []).map((row) => String(row.id));
        comparisonOffset += ids.length;
        exhausted = ids.length < 50;
        for (const id of ids) {
          const snapshot = await loadEvalComparisonExport(id);
          if (!snapshot) throw new Error("EVAL_COMPARISON_EXPORT_READBACK_MISSING");
          const rows = input.resource === "eval-comparisons"
            ? [snapshot.comparison]
            : snapshot.results;
          buffer.push(...rows.map((row) => Object.fromEntries(Object.entries(row)) as ExportRow));
        }
      }
      return buffer.splice(0, input.pageSize);
    },
    async close() {
      buffer.length = 0;
      exhausted = true;
    },
  };
}

// Phase 8
type Phase8ExportSpec = {
  table: string;
  select: string;
  orderColumn: string;
  secondaryOrderColumn: string;
  tenantColumn?: string;
  testColumn?: string;
  row(value: Record<string, unknown>): ExportRow;
};

function audience(value: Record<string, unknown>) {
  const roles = Array.isArray(value.audience_roles)
    ? value.audience_roles.filter((role): role is string => typeof role === "string")
    : [];
  if (truth(value.include_success_owner)) roles.push("success_owner");
  if (truth(value.include_billing_contact)) roles.push("billing_contact");
  return roles.join("; ");
}

function destinations(value: unknown) {
  return Array.isArray(value)
    ? value.filter((destination): destination is string => typeof destination === "string")
    : [];
}

const PHASE8_EXPORT_SPECS: Record<(typeof PHASE8_EXPORT_RESOURCES)[number], Phase8ExportSpec> = {
  "alert-rules": {
    table: "alert_rules",
    select: "id,event_key,scope,name,category,audience_roles,include_success_owner,include_billing_contact,default_destinations,suppressible,default_enabled,created_at",
    orderColumn: "event_key",
    secondaryOrderColumn: "id",
    row: (value) => ({
      event: scalar(value.event_key),
      scope: scalar(value.scope),
      name: scalar(value.name),
      category: scalar(value.category),
      audience: audience(value),
      destinations: destinations(value.default_destinations).join("; "),
      required: !truth(value.suppressible),
      enabled: truth(value.default_enabled),
    }),
  },
  "audit-log": {
    table: "audit_log",
    select: "id,tenant_id,action,actor_id,target_type,target_id,reason,created_at",
    orderColumn: "created_at",
    secondaryOrderColumn: "id",
    tenantColumn: "tenant_id",
    row: (value) => ({
      action: scalar(value.action),
      actor: scalar(value.actor_id),
      target: [text(value.target_type), text(value.target_id)].filter(Boolean).join(": "),
      reason: scalar(value.reason),
      at: scalar(value.created_at),
      testData: false,
    }),
  },
  "coach-support-messages": {
    table: "coach_support_messages",
    select: "id,tenant_id,thread_id,author_id,is_test,created_at",
    orderColumn: "created_at",
    secondaryOrderColumn: "id",
    tenantColumn: "tenant_id",
    testColumn: "is_test",
    row: (value) => ({
      thread: scalar(value.thread_id),
      author: scalar(value.author_id),
      createdAt: scalar(value.created_at),
      testData: false,
    }),
  },
  "notification-deliveries": {
    table: "notification_deliveries",
    select: "id,destination,status,attempts,last_attempt_at,delivered_at,created_at,notification:notifications!inner(tenant_id,kind,is_test)",
    orderColumn: "created_at",
    secondaryOrderColumn: "id",
    row: (value) => {
      const notification = related(value.notification);
      return {
        event: scalar(notification?.kind),
        destination: scalar(value.destination),
        state: scalar(value.status),
        attempts: scalar(value.attempts),
        lastAttemptAt: scalar(value.last_attempt_at),
        deliveredAt: scalar(value.delivered_at),
        testData: false,
      };
    },
  },
  "notification-rules": {
    table: "alert_rules",
    select: "id,event_key,scope,category,default_destinations,suppressible,created_at",
    orderColumn: "event_key",
    secondaryOrderColumn: "id",
    row: (value) => {
      const enabled = destinations(value.default_destinations);
      return {
        event: scalar(value.event_key),
        scope: scalar(value.scope),
        bell: enabled.includes("bell"),
        email: enabled.includes("email"),
        slack: enabled.includes("slack"),
        required: !truth(value.suppressible),
      };
    },
  },
  "support-messages": {
    table: "support_messages",
    select: "id,tenant_id,thread_id,author_id,internal,is_test,created_at",
    orderColumn: "created_at",
    secondaryOrderColumn: "id",
    tenantColumn: "tenant_id",
    testColumn: "is_test",
    row: (value) => ({
      thread: scalar(value.thread_id),
      author: scalar(value.author_id),
      internal: truth(value.internal),
      createdAt: scalar(value.created_at),
      testData: false,
    }),
  },
  "support-threads": {
    table: "support_threads",
    select: "id,tenant_id,subject,status,assigned_to,is_test,updated_at",
    orderColumn: "updated_at",
    secondaryOrderColumn: "id",
    tenantColumn: "tenant_id",
    testColumn: "is_test",
    row: (value) => ({
      subject: scalar(value.subject),
      client: scalar(value.tenant_id),
      status: scalar(value.status),
      assignee: scalar(value.assigned_to),
      updatedAt: scalar(value.updated_at),
      testData: false,
    }),
  },
  "success-client-book": {
    table: "tenants",
    select: "id,name,status,success_owner,updated_at,support_threads(status,updated_at)",
    orderColumn: "updated_at",
    secondaryOrderColumn: "id",
    tenantColumn: "id",
    row: (value) => {
      const support = relatedRows(value.support_threads)
        .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)))[0] ?? null;
      return {
        client: scalar(value.name),
        status: scalar(value.status),
        successOwner: scalar(value.success_owner),
        supportStatus: scalar(support?.status),
        updatedAt: scalar(value.updated_at),
      };
    },
  },
};

/** Coach support deliberately has no internal member at the query or projection boundary. */
export function phase8ExportRow(
  resource: (typeof PHASE8_EXPORT_RESOURCES)[number],
  value: Record<string, unknown>,
) {
  return PHASE8_EXPORT_SPECS[resource].row(value);
}

/**
 * The success owner's name for an exported client-book row.
 *
 * The projection column is `tenants.success_owner`, a uuid, and a spreadsheet is the one surface a
 * reader cannot hover to resolve it. So the export runs the same keyed `users` read the screen
 * runs, per page, and never falls back to the id: an owner the join could not name is still an
 * owned client and says so, an empty column is nobody's.
 */
async function loadExportOwnerNames(
  client: ReturnType<typeof createSupabaseServiceClient>,
  ownerIds: readonly string[],
): Promise<Map<string, string>> {
  const resolved = new Map<string, string>();
  if (ownerIds.length === 0) return resolved;
  const { data, error } = await client.from("users").select("id,full_name,email").in("id", [...ownerIds]);
  if (error || !data) return resolved;
  for (const user of data as { id: string; full_name: string | null; email: string | null }[]) {
    const name = user.full_name?.trim() || user.email?.trim();
    if (name) resolved.set(String(user.id), name);
  }
  return resolved;
}

export function exportOwnerLabel(id: unknown, names: ReadonlyMap<string, string>): string {
  if (typeof id !== "string" || !id.trim()) return "Unassigned";
  return names.get(id) ?? "Assigned owner";
}

async function loadRealTenantIds() {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.from("analytics_tenants").select("tenant_id")
    .order("tenant_id").limit(MAX_ROWS);
  if (error) throw new Error(`PHASE7_EXPORT_EXCLUSION_VIEWS_MISSING:${error.message}`);
  return (data ?? []).map((row) => String(row.tenant_id));
}

async function openPhase8Cursor(input: {
  resource: (typeof PHASE8_EXPORT_RESOURCES)[number];
  actorId: string;
  tenantId: string | null;
  filter: ExportFilter;
  pageSize: number;
}): Promise<ExportCursor> {
  if (isPhase8TenantResource(input.resource) && !input.tenantId) {
    throw new Error("EXPORT_TENANT_REQUIRED");
  }
  const spec = PHASE8_EXPORT_SPECS[input.resource];
  const client = createSupabaseServiceClient();
  const realTenantIds = spec.tenantColumn || input.resource === "notification-deliveries"
    ? await loadRealTenantIds()
    : [];
  if (input.tenantId && !realTenantIds.includes(input.tenantId)) {
    return { async nextPage() { return []; }, async close() {} };
  }
  let offset = 0;
  let exhausted = false;
  return {
    async nextPage() {
      if (exhausted) return [];
      let query = client.from(spec.table).select(spec.select);
      if (spec.testColumn) query = query.eq(spec.testColumn, false);
      if (spec.tenantColumn && input.tenantId) {
        query = query.eq(spec.tenantColumn, input.tenantId);
      } else if (spec.tenantColumn && spec.table !== "audit_log") {
        if (realTenantIds.length === 0) return [];
        query = query.in(spec.tenantColumn, realTenantIds);
      } else if (spec.table === "audit_log") {
        const realTenantFilter = realTenantIds.map((id) => `"${id}"`).join(",");
        query = query.or(realTenantFilter
          ? `tenant_id.is.null,tenant_id.in.(${realTenantFilter})`
          : "tenant_id.is.null");
      } else if (input.resource === "notification-deliveries") {
        if (realTenantIds.length === 0) return [];
        query = query.eq("notification.is_test", false)
          .in("notification.tenant_id", realTenantIds);
      }
      if (input.filter.search) {
        const searchColumn = input.resource === "audit-log"
          ? "reason"
          : input.resource === "support-threads" || input.resource === "success-client-book"
            ? input.resource === "support-threads" ? "subject" : "name"
            : null;
        if (searchColumn) query = query.ilike(searchColumn, `%${input.filter.search}%`);
      }
      if (input.filter.status && input.filter.status !== "all") {
        const statusColumn = input.resource === "alert-rules" ? "default_enabled" : "status";
        const statusValue = input.resource === "alert-rules"
          ? input.filter.status === "enabled"
          : input.filter.status;
        query = query.eq(statusColumn, statusValue);
      }
      if (input.filter.scope && input.filter.scope !== "all") query = query.eq("scope", input.filter.scope);
      if (input.filter.category) query = query.eq("category", input.filter.category);
      if (input.filter.destination && input.filter.destination !== "all") {
        query = query.eq("destination", input.filter.destination);
      }
      if (input.filter.action) query = query.eq("action", input.filter.action);
      if (input.filter.assignee) {
        query = query.eq(input.resource === "success-client-book" ? "success_owner" : "assigned_to", input.filter.assignee);
      }
      if (input.filter.book === "mine") {
        query = query.eq(input.resource === "success-client-book" ? "success_owner" : "assigned_to", input.actorId);
      }
      if (input.filter.threadId) query = query.eq("thread_id", input.filter.threadId);
      const { data, error } = await query
        .order(spec.orderColumn, { ascending: input.filter.order === "event_asc" })
        .order(spec.secondaryOrderColumn, { ascending: input.filter.order === "event_asc" })
        .range(offset, offset + input.pageSize - 1);
      if (error) throw new Error(`EXPORT_PAGE_READ_FAILED:${error.message}`);
      const raw = (data ?? []) as unknown as Record<string, unknown>[];
      const rows = raw.map((row) => phase8ExportRow(input.resource, row));
      if (input.resource === "success-client-book") {
        const ownerIds = [...new Set(raw.flatMap((row) => (typeof row.success_owner === "string"
          && row.success_owner.trim() ? [row.success_owner] : [])))];
        const ownerNames = await loadExportOwnerNames(client, ownerIds);
        for (const [index, row] of rows.entries()) {
          row.successOwner = exportOwnerLabel(raw[index].success_owner, ownerNames);
        }
      }
      offset += rows.length;
      exhausted = rows.length < input.pageSize;
      return rows;
    },
    async close() {},
  };
}

async function openRepositoryCursor(input: {
  resource: ExportResource;
  actorId: string;
  tenantId: string | null;
  filter: ExportFilter;
  pageSize: number;
}): Promise<ExportCursor> {
  if (isPhase8Resource(input.resource)) return openPhase8Cursor({ ...input, resource: input.resource });
  if (isPhase7PlatformResource(input.resource)) {
    return openPhase7PlatformCursor({
      resource: input.resource,
      actorId: input.actorId,
      pageSize: input.pageSize,
    });
  }
  // Ahead of the window-scoped Phase 7 branch for the same reason the composition branch is, and
  // ahead of `isPhase2Resource`, which is checked near the bottom, because that predicate would
  // route this resource into `openPhase2Cursor`, which has no table for it.
  if (isCoachTopObjectionsResource(input.resource)) {
    if (!input.tenantId) throw new Error("EXPORT_TENANT_REQUIRED");
    const rollup = await loadCoachTopObjections(
      input.actorId, input.tenantId, new Date().toISOString(),
    );
    const rows = coachTopObjectionExportRows(rollup) as unknown as ExportRow[];
    let offset = 0;
    return {
      async nextPage() {
        const page = rows.slice(offset, offset + input.pageSize);
        offset += page.length;
        return page;
      },
      async close() {},
    };
  }
  // Ahead of the window-scoped Phase 7 branch, because this resource has no window to demand
  // and `phase7MeasurementExportRows` takes a CoachMeasurement it will never be handed.
  if (isCoachCompositionResource(input.resource)) {
    if (!input.tenantId) throw new Error("EXPORT_TENANT_REQUIRED");
    const composition = await loadCoachLeadComposition(
      input.actorId, input.tenantId, new Date().toISOString(),
    );
    const rows = coachCompositionExportRows(composition) as unknown as ExportRow[];
    let offset = 0;
    return {
      async nextPage() {
        const page = rows.slice(offset, offset + input.pageSize);
        offset += page.length;
        return page;
      },
      async close() {},
    };
  }
  if (isPhase7TenantResource(input.resource)) {
    if (!input.tenantId || !input.filter.window) throw new Error("EXPORT_TENANT_REQUIRED");
    const snapshot = await loadCoachMeasurement(input.actorId, input.tenantId, {
      window: input.filter.window,
      customFrom: input.filter.from ?? null,
      customTo: input.filter.to ?? null,
      asOf: new Date().toISOString(),
    });
    const rows = phase7MeasurementExportRows(input.resource, snapshot);
    let offset = 0;
    return {
      async nextPage() {
        const page = rows.slice(offset, offset + input.pageSize);
        offset += page.length;
        return page;
      },
      async close() {},
    };
  }
  if (isPhase6Resource(input.resource)) return openPhase6Cursor({ ...input, resource: input.resource });
  if (isPhase5Resource(input.resource)) return openPhase5Cursor({ ...input, resource: input.resource });
  if (isPhase3Resource(input.resource)) return openPhase3Cursor({ ...input, resource: input.resource });
  if (isPhase4Resource(input.resource)) return openPhase4Cursor({ ...input, resource: input.resource });
  if (isPhase2Resource(input.resource)) return openPhase2Cursor({ ...input, resource: input.resource });
  if (!input.tenantId) throw new Error("EXPORT_TENANT_REQUIRED");
  const tenantId = input.tenantId;
  let conversationCursor: ConversationCursor | null = null;
  let contactCursor: ContactCursor | null = null;
  let exhausted = false;

  return {
    async nextPage() {
      if (exhausted) return [];
      const rows: ExportRow[] = [];
      while (rows.length < input.pageSize && !exhausted) {
        if (input.resource === "conversations") {
          const page = await listConversations(tenantId, {
            cursor: conversationCursor,
            limit: Math.min(100, input.pageSize - rows.length),
            objectionId: input.filter.objection ?? null,
          });
          rows.push(...page.items.filter((row) => conversationMatches(row, input.filter)).map(conversationExportRow));
          conversationCursor = page.nextCursor;
          exhausted = conversationCursor === null;
        } else {
          const page = await listContacts(tenantId, {
            cursor: contactCursor,
            limit: Math.min(100, input.pageSize - rows.length),
          });
          rows.push(...page.items.filter((row) => contactMatches(row, input.filter)).map(contactExportRow));
          contactCursor = page.nextCursor;
          exhausted = contactCursor === null;
        }
      }
      return rows;
    },
    async close() {},
  };
}

async function startExport(input: Parameters<ExportDependencies["start"]>[0]) {
  const client = createSupabaseServiceClient();
  if (input.auditMode === "affiliate") {
    const { data, error } = await client.from("audit_log").insert({
      actor_id: input.actorId,
      tenant_id: null,
      action: "export.started",
      target_type: "affiliate_export",
      target_id: input.resource,
      payload: { filter: input.filter, format: input.format, columns: input.columns },
    }).select("id").single();
    if (error || !data?.id) throw new Error("AFFILIATE_EXPORT_START_FAILED");
    return String(data.id);
  }
  const platform = input.auditMode === "platform" || input.auditMode === "platform_tenant";
  if (platform && !input.reason) throw new Error("PLATFORM_EXPORT_REASON_REQUIRED");
  if (input.auditMode === "platform_tenant" && !input.subjectTenantId) {
    throw new Error("PLATFORM_EXPORT_SUBJECT_TENANT_REQUIRED");
  }
  if (input.auditMode === "tenant" && !input.tenantId) throw new Error("EXPORT_TENANT_REQUIRED");
  const { data, error } = platform
    ? await client.rpc("start_platform_export", {
        p_actor_id: input.actorId,
        p_resource: input.resource,
        p_filter: { ...input.filter, format: input.format },
        p_columns: input.columns,
        p_reason: input.reason!,
        p_subject_tenant: input.subjectTenantId,
      })
    : await client.rpc("start_export", {
        p_expected_tenant: input.tenantId!,
        p_actor_id: input.actorId,
        p_resource: input.resource,
        p_filter: { ...input.filter, format: input.format },
        p_columns: input.columns,
      });
  if (error || data === null || data === undefined) {
    throw new Error(`EXPORT_START_FAILED:${error?.message ?? "missing audit id"}`);
  }
  return String(data);
}

async function finishExport(input: Parameters<ExportDependencies["finish"]>[0]) {
  const client = createSupabaseServiceClient();
  if (input.auditMode === "affiliate") {
    const { data: started, error: startedError } = await client.from("audit_log")
      .select("id,actor_id,action,target_type,target_id")
      .eq("id", input.startedAuditId)
      .eq("actor_id", input.actorId)
      .eq("action", "export.started")
      .eq("target_type", "affiliate_export")
      .eq("target_id", input.resource)
      .maybeSingle();
    if (startedError || !started) throw new Error("AFFILIATE_EXPORT_START_NOT_FOUND");
    const { error } = await client.from("audit_log").insert({
      actor_id: input.actorId,
      tenant_id: null,
      action: "export.finished",
      target_type: "affiliate_export",
      target_id: input.resource,
      payload: {
        started_audit_id: input.startedAuditId,
        row_count: input.rowCount,
        byte_count: input.byteCount,
      },
    });
    if (error) throw new Error("AFFILIATE_EXPORT_FINISH_FAILED");
    return;
  }
  const platform = input.auditMode === "platform" || input.auditMode === "platform_tenant";
  if (platform && !input.reason) throw new Error("PLATFORM_EXPORT_REASON_REQUIRED");
  if (input.auditMode === "platform_tenant" && !input.subjectTenantId) {
    throw new Error("PLATFORM_EXPORT_SUBJECT_TENANT_REQUIRED");
  }
  if (input.auditMode === "tenant" && !input.tenantId) throw new Error("EXPORT_TENANT_REQUIRED");
  const { error } = platform
    ? await client.rpc("finish_platform_export", {
        p_actor_id: input.actorId,
        p_export_id: input.startedAuditId,
        p_rows: input.rowCount,
        p_bytes: input.byteCount,
        p_reason: input.reason!,
        p_subject_tenant: input.subjectTenantId,
      })
    : await client.rpc("finish_export", {
        p_expected_tenant: input.tenantId!,
        p_actor_id: input.actorId,
        p_started_audit_id: input.startedAuditId,
        p_resource: input.resource,
        p_row_count: input.rowCount,
        p_byte_count: input.byteCount,
      });
  if (error) throw new Error(`EXPORT_FINISH_FAILED:${error.message}`);
}

async function exportSession(): Promise<ExportActor | null> {
  const actor = await loadRouteActor();
  if (actor?.role) {
    return {
      userId: actor.userId,
      tenantId: actor.tenantId,
      role: actor.role,
      affiliateAccess: actor.affiliateAccess,
    };
  }
  const capabilityActor = await loadCapabilityActor();
  if (!capabilityActor?.role) return null;
  return {
    userId: capabilityActor.userId,
    tenantId: null,
    role: capabilityActor.role,
    affiliateAccess: capabilityActor.affiliateAccess,
  };
}

export function createExportHandler(dependencies: ExportDependencies) {
  return async function GET(request: Request, context: { params: Promise<{ resource: string }> }) {
    const noStore = { "Cache-Control": "no-store" };
    const resource = parseResource((await context.params).resource);
    if (!resource) {
      return Response.json({ error: "Export request was refused." }, { status: 400, headers: noStore });
    }
    if (!dependencies.enabled(resource)) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStore });
    }
    const actor = await dependencies.session();
    if (!actor) return Response.json({ error: "Authentication required." }, { status: 401, headers: noStore });
    const affiliateReferralExport = resource === "affiliate-referrals";
    // Phase 6: the affiliate projection is the single allowlisted affiliate export and derives
    // its identity from the session-bound repository. It must be checked before the blanket role refusal.
    //
    // Gated on the `affiliates` row, never on `role = 'affiliate'` (T15-13, `docs/DECISIONS.md:277`),
    // and through the same predicate `/affiliate` and `GET /api/affiliate/referrals` use, because
    // this export is the Copy/Export control drawn on that page: a dual-role coach who can open the
    // portal and read the table must be able to export the rows they are already looking at. The
    // rows come from `listOwnReferrals()`, which takes no argument and selects the affiliate inside
    // PostgreSQL, so admitting the coach widens who may ask and not what comes back.
    if (affiliateReferralExport && !canAccessWorkspace(actor.role, "affiliate", {
      affiliateAccess: actor.affiliateAccess,
    })) {
      return Response.json({ error: "Export is not available for this role." }, { status: 403, headers: noStore });
    }
    if (actor.role === "build" || (actor.role === "affiliate" && !affiliateReferralExport)) {
      return Response.json({ error: "Export is not available for this role." }, { status: 403, headers: noStore });
    }
    if (isOwnerAdminResource(resource) && actor.role !== "owner" && actor.role !== "admin") {
      return Response.json({ error: "Platform export refused." }, { status: 403, headers: noStore });
    }

    try {
      const parsed = parseRequest(request, resource);
      const platform = isPlatformResource(resource);
      const platformActor = ["owner", "admin", "success"].includes(actor.role);
      if (platform && !["owner", "admin", "success"].includes(actor.role)) {
        return Response.json({ error: "Platform export refused." }, { status: 403, headers: noStore });
      }
      if (platform && (parsed.requestedTenantId || !parsed.reason)) {
        return Response.json({ error: "Platform export reason is required." }, { status: 400, headers: noStore });
      }
      if (!platform && !affiliateReferralExport && !actor.tenantId && !platformActor) {
        return Response.json({ error: "Tenant export refused." }, { status: 403, headers: noStore });
      }
      if (!platform && !affiliateReferralExport && !platformActor
        && parsed.requestedTenantId && parsed.requestedTenantId !== actor.tenantId) {
        return Response.json({ error: "Cross-tenant export refused." }, { status: 403, headers: noStore });
      }
      if (affiliateReferralExport && parsed.requestedTenantId) {
        return Response.json({ error: "Affiliate export refused." }, { status: 400, headers: noStore });
      }
      if (!platform && !affiliateReferralExport && platformActor
        && (!parsed.requestedTenantId || !parsed.reason)) {
        return Response.json(
          { error: "Named-tenant platform export requires tenantId and reason." },
          { status: 400, headers: noStore },
        );
      }
      const namedTenantPlatformExport = !platform && !affiliateReferralExport && platformActor;
      const exportTenantId = affiliateReferralExport
        ? null
        : namedTenantPlatformExport
          ? parsed.requestedTenantId
          : platform
            ? null
            : actor.tenantId;
      const auditMode: ExportAuditMode = affiliateReferralExport
        ? "affiliate"
        : namedTenantPlatformExport
          ? "platform_tenant"
          : platform
            ? "platform"
            : "tenant";
      const auditReason = auditMode === "platform" || auditMode === "platform_tenant"
        ? parsed.reason
        : null;
      const subjectTenantId = auditMode === "platform_tenant" ? exportTenantId : null;
      const startedAuditId = await dependencies.start({
        tenantId: exportTenantId,
        actorId: actor.userId,
        resource,
        format: parsed.format,
        filter: parsed.filter,
        columns: parsed.columns,
        reason: auditReason,
        auditMode,
        subjectTenantId,
      });
      const cursor = await dependencies.openCursor({
        resource,
        actorId: actor.userId,
        tenantId: exportTenantId,
        filter: parsed.filter,
        pageSize: PAGE_SIZE,
      });
      const body = streamExport({
        cursor,
        signal: request.signal,
        format: parsed.format,
        columns: parsed.columns,
        finish: (rowCount, byteCount) => dependencies.finish({
          tenantId: exportTenantId,
          actorId: actor.userId,
          startedAuditId,
          resource,
          rowCount,
          byteCount,
          reason: auditReason,
          auditMode,
          subjectTenantId,
        }),
      });
      const extension = parsed.format;
      return new Response(body, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="setterfi-${resource}.${extension}"`,
          "Content-Type": parsed.format === "csv"
            ? "text/csv; charset=utf-8"
            : "application/json; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return Response.json(
        { error: "Export request was refused." },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
  };
}

export function exportResourceEnabled(
  resource: ExportResource,
  environment: EnvironmentSource = process.env,
) {
  return isPhase8Resource(resource)
    ? phase8ExportsLive(environment)
    : isPhase7PlatformResource(resource)
    ? isEvalComparisonResource(resource)
      ? phase7EvalsLive(environment)
      : phase7AnalyticsLive(environment)
    : isPhase7TenantResource(resource) || isCoachCompositionResource(resource)
    ? phase7AnalyticsLive(environment)
    // Ahead of the isPhase2Resource fallthrough so the child flag is actually consulted.
    // brainObjectionsLive already requires phase2Live, so the nesting holds without restating it.
    : isCoachTopObjectionsResource(resource)
    ? brainObjectionsLive(environment)
    : isPhase6Resource(resource)
    ? phase6Live(environment)
      && (resource !== "affiliate-referrals" || phase6AffiliatesLive(environment))
    : isPhase5Resource(resource)
    ? phase5Live(environment)
    : isPhase3Resource(resource)
    ? phase1Live(environment) && phase3Live(environment)
    : isPhase4Resource(resource)
    ? phase4Live(environment)
    : isPhase2Resource(resource) ? phase2Live(environment) : phase1Live(environment);
}

export const GET = createExportHandler({
  enabled: exportResourceEnabled,
  session: exportSession,
  openCursor: openRepositoryCursor,
  start: startExport,
  finish: finishExport,
});
