import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

/*
 * The marketplace install arm, folded out of `/admin/provisioning` and into the Clients screen's
 * Setup tab. The route survives only as a redirect, so every assertion that used to read the page
 * reads the module that now holds the same code -- unchanged assertions, moved target.
 */
const INSTALL_SECTION = "src/app/(workspace)/admin/platform-clients/install-section.tsx";

describe("Marketplace install reachability", () => {
  it("wires the setup section to the flag, the query string, and the agency row", () => {
    const page = source(INSTALL_SECTION);
    expect(page).toContain("phase9GhlOAuthLive");
    expect(page).toContain("searchParams");
    expect(page).toContain("messagingInstallOutcome");
    expect(page).toContain("<MessagingInstallPanel");
    expect(page).toContain("createGhlAgencyInstallCustody");
  });

  it("keeps every credential envelope out of the props the section hands the client", () => {
    const page = source(INSTALL_SECTION);
    expect(page).not.toContain("accessCredentialEnvelope");
    expect(page).not.toContain("refreshCredentialEnvelope");
  });

  it("starts the install from the client panel through the view-model seam", () => {
    const panel = source("src/components/onboarding/messaging-install-panel.tsx");
    expect(panel.trimStart().startsWith('"use client"')).toBe(true);
    expect(panel).toContain("startMessagingInstall");
  });

  it("names no provider and holds no route literal in the client panel", () => {
    const panel = source("src/components/onboarding/messaging-install-panel.tsx");
    expect(panel).not.toMatch(/GoHighLevel|GHL|HighLevel|LeadConnector|Twilio/i);
    expect(panel).not.toMatch(/install-start/);
  });
});

describe("the folded route still reaches the install surface", () => {
  it("redirects /admin/provisioning onto the tab that mounts the section", () => {
    const fold = source("src/lib/admin-route-fold.ts");
    expect(fold).toMatch(/"\/admin\/provisioning": \{ pathname: "\/admin\/platform-clients", param: "tab", value: "setup" \}/);
  });

  it("mounts the section from the Clients page on that tab, with no second page heading", () => {
    const clients = source("src/app/(workspace)/admin/platform-clients/page.tsx");
    expect(clients).toContain("ClientsSetupSection");
    expect(clients).toMatch(/tab === "setup" \? <ClientsSetupSection/);
    expect(source(INSTALL_SECTION)).toContain('chrome="embedded"');
  });
});

describe("the setup section authorizes before it reads", () => {
  const page = source(INSTALL_SECTION);

  it("holds the cross-tenant audit read inside the allowed branch, not merely after the decision", () => {
    expect(page).toMatch(/if \(access !== "allowed"\)[\s\S]*installEventRows\(/);
    expect(page.indexOf("installAttemptsAccess")).toBeLessThan(page.lastIndexOf("installEventRows("));
  });

  it("puts both agency custody reads behind the same decision", () => {
    expect(page).toMatch(/if \(access !== "allowed"\)[\s\S]*agencyInstallState\(/);
    // One definition, then the agent and provisioning custody reads together inside the allowed
    // branch. Both app rows are needed because the messaging callback can return a Company grant.
    expect((page.match(/agencyInstallState\(/g) ?? [])).toHaveLength(3);
    expect(page).toMatch(/Promise\.all\(\[\s*agencyInstallState\("agent"\),\s*agencyInstallState\("provisioning"\)/);
  });

  it("runs both phase-5 branches through the one gated helper", () => {
    expect((page.match(/await installSection\(/g) ?? [])).toHaveLength(2);
  });

  it("loads the platform actor the way every other admin page does", () => {
    expect(page).toContain("loadPlatformActor");
    expect(page).toContain('from "@/lib/auth/actors"');
  });
});

describe("the approval popup cannot navigate the tab that opened it", () => {
  const panel = source("src/components/onboarding/messaging-install-panel.tsx");

  it("opens the approval tab through the seam rather than calling window.open itself", () => {
    expect(panel).toContain("openInstallPopup");
    expect(panel).not.toContain('window.open("about:blank"');
    // window.open survives only as the primitive injected into the seam, exactly once.
    expect((panel.match(/window\.open\(/g) ?? [])).toHaveLength(1);
    expect(panel).toMatch(/openInstallPopup\(\s*\(url, target\) => window\.open\(url, target\)/);
  });
});

describe("the outcome banner's live-region role", () => {
  it("reserves the assertive role for the bad outcomes, not for everything that is not good", () => {
    const panel = source("src/components/onboarding/messaging-install-panel.tsx");
    // The linked-but-unconfirmed banner is tone "pending". Keying alert off `!== "good"` would
    // announce an approval that did come back as an interruption.
    expect(panel).not.toMatch(/outcome\.tone === "good" \? "status" : "alert"/);
    expect(panel).toMatch(/outcome\.tone === "bad" \? "alert" : "status"/);
  });
});
