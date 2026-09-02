import { createElement } from "react";

import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import "@/app/tokens.css";
import "@/app/globals.css";

import { AgentFlow } from "@/components/agent-flow";
import { MeetYourAgent } from "@/components/meet-your-agent";

Object.defineProperty(HTMLElement.prototype, "scrollTo", {
  configurable: true,
  value: vi.fn(),
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty("--line");
  document.documentElement.style.removeProperty("--line-strong");
  document.querySelector("[data-test-composer-css]")?.remove();
});

describe("Meet Your Agent session states", () => {
  it("renders a centred idle canvas with no live-looking nodes when sessionId is null", () => {
    render(createElement(AgentFlow, {
      sessionId: null,
      current: "greeting",
      done: ["greeting", "qualify"],
      thinking: true,
      brainUsed: true,
      guardrail: { type: "block", rule: "stay-in-role" },
      booked: { slot: "Test slot", calendar: "Test calendar" },
      decisionLabel: "IN PROGRESS",
    }));

    const canvas = screen.getByRole("group", { name: "Agent decision flow trace" });
    const idleExplanation = screen.getByRole("status");

    expect(canvas).toHaveAttribute("data-session-state", "idle");
    expect(idleExplanation).toHaveClass("absolute", "inset-0", "grid", "place-items-center");
    expect(canvas.querySelectorAll('[data-status="active"], [data-status="done"]')).toHaveLength(0);
    expect(canvas).toHaveTextContent("Greeting: idle. waiting for session.");
    expect(canvas).not.toHaveTextContent(/\blive\b|in progress/i);
  });

  it("keeps the canvas idle and shows recovery when session creation fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(
      { code: "TEST_AGENT_SESSION_REFUSED" },
      { status: 503 },
    ));

    render(createElement(MeetYourAgent, { canPromote: false, enabled: true, lockedContext: true }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Test session could not start");
    expect(screen.getByRole("button", { name: "Retry session" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Contact support" })).toHaveAttribute("href", "/coach/help");
    expect(screen.getByRole("textbox", { name: "Message your test agent" })).toHaveAttribute(
      "placeholder",
      "Session unavailable; retry above to begin",
    );
  });

  it("gives the disabled composer a distinct computed border colour", async () => {
    const style = document.createElement("style");
    style.dataset.testComposerCss = "true";
    style.textContent = `
      .composer input { border: 1px solid currentColor; }
      .composer[data-state="disabled"] input { border-color: transparent; }
    `;
    document.head.append(style);

    let resolveSession: ((response: Response) => void) | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>((resolve) => {
      resolveSession = resolve;
    }));

    render(createElement(MeetYourAgent, { canPromote: false, enabled: true, lockedContext: true }));
    const composer = screen.getByRole("textbox", { name: "Message your test agent" });

    expect(composer).toBeDisabled();
    const disabledBorderColour = getComputedStyle(composer).borderColor;

    await act(async () => {
      resolveSession?.(Response.json({ sessionId: "test-session" }));
    });
    await waitFor(() => expect(composer).toBeEnabled());

    expect(getComputedStyle(composer).borderColor).not.toBe(disabledBorderColour);
  });
});
