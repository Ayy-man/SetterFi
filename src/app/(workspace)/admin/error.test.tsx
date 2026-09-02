import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import AdminError from "@/app/(workspace)/admin/error";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

describe("AdminError", () => {
  it("keeps the application shell and offers a retry", () => {
    const reset = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { container } = render(
      <AdminError error={new Error("read failed")} reset={reset} />,
    );

    expect(container.querySelector("[data-shell-root]")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
