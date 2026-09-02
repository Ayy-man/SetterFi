import "@testing-library/jest-dom/vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppShell, useShellDensity, type NavGroup } from "@/components/kit/app-shell";

const nav: readonly NavGroup[] = [
  {
    label: "Workspace",
    items: [{ label: "Home", href: "/home" }],
  },
];

function DensityProbe() {
  const { density, setDensity } = useShellDensity();
  return (
    <button onClick={() => setDensity("dense")} type="button">
      density: {density}
    </button>
  );
}

function renderShell(role: "admin" | "coach" | "affiliate") {
  return render(
    <AppShell
      activePath="/home"
      crumbs={[{ label: "Workspace" }, { label: "Home" }]}
      nav={nav}
      role={role}
    >
      <DensityProbe />
    </AppShell>,
  );
}

function installStorage() {
  const values = new Map<string, string>();
  const storage = {
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, value),
  };
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
}

beforeEach(() => {
  installStorage();
});

afterEach(() => {
  document.documentElement.classList.remove("dark");
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.workspaceTheme;
});

describe("AppShell density", () => {
  it.each([
    ["coach", "comfortable"],
    ["affiliate", "comfortable"],
    ["admin", "compact"],
  ] as const)(
    "keeps the density control out of the header for %s and defaults rows to %s",
    (role, density) => {
      const { container } = renderShell(role);

      expect(screen.queryByRole("group", { name: "Table density" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "compact" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "dense" })).not.toBeInTheDocument();
      const shell = container.querySelector<HTMLElement>("[data-shell-root]");
      expect(shell).toHaveAttribute("data-density", density);
      expect(shell?.style.getPropertyValue("--row-h")).toBe(`var(--row-h-${density})`);
    },
  );

  it("restores a stored density over the role default", async () => {
    window.localStorage.setItem("setterfi:device:density", "dense");
    const { container } = renderShell("admin");

    const shell = container.querySelector<HTMLElement>("[data-shell-root]");
    await waitFor(() => expect(shell).toHaveAttribute("data-density", "dense"));
    expect(shell?.style.getPropertyValue("--row-h")).toBe("var(--row-h-dense)");
  });

  it("lets a table control write the shell density and persists it", () => {
    const { container } = renderShell("admin");

    expect(screen.getByRole("button", { name: /density: compact/ })).toBeInTheDocument();

    act(() => {
      screen.getByRole("button", { name: /density: compact/ }).click();
    });

    const shell = container.querySelector<HTMLElement>("[data-shell-root]");
    expect(shell).toHaveAttribute("data-density", "dense");
    expect(window.localStorage.getItem("setterfi:device:density")).toBe("dense");
  });
});
