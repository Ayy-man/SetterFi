import { describe, expect, it } from "vitest";

import {
  assertCoachPostgrestWritesRefused,
  type OfferPostgrestClient,
} from "@/lib/repositories/offer-layer";

function directWriteClient({ allowTable }: { allowTable?: string } = {}) {
  const writes: Array<{ table: string; values: Record<string, unknown>; tenantId: string }> = [];
  const client = {
    from(table: string) {
      return {
        update(values: Record<string, unknown>) {
          return {
            async eq(_column: string, tenantId: unknown) {
              writes.push({ table, values, tenantId: String(tenantId) });
              return {
                data: null,
                error: allowTable === table ? null : { message: `permission denied for ${table}` },
              };
            },
          };
        },
      };
    },
  } as unknown as OfferPostgrestClient;
  return { client, writes };
}

describe("offer-layer PostgREST custody probe", () => {
  it("performs direct coach writes and requires both platform columns to be refused", async () => {
    const { client, writes } = directWriteClient();
    const result = await assertCoachPostgrestWritesRefused(client, "tenant-a");
    expect(result).toEqual({
      offer: "permission denied for offer_layers",
      linkWhitelist: "permission denied for tenant_settings",
    });
    expect(writes).toEqual([
      { table: "offer_layers", values: { status: "published" }, tenantId: "tenant-a" },
      { table: "tenant_settings", values: { link_whitelist: ["invalid.example"] }, tenantId: "tenant-a" },
    ]);
  });

  it.each(["offer_layers", "tenant_settings"])(
    "fails the custody probe when PostgREST allows %s",
    async (allowTable) => {
      const { client } = directWriteClient({ allowTable });
      await expect(assertCoachPostgrestWritesRefused(client, "tenant-a")).rejects.toThrow(/WAS_ALLOWED/);
    },
  );
});
