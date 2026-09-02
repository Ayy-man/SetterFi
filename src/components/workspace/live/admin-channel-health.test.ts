import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Admin Channel Health live reachability", () => {
  it("uses a dedicated dynamic claims-bound page with both flags and server repositories", () => {
    const page = source("src/app/(workspace)/admin/channel-health/page.tsx");
    expect(page).toContain('export const dynamic = "force-dynamic"');
    expect(page).toContain("liveAdminContext");
    expect(page).toContain("parseAppClaims");
    expect(page).toContain("impersonatedReadContext");
    expect(page).toContain("phase1Live() || !phase4Live()");
    expect(page).toContain("listChannelConnections(context.tenantId)");
    expect(page).toContain("listMessageTemplates(context.tenantId)");
    expect(page).toContain("<AdminChannelHealth");
    expect(page).toContain("enabled={false}");
    expect(page).not.toContain("FixtureWorkspaceShell");
  });

  it("renders an explicit tenant-selection state for an unscoped Admin instead of redirecting away", () => {
    const page = source("src/app/(workspace)/admin/channel-health/page.tsx");
    const component = source("src/components/workspace/live/admin-channel-health.tsx");
    expect(page).toContain('return { tenantId: null, impersonation: null }');
    expect(page).toContain('scope="unscoped"');
    expect(page).not.toContain('if (!tenantId) redirect("/admin/platform-clients")');
    expect(component).toContain('scope === "unscoped"');
    // Re-pointed for the round-4 (5i) copy, which replaced "No client is selected..." wholesale.
    // The authority is unchanged and is the reason this line greps the source at all: an unscoped
    // admin must land on a state that names the selection and says why the surface is per-tenant,
    // never a redirect that moves them somewhere else. So the pin asserts both halves of that
    // sentence, the instruction and its reason, rather than any one JSX spelling of it.
    expect(component).toMatch(/Choose a client to read its connection receipts[\s\S]*pooled across clients on purpose/);
  });

  it("keeps Channel Health out of the fixture catch-all and renders external prerequisites honestly", () => {
    const component = source("src/components/workspace/live/admin-channel-health.tsx");
    expect(existsSync(resolve(process.cwd(), "src/app/(workspace)/[role]/[[...screen]]/page.tsx"))).toBe(false);
    expect(existsSync(resolve(process.cwd(), "src/components/workspace/workspace-screens.tsx"))).toBe(false);
    expect(component).toContain("deriveMetaReviewTruth(null)");
    expect(component).toContain("Business Verification, Access Verification");
    // Demo/test scope stays labelled on screen and called out as excluded from analytics.
    // Asserted through the derivation + the labels it drives, not through one JSX spelling.
    expect(component).toMatch(/const isDemoScope[\s\S]*channels\.some\(\(channel\) => channel\.templateIsDemo\)/u);
    expect(component).toMatch(/testRow=\{\(\) => isDemoScope\}/u);
    expect(component).toMatch(/testRowLabel="Demo"/u);
    // Re-pointed for the canvas chip, which moved the page-level disclosure from a faint sentence
    // under the description to a mono chip above the <h1> -- the placement all thirteen console
    // artboards draw. The authority above is unchanged and both halves of it are still asserted:
    // the scope derivation still drives the disclosure, and the words "excluded from analytics"
    // are still on screen, now in the shared chip this page mounts rather than in a local string.
    expect(component).toMatch(/provenanceKind=\{isDemoScope \? "demo"/u);
    expect(source("src/components/kit/provenance-chip.tsx")).toContain("Excluded from analytics");
    expect(component).not.toMatch(/GoHighLevel|GHL|Twilio|review completes|review takes/i);
  });
});
