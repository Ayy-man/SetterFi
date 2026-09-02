import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ForgotPasswordForm } from "./forgot-password-form";

function submitWith(response: Partial<Response> & { json: () => Promise<unknown> }) {
  const fetchMock = vi.fn().mockResolvedValue({ status: 202, ...response });
  vi.stubGlobal("fetch", fetchMock);
  render(<ForgotPasswordForm next="/login" />);
  fireEvent.change(screen.getByLabelText(/email address/i), {
    target: { value: "coach@example.test" },
  });
  fireEvent.submit(screen.getByRole("button", { name: /send reset link/i }));
  return fetchMock;
}

const accepted = {
  json: async () => ({
    message: "If an eligible account matches that email address, we have sent instructions.",
  }),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ForgotPasswordForm", () => {
  it("posts the address and the validated return path to the recovery route", async () => {
    const fetchMock = submitWith(accepted);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/auth/password-reset");
    expect(JSON.parse(String(init.body))).toEqual({ email: "coach@example.test", next: "/login" });
  });

  it("shows the route's indistinguishable message rather than saying whether an account exists", async () => {
    submitWith(accepted);

    await waitFor(() =>
      expect(
        screen.getByText(/if an eligible account matches that email address/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/no account/i)).not.toBeInTheDocument();
  });

  it("says the attempt was throttled rather than implying mail was sent", async () => {
    submitWith({ status: 429, json: async () => ({ message: "ignored" }) });

    await waitFor(() => expect(screen.getByText(/too many attempts/i)).toBeInTheDocument());
    expect(screen.queryByText(/we have sent instructions/i)).not.toBeInTheDocument();
  });

  it("says reset is unavailable when the route cannot serve it", async () => {
    submitWith({ status: 503, json: async () => ({ message: "ignored" }) });

    await waitFor(() =>
      expect(screen.getByText(/password reset is unavailable right now/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/we have sent instructions/i)).not.toBeInTheDocument();
  });
});
