import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ImpersonationFrame } from "@/components/kit/impersonation-frame";

const SESSION = {
  expiresAt: "2026-09-01T10:30:00.000Z",
  sessionId: "a1000000-0000-4000-8000-000000000001",
  startedAt: "2026-09-01T10:00:00.000Z",
  tenantName: "Reid Funding Group",
};

describe("ImpersonationFrame", () => {
  it("adds nothing at all to an ordinary session", () => {
    const { container } = render(
      <ImpersonationFrame session={null}>
        <p>the workspace</p>
      </ImpersonationFrame>,
    );

    expect(screen.queryByRole("status")).toBeNull();
    // No wrapper element, so none of the frame's height rules can reach the shell when they have
    // no band to make room for.
    expect(container.querySelector("[data-workspace-frame]")).toBeNull();
    expect(container.innerHTML).toBe("<p>the workspace</p>");
  });

  it("puts the band above the page it wraps", () => {
    const { container } = render(
      <ImpersonationFrame session={SESSION}>
        <p>the workspace</p>
      </ImpersonationFrame>,
    );

    const frame = container.querySelector('[data-workspace-frame="impersonating"]');
    expect(frame).not.toBeNull();
    const children = [...frame!.children];
    const band = children.findIndex((child) => child.matches('[data-slot="impersonation-banner"]'));
    const page = children.findIndex((child) => child.tagName === "P");
    expect(band).toBeGreaterThanOrEqual(0);
    expect(band).toBeLessThan(page);
    expect(screen.getByRole("status")).toHaveTextContent("Reid Funding Group");
  });

  /**
   * The reason this component exists.
   *
   * `ImpersonationBanner` shipped complete and tested with zero call sites, so no impersonating
   * session showed a band, a clock, an audit line, or a way out --
   * `/api/platform/impersonation/end` had no caller anywhere in the app. A component test cannot
   * catch that, because the component was never the thing that was broken. This reads the layout
   * that mounts it, because the mount is the fix and un-mounting it is the regression.
   */
  it("is mounted by the one server boundary above every workspace route", () => {
    const layout = readFileSync(
      resolve(process.cwd(), "src/app/(workspace)/layout.tsx"),
      "utf8",
    );

    expect(layout).toContain("ImpersonationFrame");
    expect(layout).toContain("loadImpersonationSessionBanner");
    expect(layout).toMatch(/<ImpersonationFrame\s+session=\{await loadImpersonationSessionBanner\(\)\}>/u);
  });
});
