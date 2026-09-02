import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConsumerEntry } from "@/components/consumer-entry";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ConsumerEntry", () => {
  it("exchanges a recorded consent token for an opaque conversation session", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return {
        ok: true,
        json: async () => ({
          brand: { name: "Tenant A", privacyUrl: "/opt-in/tenant-a/privacy" },
          sessionReference: "server-issued",
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ConsumerEntry
        bookingConfirmEnabled
        consentToken="signed-consent-token"
        humanReplyWindow={null}
        tenantSlug="tenant-a"
      />,
    );

    expect(screen.getByText("Starting your conversation")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Tenant A" })).toBeVisible());
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      action: "start",
      consentToken: "signed-consent-token",
      tenantSlug: "tenant-a",
    });
    expect(screen.getByRole("note")).toHaveTextContent("Live conversation");
    expect(screen.getByRole("link", { name: "Privacy policy" })).toHaveAttribute(
      "href",
      "/opt-in/tenant-a/privacy",
    );
  });

  it("does not render a usable chat when consent exchange is refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: "Consent is required before this conversation can start." }),
    })));

    render(
      <ConsumerEntry
        bookingConfirmEnabled={false}
        consentToken="unredeemed-token"
        humanReplyWindow={null}
        tenantSlug="tenant-a"
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Conversation unavailable");
    expect(screen.getByRole("alert")).toHaveTextContent("Consent is required");
    expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
  });
});
