/**
 * Starting a Meta sign-in from the Connections page.
 *
 * `POST /api/channels/meta/connect` is the only thing in the product that mints a Meta
 * authorization URL, and until 2026-09-02 nothing on a page called it: every Instagram and
 * Messenger "Connect" was a link to Setup, and Setup linked back here. This is the browser half
 * of that route, shaped like `messaging-install-view-models.ts` so the two provider hand-offs
 * cannot drift into two accounts of what a 201 means.
 *
 * The result never claims a connection. A 201 with a URL means the browser is being sent to Meta;
 * whether a connection exists is decided by the callback and read back from `channel_connections`.
 */

export const META_CONNECT_START_PATH = "/api/channels/meta/connect";

/** Where Meta sends the coach back to. The page that owns the row, never Setup. */
export const META_CONNECT_RETURN_PATH = "/coach/integrations";

export type MetaConnectChannel = "instagram" | "messenger";

export type MetaConnectStartResult =
  | { status: "redirecting" }
  | { status: "failed"; reason: "refused" | "unavailable" | "error" };

type StartResponse = { status: number; json(): Promise<unknown> };

const STATUS_FAILURES: Record<number, "refused" | "unavailable"> = {
  401: "refused",
  403: "refused",
  404: "unavailable",
  503: "unavailable",
};

function failure(reason: "refused" | "unavailable" | "error"): MetaConnectStartResult {
  return { status: "failed", reason };
}

export async function startMetaConnection(input: {
  channel: MetaConnectChannel;
  fetch: (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<StartResponse>;
  assign: (url: string) => void;
  returnPath?: string;
}): Promise<MetaConnectStartResult> {
  try {
    const response = await input.fetch(META_CONNECT_START_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: input.channel,
        returnPath: input.returnPath ?? META_CONNECT_RETURN_PATH,
      }),
    });
    if (response.status !== 201) return failure(STATUS_FAILURES[response.status] ?? "error");
    const body: unknown = await response.json().catch(() => null);
    const url = body && typeof body === "object" && !Array.isArray(body)
      && typeof (body as { authorizationUrl?: unknown }).authorizationUrl === "string"
      ? (body as { authorizationUrl: string }).authorizationUrl.trim()
      : "";
    if (!url) return failure("error");
    input.assign(url);
    return { status: "redirecting" };
  } catch {
    return failure("error");
  }
}

/** The sentence a coach reads for each failure. None of them claims anything was started. */
export const META_CONNECT_FAILURE_COPY: Record<Extract<MetaConnectStartResult, { status: "failed" }>["reason"], string> = {
  refused: "This session is not allowed to start a Meta sign-in. Nothing changed.",
  unavailable: "Meta sign-in is not available on this deployment right now. No connection was started.",
  error: "Meta sign-in could not be started. Nothing changed.",
};
