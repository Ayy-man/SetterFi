import { RESOURCE_COLUMNS } from "@/app/api/exports/[resource]/handler";
import type { ServerExportMenuProps } from "@/components/kit/export-menu";

export type RenderedTableExport = {
  surface: string;
  resource: ServerExportMenuProps["resource"];
  formats: readonly ["csv", "json"];
  columns: readonly string[];
  filterKeys: readonly string[];
  sort: "last_activity_desc" | "created_desc" | "version_desc" | "event_asc";
};

function renderedTable(
  surface: string,
  resource: ServerExportMenuProps["resource"],
  filterKeys: readonly string[],
  sort: RenderedTableExport["sort"],
  columns: readonly string[] = RESOURCE_COLUMNS[resource],
): RenderedTableExport {
  return { surface, resource, formats: ["csv", "json"], columns, filterKeys, sort };
}

const live = "src/components/workspace/live";
const rehaul = "src/components/workspace/rehaul";

/**
 * Source-owned inventory of every server ExportMenu rendered by the live components, the rehaul
 * components, and the workspace routes. The paired test derives the same contract from TSX syntax
 * across all three trees, so either side fails when a rendered table changes independently.
 */
export const LIVE_RENDERED_TABLE_EXPORTS = [
  renderedTable(`${live}/admin-compliance.tsx#suppression-tombstones`, "suppression-tombstones", [], "created_desc"),
  renderedTable(`${live}/admin-overview.tsx#platform-guardrail-rules`, "platform-guardrail-rules", [], "created_desc", [
    "dataOrigin", "ruleKey", "label", "fires", "blocks", "holds",
  ]),
  renderedTable(`${live}/admin-overview.tsx#platform-followup-performance`, "platform-followup-performance", [], "created_desc", [
    "dataOrigin", "touchNo", "sent", "replied", "crossChannel", "exhausted",
  ]),
  renderedTable(`${live}/admin-overview.tsx#platform-provisioning-performance`, "platform-provisioning-performance", [], "created_desc", [
    "dataOrigin", "stepKey", "state", "attempts", "failures", "medianDaysToClear",
  ]),
  renderedTable(`${live}/admin-overview.tsx#platform-subscriptions`, "platform-subscriptions", [], "created_desc", [
    "dataOrigin", "tenantId", "subscriptionId", "status", "stripePriceId", "periodStart", "periodEnd",
  ]),
  renderedTable(`${live}/admin-money-tiers.tsx#billing-tiers`, "billing-tiers", [], "created_desc"),
  renderedTable(`${live}/admin-money-billing.tsx#platform-billing`, "platform-billing", [], "created_desc"),
  renderedTable(`${live}/admin-money-billing-costs.tsx#billing-cost-rollups`, "billing-cost-rollups", [], "created_desc", [
    "rollupId", "tenantId", "businessName", "windowStart", "windowEnd", "revenueCents", "modelCostCents",
    "messagingCostCents", "embeddingCostCents", "complete", "missingSources", "sourceEvidenceAt", "dataLabel",
  ]),
  renderedTable(`${live}/admin-money-corrections.tsx#billing-corrections`, "billing-corrections", [], "created_desc", [
    "requestId", "tenantId", "billableEventId", "quantityDelta", "reason", "requestedAt", "requestAuditId",
    "decision", "decisionReason", "decisionId", "decisionAuditId", "offsetEventId", "dataLabel",
  ]),
  renderedTable(`${live}/admin-money-affiliates.tsx#affiliate-payouts`, "affiliate-payouts", [], "created_desc"),
  renderedTable(`${live}/admin-testing.tsx#eval-comparisons`, "eval-comparisons", [], "created_desc"),
  renderedTable(`${live}/admin-testing.tsx#eval-comparison-results`, "eval-comparison-results", [], "created_desc"),
  renderedTable(`${live}/affiliate-money.tsx#affiliate-referrals`, "affiliate-referrals", [], "created_desc", [
    "businessName", "accountStatus", "commissionEarnedUsd",
  ]),
  renderedTable(`${live}/coach-keyword-goals.tsx#keyword-goals`, "keyword-goals", [], "created_desc"),
  /*
   * Six rows left with their files, and every export they carried came back.
   *
   * `coach-conversations.tsx`, `coach-measurement.tsx` and `coach-offer.tsx` were deleted in the
   * rehaul, and for a while only the keyword table returned with its export. The other five are
   * listed below among the rehaul entries: `conversations` on `rehaul/coach-inbox.tsx`, and
   * `offer-prices`, `offer-proof`, `offer-assets` and `coach-top-objections` on
   * `rehaul/coach-agent.tsx`. No server export route in this set is without a control that calls
   * it.
   */
  // Phase 8
  renderedTable(`${live}/admin-support.tsx#support-messages`, "support-messages", ["threadId"], "created_desc"),
  renderedTable(`${live}/admin-support.tsx#support-threads`, "support-threads", ["book", "status"], "created_desc"),
  renderedTable(`${live}/admin-audit-log.tsx#audit-log`, "audit-log", ["action"], "created_desc"),
  renderedTable(`${live}/success-client-book.tsx#success-client-book`, "success-client-book", ["book"], "created_desc"),
  renderedTable(`${live}/coach-support.tsx#coach-support-messages`, "coach-support-messages", ["threadId"], "created_desc"),
  renderedTable(`${live}/alert-settings.tsx#notification-rules`, "notification-rules", [], "event_asc", [
    "event", "scope", "bell", "email", "slack", "required",
  ]),
  renderedTable(`${live}/admin-system-health.tsx#notification-deliveries`, "notification-deliveries", [], "created_desc", [
    "event", "destination", "state", "attempts", "lastAttemptAt", "deliveredAt", "testData",
  ]),

  /*
   * The rehaul shell's own tables.
   *
   * The walk used to cover `workspace/live` and `app/(workspace)` only, so every table the rehaul
   * screens draw sat outside this inventory: a rehaul table could ship without an export, or with
   * a column its resource cannot serve, and nothing here would say so. The rehaul surfaces are
   * what a client opens now, so they are held to the same contract as the live ones.
   */
  renderedTable(`${rehaul}/affiliate-home.tsx#affiliate-referrals`, "affiliate-referrals", [], "created_desc", [
    "businessName", "accountStatus", "commissionEarnedUsd",
  ]),
  renderedTable(`${rehaul}/coach-agent.tsx#coach-top-objections`, "coach-top-objections", [], "created_desc"),
  renderedTable(`${rehaul}/coach-agent.tsx#offer-assets`, "offer-assets", [], "created_desc"),
  renderedTable(`${rehaul}/coach-agent.tsx#offer-prices`, "offer-prices", [], "created_desc"),
  renderedTable(`${rehaul}/coach-agent.tsx#offer-proof`, "offer-proof", [], "created_desc"),
  renderedTable(`${rehaul}/coach-dashboard.tsx#coach-measurement-keywords`, "coach-measurement-keywords", ["from", "to", "window"], "created_desc", [
    "keyword", "conversations", "qualifiedContacts", "respondedConversations", "bookedContacts", "optInDenominator", "qualifiedDenominator", "bookedDenominator", "dataLabel",
  ]),
  renderedTable(`${rehaul}/coach-inbox.tsx#conversations`, "conversations", ["search"], "last_activity_desc"),
  renderedTable(`${rehaul}/owner-audit.tsx#audit-log`, "audit-log", ["action", "search"], "created_desc", [
    "action", "actor", "target", "reason", "at", "testData",
  ]),
  renderedTable(`${rehaul}/owner-brain.tsx#brain-import-batches`, "brain-import-batches", [], "created_desc", [
    "id", "source", "status", "receivedCount", "normalizedCount", "flaggedCount", "createdAt", "completedAt",
  ]),
  renderedTable(`${rehaul}/owner-brain.tsx#brain-import-items`, "brain-import-items", [], "created_desc", [
    "id", "batchId", "sourceRef", "operation", "decision", "disposition", "flagCount", "decidedAt",
  ]),
  renderedTable(`${rehaul}/owner-brain.tsx#brain-knowledge-entries`, "brain-knowledge-entries", ["status"], "created_desc", [
    "id", "category", "source", "sourceRef", "disposition", "status", "question", "responseTemplate",
  ]),
  renderedTable(`${rehaul}/owner-brain.tsx#brain-objections`, "brain-objections", ["status"], "created_desc", [
    "id", "label", "category", "hardGate", "status", "matchKeywords", "response", "publishedAt",
  ]),
  renderedTable(`${rehaul}/owner-brain.tsx#brain-snapshot-diffs`, "brain-snapshot-diffs", [], "version_desc", [
    "version", "contentHash", "sourceHash", "knowledgeMode", "publishedAt", "rollbackOfSnapshotId",
  ]),
  renderedTable(`${rehaul}/owner-brain.tsx#brain-snapshots`, "brain-snapshots", [], "version_desc", [
    "id", "version", "contentHash", "sourceHash", "knowledgeMode", "platformTokens", "publishedAt", "rollbackOfSnapshotId",
  ]),
  renderedTable(`${rehaul}/owner-clients.tsx#success-client-book`, "success-client-book", ["book"], "created_desc", [
    "client", "status", "successOwner", "supportStatus", "updatedAt",
  ]),
  renderedTable(`${rehaul}/owner-compliance.tsx#suppression-tombstones`, "suppression-tombstones", [], "created_desc", [
    "id", "tenantId", "channel", "identifierLast4", "deletionAuditId", "createdAt",
  ]),
] as const satisfies readonly RenderedTableExport[];
