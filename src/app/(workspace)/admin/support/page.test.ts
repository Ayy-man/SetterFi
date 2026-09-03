// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  navFoldLive: vi.fn(() => false),
  phase8SupportLive: vi.fn(() => false),
  redirect: vi.fn((location: string) => { throw new Error(`REDIRECT:${location}`); }),
}));

vi.mock("next/navigation", () => ({
  forbidden: vi.fn(),
  redirect: navigation.redirect,
}));

vi.mock("@/lib/env-contract", () => ({
  navFoldLive: navigation.navFoldLive,
  phase8SupportLive: navigation.phase8SupportLive,
  phase5Live: () => false,
  phase6Live: () => false,
}));

vi.mock("@/lib/support/service", () => ({
  loadSupportSession: vi.fn(),
}));

import { workspaceNavigation } from "@/lib/workspace-navigation";

import AdminSupportPage, { metadata } from "./page";

/**
 * One destination, one name.
 *
 * The rail, the breadcrumb and the surface's own heading all say "Client requests". The document
 * title said "Support", so the browser tab, the history entry and anything reading the page's
 * metadata named a surface the product does not otherwise have -- and a reader who went looking
 * for "Support" in the nav would not find it.
 *
 * The expected value is read out of the navigation rather than retyped, so renaming the
 * destination in one place fails here rather than quietly re-opening the split.
 */
describe("the document title on /admin/support", () => {
  it("calls the surface what the navigation calls it", () => {
    const item = workspaceNavigation.admin
      .flatMap((group) => group.items)
      .find((candidate) => candidate.href === "/admin/support");

    // The positive control: a renamed or moved href would otherwise leave the comparison below
    // asserting a title against undefined.
    expect(item, "/admin/support is not in the admin navigation any more").toBeDefined();
    expect(item!.label.length).toBeGreaterThan(0);
    expect(metadata.title).toBe(item!.label);
  });
});

describe("the folded /admin/support route", () => {
  beforeEach(() => {
    navigation.redirect.mockClear();
    navigation.navFoldLive.mockReturnValue(false);
    navigation.phase8SupportLive.mockReturnValue(false);
  });

  it("redirects server-side to Inbox when the nav fold is live", async () => {
    navigation.navFoldLive.mockReturnValue(true);

    await expect(AdminSupportPage()).rejects.toThrow("REDIRECT:/admin/alerts");
    expect(navigation.redirect).toHaveBeenCalledWith("/admin/alerts");
  });

  it("keeps the support page's existing disabled path when the nav fold is off", async () => {
    navigation.navFoldLive.mockReturnValue(false);
    navigation.phase8SupportLive.mockReturnValue(false);

    const page = await AdminSupportPage();

    expect(navigation.redirect).not.toHaveBeenCalled();
    expect(page.props).toMatchObject({ actorId: "", actorRole: "admin", enabled: false });
  });
});
