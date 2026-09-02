import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AdminHelp } from "@/components/workspace/admin-help";
import { ADMIN_GUIDES } from "@/lib/admin-help-guides";

/**
 * The em-rule, named once so the operator-copy guards below can mention it without writing a bare
 * `\u2014` into a regex alternation. `src/app/em-dash.test.ts` decodes escapes before it checks,
 * so an escaped dash reads exactly like a literal one to it: standing alone in a quoted value it
 * is the absent mark, spliced into a sentence it is punctuation, and no spelling of the character
 * gets a different answer.
 */
const EM_RULE = "\u2014";
const MACHINE_LANGUAGE = new RegExp(
  `persisted|Unavailable|tombstone|tenant\\.success_owner\\.reassigned|${EM_RULE}`,
  "u",
);

describe("AdminHelp", () => {
  it("filters runbooks by operator task and keeps the reading pane aligned", () => {
    render(<AdminHelp />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search operating guides" }), {
      target: { value: "carrier" },
    });

    expect(screen.getByRole("button", { name: /A2P and channel health/i })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("heading", { name: "A2P and channel health", level: 2 })).toBeInTheDocument();
  });

  it("renders human-facing operator copy and a readable package date", () => {
    const { container } = render(
      <AdminHelp
        handover={{
          downloads: [{ fileName: "OPERATIONS.md", content: "Guide" }],
          generatedAt: "2026-08-24T06:30:00.000Z",
          guideCount: 12,
        }}
      />,
    );

    expect(screen.getByText(/Generated 24 Aug 2026 with 12 operator guides/)).toBeInTheDocument();
    expect(container).not.toHaveTextContent("2026-08-24T06:30:00.000Z");
    expect(container.textContent).not.toMatch(MACHINE_LANGUAGE);
  });

  // Renders every runbook in one pass; the default 5s budget trips under a loaded machine.
  it("keeps machine language out of every runbook", { timeout: 20_000 }, () => {
    const { container } = render(<AdminHelp />);
    const index = screen.getByRole("navigation", { name: "Operating guides" });

    for (const guide of ADMIN_GUIDES) {
      fireEvent.click(within(index).getByRole("button", { name: new RegExp(guide.title, "i") }));
      expect(container.textContent).not.toMatch(MACHINE_LANGUAGE);
    }
  });

  it("groups the rail by category and reads the guide at one column width", () => {
    render(<AdminHelp />);
    const index = screen.getByRole("navigation", { name: "Operating guides" });

    for (const category of new Set(ADMIN_GUIDES.map((guide) => guide.category))) {
      expect(within(index).getByText(category)).toBeInTheDocument();
    }

    // The first guide opens by default, so the reading pane always has a subject.
    expect(
      screen.getByRole("heading", { level: 2, name: ADMIN_GUIDES[0].title }),
    ).toBeInTheDocument();
  });

  /**
   * A step number is a figure, so the Mono Licence rule puts it on the mono face. This used to
   * assert the `t-mono-meta` type-scale class; the gutter now reaches the same role through the
   * kit's `MonoMeta` atomic, which is the only definition of it the redesigned surfaces share, so
   * the assertion moved to the atomic's own slot plus the face it guarantees. Sans in the gutter,
   * or a hand-rolled span next to the atomic, still fails here.
   */
  it("numbers every runbook step in the gutter, in the mono figure role", () => {
    render(<AdminHelp />);

    const gutter = [...document.querySelectorAll("ol > li > span")];
    expect(gutter.length).toBeGreaterThan(0);
    expect(gutter.map((node) => node.textContent)).toEqual(
      Array.from({ length: gutter.length }, (_unused, index) => String(index + 1).padStart(2, "0")),
    );
    for (const number of gutter) {
      expect(number).toHaveAttribute("data-slot", "mono-meta");
      expect(number.className).toContain("mono");
      expect(number.className).toContain("tabular-nums");
    }
  });

  it("colours the verification checks with a token the theme actually defines", () => {
    render(<AdminHelp />);

    const checks = [...document.querySelectorAll('svg[class*="--good"]')];
    expect(checks.length).toBeGreaterThan(0);
    expect(document.querySelector('svg[class*="--positive"]')).toBeNull();
  });

  it("teaches recovery when no runbook matches", () => {
    render(<AdminHelp />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search operating guides" }), {
      target: { value: "no matching task" },
    });

    expect(screen.getByRole("heading", { name: "No matching runbook" })).toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });
});
