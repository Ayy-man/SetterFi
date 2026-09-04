"use client";

/*
 * Step 4 of 6.
 *
 * Every loader, every post and every state rule is unchanged: the same `GET /api/onboarding/calendar`,
 * the same `/api/calendars/google/connect` anchor and `/api/calendars/google/select` post, the
 * same distinction between a stored authorization and a verified availability read, and the same
 * refusal to tell a dead grant apart from a check that could not run.
 *
 * What is gone, since 2026-09-05, is the manual receipt panel. It asked a coach for a provider
 * account reference, a provider calendar reference and an authorization receipt reference, which
 * are SetterFi's identifiers for a calendar SetterFi connected by hand. A coach never holds any
 * of those, so the panel was a support tool drawn on a coach's screen. `POST /api/onboarding/calendar`
 * still records one; the person who does that is us, and the screen says so when the press is not
 * available.
 */

import Link from "next/link";
import { useEffect, useState } from "react";

import {
  TONE_LINE,
  TONE_MARK,
  TONE_TEXT,
  TONE_WASH,
  type Tone,
} from "@/components/kit/atomics";
import { ShieldCheck } from "@/components/kit/icons";
import {
  OnboardingStepShell,
  STEP_PANEL_CLASS,
  STEP_PRIMARY_CLASS,
  STEP_SECONDARY_CLASS,
  StepReadback,
  nextStepHref,
} from "@/components/onboarding/step-shell";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";
import { timezoneDisplayLabel } from "@/lib/format/datetime";

type Connection = {
  provider: "ghl" | "google";
  calendarName: string | null;
  externalCalendarId: string;
  externalAccountReference: string | null;
  authorizationRecordedAt: string | null;
  state: string;
};
type GoogleGrant = {
  connectedAs: string | null;
  refreshTokenExpiresAt: string | null;
  reauthorizationRequired: boolean;
};
type PendingCalendar = { id: string; name: string; timeZone: string };
/**
 * Coach-visible provider names. The stored value stays `ghl` because that is what the API and the
 * `calendar_connections` row expect; only the words a coach reads change.
 */
const PROVIDER_LABELS: Readonly<Record<Connection["provider"], string>> = {
  ghl: "SetterFi's backup calendar",
  google: "Google Calendar",
};

const GOOGLE_CONNECT_PATH = "/api/calendars/google/connect";

const PICKABLE_ROW_CLASS =
  "flex min-h-[56px] min-w-0 cursor-pointer items-center gap-[14px] rounded-[12px] border border-[var(--line-input)] bg-[var(--well)] px-[16px]";
const PICKED_ROW_CLASS =
  "flex min-h-[56px] min-w-0 cursor-pointer items-center gap-[14px] rounded-[12px] border border-[var(--accent)] bg-[var(--accent-wash)] px-[16px]";

/** What the callback route returned us with, in the coach's own words. */
const CALLBACK_SENTENCES: Readonly<Record<string, string>> = {
  ready: "Google Calendar is connected and SetterFi read your availability back successfully.",
  choose: "Google Calendar is connected. Choose the calendar your agent should book into.",
  unverified: "Google Calendar is connected. SetterFi could not read your availability yet, so booking stays off.",
  declined: "The Google window was closed before access was granted. Nothing was changed, and you can connect whenever you are ready.",
  reauthorize: "Google did not return a lasting authorization. Connect again and accept the access request.",
  scopes: "Some of the calendar permissions were not granted. Connect again and leave every calendar permission ticked.",
  nocalendars: "A calendar came back with no time zone set. Set one on it in Google Calendar, or leave this with your SetterFi contact.",
  error: "The connection did not finish. Nothing was changed. Try again, and tell your SetterFi contact if it keeps stopping here.",
};

/** The sentences this screen used to print as help text, handed to the eye instead. */
export const CALENDAR_STEP_EYE_COPY =
  "Your agent needs to see when you are free and somewhere to put the calls it books. SetterFi "
  + "asks Google for permission to read your availability and to write the calls your agent books; "
  + "nothing else on your Google account is touched, and only the calendar you pick is read. A "
  + "stored authorization is not the same as a verified availability read, and booking depends on "
  + "the second, so this screen stays amber until SetterFi has read the calendar back. While "
  + "SetterFi is in review with Google, Google ends calendar permissions on a schedule: nothing "
  + "you did caused that, and reconnecting takes one press. Without a lasting authorization "
  + "SetterFi cannot keep the connection alive on its own, and without every calendar permission "
  + "it can neither read availability nor place a booking. A calendar with no time zone set can "
  + "land a call at the wrong hour, which is why one is required. Where the connect button is not "
  + "available yet, a person at SetterFi connects the calendar with you and records it.";

/** The vocabulary's 32px state pill: a dot, then the word. Never pressable. */
function StatePill({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span
      className="inline-flex h-[32px] w-fit shrink-0 items-center gap-[8px] rounded-full border px-[12px] text-[15px] leading-none font-[500]"
      style={{ background: TONE_WASH[tone], borderColor: TONE_LINE[tone], color: TONE_TEXT[tone] }}
    >
      <span
        aria-hidden="true"
        className="size-[8px] flex-none rounded-full"
        style={{ background: TONE_MARK[tone] }}
      />
      {label}
    </span>
  );
}

export function CalendarStep() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loaded, setLoaded] = useState<"reading" | "read" | "failed">("reading");
  const [connectAvailable, setConnectAvailable] = useState(false);
  const [grant, setGrant] = useState<GoogleGrant | null>(null);
  const [pending, setPending] = useState<readonly PendingCalendar[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [connectMessage, setConnectMessage] = useState<string | null>(null);

  /*
   * The callback outcome is read off the address bar rather than through `useSearchParams`,
   * because the navigation hook opts a client page with no Suspense boundary above it out of
   * static rendering.
   */
  useEffect(() => {
    const outcome = new URLSearchParams(window.location.search).get("calendar");
    void fetch("/api/onboarding/calendar", { cache: "no-store" }).then(async (response) => {
      const payload = await response.json() as {
        connection?: Connection | null;
        googleConnectAvailable?: boolean;
        googleGrant?: GoogleGrant | null;
        pendingCalendars?: readonly PendingCalendar[];
      };
      if (!response.ok) throw new Error();
      setConnectAvailable(payload.googleConnectAvailable === true);
      setGrant(payload.googleGrant ?? null);
      setPending(payload.pendingCalendars ?? []);
      if (outcome && outcome !== "ready" && outcome in CALLBACK_SENTENCES) {
        setConnectMessage(CALLBACK_SENTENCES[outcome]);
      }
      if (payload.connection) setConnection(payload.connection);
      setLoaded("read");
    }).catch(() => setLoaded("failed"));
  }, []);

  /*
   * Two refusals that must never be told apart wrongly. A dead grant is gone and the way back is
   * Google's consent screen; a verification that could not run is a live grant and a read that
   * failed to happen, where the way back is the same button.
   */
  async function choose() {
    const externalCalendarId = picked;
    if (!externalCalendarId) return;
    setConnectMessage("Saving your choice and reading availability back from Google…");
    const calendar = pending.find((candidate) => candidate.id === externalCalendarId);
    try {
      const response = await fetch("/api/calendars/google/select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ externalCalendarId }),
      });
      const payload = await response.json().catch(() => null) as
        { connection?: Connection; verified?: boolean; code?: string } | null;
      if (payload?.code === "CALENDAR_VERIFICATION_UNAVAILABLE") {
        setConnectMessage("SetterFi could not check that calendar's availability right now. Nothing is wrong with your Google account. Press the button again in a moment.");
        return;
      }
      if (response.status === 409 || payload?.code === "GOOGLE_GRANT_EXPIRED") {
        setConnectMessage("The Google authorization ran out before this calendar could be saved. Connect again and pick it once more.");
        return;
      }
      if (!response.ok || !payload?.connection) throw new Error();
      setConnection(payload.connection);
      setPending([]);
      setPicked(null);
      setConnectMessage(payload.verified === true
        ? `Your agent will book into ${payload.connection.calendarName ?? "the calendar you picked"}. SetterFi read its availability back from Google.`
        : `SetterFi could not read availability from ${calendar?.name ?? "that calendar"} yet, so booking stays off. The authorization is saved and nothing needs redoing.`);
    } catch {
      setConnectMessage("The calendar could not be saved. Nothing was changed, so you can pick again.");
    }
  }

  const verified = connection?.state === "ready";
  const googleRow = connection?.provider === "google";
  const expired = googleRow && connection?.state === "expired";
  const faulted = googleRow && connection?.state === "error";
  const choosing = connectAvailable && pending.length > 0;
  // Reconnect and connect are the same route, so there is one authorization path in the product.
  const showConnect = connectAvailable && !choosing && (!googleRow || expired || faulted);
  const accountability = AUDIT_ACTIONS["calendar.connected"];
  /*
   * Google is the calendar; the workspace calendar is the backup calls land in until Google is
   * connected. So while there is no Google row and the press is available, connecting Google is
   * the step's one filled action and Continue steps down to the secondary face. Once Google is
   * connected (or the press is not available) Continue takes the fill back.
   */
  const connectLeads = showConnect && !googleRow;

  return (
    <OnboardingStepShell
      eyeCopy={CALENDAR_STEP_EYE_COPY}
      eyeScreen="onboarding-calendar"
      lead={googleRow && verified
        ? "Your agent can see when you are free in Google Calendar, so it can offer real times and book them."
        : "Connect your Google Calendar so your agent can see when you are free and put the calls it books on it."}
      primary={
        <Link className={connectLeads ? `${STEP_SECONDARY_CLASS} w-full sm:w-auto` : STEP_PRIMARY_CLASS} href={nextStepHref("calendar")}>
          Continue to your offer
        </Link>
      }
      stepKey="calendar"
      width={860}
    >
      <div className="flex flex-col gap-[20px]">
        <section
          aria-labelledby="onboarding-calendar-provider"
          className={STEP_PANEL_CLASS}
          data-slot="rehaul-calendar-provider"
        >
          {/*
            The one claim this screen exists to keep honest, said once, in the band: a stored
            authorization is not a verified availability read, and booking depends on the second.
            It is a pill rather than a sentence under the heading because explanation belongs in
            the eye and a state belongs beside the thing it is a state of.
          */}
          <div className="flex min-h-[78px] flex-col justify-center gap-[10px] border-b border-[var(--line)] px-[16px] py-[19px] sm:flex-row sm:items-center sm:justify-between sm:px-[20px]">
            <div className="min-w-0">
              <span className="mb-[4px] block text-[14px] leading-[1.55] text-[color:var(--muted)]">
                Where your calls land
              </span>
              <h2
                className="m-0 text-[20px] leading-[1.2] font-[500] tracking-[-0.015em] text-[color:var(--ink)]"
                id="onboarding-calendar-provider"
              >
                Google Calendar
              </h2>
            </div>
            <StatePill
              label={verified
                ? "Availability verified, so your agent can book"
                : "Availability not verified, so your agent cannot book yet"}
              tone={verified ? "good" : "warning"}
            />
          </div>

          <div className="flex flex-col gap-[16px] px-[16px] py-[20px] sm:px-[20px]">
            {connectLeads ? (
              <div className="flex flex-wrap items-center gap-[14px]">
                <a className={STEP_PRIMARY_CLASS} data-slot="rehaul-calendar-connect" href={GOOGLE_CONNECT_PATH}>
                  Connect Google Calendar
                </a>
                <span
                  aria-label={accountability.ariaLabel}
                  className="inline-flex items-center gap-[8px] text-[14px] text-[color:var(--muted)]"
                >
                  <ShieldCheck aria-hidden className="size-[16px]" />
                  {accountability.microcopy}
                </span>
              </div>
            ) : null}

            <div className="grid gap-[16px] sm:grid-cols-2">
              <div className="min-w-0">
                <p className="mb-[6px] text-[16px] leading-[1.4] text-[color:var(--muted)]">
                  {connection && !googleRow ? "Calls land here until Google is connected" : "Calendar"}
                </p>
                <StepReadback absent={!connection}>
                  {connection
                    ? `${PROVIDER_LABELS[connection.provider]}${connection.calendarName ? `, ${connection.calendarName}` : ""}`
                    : loaded === "reading"
                      ? "Reading your calendar…"
                      : loaded === "failed"
                        ? "Your calendar could not be read just now"
                        : "No Google Calendar connected yet"}
                </StepReadback>
              </div>
              {/* The account is said only when there is one: "No account recorded" was the
                  screen stating an absence of its own bookkeeping, not of anything the coach owns. */}
              {grant?.connectedAs ? (
                <div className="min-w-0">
                  <p className="mb-[6px] text-[16px] leading-[1.4] text-[color:var(--muted)]">Connected as</p>
                  <StepReadback mono>{grant.connectedAs}</StepReadback>
                </div>
              ) : null}
            </div>

            {connectMessage ? (
              <p aria-live="polite" className="m-0 text-[16px] leading-[1.45] text-[color:var(--body)]">
                {connectMessage}
              </p>
            ) : null}

            {loaded === "read" && !connectAvailable && !googleRow ? (
              /*
                No button, no form. Where the press is not switched on for this workspace the
                calendar is connected by a person at SetterFi, and the screen says so rather than
                asking the coach for identifiers only we hold.
              */
              <p
                className="m-0 border-t border-[var(--line-soft)] pt-[16px] text-[16px] leading-[1.5] text-[color:var(--body)]"
                data-slot="rehaul-calendar-ask"
              >
                The Google Calendar connection is not switched on for this workspace yet. Message us
                from the bubble in the corner and a person will switch it on with you.
              </p>
            ) : null}

            {showConnect && !connectLeads ? (
              <div className="flex flex-wrap items-center gap-[14px] border-t border-[var(--line-soft)] pt-[16px]">
                <a className={STEP_SECONDARY_CLASS} data-slot="rehaul-calendar-connect" href={GOOGLE_CONNECT_PATH}>
                  Reconnect Google Calendar
                </a>
                <span
                  aria-label={accountability.ariaLabel}
                  className="inline-flex items-center gap-[8px] text-[14px] text-[color:var(--muted)]"
                >
                  <ShieldCheck aria-hidden className="size-[16px]" />
                  {accountability.microcopy}
                </span>
              </div>
            ) : null}
          </div>
        </section>

        {choosing ? (
          <section aria-labelledby="onboarding-calendar-picker" className={STEP_PANEL_CLASS}>
            <div className="flex min-h-[78px] flex-col justify-center border-b border-[var(--line)] px-[16px] py-[19px] sm:px-[20px]">
              <span className="mb-[4px] block text-[14px] leading-[1.55] text-[color:var(--muted)]">
                Pick one
              </span>
              <h2
                className="m-0 text-[20px] leading-[1.2] font-[500] tracking-[-0.015em] text-[color:var(--ink)]"
                id="onboarding-calendar-picker"
              >
                Which calendar should your agent book into?
              </h2>
            </div>
            <div
              aria-labelledby="onboarding-calendar-picker"
              className="flex flex-col gap-[12px] px-[16px] py-[20px] sm:px-[20px]"
              role="radiogroup"
            >
              {pending.map((calendar) => (
                <label
                  className={picked === calendar.id ? PICKED_ROW_CLASS : PICKABLE_ROW_CLASS}
                  key={calendar.id}
                >
                  <input
                    checked={picked === calendar.id}
                    className="size-[20px] shrink-0 accent-[var(--accent)]"
                    data-coach-target="exempt"
                    name="google-calendar"
                    onChange={() => setPicked(calendar.id)}
                    type="radio"
                    value={calendar.id}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[16px] font-medium text-[color:var(--ink)]">
                      {calendar.name}
                    </span>
                    <span className="text-[14px] text-[color:var(--muted)]">
                      {timezoneDisplayLabel(calendar.timeZone) ?? "Time zone set in Google"}
                    </span>
                  </span>
                </label>
              ))}
              <div className="mt-[4px] flex flex-wrap items-center gap-[14px]">
                <button
                  className={STEP_SECONDARY_CLASS}
                  disabled={picked === null}
                  onClick={() => void choose()}
                  type="button"
                >
                  Use this calendar
                </button>
                <span
                  aria-label={accountability.ariaLabel}
                  className="inline-flex items-center gap-[8px] text-[14px] text-[color:var(--muted)]"
                >
                  <ShieldCheck aria-hidden className="size-[16px]" />
                  {accountability.microcopy}
                </span>
              </div>
            </div>
          </section>
        ) : null}

      </div>
    </OnboardingStepShell>
  );
}
