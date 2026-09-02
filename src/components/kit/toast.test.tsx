import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { toastRefused } from "@/components/kit/toast";
import { Toaster } from "@/components/ui/sonner";

describe("toastRefused", () => {
  it("states that nothing changed", async () => {
    render(<Toaster />);

    toastRefused("The update was refused.");

    expect(await screen.findByText(/Nothing changed/)).toBeInTheDocument();
  });
});
