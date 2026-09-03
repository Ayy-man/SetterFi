// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  redirect: vi.fn((location: string) => { throw new Error(`REDIRECT:${location}`); }),
}));

vi.mock("next/navigation", () => ({
  forbidden: vi.fn(),
  redirect: navigation.redirect,
}));

import AdminSupportPage from "./page";

/**
 * Client requests is a lane of the Inbox, so this route is a forwarding address and nothing else.
 * The assertion is what a saved link or a bookmark hits, which is the only reason the file is
 * still here.
 */
describe("the folded /admin/support route", () => {
  beforeEach(() => {
    navigation.redirect.mockClear();
  });

  it("redirects server-side to Inbox", async () => {
    await expect(AdminSupportPage()).rejects.toThrow("REDIRECT:/admin/alerts");
    expect(navigation.redirect).toHaveBeenCalledWith("/admin/alerts");
  });
});
