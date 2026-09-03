import { describe, expect, it, vi } from "vitest";

import {
  META_CONNECT_RETURN_PATH,
  META_CONNECT_START_PATH,
  startMetaConnection,
} from "./coach-meta-connect";

function response(status: number, body: unknown = null) {
  return { status, json: async () => body };
}

describe("startMetaConnection", () => {
  it("posts the channel and the Connections return path, then sends the browser to Meta", async () => {
    const fetch = vi.fn<(url: string, init: { body: string }) => Promise<ReturnType<typeof response>>>(async () => response(201, {
      authorizationUrl: " https://www.facebook.com/v21.0/dialog/oauth?state=abc ",
      expiresAt: "2026-09-03T00:10:00.000Z",
      state: "connecting",
    }));
    const assign = vi.fn();

    const result = await startMetaConnection({ channel: "instagram", fetch, assign });

    expect(result).toEqual({ status: "redirecting" });
    expect(fetch).toHaveBeenCalledWith(META_CONNECT_START_PATH, expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body ?? "null")).toEqual({
      channel: "instagram",
      returnPath: META_CONNECT_RETURN_PATH,
    });
    expect(assign).toHaveBeenCalledWith("https://www.facebook.com/v21.0/dialog/oauth?state=abc");
  });

  it("names a refused session, an unavailable arm, and a broken response apart, and never navigates", async () => {
    const assign = vi.fn();
    const outcomes = await Promise.all([
      startMetaConnection({ channel: "messenger", fetch: async () => response(403, { error: "read-only" }), assign }),
      startMetaConnection({ channel: "messenger", fetch: async () => response(503, { error: "no" }), assign }),
      startMetaConnection({ channel: "messenger", fetch: async () => response(404, { error: "no" }), assign }),
      startMetaConnection({ channel: "messenger", fetch: async () => response(201, { authorizationUrl: "" }), assign }),
      startMetaConnection({ channel: "messenger", fetch: async () => { throw new Error("offline"); }, assign }),
    ]);

    expect(outcomes.map((outcome) => outcome.status === "failed" ? outcome.reason : outcome.status))
      .toEqual(["refused", "unavailable", "unavailable", "error", "error"]);
    expect(assign).not.toHaveBeenCalled();
  });
});
