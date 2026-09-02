import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { demoReviewPersonas, demoViewTargets } from "@/lib/workspace-navigation";

import { demoViewsForSession } from "./workspace-env";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const appShell = source("src/components/kit/app-shell.tsx");
const appTopbar = source("src/components/kit/app-topbar.tsx");
const personaSwitcher = source("src/components/kit/persona-switcher.tsx");

describe("entrance paint", () => {
  it("keeps the AppShell main element plain and reachable from the skip link", () => {
    expect(appShell).not.toContain("motion.main");
    expect(appShell).not.toMatch(/initial=\{/u);
    expect(appShell).toContain('href="#main"');
    expect(appShell).toContain('id="main"');
  });

  it("paints the shell from the product canvas token without legacy class hooks", () => {
    expect(appShell).toContain("bg-[var(--canvas)]");
    expect(appShell).not.toMatch(/\b(?:sf|ws)-[a-z]/u);
  });
});

describe("theme hydration", () => {
  it("never reads stored theme during the first render", () => {
    expect(appTopbar).not.toMatch(/useState[\s\S]{0,200}localStorage\.getItem/u);
  });

  it("applies the root theme in a layout effect that commits before paint", () => {
    expect(appTopbar).toContain("useIsomorphicLayoutEffect");
    expect(appTopbar).toContain("applyTheme(rootTheme)");
  });

  it("still starts in light mode so the client agrees with the server", () => {
    expect(appTopbar).toContain('useState<WorkspaceTheme>("light")');
  });
});

describe("demo views", () => {
  const ids = (targets: readonly { id: string }[]) => targets.map((target) => target.id);

  it("keeps only what a real session can open, per role", () => {
    expect(ids(demoViewsForSession(demoViewTargets, "supabase", "admin"))).toEqual([
      "admin",
      "onboarding",
      "consumer",
    ]);
    expect(ids(demoViewsForSession(demoViewTargets, "supabase", "coach"))).toEqual([
      "coach",
      "onboarding",
      "consumer",
    ]);
    expect(ids(demoViewsForSession(demoViewTargets, "supabase", "affiliate"))).toEqual([
      "onboarding",
      "consumer",
      "affiliate",
    ]);
  });

  it("changes nothing under the fixture-identity modes the demo views were written for", () => {
    expect(demoViewsForSession(demoViewTargets, "open", "admin")).toEqual(demoViewTargets);
    expect(demoViewsForSession(demoViewTargets, "password", "admin")).toEqual(demoViewTargets);
  });

  it("never adds Onboarding back once Phase 5 has removed it on the server", () => {
    const phase5Live = demoViewTargets.filter((target) => target.id !== "onboarding");

    expect(ids(demoViewsForSession(phase5Live, "supabase", "coach"))).toEqual([
      "coach",
      "consumer",
    ]);
  });

  it("decides the Phase 5 filter on the server, where the flag exists", () => {
    const workspaceLayout = source("src/app/(workspace)/layout.tsx");
    expect(workspaceLayout).toContain("demoViewTargetsFor()");
    expect(workspaceLayout).toContain("authMode()");
    expect(workspaceLayout).not.toContain('"use client"');
  });

  it("keeps the four review personas separate from direct route switching", () => {
    expect(demoReviewPersonas.map((persona) => persona.id)).toEqual([
      "owner",
      "admin",
      "coach",
      "affiliate",
    ]);
    expect(personaSwitcher).toContain('mode === "supabase" ? demoReviewPersonas : targets');
    expect(personaSwitcher).toContain("`/login?next=${encodeURIComponent(item.home)}`");
  });
});
