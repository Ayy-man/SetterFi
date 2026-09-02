import "@testing-library/jest-dom/vitest";

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FormSaveBar } from "@/components/kit/form-save-bar";
import { SettingsSection } from "@/components/kit/templates/settings-layout";

describe("FormSaveBar elevation", () => {
  it("wears the card's own material rather than an overlay surface", () => {
    // The bar is pinned to the bottom of the settings card it belongs to. On --raised it was a
    // lighter stripe inside a --card section: the same surface the drawers and popovers use,
    // applied to something you are editing rather than something over what you are editing.
    // Elevation only means "temporarily over your work" while nothing else claims it.
    render(
      <SettingsSection footer={<FormSaveBar dirty onSave={() => {}} />} title="Notifications">
        <p>Fields</p>
      </SettingsSection>,
    );

    const bar = document.querySelector('[data-slot="form-save-bar"]');
    expect(bar).toHaveClass("bg-[var(--card)]", "border-t");
    expect(bar?.className).not.toContain("--raised");
  });

  it("separates itself with a rule instead of a shadow", () => {
    // A sticky bar that content scrolls beneath still is not above the page -- it is the bottom
    // edge of the page. The top rule is the whole separation it needs.
    render(<FormSaveBar dirty onSave={() => {}} />);

    const bar = document.querySelector('[data-slot="form-save-bar"]');
    expect(bar?.className).not.toContain("shadow-");
  });
});
