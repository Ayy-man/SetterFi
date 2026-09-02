/**
 * The seam between the install buttons and the route that issues the install link.
 *
 * It is pure and fully injected - the fetch and the navigation both arrive as parameters - so the
 * whole thing is testable under a node environment, and so the one route literal in the UI layer
 * lives here rather than in the copy a client reads.
 */

import type { WorkspaceTone } from "@/components/workspace/live/tones";
import { workspaceDateFormat, workspaceDateTimeYearFormat } from "@/lib/format/datetime";
import type { GhlOAuthApp } from "@/lib/integrations/ghl-oauth";

const INSTALL_START_PATH = "/api/channels/ghl/install-start";

export type MessagingInstallFailure =
  | "not-enabled"
  | "signed-out"
  | "not-allowed"
  | "refused"
  | "timeout"
  | "error";
export type MessagingInstallResult =
  | { status: "redirecting" }
  | { status: MessagingInstallFailure; message: string };

const FAILURE_MESSAGES: Readonly<Record<MessagingInstallFailure, string>> = {
  "not-enabled": "This install is not switched on in this environment.",
  "signed-out": "Your session ended. Sign in again, then start the install.",
  "not-allowed": "Only an owner or admin can start this install, and not while viewing as a client.",
  refused: "The install request was refused.",
  // Deliberately not the `error` copy. That sentence says the link could not be created and that
  // nothing was started; on a timeout we know neither - the route may well have created the link
  // and logged it. The attempts list is the only place that can answer, so it points there.
  timeout: "No answer came back in time, so nothing opened here. The install attempts list below shows whether a link was created; check it before trying again.",
  error: "The install link could not be issued. Nothing was started.",
};

// No timeout entry: a request that never answered has no HTTP status to map.
const STATUS_FAILURES: Readonly<Record<number, MessagingInstallFailure>> = {
  404: "not-enabled",
  401: "signed-out",
  403: "not-allowed",
  400: "refused",
};

function failure(status: MessagingInstallFailure): MessagingInstallResult {
  return { status, message: FAILURE_MESSAGES[status] };
}

export type MessagingInstallApp = {
  app: GhlOAuthApp;
  buttonLabel: string;
  title: string;
  detail: string;
};

export const MESSAGING_INSTALL_APPS: readonly [MessagingInstallApp, MessagingInstallApp] = [
  {
    app: "agent",
    buttonLabel: "Connect messaging",
    title: "Messaging app",
    detail: "Approval happens on the provider's site. Nothing here reports connected until the approval returns.",
  },
  {
    app: "provisioning",
    buttonLabel: "Connect provisioning",
    title: "Provisioning app",
    detail: "The agency-level app that creates sub-accounts. One approval covers the platform.",
  },
];

type InstallResponse = { status: number; json(): Promise<unknown> };

type InstallRequestInit = {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
};

/**
 * The popup is minimal and structural on purpose - it never mentions `Window`, so the seam is
 * testable with a plain object under a node environment.
 */
export type InstallPopupHandle = {
  closed: boolean;
  opener: unknown;
  close(): void;
  location: { href: string };
};

/**
 * Opens the approval tab and cuts its link back to this one, in a single call so the two can never
 * drift apart.
 *
 * The tab starts at `about:blank`, which inherits this document's origin, so this window may still
 * write to it. Per the WHATWG HTML `window.opener` setter steps
 * (https://html.spec.whatwg.org/multipage/nav-history-apis.html#dom-opener, read 2026-08-20),
 * assigning null sets the browsing context's opener browsing context to null, and the spec notes no
 * later script can reach the opener's `Window` through it - the sever is permanent for that tab.
 * It has to happen here, while the popup is still blank: once the provider URL is written in, the
 * tab is cross-origin and out of reach, and the provider page plus every hop of its redirect chain
 * could navigate this authenticated admin tab wherever they liked.
 *
 * Passing `"noopener"` in the features string is the other way to get this, and is not taken:
 * `window.open` then returns null, which destroys the fill-the-URL-later design that the
 * popup-blocker fallback depends on.
 */
export function openInstallPopup(
  open: (url: string, target: string) => InstallPopupHandle | null,
): InstallPopupHandle | null {
  const popup = open("about:blank", "_blank");
  if (!popup) return null;
  try {
    popup.opener = null;
  } catch {
    // A tab we cannot sever is a tab we will not navigate. Close it and let the caller fall back to
    // approving in this tab, rather than sending the provider a window that kept its opener.
    popup.close();
    return null;
  }
  return popup;
}

export const INSTALL_START_TIMEOUT_MS = 15_000;

export async function startMessagingInstall(input: {
  app: GhlOAuthApp;
  returnPath: string;
  fetch: (url: string, init: InstallRequestInit) => Promise<InstallResponse>;
  assign: (url: string) => void;
  timeoutMs?: number;
}): Promise<MessagingInstallResult> {
  const controller = new AbortController();
  let gaveUp = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // Raced rather than left to the fetch rejecting on abort: an injected fetch in a test does not
  // listen to the signal at all, and a real request whose response is already buffered may not
  // either. The signal still goes out, so the connection is dropped as well as abandoned.
  const expiry = new Promise<MessagingInstallResult>((resolve) => {
    timer = setTimeout(() => {
      gaveUp = true;
      controller.abort();
      resolve(failure("timeout"));
    }, input.timeoutMs ?? INSTALL_START_TIMEOUT_MS);
  });

  const request = (async (): Promise<MessagingInstallResult> => {
    try {
      const response = await input.fetch(INSTALL_START_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        // No tenantId: the agency install is platform-wide and the sub-account install binds its
        // tenant from the grant, so a tenant guessed by the browser would be a lie the state carries.
        body: JSON.stringify({ app: input.app, returnPath: input.returnPath }),
      });
      if (response.status !== 201) return failure(STATUS_FAILURES[response.status] ?? "error");
      const body = await response.json() as { authorizationUrl?: unknown } | null;
      const url = body && typeof body.authorizationUrl === "string" ? body.authorizationUrl.trim() : "";
      if (!url) return failure("error");
      // A link that arrives after the reader has already been told nothing opened must not then
      // navigate them out of the page. It shows up in the attempts list instead.
      if (gaveUp) return failure("timeout");
      input.assign(url);
      return { status: "redirecting" };
    } catch {
      return failure("error");
    }
  })();

  try {
    return await Promise.race([request, expiry]);
  } finally {
    // Every exit path, so no timer outlives the call.
    clearTimeout(timer);
  }
}

export type MessagingInstallOutcome = {
  app: GhlOAuthApp;
  outcome: "linked" | "declined" | "error";
  tone: WorkspaceTone;
  headline: string;
  detail: string;
};

const OUTCOME_KEYS: readonly { key: string; app: GhlOAuthApp; label: string }[] = [
  { key: "messaging", app: "agent", label: "Messaging app" },
  { key: "provisioning", app: "provisioning", label: "Provisioning app" },
];

function first(value: string | string[] | undefined) { return Array.isArray(value) ? value[0] : value; }

/**
 * A query parameter is attacker-writable text, so even the `linked` branch only says that the
 * callback returned. A completion audit row is historical evidence that storage succeeded then;
 * it is not a live readiness check, because a provider can revoke a grant after the callback.
 * The current cards own the stronger claim and are intentionally separate from this banner.
 */
export function messagingInstallOutcome(
  params: Record<string, string | string[] | undefined>,
): MessagingInstallOutcome | null {
  for (const entry of OUTCOME_KEYS) {
    const value = first(params[entry.key]);
    // Only the three literals the callbacks emit count. An unrecognised value is a query string
    // someone typed, not evidence that anything happened.
    if (value === "linked") {
      return {
        app: entry.app,
        outcome: "linked",
        tone: "pending",
        headline: `${entry.label} approval came back`,
        detail: "The current stored state on the card above reports whether the connection is usable now. The install attempts list below is historical evidence of this approval.",
      };
    }
    if (value === "declined") {
      return {
        app: entry.app,
        outcome: "declined",
        tone: "bad",
        headline: "Approval was declined",
        detail: "Nothing was stored. Start the install again when you are ready to approve it.",
      };
    }
    if (value === "error") {
      return {
        app: entry.app,
        outcome: "error",
        tone: "bad",
        headline: "The install did not complete",
        detail: "Nothing was stored. You can start the install again from this page.",
      };
    }
  }
  return null;
}

/**
 * What a viewer we refused sees where the agency state would be. Deliberately not
 * `agencyInstallStateLabel(null)`: "Not connected" is a claim about the provider, and a viewer whose
 * read never ran was told nothing about the provider either way.
 */
export const AGENCY_INSTALL_UNCHECKED: { label: string; tone: WorkspaceTone } = {
  label: "Not checked",
  tone: "neutral",
};

/**
 * A failed custody read and an empty custody table are different facts. In particular, returning
 * `Not connected` after a database failure invites an operator to repeat an approval that may
 * already be live, so only a completed read may make that claim.
 */
export function agencyInstallReadLabel(input: {
  checked: boolean;
  row: { installState: string; reauthorizationRequiredAt: string | null } | null;
}): { label: string; tone: WorkspaceTone } {
  if (!input.checked) return { label: "Could not check stored connection", tone: "neutral" };
  return agencyInstallStateLabel(input.row);
}

export function agencyInstallStateLabel(
  row: { installState: string; reauthorizationRequiredAt: string | null } | null,
): { label: string; tone: WorkspaceTone } {
  if (!row) return { label: "Not connected", tone: "neutral" };
  // Order matters: a row can read `token_ok` while carrying a re-approval marker, and reporting
  // that as connected would be the dishonest state.
  if (row.reauthorizationRequiredAt) return { label: "Needs re-approval", tone: "bad" };
  if (row.installState === "token_ok") return { label: "Connected", tone: "good" };
  if (row.installState === "uninstalled") return { label: "Removed on the provider's side", tone: "bad" };
  if (row.installState === "failed") return { label: "Last attempt failed", tone: "bad" };
  return { label: "Not connected", tone: "neutral" };
}

/**
 * Whether this install follows the agency into sub-accounts made later, the one thing about an
 * install nobody could read off our own rows.
 *
 * Three answers, and the third is the whole reason this is not a boolean. `false` is the installer
 * declining an option the consent screen offered; `null` is an install that never told us, which is
 * every row written before the flag was persisted. Rendering "no" for both would let an operator
 * conclude the installer chose something they were never asked.
 *
 * `false` is `neutral`, not `bad`: it is a legitimate choice, and the only reason to show it is that
 * it explains why a sub-account created tomorrow starts without the app.
 */
export function agencyFutureLocationsFact(
  row: { installToFutureLocations: boolean | null } | null,
): { label: string; tone: WorkspaceTone } | null {
  if (!row) return null;
  // Same helper the fact list uses, so the pill and the row can never answer differently.
  const answer = flagAnswer(row.installToFutureLocations);
  return { label: `${FUTURE_LOCATIONS_TERM}: ${answer.value.toLowerCase()}`, tone: answer.tone };
}

/**
 * What a stored grant records about itself, as term-and-value pairs.
 *
 * Separate from the state label above on purpose. That one answers "is this credential usable",
 * which is a claim about now; these answer "what does the row say", which is a claim about the
 * moment the install happened and has been true ever since. The two get confused precisely when
 * the row is old, which is the case this exists for.
 */
export type AgencyGrantFact = { term: string; value: string; tone: WorkspaceTone };

export type AgencyGrantRow = {
  createdAt: string;
  updatedAt: string;
  approveAllLocations: boolean | null;
  isBulkInstallation: boolean | null;
  installToFutureLocations: boolean | null;
};

/** What a stored grant lets the panel say, and whether there is a grant at all. */
export type AgencyGrantSummary = { stored: boolean; facts: readonly AgencyGrantFact[] };

const NOT_RECORDED = "Not recorded";

/**
 * Three answers, never two. `null` is a row that never told us -- every row written before the
 * consent columns existed reads this way -- and rendering it as "no" would report the installer's
 * answer to a question they were never asked.
 */
function flagAnswer(
  value: boolean | null,
  falseTone: WorkspaceTone = "neutral",
): { value: string; tone: WorkspaceTone } {
  if (value === null) return { value: NOT_RECORDED, tone: "neutral" };
  return value ? { value: "Yes", tone: "good" } : { value: "No", tone: falseTone };
}

const FUTURE_LOCATIONS_TERM = "Covers future sub-accounts";

function instant(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * The freshness pair, and the reason the second half is not a timestamp.
 *
 * `updated_at` defaults to `created_at` and only moves when something writes the row again, so an
 * install nobody has touched since August carries an August `updated_at` -- a perfectly recent
 * looking timestamp that says nothing about the grant still being good. Printing it beside
 * "Connected" is how a stale row reads as a current one. When the two stamps are the same instant
 * this says so in words and carries the pending tone, because "never refreshed" is a thing to look
 * at rather than a thing that is fine.
 */
export function agencyGrantFreshnessFacts(
  row: { createdAt: string; updatedAt: string },
): readonly AgencyGrantFact[] {
  const installed = instant(row.createdAt);
  const refreshed = instant(row.updatedAt);
  const installedFact: AgencyGrantFact = {
    term: "Grant installed",
    value: installed ? workspaceDateFormat.format(installed) : NOT_RECORDED,
    tone: "neutral",
  };
  if (!installed || !refreshed) {
    return [installedFact, { term: "Last refreshed", value: NOT_RECORDED, tone: "neutral" }];
  }
  if (refreshed.getTime() <= installed.getTime()) {
    return [
      installedFact,
      {
        term: "Last refreshed",
        value: `Never refreshed since ${workspaceDateFormat.format(installed)}`,
        tone: "pending",
      },
    ];
  }
  return [
    installedFact,
    {
      term: "Last refreshed",
      value: workspaceDateTimeYearFormat.format(refreshed),
      tone: "neutral",
    },
  ];
}

/**
 * Everything the stored row can say about itself, in the order an operator needs it: when it
 * arrived, whether anything has touched it since, then the three consent answers.
 */
export function agencyGrantFacts(row: AgencyGrantRow | null): readonly AgencyGrantFact[] {
  if (!row) return [];
  const future = flagAnswer(row.installToFutureLocations);
  // False here is the state that sends a coach's sub-account live without the messaging app, so it
  // is the one consent answer that is allowed to read as something to look at.
  const approved = flagAnswer(row.approveAllLocations, "pending");
  const bulk = flagAnswer(row.isBulkInstallation);
  return [
    ...agencyGrantFreshnessFacts(row),
    { term: FUTURE_LOCATIONS_TERM, value: future.value, tone: future.tone },
    { term: "All sub-accounts approved at install", value: approved.value, tone: approved.tone },
    { term: "Installed in bulk", value: bulk.value, tone: bulk.tone },
  ];
}

/**
 * The state a surface may show for a grant, once the row's own freshness is taken into account.
 *
 * `agencyInstallStateLabel` answers from `install_state` alone, and for a row nothing has touched
 * since August that answer is "Connected" -- true of the column, and read by an operator as
 * "this is working now". A grant whose `updated_at` has never moved off `created_at` has never
 * been refreshed, exercised or re-checked by anything in this codebase, so the word is withheld
 * and the reader gets the fact that is actually known: when it was stored, and that nothing has
 * happened to it since.
 *
 * A bad state is never softened. "Needs re-approval" outranks staleness, because it is the
 * stronger claim and the one that says what to do.
 */
export function agencyInstallSummaryLine(input: {
  state: { label: string; tone: WorkspaceTone };
  facts: readonly AgencyGrantFact[];
}): { label: string; tone: WorkspaceTone } {
  if (input.state.tone === "bad") return input.state;
  const freshness = input.facts.find((fact) => fact.term === "Last refreshed");
  if (!freshness || freshness.tone !== "pending") return input.state;
  return { label: freshness.value, tone: freshness.tone };
}
