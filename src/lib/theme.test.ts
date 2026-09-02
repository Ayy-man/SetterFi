import { afterEach, describe, expect, it, vi } from "vitest";

import { applyTheme, THEME_BOOT_SCRIPT, THEME_STORAGE_KEY } from "./theme";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workspace theme contract", () => {
  it("spells the existing storage key once in the boot script", () => {
    expect(THEME_STORAGE_KEY).toBe("setterfi:device:workspace-theme");
    expect(THEME_BOOT_SCRIPT).toContain("setterfi:device:workspace-theme");
  });

  it.each([
    ["light", false],
    ["dark", true],
  ] as const)("applies the %s theme to all three markers", (theme, darkClass) => {
    const root = {
      dataset: {} as Record<string, string>,
      classList: { toggle: vi.fn() },
    };
    vi.stubGlobal("document", { documentElement: root });

    applyTheme(theme);

    expect(root.dataset).toEqual({ theme, workspaceTheme: theme });
    expect(root.classList.toggle).toHaveBeenCalledWith("dark", darkClass);
  });
});
