import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../supabase/migrations/20260905000005_qualification_runtime.sql", import.meta.url),
  "utf8",
);

describe("qualification turn custody", () => {
  it("forces RLS and leaves replay/CAS mutations reachable only through the RPC", () => {
    expect(migration).toContain("alter table public.qualification_turn_receipts force row level security");
    expect(migration).toContain(
      "revoke all on table public.qualification_turn_receipts from public, anon, authenticated, service_role",
    );
    expect(migration).not.toMatch(
      /grant\s+(?:select|insert|update)[\s\S]*qualification_turn_receipts\s+to\s+service_role/iu,
    );
    expect(migration).toContain("grant execute on function public.apply_qualification_turn");
  });
});
