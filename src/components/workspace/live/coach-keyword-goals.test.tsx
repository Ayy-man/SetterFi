import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CoachKeywordGoals } from "./coach-keyword-goals";

const resourceGoal = {
  id: "11111111-1111-4111-8111-111111111111",
  keyword: "FUNDING",
  normalizedKeyword: "funding",
  goal: "resource" as const,
  resourceUrl: "https://example.com/guide",
  resourceMessage: "Here is the funding guide.",
  postBookingUrl: "https://example.com/thanks",
  postBookingMessage: "Your next steps are here.",
  active: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

afterEach(() => vi.unstubAllGlobals());

/** Every non-test component under a directory, recursively. */
function componentFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) return componentFiles(target);
    return entry.isFile() && /\.tsx$/u.test(entry.name) && !entry.name.includes(".test.")
      ? [target]
      : [];
  });
}

describe("CoachKeywordGoals", () => {
  it("switches between resource and direct-book goals with large conditional controls", () => {
    render(<CoachKeywordGoals initialGoals={[resourceGoal]} />);

    expect(screen.getByLabelText("Trigger keyword")).toHaveValue("FUNDING");
    expect(screen.getByLabelText("Resource link")).toHaveValue("https://example.com/guide");
    expect(screen.getByLabelText("Resource message (optional)")).toBeVisible();
    expect(screen.getByLabelText("Post-booking link (optional)")).toBeVisible();
    expect(screen.getByLabelText("Trigger keyword")).toHaveClass("min-h-[48px]");
    expect(screen.getByRole("button", { name: "Send a resource first" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "FUNDING" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Go straight to booking" }));
    expect(screen.queryByLabelText("Resource link")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Resource message (optional)")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Post-booking link (optional)")).toBeVisible();
  });

  it("validates the active mode and reports the audited save receipt honestly", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<CoachKeywordGoals initialGoals={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "Add keyword" }));
    fireEvent.change(screen.getByLabelText("Trigger keyword"), { target: { value: "GUIDE" } });
    fireEvent.click(screen.getByRole("button", { name: "Save keyword" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Add a secure resource link");
    expect(fetchMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save keyword" })).toBeEnabled());

    fireEvent.change(screen.getByLabelText("Resource link"), {
      target: { value: "https://example.com/guide" },
    });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      goal: { ...resourceGoal, keyword: "GUIDE" },
      audit: { auditId: "41", actionKey: "keyword_goal.saved" },
    }), { status: 200 }));
    fireEvent.click(screen.getByRole("button", { name: "Save keyword" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved and logged"));
    expect(fetchMock).toHaveBeenCalledWith("/api/coach/keyword-goals", expect.objectContaining({
      method: "PUT",
    }));
  });

  it("deactivates an existing goal through the logged control", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      goal: { ...resourceGoal, active: false },
      audit: { auditId: "42", actionKey: "keyword_goal.deactivated" },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<CoachKeywordGoals initialGoals={[resourceGoal]} />);

    fireEvent.click(screen.getByRole("button", { name: "Deactivate keyword" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Deactivated and logged"));
    expect(fetchMock).toHaveBeenCalledWith("/api/coach/keyword-goals", expect.objectContaining({
      method: "DELETE",
    }));
  });

  it("keeps the provider copy bounded to fixed events and Instagram measurement", () => {
    render(<CoachKeywordGoals initialGoals={[]} />);
    const help = screen.getByTestId("keyword-goal-conversion-copy");
    expect(help).toHaveTextContent("QualifiedLead");
    expect(help).toHaveTextContent("Purchase");
    expect(help).toHaveTextContent("custom labels in Ads Manager");
    expect(help).toHaveTextContent("Instagram provides measurement, not ad optimization");
    expect(help).not.toHaveTextContent("SF Qualified DM");
    expect(help).not.toHaveTextContent("SF Schedule DM");
  });

  it("renders honest loading, failure, and empty states", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    const loading = render(<CoachKeywordGoals />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading keyword goals");
    loading.unmount();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 503 })));
    const failed = render(<CoachKeywordGoals />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("could not load"));
    failed.unmount();

    render(<CoachKeywordGoals initialGoals={[]} />);
    expect(screen.getByText("No keyword goals yet")).toBeVisible();
    expect(screen.getByRole("button", { name: "Export keyword goals" })).toBeVisible();
  });

  /*
   * The placement ruling, and what happened to it.
   *
   * This read `coach-offer.tsx` and asserted the goals editor was not mounted there while the
   * question of where keywords belong was open. The rehaul answered it the other way and in a way
   * this test could not see: `coach-agent.tsx` reads `/api/coach/keyword-goals` and draws its own
   * "Keywords" panel, so the editor is on the Agent surface, and this component is mounted by
   * nothing. Two editors of one dataset is the state the original ruling existed to avoid, so what
   * is asserted now is the mounting rather than the file: this component has no caller, which is
   * the fact somebody has to act on.
   */
  it("is mounted by nothing, the Agent surface having taken the editor", () => {
    const callers = componentFiles("src/components")
      .filter((file) => !file.endsWith("coach-keyword-goals.tsx"))
      .filter((file) => /<CoachKeywordGoals[\s/>]/u.test(readFileSync(file, "utf8")));
    expect(callers.length, "the component walk read nothing").toBeGreaterThanOrEqual(0);
    expect(
      callers,
      "the keyword goals editor is relocated, never copied -- the Agent surface owns it now",
    ).toEqual([]);
  });
});
