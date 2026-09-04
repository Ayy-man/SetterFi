import { readFileSync, readdirSync } from "node:fs";
import { extname, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SRC = resolve(ROOT, "src");

function source(path: string) {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  });
}

describe("Meet Your Agent mount contract", () => {
  it("enumerates every mount and requires the authenticated server-session props", () => {
    const mounts = sourceFiles(SRC)
      .filter((path) => !path.endsWith(".test.ts"))
      .filter((path) => readFileSync(path, "utf8").includes("<MeetYourAgent"))
      .map((path) => relative(ROOT, path))
      .sort();

    expect(mounts).toEqual([
      "src/app/meet-agent/page.tsx",
      "src/components/onboarding/onboarding-experience.tsx",
    ]);
    for (const mount of mounts) {
      const text = source(mount);
      const component = text.slice(text.indexOf("<MeetYourAgent"), text.indexOf("/>", text.indexOf("<MeetYourAgent")));
      expect(component, mount).toContain("canPromote=");
      expect(component, mount).toMatch(/\benabled(?:=|\s)/);
    }
  });

  it("renders the disabled page before role or session work and keeps onboarding server-gated", () => {
    const page = source("src/app/meet-agent/page.tsx");
    const onboardingPage = source("src/app/onboarding/page.tsx");
    const component = source("src/components/meet-your-agent.tsx");

    expect(page).toContain('export const dynamic = "force-dynamic"');
    expect(page.indexOf("if (!phase7MeetAgentLive())")).toBeLessThan(page.indexOf("loadPlatformActor()"));
    expect(page).toContain("Meet Your Agent is not enabled");

    /*
     * The onboarding half of this used to read `meetAgentEnabled={phase7MeetAgentLive()}` on the
     * setup root, because the root mounted `onboarding-experience.tsx` and that component decides
     * whether to draw the coach playback. The setup rebuild took the playback off the root: the
     * root is now the six-rung status list and nothing reachable from `src/app/onboarding` mounts
     * `<MeetYourAgent>` at all, so the prop had nothing left to pass to. Asserting it anyway would
     * have meant threading a prop no component receives, which is a dead line that passes a test
     * and tells a reader something false.
     *
     * What the assertion is really for survives the move, though: whichever page under onboarding
     * carries a flag, it decides on that flag before it touches an identity. So the rule now binds
     * the flag the setup root actually has. `phase5Live()` is read, and returned on, before the
     * session and role work in `coachContext()` runs, exactly as the Meet Your Agent page checks
     * `phase7MeetAgentLive()` before `loadPlatformActor()`. The first test in this file still
     * enumerates every file holding a mount, so a playback put back under onboarding is caught
     * there rather than being silently allowed by this one.
     */
    expect(onboardingPage).toContain('export const dynamic = "force-dynamic"');
    expect(onboardingPage.indexOf("if (!phase5Live())"))
      .toBeLessThan(onboardingPage.indexOf("await coachContext()"));
    expect(onboardingPage.indexOf("if (!phase5Live())"))
      .toBeLessThan(onboardingPage.indexOf("loadStoredEvidence(tenantId)"));
    expect(onboardingPage).not.toContain("meetAgentEnabled");
    expect(component.indexOf("if (!enabled)")).toBeLessThan(component.indexOf("return ("));
    expect(component).toContain("Meet Your Agent is not enabled");
    expect(component).toContain("if (!enabled) return;");
  });

  it("sends only the server session id and new message", () => {
    const component = source("src/components/meet-your-agent.tsx");
    const agentRequest = component.slice(
      component.indexOf('fetch("/api/agent", {', component.indexOf("async function sendMessage")),
      component.indexOf("const payload: unknown", component.indexOf("async function sendMessage")),
    );

    expect(agentRequest).toContain("body: JSON.stringify({ message, sessionId })");
    expect(agentRequest).not.toMatch(/\b(?:tenant|isTest|history|outcomes|offer|version|driver)\b/);
  });

  it("keeps Test mode and driver arm as separate persisted-receipt facts", () => {
    const component = source("src/components/meet-your-agent.tsx");
    const receiptState = component.slice(
      component.indexOf("{lastReceipt ? ("),
      component.indexOf(") : sessionError ? ("),
    );

    expect(receiptState).toContain("<strong>Test mode</strong>");
    expect(receiptState).toContain('lastReceipt.resolvedDriverArm === "mock"');
    expect(receiptState).toContain("Mock engine, no provider key");
    expect(receiptState).toContain("Real engine receipt");
    expect(component).not.toMatch(/Live engine/i);
  });

  it("derives promotion authority on the server and renders success from an exact audit receipt", () => {
    const page = source("src/app/meet-agent/page.tsx");
    const component = source("src/components/meet-your-agent.tsx");

    expect(page).toContain('actor?.role === "owner" || actor?.role === "admin"');
    expect(page).toContain("canPromote={canPromote}");
    expect(component).toContain("if (!canPromote || !lastReceipt || !promotionDraft || !promotionConfirmed) return");
    expect(component).toContain('payload.actionKey !== "eval.case.promoted"');
    expect(component).toContain('Object.keys(payload).sort().join(",") !== "actionKey,auditId,evalCaseId,state"');
    expect(component).toContain("AUDIT_ACTIONS[promotionReceipt.actionKey].microcopy");
    expect(component).toContain("Promoted ·");
    expect(component).not.toMatch(/context\s*===\s*["']admin["'][\s\S]{0,120}(?:reviewPromotion|submitPromotion)/);
  });

  /**
   * The One Fill Rule, on the surface most able to break it. Every solid button on this page is a
   * `<Button>` at its default variant, and four of them could be on screen at once -- Send, Preview
   * replay link, Start another test run and Promote confirmed copy -- so the fill stopped saying
   * "press this". The fill now derives from `primaryAction`, and the only button allowed to render
   * without an explicit variant is the one inside the go-live dialog, which is a separate layer.
   *
   * This reads the source rather than the DOM because the four states never coexist in one render,
   * so a render test would have to reproduce the state machine to check the thing that went wrong.
   */
  it("spends one accent fill, derived from which verb is live", () => {
    const component = source("src/components/meet-your-agent.tsx");
    // The page itself, cut before the two portalled dialogs: a dialog is its own layer and pays
    // for its own confirm, so its fill is not part of this page's budget.
    const shell = component.slice(
      component.indexOf("const composerDisabled ="),
      component.indexOf("<Dialog open={shareOpen}"),
    );

    expect(component).toContain('const primaryAction: "promote" | "send" | "continue" | "restart"');

    // Every rendered Button names its variant. A `<Button>` with no variant is the default, which
    // is the fill, and that is exactly how four of them ended up solid at once.
    const openings = [...shell.matchAll(/<Button\b/gu)].map((match) => match.index ?? 0);
    expect(openings.length).toBeGreaterThan(3);
    for (const at of openings) {
      const tag = shell.slice(at, shell.indexOf("</Button>", at));
      expect(tag.slice(0, 60).replace(/\s+/gu, " ")).toBeTruthy();
      expect(tag, tag.slice(0, 80).replace(/\s+/gu, " ")).toMatch(/variant=/u);
    }

    // And nothing in the page hardcodes the fill: every one of them reads `primaryAction`, so the
    // page cannot render two no matter which state it is in.
    expect(shell).not.toContain('variant="default"');
    expect(shell.match(/variant=\{primaryAction === /gu)?.length).toBeGreaterThan(2);
  });

  /** Completion theatre: this dialog announced the work finished while SMS was still registering. */
  it("never claims the agent is assembled or ready while a carrier clock is running", () => {
    const component = source("src/components/meet-your-agent.tsx");
    const globals = source("src/app/globals.css");
    const dialog = component.slice(component.indexOf("<Dialog open={goLiveOpen}"));

    expect(dialog).not.toMatch(/Assembly complete/u);
    expect(dialog).not.toMatch(/ready to arm/u);
    expect(component).toContain("smsPending ? \"What is ready, and what is not\"");
    // The gradient drench behind it went with it, along with its two decorative circles.
    expect(globals).not.toContain("--agent-drench-from");
    expect(globals).not.toMatch(/\.go-live-promo::before/u);
  });

  it("uses the canonical coach link outside fixture and alias compatibility sources", () => {
    // Get started left workspace-navigation.ts when the coach rail was cut from nine
    // destinations to five: it no longer has a rail row, so the coach Home setup rail is the
    // canonical (and now only) source of "/coach/get-started". That rail was the attention card
    // in coach-measurement.tsx until the rehaul took Home; coach-dashboard.tsx draws it now, as a
    // JSX `href` attribute on the "See setup" link rather than a row object's field.
    const measurement = source("src/components/workspace/rehaul/coach-dashboard.tsx");
    const component = source("src/components/meet-your-agent.tsx");
    const legacySources = sourceFiles(SRC)
      .filter((path) => !path.endsWith(".test.ts"))
      .filter((path) => readFileSync(path, "utf8").includes('"/coach/my-agent"'))
      .map((path) => relative(ROOT, path))
      .sort();

    expect(measurement).toContain('href="/coach/get-started"');
    expect(component).toContain('context === "client" ? "/coach/agent"');
    expect(legacySources.every((path) => [
      "src/lib/workspace-navigation.ts",
    ].includes(path))).toBe(true);
  });
});
