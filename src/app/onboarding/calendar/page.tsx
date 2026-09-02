"use client";

import { FormEvent, useEffect, useState } from "react";

import { ShieldCheck } from "@/components/kit/icons";
import {
  FieldShell,
  KitButton,
  KitInput,
  kitButtonClass,
  Prose,
  SelectCaret,
  Status,
  Surface,
} from "@/components/kit/atomics";
import { OnboardingStage } from "@/components/onboarding/onboarding-stage";
import {
  COACH_FOOTNOTE_CLASS,
  COACH_READING_CLASS,
} from "@/components/workspace/live/coach-type";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";
import { timezoneDisplayLabel, workspaceDateFormat } from "@/lib/format/datetime";

type Connection = { provider: "ghl" | "google"; calendarName: string | null; externalCalendarId: string; externalAccountReference: string | null; authorizationRecordedAt: string | null; state: string };
type GoogleGrant = { connectedAs: string | null; refreshTokenExpiresAt: string | null; reauthorizationRequired: boolean };
type PendingCalendar = { id: string; name: string; timeZone: string };
type Form = { provider: "ghl" | "google"; externalAccountReference: string; externalCalendarId: string; calendarName: string; timezone: string; authorizationReceipt: string };

const EMPTY: Form = { provider: "ghl", externalAccountReference: "", externalCalendarId: "", calendarName: "", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", authorizationReceipt: "" };

/**
 * Coach-visible provider names, and the reason this map exists rather than two inline strings.
 *
 * The `ghl` option rendered as "GoHighLevel Calendar" on this page until 2026-08-31, which is a
 * `CLAUDE.md` hard-rule violation ("No GoHighLevel branding anywhere client-visible") sitting on
 * the most client-facing route in the product. The stored value stays `ghl` because that is what
 * the API and the `calendar_connections` row expect; only the words a coach reads change. The name
 * follows the convention `admin-view-models.ts` already uses, where the `ghl_location` step is
 * shown as "Workspace".
 */
const PROVIDER_LABELS: Readonly<Record<Form["provider"], string>> = {
  ghl: "SetterFi workspace calendar",
  google: "Google Calendar",
};

const LABEL_CLASS = "block text-[16px] leading-[1.4] font-[500] text-[color:var(--body)]";

const GOOGLE_CONNECT_PATH = "/api/calendars/google/connect";

/*
 * The two states of a pickable calendar, spelled out once each rather than assembled from a
 * ternary inside one attribute. Both arms in a single expression read as co-occurring to every
 * static reader of this file, and the difference here is the whole selected state. The chosen row
 * takes the accent line all the way round: an edge bar is the one treatment this product does not
 * use for selection.
 */
const PICKABLE_ROW_CLASS =
  "flex min-w-0 cursor-pointer items-center gap-[var(--s-3)] rounded-[var(--r-control)] border border-[var(--line)] p-[var(--s-3)]";
const PICKED_ROW_CLASS =
  "flex min-w-0 cursor-pointer items-center gap-[var(--s-3)] rounded-[var(--r-control)] border border-[var(--accent)] bg-[var(--raised)] p-[var(--s-3)]";

/**
 * What the callback route returned us with, in the coach's own words.
 *
 * One sentence per outcome the contract can produce, and none of them is styled as a failure the
 * coach caused. `declined` in particular is a person pressing Cancel in Google's own window, which
 * they were entitled to do; reading that back as an error would be the page inventing a fault out
 * of a decision. Provider prose never appears here -- Google's `error_description` can carry
 * request context, so it reaches neither the browser nor a log line.
 */
const CALLBACK_SENTENCES: Readonly<Record<string, string>> = {
  ready: "Google Calendar is connected and SetterFi read your availability back successfully.",
  choose: "Google Calendar is connected. Choose the calendar your agent should book into.",
  unverified: "Google Calendar is connected, but SetterFi could not read your availability yet. Booking stays off until that read succeeds.",
  declined: "The Google window was closed before access was granted. Nothing was changed, and you can connect whenever you are ready.",
  reauthorize: "Google did not return a lasting authorization, so SetterFi cannot keep the connection alive on its own. Connect again and accept the access request.",
  scopes: "Some of the calendar permissions were not granted, so SetterFi cannot read availability or place bookings. Connect again and leave every calendar permission ticked.",
  nocalendars: "A calendar came back, but it has no time zone set, so a booking could land at the wrong hour. Set a time zone on it in Google Calendar, or leave this with your SetterFi contact.",
  error: "The connection did not finish. Nothing was changed. Try again, and tell your SetterFi contact if it keeps stopping here.",
};

/**
 * The audit caption, on its own rather than under a button.
 *
 * `LoggedButton` already pairs a privileged control with the line that says what gets recorded,
 * and this is the same line for the one control that cannot be a `<button>`: connecting leaves the
 * app for Google's consent screen, so it has to be an anchor. Same microcopy, same accessible
 * name, read from the same registry, so the two never drift apart.
 */
function AuditNote({ actionKey }: { actionKey: "calendar.connected" }) {
  const accountability = AUDIT_ACTIONS[actionKey];
  return (
    <span
      aria-label={accountability.ariaLabel}
      className="inline-flex items-center gap-[var(--s-1)] text-[14px] leading-[1.4] text-[color:var(--muted)]"
    >
      <ShieldCheck aria-hidden className="size-[var(--s-3)]" />
      {accountability.microcopy}
    </span>
  );
}

function Field({
  children,
  hint,
  id,
  label,
}: {
  children: React.ReactNode;
  hint?: string;
  id: string;
  label: string;
}) {
  return (
    <div className="min-w-0">
      <label className={LABEL_CLASS} htmlFor={id}>{label}</label>
      <div className="mt-[var(--s-2)]">{children}</div>
      {hint ? (
        <Prose className={`mt-[var(--s-2)] ${COACH_FOOTNOTE_CLASS}`}>
          {hint}
        </Prose>
      ) : null}
    </div>
  );
}

export default function CalendarOnboardingPage() {
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
   * static rendering. It is read once and applied with the payload rather than on its own: the
   * sentence only ever renders inside the connect card, which the payload's availability field
   * decides, so setting it any earlier would be state nothing can display yet.
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
      // `ready` is the one outcome the page can already prove without being told: the state card
      // is green and the lead names the calendar, so repeating it would be a third sentence about
      // one fact. Every other outcome says something no other line on the page carries.
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
   * The picker's whole job: post one id and read one answer. `verified: false` is a 200 with a
   * stored authorization and a failed availability read, so the page keeps the amber card and says
   * which of the two things happened. A 409 is a grant that died between the redirect and the
   * pick, which under Google's Testing status is an ordinary seven-day event.
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
      /*
       * Two refusals that must never be told apart wrongly. A dead grant is gone and the way back
       * is Google's consent screen; a verification that could not run is a live grant and a read
       * that failed to happen, where the way back is the same button. Sending a coach through
       * consent to fix a working authorization wastes the grant they already hold, so the
       * transient arm is checked first and never says reconnect.
       */
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
  // The button is shown when there is nothing live to book into: no Google connection at all, or
  // one Google has stopped honouring.
  const showConnect = connectAvailable && !choosing && (!googleRow || expired || faulted);

  /*
   * The one explanatory line every state gets. `expired` is written for whoever is reading it:
   * under Google's Testing publishing status a grant dies seven days after consent, so this is the
   * ordinary condition of the product rather than a fault, and the sentence has to say what
   * happened and keep the way back visible without telling a coach they broke something.
   */
  const googleFootnote = expired
    ? "Google ends calendar permissions on a schedule while SetterFi is in review with them. Nothing you did caused it, and reconnecting takes one press."
    : faulted
      ? "SetterFi could not keep this connection working. Reconnecting puts it back; tell your SetterFi contact if it happens again."
      : choosing
        ? "Only the calendar you pick is read. SetterFi looks at when you are busy and writes the calls your agent books."
        : verified
          ? "Nothing further is needed from you here."
          : googleRow && connection
            ? "SetterFi owns the availability check and keeps trying it. There is nothing here for you to press while it does."
            : "SetterFi asks Google for permission to read your availability and to put booked calls on your calendar. Nothing else on your Google account is touched.";
  /*
   * The card's first line, which has to answer a different question in each state without ever
   * repeating the card underneath it. A connected Google row names the calendar and stops, because
   * the account, the date and the reason all sit in the rows below it; the untouched arm keeps the
   * exact sentence the demotion guard reads, since that is what a coach sees when SetterFi is
   * still doing this for them.
   */
  const calendarName = connection?.calendarName || "your booking calendar";
  const leadSentence = googleRow && connection
    ? verified
      ? `Your agent books calls into ${calendarName}.`
      : `${calendarName} is the calendar your agent books into.`
    : connection
      ? `SetterFi has recorded ${calendarName} against your account.`
      : connectAvailable
        ? "Your agent needs to see when you are free, and somewhere to put the calls it books. One press is all that takes."
        : "SetterFi records your booking calendar for you as part of setting up your account. You do not need to find any codes or copy anything across.";

  /*
   * The line under the page title, which is the first thing read and therefore the one that must
   * not ask for a press that is not there. It asks for one only while there is something to press.
   */
  const pageLead = !connectAvailable
    ? "SetterFi connects your booking calendar for you during onboarding. There is nothing here for you to fill in."
    : verified
      ? "Your booking calendar is connected and SetterFi has read its availability. Nothing on this page needs you."
      : googleRow && connection && !expired && !faulted
        ? "Google Calendar is connected. SetterFi is finishing the availability check before your agent can book."
        : "SetterFi handles the setup. Connecting Google Calendar is the one press we need from you.";

  const manualFootnote = verified
    ? "Nothing further is needed from you here."
    : "If your calendar still is not connected, your SetterFi contact will finish it with you \u2014 it takes a couple of minutes on a call.";

  return (
    <OnboardingStage
      lead={pageLead}
      title="Connect your booking calendar"
      width="narrow"
    >
      <div className="flex flex-col gap-[var(--s-5)]">

        {/*
          * Two different claims, and the page must never let one stand in for the other. A stored
          * authorization receipt says a provider said yes once; it does not say availability has
          * been read back, and booking depends on the second. So the state card is keyed to
          * `state === "ready"` -- the availability check -- and not to whether a receipt exists.
          */}
        <Surface className="flex flex-col items-start gap-[var(--s-3)]" tone={verified ? "good" : "warning"}>
          <Status
            label={verified ? "Availability verified" : "Availability not verified"}
            tone={verified ? "good" : "warning"}
          />
          <Prose
            className={COACH_READING_CLASS}
            style={{ color: verified ? "var(--body)" : "var(--warning-body)" }}
          >
            {verified
              ? "A calendar is connected and a successful availability read is stored against it. Your agent can book into it."
              : "External calendar availability has not been verified. Your agent cannot book appointments yet."}
          </Prose>
          {/*
            * The expiry sentence sits under the shared one rather than replacing it, because both
            * are true at once: availability is unverified, and the specific reason is that the
            * authorization ran out. The card's condition stays the single `state === "ready"`
            * check above; this adds detail to the amber, it does not open a second way to be green.
            */}
          {expired || faulted ? (
            <Prose className={COACH_FOOTNOTE_CLASS} style={{ color: "var(--warning-body)" }}>
              {expired
                ? "The Google Calendar authorization has run out, so nothing can be booked until it is reconnected."
                : "The Google Calendar connection stopped working, so nothing can be booked until it is reconnected."}
            </Prose>
          ) : null}
        </Surface>

        {/*
          * The coach's half of this screen, and why it states a value instead of offering a control.
          *
          * Until 2026-09-02 this route opened straight onto six inputs asking a credit coach for a
          * "provider account reference", a "provider calendar reference" and a "provider-issued
          * authorization receipt reference". None of those values is discoverable anywhere in
          * SetterFi, and no calendar OAuth flow exists in the codebase, so the form WAS the
          * integration -- which contradicts the done-for-you principle in `CLAUDE.md` ("most rows
          * state the value SetterFi already chose rather than offering a control") on the most
          * client-facing route in the product.
          *
          * The inputs are not deleted, only demoted. Until 2026-09-02 this form was the only writer
          * of `calendar_connections` anywhere in the product; the Google connect route below is now
          * the second, but the SetterFi workspace calendar still has no authorization flow of its
          * own, so removing the disclosure would leave that case with nobody able to connect it.
          */}
        <Surface className="flex flex-col gap-[var(--s-4)]">
          {/*
            * The lead sentence steps aside while the coach is being asked to pick, because at that
            * moment the question below it is the whole content of the card and a sentence about
            * how SetterFi normally handles this is something to read past.
            */}
          {choosing ? null : (
            <Prose className={`m-0 ${COACH_READING_CLASS} text-[color:var(--body)]`}>
              {leadSentence}
            </Prose>
          )}

          {connectAvailable && googleRow && grant?.connectedAs ? (
            <Surface className="flex flex-col gap-[var(--s-1)]" variant="well">
              <Prose className={`m-0 ${COACH_READING_CLASS} text-[color:var(--ink)]`}>
                {`Connected as ${grant.connectedAs}`}
              </Prose>
              {connection?.authorizationRecordedAt ? (
                <Prose className={`m-0 ${COACH_FOOTNOTE_CLASS}`}>
                  {`Connected on ${workspaceDateFormat.format(new Date(connection.authorizationRecordedAt))}`}
                </Prose>
              ) : null}
            </Surface>
          ) : null}

          {connectAvailable && connectMessage ? (
            <p
              aria-live="polite"
              className={`m-0 ${COACH_READING_CLASS} text-[color:var(--body)]`}
            >
              {connectMessage}
            </p>
          ) : null}

          {/*
            * The picker. Names only: a Google calendar id is the account's email on the primary
            * entry and an opaque group address on the rest, so neither is a thing a coach
            * recognises and printing one would be a leak dressed as detail. The time zone stays,
            * because it is the one fact that decides whether a booked call lands at the right hour.
            */}
          {choosing ? (
            <div
              aria-label="Which calendar should your agent book into?"
              className="flex flex-col gap-[var(--s-2)]"
              role="radiogroup"
            >
              {pending.map((calendar) => (
                <label
                  className={picked === calendar.id ? PICKED_ROW_CLASS : PICKABLE_ROW_CLASS}
                  key={calendar.id}
                >
                  <input
                    checked={picked === calendar.id}
                    className="size-[var(--s-4)] shrink-0 accent-[var(--accent)]"
                    name="google-calendar"
                    onChange={() => setPicked(calendar.id)}
                    type="radio"
                    value={calendar.id}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={`${COACH_READING_CLASS} text-[color:var(--ink)]`}>{calendar.name}</span>
                    <span className={COACH_FOOTNOTE_CLASS}>{timezoneDisplayLabel(calendar.timeZone) ?? "Time zone set in Google"}</span>
                  </span>
                </label>
              ))}
              {/*
                * A `KitButton` and the same caption the connect anchor carries, rather than a
                * `LoggedButton`. That component renders the shadcn button, whose primary face is a
                * different blue from the kit's accent and whose caption is set in caps, so the two
                * controls on this one page would have been two different buttons saying the same
                * microcopy two different ways.
                */}
              <div className="mt-[var(--s-2)] flex flex-col items-start gap-[var(--s-2)]">
                <KitButton
                  className="h-[var(--coach-target-primary)] px-[28px] text-[18px]"
                  disabled={picked === null}
                  onClick={() => void choose()}
                  size="lg"
                  variant="primary"
                >
                  Use this calendar
                </KitButton>
                <AuditNote actionKey="calendar.connected" />
              </div>
            </div>
          ) : null}

          {showConnect ? (
            <div className="flex flex-col items-start gap-[var(--s-2)]">
              <a
                className={kitButtonClass({
                  className: "h-[var(--coach-target-primary)] px-[28px] text-[18px]",
                  size: "lg",
                  variant: "primary",
                })}
                href={GOOGLE_CONNECT_PATH}
              >
                {expired || faulted ? "Reconnect Google Calendar" : "Connect Google Calendar"}
              </a>
              <AuditNote actionKey="calendar.connected" />
            </div>
          ) : null}

          <Prose className={`m-0 ${COACH_FOOTNOTE_CLASS}`}>
            {connectAvailable ? googleFootnote : manualFootnote}
          </Prose>
        </Surface>

        {/*
          * `<details>` rather than a conditional render: the inputs stay mounted so the two existing
          * guards in `page.test.tsx` -- the receipt round-trip and the GHL branding assertion that
          * reads `document.body.textContent` -- keep measuring the real control set rather than an
          * empty subtree. A collapsed disclosure that unmounts its contents reads as agreement to
          * every static and DOM-walking reader.
          */}
        <details className="min-w-0">
          <summary
            className={`cursor-pointer list-none ${COACH_FOOTNOTE_CLASS} text-[color:var(--body)]`}
          >
            Set up manually
          </summary>

          <Surface className="mt-[var(--s-3)] flex flex-col gap-[var(--s-5)]">
            <Prose className={`m-0 ${COACH_FOOTNOTE_CLASS}`}>
              For SetterFi to complete with you. These are provider-issued identifiers, not
              anything you are expected to know.
            </Prose>

            <p
              aria-live="polite"
              className={`surface-well m-0 ${COACH_READING_CLASS} text-[color:var(--body)]`}
            >
              {status}
            </p>

            <form className="grid gap-[var(--s-4)]" onSubmit={(event) => void submit(event)}>
              <Field id="calendar-provider" label="Calendar provider">
                <FieldShell className="h-[var(--coach-target)] w-full">
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
              </Field>

              <Field id="account-reference" label="Provider account reference">
                <KitInput
                  className="mono"
                  id="account-reference"
                  onChange={(event) => change("externalAccountReference", event.target.value)}
                  required
                  shellClassName="w-full"
                  value={form.externalAccountReference}
                />
              </Field>

              <Field id="calendar-reference" label="Provider calendar reference">
                <KitInput
                  className="mono"
                  id="calendar-reference"
                  onChange={(event) => change("externalCalendarId", event.target.value)}
                  required
                  shellClassName="w-full"
                  value={form.externalCalendarId}
                />
              </Field>

              <Field id="calendar-name" label="Calendar name (optional)">
                <KitInput
                  id="calendar-name"
                  onChange={(event) => change("calendarName", event.target.value)}
                  shellClassName="w-full"
                  value={form.calendarName}
                />
              </Field>

              <Field id="calendar-timezone" label="Calendar timezone">
                <KitInput
                  className="mono"
                  id="calendar-timezone"
                  onChange={(event) => change("timezone", event.target.value)}
                  required
                  shellClassName="w-full"
                  value={form.timezone}
                />
              </Field>

              <Field
                hint="Do not enter an OAuth access token. This field is only for the completed provider authorization receipt reference."
                id="authorization-receipt"
                label="Provider-issued authorization receipt reference"
              >
                <KitInput
                  className="mono"
                  id="authorization-receipt"
                  onChange={(event) => change("authorizationReceipt", event.target.value)}
                  required
                  shellClassName="w-full"
                  value={form.authorizationReceipt}
                />
              </Field>

              <div className="flex flex-wrap items-center gap-[var(--s-3)] border-t border-[var(--line-soft)] pt-[var(--s-4)]">
                <KitButton
                  className="h-[var(--coach-target-primary)] px-[28px] text-[18px]"
                  disabled={saving}
                  size="lg"
                  type="submit"
                  variant="primary"
                >
                  {saving ? "Recording…" : "Record authorization receipt"}
                </KitButton>
                <span className={COACH_FOOTNOTE_CLASS}>
                  Recording a receipt is logged in your onboarding audit trail.
                </span>
              </div>
            </form>
          </Surface>
        </details>
      </div>
    </OnboardingStage>
  );
}
