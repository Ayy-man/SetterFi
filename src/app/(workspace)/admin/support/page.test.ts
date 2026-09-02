// @vitest-environment node

import { describe, expect, it } from "vitest";

import { workspaceNavigation } from "@/lib/workspace-navigation";

import { metadata } from "./page";

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
