import { describe, expect, it, vi } from "vitest";

import type { CoachSetupRead } from "@/components/workspace/rehaul/coach-setup";

const redirect = vi.fn((path: string) => {
  throw new Error(`NEXT_REDIRECT ${path}`);
});
vi.mock("next/navigation", () => ({ redirect: (path: string) => redirect(path) }));

const rows = vi.fn();
vi.mock("@/components/workspace/rehaul/coach-setup", () => ({
  coachSetupRows: () => rows(),
  coachSetupResumeHref: (candidate: readonly { key: string; owner: string; done: boolean; action: unknown }[]) => {
    const open = candidate.find((row) => row.owner === "you" && row.action && !row.done);
    const action = open?.action as { kind: string; href?: string } | undefined;
    if (!action) return null;
    return action.kind === "link" ? action.href : "/onboarding/connect";
  },
}));
vi.mock("@/components/workspace/rehaul/coach-setup-read", () => ({
  coachSetupContext: async () => ({ impersonating: false, tenantId: "tenant-1" }),
  loadCoachSetup: async () => ({} as CoachSetupRead),
}));

import OnboardingPage from "./page";

/**
 * The setup root resumes where the coach stopped. It reads the one list Setup draws and sends the
 * coach to the open row's screen, so coming back never restarts at step one; with nothing left to
 * press it lands on the list itself.
 */
describe("the setup root", () => {
  it("resumes at the first row still the coach's to do", async () => {
    rows.mockReturnValue([
      { key: "business", owner: "you", done: true, action: null },
      { key: "channels", owner: "you", done: true, action: { kind: "meta", label: "Reconnect Instagram" } },
      { key: "calendar", owner: "you", done: false, action: { kind: "link", href: "/onboarding/calendar" } },
      { key: "offer", owner: "you", done: false, action: { kind: "link", href: "/onboarding/offer" } },
    ]);
    await expect(OnboardingPage()).rejects.toThrow("NEXT_REDIRECT /onboarding/calendar");
  });

  it("opens the connect step when the gap is the channels row, whose button is a sheet", async () => {
    rows.mockReturnValue([
      { key: "business", owner: "you", done: true, action: null },
      { key: "channels", owner: "you", done: false, action: { kind: "meta", label: "Connect" } },
    ]);
    await expect(OnboardingPage()).rejects.toThrow("NEXT_REDIRECT /onboarding/connect");
  });

  it("lands on the list when nothing is the coach's to press", async () => {
    rows.mockReturnValue([
      { key: "business", owner: "you", done: true, action: null },
      { key: "carrier", owner: "carriers", done: false, action: null },
    ]);
    await expect(OnboardingPage()).rejects.toThrow("NEXT_REDIRECT /coach/get-started");
  });
});
