import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  pathname: "/admin/audit",
  replace: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => navigation.searchParams,
}));

import type { AdminAuditRow, AuditPagination } from "@/components/workspace/live/admin-audit-log";
import { OwnerAudit } from "@/components/workspace/rehaul/owner-audit";

const pagination: AuditPagination = {
  hasNextPage: true,
  hasPreviousPage: false,
  pageIndex: 0,
  pageSize: 50,
  totalRows: 312,
};

function row(overrides: Partial<AdminAuditRow> & Pick<AdminAuditRow, "id" | "action">): AdminAuditRow {
  return {
    actor: "8f1c0f2e-1b6a-4f9a-8b2e-2f9c9a1d5e77",
    actorIp: "203.0.113.8",
    actorName: "Delia Hartman",
    at: "2026-09-02T20:40:00.000Z",
    reason: "Credit floor to 620 per Alec.",
    source: "console",
    target: "brain_version: v12",
    tenantId: null,
    tenantName: null,
    testData: false,
    ...overrides,
  };
}

const rows: AdminAuditRow[] = [
  row({ id: "1", action: "brain.published" }),
  row({
    id: "2",
    action: "conversation.tripwire.refused",
    actorName: null,
    actor: "Actor unavailable",
    at: "2026-09-01T12:52:00.000Z",
    reason: null,
    target: "conversation: c-9",
    tenantId: "t-1",
    tenantName: "Reid Funding Group",
  }),
];

describe("OwnerAudit", () => {
  it("renders the title, the summary figure and the table sentence", () => {
    render(<OwnerAudit enabled liveWorkspaceCount={6} pagination={pagination} rows={rows} />);

    expect(screen.getByRole("heading", { level: 1, name: "Audit" })).toBeInTheDocument();
    expect(screen.getByText("312 events · 1 refused · 1 workspace")).toBeInTheDocument();

    const table = screen.getByRole("table");
    expect(within(table).getByText(/Published a new version of the Brain/)).toBeInTheDocument();
    expect(within(table).getByText("brain.published")).toBeInTheDocument();
    expect(within(table).getByText("Every workspace")).toBeInTheDocument();
    expect(within(table).getByText("Refused")).toBeInTheDocument();
  });

  it("keeps every explainer sentence off the page", () => {
    render(<OwnerAudit enabled liveWorkspaceCount={6} pagination={pagination} rows={rows} />);

    expect(screen.queryByText(/because .why did the agent say that/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Order is when each event was recorded/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Change or clear the filters to see recorded activity/i),
    ).not.toBeInTheDocument();
  });

  it("opens the detail pane for the event named in the URL", () => {
    navigation.searchParams = new URLSearchParams("event=1");
    render(<OwnerAudit enabled liveWorkspaceCount={6} pagination={pagination} rows={rows} />);

    const pane = screen.getByRole("complementary", { name: "Event detail" });
    expect(within(pane).getByText("Delia Hartman published a new version of the Brain")).toBeInTheDocument();
    expect(within(pane).getByText("Applied")).toBeInTheDocument();
    expect(within(pane).getByText("Person")).toBeInTheDocument();
    expect(within(pane).getByText("203.0.113.8")).toBeInTheDocument();
    expect(within(pane).getByText("6 workspaces")).toBeInTheDocument();
    expect(within(pane).getByText("Credit floor to 620 per Alec.")).toBeInTheDocument();
    expect(within(pane).getByText("Cannot be edited or deleted")).toBeInTheDocument();
    navigation.searchParams = new URLSearchParams();
  });
});
