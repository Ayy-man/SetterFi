"use client";

/*
 * Step 4 of setup, drawn from `OnboardingCalendar.body.html`.
 *
 * Every loader, every post and every state rule is the live page's, unchanged: the same
 * `GET/POST /api/onboarding/calendar`, the same `/api/calendars/google/connect` anchor and
 * `/api/calendars/google/select` post, the same distinction between a stored authorization and a
 * verified availability read, and the same refusal to tell a dead grant apart from a check that
 * could not run.
 *
 * The page used to carry four explanatory sentences that changed with the state -- what Google is
 * asked for, why a grant expires, what SetterFi does on the coach's behalf. Those are the eye's
 * now. What is left on the screen is the connection, the calendar to book into, and the manual
 * receipt for the case the press cannot cover.
 */

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";

import {
  FieldShell,
  KitButton,
  KitInput,
  SelectCaret,
  kitButtonClass,
} from "@/components/kit/atomics";
import { DeckPanel } from "@/components/kit/deck-panel";
import { ShieldCheck } from "@/components/kit/icons";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import {
  ONBOARDING_FIELD_CLASS,
  ONBOARDING_MONO_CLASS,
  OnboardingField,
  OnboardingFooter,
  OnboardingReadback,
  OnboardingShell,
} from "@/components/workspace/rehaul/onboarding-shell";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";
import { timezoneDisplayLabel } from "@/lib/format/datetime";

type Connection = { provider: "ghl" | "google"; calendarName: string | null; externalCalendarId: string; externalAccountReference: string | null; authorizationRecordedAt: string | null; state: string };
type GoogleGrant = { connectedAs: string | null; refreshTokenExpiresAt: string | null; reauthorizationRequired: boolean };
type PendingCalendar = { id: string; name: string; timeZone: string };
type Form = { provider: "ghl" | "google"; externalAccountReference: string; externalCalendarId: string; calendarName: string; timezone: string; authorizationReceipt: string };

const EMPTY: Form = { provider: "ghl", externalAccountReference: "", externalCalendarId: "", calendarName: "", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", authorizationReceipt: "" };

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
export const ONBOARDING_CALENDAR_EYE_COPY =
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

export function OnboardingCalendarRehaul() {
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
        setConnection(payload.connection);
        setForm((current) => ({
          ...current,
          provider: payload.connection!.provider,
          externalAccountReference: payload.connection!.externalAccountReference ?? "",
          externalCalendarId: payload.connection!.externalCalendarId,
          calendarName: payload.connection!.calendarName ?? "",
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
    <OnboardingShell
      status={[{
        label: verified
          ? "Availability verified, so your agent can book"
          : "Availability not verified, so your agent cannot book yet",
        tone: verified ? "good" : "warning",
      }]}
      step={4}
      title="Connect your booking calendar"
    >
      <div className="grid grid-cols-1 items-start gap-[20px] @min-[900px]:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex min-w-0 flex-col gap-[20px]">
          <DeckPanel
            dataSlot="rehaul-calendar-provider"
            eyebrow="Where your calls land"
            headingId="rehaul-calendar-provider"
            /* The artboard's "One press" meta, shown only while there is a press to make. */
            meta={showConnect ? (
              <span className={`text-[14px] text-[color:var(--warning-text)] ${ONBOARDING_MONO_CLASS}`}>
                One press
              </span>
            ) : undefined}
            name="Calendar provider"
          >
            <div className="flex flex-col gap-[16px]">
              <div className="grid gap-[16px] @min-[640px]:grid-cols-2">
                <div className="min-w-0">
                  <p className="mb-[6px] text-[14px] font-medium text-[color:var(--muted)]">Provider</p>
                  <OnboardingReadback absent={!connection}>
                    {connection ? PROVIDER_LABELS[connection.provider] : "No provider connected yet"}
                  </OnboardingReadback>
                </div>
                <div className="min-w-0">
                  <p className="mb-[6px] text-[14px] font-medium text-[color:var(--muted)]">Connected as</p>
                  <OnboardingReadback absent={!grant?.connectedAs} mono={Boolean(grant?.connectedAs)}>
                    {grant?.connectedAs ?? "No account recorded"}
                  </OnboardingReadback>
                </div>
              </div>

              {connectMessage ? (
                <p aria-live="polite" className="m-0 text-[15px] leading-[1.45] text-[color:var(--body)]">
                  {connectMessage}
                </p>
              ) : null}

              {showConnect ? (
                <div className="flex flex-wrap items-center gap-[14px] border-t border-[var(--line-soft)] pt-[16px]">
                  <a
                    className={kitButtonClass({
                      className: "h-[48px] px-[22px] text-[16px] no-underline",
                      variant: "secondary",
                    })}
                    href={GOOGLE_CONNECT_PATH}
                  >
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
          </DeckPanel>

          {choosing ? (
            <DeckPanel
              dataSlot="rehaul-calendar-picker"
              eyebrow="Pick one"
              headingId="rehaul-calendar-picker"
              name="Which calendar should your agent book into?"
            >
              <div
                aria-labelledby="rehaul-calendar-picker"
                className="flex flex-col gap-[12px]"
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
                      <span className="text-[16px] font-medium text-[color:var(--ink)]">{calendar.name}</span>
                      <span className={`text-[14px] text-[color:var(--muted)] ${ONBOARDING_MONO_CLASS}`}>
                        {timezoneDisplayLabel(calendar.timeZone) ?? "Time zone set in Google"}
                      </span>
                    </span>
                  </label>
                ))}
                <div className="mt-[4px] flex flex-wrap items-center gap-[14px]">
                  <KitButton
                    className="h-[48px] px-[24px] text-[16px]"
                    disabled={picked === null}
                    onClick={() => void choose()}
                    size="lg"
                    variant="secondary"
                  >
                    Use this calendar
                  </KitButton>
                  <span
                    aria-label={accountability.ariaLabel}
                    className="inline-flex items-center gap-[8px] text-[14px] text-[color:var(--muted)]"
                  >
                    <ShieldCheck aria-hidden className="size-[16px]" />
                    {accountability.microcopy}
                  </span>
                </div>
              </div>
            </DeckPanel>
          ) : null}
        </div>

        <DeckPanel
          dataSlot="rehaul-calendar-manual"
          eyebrow="Only if the press did not work"
          headingId="rehaul-calendar-manual"
          name="Record it by hand"
        >
          <form className="flex flex-col gap-[14px]" onSubmit={(event) => void submit(event)}>
            <p aria-live="polite" className="m-0 text-[15px] leading-[1.4] text-[color:var(--muted)]">
              {status}
            </p>

            <OnboardingField id="calendar-provider" label="Calendar provider">
              <FieldShell className={`relative ${ONBOARDING_FIELD_CLASS}`}>
                <select
                  className="min-w-0 flex-1 appearance-none bg-transparent text-[16px] text-[color:var(--ink)]"
                  id="calendar-provider"
                  onChange={(event) => change("provider", event.target.value)}
                  value={form.provider}
                >
                  <option value="ghl">{PROVIDER_LABELS.ghl}</option>
                  <option value="google">{PROVIDER_LABELS.google}</option>
                </select>
                <SelectCaret />
              </FieldShell>
            </OnboardingField>

            <OnboardingField id="account-reference" label="Provider account reference">
              <KitInput
                className={`text-[16px] ${ONBOARDING_MONO_CLASS}`}
                id="account-reference"
                onChange={(event) => change("externalAccountReference", event.target.value)}
                placeholder="Paste the reference"
                required
                shellClassName={ONBOARDING_FIELD_CLASS}
                value={form.externalAccountReference}
              />
            </OnboardingField>

            <OnboardingField id="calendar-reference" label="Provider calendar reference">
              <KitInput
                className={`text-[16px] ${ONBOARDING_MONO_CLASS}`}
                id="calendar-reference"
                onChange={(event) => change("externalCalendarId", event.target.value)}
                placeholder="Paste the reference"
                required
                shellClassName={ONBOARDING_FIELD_CLASS}
                value={form.externalCalendarId}
              />
            </OnboardingField>

            <OnboardingField id="calendar-timezone" label="Calendar timezone">
              <KitInput
                className={`text-[16px] ${ONBOARDING_MONO_CLASS}`}
                id="calendar-timezone"
                onChange={(event) => change("timezone", event.target.value)}
                required
                shellClassName={ONBOARDING_FIELD_CLASS}
                value={form.timezone}
              />
            </OnboardingField>

            <OnboardingField id="authorization-receipt" label="Authorization receipt reference">
              <KitInput
                className={`text-[16px] ${ONBOARDING_MONO_CLASS}`}
                id="authorization-receipt"
                onChange={(event) => change("authorizationReceipt", event.target.value)}
                placeholder="Never an access token"
                required
                shellClassName={ONBOARDING_FIELD_CLASS}
                value={form.authorizationReceipt}
              />
            </OnboardingField>

            <KitButton
              className="h-[48px] justify-center text-[16px]"
              disabled={saving}
              size="lg"
              type="submit"
              variant="secondary"
            >
              {saving ? "Recording…" : "Record the receipt"}
            </KitButton>
            <span
              aria-label={accountability.ariaLabel}
              className="inline-flex items-center gap-[8px] text-[14px] text-[color:var(--muted)]"
            >
              <ShieldCheck aria-hidden className="size-[16px]" />
              {accountability.microcopy}
            </span>
          </form>
        </DeckPanel>
      </div>

      <OnboardingFooter
        actions={
          <>
            <Link
              className={kitButtonClass({
                className: "h-[48px] px-[22px] text-[16px] no-underline",
                variant: "secondary",
              })}
              href="/onboarding/offer"
            >
              Back
            </Link>
            <Link
              className={kitButtonClass({
                className: "h-[48px] px-[28px] text-[17px] no-underline",
                variant: "primary",
              })}
              href="/onboarding/sms-eligibility"
            >
              Continue
            </Link>
          </>
        }
        sentence="Your agent books nothing until SetterFi has read this calendar's availability back."
      />

      <ContextEye copy={ONBOARDING_CALENDAR_EYE_COPY} screen="onboarding-calendar" />
    </OnboardingShell>
  );
}
