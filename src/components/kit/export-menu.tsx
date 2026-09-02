"use client";

import { ChevronDown, Download, FileJson } from "@/components/kit/icons";

import { useState } from "react";

import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";
import { cn } from "@/lib/utils";

type ExportRow = Record<string, unknown>;

/**
 * `label` names this export when a surface carries more than one. The default is the bare word,
 * because a table with a single export needs no qualifier; a page with two does, and two controls
 * both called "Export table" is the same as neither of them being named.
 */
export type LocalExportMenuProps = {
  mode: "local";
  filename: string;
  rows: ExportRow[];
  className?: string;
  label?: string;
};

type ServerExportBase = {
  mode: "server";
  filename: string;
  className?: string;
  label?: string;
};

type CommonServerQuery = {
  search?: string;
  columns?: string[];
  reason?: string;
  tenantId?: string;
};

export type ServerExportMenuProps = ServerExportBase & (
  | {
      resource: "conversations";
      query?: CommonServerQuery & {
        channel?: string;
        outcome?: string;
        stage?: string;
        objection?: string;
        order?: "last_activity_desc";
      };
    }
  | {
      resource: "contacts";
      query?: CommonServerQuery & { status?: string; order?: "last_activity_desc" };
    }
  | {
      resource: "brain-import-batches" | "brain-import-items" | "brain-knowledge-entries" | "brain-objections";
      query: CommonServerQuery & { status?: string; order?: "created_desc"; reason: string };
    }
  | {
      resource: "brain-snapshots" | "brain-snapshot-diffs";
      query: CommonServerQuery & { order?: "version_desc"; reason: string };
    }
  | {
      resource: "eval-gate-results";
      query: CommonServerQuery & { order?: "created_desc"; reason: string };
    }
  | {
      resource: "keyword-goals" | "offer-prices" | "offer-proof" | "offer-assets";
      query?: CommonServerQuery & { order?: "created_desc" };
    }
  // Phase 4
  | {
      resource: "contact-identities";
      query?: CommonServerQuery & {
        channel?: string;
        status?: string;
        order?: "created_desc";
      };
    }
  | {
      resource: "suspected-duplicates";
      query?: CommonServerQuery & { status?: string; order?: "created_desc" };
    }
  | {
      resource: "message-templates" | "channel-connections";
      query?: CommonServerQuery & {
        channel?: string;
        status?: string;
        order?: "created_desc";
      };
    }
  | {
      resource: "merge-history";
      query?: CommonServerQuery & { order?: "created_desc" };
    }
  // Phase 3
  | {
      resource: "followups";
      query?: CommonServerQuery & { status?: string; order?: "created_desc" };
    }
  | {
      resource: "suppression-tombstones";
      query: CommonServerQuery & { order?: "created_desc"; reason: string };
    }
  // Phase 5
  | {
      resource:
        | "provisioning-steps"
        | "signup-intents"
        | "onboarding-runs"
        | "business-profiles"
        | "onboarding-optin-artifacts"
        | "onboarding-content-screens"
        | "a2p-probe-receipts";
      query: CommonServerQuery & { order?: "created_desc"; reason: string };
    }
  // Phase 6
  | {
      resource:
        | "billing-tiers"
        | "platform-billing"
        | "billing-corrections"
        | "affiliate-payouts"
        | "billing-cost-rollups";
      query: CommonServerQuery & { order?: "created_desc"; reason: string };
    }
  | {
      resource: "affiliate-referrals";
      query?: CommonServerQuery & { order?: "created_desc" };
    }
  // Phase 7
  | {
      resource: "coach-measurement-keywords" | "coach-measurement-steps" | "coach-pipeline";
      query?: CommonServerQuery & {
        window?: "1d" | "1w" | "1m" | "3m" | "all" | "custom";
        from?: string;
        to?: string;
      };
    }
  | {
      // Fixed to the last six calendar months, so it carries no window keys at all.
      resource: "coach-lead-composition";
      query?: CommonServerQuery & { order?: "event_asc" };
    }
  // Phase 10
  | {
      // Fixed to a trailing 30 days anchored at the request's own clock reading, so like the
      // composition it carries no window keys.
      resource: "coach-top-objections";
      query?: CommonServerQuery & { order?: "created_desc" };
    }
  // Phase 7 platform
  | {
      resource:
        | "eval-comparisons"
        | "eval-comparison-results"
        | "platform-subscriptions"
        | "platform-tenant-performance"
        | "platform-guardrail-rules"
        | "platform-followup-performance"
        | "platform-provisioning-performance";
      query: CommonServerQuery & { order?: "created_desc"; reason: string };
    }
  // Phase 8
  | {
      resource: "coach-support-messages";
      query?: CommonServerQuery & {
        order?: "created_desc";
        threadId?: string;
      };
    }
  | {
      resource:
        | "alert-rules"
        | "audit-log"
        | "notification-deliveries"
        | "notification-rules"
        | "support-messages"
        | "support-threads"
        | "success-client-book";
      query: CommonServerQuery & {
        order?: "created_desc" | "event_asc" | "updated_desc" | "at_desc";
        reason: string;
        scope?: "all" | "tenant" | "platform";
        category?: string;
        destination?: "all" | "bell" | "email" | "slack";
        status?: string;
        book?: "mine" | "all";
        action?: string;
        assignee?: string;
        threadId?: string;
      };
    }
);

export type ExportMenuProps = LocalExportMenuProps | ServerExportMenuProps;

function safeBaseName(filename: string) {
  const withoutExtension = filename.replace(/\.(csv|json)$/i, "");
  return withoutExtension.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "export";
}

function spreadsheetSafeValue(value: unknown) {
  if (value === null || value === undefined) return "";

  const serialized =
    value instanceof Date
      ? value.toISOString()
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);

  return /^\s*[=+\-@]/.test(serialized) || /^[\t\r\n]/.test(serialized)
    ? `'${serialized}`
    : serialized;
}

function csvCell(value: unknown) {
  return `"${spreadsheetSafeValue(value).replaceAll('"', '""')}"`;
}

function rowsToCsv(rows: ExportRow[]) {
  const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  if (headers.length === 0) return "";

  return [
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ].join("\r\n");
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadBlob(contents: string, filename: string, type: string) {
  saveBlob(new Blob([contents], { type }), filename);
}

type ServerQuery = CommonServerQuery & {
  channel?: string;
  outcome?: string;
  stage?: string;
  status?: string;
  objection?: string;
  order?: "last_activity_desc" | "created_desc" | "version_desc" | "event_asc" | "updated_desc" | "at_desc";
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

function serverExportHref(
  resource: ServerExportMenuProps["resource"],
  format: "csv" | "json",
  query: ServerQuery | undefined,
) {
  const params = new URLSearchParams({ format });
  if (query?.search) params.set("search", query.search);
  if (query?.channel) params.set("channel", query.channel);
  if (query?.outcome) params.set("outcome", query.outcome);
  if (query?.stage) params.set("stage", query.stage);
  if (query?.status) params.set("status", query.status);
  if (query?.objection) params.set("objection", query.objection);
  if (query?.order) params.set("order", query.order);
  if (query?.columns?.length) params.set("columns", query.columns.join(","));
  if (query?.reason?.trim()) params.set("reason", query.reason.trim());
  if (query?.window) params.set("window", query.window);
  if (query?.from) params.set("from", query.from);
  if (query?.to) params.set("to", query.to);
  if (query?.tenantId) params.set("tenantId", query.tenantId);
  if (query?.scope) params.set("scope", query.scope);
  if (query?.category) params.set("category", query.category);
  if (query?.destination) params.set("destination", query.destination);
  if (query?.book) params.set("book", query.book);
  if (query?.action) params.set("action", query.action);
  if (query?.assignee) params.set("assignee", query.assignee);
  if (query?.threadId) params.set("threadId", query.threadId);
  return `/api/exports/${resource}?${params.toString()}`;
}

/**
 * An export route can refuse: the resource's flag is off in this environment (404), the session
 * is not allowed to read it, or the request is rejected. A plain `<a download>` saves whatever
 * comes back, so a refusal used to land on disk as a file named like a real export containing
 * `{"error":"Not found."}`. Fetch it first, and only write a file once the response says it is
 * one.
 */
const EXPORT_DISABLED_MESSAGE =
  "Exports are not enabled in this environment. No file was saved.";
const EXPORT_FAILED_MESSAGE = "The export did not complete. No file was saved.";

type ServerExportResult =
  | { ok: true; blob: Blob }
  | { ok: false; message: string };

async function fetchServerExport(
  href: string,
  format: "csv" | "json",
): Promise<ServerExportResult> {
  const expectedType = format === "csv" ? "text/csv" : "application/json";
  let response: Response;
  try {
    response = await fetch(href, { headers: { accept: expectedType } });
  } catch {
    return { ok: false, message: EXPORT_FAILED_MESSAGE };
  }

  if (response.status === 404) return { ok: false, message: EXPORT_DISABLED_MESSAGE };
  if (!response.ok) return { ok: false, message: EXPORT_FAILED_MESSAGE };
  if (!(response.headers.get("content-type") ?? "").toLowerCase().includes(expectedType)) {
    return { ok: false, message: EXPORT_FAILED_MESSAGE };
  }

  try {
    return { ok: true, blob: await response.blob() };
  } catch {
    return { ok: false, message: EXPORT_FAILED_MESSAGE };
  }
}

async function downloadServerExport(
  href: string,
  filename: string,
  format: "csv" | "json",
) {
  const result = await fetchServerExport(href, format);
  if (!result.ok) return result.message;
  saveBlob(result.blob, filename);
  return null;
}

function queryRequiresReason(props: ServerExportMenuProps) {
  return props.query !== undefined && Object.prototype.hasOwnProperty.call(props.query, "reason");
}

export function ExportMenu(props: ExportMenuProps) {
  const { filename, className, label } = props;
  const baseName = safeBaseName(filename);
  const hasRows = props.mode === "server" || props.rows.length > 0;
  const requiredReason = props.mode === "server" && queryRequiresReason(props);
  const suppliedReason = props.mode === "server" ? props.query?.reason ?? "" : "";
  const exportIdentity = props.mode === "server"
    ? `${filename}:${serverExportHref(props.resource, "csv", props.query as ServerQuery)}`
    : `local:${filename}`;
  const [reasonDraft, setReasonDraft] = useState<{ identity: string; value: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const reason = reasonDraft?.identity === exportIdentity ? reasonDraft.value : suppliedReason;
  const serverAuditAction = requiredReason
    ? AUDIT_ACTIONS["platform_export.started"]
    : AUDIT_ACTIONS["export.started"];

  const canExport = hasRows && (!requiredReason || reason.trim().length > 0);

  function exportLocal(format: "csv" | "json") {
    if (props.mode !== "local" || !canExport) return;
    setFailure(null);
    if (format === "csv") {
      downloadBlob(`\uFEFF${rowsToCsv(props.rows)}`, `${baseName}.csv`, "text/csv;charset=utf-8");
      return;
    }
    downloadBlob(JSON.stringify(props.rows, null, 2), `${baseName}.json`, "application/json;charset=utf-8");
  }

  async function exportServer(format: "csv" | "json") {
    if (props.mode !== "server" || !canExport) return;
    setFailure(null);
    const query = { ...props.query, ...(requiredReason ? { reason: reason.trim() } : {}) } as ServerQuery;
    const message = await downloadServerExport(
      serverExportHref(props.resource, format, query),
      `${baseName}.${format}`,
      format,
    );
    if (message === null) return;
    // The item press already closed the menu, so the message is put back where the export was
    // asked for rather than left somewhere the click never was.
    setFailure(message);
    setOpen(true);
  }

  return (
    <DropdownMenu
      onOpenChange={(nextOpen, details) => {
        if (details.reason !== "trigger-press") setOpen(nextOpen);
      }}
      open={open}
    >
      <DropdownMenuTrigger
        aria-label={label ?? "Export table"}
        className={cn(
          buttonVariants({ variant: "outline" }),
          "gap-[var(--s-2)]",
          className,
        )}
        disabled={!hasRows}
        onClick={() => {
          setFailure(null);
          setOpen((current) => !current);
        }}
      >
        <Download aria-hidden className="size-[var(--s-4)]" />
        {label ?? "Export"}
        <ChevronDown aria-hidden className="size-[var(--s-4)]" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        aria-label="Export options"
        className="w-[var(--drawer-w)] max-w-[calc(100vw-var(--s-6))] rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--raised)] p-[var(--s-1)] shadow-[var(--shadow-raised)] duration-[var(--duration-quick)] ease-[var(--ease-out)] motion-reduce:animate-none motion-reduce:transition-none"
        role="menu"
      >
        {requiredReason ? (
          <div className="space-y-[var(--s-2)] p-[var(--s-2)]">
            <label className="block text-[length:var(--t-body)] font-[var(--t-body-w)] text-[var(--body)]" htmlFor={`${baseName}-export-reason`}>
              Export reason
            </label>
            <Input
              aria-describedby={`${baseName}-export-reason-help`}
              id={`${baseName}-export-reason`}
              onChange={(event) => setReasonDraft({ identity: exportIdentity, value: event.target.value })}
              onKeyDown={(event) => {
                if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
              }}
              placeholder="Add a reason to enable export"
              value={reason}
            />
            <p className="text-[length:var(--t-body)] font-[var(--t-body-w)] text-[var(--muted)]" id={`${baseName}-export-reason-help`}>
              Required for this export.
            </p>
          </div>
        ) : (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Choose a format</DropdownMenuLabel>
          </DropdownMenuGroup>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!canExport}
          onClick={() => { if (props.mode === "local") { exportLocal("csv"); return; } void exportServer("csv"); }}
        >
          <Download aria-hidden />
          <span className="flex flex-col">
            <span>Download CSV</span>
            <span className="text-[length:var(--t-body)] font-[var(--t-body-w)] text-[var(--muted)]">
              {props.mode === "local" ? "Current rows" : "All matching rows"}
            </span>
            {props.mode === "server" ? (
              <span className="text-[length:var(--t-body)] font-[var(--t-body-w)] text-[var(--muted)]">
                {serverAuditAction.microcopy}
              </span>
            ) : null}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!canExport}
          onClick={() => { if (props.mode === "local") { exportLocal("json"); return; } void exportServer("json"); }}
        >
          <FileJson aria-hidden />
          <span className="flex flex-col">
            <span>Download JSON</span>
            <span className="text-[length:var(--t-body)] font-[var(--t-body-w)] text-[var(--muted)]">
              Structured source data
            </span>
            {props.mode === "server" ? (
              <span className="text-[length:var(--t-body)] font-[var(--t-body-w)] text-[var(--muted)]">
                {serverAuditAction.microcopy}
              </span>
            ) : null}
          </span>
        </DropdownMenuItem>
        {failure ? (
          <p
            className="p-[var(--s-2)] text-[length:var(--t-body)] font-[var(--t-body-w)] text-[var(--critical-text)]"
            role="status"
          >
            {failure}
          </p>
        ) : null}
        {!hasRows ? <p className="p-[var(--s-2)] text-[length:var(--t-body)] text-[var(--muted)]">There are no rows to export.</p> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
