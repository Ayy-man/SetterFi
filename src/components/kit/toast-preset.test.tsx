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
});
