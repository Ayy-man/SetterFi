/**
 * Shared contract for the paginated compliance registry read.  The database RPC owns the
 * joins, search cohort, ordering, and exact count so a page and its export can use one filter
 * definition instead of independently reimplementing it in the browser.
 */

export const COMPLIANCE_REGISTRY_RESOURCES = ["suppressions", "tombstones", "contacts"] as const;
export type ComplianceRegistryResource = (typeof COMPLIANCE_REGISTRY_RESOURCES)[number];

export const COMPLIANCE_REGISTRY_DEFAULT_PAGE_SIZE = 50;
export const COMPLIANCE_REGISTRY_MAX_PAGE_SIZE = 100;
export const COMPLIANCE_REGISTRY_MAX_SEARCH_LENGTH = 120;

export type ComplianceRegistryQuery = {
  resource: ComplianceRegistryResource;
  page: number;
  pageSize: number;
  search: string;
};

export type ComplianceRegistryPage = {
  rows: readonly Record<string, unknown>[];
  page: number;
  pageSize: number;
  totalRows: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  search: string;
  resource: ComplianceRegistryResource;
};

export type ComplianceRegistryRpcClient = {
  rpc(name: string, args: Record<string, unknown>): Promise<{
    data: unknown;
    error: { message?: string } | null;
  }>;
};

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function boundedInteger(value: string | undefined, fallback: number, maximum: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), maximum) : fallback;
}

export function complianceRegistryQuery(
  params: Record<string, string | string[] | undefined>,
): ComplianceRegistryQuery {
  const candidate = first(params.resource);
  const resource = COMPLIANCE_REGISTRY_RESOURCES.includes(candidate as ComplianceRegistryResource)
    ? candidate as ComplianceRegistryResource
    : "suppressions";
  const pageSize = boundedInteger(
    first(params.pageSize),
    COMPLIANCE_REGISTRY_DEFAULT_PAGE_SIZE,
    COMPLIANCE_REGISTRY_MAX_PAGE_SIZE,
  );
  return {
    resource,
    page: boundedInteger(first(params.page), 0, 1_000_000),
    pageSize: pageSize === 0 ? COMPLIANCE_REGISTRY_DEFAULT_PAGE_SIZE : pageSize,
    search: (first(params.q) ?? "").trim().replaceAll(/\s+/g, " ").slice(0, COMPLIANCE_REGISTRY_MAX_SEARCH_LENGTH),
  };
}

function numericCount(value: unknown) {
  const count = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

export function mapComplianceRegistryRpcResult(
  query: ComplianceRegistryQuery,
  value: unknown,
): ComplianceRegistryPage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("COMPLIANCE_REGISTRY_RESULT_INVALID");
  }
  const row = value as { rows?: unknown; total_rows?: unknown };
  if (!Array.isArray(row.rows)) throw new Error("COMPLIANCE_REGISTRY_RESULT_INVALID");
  const totalRows = numericCount(row.total_rows);
  if (totalRows === null || !row.rows.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
    throw new Error("COMPLIANCE_REGISTRY_RESULT_INVALID");
  }
  return {
    rows: row.rows as readonly Record<string, unknown>[],
    page: query.page,
    pageSize: query.pageSize,
    totalRows,
    hasNextPage: (query.page + 1) * query.pageSize < totalRows,
    hasPreviousPage: query.page > 0,
    search: query.search,
    resource: query.resource,
  };
}

export async function loadComplianceRegistryPage(
  client: ComplianceRegistryRpcClient,
  tenantId: string | null,
  query: ComplianceRegistryQuery,
): Promise<ComplianceRegistryPage> {
  const { data, error } = await client.rpc("read_compliance_registry_page", {
    p_tenant_id: tenantId,
    p_resource: query.resource,
    p_page_size: query.pageSize,
    p_offset: query.page * query.pageSize,
    p_search: query.search || null,
  });
  if (error) throw new Error(`COMPLIANCE_REGISTRY_READ_FAILED:${error.message ?? "empty"}`);
  return mapComplianceRegistryRpcResult(query, Array.isArray(data) ? data[0] : data);
}
