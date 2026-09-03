/**
 * What the "Connect where your leads message you" step says about each channel.
 *
 * Pure, so the honest-state rules on this screen are testable without a browser or a database.
 * Three of them matter more than the layout:
 *
 *   1. **Nothing reads connected without a receipt.** The Meta cards go green only on
 *      `state === "live"` with a `signedRoundTripAt` -- a real message that made a round trip.
 *      `ready` means the OAuth finished and nothing has been proved yet, and it says so.
 *   2. **The SMS card never offers an instant action and never states a finish date.** Carrier
 *      A2P vetting takes two to three weeks per coach, and `CLAUDE.md` allows a day counter and
 *      forbids a percentage or a predicted date. Once details are filed the card carries a
 *      `wait` and no action at all, because there is nothing the coach can do to move it.
 *   3. **No GoHighLevel anywhere.** The connect destinations are the coach's own setup screens.
 *
 * The detail line under a connected card is the provider's own account label, never a synthesised
 * one: when the column is empty the card omits the line instead of guessing a handle.
 */

import type { Tone } from "@/components/kit/atomics";
import type { CoachA2pRegistrationProjection } from "@/lib/repositories/onboarding-evidence";
import type { ChannelConnectionView } from "@/lib/repositories/channel-connections";

export const CONNECT_CARD_KEYS = ["instagram", "messenger", "sms"] as const;
export type ConnectCardKey = (typeof CONNECT_CARD_KEYS)[number];

export type ConnectCardAction = { href: string; label: string };

export type ConnectCard = {
  key: ConnectCardKey;
  eyebrow: string;
  name: string;
  /** What the channel does for the coach. The canvas's sentence, unchanged. */
  body: string;
  /** The line under the body: the promise, or the honest wait. Never a date. */
  note: string;
  status: { label: string; tone: Tone } | null;
  /** The provider's own account label, when the row carries one. */
  detail: string | null;
  /**
   * When a message last made a signed round trip on this channel, straight off
   * `receipts.signedRoundTripAt`.
   *
   * The one receipt on the row that proves the channel actually works, so the screen can state the
   * day it was proved rather than only the word "Answering". Null on every card that has no such
   * receipt, the SMS card included -- there is no round trip to prove while the carriers still
   * hold the registration.
   */
  provedAt: string | null;
  action: ConnectCardAction | null;
  /** Set only on the SMS card, and only once details are actually with the carriers. */
  wait: { since: string } | null;
};

const META_COPY = {
  instagram: {
    body: "Your agent answers every DM and every story reply on your business account. You keep full control of the account.",
    eyebrow: "Direct messages",
    name: "Instagram",
    note: "Answering within a day of you connecting it.",
  },
  messenger: {
    body: "Anyone who messages your Facebook page gets the same agent, with the same answers, in the same voice.",
    eyebrow: "Page messages",
    name: "Facebook Messenger",
    note: "Answering within a day of you connecting it.",
  },
} as const;

/**
 * The one destination in the product that actually starts a channel connection: Connections
 * calls `POST /api/channels/meta/connect` itself. It used to be Setup, which only linked back to
 * Connections, and the two pages sent a coach round in a circle with no Meta login in it.
 */
const CONNECT_HREF = "/coach/integrations";

function metaCard(
  key: "instagram" | "messenger",
  connection: ChannelConnectionView | undefined,
): ConnectCard {
  const copy = META_COPY[key];
  const base = { ...copy, detail: null, key, provedAt: null, wait: null } satisfies Omit<
    ConnectCard,
    "action" | "status"
  >;
  const label = connection?.externalAccountLabel?.trim() || null;
  const provedAt = connection?.receipts.signedRoundTripAt ?? null;

  if (connection?.state === "live" && connection.receipts.signedRoundTripAt) {
    return {
      ...base,
      action: null,
      detail: label,
      note: "Answering your messages now.",
      provedAt,
      status: { label: "Answering", tone: "good" },
    };
  }
  if (connection?.state === "ready") {
    return {
      ...base,
      action: { href: CONNECT_HREF, label: "Finish connecting" },
      detail: label,
      provedAt,
      note: "Connected, but no message has made a round trip yet, so it is not answering.",
      status: { label: "Not answering yet", tone: "waiting" },
    };
  }
  if (
    connection?.state === "error"
    || connection?.state === "expired"
    || connection?.state === "blocked_permanent"
  ) {
    return {
      ...base,
      action: { href: CONNECT_HREF, label: `Reconnect ${copy.name}` },
      detail: label,
      provedAt,
      note: connection.error ?? "The connection stopped working and no reason was recorded.",
      status: { label: "Needs reconnecting", tone: "failure" },
    };
  }
  if (connection && connection.state !== "disconnected") {
    return {
      ...base,
      action: { href: CONNECT_HREF, label: "Open setup" },
      detail: label,
      provedAt,
      note: "Connecting. Nothing for you to do while this finishes.",
      status: { label: "Connecting", tone: "waiting" },
    };
  }
  return {
    ...base,
    action: { href: CONNECT_HREF, label: `Connect ${copy.name}` },
    detail: null,
    status: null,
  };
}

function smsCard(registration: CoachA2pRegistrationProjection | null): ConnectCard {
  const base = {
    // No round trip can be proved while the carriers still hold the registration.
    provedAt: null,
    body: "This one does not switch on today. Sending business texts in the US means the phone carriers vet your business first, and that takes about three weeks.",
    detail: null,
    eyebrow: "SMS to your business number",
    key: "sms",
    name: "Text messaging",
  } satisfies Omit<ConnectCard, "action" | "note" | "status" | "wait">;

  if (registration?.terminalRejection) {
    return {
      ...base,
      action: { href: "/coach/integrations", label: "Review what needs changing" },
      note: "The carriers refused this registration. It has to be corrected before it can be filed again.",
      status: { label: "Refused by the carriers", tone: "failure" },
      wait: null,
    };
  }
  if (registration?.submittedAt) {
    return {
      ...base,
      // Deliberately no action. The details are filed and the clock belongs to the carriers, so
      // any button here would be one the coach presses hoping it does something.
      action: null,
      note: "Your details are with the carriers. We show you the day count, never a finish date, because no one gets one.",
      status: { label: "With the carriers", tone: "waiting" },
      wait: { since: registration.submittedAt },
    };
  }
  return {
    ...base,
    action: { href: "/onboarding/sms-eligibility", label: "Send my details to the carriers" },
    note: "Filing your details starts the review. We show you the day count, never a finish date, because no one gets one.",
    status: null,
    wait: null,
  };
}

export function connectCards(input: {
  connections: readonly ChannelConnectionView[];
  registration: CoachA2pRegistrationProjection | null;
}): ConnectCard[] {
  const byChannel = new Map(input.connections.map((row) => [row.channel, row]));
  return [
    metaCard("instagram", byChannel.get("instagram")),
    metaCard("messenger", byChannel.get("messenger")),
    smsCard(input.registration),
  ];
}

/**
 * Whether the connect step can be ticked in the four-step strip.
 *
 * One Meta channel genuinely answering is the bar, and it is a receipt: a round trip a provider
 * signed. `ready` is not enough -- the OAuth finishing proves a token exists, not that a lead's
 * message reaches the agent -- and the SMS card can never satisfy this, because it is still weeks
 * from working when the rest of setup is done.
 */
export function connectStepComplete(connections: readonly ChannelConnectionView[]) {
  return connections.some(
    (row) =>
      (row.channel === "instagram" || row.channel === "messenger")
      && row.state === "live"
      && Boolean(row.receipts.signedRoundTripAt),
  );
}
