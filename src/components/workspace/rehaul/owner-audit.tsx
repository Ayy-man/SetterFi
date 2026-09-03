"use client";

/**
 * The owner Audit screen, rehaul face.
 *
 * One table and one detail pane. Every row, count and facet comes from the same loader the live
 * surface uses; this file adds no read of its own and no state the URL does not already hold.
 *
 * What the drawing asks for that the platform cannot answer, and what stands in its place:
 *
 * - The range control is drawn as Today / 7 days / 30 days / Custom. The query behind this page
 *   accepts three windows -- 7 days, 30 days, all of it -- and the range is a server filter, so a
 *   fourth pill would either show a window the query never applied or narrow one loaded page and
 *   leave the total above it answering a different question. The control offers the three windows
 *   the loader can actually run.
 * - The pane is drawn with a reach block reading "8 agents, 5 answers changed, 46 of 48 evals".
 *   The log records none of those, so the block carries what the registry does say: whether the
 *   key reaches every workspace or one, how many workspaces are live now, and where the event came
 *   from. The live count is labelled "now" every time, because it is not the reach the event had.
 * - The summary line's event total is the whole window; refusals and workspaces are counted over
 *   the loaded page, because a cursor-paginated read cannot count either across the window without
 *   a query this page is not allowed to add. The eye carries that sentence.
 */

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { DataTableFacetedFilter } from "@/components/kit/data-table-faceted-filter";
import { ExportMenu } from "@/components/kit/export-menu";
import { ChevronLeft, ChevronRight, Search, X } from "@/components/kit/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AdminAuditRow, AuditPagination } from "@/components/workspace/live/admin-audit-log";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import { CARD_TABLE, CardTable, Pill, Seg, StatusDot } from "@/components/workspace/rehaul/_primitives";
import {
  ACTOR_ROLES,
  AUDIT_OUTCOME_KEYS,
  AUDIT_OUTCOMES,
  actorLabel,
  actorRoleOf,
  auditMicrocopy,
  eventLabel,
  eventPhrase,
  needsReading,
  outcomeOf,
  scopeOf,
  sourceLabel,
  targetParts,
} from "@/components/workspace/rehaul/audit-derivations";
import { AUDIT_ACTION_KEYS } from "@/lib/audit/actions";
import { workspaceCountFormat, workspaceDateTimeFormat } from "@/lib/format/datetime";
import { cn } from "@/lib/utils";

export type OwnerAuditProps = {
  enabled: boolean;
  rows: readonly AdminAuditRow[];
  pagination: AuditPagination;
  unavailableReason?: string | null;
  /** How many workspaces answer from the central Brain right now. Never a historical reach. */
  liveWorkspaceCount?: number | null;
};

const EYE_COPY = "Every publish, override, takeover and pause is recorded here, because “why did the agent say that” always has an answer. Nothing in this log can be edited or deleted. The event total counts the whole window you picked; refused and workspaces count the page in front of you, because the log is read a page at a time. Order is when each event was recorded, which is not always when the change took effect.";

const RANGE_OPTIONS = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "all", label: "All" },
] as const;

const SEARCH_DEBOUNCE_MS = 250;

const ACTION_OPTIONS = AUDIT_ACTION_KEYS
  .map((key) => ({ label: eventLabel(key), value: key }))
  .sort((first, second) => first.label.localeCompare(second.label));

const OUTCOME_OPTIONS = AUDIT_OUTCOME_KEYS
  .map((key) => ({ label: AUDIT_OUTCOMES[key].label, value: AUDIT_OUTCOMES[key].label }));

const ACTOR_OPTIONS = ACTOR_ROLES.map((role) => ({ label: role.label, value: role.label }));

function timestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : workspaceDateTimeFormat.format(date);
}

function count(value: number, singular: string, plural: string) {
  return `${workspaceCountFormat.format(value)} ${value === 1 ? singular : plural}`;
}

/** The mono key that sits beside the sentence, so the row carries the fact and its spelling. */
function ActionKey({ children }: { children: string }) {
  return (
    <span className="ml-2 font-mono text-[11.5px] text-[var(--faint)]">{children}</span>
  );
}

function OutcomePill({ action }: { action: string }) {
  const outcome = outcomeOf(action);
  return (
    <Pill tone={outcome.tone === "amber" ? "amber" : "neutral"}>
      <StatusDot tone={outcome.tone} />
      {outcome.label}
    </Pill>
  );
}

/** A label over a value, the pane's field shape. An absent value reads as faint italic words. */
function PaneField({ absence, label, mono, value }: {
  absence: string;
  label: string;
  mono?: boolean;
  value?: string | null;
}) {
  return (
    <>
      <span className="text-[var(--muted)]">{label}</span>
      <span className={cn(mono && value ? "font-mono text-[12.5px]" : undefined, value ? undefined : "text-[var(--faint)] italic")}>
        {value || absence}
      </span>
    </>
  );
}

function EventPane({
  liveWorkspaceCount,
  onClose,
  onSelect,
  row,
  trail,
}: {
  liveWorkspaceCount: number | null;
  onClose: () => void;
  onSelect: (id: string) => void;
  row: AdminAuditRow;
  trail: readonly AdminAuditRow[];
}) {
  const phrase = eventPhrase(row.action);
  const scope = scopeOf(row);
  const outcome = outcomeOf(row.action);
  return (
    <aside
      aria-label="Event detail"
      className={cn(
        CARD_TABLE.card,
        "flex min-h-0 flex-col gap-[14px] overflow-y-auto px-5 py-[18px]",
      )}
      data-slot="audit-event-pane"
    >
      <div>
        <div className="flex items-start gap-2">
          <div className="font-mono text-[11.5px] text-[var(--faint)]">{row.action}</div>
          <Button
            aria-label="Close event detail"
            className="-mt-1 ml-auto"
            onClick={onClose}
            size="icon-sm"
            variant="ghost"
          >
            <X aria-hidden />
          </Button>
        </div>
        <div className="mt-1 text-[17px] font-semibold tracking-[-0.01em]">
          {`${actorLabel(row)} ${phrase.verb} ${phrase.object}`}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <Pill tone={outcome.tone === "amber" ? "amber" : "neutral"}>
            <StatusDot tone={outcome.tone} />
            {outcome.label}
          </Pill>
          <Pill>{actorRoleOf(row).label}</Pill>
          <Pill className="font-mono">{row.actorIp ?? "no address recorded"}</Pill>
        </div>
      </div>

      <div>
        <div className="mb-1.5 text-[12.5px] font-medium text-[var(--muted)]">Reached</div>
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
          <PaneField absence="not recorded" label="Where" value={scope.label} />
          <PaneField
            absence="not readable right now"
            label="Live now"
            value={scope.platformWide
              ? liveWorkspaceCount === null
                ? null
                : count(liveWorkspaceCount, "workspace", "workspaces")
              : "this workspace only"}
          />
          <PaneField absence="not recorded" label="Record" value={targetParts(row.target).label} />
          <PaneField
            absence="no origin recorded"
            label="Source"
            value={row.source ? sourceLabel(row.source) : null}
          />
        </div>
      </div>

      <div>
        <div className="mb-1.5 text-[12.5px] font-medium text-[var(--muted)]">Reason</div>
        <div
          className={cn(
            "rounded-[11px] border border-[var(--line-soft)] bg-[var(--well)] px-3.5 py-3 leading-[1.5]",
            row.reason?.trim() ? undefined : "text-[var(--faint)] italic",
          )}
        >
          {row.reason?.trim() || "no reason was given"}
        </div>
      </div>

      <div>
        <div className="mb-1.5 text-[12.5px] font-medium text-[var(--muted)]">Trail</div>
        <ol className="m-0 flex list-none flex-col p-0 text-[13px]">
          {trail.map((entry) => (
            <li
              className="flex gap-2.5 border-b border-[var(--line-soft)] py-[7px] last:border-b-0"
              key={entry.id}
            >
              <span className="font-mono text-[var(--muted)]">{timestamp(entry.at)}</span>
              {entry.id === row.id ? (
                <span>{`${eventLabel(entry.action)}, this event`}</span>
              ) : (
                <button
                  className="link-inline border-0 bg-transparent p-0 text-left"
                  onClick={() => onSelect(entry.id)}
                  type="button"
                >
                  {eventLabel(entry.action)}
                </button>
              )}
            </li>
          ))}
        </ol>
      </div>

      <div className="mt-auto flex flex-col gap-1 pt-2 font-mono text-[11px] text-[var(--faint)]">
        <span>{auditMicrocopy(row.action)}</span>
        <span>Cannot be edited or deleted</span>
      </div>
    </aside>
  );
}

export function OwnerAudit({
  enabled,
  liveWorkspaceCount = null,
  pagination,
  rows,
  unavailableReason = null,
}: OwnerAuditProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const requestedRange = searchParams.get("range");
  const activeRange = requestedRange === "7d" || requestedRange === "30d" ? requestedRange : "all";
  const activeAction = searchParams.get("action");
  const activeOutcome = searchParams.get("outcome");
  const activeActorRole = searchParams.get("actorRole");
  const activeClient = searchParams.get("client");
  const activeSearch = (searchParams.get("q") ?? "").trim().slice(0, 120);
  const selectedId = searchParams.get("event");

  const replaceQuery = useCallback((updates: Record<string, string | null>, resetPaging = false) => {
    const params = new URLSearchParams(searchParams.toString());
    if (resetPaging) {
      params.delete("cursor");
      params.delete("direction");
      params.delete("page");
    }
    for (const [key, value] of Object.entries(updates)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

  /** The range is a server filter, so its pills are links that also drop the page cursor. */
  const rangeHref = useCallback((key: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("cursor");
    params.delete("direction");
    params.delete("page");
    if (key === "all") params.delete("range");
    else params.set("range", key);
    const query = params.toString();
    return query ? `${pathname}?${query}` : pathname;
  }, [pathname, searchParams]);

  const [draft, setDraft] = useState(() => ({ source: activeSearch, value: activeSearch }));
  const search = draft.source === activeSearch ? draft.value : activeSearch;
  useEffect(() => {
    if (search === activeSearch) return;
    const timeout = window.setTimeout(
      () => replaceQuery({ q: search.trim() || null }, true),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [activeSearch, replaceQuery, search]);

  /*
   * Outcome, actor role and client narrow the rows already loaded, which is right for facets whose
   * options come from those rows. Action and the range are server filters and reset paging.
   */
  const visibleRows = useMemo(
    () => rows.filter((row) => (!activeOutcome || outcomeOf(row.action).label === activeOutcome)
      && (!activeActorRole || actorRoleOf(row).label === activeActorRole)
      && (!activeClient || scopeOf(row).label === activeClient)),
    [activeActorRole, activeClient, activeOutcome, rows],
  );

  const clientOptions = useMemo(
    () => [...new Set(rows.filter((row) => !scopeOf(row).platformWide).map((row) => scopeOf(row).label))]
      .sort((first, second) => first.localeCompare(second))
      .map((label) => ({ label, value: label })),
    [rows],
  );

  const summary = useMemo(() => {
    const refused = visibleRows.filter((row) => needsReading(row.action)).length;
    const workspaces = new Set(
      visibleRows.filter((row) => !scopeOf(row).platformWide).map((row) => scopeOf(row).label),
    ).size;
    return [
      count(pagination.totalRows, "event", "events"),
      `${workspaceCountFormat.format(refused)} refused`,
      count(workspaces, "workspace", "workspaces"),
    ].join(" · ");
  }, [pagination.totalRows, visibleRows]);

  const selected = visibleRows.find((row) => row.id === selectedId) ?? null;

  /** Every event on this page that touched the same record, oldest first. */
  const trail = useMemo(() => {
    if (!selected) return [];
    const targetId = targetParts(selected.target).id;
    if (!targetId) return [selected];
    return [...visibleRows]
      .filter((row) => targetParts(row.target).id === targetId)
      .sort((first, second) => first.at.localeCompare(second.at));
  }, [selected, visibleRows]);

  const navigate = useCallback((direction: "next" | "previous") => {
    const boundary = direction === "next" ? rows.at(-1) : rows.at(0);
    if (!boundary) return;
    const pageIndex = direction === "next"
      ? pagination.pageIndex + 1
      : Math.max(0, pagination.pageIndex - 1);
    replaceQuery({
      cursor: `${boundary.at}~${boundary.id}`,
      direction,
      event: null,
      page: String(pageIndex),
    });
  }, [pagination.pageIndex, replaceQuery, rows]);

  const [exportReason, setExportReason] = useState("");
  const exportControl = (
    <span
      className="inline-flex"
      onChangeCapture={(event) => {
        const target = event.target;
        if (target instanceof HTMLInputElement && target.id === "setterfi-audit-log-export-reason") {
          setExportReason(target.value);
        }
      }}
    >
      <ExportMenu
        filename="setterfi-audit-log"
        mode="server"
        query={{
          action: activeAction ?? undefined,
          reason: exportReason,
          ...(activeSearch ? { search: activeSearch } : {}),
        }}
        resource="audit-log"
      />
    </span>
  );

  const first = pagination.totalRows === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1;
  const last = pagination.totalRows === 0
    ? 0
    : Math.min(pagination.totalRows, first + rows.length - 1);

  const body = !enabled
    ? <p className="p-6 text-[var(--muted)]">Audit is not enabled.</p>
    : unavailableReason
      ? <p className="p-6 text-[var(--muted)]">{unavailableReason}</p>
      : visibleRows.length === 0
        ? <p className="p-6 text-[var(--muted)]">No events match these filters.</p>
        : (
          <table className={CARD_TABLE.table}>
            <thead>
              <tr>
                <th className={CARD_TABLE.th}>Who</th>
                <th className={CARD_TABLE.th}>What happened</th>
                <th className={CARD_TABLE.th}>Where</th>
                <th className={CARD_TABLE.th}>Outcome</th>
                <th className={CARD_TABLE.th}>When</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const phrase = eventPhrase(row.action);
                return (
                  <tr
                    className={cn(
                      "cursor-pointer hover:bg-[var(--row-hover)]",
                      row.id === selectedId && "bg-[var(--row-selected)]",
                    )}
                    data-selected={row.id === selectedId ? "true" : undefined}
                    data-testid="audit-row"
                    key={row.id}
                    onClick={() => replaceQuery({ event: row.id })}
                  >
                    <td className={cn(CARD_TABLE.td, "font-medium")}>
                      <button
                        aria-label={`Open event detail: ${eventLabel(row.action)}`}
                        className="border-0 bg-transparent p-0 text-left font-medium text-[var(--ink)]"
                        onClick={(event) => {
                          event.stopPropagation();
                          replaceQuery({ event: row.id });
                        }}
                        type="button"
                      >
                        {actorLabel(row)}
                      </button>
                    </td>
                    <td className={CARD_TABLE.td}>
                      {`${phrase.verb.charAt(0).toLocaleUpperCase()}${phrase.verb.slice(1)} ${phrase.object}`}
                      <ActionKey>{row.action}</ActionKey>
                      {row.testData === true ? (
                        <span className="ml-2 font-mono text-[10.5px] text-[var(--faint)]">test data</span>
                      ) : null}
                    </td>
                    <td className={cn(CARD_TABLE.td, "text-[var(--muted)]")}>{scopeOf(row).label}</td>
                    <td className={CARD_TABLE.td}><OutcomePill action={row.action} /></td>
                    <td className={cn(CARD_TABLE.td, "font-mono text-[var(--muted)]")}>
                      {timestamp(row.at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="mb-[14px] flex items-end gap-3">
        <h1 className="m-0 text-[30px] leading-[1.1] font-semibold tracking-[-0.02em]">Audit</h1>
        <div className="ml-auto flex items-center gap-2">
          <Seg
            items={RANGE_OPTIONS.map((option) => ({
              active: option.key === activeRange,
              href: rangeHref(option.key),
              label: option.label,
            }))}
            label="Time range"
          />
          {exportControl}
        </div>
      </div>

      <div className="mb-[14px] flex flex-wrap items-center gap-2">
        <div className="relative w-[280px]">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-[var(--muted)]"
          />
          <Input
            aria-label="Search events"
            className="h-8 w-full pl-8"
            onChange={(event) => setDraft({ source: activeSearch, value: event.target.value })}
            placeholder="Search events"
            type="search"
            value={search}
          />
        </div>
        <DataTableFacetedFilter
          onChange={(next) => replaceQuery({ outcome: next.at(-1) ?? null })}
          options={OUTCOME_OPTIONS}
          title="Outcome"
          value={activeOutcome === null ? [] : [activeOutcome]}
        />
        <DataTableFacetedFilter
          onChange={(next) => replaceQuery({ actorRole: next.at(-1) ?? null })}
          options={ACTOR_OPTIONS}
          title="Actor"
          value={activeActorRole === null ? [] : [activeActorRole]}
        />
        {clientOptions.length > 0 ? (
          <DataTableFacetedFilter
            onChange={(next) => replaceQuery({ client: next.at(-1) ?? null })}
            options={clientOptions}
            title="Client"
            value={activeClient === null ? [] : [activeClient]}
          />
        ) : null}
        <DataTableFacetedFilter
          onChange={(next) => replaceQuery({ action: next.at(-1) ?? null }, true)}
          options={ACTION_OPTIONS}
          title="Action"
          value={activeAction === null ? [] : [activeAction]}
        />
        <span
          className="ml-auto font-mono text-[12px] text-[var(--muted)]"
          data-slot="audit-summary"
        >
          {summary}
        </span>
      </div>

      <div
        className={cn(
          "grid min-h-0 flex-1 gap-4",
          selected ? "grid-cols-[minmax(0,1fr)_400px]" : "grid-cols-1",
        )}
      >
        <div className="flex min-h-0 min-w-0 flex-col gap-2">
          <CardTable className="min-h-0 flex-1 overflow-y-auto">{body}</CardTable>
          <div className="flex items-center gap-3 text-[12.5px] text-[var(--muted)]">
            <span className="font-mono">
              {`${workspaceCountFormat.format(pagination.totalRows)} events, showing ${workspaceCountFormat.format(first)} to ${workspaceCountFormat.format(last)}`}
            </span>
            {pagination.totalRows > pagination.pageSize ? (
              <div className="ml-auto flex items-center gap-1">
                <Button
                  aria-label="Previous page"
                  disabled={!pagination.hasPreviousPage}
                  onClick={() => navigate("previous")}
                  size="icon-sm"
                  variant="ghost"
                >
                  <ChevronLeft aria-hidden />
                </Button>
                <Button
                  aria-label="Next page"
                  disabled={!pagination.hasNextPage}
                  onClick={() => navigate("next")}
                  size="icon-sm"
                  variant="ghost"
                >
                  <ChevronRight aria-hidden />
                </Button>
              </div>
            ) : null}
          </div>
        </div>
        {selected ? (
          <EventPane
            liveWorkspaceCount={liveWorkspaceCount}
            onClose={() => replaceQuery({ event: null })}
            onSelect={(id) => replaceQuery({ event: id })}
            row={selected}
            trail={trail}
          />
        ) : null}
      </div>

      <ContextEye copy={EYE_COPY} screen="owner-audit" />
    </div>
  );
}
