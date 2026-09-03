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
  groupLabel?: string;
};

type ServerExportBase = {
  mode: "server";
  filename: string;
  className?: string;
  label?: string;
  groupLabel?: string;
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

/** One thing this menu can export: a set of rows already on screen, or a server resource. */
export type ExportMenuSource = LocalExportMenuProps | ServerExportMenuProps;

/**
 * `also` puts a second export under the same trigger.
 *
 * A screen that can export two different things -- the rows on screen and a server resource the
 * table only shows part of -- used to need two "Export" buttons beside each other, which reads as
 * two of the same control rather than one control with two answers. Each source keeps its own
 * reason field and its own failure message, so neither can be attributed to the other, and
 * `groupLabel` names them: without it a single-source menu says "Choose a format" exactly as
 * before.
 */
export type ExportMenuProps = ExportMenuSource & {
  also?: ExportMenuSource;
};

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

function sourceHasRows(source: ExportMenuSource) {
  return source.mode === "server" || source.rows.length > 0;
}

/**
 * One source's part of the menu: the reason field its route requires, its two formats, and the
 * microcopy that says whether taking it is logged.
 *
 * The export reason lives here rather than in the menu because a menu can now carry two sources,
 * and a reason typed for a platform export must not travel with the other one. The failure
 * message is handed up instead: the item press closes the menu, so the parent is what can put the
 * message back where the export was asked for.
 */
function ExportGroup({
  failure,
  onFailure,
  source,
}: {
  failure: string | null;
  onFailure: (message: string | null) => void;
  source: ExportMenuSource;
}) {
  const baseName = safeBaseName(source.filename);
  const hasRows = sourceHasRows(source);
  const requiredReason = source.mode === "server" && queryRequiresReason(source);
  const suppliedReason = source.mode === "server" ? source.query?.reason ?? "" : "";
  const exportIdentity = source.mode === "server"
    ? `${source.filename}:${serverExportHref(source.resource, "csv", source.query as ServerQuery)}`
    : `local:${source.filename}`;
  const [reasonDraft, setReasonDraft] = useState<{ identity: string; value: string } | null>(null);
  const reason = reasonDraft?.identity === exportIdentity ? reasonDraft.value : suppliedReason;
  const serverAuditAction = requiredReason
    ? AUDIT_ACTIONS["platform_export.started"]
    : AUDIT_ACTIONS["export.started"];

  const canExport = hasRows && (!requiredReason || reason.trim().length > 0);

  function exportLocal(format: "csv" | "json") {
    if (source.mode !== "local" || !canExport) return;
    onFailure(null);
    if (format === "csv") {
      downloadBlob(`\uFEFF${rowsToCsv(source.rows)}`, `${baseName}.csv`, "text/csv;charset=utf-8");
      return;
    }
    downloadBlob(JSON.stringify(source.rows, null, 2), `${baseName}.json`, "application/json;charset=utf-8");
  }

  async function exportServer(format: "csv" | "json") {
    if (source.mode !== "server" || !canExport) return;
    onFailure(null);
    const query = { ...source.query, ...(requiredReason ? { reason: reason.trim() } : {}) } as ServerQuery;
    const message = await downloadServerExport(
      serverExportHref(source.resource, format, query),
      `${baseName}.${format}`,
      format,
    );
    if (message === null) return;
    onFailure(message);
  }

  function request(format: "csv" | "json") {
    if (source.mode === "local") {
      exportLocal(format);
      return;
    }
    void exportServer(format);
  }

  return (
    <>
      {requiredReason ? (
        <div className="space-y-[var(--s-2)] p-[var(--s-2)]">
          <label className="block text-[length:var(--t-body)] font-[var(--t-body-w)] text-[var(--body)]" htmlFor={`${baseName}-export-reason`}>
            {source.groupLabel ? `${source.groupLabel}: export reason` : "Export reason"}
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
          <DropdownMenuLabel>{source.groupLabel ?? "Choose a format"}</DropdownMenuLabel>
        </DropdownMenuGroup>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={!canExport} onClick={() => request("csv")}>
        <Download aria-hidden />
        <span className="flex flex-col">
          <span>{source.groupLabel ? `Download CSV, ${source.groupLabel}` : "Download CSV"}</span>
          <span className="text-[length:var(--t-body)] font-[var(--t-body-w)] text-[var(--muted)]">
            {source.mode === "local" ? "Current rows" : "All matching rows"}
          </span>
          <span className="text-[length:var(--t-body)] font-[var(--t-body-w)] text-[var(--muted)]">
            {source.mode === "server" ? serverAuditAction.microcopy : "Rows already on screen, not logged"}
          </span>
        </span>
      </DropdownMenuItem>
      <DropdownMenuItem disabled={!canExport} onClick={() => request("json")}>
        <FileJson aria-hidden />
        <span className="flex flex-col">
          <span>{source.groupLabel ? `Download JSON, ${source.groupLabel}` : "Download JSON"}</span>
          <span className="text-[length:var(--t-body)] font-[var(--t-body-w)] text-[var(--muted)]">
            Structured source data
          </span>
          <span className="text-[length:var(--t-body)] font-[var(--t-body-w)] text-[var(--muted)]">
            {source.mode === "server" ? serverAuditAction.microcopy : "Rows already on screen, not logged"}
          </span>
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
    </>
  );
}

export function ExportMenu(props: ExportMenuProps) {
  const { className, label } = props;
  const also = props.also;
  const primary: ExportMenuSource = props;
  /*
   * The trigger only goes dead when nothing under it can be exported. With a second source the
   * empty one still says "There are no rows to export." inside the menu, which is a better answer
   * than a disabled button that cannot say why.
   */
  const hasRows = sourceHasRows(primary) || (also !== undefined && sourceHasRows(also));
  const [open, setOpen] = useState(false);
  const [failures, setFailures] = useState<{ primary: string | null; also: string | null }>({
    primary: null,
    also: null,
  });

  function reportFailure(which: "primary" | "also", message: string | null) {
    setFailures((current) => ({ ...current, [which]: message }));
    // The item press already closed the menu, so a refusal is put back where the export was asked
    // for rather than left somewhere the click never was.
    if (message !== null) setOpen(true);
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
          setFailures({ primary: null, also: null });
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
        /*
            Sized by its own two rows, not by `--drawer-w`. That token is 480px, a drawer width,
            and on a 110px "Export" trigger anchored `align="end"` it hung the panel 370px to the
            left of the button it belongs to: the menu read as a slab that had arrived from
            somewhere else rather than as the trigger opening. `DropdownMenuContent` now sizes
            every menu to its content between the trigger's width and a 20rem cap, so this needs
            no width of its own.
          */
          className="rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--raised)] p-[var(--s-1)] shadow-[var(--shadow-raised)] duration-[var(--duration-quick)] ease-[var(--ease-out)] motion-reduce:animate-none motion-reduce:transition-none"
        role="menu"
      >
        <ExportGroup
          failure={failures.primary}
          onFailure={(message) => reportFailure("primary", message)}
          source={primary}
        />
        {also ? (
          <>
            <DropdownMenuSeparator />
            <ExportGroup
              failure={failures.also}
              onFailure={(message) => reportFailure("also", message)}
              source={also}
            />
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
