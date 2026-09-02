// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const supabase = vi.hoisted(() => ({ client: null as unknown }));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: () => supabase.client,
}));

import { auditViewFilter } from "@/lib/audit/views";

import { loadAuditRows, requestedQuery } from "./load";

type RecordedQuery = {
  table: string;
  head: boolean;
  or: string[];
  eq: [string, unknown][];
  gte: [string, unknown][];
  in: [string, readonly unknown[]][];
};

const auditRow = (id: number, action: string) => ({
  id,
  tenant_id: null,
  action,
  actor_id: null,
  target_type: "brain",
  target_id: "snapshot-1",
  reason: null,
  created_at: "2026-08-30T10:00:00.000Z",
  source: null,
  actor_ip: null,
});

/**
 * A recording stand-in for the PostgREST client.
 *
 * Every builder method hands back the same object and writes down what it was asked for, and the
 * object is thenable so awaiting it answers. That is enough to hold the claim this file exists
 * for: which clauses reached the database, on which reads.
 */
function recordingClient(input: {
  rows?: Record<string, unknown>[];
  countFor?: (query: RecordedQuery) => number;
  users?: { id: string; full_name: string | null; email: string | null }[];
}) {
  const queries: RecordedQuery[] = [];
  const client = {
    from(table: string) {
      const query: RecordedQuery = { table, head: false, or: [], eq: [], gte: [], in: [] };
      queries.push(query);
      const chain = {
        select(_columns: string, options?: { head?: boolean }) {
          query.head = Boolean(options?.head);
          return chain;
        },
        or(filter: string) { query.or.push(filter); return chain; },
        eq(column: string, value: unknown) { query.eq.push([column, value]); return chain; },
        gte(column: string, value: unknown) { query.gte.push([column, value]); return chain; },
        in(column: string, values: readonly unknown[]) { query.in.push([column, values]); return chain; },
        order() { return chain; },
        limit() { return chain; },
        then(resolve: (value: unknown) => void) {
          if (table === "analytics_tenants") {
            resolve({ data: [{ tenant_id: "tenant-1", status: "active" }], error: null });
            return;
          }
          if (table === "audit_log" && query.head) {
            resolve({ count: input.countFor?.(query) ?? 0, error: null });
            return;
          }
          if (table === "audit_log") {
            resolve({ data: input.rows ?? [], error: null });
            return;
          }
          if (table === "users") {
            resolve({ data: input.users ?? [], error: null });
            return;
          }
          resolve({ data: [], error: null });
        },
      };
      return chain;
    },
  };
  supabase.client = client;
  return queries;
}

/** The count reads: four of them, one per saved view, and none of them fetching rows. */
function counts(queries: RecordedQuery[]) {
  return queries.filter((query) => query.table === "audit_log" && query.head);
}

function rowsQuery(queries: RecordedQuery[]) {
  return queries.filter((query) => query.table === "audit_log" && !query.head).at(0);
}

describe("the audit loader's saved views", () => {
  beforeEach(() => {
    supabase.client = null;
  });

  it("reads the view out of the URL and falls back to Everything for anything else", () => {
    expect(requestedQuery({ view: "pause" }).view).toBe("pause");
    expect(requestedQuery({ view: ["takeover", "pause"] }).view).toBe("takeover");
    expect(requestedQuery({ view: "pauses" }).view).toBe("all");
    expect(requestedQuery({}).view).toBe("all");
  });

  it("counts every view on the server, over the window rather than over the page", async () => {
    const byView = new Map([
      [auditViewFilter("publish"), 34],
      [auditViewFilter("takeover"), 9],
      [auditViewFilter("pause"), 17],
    ]);
    const queries = recordingClient({
      rows: [auditRow(1, "brain.published")],
      countFor: (query) => {
        const viewClause = query.or.find((clause) => clause.startsWith("action."));
        return byView.get(viewClause ?? null) ?? 212;
      },
    });

    const result = await loadAuditRows(requestedQuery({ view: "pause", range: "7d" }));

    expect(counts(queries)).toHaveLength(4);
    expect(result.viewCounts).toEqual({ all: 212, publish: 34, takeover: 9, pause: 17 });
    // The pager works from the active view's total, not from Everything's.
    expect(result.pagination.totalRows).toBe(17);
    // Every count carries the same window as the rows, so the four numbers describe one query.
    for (const query of counts(queries)) {
      expect(query.gte.map(([column]) => column)).toContain("created_at");
      expect(query.head, "a count read fetched rows").toBe(true);
    }
  });

  it("sends the view's own clause with the rows, so a page is a page of that view", async () => {
    const queries = recordingClient({ rows: [auditRow(1, "channel.disconnected")] });

    await loadAuditRows(requestedQuery({ view: "pause" }));

    expect(rowsQuery(queries)?.or).toContain(auditViewFilter("pause"));
  });

  it("narrows nothing by kind in Everything, while still counting the other three", async () => {
    const queries = recordingClient({ rows: [auditRow(1, "brain.published")] });

    await loadAuditRows(requestedQuery({}));

    const kindClause = (query: RecordedQuery) => query.or
      .filter((clause) => clause.startsWith("action.like") || clause.startsWith("action.in"));
    // Everything's rows are every kind, so the read carries no clause about kind at all.
    expect(kindClause(rowsQuery(queries)!)).toEqual([]);
    // The three named views are still counted, because their segments still show a number.
    expect(counts(queries).filter((query) => kindClause(query).length === 0)).toHaveLength(1);
    expect(counts(queries).filter((query) => kindClause(query).length === 1)).toHaveLength(3);
  });

  /**
   * F-11-AUDIT-ACTOR-NAMES: the feed says who acted, so the loader resolves the actor id through
   * `users` before the rows leave the server. An id the read cannot name stays unnamed here and
   * the screen prints its neutral word for it; nothing invents a person.
   */
  it("names the actor on every row it hands the feed", async () => {
    const queries = recordingClient({
      rows: [
        { ...auditRow(1, "brain.published"), actor_id: "user-1" },
        { ...auditRow(2, "brain.published"), actor_id: "user-2" },
        auditRow(3, "conversation.escalated"),
      ],
      users: [{ id: "user-1", full_name: "Priya Natarajan", email: null }],
    });

    const result = await loadAuditRows(requestedQuery({}));

    // One keyed read for the whole page, not one per row.
    const userReads = queries.filter((query) => query.table === "users");
    expect(userReads).toHaveLength(1);
    expect(userReads[0]!.in).toEqual([["id", ["user-1", "user-2"]]]);
    expect(result.rows.map((row) => row.actorName))
      .toEqual(["Priya Natarajan", null, null]);
    expect(result.rows[2]!.actor).toBe("Actor unavailable");
  });

  it("keeps the view when the reader pages, rather than dropping back to Everything", async () => {
    const queries = recordingClient({ rows: [auditRow(1, "followup.claimed")] });

    const query = requestedQuery({
      view: "takeover",
      cursor: "2026-08-30T10:00:00.000Z~9",
      page: "3",
      direction: "next",
    });
    expect(query.pageIndex).toBe(3);

    const result = await loadAuditRows(query);

    expect(rowsQuery(queries)?.or).toContain(auditViewFilter("takeover"));
    expect(result.pagination.pageIndex).toBe(3);
  });
});
