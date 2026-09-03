'use client';

import {
  AtSign,
  CalendarDays,
  Check,
  MessageCircleMore,
  MessagesSquare,
  Phone,
  RefreshCw,
  X,
  type LucideIcon,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, type KeyboardEvent, type ReactNode } from "react";

import {
  Figure,
  IconTile,
  KitButton,
  MonoMeta,
  Prose,
  Status,
  StatusDot,
  Surface,
  type Tone,
} from "@/components/kit/atomics";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DataState } from "@/components/kit/data-state";
import { DayCounter, elapsedWorkspaceDays } from "@/components/kit/day-counter";
import { ExportMenu } from "@/components/kit/export-menu";
import { LoggedButton } from "@/components/kit/logged-button";
import { CoachPageHead } from "@/components/workspace/live/coach-page-head";
import { TechnicalDetail } from "@/components/kit/technical-detail";
import { receiptState } from "@/lib/copy/states";
import { workspaceTimestampFormat } from "@/lib/format/datetime";
import { coachIntegrationLabel } from "@/lib/integrations/coach-integration-labels";
import { CARRIER_TYPICAL_DAYS } from "@/lib/onboarding/contracts";
import type { ChannelConnectionView } from "@/lib/repositories/channel-connections";
import type {
  CapiDatasetChannel,
  CapiDatasetSnapshot,
} from "@/lib/repositories/capi-datasets";
import type { MessageTemplateView } from "@/lib/repositories/message-templates";
import type { CoachA2pRegistrationProjection } from "@/lib/repositories/onboarding-evidence";
import {
  COACH_EYEBROW_CLASS,
  COACH_PANEL_NAME_CLASS,
} from "@/components/workspace/live/coach-type";
import { cn } from "@/lib/utils";
import {
  COACH_MESSAGING_CONNECTION_NOTE,
  type CoachMessagingConnectionState,
} from "./coach-messaging-connection-view-models";
import {
  PHASE4_CHANNELS,
  deriveChannelTruths,
  type ChannelTruth,
  type Phase4Channel,
} from "./view-models";

const CHANNEL_ICONS: Record<Phase4Channel, LucideIcon> = {
  instagram: AtSign,
  messenger: MessagesSquare,
  whatsapp: MessageCircleMore,
  sms: Phone,
};

const CHANNEL_ORDER: Record<Phase4Channel, number> = {
  sms: 0,
  instagram: 1,
  messenger: 2,
  whatsapp: 3,
};

/*
 * Every connection takes an identical face on purpose: this page is one kind of object in several
 * states, so the frame has to be the constant that makes the state differences legible. What
 * differs card to card is the interior the state earns - a carrier review gets a day-counter well
 * the others never draw, a connected channel gets a receipt line, a broken one gets neither.
 *
 * The face, the well, the overline, the mono readout and the status pill are the kit's now rather
 * than this file's. They used to be five class strings retyped here, which is how the nine coach
 * surfaces ended up with an overline at three sizes; the craft audit of 2026-08-30 named that as
 * the drift the prose brief could not prevent. What stays local is only what the kit has no
 * answer for.
 */
/*
 * Coach sizes. This page renders inside the coach shell, which `coach.css` has already raised to a
 * 16px root -- but an absolute px value in a class does not move with a root font-size, so this
 * string went on printing at the console's density on the screen a coach opens when something is
 * broken. `coach-type.ts` exists for exactly this trap, and the card title that used to sit beside
 * this one has moved there as `COACH_PANEL_NAME_CLASS` -- it was declared here and byte-identically
 * in `get-started-checklist.tsx`, which is one constant kept in two places under one name.
 */
const CARD_SUB_CLASS = "text-[16px] leading-[1.55] text-[color:var(--faint)]";

/**
 * The carrier's own clock, now read from the one place that owns it.
 *
 * This file used to declare its own `[14, 21]`, which meant the wait an operator reads and the
 * wait a coach reads could be edited apart: `admin-channel-health.tsx` and `admin-provisioning.tsx`
 * still carry copies of the same pair, and converging those on this constant is outstanding
 * work. Re-exported
 * rather than merely imported because `coach-integrations.test.tsx` reads it from here to check
 * the managed strip's sentence, and that check should keep pointing at whatever this page uses.
 */
export { CARRIER_TYPICAL_DAYS };

/**
 * The page's single accent fill. It belongs to the one connection the coach is actually meant to
 * act on right now, which is the first card in priority order that carries a required action of
 * theirs. Every other action on the page is a quiet secondary, and a page where SetterFi and the
 * carriers own everything spends no fill at all.
 */
const ACCENT_FILL_CLASS =
  "inline-flex h-[var(--coach-target-primary)] items-center justify-center rounded-[12px] border border-[var(--accent-line)] bg-[var(--accent-fill)] px-[24px] text-[17px] leading-none font-semibold text-[color:var(--on-accent)] shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_8px_20px_-8px_var(--accent)]";
const QUIET_ACTION_CLASS =
  "inline-flex h-[var(--coach-target)] shrink-0 items-center rounded-[10px] border border-[var(--line)] bg-[rgba(255,255,255,0.04)] px-[16px] text-[16px] leading-none text-[color:var(--body)] hover:border-[var(--accent-edge)] hover:text-[color:var(--ink)]";

export type ConnectionActivity = {
  checked: boolean;
  at: string | null;
};

export type ConnectionErrorRead = {
  checked: boolean;
  message: string | null;
};

export type A2pRegistrationRead = {
  checked: boolean;
  registration: CoachA2pRegistrationProjection | null;
};

export type CalendarConnectionSnapshot = {
  id: string;
  name: string | null;
  provider: "ghl" | "google";
  state: "disconnected" | "connecting" | "ready" | "error" | "expired";
  timezone: string;
  lastSlotFetchAt: string | null;
  lastSlotFetchOk: boolean | null;
  lastError: ConnectionErrorRead;
  createdAt: string;
  updatedAt: string;
};

export type CalendarConnectionRead = {
  checked: boolean;
  connection: CalendarConnectionSnapshot | null;
};

export type ConversionTrackingRead = {
  enabled: boolean;
  checked: boolean;
  datasets: readonly CapiDatasetSnapshot[];
};

type ConversionTrackingState = {
  channel: CapiDatasetChannel;
  checked: boolean;
  connected: boolean;
  label: "Conversion tracking: connected" | "Conversion tracking: not set up";
  detail: string;
};

/**
 * The calendar provider in words a coach reads, and the reason the map exists.
 *
 * The stored values stay as the database enum has them, because that is what
 * `calendar_connections.provider` and the booking driver expect. The words a coach reads are
 * SetterFi's instead: the backend booking vendor is plumbing, and `CLAUDE.md` makes keeping its
 * branding off every client-visible surface a hard rule. `coach-integrations.test.ts` reads this
 * file as source and fails on the vendor's name appearing in it at all, comments included. The
 * naming matches
 * `src/app/onboarding/calendar/page.tsx`, which already had to make this exact decision on the
 * route where a coach picks the provider; a coach who picked "SetterFi workspace calendar" there
 * has to find the same name here or the two pages are describing different calendars.
 */
const CALENDAR_PROVIDER_LABELS: Readonly<Record<CalendarConnectionSnapshot["provider"], string>> = {
  ghl: "SetterFi workspace calendar",
  google: "Google Calendar",
};

type ConnectionAction = {
  label: "Connect" | "Reconnect";
  href: string;
  required: boolean;
};

type ProviderCommandTarget = "channel" | "google-calendar";

type ConnectionRow = {
  id: string;
  label: string;
  icon: LucideIcon;
  detail: ReactNode;
  detailExport: string;
  receiptSummary: string | null;
  stateLabel: string;
  /**
   * The kit's seven-tone scale, not the legacy five. `critical` split three ways in the
   * 2026-08-30 ruling and a broken connection is a state, so it is `failure`; `info` became
   * `waiting`, since a column of accent pills reads as a column of selected rows.
   */
  tone: Tone;
  priority: number;
  action: ConnectionAction | null;
  owner: "you" | "setterfi" | "carrier" | "none";
  activity: ConnectionActivity;
  /** The eyebrow for the activity well: what the timestamp inside it is a timestamp of. */
  activityLabel: string;
  connectionId: string | null;
  providerDisconnectSupported: boolean;
  /**
   * Which route this row's provider commands go to, and the reason it is a row property rather
   * than a branch inside the command runner.
   *
   * `/api/channel-actions/[connectionId]/[command]` selects from `channel_connections` and refuses
   * any provider outside `ghl` and `meta_direct`, so a `calendar_connections` id resolves to
   * nothing there and every command against it comes back refused. A Google calendar has its own
   * disconnect route and no provider-check route at all, so the row that knows what it is stored
   * as is the row that decides where its commands go -- and `null` is the honest answer for a row
   * whose provider has no command route, which is what keeps the buttons off it.
   */
  commandTarget: ProviderCommandTarget | null;
  rawState: string | null;
  lastError: ConnectionErrorRead;
  history: readonly { label: string; at: string; successful: boolean }[];
  technical: readonly { label: string; value: string }[];
  whatToTry: string;
  replyWindow: string;
  conversionTracking: ConversionTrackingState | null;
};

/**
 * The two questions this page answers, in the order a coach asks them. A row belongs to a band by
 * what it is for, never by how healthy it is, so a band never empties itself by having good news.
 */
const CONNECTION_BANDS: readonly { label: string; holds: (row: ConnectionRow) => boolean }[] = [
  { label: "Where it talks", holds: (row) => row.id.startsWith("channel:") },
  { label: "Where it books", holds: (row) => !row.id.startsWith("channel:") },
];

type ProviderCommand = "test" | "disconnect";

type ProviderCommandState = {
  connectionId: string;
  command: ProviderCommand;
  phase: "pending" | "confirmed" | "failed";
  message: string;
  receiptId?: string;
  auditId?: number;
  code?: string;
};

type DatasetCommandState = {
  channel: CapiDatasetChannel;
  phase: "pending" | "confirmed" | "failed";
  message: string;
  auditId?: string;
};

function conversionTrackingState(
  channel: Phase4Channel,
  read: ConversionTrackingRead,
  connectionId: string | null,
): ConversionTrackingState | null {
  if (!read.enabled || channel === "sms") return null;
  const dataset = read.datasets.find((candidate) => candidate.channel === channel);
  const receipt = dataset?.providerReceipt ?? {};
  const connected = read.checked && connectionId !== null &&
    dataset?.channelConnectionId === connectionId && dataset.status === "connected" && !dataset.isMock &&
    Boolean(dataset.datasetId) && Boolean(dataset.provisionedAt) &&
    receipt.provider === "meta" && receipt.mode === "real" &&
    receipt.operation === "get_or_create" && receipt.accepted === true;
  const eventCopy = channel === "instagram"
    ? "QualifiedLead and Purchase are measured for Instagram. Instagram is measurement only, not ad optimization."
    : "QualifiedLead and Purchase can be used for Messenger and WhatsApp click-to-message ad optimization.";
  return {
    channel,
    checked: read.checked,
    connected,
    label: connected ? "Conversion tracking: connected" : "Conversion tracking: not set up",
    detail: `${eventCopy} Custom conversion labels are set by the account owner in Ads Manager, not in SetterFi.`,
  };
}

type ProviderCommandReceipt = {
  receiptId: string;
  auditId: number;
  outcome: "verified" | "not_verified" | "started" | "replayed";
  code: string;
};

function providerCommandReceipt(value: unknown): ProviderCommandReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = (value as { receipt?: unknown }).receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return null;
  const candidate = receipt as Partial<ProviderCommandReceipt>;
  if (
    typeof candidate.receiptId !== "string" || !candidate.receiptId.trim()
    || typeof candidate.auditId !== "number" || !Number.isSafeInteger(candidate.auditId) || candidate.auditId <= 0
    || !["verified", "not_verified", "started", "replayed"].includes(candidate.outcome ?? "")
    || typeof candidate.code !== "string" || !candidate.code.trim()
  ) return null;
  return candidate as ProviderCommandReceipt;
}

function providerCommandKey(command: ProviderCommand, connectionId: string) {
  const nonce = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  return `coach-connection:${command}:${connectionId}:${nonce}`;
}

function safeDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function absoluteTime(value: string) {
  const date = safeDate(value);
  return date ? workspaceTimestampFormat.format(date) : "Time could not be read";
}

function relativeTime(value: string, now: Date) {
  const date = safeDate(value);
  if (!date) return "Time could not be read";
  const seconds = Math.round((date.getTime() - now.getTime()) / 1_000);
  const absoluteSeconds = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (absoluteSeconds < 60) return formatter.format(seconds, "second");
  if (absoluteSeconds < 3_600) return formatter.format(Math.round(seconds / 60), "minute");
  if (absoluteSeconds < 86_400) return formatter.format(Math.round(seconds / 3_600), "hour");
  return formatter.format(Math.round(seconds / 86_400), "day");
}

function toneForChannel(channel: ChannelTruth): Tone {
  if (channel.tone === "good") return "good";
  if (channel.tone === "pending") return "warning";
  if (channel.tone === "bad") return "failure";
  return "neutral";
}

function receiptHistory(channel: ChannelTruth, connection: ChannelConnectionView | null) {
  const receiptTimes = connection?.receipts ?? null;
  if (!receiptTimes) return [];
  const times = [
    { label: "Account permission confirmed", at: receiptTimes.oauthCompletedAt },
    { label: "Account asset confirmed", at: receiptTimes.assetVerifiedAt },
    { label: "Message delivery subscribed", at: receiptTimes.webhookSubscribedAt },
    { label: "Signed round trip received", at: receiptTimes.signedRoundTripAt },
  ];

  const completed = channel.prerequisites.map((item, index) => ({
    label: times[index]?.label ?? item.label,
    at: times[index]?.at ?? null,
    successful: item.complete,
  }));
  return completed
    .filter((item): item is { label: string; at: string; successful: boolean } => item.at !== null)
    .sort((left, right) => right.at.localeCompare(left.at));
}

function technicalReceipts(connection: ChannelConnectionView | null) {
  if (!connection) return [];
  return [
    { label: "OAuth receipt", value: connection.receipts.oauthCompletedAt },
    { label: "Asset receipt", value: connection.receipts.assetVerifiedAt },
    { label: "Webhook receipt", value: connection.receipts.webhookSubscribedAt },
    { label: "Round-trip receipt", value: connection.receipts.signedRoundTripAt },
  ].flatMap((item) => item.value ? [{ label: item.label, value: item.value }] : []);
}

function socialRow(input: {
  channel: ChannelTruth;
  connection: ChannelConnectionView | null;
  activity: ConnectionActivity;
  lastError: ConnectionErrorRead;
  registration: A2pRegistrationRead;
  now: Date;
  conversionTracking: ConversionTrackingState | null;
}): ConnectionRow {
  const { channel, connection, activity, lastError, registration, now, conversionTracking } = input;
  const label = coachIntegrationLabel(channel.channel);
  const proof = connection ? receiptState(connection.receipts) : "connecting";
  const isSms = channel.channel === "sms";
  const live = connection?.state === "live" && proof === "live";
  const readyToTest = !live
    && proof === "ready"
    && (connection?.state === "ready" || connection?.state === "live");
  const registrationState = registration.registration?.registrationState ?? null;
  const terminalRegistration = registration.checked && (
    registration.registration?.terminalRejection === true
    || registrationState === "blocked"
  );

  let stateLabel = channel.stateLabel;
  let tone = toneForChannel(channel);
  let priority = 5;
  let action: ConnectionAction | null = null;
  let owner: ConnectionRow["owner"] = "setterfi";
  let whatToTry = "SetterFi is checking the saved connection evidence.";
  let detailExport = channel.accountLabel
    ? `${label} account ${channel.accountLabel}`
    : `${label} has no saved account`;
  let detail: ReactNode = connection?.externalAccountLabel
    ? `Using ${connection.externalAccountLabel}.`
    : "No account receipt is stored yet.";
  let receiptSummary = connection?.receipts.signedRoundTripAt
    ? `Signed round trip received ${absoluteTime(connection.receipts.signedRoundTripAt)}. Receipt stored.`
    : connection?.receipts.assetVerifiedAt
      ? `Account asset confirmed ${absoluteTime(connection.receipts.assetVerifiedAt)}.`
      : connection?.receipts.oauthCompletedAt
        ? `Account permission confirmed ${absoluteTime(connection.receipts.oauthCompletedAt)}.`
        : null;

  if (isSms && terminalRegistration) {
    stateLabel = "Blocked";
    tone = "failure";
    detail = "Carrier registration was permanently declined. SetterFi is reviewing the decision and the saved registration evidence.";
    detailExport = String(detail);
    whatToTry = "SetterFi owns the next review. There is nothing for you to retry here.";
  } else if (live) {
    stateLabel = "Live";
    tone = "good";
    owner = "none";
    detail = connection.externalAccountLabel
      ? `Replying through ${connection.externalAccountLabel}.`
      : "A signed round trip confirms this channel can send and receive.";
    detailExport = String(detail);
    whatToTry = "The signed provider round trip is already stored. There is no connection step for you to run.";
  } else if (isSms) {
    const filed = registration.registration?.submittedAt ?? null;

    if (!registration.checked) {
      stateLabel = "We could not check this";
      tone = "neutral";
      detail = "The carrier registration check did not run, so this row cannot claim a setup state.";
      whatToTry = "Check again later. No registration state was inferred from the failed read.";
    } else if (registrationState === "awaiting_coach") {
      stateLabel = "Awaiting you";
      tone = "warning";
      owner = "you";
      action = { label: "Connect", href: "/coach/get-started", required: true };
      detail = "Registration needs information from Setup before it can move to carrier review.";
      whatToTry = "Open Setup and complete the requested registration information.";
    } else if (registrationState === "awaiting_provider" || (registrationState === "running" && filed)) {
      stateLabel = "Awaiting carrier";
      tone = "warning";
      owner = "carrier";
      detail = filed ? (
        <DayCounter now={now} since={filed} typicalDays={CARRIER_TYPICAL_DAYS} />
      ) : "Carrier review is recorded, but its filing time could not be confirmed.";
      receiptSummary = filed
        ? `Registration filed ${absoluteTime(filed)}. Filing receipt stored.`
        : receiptSummary;
      whatToTry = "The carrier owns this review. There is nothing for you to retry here.";
    } else if (registrationState === "done" && readyToTest) {
      stateLabel = "Ready to test";
      tone = "waiting";
      detail = "Registration and account receipts are stored. A signed round trip is still needed before this reads Live.";
      whatToTry = "SetterFi owns the signed provider check. There is nothing for you to run here.";
    } else if (registrationState === "done") {
      stateLabel = "Setup finishing";
      tone = "waiting";
      detail = "Carrier registration is complete. SetterFi is reconciling the channel receipts before testing is available.";
      whatToTry = "SetterFi owns the receipt check. Testing cannot advance this state yet.";
    } else if (registrationState === "failed") {
      stateLabel = "Setup needs review";
      tone = "failure";
      detail = "Text messaging setup did not complete. SetterFi is reviewing the saved failure.";
      whatToTry = "SetterFi owns the next review. Testing cannot advance this state.";
    } else if (registrationState === "awaiting_platform") {
      stateLabel = "Waiting on SetterFi";
      tone = "warning";
      detail = "The registration evidence is with SetterFi for the next setup step.";
      whatToTry = "SetterFi owns the next step. There is nothing for you to retry here.";
    } else if (registrationState === "pending" || registrationState === "running") {
      stateLabel = "Setup in progress";
      tone = "waiting";
      detail = "SetterFi is preparing the carrier registration. Testing cannot advance it yet.";
      whatToTry = "SetterFi owns the setup work. There is nothing for you to retry here.";
    } else {
      stateLabel = "Waiting to file";
      tone = "neutral";
      detail = "SetterFi files the carrier registration after the required business and consent evidence is ready.";
      whatToTry = "SetterFi owns the filing step. There is nothing for you to retry here.";
    }
    detailExport = typeof detail === "string"
      ? detail
      : filed
        ? `Carrier review started ${filed}`
        : "Carrier review time could not be confirmed";
  } else {
    switch (connection?.state) {
      case undefined:
      case "disconnected":
        stateLabel = "Not connected";
        tone = "neutral";
        owner = "you";
        action = { label: "Connect", href: "/coach/get-started", required: true };
        detail = "No connection receipt is stored yet.";
        whatToTry = "Open Setup and connect the account you want your agent to use.";
        break;
      case "error":
      case "expired":
      case "restricted":
        stateLabel = "Reconnect needed";
        tone = "warning";
        owner = "you";
        action = { label: "Reconnect", href: "/coach/get-started", required: true };
        detail = "The saved connection no longer has enough current evidence to receive messages.";
        whatToTry = "Reconnect the account from Setup, then run a signed test message.";
        break;
      case "ready":
        if (readyToTest) {
          stateLabel = "Ready to test";
          tone = "waiting";
          detail = "Account and asset receipts are stored. A signed round trip is still needed before this reads Live.";
          whatToTry = "SetterFi owns the signed provider check. There is nothing for you to run here.";
        } else {
          stateLabel = "Setup incomplete";
          tone = "warning";
          detail = "The connection is marked ready, but the account receipts needed for a test are incomplete.";
          whatToTry = "SetterFi is reconciling the account receipts. Testing cannot advance this state yet.";
        }
        break;
      case "live":
        if (readyToTest) {
          stateLabel = "Ready to test";
          tone = "waiting";
          detail = "Account and asset receipts are stored. A signed round trip is still needed before this reads Live.";
          whatToTry = "SetterFi owns the signed provider check. There is nothing for you to run here.";
        } else {
          stateLabel = "Setup incomplete";
          tone = "failure";
          detail = "The connection is marked live, but no signed round-trip receipt proves it.";
          whatToTry = "SetterFi is reconciling the missing receipt. Testing cannot advance this state yet.";
        }
        break;
      case "blocked_permanent":
        stateLabel = "Blocked";
        tone = "failure";
        detail = "The saved connection is permanently blocked and cannot receive new lead messages.";
        whatToTry = "SetterFi owns the next review. Testing and reconnecting cannot advance this state.";
        break;
      case "flagged":
        stateLabel = "Flagged for review";
        tone = "warning";
        detail = "The saved connection needs a provider evidence review before it can continue.";
        whatToTry = "SetterFi owns the evidence review. Testing cannot advance this state yet.";
        break;
      case "connecting":
        stateLabel = "Connecting";
        tone = "waiting";
        detail = "The account connection has started, but the receipts needed for testing are incomplete.";
        whatToTry = "SetterFi is finishing the connection. Testing cannot advance this state yet.";
        break;
      case "pending_review":
        stateLabel = "In review";
        tone = "warning";
        detail = "The connection is under review and cannot be tested until that review finishes.";
        whatToTry = "SetterFi is tracking the review. There is nothing for you to retry here.";
        break;
    }
    detailExport = String(detail);
  }

  priority = owner === "you" && action?.required
    ? 0
    : tone === "failure"
      ? 2
      : owner === "carrier"
        ? 3
        : owner === "setterfi"
          ? 4
          : action
            ? 6
            : 5;

  const history = receiptHistory(channel, connection);
  const replyWindow = connection?.capabilities.windowed
    ? "Meta's 24 hour reply window applies to automated replies on this channel."
    : "This channel does not use Meta's 24 hour reply window.";
  const technical = [
    ...(connection ? [
      { label: "Connection ID", value: connection.id },
      { label: "Connection state", value: connection.state },
    ] : [{ label: "Channel key", value: channel.channel }]),
    ...(activity.at ? [{ label: "Last event", value: activity.at }] : []),
    ...(isSms && registration.checked && registration.registration ? [
      { label: "Registration state", value: registration.registration.registrationState },
      ...(registration.registration.terminalCode
        ? [{ label: "Terminal registration code", value: registration.registration.terminalCode }]
        : []),
    ] : []),
    ...technicalReceipts(connection),
  ];

  return {
    id: `channel:${channel.channel}`,
    label,
    icon: CHANNEL_ICONS[channel.channel],
    detail,
    detailExport,
    receiptSummary,
    stateLabel,
    tone,
    priority,
    action,
    owner,
    activity,
    activityLabel: "Last message event",
    connectionId: connection?.id ?? null,
    // The coach read does not expose a provider name. Windowed or template messaging is still a
    // positive direct-Meta capability, while every workspace-backed capability is false, so ambiguous
    // connections never receive a disconnect control that their provider cannot execute.
    providerDisconnectSupported: connection
      ? connection.capabilities.windowed || connection.capabilities.templates
      : false,
    commandTarget: connection ? "channel" : null,
    rawState: connection?.state ?? null,
    lastError,
    history,
    technical,
    whatToTry,
    replyWindow,
    conversionTracking,
  };
}

function calendarRow(read: CalendarConnectionRead): ConnectionRow {
  const connection = read.connection;
  if (!read.checked) {
    return {
      id: "calendar:primary",
      label: "Calendar",
      icon: CalendarDays,
      detail: "The calendar check did not run, so this row cannot claim a connection state.",
      detailExport: "Calendar check did not run",
      receiptSummary: null,
      stateLabel: "We could not check this",
      tone: "neutral",
      priority: 4,
      action: null,
      owner: "setterfi",
      activity: { checked: false, at: null },
      activityLabel: "Last availability check",
      connectionId: null,
      providerDisconnectSupported: false,
      commandTarget: null,
      rawState: null,
      lastError: { checked: false, message: null },
      history: [],
      technical: [],
      whatToTry: "Check again later. No connection state was inferred from the failed read.",
      replyWindow: "Calendar availability is not governed by a messaging reply window.",
      conversionTracking: null,
    };
  }

  if (!connection) {
    return {
      id: "calendar:primary",
      label: "Calendar",
      icon: CalendarDays,
      detail: "Your agent can qualify leads, but it cannot book them until a calendar is linked.",
      detailExport: "No primary calendar connection",
      receiptSummary: null,
      stateLabel: "Not connected",
      tone: "neutral",
      priority: 0,
      action: { label: "Connect", href: "/coach/get-started", required: true },
      owner: "you",
      activity: { checked: true, at: null },
      activityLabel: "Last availability check",
      connectionId: null,
      providerDisconnectSupported: false,
      commandTarget: null,
      rawState: null,
      lastError: { checked: true, message: null },
      history: [],
      technical: [],
      whatToTry: "Open Setup and connect the calendar where your agent should book calls.",
      replyWindow: "Calendar availability is not governed by a messaging reply window.",
      conversionTracking: null,
    };
  }

  const testPassed = connection.state === "ready"
    && connection.lastSlotFetchOk === true
    && connection.lastSlotFetchAt !== null;
  const needsReconnect = ["error", "disconnected", "expired"].includes(connection.state);
  const connecting = connection.state === "connecting";
  const action: ConnectionAction | null = needsReconnect
    ? { label: "Reconnect", href: "/coach/get-started", required: true }
    : null;
  const history = connection.lastSlotFetchAt ? [{
    label: connection.lastSlotFetchOk ? "Availability check passed" : "Availability check failed",
    at: connection.lastSlotFetchAt,
    successful: connection.lastSlotFetchOk === true,
  }] : [];
  // Which calendar, on which service. The name alone is whatever the coach called it, and two
  // coaches with a calendar called "Consults" were reading the same sentence about different
  // services. A calendar with no stored name falls back to the service, never to "your calendar".
  const providerLabel = CALENDAR_PROVIDER_LABELS[connection.provider];
  const source = connection.name ? `${connection.name} on ${providerLabel}` : providerLabel;

  return {
    id: "calendar:primary",
    label: "Calendar",
    icon: CalendarDays,
    detail: testPassed
      ? `Live availability was read from ${source}.`
      : needsReconnect
        ? `${source} needs to be linked again before your agent can book.`
        : connecting
          ? `The connection to ${source} has started, but it is not ready for an availability test.`
        : `${source} is linked, but a successful availability check is still needed.`,
    detailExport: testPassed
      ? `Live availability receipt stored for ${source}`
      : `Availability is not confirmed for ${source}`,
    receiptSummary: testPassed && connection.lastSlotFetchAt
      ? `Availability read ${absoluteTime(connection.lastSlotFetchAt)}. Receipt stored.`
      : connection.lastSlotFetchAt
        ? `Availability check recorded ${absoluteTime(connection.lastSlotFetchAt)}.`
        : null,
    stateLabel: testPassed
      ? "Availability confirmed"
      : needsReconnect
        ? "Reconnect needed"
        : connecting
          ? "Connecting"
          : "Waiting for verification",
    tone: testPassed ? "good" : needsReconnect ? "warning" : "waiting",
    priority: needsReconnect ? 0 : testPassed ? 5 : 4,
    action,
    owner: testPassed ? "none" : needsReconnect ? "you" : "setterfi",
    activity: { checked: true, at: connection.lastSlotFetchAt },
    activityLabel: "Last availability check",
    connectionId: connection.id,
    // Google is the one calendar provider with a disconnect route, and that route revokes with
    // Google before it changes anything locally. The workspace calendar has no such route, so it
    // stays false: a Disconnect button there would be a claim the backend cannot honour.
    providerDisconnectSupported: connection.provider === "google",
    commandTarget: connection.provider === "google" ? "google-calendar" : null,
    rawState: connection.state,
    lastError: connection.lastError,
    history,
    technical: [
      { label: "Connection ID", value: connection.id },
      { label: "Connection state", value: connection.state },
      // The coach-facing name, never the stored `ghl`: this panel is on a coach's screen.
      { label: "Calendar service", value: providerLabel },
      { label: "Timezone", value: connection.timezone },
      ...(connection.lastSlotFetchAt
        ? [{ label: "Last availability check", value: connection.lastSlotFetchAt }]
        : []),
    ],
    whatToTry: needsReconnect
      ? "Reconnect the primary calendar from Setup, then run an availability test."
      : connecting
        ? "SetterFi is finishing the connection. Testing cannot advance this state yet."
        : testPassed
          ? "Live availability has already been confirmed. There is no connection step for you to run."
          : "SetterFi owns the live availability check. There is nothing for you to run here.",
    replyWindow: "Calendar availability is not governed by a messaging reply window.",
    conversionTracking: null,
  };
}

/**
 * The activity readout inside a card's well: the absolute time in mono on top, because that is
 * the fact the row can prove, with the relative reading under it as the thing a person actually
 * scans for. A read that did not run says so rather than borrowing "no activity yet", which
 * would claim a silent channel where there is only a failed query.
 */
function ActivityReadout({ activity, now }: { activity: ConnectionActivity; now: Date }) {
  // Both absences stay in words rather than becoming the kit's em-rule. "Could not be read" and
  // "No activity yet" are the two claims this page must never merge, and an em-rule says only
  // that there is nothing here, which is the honest-state failure in miniature.
  if (!activity.checked) {
    return <MonoMeta className="block">Could not be read</MonoMeta>;
  }
  if (!activity.at) {
    return <MonoMeta className="block">No activity yet</MonoMeta>;
  }

  return (
    <>
      <MonoMeta className="block" style={{ color: "var(--body)" }}>{absoluteTime(activity.at)}</MonoMeta>
      <p className="mt-[3px] text-[15px] leading-[1.5] text-[color:var(--faint)]">
        {relativeTime(activity.at, now)}
      </p>
    </>
  );
}

/**
 * Who owns the next step, in one sentence, derived in one place.
 *
 * It used to be written twice: a four-way branch on the card and a two-way branch in the sheet
 * that collapsed carrier-owned and SetterFi-owned work into "Nothing for you to do." So a coach
 * whose SMS row said "The carrier owns the next step." on the card read "Nothing for you to do."
 * the moment they opened it, on the same row, in the same second.
 */
function ownerSentence(owner: ConnectionRow["owner"]) {
  if (owner === "you") return "The next step is yours.";
  if (owner === "carrier") return "The carrier owns the next step.";
  if (owner === "setterfi") return "SetterFi owns the next step.";
  return "Nothing for you to do.";
}

function History({ items }: { items: ConnectionRow["history"] }) {
  if (items.length === 0) {
    return <p className="text-[16px] leading-[1.55] text-[color:var(--faint)]">No connection receipts have been recorded yet.</p>;
  }
  return (
    <ol className="flex flex-col gap-[var(--s-2)]">
      {items.map((item) => (
        <li
          className="flex items-baseline justify-between gap-[var(--s-4)] border-b border-[var(--line-soft)] pb-[var(--s-2)] last:border-b-0 last:pb-0"
          key={`${item.label}:${item.at}`}
        >
          <span className="min-w-0 text-[16px] leading-[1.55] text-[color:var(--body)]">{item.label}</span>
          {/* A failed receipt's timestamp is the bad news, so it carries the tone: clay text on
              the new palette rather than `--critical`, which the ruling reserved for inline error
              copy and destructive buttons. */}
          <MonoMeta className="shrink-0 text-[14px]" tone={item.successful ? "neutral" : "failure"}>
            {absoluteTime(item.at)}
          </MonoMeta>
        </li>
      ))}
    </ol>
  );
}

/**
 * One connection, one card face. The state is a dot plus a word in a washed pill, never a hue on
 * its own, and the two things a connection can be waiting on - a carrier clock or a last event -
 * sit in mono wells beneath it. The footer names who owns the next step in words before it draws
 * any button, so a card that reads "Nothing for you to do" says it rather than implying it by
 * having nothing there.
 */
function ConnectionCard({
  row,
  now,
  selected,
  spendAccent,
  onOpen,
}: {
  row: ConnectionRow;
  now: Date;
  selected: boolean;
  spendAccent: boolean;
  onOpen: () => void;
}) {
  const Icon = row.icon;
  // The carrier day counter arrives as the row's detail node; a plain sentence arrives as a
  // string. Neither is rewritten here, they are only placed where each belongs.
  const dayCounter = typeof row.detail === "string" ? null : row.detail;
  const prose = typeof row.detail === "string" ? row.detail : null;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onOpen();
  }

  return (
    <Surface
      aria-expanded={selected}
      aria-label={`${row.label}. ${row.stateLabel}.`}
      className={cn(
        // `w-full` is load-bearing: `@container` gives the card `container-type: inline-size`, which
        // zeroes its intrinsic width, and the list item wraps it in a flex row. Without an explicit
        // width the card sized to its icon tile (measured 36px inside a 682px cell, 2026-09-02).
        "@container/card flex h-full w-full min-w-0 cursor-pointer flex-col gap-[var(--s-3)]",
        "transition-[border-color,box-shadow] duration-[var(--duration-quick)] ease-[var(--ease-out)]",
        "hover:border-[var(--accent-edge)]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]",
        "motion-reduce:transition-none",
      )}
      data-row-id={row.id}
      data-selected={selected ? "true" : undefined}
      onClick={onOpen}
      onKeyDown={onKeyDown}
      open={selected}
      role="button"
      tabIndex={0}
    >
      <div className="flex items-start gap-[var(--s-3)]">
        {/* The tile is tinted by the state of the card it leads, which is what makes a column of
            five identical faces scannable at all. It is never `accent`: none of these states is
            the coach's live action, and the page's one accent belongs to the button below. */}
        <IconTile size="lg" tone={row.tone}>
          <Icon aria-hidden />
        </IconTile>
        <div className="min-w-0 flex-1">
          <h3 className={COACH_PANEL_NAME_CLASS}>{row.label}</h3>
          {prose ? <Prose className={cn(CARD_SUB_CLASS, "mt-[4px]")}>{prose}</Prose> : null}
        </div>
        <Status className="shrink-0" label={row.stateLabel} tone={row.tone} />
      </div>

      <div className={cn("grid gap-[10px]", dayCounter && "@lg/card:grid-cols-2")}>
        {dayCounter ? (
          <Surface className="min-w-0" variant="well">
            {/* The amber dot beside the overline is the provisioning mark DESIGN.md names, and it
                does not glow: the budget is one for the whole product and this page is not where
                it is spent. Five channels each glowing is the signal destroyed. */}
            <span className="flex items-center gap-[6px]">
              <StatusDot size={6} tone="warning" />
              <span className={COACH_EYEBROW_CLASS}>Carrier review</span>
            </span>
            <div className="mt-[7px]">{dayCounter}</div>
          </Surface>
        ) : null}
        <Surface className="min-w-0" variant="well">
          <span className={`block ${COACH_EYEBROW_CLASS}`}>{row.activityLabel}</span>
          <div className="mt-[7px]">
            <ActivityReadout activity={row.activity} now={now} />
          </div>
        </Surface>
      </div>

      {row.receiptSummary ? (
        <Prose className="flex items-start gap-[var(--s-2)] text-[15px] leading-[1.5] text-[color:var(--meta)]">
          <Check aria-hidden className="mt-[2px] size-[var(--s-3)] shrink-0" />
          <span>{row.receiptSummary}</span>
        </Prose>
      ) : null}

      {row.conversionTracking ? (
        <Surface className="flex min-w-0 flex-col gap-[6px]" variant="well">
          <span className={COACH_EYEBROW_CLASS}>{row.conversionTracking.label}</span>
          <Prose className="text-[15px] leading-[1.5] text-[color:var(--faint)]">
            {row.conversionTracking.detail}
          </Prose>
        </Surface>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center justify-between gap-[var(--s-3)] border-t border-[var(--line-soft)] pt-[var(--s-3)]">
        <span className="text-[15px] leading-[1.5] text-[color:var(--faint)]">
          {ownerSentence(row.owner)}
        </span>
        {row.action ? (
          <a
            className={spendAccent ? ACCENT_FILL_CLASS : QUIET_ACTION_CLASS}
            href={row.action.href}
            onClick={(event) => event.stopPropagation()}
          >
            {row.action.label}
          </a>
        ) : null}
      </div>
    </Surface>
  );
}


function ConnectionDetail({ row }: { row: ConnectionRow }) {
  return (
    <div className="flex flex-col">
      {[
        { title: "Connection history", body: <History items={row.history} /> },
        {
          title: "Last error",
          body: !row.lastError.checked
            ? "We could not check the latest stored error."
            : row.lastError.message
              ? row.lastError.message
              : "No error has been recorded for this connection.",
        },
        { title: "What to try", body: row.whatToTry },
        { title: "Reply window", body: row.replyWindow },
      ].map((section) => (
        <section
          className="flex flex-col gap-[var(--s-3)] border-b border-[var(--line-soft)] py-[var(--s-4)] last:border-b-0"
          key={section.title}
        >
          <h3 className={`m-0 ${COACH_EYEBROW_CLASS}`}>{section.title}</h3>
          {typeof section.body === "string" ? (
            <Prose className="text-[16px] leading-[1.55] text-[color:var(--body)]">{section.body}</Prose>
          ) : section.body}
        </section>
      ))}
      {row.technical.length > 0 ? (
        <div className="py-[var(--s-4)]">
          <TechnicalDetail items={row.technical} />
        </div>
      ) : null}
    </div>
  );
}

function ProviderCommandReadback({ state }: { state: ProviderCommandState }) {
  const presentation = state.phase === "pending"
    ? { label: state.command === "test" ? "Provider check pending" : "Disconnect pending", tone: "waiting" as const }
    : state.phase === "confirmed"
      ? { label: state.command === "test" ? "Provider access confirmed" : "Disconnect confirmed", tone: "good" as const }
      : { label: state.command === "test" ? "Provider check failed" : "Disconnect failed", tone: "failure" as const };
  return (
    <Surface className="mt-[var(--s-3)] flex flex-col gap-[var(--s-2)]" role="status" variant="well">
      <Status label={presentation.label} tone={presentation.tone} />
      <Prose className="text-[16px] leading-[1.55] text-[color:var(--body)]">{state.message}</Prose>
      {state.receiptId && state.auditId && state.code ? (
        <MonoMeta className="break-all">
          Command receipt {state.receiptId} · Audit #{state.auditId} · {state.code}
        </MonoMeta>
      ) : state.code ? (
        <MonoMeta>{state.code}</MonoMeta>
      ) : null}
    </Surface>
  );
}

function DatasetCommandReadback({ state }: { state: DatasetCommandState }) {
  const presentation = state.phase === "pending"
    ? { label: "Conversion tracking setup pending", tone: "waiting" as const }
    : state.phase === "confirmed"
      ? { label: "Conversion tracking connected", tone: "good" as const }
      : { label: "Conversion tracking not set up", tone: "failure" as const };
  return (
    <Surface className="mt-[var(--s-3)] flex flex-col gap-[var(--s-2)]" role="status" variant="well">
      <Status label={presentation.label} tone={presentation.tone} />
      <Prose className="text-[16px] leading-[1.55] text-[color:var(--body)]">{state.message}</Prose>
      {state.auditId ? <MonoMeta>Audit #{state.auditId}</MonoMeta> : null}
    </Surface>
  );
}

function InlineConnectionSheet({
  row,
  onClose,
  commandState,
  impersonating,
  onCheckProvider,
  onRequestDisconnect,
  datasetCommandState,
  onSetupConversion,
}: {
  row: ConnectionRow;
  onClose: () => void;
  commandState: ProviderCommandState | null;
  impersonating: boolean;
  onCheckProvider: () => void;
  onRequestDisconnect: () => void;
  datasetCommandState: DatasetCommandState | null;
  onSetupConversion: () => Promise<void>;
}) {
  const Icon = row.icon;
  const commandPending = commandState?.phase === "pending";
  // The provider check is a messaging command: its route refuses a calendar id the same way the
  // channel disconnect one does, so a calendar row was carrying a button that could only ever come
  // back failed. The gate is the row's command target, not its state.
  const canCheckProvider = row.connectionId !== null
    && row.commandTarget === "channel"
    && ["ready", "live"].includes(row.rawState ?? "");
  const canDisconnect = row.connectionId !== null
    && row.providerDisconnectSupported
    && row.rawState !== "disconnected";
  const canSetupConversion = row.conversionTracking !== null
    && !row.conversionTracking.connected
    && row.connectionId !== null
    && ["ready", "live"].includes(row.rawState ?? "");

  return (
    <aside
      aria-label={`${row.label} connection`}
      className="flex min-h-[calc(var(--s-12)*11+var(--s-8))] w-[var(--drawer-w)] max-w-full shrink-0 flex-col rounded-[var(--r-panel)] border border-[var(--line)] bg-[var(--raised)]"
    >
      <header className="flex items-start gap-[var(--s-3)] border-b border-[var(--line)] px-[var(--s-5)] pb-[var(--s-4)] pt-[var(--s-5)]">
        <IconTile size="lg" tone={row.tone}>
          <Icon aria-hidden />
        </IconTile>
        <div className="min-w-0">
          <h2 className={COACH_PANEL_NAME_CLASS}>{row.label}</h2>
          <div className="mt-[var(--s-2)] flex flex-wrap items-center gap-[var(--s-2)]">
            <Status label={row.stateLabel} tone={row.tone} />
            <span className="text-[15px] leading-[1.5] text-[color:var(--faint)]">
              {ownerSentence(row.owner)}
            </span>
          </div>
        </div>
        <KitButton
          aria-label="Close connection detail"
          className="ml-auto"
          onClick={onClose}
          size="sm"
          variant="ghost"
        >
          <X aria-hidden className="size-[var(--s-4)]" />
        </KitButton>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-[var(--s-5)] pb-[var(--s-5)] pt-[var(--s-2)]">
        <ConnectionDetail row={row} />
        {commandState ? <ProviderCommandReadback state={commandState} /> : null}
        {datasetCommandState ? <DatasetCommandReadback state={datasetCommandState} /> : null}
        {impersonating && row.connectionId ? (
          <Prose className="mt-[var(--s-3)] text-[16px] leading-[1.55] text-[color:var(--faint)]">
            Provider commands are unavailable in a read-only impersonated view.
          </Prose>
        ) : null}
      </div>
      {row.action || (!impersonating && (canCheckProvider || canDisconnect || canSetupConversion)) ? (
        <footer className="flex flex-wrap items-center gap-[var(--s-2)] border-t border-[var(--line)] px-[var(--s-5)] py-[var(--s-3)]">
          {row.action ? (
            <a className={QUIET_ACTION_CLASS} href={row.action.href}>
              {row.action.label}
            </a>
          ) : null}
          {!impersonating && canCheckProvider ? (
            <KitButton disabled={commandPending} onClick={onCheckProvider} size="sm" variant="secondary">
              {commandPending && commandState?.command === "test" ? "Checking provider" : "Check provider access"}
            </KitButton>
          ) : null}
          {!impersonating && canSetupConversion ? (
            <LoggedButton
              actionKey="capi.dataset.provisioned"
              disabled={datasetCommandState?.phase === "pending"}
              onClick={onSetupConversion}
              scale="coach"
              variant="secondary"
            >
              {datasetCommandState?.phase === "pending" ? "Setting up" : "Set up conversion tracking"}
            </LoggedButton>
          ) : null}
          {/*
            * The caption names the key that actually gets written, which is why only the calendar
            * row carries one: `calendar.disconnected` is what that route records, and it is
            * `coachVisible` with its own microcopy. A messaging row's disconnect writes a
            * different key on a different route, so captioning it from here would be this lane
            * making a claim about a write it does not own.
            */}
          {!impersonating && canDisconnect && row.commandTarget === "google-calendar" ? (
            <LoggedButton
              actionKey="calendar.disconnected"
              disabled={commandPending}
              onClick={onRequestDisconnect}
              scale="coach"
              variant="danger"
            >
              Disconnect
            </LoggedButton>
          ) : null}
          {!impersonating && canDisconnect && row.commandTarget !== "google-calendar" ? (
            <KitButton disabled={commandPending} onClick={onRequestDisconnect} size="sm" variant="destructive">
              Disconnect
            </KitButton>
          ) : null}
        </footer>
      ) : null}
    </aside>
  );
}

function messagingCopy(messaging: CoachMessagingConnectionState) {
  const sourceLabel = messaging.label;
  const sourceDetail = messaging.detail;
  if (messaging.status === "unchecked") {
    return { label: "We could not check this", detail: "The text messaging setup check did not run." };
  }
  if (messaging.status === "connected") {
    return {
      label: "Setup record found",
      detail: "SetterFi's setup record is available. A channel still needs a signed test receipt before it reads Live.",
    };
  }
  return { label: sourceLabel, detail: sourceDetail };
}

function messagingTone(messaging: CoachMessagingConnectionState): Tone {
  if (messaging.status === "failed" || messaging.status === "needs-reapproval" || messaging.status === "removed") {
    return "failure";
  }
  if (messaging.status === "in-progress") return "warning";
  if (messaging.status === "connected") return "waiting";
  return "neutral";
}

export function CoachIntegrations({
  connections,
  templates,
  enabled = true,
  impersonating = false,
  a2pRegistration = { checked: true, registration: null },
  messaging = null,
  activityByChannel = {},
  calendar = { checked: true, connection: null },
  conversionTracking = { enabled: false, checked: true, datasets: [] },
  storedErrorsByConnection = {},
  nowIso = new Date().toISOString(),
}: {
  connections: ChannelConnectionView[] | null;
  templates: MessageTemplateView[] | null;
  enabled?: boolean;
  impersonating?: boolean;
  a2pRegistration?: A2pRegistrationRead;
  messaging?: CoachMessagingConnectionState | null;
  activityByChannel?: Partial<Record<Phase4Channel, ConnectionActivity>>;
  calendar?: CalendarConnectionRead;
  conversionTracking?: ConversionTrackingRead;
  storedErrorsByConnection?: Record<string, ConnectionErrorRead> | null;
  nowIso?: string;
}) {
  const searchParams = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(
    () => searchParams.get("connectionId"),
  );
  const [providerCommand, setProviderCommand] = useState<ProviderCommandState | null>(null);
  const [disconnectConnectionId, setDisconnectConnectionId] = useState<string | null>(null);
  const [datasetCommand, setDatasetCommand] = useState<DatasetCommandState | null>(null);
  const router = useRouter();
  const now = safeDate(nowIso) ?? new Date(0);

  if (!enabled) {
    return (
      <div className="min-w-0">
{/*
          The coach head, not `PageHeader`, and this page was the last coach surface still wearing
          the console's.

          `PageHeader` sets its title with `.t-page-title`, which resolves to 30px only under
          `[data-shell-role="admin"]` and is 20px everywhere else, so this page opened at a fifth
          of the 46px `--coach-page-title` every drawn coach surface opens at. Both `CoachPageHead`
          and `coach-support.tsx` already carry that reasoning; Connections has no artboard, so the
          redesign reached exactly as far as the drawings did and stopped here. The crumbs go with
          it: `ConnectionsShell` already passes the same crumbs to `AppShell`, so `PageHeader`
          was drawing a second trail directly under the first.
        */}
        <CoachPageHead
          sub="Where your agent can talk to leads, and where it books them."
          surface="connections"
          title="Connections"
        />
        <DataState body="Turn on direct channel connections to check setup and provider receipts." kind="empty" title="Connections are not enabled" />
      </div>
    );
  }

  if (connections === null) {
    return (
      <div className="min-w-0">
<CoachPageHead
          sub="Where your agent can talk to leads, and where it books them."
          surface="connections"
          title="Connections"
        />
        <DataState
          body="The connection check did not run, so this page cannot claim that a channel is disconnected."
          kind="unavailable"
          title="We could not check this"
        />
      </div>
    );
  }

  const registration = a2pRegistration.checked ? a2pRegistration.registration : null;
  const channels = deriveChannelTruths(connections, templates ?? [], now, registration?.submittedAt ?? null);
  const rows = channels.map((channel) => {
    const connection = connections.find((candidate) => candidate.channel === channel.channel) ?? null;
    return socialRow({
      channel,
      connection,
      activity: activityByChannel[channel.channel] ?? { checked: true, at: null },
      lastError: connection
        ? storedErrorsByConnection === null
          ? { checked: false, message: null }
          : storedErrorsByConnection[connection.id] ?? { checked: true, message: null }
        : { checked: true, message: null },
      registration: a2pRegistration,
      now,
      conversionTracking: conversionTrackingState(channel.channel, conversionTracking, connection?.id ?? null),
    });
  });
  rows.push(calendarRow(calendar));
  rows.sort((left, right) => {
    const priority = left.priority - right.priority;
    if (priority !== 0) return priority;
    const leftOrder = left.id.startsWith("channel:")
      ? CHANNEL_ORDER[left.id.slice("channel:".length) as Phase4Channel]
      : PHASE4_CHANNELS.length;
    const rightOrder = right.id.startsWith("channel:")
      ? CHANNEL_ORDER[right.id.slice("channel:".length) as Phase4Channel]
      : PHASE4_CHANNELS.length;
    return leftOrder - rightOrder;
  });
  const selected = selectedId
    ? rows.find((row) => row.connectionId === selectedId || row.id === selectedId) ?? null
    : null;
  const selectedCommand = selected?.connectionId && providerCommand?.connectionId === selected.connectionId
    ? providerCommand
    : null;
  const selectedDatasetCommand = selected?.conversionTracking &&
    datasetCommand?.channel === selected.conversionTracking.channel
    ? datasetCommand
    : null;

  async function runDatasetSetup(row: ConnectionRow) {
    const tracking = row.conversionTracking;
    if (impersonating || !tracking) {
      throw new Error("CAPI_DATASET_SETUP_REFUSED");
    }
    setDatasetCommand({
      channel: tracking.channel,
      phase: "pending",
      message: "SetterFi is creating or finding the dataset owned by this connected business asset.",
    });
    try {
      const response = await fetch("/api/channels/capi/datasets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: tracking.channel }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const body = payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {};
      const dataset = body.dataset && typeof body.dataset === "object" && !Array.isArray(body.dataset)
        ? body.dataset as Record<string, unknown>
        : {};
      const audit = body.audit && typeof body.audit === "object" && !Array.isArray(body.audit)
        ? body.audit as Record<string, unknown>
        : {};
      if (
        !response.ok || dataset.channel !== tracking.channel || dataset.status !== "connected" ||
        dataset.isMock !== false || audit.actionKey !== "capi.dataset.provisioned" ||
        typeof audit.auditId !== "string" || !audit.auditId
      ) throw new Error("CAPI_DATASET_RECEIPT_NOT_REAL");
      setDatasetCommand({
        channel: tracking.channel,
        phase: "confirmed",
        message: "A real dataset receipt is stored. Custom conversion labels remain owned in Ads Manager.",
        auditId: audit.auditId,
      });
      router.refresh();
    } catch (error) {
      setDatasetCommand({
        channel: tracking.channel,
        phase: "failed",
        message: "No real dataset receipt was stored, so conversion tracking still reads not set up.",
      });
      throw error;
    }
  }

  async function runProviderCommand(row: ConnectionRow, action: ProviderCommand) {
    if (impersonating || !row.connectionId) {
      setProviderCommand({
        connectionId: row.connectionId ?? row.id,
        command: action,
        phase: "failed",
        message: "Provider commands are unavailable in a read-only impersonated view.",
        code: "IMPERSONATION_REFUSED",
      });
      return false;
    }
    const connectionId = row.connectionId;
    setProviderCommand({
      connectionId,
      command: action,
      phase: "pending",
      message: action === "test"
        ? "SetterFi is asking the provider for a safe account read. No message is being sent."
        : "SetterFi is asking the provider to revoke this connection before changing local state.",
    });
    try {
      /*
       * The one thing that differs by row kind, and everything after it is shared on purpose. A
       * Google calendar disconnect has its own route because the channel-actions one reads
       * `channel_connections` and would resolve a calendar id to nothing; the request body, the
       * receipt parse, the expected-code check and the three readback sentences are identical, so
       * the two paths cannot drift into two different accounts of what happened.
       */
      const endpoint = row.commandTarget === "google-calendar" && action === "disconnect"
        ? "/api/calendars/google/disconnect"
        : `/api/channel-actions/${encodeURIComponent(connectionId)}/${action}`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idempotencyKey: providerCommandKey(action, connectionId) }),
      });
      const payload = await response.json().catch(() => null);
      const receipt = providerCommandReceipt(payload);
      const expectedCode = action === "test" ? "PROVIDER_READ_VERIFIED" : "PROVIDER_REVOKED";
      if (!response.ok || !receipt || receipt.outcome !== "verified" || receipt.code !== expectedCode) {
        const refusalCode = receipt?.code
          ?? (payload && typeof payload === "object" && !Array.isArray(payload)
            && typeof (payload as { code?: unknown }).code === "string"
            ? (payload as { code: string }).code
            : `HTTP_${response.status}`);
        setProviderCommand({
          connectionId,
          command: action,
          phase: "failed",
          message: action === "test"
            ? "The provider did not confirm account access. SetterFi may have recorded the attempt, but this page does not claim provider success."
            : "The provider did not confirm revocation. This page does not claim the connection was disconnected.",
          ...(receipt ? { receiptId: receipt.receiptId, auditId: receipt.auditId } : {}),
          code: refusalCode,
        });
        return false;
      }
      setProviderCommand({
        connectionId,
        command: action,
        phase: "confirmed",
        message: action === "test"
          ? "The provider accepted a safe account read. This did not send a message or create a signed round-trip receipt."
          : "The provider confirmed revocation and SetterFi recorded this connection as disconnected.",
        receiptId: receipt.receiptId,
        auditId: receipt.auditId,
        code: receipt.code,
      });
      if (action === "disconnect") router.refresh();
      return true;
    } catch {
      setProviderCommand({
        connectionId,
        command: action,
        phase: "failed",
        message: action === "test"
          ? "The provider check could not complete, so this page does not claim provider access."
          : "The disconnect request could not complete, so this page does not claim the connection was disconnected.",
        code: "PROVIDER_COMMAND_UNAVAILABLE",
      });
      return false;
    }
  }

  const disconnectRow = disconnectConnectionId
    ? rows.find((row) => row.connectionId === disconnectConnectionId) ?? null
    : null;
  const disconnectPending = providerCommand?.connectionId === disconnectConnectionId
    && providerCommand.command === "disconnect"
    && providerCommand.phase === "pending";

  /*
   * Test data is segregated from real analytics and has to say so where it is read. The marker is
   * derived from the template's own demo flag rather than a prop, so it cannot outlive the data it
   * describes. It takes the violet `draft` tone, which the palette declares for non-production
   * state and nothing else, instead of borrowing an in-progress amber.
   */
  const hasDemoTemplate = channels.some((candidate) => candidate.templateIsDemo);
  const liveRows = rows.filter((row) => row.stateLabel === "Live");
  const needsYouRows = rows.filter((row) => row.owner === "you" && row.action?.required);
  const waitingRows = rows.filter((row) => row.owner === "carrier" || row.owner === "setterfi");
  const blockedRows = rows.filter((row) => row.tone === "failure");
  const messagingState = messaging ? messagingCopy(messaging) : null;
  const setterFiOwnsMessaging = COACH_MESSAGING_CONNECTION_NOTE.length > 0;

  // Third strip line: only names and counts the rows already carry, never a predicted date.
  const carrierFiledAt = registration?.submittedAt ?? null;
  const carrierWaitingRow = waitingRows.find((row) => row.owner === "carrier") ?? null;
  const carrierReviewDay = carrierFiledAt ? elapsedWorkspaceDays(carrierFiledAt, now) : null;
  const waitingNote = carrierWaitingRow && carrierReviewDay !== null
    ? `${carrierWaitingRow.label}, carrier review day ${carrierReviewDay}`
    : waitingRows.length > 0
      ? waitingRows.map((row) => row.label).join(", ")
      : "No connection is waiting on a provider";
  // The denominator is channels only. The calendar is a row but never a channel, and it can
  // never read Live, so counting it made a fully connected workspace read "4 of 5" forever.
  const channelRowCount = rows.filter((row) => row.id.startsWith("channel:")).length;
  const stripItems = [
    {
      label: "Live channels",
      value: `${liveRows.length}`,
      of: `of ${channelRowCount}`,
      note: liveRows.length > 0
        ? liveRows.map((row) => row.label).join(", ")
        : "No channel has a signed round-trip receipt yet",
    },
    {
      label: "Waiting on you",
      value: `${needsYouRows.length}`,
      of: null,
      note: needsYouRows.length > 0
        ? needsYouRows.map((row) => row.label).join(", ")
        : "Nothing for you to do",
    },
    {
      label: "Waiting on a provider",
      value: `${waitingRows.length}`,
      of: null,
      note: waitingNote,
    },
    {
      label: "Blocked",
      value: `${blockedRows.length}`,
      of: null,
      note: blockedRows.length > 0
        ? blockedRows.map((row) => row.label).join(", ")
        : "Nothing is blocked",
    },
  ] as const;

  /*
   * The One Fill Rule, resolved from the same sorted list the cards render from: the first card
   * that carries a required action of the coach's own is the one live thing on the page, and it
   * gets the fill. When every remaining step belongs to SetterFi or a carrier, nothing is lit,
   * which is the honest resting state for a page that is mostly waiting.
   */
  const accentRowId = rows.find((row) => row.owner === "you" && row.action?.required)?.id ?? null;

  const exportRows = rows.map((row) => ({
    connection: row.label,
    state: row.rawState,
    displayState: row.stateLabel,
    owner: row.owner,
    lastEventAt: row.activity.at,
    connectionId: row.connectionId,
    detail: row.detailExport,
    receipt: row.receiptSummary,
    errorCheckRan: row.lastError.checked,
    lastError: row.lastError.message,
    conversionTracking: row.conversionTracking?.connected ? "connected" : row.conversionTracking ? "not set up" : null,
    conversionTrackingCheckRan: row.conversionTracking?.checked ?? null,
    conversionTrackingProviderReceipt: row.conversionTracking?.connected ? "stored real receipt" : null,
  }));
  const showInlineSheet = selected !== null;

  return (
    <div className="@container/page min-w-0">
      <CoachPageHead
        /*
          One action and the receipt for it. `CoachPageHead` allows a single action, and the
          timestamp is not a second one -- it is what the button acted on, and a "Check again"
          with no "checked when" beside it asks a coach to trust a refresh they cannot date.
        */
        action={
          <div className="flex flex-wrap items-center gap-[var(--s-3)]">
            <MonoMeta>Checked {absoluteTime(nowIso)}</MonoMeta>
            <KitButton
              leading={<RefreshCw aria-hidden className="size-[var(--s-4)]" />}
              onClick={() => router.refresh()}
              size="md"
              variant="ghost"
            >
              Check again
            </KitButton>
          </div>
        }
        sub="Where your agent can talk to leads, and where it books them. Each line shows who owns the next step."
        surface="connections"
        title="Connections"
      />

      {impersonating ? (
        <Surface
          className="mb-[var(--s-4)] text-[16px] leading-[1.55] text-[color:var(--body)]"
          role="status"
          variant="strip"
        >
          <strong className="font-medium text-[color:var(--ink)]">Read-only impersonated view.</strong>{" "}
          Connection actions open their normal destinations without exposing session identifiers.
        </Surface>
      ) : null}

      {/*
        Built from the atomics rather than from `FigureStrip`, for two reasons the kit cannot cover.
        The first is the denominator: `Live channels` is a count against a total, and a figure with
        no "of N" beside it is a number a coach cannot place. The second is the boundary
        `figure-strip.tsx` documents - its single absent case covers both "could not be read" and
        "read it, it is none", and every count here is derived from a list this render already
        holds, so all four zeroes are measured. Rendering a measured zero as "not readable right
        now" would be the honest-state rule inverted.
      */}
      <Surface
        as="dl"
        className="strip mb-[var(--s-5)] grid gap-x-[var(--s-6)] gap-y-[var(--s-4)] @xl/page:grid-cols-2 @4xl/page:grid-cols-4"
        variant="strip"
      >
        {stripItems.map((item) => (
          <div className="flex min-w-0 flex-col gap-[6px]" data-strip-item key={item.label}>
            <dt className={COACH_EYEBROW_CLASS}>{item.label}</dt>
            <dd className="flex items-baseline gap-[var(--s-2)]">
              <Figure size="lg">{item.value}</Figure>
              {item.of ? <MonoMeta>{item.of}</MonoMeta> : null}
            </dd>
            <dd className="text-[15px] leading-[1.5] text-[color:var(--faint)]">{item.note}</dd>
          </div>
        ))}
      </Surface>

      <div className="flex min-w-0 flex-col gap-[var(--s-6)] @4xl/page:flex-row @4xl/page:items-start">
        <div className="@container/list min-w-0 flex-1">
          <div className="mb-[var(--s-3)] flex flex-wrap items-end justify-between gap-[var(--s-3)]">
            <div>
              <h2 className={COACH_PANEL_NAME_CLASS}>Channels and calendar</h2>
              <Prose className={cn(CARD_SUB_CLASS, "mt-[4px]")}>
                Live means a signed round-trip receipt is stored, not a guess from setup state.
              </Prose>
            </div>
            <div className="flex flex-wrap items-center gap-[var(--s-3)]">
              {hasDemoTemplate ? (
                <div className="flex items-center gap-[var(--s-2)] text-[15px] leading-[1.5] text-[color:var(--faint)]" data-provenance="demo">
                  <Status dot={false} label="Demo workspace data" tone="draft" />
                  <span>Demo data, excluded from real analytics</span>
                </div>
              ) : null}
              <ExportMenu filename="setterfi-connections" mode="local" rows={exportRows} />
            </div>
          </div>

          {rows.length === 0 ? (
            <DataState body="Connect a channel from Setup to add it here." kind="empty" title="No connections yet" />
          ) : (
            /*
              Two bands, because a coach reads this page with one of two questions: can it still
              answer people, or can it still book them. A calendar sorted into the same grid as
              four channels by priority alone answered neither, since the row that decides whether
              a booking can happen at all could land anywhere in the list.

              The priority sort survives inside each band, so the one connection that needs the
              coach still leads the band it belongs to, and the accent is still resolved once
              across every row rather than once per band.
            */
            <div className="flex min-w-0 flex-col gap-[var(--s-5)]">
              {CONNECTION_BANDS.map((band) => {
                const bandRows = rows.filter((row) => band.holds(row));
                if (bandRows.length === 0) return null;
                return (
                  <section aria-label={band.label} key={band.label} className="min-w-0">
                    <h3 className={`m-0 mb-[var(--s-3)] ${COACH_EYEBROW_CLASS}`}>{band.label}</h3>
                    <div
                      className="chanlist grid min-w-0 gap-[12px] @2xl/list:grid-cols-2"
                      role="list"
                    >
                      {bandRows.map((row) => (
                        <div className="flex min-w-0" key={row.id} role="listitem">
                          <ConnectionCard
                            now={now}
                            onOpen={() => setSelectedId(row.connectionId ?? row.id)}
                            row={row}
                            selected={selected?.id === row.id}
                            spendAccent={row.id === accentRowId}
                          />
                        </div>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>

        {showInlineSheet && selected ? (
          <InlineConnectionSheet
            commandState={selectedCommand}
            impersonating={impersonating}
            onCheckProvider={() => void runProviderCommand(selected, "test")}
            onClose={() => setSelectedId(null)}
            onRequestDisconnect={() => setDisconnectConnectionId(selected.connectionId)}
            datasetCommandState={selectedDatasetCommand}
            onSetupConversion={() => runDatasetSetup(selected)}
            row={selected}
          />
        ) : null}
      </div>

      <AlertDialog
        onOpenChange={(open) => {
          if (!open && !disconnectPending) setDisconnectConnectionId(null);
        }}
        open={disconnectRow !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {disconnectRow?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              SetterFi will ask the provider to revoke this exact stored connection first. The local
              connection changes to disconnected only after the provider confirms that revoke.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {disconnectRow?.connectionId ? (
            <MonoMeta className="break-all">Connection {disconnectRow.connectionId}</MonoMeta>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnectPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={disconnectPending || !disconnectRow}
              onClick={(event) => {
                event.preventDefault();
                if (!disconnectRow) return;
                void runProviderCommand(disconnectRow, "disconnect")
                  .finally(() => setDisconnectConnectionId(null));
              }}
              variant="destructive"
            >
              {disconnectPending ? "Disconnecting provider" : "Disconnect provider"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* The quietest thing on the page, deliberately: it states what SetterFi already runs and
          is never something the coach acts on, so it takes the strip wash rather than a card face
          and carries no accent anywhere. */}
      <Surface
        as="section"
        className="mt-[var(--s-5)] flex flex-wrap items-start justify-between gap-[var(--s-4)]"
        variant="strip"
      >
        <div className="max-w-[var(--measure-prose)] min-w-[min(100%,34ch)] flex-1">
          <span className={`block ${COACH_EYEBROW_CLASS}`}>Managed by SetterFi</span>
          <h2 className={cn(COACH_PANEL_NAME_CLASS, "mt-[7px]")}>SetterFi sets up text messaging for you</h2>
          {/* The wait below is a literal on purpose, and `coach-integrations.test.ts` pins it as
              source text -- it is the guard standing between this sentence and a cheerful shorter
              number. Do not restate that string in a comment: quoting it here is enough to satisfy
              the pin on its own, which would leave the guard green over any copy at all. The other
              half, that the sentence stays in step with CARRIER_TYPICAL_DAYS, is checked against
              the rendered DOM in `coach-integrations.test.tsx`. */}
          <Prose className={cn(CARD_SUB_CLASS, "mt-[4px]")}>
            Carrier approval usually takes 2 to 3 weeks and cannot be sped up from here. The day count stays visible while the carrier reviews it.
          </Prose>
          {messagingState ? (
            <Prose className="mt-[var(--s-2)] text-[16px] leading-[1.55] text-[color:var(--body)]">{messagingState.detail}</Prose>
          ) : null}
          {/*
            Live means a signed round trip is stored, and that is all it means. A newly connected
            account can send before it should be sending at full volume, and no connection row can
            say where in that warm-up it is: the stored state is one of a fixed list that has no
            warm-up member, and the four receipts are timestamps rather than a volume. So the strip
            says the limit out loud instead of letting "Live" imply a ramp nobody recorded.
          */}
          <Prose className="mt-[var(--s-2)] text-[16px] leading-[1.55] text-[color:var(--faint)]">
            A newly connected account still warms up before it sends at full volume. SetterFi does
            not record how far along that is, so no channel here shows a warm-up state, and Live
            means a signed test message went out and came back, not that volume is unrestricted.
          </Prose>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-[var(--s-2)]">
          {messaging && messagingState ? (
            <Status label={messagingState.label} tone={messagingTone(messaging)} />
          ) : null}
          {setterFiOwnsMessaging ? (
            <span className="text-[15px] leading-[1.5] text-[color:var(--faint)]">Nothing for you to do</span>
          ) : null}
        </div>
      </Surface>

    </div>
  );
}
