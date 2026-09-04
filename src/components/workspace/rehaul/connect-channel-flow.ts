/**
 * The connect sheet's state, copy and wire contracts, kept apart from the sheet so every claim
 * the sheet makes can be tested without a DOM.
 *
 * Drawn from `docs/plans/2026-09-04-connect-flow-research.md`: the flow never leaves the page it
 * was pressed on, permissions are written as capabilities and consequences (three, then what the
 * assistant will never do), a rehearsal step names the window before it opens, the coach chooses
 * which account is being connected before anything is saved, success says what now works and how
 * long it takes, and every failure stays in the frame with a verb as the primary action.
 *
 * The wire is the existing Meta OAuth round trip, unchanged:
 *   POST /api/channels/meta/connect   -> { authorizationUrl }         (the sign-in window)
 *   GET  /api/channels/meta/callback  -> redirect returnPath?meta=select_asset + session cookie
 *   GET  /api/channels/meta/assets    -> { items }                    (the accounts to choose from)
 *   POST /api/channels/meta/assets    -> 202 { connectionId, state }  (the chosen account)
 * Nothing here claims a connection: "connected" is only ever the 202 read back from that last
 * call, and the row behind the sheet re-reads `channel_connections` when the sheet closes.
 */

import type { MetaConnectChannel } from "@/components/workspace/live/coach-meta-connect";

export type ConnectChannel = MetaConnectChannel;

export type ConnectAsset = {
  assetId: string;
  channel: ConnectChannel;
  label: string;
  eligible: boolean;
  /** Why an account cannot be chosen, in the coach's words. `null` when it can. */
  reason: string | null;
};

export type ConnectStage =
  /** What this does, and what it will never do. */
  | { kind: "intro"; note: string | null }
  /** The rehearsal: what the window will look like and what to press in it. */
  | { kind: "rehearsal" }
  /** The window is open; the sheet waits for the callback's session. */
  | { kind: "waiting"; reopened: boolean }
  /** The accounts the sign-in returned; the coach picks one. */
  | { kind: "choose"; items: readonly ConnectAsset[]; chosen: string | null; saving: boolean; error: string | null }
  /** The 202 came back. `label` is the account the coach chose. */
  | { kind: "connected"; label: string }
  /** Something the coach can retry. `reference` is a short code for a support call, never a raw error. */
  | { kind: "failed"; reason: ConnectFailure }
  /** Facebook has not approved the app on this deployment. No sign-in can start. */
  | { kind: "not_ready" };

export type ConnectFailure = "window_closed" | "refused" | "no_accounts" | "not_saved" | "timed_out" | "error";

export const CHANNEL_WORDS: Record<ConnectChannel, { name: string; account: string; place: string }> = {
  instagram: { name: "Instagram", account: "Instagram account", place: "your Instagram account" },
  messenger: { name: "Messenger", account: "Facebook page", place: "your Facebook page" },
};

/** "Instagram", "Messenger", or "Instagram and Messenger" for the title of a queued connect. */
export function channelListName(channels: readonly ConnectChannel[]): string {
  const names = channels.map((channel) => CHANNEL_WORDS[channel].name);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The three things Facebook will ask permission for, and the one sentence of what the assistant
 * will never do. Capabilities and consequences, never scopes: a coach knows what a message is and
 * does not know what `instagram_manage_messages` is.
 */
export function permissionLines(channel: ConnectChannel): readonly string[] {
  const words = CHANNEL_WORDS[channel];
  return [
    `Read new messages people send to ${words.place}`,
    "Reply to those messages for you, in your voice",
    "See the name and photo of the person who wrote, so it can greet them",
  ];
}

export const NEVER_LINE =
  "Your assistant will never post to your feed, change your profile, or read your personal messages.";

/** The rehearsal, numbered, so the Facebook window is expected rather than a surprise. */
export const REHEARSAL_STEPS: readonly string[] = [
  "Sign in to Facebook if it asks you to.",
  "Choose the account your business uses.",
  "Leave the boxes ticked and press Continue.",
];

export const FAILURE_COPY: Record<ConnectFailure, { title: string; body: string }> = {
  window_closed: {
    title: "The Facebook window closed before it finished",
    body: "Nothing was changed. Open it again and press Continue at the end.",
  },
  refused: {
    title: "This sign-in is not allowed from here",
    body: "Nothing was changed. Connecting has to happen in your own account, not one you are viewing on someone's behalf.",
  },
  no_accounts: {
    title: "Facebook did not hand back an account we can use",
    body: "Nothing was changed. This usually means the account you chose is a personal one, not a business page or a professional Instagram account.",
  },
  not_saved: {
    title: "That account could not be saved",
    body: "Nothing was changed. Try again, and if it happens twice, message us from the bubble in the corner.",
  },
  timed_out: {
    title: "We stopped waiting for Facebook",
    body: "Nothing was changed. The window was open for more than ten minutes without finishing.",
  },
  error: {
    title: "Facebook did not finish connecting",
    body: "Nothing was changed. Try again in a minute, and if it happens twice, message us from the bubble in the corner.",
  },
};

export const NOT_READY_COPY = {
  title: "Facebook is still reviewing SetterFi",
  body: "Facebook has to approve SetterFi before you can connect, and that review is ours to chase. You will be able to connect from this same button the day it clears.",
  meanwhile: "In the meantime, your assistant can still answer text messages once the carriers finish their review.",
} as const;

/** The sentence after a 202: what works now and when, and the fact that older messages are left alone. */
export function connectedCopy(channel: ConnectChannel, label: string, date: Date): { title: string; body: string; older: string } {
  const words = CHANNEL_WORDS[channel];
  return {
    title: `${words.name} is connected`,
    body: `Connected to ${label} on ${longDate(date)}. Your assistant starts answering new messages there straight away.`,
    older: "Messages sent before now are left alone.",
  };
}

export function longDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" }).format(date);
}

/** Parse `GET /api/channels/meta/assets`. Unknown shapes are an empty list, never a guess. */
export function parseConnectAssets(value: unknown, channel: ConnectChannel): readonly ConnectAsset[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { items?: unknown }).items)) return [];
  const items = (value as { items: unknown[] }).items;
  const parsed: ConnectAsset[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.assetId !== "string" || typeof record.label !== "string") continue;
    if (record.channel !== channel) continue;
    parsed.push({
      assetId: record.assetId,
      channel,
      label: record.label,
      eligible: record.eligible === true,
      reason: typeof record.reason === "string" && record.reason.trim() ? record.reason : null,
    });
  }
  return parsed;
}

/**
 * Which account the list should start on: the only eligible one when there is exactly one, so a
 * coach with a single business page presses one button rather than two. More than one eligible
 * account starts unchosen, because guessing between two pages is how the wrong one gets connected.
 */
export function defaultChoice(items: readonly ConnectAsset[]): string | null {
  const eligible = items.filter((item) => item.eligible);
  return eligible.length === 1 ? eligible[0].assetId : null;
}

/** How long the sheet waits on an open window before it gives up. Ten minutes, the state row's own expiry. */
export const WAIT_LIMIT_MS = 10 * 60 * 1_000;
/** How often the sheet asks whether the callback has landed. */
export const POLL_INTERVAL_MS = 1_500;

/** What the sheet's window is called, so a second press reuses it rather than opening a third. */
export const SIGN_IN_WINDOW_NAME = "setterfi-facebook-sign-in";
export const SIGN_IN_WINDOW_FEATURES = "popup,width=640,height=760,resizable,scrollbars";

/** Where the sign-in window lands when it finishes, a page that only says "you can close this". */
export const SIGN_IN_WINDOW_RETURN_PATH = "/coach/meta-login";

/** The query the callback appends, read on mount so a redirect without a window resumes the sheet. */
export const RETURN_QUERY = { key: "meta", chooseValue: "select_asset", errorValue: "connection_error" } as const;
