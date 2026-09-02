import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, screen } from "@testing-library/react";
import { toast } from "sonner";
import { describe, expect, it } from "vitest";

import { Toaster } from "@/components/ui/sonner";

import { TOASTER_PRESET } from "./toast-preset";

describe("TOASTER_PRESET", () => {
  it("is a plain object a server layout can spread into <Toaster>, and the toaster mounts on the first toast", async () => {
    // A "use client" export would arrive in the workspace layout as a client reference, not a value.
    expect(Object.getPrototypeOf(TOASTER_PRESET)).toBe(Object.prototype);
    expect(TOASTER_PRESET.position).toBe("bottom-right");

    render(<Toaster {...TOASTER_PRESET} />);
    expect(document.querySelector("[data-sonner-toaster]")).toBeNull();

    toast("Saved");
    expect(await screen.findByText("Saved")).toBeInTheDocument();

    const toaster = document.querySelector("[data-sonner-toaster]");
    expect(toaster).toHaveAttribute("data-x-position", "right");
    expect(toaster).toHaveAttribute("data-y-position", "bottom");
  });

  /**
   * Unstyled sonner draws no width and no padding of its own, so the toast used to take whatever
   * width its longest line asked for. The approved geometry is a fixed 360px card, a 10px gap
   * between icon and body, and 12/12/12/14 padding, all of it read back off the tokens rather
   * than restated as pixels here.
   */
  it("draws the approved toast geometry from tokens", () => {
    const css = readFileSync(resolve(process.cwd(), "src/app/tokens.css"), "utf8");
    const value = (name: string) => {
      const match = css.match(new RegExp(`--${name}:\\s*(\\d+)px`, "u"));
      if (!match) throw new Error(`tokens.css declares no --${name}`);
      return Number(match[1]);
    };

    const toastClass = TOASTER_PRESET.toastOptions.classNames.toast;

    expect(toastClass).toContain("w-[var(--toast-w)]");
    expect(value("toast-w")).toBe(360);

    expect(toastClass).toContain("gap-[calc(var(--s-2)+var(--s-1)/2)]");
    expect(value("s-2") + value("s-1") / 2).toBe(10);

    expect(toastClass).toContain("py-[var(--s-3)]");
    expect(toastClass).toContain("pr-[var(--s-3)]");
    expect(toastClass).toContain("pl-[calc(var(--s-3)+var(--s-1)/2)]");
    expect(value("s-3")).toBe(12);
    expect(value("s-3") + value("s-1") / 2).toBe(14);

    // The stack keeps its own 8px gap and 24px offset, which the geometry above sits inside.
    expect(TOASTER_PRESET.className).toContain("[--gap:var(--s-2)]");
    expect(TOASTER_PRESET.offset).toBe("var(--s-6)");
  });
});
