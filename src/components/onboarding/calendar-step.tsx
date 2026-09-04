"use client";

/*
 * Step 4 of 6.
 *
 * Every loader, every post and every state rule is unchanged: the same
 * `GET/POST /api/onboarding/calendar`, the same `/api/calendars/google/connect` anchor and
 * `/api/calendars/google/select` post, the same distinction between a stored authorization and a
 * verified availability read, and the same refusal to tell a dead grant apart from a check that
 * could not run.
 *
 * What changed is the chrome and the ordering. The step title is the h1 and the panels carry no
 * competing heading band above them; the four explanatory sentences that used to change with the
 * state are the eye's; and the page's single filled button is Continue in the footer, which at
 * 390px is a sticky full-width bar. The manual receipt keeps its `data-slot` names because the
 * guard beside this file reads them, and the rule it guards -- every provider identifier demoted
 * into the fallback panel -- is a rule about this screen rather than about its markup.
 */

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

import {
  KitInput,
  TONE_LINE,
  TONE_MARK,
  TONE_TEXT,
  TONE_WASH,
  type Tone,
} from "@/components/kit/atomics";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ShieldCheck } from "@/components/kit/icons";
import {
  OnboardingStepShell,
  STEP_FIELD_CLASS,
  STEP_MONO_CLASS,
  STEP_PANEL_CLASS,
  STEP_PRIMARY_CLASS,
  STEP_SECONDARY_CLASS,
  StepField,
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
type Form = {
  provider: "ghl" | "google";
  externalAccountReference: string;
  externalCalendarId: string;
  calendarName: string;
  timezone: string;
  authorizationReceipt: string;
};

const EMPTY: Form = {
  provider: "ghl",
  externalAccountReference: "",
  externalCalendarId: "",
  calendarName: "",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  authorizationReceipt: "",
};

/**
 * Coach-visible provider names. The stored value stays `ghl` because that is what the API and the
 * `calendar_connections` row expect; only the words a coach reads change.
 */
const PROVIDER_LABELS: Readonly<Record<Form["provider"], string>> = {
  ghl: "SetterFi workspace calendar",
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
  + "land a call at the wrong hour, which is why one is required. The manual fields are "
  + "provider-issued identifiers for SetterFi to complete with you, never an OAuth access token.";

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
  const [form, setForm] = useState<Form>(EMPTY);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [status, setStatus] = useState("Loading saved calendar authorization…");
  const [saving, setSaving] = useState(false);
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
      if (payload.connection) {
        const found = payload.connection;
        setConnection(found);
        setForm((current) => ({
          ...current,
          provider: found.provider,
          externalAccountReference: found.externalAccountReference ?? "",
          externalCalendarId: found.externalCalendarId,
          calendarName: found.calendarName ?? "",
        }));
      }
      setStatus(payload.connection
        ? "Saved calendar authorization loaded."
        : "Authorize a calendar with its provider before recording its receipt here.");
    }).catch(() => setStatus("Calendar authorization could not be loaded."));
  }, []);

  function change(key: keyof Form, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setStatus("Recording the provider authorization receipt…");
    try {
      const response = await fetch("/api/onboarding/calendar", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...form, calendarName: form.calendarName || null }),
      });
      const payload = await response.json() as { connection?: Connection; audit?: { id: string } };
      if (!response.ok || !payload.connection || !payload.audit?.id) throw new Error();
      setConnection(payload.connection);
      setStatus("Authorization receipt recorded and logged. Calendar availability has not been verified, so booking is not ready.");
    } catch {
      setStatus("Calendar authorization could not be recorded. Confirm that provider authorization has actually happened, then try again.");
    } finally {
      setSaving(false);
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

  return (
    <OnboardingStepShell
      eyeCopy={CALENDAR_STEP_EYE_COPY}
      eyeScreen="onboarding-calendar"
      lead={verified
        ? "Your agent can see when you are free, so it can offer real times and book them."
        : "Your agent needs somewhere to put the calls it books, and permission to see when you are free."}
      primary={
        <Link className={STEP_PRIMARY_CLASS} href={nextStepHref("calendar")}>
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
                Calendar provider
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
            <div className="grid gap-[16px] sm:grid-cols-2">
              <div className="min-w-0">
                <p className="mb-[6px] text-[16px] leading-[1.4] text-[color:var(--muted)]">Provider</p>
                <StepReadback absent={!connection}>
                  {connection ? PROVIDER_LABELS[connection.provider] : "No provider connected yet"}
                </StepReadback>
              </div>
              <div className="min-w-0">
                <p className="mb-[6px] text-[16px] leading-[1.4] text-[color:var(--muted)]">Connected as</p>
                <StepReadback absent={!grant?.connectedAs} mono={Boolean(grant?.connectedAs)}>
                  {grant?.connectedAs ?? "No account recorded"}
                </StepReadback>
              </div>
            </div>

            {connectMessage ? (
              <p aria-live="polite" className="m-0 text-[16px] leading-[1.45] text-[color:var(--body)]">
                {connectMessage}
              </p>
            ) : null}

            {showConnect ? (
              <div className="flex flex-wrap items-center gap-[14px] border-t border-[var(--line-soft)] pt-[16px]">
                <a className={STEP_SECONDARY_CLASS} href={GOOGLE_CONNECT_PATH}>
                  {expired || faulted ? "Reconnect Google Calendar" : "Connect Google Calendar"}
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

        <section
          aria-labelledby="onboarding-calendar-manual"
          className={STEP_PANEL_CLASS}
          data-slot="rehaul-calendar-manual"
        >
          <div className="flex min-h-[78px] flex-col justify-center border-b border-[var(--line)] px-[16px] py-[19px] sm:px-[20px]">
            <span className="mb-[4px] block text-[14px] leading-[1.55] text-[color:var(--muted)]">
              Only if the press did not work
            </span>
            <h2
              className="m-0 text-[20px] leading-[1.2] font-[500] tracking-[-0.015em] text-[color:var(--ink)]"
              id="onboarding-calendar-manual"
            >
              Record it by hand
            </h2>
          </div>

          <form
            className="flex flex-col gap-[16px] px-[16px] py-[20px] sm:px-[20px]"
            onSubmit={(event) => void submit(event)}
          >
            <p aria-live="polite" className="m-0 text-[16px] leading-[1.4] text-[color:var(--muted)]">
              {status}
            </p>

            <StepField id="calendar-provider" label="Calendar provider">
              <Select
                onValueChange={(value) => change("provider", value ?? form.provider)}
                value={form.provider}
              >
                <SelectTrigger className={STEP_FIELD_CLASS} id="calendar-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start" alignItemWithTrigger={false}>
                  <SelectItem value="ghl">{PROVIDER_LABELS.ghl}</SelectItem>
                  <SelectItem value="google">{PROVIDER_LABELS.google}</SelectItem>
                </SelectContent>
              </Select>
            </StepField>

            <div className="grid gap-[16px] sm:grid-cols-2">
              <StepField id="account-reference" label="Provider account reference">
                <KitInput
                  className={`text-[16px] ${STEP_MONO_CLASS}`}
                  id="account-reference"
                  onChange={(event) => change("externalAccountReference", event.target.value)}
                  placeholder="Paste the reference"
                  required
                  shellClassName={STEP_FIELD_CLASS}
                  value={form.externalAccountReference}
                />
              </StepField>

              <StepField id="calendar-reference" label="Provider calendar reference">
                <KitInput
                  className={`text-[16px] ${STEP_MONO_CLASS}`}
                  id="calendar-reference"
                  onChange={(event) => change("externalCalendarId", event.target.value)}
                  placeholder="Paste the reference"
                  required
                  shellClassName={STEP_FIELD_CLASS}
                  value={form.externalCalendarId}
                />
              </StepField>

              {/*
                Optional, and load-bearing: the flag path once posted `calendarName: null` on every
                manual receipt, so a calendar the coach had named came back nameless above.
              */}
              <StepField id="calendar-name" label="Calendar name (optional)">
                <KitInput
                  className="text-[16px]"
                  id="calendar-name"
                  onChange={(event) => change("calendarName", event.target.value)}
                  shellClassName={STEP_FIELD_CLASS}
                  value={form.calendarName}
                />
              </StepField>

              <StepField id="calendar-timezone" label="Calendar timezone">
                <KitInput
                  className={`text-[16px] ${STEP_MONO_CLASS}`}
                  id="calendar-timezone"
                  onChange={(event) => change("timezone", event.target.value)}
                  required
                  shellClassName={STEP_FIELD_CLASS}
                  value={form.timezone}
                />
              </StepField>
            </div>

            <StepField id="authorization-receipt" label="Authorization receipt reference">
              <KitInput
                className={`text-[16px] ${STEP_MONO_CLASS}`}
                id="authorization-receipt"
                onChange={(event) => change("authorizationReceipt", event.target.value)}
                placeholder="Never an access token"
                required
                shellClassName={STEP_FIELD_CLASS}
                value={form.authorizationReceipt}
              />
            </StepField>

            <div className="flex flex-wrap items-center gap-[14px]">
              <button className={STEP_SECONDARY_CLASS} disabled={saving} type="submit">
                {saving ? "Recording…" : "Record the receipt"}
              </button>
              <span
                aria-label={accountability.ariaLabel}
                className="inline-flex items-center gap-[8px] text-[14px] text-[color:var(--muted)]"
              >
                <ShieldCheck aria-hidden className="size-[16px]" />
                {accountability.microcopy}
              </span>
            </div>
          </form>
        </section>
      </div>
    </OnboardingStepShell>
  );
}
