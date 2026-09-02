import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CoachOnboarding } from "@/components/onboarding/coach-onboarding";
import type { ReadinessResult } from "@/lib/onboarding/contracts";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock("next/link", () => ({ default: "a" }));

const readiness: ReadinessResult = {
  ready: false,
  checks: [
    { key: "tenant_active", ready: false, code: "tenant_readiness_unavailable", evidenceAt: null, blamingParty: "platform" },
    { key: "messaging_channel_live", ready: false, code: "carrier_review", evidenceAt: null, blamingParty: "provider" },
    { key: "primary_calendar_healthy", ready: false, code: "calendar_missing", evidenceAt: null, blamingParty: "coach" },
    { key: "published_offer_ready", ready: false, code: "offer_review_contract_unavailable", evidenceAt: null, blamingParty: "platform" },
    { key: "platform_brain_published", ready: true, code: "ready", evidenceAt: "2026-08-20T12:00:00.000Z", blamingParty: "platform" },
    { key: "test_passed", ready: false, code: "test_required", evidenceAt: null, blamingParty: "coach" },
    { key: "subscription_ready", ready: false, code: "subscription_required", evidenceAt: null, blamingParty: "coach" },
  ],
};

function response(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CoachOnboarding", () => {
  it("renders each of the seven checks exactly once and keeps the carrier day count in the journey", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/onboarding/readiness")) return response({ readiness });
      if (url.endsWith("/api/onboarding/a2p-registration")) {
        return response({
          registration: {
            registrationState: "awaiting_provider",
            submittedAt: "2026-08-14T12:00:00.000Z",
            terminalCode: null,
            terminalRejection: false,
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(<CoachOnboarding />);

    const journey = await screen.findByRole("list", { name: "Setup journey" });
    for (const label of [
      "Workspace activation",
      "Text messages (SMS)",
      "Calendar",
      "Published offer",
      "The Brain",
      "Safe test",
      "Subscription",
    ]) {
      expect(within(journey).getAllByText(label, { exact: true })).toHaveLength(1);
    }
    expect(within(journey).getByText(/^Day \d+$/)).toBeVisible();
    expect(journey).not.toHaveTextContent(/readiness\s+unavailable/);
    expect(journey).not.toHaveTextContent(/route[- ]owned/);
    expect(screen.getByText("Go-live logged")).toBeVisible();

    // The count is rendered from the list it describes, on the same receipt-backed rule the
    // journey marks a row done with: one of the seven fixtures is ready and carries an
    // `evidenceAt`, so exactly one is confirmed.
    expect(screen.getByText("1 of 7")).toBeVisible();
    // And the page says in words that nothing is waiting on the coach while the carrier holds it,
    // rather than leaving them to infer it from a timeline and a disabled button.
    expect(screen.getByText(/Waiting on you: calendar\./i)).toBeVisible();
  });

  /**
   * The One Fill Rule, across the two components that could each spend it.
   *
   * `StepJourney` fills the coach's first actionable step; Go live is the page's other candidate.
   * A permanently primary Go live would be a second fill on every screen where the coach still has
   * work, spent on the one control that is disabled precisely because that work is not done.
   */
  it("spends one accent fill: the journey's while work remains, Go live's only once it does not", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/onboarding/readiness")) return response({ readiness });
      if (url.endsWith("/api/onboarding/a2p-registration")) return response({ registration: null });
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(<CoachOnboarding />);
    await screen.findByRole("list", { name: "Setup journey" });

    const filled = () => Array.from(document.querySelectorAll<HTMLElement>('[data-slot="button"].bg-primary'));
    expect(filled()).toHaveLength(1);
    expect(filled()[0]).not.toHaveTextContent(/Turn my agent on/i);
    expect(screen.getByRole("button", { name: /Turn my agent on/i })).toBeDisabled();
  });

  it("fills Go live only when every check is receipt-backed, and nothing else then is", async () => {
    const completedReadiness: ReadinessResult = {
      ready: true,
      checks: readiness.checks.map((check) => ({
        ...check,
        ready: true,
        code: "ready",
        evidenceAt: "2026-08-20T12:00:00.000Z",
      })),
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/onboarding/readiness")) return response({ readiness: completedReadiness });
      if (url.endsWith("/api/onboarding/a2p-registration")) return response({ registration: null });
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(<CoachOnboarding />);
    await screen.findByRole("list", { name: "Setup journey" });

    expect(screen.getByText("7 of 7")).toBeVisible();
    const filled = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="button"].bg-primary'));
    expect(filled).toHaveLength(1);
    expect(filled[0]).toHaveTextContent(/Turn my agent on/i);
  });

  it("renders the seven-step journey without requesting disabled onboarding APIs", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<CoachOnboarding enabled={false} />);

    const journey = screen.getByRole("list", { name: "Setup journey" });
    expect(within(journey).getAllByRole("listitem")).toHaveLength(7);
    expect(within(journey).getByText("Workspace activation").closest("li")).toHaveAttribute("data-state", "current");
    expect(within(journey).getAllByText("Onboarding is not enabled. This check is not running.")).toHaveLength(7);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prioritizes a terminal carrier rejection over the current state", async () => {
    const terminalReadiness: ReadinessResult = {
      ...readiness,
      checks: readiness.checks.map((check, index) => ({
        ...check,
        ready: index <= 1,
        evidenceAt: index <= 1 ? "2026-08-20T12:00:00.000Z" : null,
      })),
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/onboarding/readiness")) return response({ readiness: terminalReadiness });
      if (url.endsWith("/api/onboarding/a2p-registration")) {
        return response({
          registration: {
            registrationState: "blocked",
            submittedAt: "2026-08-14T12:00:00.000Z",
            terminalCode: "carrier-terminal",
            terminalRejection: true,
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(<CoachOnboarding />);

    const smsStep = (await screen.findByText("Text messages (SMS)")).closest("li");
    expect(smsStep).toHaveAttribute("data-state", "blocked");
    expect(smsStep).toHaveTextContent("Carriers rejected your text registration");
    expect(within(smsStep as HTMLElement).getByRole("button", { name: "Open connections" })).toHaveAttribute("href", "/coach/integrations");
    expect(smsStep).toHaveTextContent("Owner: you");
    expect(smsStep).not.toHaveTextContent(/Nothing for you to do|no action needed from you/i);
    expect(screen.getByText("Calendar").closest("li")).toHaveAttribute("data-state", "current");
    expect(screen.getByRole("button", { name: /Turn my agent on/i })).toBeDisabled();
  });

  it("keeps all seven receipts visible and makes go live the separate current step", async () => {
    const completedReadiness: ReadinessResult = {
      ready: true,
      checks: readiness.checks.map((check) => ({
        ...check,
        ready: true,
        code: "ready",
        evidenceAt: "2026-08-20T12:00:00.000Z",
      })),
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/onboarding/readiness")) return response({ readiness: completedReadiness });
      if (url.endsWith("/api/onboarding/a2p-registration")) return response({ registration: null });
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(<CoachOnboarding />);

    const journey = await screen.findByRole("list", { name: "Setup journey" });
    expect(within(journey).getAllByText(/^Saved evidence confirmed/)).toHaveLength(7);
    expect(within(journey).getByText("Subscription").closest("li")).toHaveAttribute("data-state", "done");
    expect(within(journey).getByText("Go live").closest("li")).toHaveAttribute("data-state", "current");
    expect(screen.getByRole("button", { name: /Turn my agent on/i })).toBeEnabled();
  });
  it("says what pressing the button does, and that it does not turn texting on", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/onboarding/readiness")) return response({ readiness });
      if (url.endsWith("/api/onboarding/a2p-registration")) return response({ registration: null });
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(<CoachOnboarding />);
    await screen.findByRole("list", { name: "Setup journey" });

    const panel = screen.getByRole("region", { name: "What happens when you press it" });
    expect(within(panel).getAllByRole("listitem")).toHaveLength(3);
    expect(panel).toHaveAttribute("data-drench", "info");

    // The honesty-carrying line. Without it the button reads as turning the whole product on.
    const scope = screen.getByText(/This turns on Instagram and Messenger only/i);
    expect(scope).toBeVisible();
    expect(scope).toHaveTextContent(/Texting is not part of it yet/i);
  });

  it("predicts no carrier date and promises no reply speed anywhere in the action column", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/onboarding/readiness")) return response({ readiness });
      if (url.endsWith("/api/onboarding/a2p-registration")) return response({ registration: null });
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(<CoachOnboarding />);
    await screen.findByRole("list", { name: "Setup journey" });

    const panel = screen.getByRole("region", { name: "What happens when you press it" });
    const copy = `${panel.textContent ?? ""} ${screen.getByText(/This turns on Instagram and Messenger only/i).textContent ?? ""}`;
    expect(copy).not.toMatch(/%/);
    expect(copy).not.toMatch(/within about|in under|in less than|\bminute/i);
    expect(copy).not.toMatch(/\bby [A-Z][a-z]+ \d/);
  });

  it("offers a way out that is not the go-live button", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/onboarding/readiness")) return response({ readiness });
      if (url.endsWith("/api/onboarding/a2p-registration")) return response({ registration: null });
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(<CoachOnboarding />);
    await screen.findByRole("list", { name: "Setup journey" });

    expect(screen.getByRole("link", { name: "Not yet, take me back to my settings" }))
      .toHaveAttribute("href", "/coach/settings");
  });
});
