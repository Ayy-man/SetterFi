import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const packageSource = readFileSync(resolve(
  process.cwd(),
  "docs/META-APP-REVIEW-PACKAGE.md",
), "utf8");

describe("Meta App Review conversion-event filing package", () => {
  it.each([
    "page_events",
    "instagram_manage_events",
    "whatsapp_business_manage_events",
  ])("includes %s with an auto-approve expectation", (permission) => {
    expect(packageSource).toContain("| `" + permission + "` — auto-approve expected |");
  });

  it("requires the event permissions in the same filing as messaging permissions", () => {
    expect(packageSource).toContain("SAME FILING REQUIRED");
    expect(packageSource).toMatch(
      /page_events[\s\S]*instagram_manage_events[\s\S]*whatsapp_business_manage_events[\s\S]*must ship in the same App Review filing as their corresponding\s+messaging permissions/,
    );
    expect(packageSource).toContain("expected auto-approval is not recorded as an approval");
  });

  it("pins fixed events, Ads Manager ownership, and Instagram measurement-only behavior", () => {
    expect(packageSource).toContain("fixed `QualifiedLead` and `Purchase` event names");
    expect(packageSource).toContain("custom conversions created and owned by the coach or");
    expect(packageSource).toContain("account owner in Ads Manager");
    expect(packageSource).toContain("Instagram receives\nmeasurement only, not ad optimization");
    expect(packageSource).toContain("Messenger and\nWhatsApp click-to-message ads may use these events for optimization");
  });

  it("forbids the former WhatsApp events exclusion and custom labels as event names", () => {
    expect(packageSource).not.toMatch(
      /whatsapp_business_manage_events` (?:is|are) intentionally absent/,
    );
    expect(packageSource).toContain("SetterFi never sends those labels as `event_name`");
  });
});
