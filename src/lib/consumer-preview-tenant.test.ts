import { describe, expect, it } from "vitest";

import { DEMO_TENANT_ID } from "@/lib/demo-tenant";

import { resolveConsumerPreviewTenant, selectConsumerPreviewTenant } from "./consumer-preview-tenant";

describe("consumer preview tenant", () => {
  it("keeps the public preview on the canonical seeded workspace when many demos exist", () => {
    const unrelatedDemo = { id: "82000000-0000-4000-8000-000000000001", is_demo: true };
    const canonicalDemo = { id: DEMO_TENANT_ID, is_demo: true };

    expect(selectConsumerPreviewTenant(unrelatedDemo)).toBeNull();
    expect(selectConsumerPreviewTenant(canonicalDemo)).toBe(DEMO_TENANT_ID);
  });

  it("fails closed when the canonical row is missing or no longer labelled demo", async () => {
    expect(selectConsumerPreviewTenant(null)).toBeNull();
    expect(selectConsumerPreviewTenant({ id: DEMO_TENANT_ID, is_demo: false })).toBeNull();
    await expect(resolveConsumerPreviewTenant({ load: async () => null })).resolves.toBeNull();
  });
});
