/**
 * The Connections tab's view model: the rows `/coach/integrations` already reads, reduced to the
 * five cards `CoachConnections.body.html` draws.
 *
 * Pure, and deliberately so. Every input here is a shape an existing repository already returns
 * (`listChannelConnections`, `loadCoachA2pRegistration`, `listCapiDatasets`, the primary
 * `calendar_connections` row), so nothing in this module reads anything: the page loads, this maps.
 *
 * The states are read off receipts rather than off a wish. A channel is Live only where a signed
 * round trip is recorded, because that receipt is the only evidence the connection can both send
 * and receive; every other state says what is actually stored, and a read that did not answer is
 * absent rather than "not connected".
 */

import type {
  RehaulConnectionCard,
  RehaulConnectionSurface,
  RehaulSmsRegistration,
} from "@/components/workspace/rehaul/coach-agent";
import { workspaceDateTimeFormat } from "@/lib/format/datetime";
import type { CoachA2pRegistrationProjection } from "@/lib/repositories/onboarding-evidence";
import type { CapiDatasetSnapshot } from "@/lib/repositories/capi-datasets";
import type { ChannelConnectionView } from "@/lib/repositories/channel-connections";

/** The primary `calendar_connections` row, narrowed to what a coach reads about it. */
export type RehaulCalendarSnapshot = {
  name: string | null;
  provider: "ghl" | "google";
  state: "disconnected" | "connecting" | "ready" | "error" | "expired";
  lastSlotFetchAt: string | null;
  lastSlotFetchOk: boolean | null;
};

/**
 * The calendar provider in SetterFi's words. The backing vendor's name never reaches a coach, so
 * the workspace calendar is named for the workspace, matching what onboarding called it.
 */
const CALENDAR_PROVIDER_LABELS: Record<RehaulCalendarSnapshot["provider"], string> = {
  ghl: "SetterFi workspace calendar",
  google: "Google Calendar",
};

const CHANNEL_ORDER = ["instagram", "messenger", "whatsapp", "sms"] as const;

/**
 * The coach-facing name for each card, indexed rather than derived.
 *
 * The repository's own `channelLabel` is an operator label ("Facebook Messenger", "Text messages
 * (SMS)") and the old fallback upper-cased the raw key, which printed "Whatsapp" and would print a
 * vendor key verbatim the day one appears. This map is the whole vocabulary: a key outside it has
 * no card, so no string munging can leak one.
 */
const CHANNEL_LABELS: Record<(typeof CHANNEL_ORDER)[number], string> = {
  instagram: "Instagram",
  messenger: "Messenger",
  sms: "SMS",
  whatsapp: "WhatsApp",
};

function stamp(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : workspaceDateTimeFormat.format(date);
}

function channelCard(
  connection: ChannelConnectionView,
  channel: (typeof CHANNEL_ORDER)[number],
): RehaulConnectionCard {
  const roundTrip = stamp(connection.receipts.signedRoundTripAt);
  const base = {
    key: channel,
    label: CHANNEL_LABELS[channel],
    eyebrow: "Where it talks",
    rows: [] as readonly { label: string; value: string }[],
    footLabel: null as string | null,
    footValue: null as string | null,
  };

  if (connection.state === "live" && roundTrip) {
    return {
      ...base,
      tone: "good",
      stateLabel: "Live",
      sentence: `A signed round trip on ${roundTrip} confirms it can send and receive.`,
      footLabel: "Account",
      footValue: connection.externalAccountLabel ?? "not recorded",
      action: null,
    };
  }

  if (connection.state === "expired" || connection.state === "error") {
    // The artboard dates the expiry. `tokenExpiresAt` is the column that records it, so the date
    // is printed only where one was actually stored and the sentence drops it otherwise.
    const expiredOn = connection.state === "expired" ? stamp(connection.tokenExpiresAt) : null;
    return {
      ...base,
      tone: "amber",
      stateLabel: connection.state === "expired" ? "Reconnect needed" : "Not sending",
      sentence:
        connection.error ??
        (expiredOn
          ? `The sign-in expired on ${expiredOn}, so replies here are paused.`
          : "The stored sign-in stopped working, so replies here are paused."),
      action: { label: "Reconnect", href: "/coach/integrations" },
    };
  }

  if (connection.state === "ready" || connection.state === "pending_review") {
    return {
      ...base,
      tone: "amber",
      stateLabel: connection.state === "ready" ? "Not verified yet" : "Awaiting review",
      sentence: "No signed round trip recorded.",
      footLabel: "Account",
      footValue: connection.externalAccountLabel ?? "not recorded",
      action: null,
    };
  }

  return {
    ...base,
    tone: "grey",
    stateLabel: "Not connected",
    sentence: "Your agent cannot reach leads here until you sign in.",
    action: { label: "Connect", href: "/coach/integrations" },
  };
}

function calendarCard(calendar: RehaulCalendarSnapshot | null): RehaulConnectionCard | null {
  if (!calendar) return null;
  const label = CALENDAR_PROVIDER_LABELS[calendar.provider];
  const checked = stamp(calendar.lastSlotFetchAt);
  const verified = calendar.state === "ready" && calendar.lastSlotFetchOk === true;
  const rows: { label: string; value: string }[] = [];
  if (calendar.name) rows.push({ label: "Books into", value: calendar.name });
  if (checked) rows.push({ label: "Last availability check", value: checked });

  return {
    key: "calendar",
    label,
    eyebrow: "Where it books",
    tone: verified ? "good" : calendar.state === "disconnected" ? "grey" : "amber",
    stateLabel: verified
      ? "Availability confirmed"
      : calendar.state === "disconnected"
        ? "Not connected"
        : "Availability not confirmed",
    sentence: verified
      ? "Slots read cleanly, so your agent can offer a time."
      : "Booking is off.",
    footLabel: null,
    footValue: null,
    action: calendar.state === "disconnected" ? { label: "Connect", href: "/coach/integrations" } : null,
    rows,
  };
}

function smsRegistration(
  registration: CoachA2pRegistrationProjection | null,
): RehaulSmsRegistration | null {
  if (!registration) return null;
  const done = !registration.terminalRejection && registration.registrationState === "done";
  return {
    submittedAt: registration.submittedAt,
    rejected: registration.terminalRejection,
    /*
     * The tone follows the state rather than the panel. Amber is the persistent pending colour and
     * a refusal is not pending, so a terminal refusal drops out of amber; "Registered" is a state
     * the carrier confirmed back to us, which is the only thing allowed to read green here.
     */
    tone: registration.terminalRejection ? "grey" : done ? "good" : "amber",
    stateLabel: registration.terminalRejection
      ? "Registration refused"
      : done
        ? "Registered"
        : "Awaiting carrier",
  };
}

/**
 * What the ad platform is told, and whether the dataset behind it actually exists. "Connected"
 * requires a dataset row in the connected state; anything else says it is not set up rather than
 * implying events are flowing.
 */
function adPlatform(datasets: readonly CapiDatasetSnapshot[] | null) {
  if (datasets === null) return null;
  const connected = datasets.some((dataset) => dataset.status === "connected");
  return {
    connected,
    label: connected ? "Qualified and booked, per keyword" : "Nothing is being sent yet",
  };
}

export function rehaulConnectionSurface(input: {
  connections: readonly ChannelConnectionView[] | null;
  calendar: RehaulCalendarSnapshot | null;
  registration: CoachA2pRegistrationProjection | null;
  datasets: readonly CapiDatasetSnapshot[] | null;
}): RehaulConnectionSurface {
  const byChannel = new Map(
    (input.connections ?? []).map((connection) => [connection.channel, connection]),
  );
  return {
    cards:
      input.connections === null
        ? null
        : CHANNEL_ORDER.map((channel) => {
            const connection = byChannel.get(channel);
            if (connection) return channelCard(connection, channel);
            return {
              key: channel,
              label: CHANNEL_LABELS[channel],
              eyebrow: "Where it talks",
              tone: "grey" as const,
              stateLabel: "Not connected",
              sentence: "Your agent cannot reach leads here until you sign in.",
              footLabel: null,
              footValue: null,
              action: { label: "Connect" as const, href: "/coach/integrations" },
              rows: [],
            };
          }),
    calendar: calendarCard(input.calendar),
    sms: smsRegistration(input.registration),
    adPlatform: adPlatform(input.datasets),
  };
}
