import { describe, expect, it } from "vitest";

import {
  complianceRegistryQuery,
  mapComplianceRegistryRpcResult,
} from "@/lib/compliance/registry";

describe("compliance registry request contract", () => {
  it("bounds page input and keeps the server search term intact for page and export callers", () => {
    expect(complianceRegistryQuery({
      resource: "tombstones",
      page: "4",
      pageSize: "500",
      q: "  provider   failed  ",
    })).toEqual({
      resource: "tombstones",
      page: 4,
      pageSize: 100,
      search: "provider failed",
    });
  });

  it("derives navigation from the database exact count instead of a loaded-row cap", () => {
    const page = mapComplianceRegistryRpcResult(
      { resource: "suppressions", page: 3, pageSize: 50, search: "" },
      { rows: [{ id: "row-151" }], total_rows: 201 },
    );
    expect(page).toMatchObject({ hasPreviousPage: true, hasNextPage: true, totalRows: 201 });
  });
});
