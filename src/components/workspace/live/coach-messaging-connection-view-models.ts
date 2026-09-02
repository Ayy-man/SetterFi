/**
 * What a coach may be told about their own messaging connection.
 *
 * The admin panel at `/admin/provisioning` pairs its state with a button, because the install route
 * (`/api/channels/ghl/install-start`) admits `owner` and `admin` and refuses every other role with
 * `GHL_INSTALL_START_ROLE_FORBIDDEN`. A coach cannot start an install, so this surface carries no
 * button at all: weakening the route's role set to give the coach one would hand a client the
 * platform's install seam. What is left is the honest half - the state, and who acts on it.
 *
 * Pure, and the labels live here rather than in the component, so the no-provider-branding rule is
 * checkable by a unit test rather than by reading JSX.
 */

import type { WorkspaceTone } from "@/components/workspace/live/tones";

export type CoachMessagingConnectionStatus =
  | "connected"
  | "needs-reapproval"
  | "removed"
  | "failed"
  | "in-progress"
  | "not-connected"
  | "unchecked";

export type CoachMessagingConnectionState = {
  status: CoachMessagingConnectionStatus;
  label: string;
  tone: WorkspaceTone;
  detail: string;
};

/** Who starts and repairs the connection. True for every state, so it is said once. */
export const COACH_MESSAGING_CONNECTION_NOTE =
  "The SetterFi team sets this connection up for your account, so there is nothing for you to approve on this page. This card only reports what is stored.";

const STATES: Readonly<Record<CoachMessagingConnectionStatus, Omit<CoachMessagingConnectionState, "status">>> = {
  connected: {
    label: "Connected",
    tone: "good",
    detail: "Your messaging account is connected, so your agent can send and receive on it.",
  },
  "needs-reapproval": {
    label: "Needs re-approval",
    tone: "bad",
    detail: "The stored connection is no longer authorised. Nothing sends on it until it is approved again.",
  },
  removed: {
    label: "Disconnected",
    tone: "bad",
    detail: "The connection was removed on the messaging side. Nothing sends on it until it is set up again.",
  },
  failed: {
    label: "Last attempt failed",
    tone: "bad",
    detail: "The last attempt to connect your messaging account did not complete, so nothing is connected.",
  },
  "in-progress": {
    label: "Setup in progress",
    tone: "pending",
    detail: "Your account has been linked but no working connection is stored yet, so nothing sends on it so far.",
  },
  "not-connected": {
    label: "Not connected",
    tone: "neutral",
    detail: "No messaging connection is stored for your account yet.",
  },
  unchecked: {
    label: "Could not be checked",
    tone: "neutral",
    detail: "The connection could not be read just now, so nothing here can say whether it is connected.",
  },
};

function statusFor(
  locations: readonly { installState: string; reauthorizationRequiredAt: string | null }[],
): CoachMessagingConnectionStatus {
  // A location reading `token_ok` while carrying a re-approval marker is not connected: the
  // credential is there and the provider will no longer honour it.
  if (locations.some((entry) => entry.installState === "token_ok" && !entry.reauthorizationRequiredAt)) {
    return "connected";
  }
  if (locations.some((entry) => entry.reauthorizationRequiredAt)) return "needs-reapproval";
  if (locations.some((entry) => entry.installState === "uninstalled")) return "removed";
  if (locations.some((entry) => entry.installState === "failed")) return "failed";
  if (locations.some((entry) => entry.installState === "installed")) return "in-progress";
  return "not-connected";
}

/**
 * `checked` false is the read that did not run, and it outranks every row handed alongside it: rows
 * from a failed read are not evidence, and "not connected" is a claim we would have no basis for.
 */
export function coachMessagingConnectionState(input: {
  checked: boolean;
  locations: readonly { installState: string; reauthorizationRequiredAt: string | null }[];
}): CoachMessagingConnectionState {
  const status = input.checked ? statusFor(input.locations) : "unchecked";
  return { status, ...STATES[status] };
}
