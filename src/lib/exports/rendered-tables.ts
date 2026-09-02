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

/**
 * Source-owned inventory of every live server ExportMenu. The paired test derives the same
 * contract from TSX syntax, so either side fails when a rendered table changes independently.
 */
export const LIVE_RENDERED_TABLE_EXPORTS = [
  renderedTable(`${live}/admin-brain.tsx#brain-import-batches`, "brain-import-batches", [], "created_desc", [
    "id", "source", "status", "receivedCount", "normalizedCount", "flaggedCount", "createdAt", "completedAt",
  ]),
  renderedTable(`${live}/admin-brain.tsx#brain-import-items`, "brain-import-items", [], "created_desc", [
    "id", "batchId", "sourceRef", "operation", "decision", "disposition", "flagCount", "decidedAt",
  ]),
  renderedTable(`${live}/admin-brain.tsx#brain-knowledge-entries`, "brain-knowledge-entries", ["status"], "created_desc", [
    "id", "category", "source", "sourceRef", "disposition", "status", "question", "responseTemplate",
  ]),
  renderedTable(`${live}/admin-brain.tsx#brain-objections`, "brain-objections", ["status"], "created_desc", [
    "id", "label", "category", "hardGate", "status", "matchKeywords", "response", "publishedAt",
  ]),
  renderedTable(`${live}/admin-brain.tsx#brain-snapshots`, "brain-snapshots", [], "version_desc", [
    "id", "version", "contentHash", "sourceHash", "knowledgeMode", "platformTokens", "publishedAt", "rollbackOfSnapshotId",
  ]),
  renderedTable(`${live}/admin-brain.tsx#brain-snapshot-diffs`, "brain-snapshot-diffs", [], "version_desc", [
    "version", "contentHash", "sourceHash", "knowledgeMode", "publishedAt", "rollbackOfSnapshotId",
  ]),
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
  renderedTable(`${live}/admin-agent-performance.tsx#platform-tenant-performance`, "platform-tenant-performance", [], "created_desc", [
    "dataOrigin", "tenantId", "bookedAppointments", "grossMrrCents", "commissionCents", "marginCents", "marginState",
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
  renderedTable(`${live}/coach-conversations.tsx#conversations`, "conversations", ["channel", "objection", "outcome", "search", "stage"], "last_activity_desc"),
  renderedTable(`${live}/coach-measurement.tsx#coach-measurement-keywords`, "coach-measurement-keywords", ["from", "to", "window"], "created_desc"),
  renderedTable(`${live}/coach-keyword-goals.tsx#keyword-goals`, "keyword-goals", [], "created_desc"),
  renderedTable(`${live}/coach-offer.tsx#offer-prices`, "offer-prices", [], "created_desc"),
  renderedTable(`${live}/coach-offer.tsx#offer-proof`, "offer-proof", [], "created_desc"),
  renderedTable(`${live}/coach-offer.tsx#offer-assets`, "offer-assets", [], "created_desc"),
  renderedTable(`${live}/coach-offer.tsx#coach-top-objections`, "coach-top-objections", [], "created_desc"),
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
] as const satisfies readonly RenderedTableExport[];
