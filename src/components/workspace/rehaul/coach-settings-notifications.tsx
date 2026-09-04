"use client";

/*
 * Coach Settings, drawn from `design/coach/Notifications.dc.html`.
 *
 * What this replaces: `live/alert-settings.tsx` at the coach surface -- 29 notices in eight
 * groups, 58 checkboxes, a 5686px document, 42 accent fills painted on one page, 117 targets under
 * 44px and the word "Required" printed eight times beside a lock glyph. Spec section 2.7 collapses
 * all of it to one question, and `docs/plans/2026-09-04-coach-visual-audit.md` section 8 calls it
 * the clearest kill on the coach side.
 *
 * The matrix is not hidden here, it is gone: this page reads and writes the coach-collapsed
 * preference at `/api/coach/notification-preference`, which derives one of email/text/both from
 * every coach-suppressible rule and writes back only the destinations that need to change. The
 * platform's non-suppressible rules are not in that set and are not represented on this page,
 * which is why the second half of the screen is a list of statements with no controls beside them.
 *
 * Three things the artboard prints that this does not, each because the record does not carry it:
 *
 *   - "Sent to reid@fenwickfunding.com." No coach-reachable read returns the signed-in coach's
 *     email address. `WorkspaceAccount` carries a name and a business, `AppClaims` carries ids, and
 *     inventing a plausible address on a page about where mail is sent is the worst possible place
 *     to guess. The row names the account instead of the address.
 *   - "on day 14 of about 21". That counter is computed by the setup screen from this tenant's own
 *     A2P registration, and this page has no registration read. A hard-coded day count is a
 *     predicted date, which the release boundary forbids.
 *   - "the card ending 4429". No card is read here, and Billing is one row away in the same menu.
 */

import Link from "next/link";
import { useEffect, useId, useState } from "react";

import { ACCENT_FILL_SHADOW_CLASS } from "@/components/kit/atomics/button-class";
import { AppShell } from "@/components/kit/app-shell";
import { ArrowLeft, Bell, CalendarCheck, ChatText, Check, CreditCard, Smartphone } from "@/components/kit/icons";
import { DeckPanel } from "@/components/kit/deck-panel";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import { COACH_FOOTNOTE_CLASS, COACH_LEAD_CLASS } from "@/components/workspace/live/coach-type";
import type { CoachNotificationPreference } from "@/lib/repositories/coach-notification-preference";
import { workspaceNavigationFor } from "@/lib/workspace-navigation";

const CRUMBS = [{ label: "Coach" }, { label: "Settings" }] as const;

/* The sentences this screen used to print as help text, handed to the eye instead. */
export const COACH_SETTINGS_EYE_COPY =
  "One choice, and it applies to everything we send you. Email goes to the address on your "
  + "account. Text is not switchable yet: a number has to clear carrier review before anyone can "
  + "be reached on it, and the setup screen carries the day count for yours. The four things "
  + "listed below are everything SetterFi sends a coach, so there is nothing else here to turn "
  + "off. Your choice takes effect on the next thing we send; it does not resend anything already "
  + "sent.";

/**
 * The three answers, in the artboard's order.
 *
 * `ready` is the honest half of this file. The preference store accepts all three values and
 * audits them, but `claim_notification_deliveries` only ever claims `destination = 'email'`, so a
 * coach who picks text today has their intent recorded and receives nothing. Offering the choice
 * as though it worked would be the product promising a delivery it has no worker for, so the two
 * unready answers say "Not ready yet" and cannot be picked -- until one already is the stored
 * answer, in which case the screen shows it rather than misreporting the account's state.
 */
type Choice = {
  value: CoachNotificationPreference;
  label: string;
  sentence: string;
  ready: boolean;
  icon: typeof Bell;
};

const CHOICES: readonly Choice[] = [
  {
    value: "email",
    label: "Email",
    sentence: "Sent to the address on your account.",
    ready: true,
    icon: ChatText,
  },
  {
    value: "text",
    label: "Text",
    sentence: "Opens the day your number clears carrier review. Setup carries the day count.",
    ready: false,
    icon: Smartphone,
  },
  {
    value: "both",
    label: "Both",
    sentence: "We will offer this the day texting opens.",
    ready: false,
    icon: Bell,
  },
];

/**
 * What SetterFi already sends a coach, as statements rather than as rows with switches.
 *
 * Four, and the count in the sentence above them is this array's length rather than the word
 * "four" typed twice. Each one names a real event family in the notification code:
 * `notifications/agent-inactivity.ts` and the handoff events in `notifications/events.ts`,
 * the booked-call events in `notifications/events.ts`, `notifications/channel-events.ts`, and
 * `notifications/billing-events.ts`. Nothing else reaches a coach, which is the claim the
 * counted sentence is making and the reason there is nothing here to switch off.
 */
const ALREADY_SENT: readonly { id: string; statement: string; icon: typeof Bell }[] = [
  {
    id: "waiting",
    statement: "A lead is waiting on you, because your agent will not answer that one for you.",
    icon: ChatText,
  },
  {
    id: "booked",
    statement: "A call was booked, with the day, the time and who it is with.",
    icon: CalendarCheck,
  },
  {
    id: "channel",
    statement:
      "Instagram, Messenger or text messages stopped working, the same hour we see it.",
    icon: Smartphone,
  },
  {
    id: "billing",
    statement: "Your bill, three days before we charge your card.",
    icon: CreditCard,
  },
];

/* The coach scale, restated locally the way `coach-billing.tsx` does it. */
/*
 * A grid rather than a flex row, and the breakpoint is the reason.
 *
 * As one flex line the row seats a 48px tile, the name over its sentence, a 28px radio and a
 * "Not ready yet" pill. At 1440 there is room for all four. At 390 the tile, the radio, the pill
 * and three gaps take about 240 of the 346 usable pixels, leaving the sentence roughly 100px:
 * "Opens the day your number clears carrier review" came out one word per line, measured
 * 2026-09-04. Wrapping alone does not fix it, because the pill has to leave the first line and
 * flex has no way to say that without ordering the nodes differently at each width.
 *
 * So the placement is explicit and the DOM is not duplicated: four columns on one row above `sm`,
 * three columns over three rows below it, with the name and the radio on the first line and the
 * sentence and the pill each spanning the full width beneath. One element per thing, at both
 * widths, which is what keeps the accessible name and the "Not ready yet" count honest.
 */
const CHOICE_ROW_CLASS =
  "grid min-h-[96px] w-full min-w-0 cursor-pointer items-center gap-x-[18px] gap-y-[8px] "
  + "grid-cols-[48px_minmax(0,1fr)_28px] sm:grid-cols-[48px_minmax(0,1fr)_28px_auto] "
  + "rounded-[17px] border px-[22px] py-[20px] "
  + "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--focus-ring)] "
  + "has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-[var(--canvas)]";
/* Row 1 on a phone, and the left of the single row above `sm`, where it spans both text rows. */
const CHOICE_CELL_TILE = "col-start-1 row-start-1 self-center sm:row-span-2";
const CHOICE_CELL_NAME = "col-start-2 row-start-1 self-center";
const CHOICE_CELL_MARK = "col-start-3 row-start-1 self-center sm:row-span-2";
/* Full width under the name on a phone; back beside it, in the text column, above `sm`. */
const CHOICE_CELL_SENTENCE =
  "col-start-1 col-end-[-1] row-start-2 sm:col-start-2 sm:col-end-3";
const CHOICE_CELL_PILL =
  "col-start-1 col-end-[-1] row-start-3 justify-self-start "
  + "sm:col-start-4 sm:col-end-5 sm:row-start-1 sm:row-span-2 sm:self-center sm:justify-self-end";
const CHOICE_ON_CLASS = "border-[var(--accent-edge)] bg-[var(--accent-wash)]";
const CHOICE_OFF_CLASS = "border-[var(--line)] bg-[var(--well)]";
const CHOICE_TILE_CLASS =
  "grid size-[48px] flex-none place-items-center rounded-[12px] border border-[var(--line)] "
  + "bg-[var(--card-top)] text-[color:var(--accent-text)]";
const SAVE_CLASS =
  "inline-flex h-[48px] items-center justify-center rounded-[9px] border border-[var(--accent-line)] "
  + "[background:var(--accent-fill)] px-[24px] text-[16px] leading-none font-semibold "
  + `text-[color:var(--on-accent)] ${ACCENT_FILL_SHADOW_CLASS} `
  + "disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none";
const PILL_CLASS =
  "inline-flex h-[32px] flex-none items-center gap-[8px] rounded-full border px-[12px] text-[15px] "
  + "leading-none font-medium whitespace-nowrap";

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "unreadable" }
  | { kind: "ready"; saved: CoachNotificationPreference };

export type CoachSettingsNotificationsProps = {
  /**
   * False outside a live alerts environment. The page still renders its head and its statements,
   * because what SetterFi sends is true whether or not this deployment can read a preference; only
   * the question is withheld, and it says why rather than rendering an inert control.
   */
  enabled: boolean;
  /**
   * Whether this coach also holds the affiliate capability, which widens the shell's destination
   * list to include the affiliate portal while they are on this page.
   *
   * Carried over from `alert-settings.tsx` unchanged, and it is worth saying what it is not: it
   * has never had anything to do with which notification rules a coach controls. It is a
   * navigation concern only -- a coach who is also an affiliate loses their way back to the portal
   * on a page reached from the account menu, because this route is not in either role's own list.
   */
  affiliateAccess?: boolean;
};

export function CoachSettingsNotifications({
  affiliateAccess = false,
  enabled,
}: CoachSettingsNotificationsProps) {
  const [state, setState] = useState<LoadState>(enabled ? { kind: "loading" } : { kind: "error" });
  const [picked, setPicked] = useState<CoachNotificationPreference | null>(null);
  const [saving, setSaving] = useState(false);
  const [receipt, setReceipt] = useState<{ ok: boolean; message: string } | null>(null);
  const groupName = useId();

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/coach/notification-preference", {
          signal: controller.signal,
        });
        const payload: unknown = await response.json();
        if (!response.ok || !payload || typeof payload !== "object") throw new Error("READ_FAILED");
        const preference = (payload as { preference?: unknown }).preference;
        if (preference === null || preference === undefined) {
          setState({ kind: "unreadable" });
          return;
        }
        setState({ kind: "ready", saved: preference as CoachNotificationPreference });
        setPicked(preference as CoachNotificationPreference);
      } catch (error) {
        if (controller.signal.aborted) return;
        void error;
        setState({ kind: "error" });
      }
    })();
    return () => controller.abort();
  }, [enabled]);

  async function save() {
    if (!picked) return;
    setSaving(true);
    setReceipt(null);
    try {
      const response = await fetch("/api/coach/notification-preference", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preference: picked }),
      });
      const payload: unknown = await response.json();
      const settled = (payload as { preference?: unknown } | null)?.preference;
      if (!response.ok || typeof settled !== "string") throw new Error("WRITE_REFUSED");
      setState({ kind: "ready", saved: settled as CoachNotificationPreference });
      setPicked(settled as CoachNotificationPreference);
      setReceipt({ ok: true, message: "Saved, and read back from your account." });
    } catch (error) {
      void error;
      setReceipt({ ok: false, message: "That could not be saved. Nothing about your account changed." });
    } finally {
      setSaving(false);
    }
  }

  const saved = state.kind === "ready" ? state.saved : null;
  const dirty = Boolean(picked && picked !== saved);

  const navigation = [
    ...workspaceNavigationFor("coach"),
    ...(affiliateAccess ? workspaceNavigationFor("affiliate") : []),
  ];

  return (
    <AppShell
      activePath="/coach/settings"
      crumbs={CRUMBS}
      nav={navigation}
      role="coach"
    >
    <div className="flex min-w-0 flex-col gap-[32px]" data-slot="coach-settings">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-[24px]">
        <header className="flex min-w-0 flex-col gap-[var(--s-2)]" data-page-head="settings">
          {/*
            Settings is reached from the account menu, which is not a place on the page, so without
            this a coach who opens it has no route out but the browser's own back.
          */}
          <Link
            className="inline-flex min-h-[44px] items-center gap-[8px] text-[16px] leading-[1.4] font-medium text-[color:var(--accent-text)] no-underline hover:underline"
            data-slot="settings-back"
            href="/coach/home"
          >
            <ArrowLeft aria-hidden size={18} strokeWidth={1.75} />
            Back to Home
          </Link>
          <h1 className="coach-page-title m-0">Settings</h1>
          <p className={`m-0 max-w-[var(--measure-prose)] ${COACH_LEAD_CLASS}`}>
            One thing to choose, and a list of what we already send you. Everything else is decided
            for you.
          </p>
        </header>
        <ContextEye
          copy={COACH_SETTINGS_EYE_COPY}
          placement="header"
          scale="coach"
          screen="coach-settings"
        />
      </div>

      <section aria-labelledby="coach-settings-question" className="flex min-w-0 flex-col gap-[16px]">
        <h2
          className="m-0 text-[22px] leading-[1.2] font-medium tracking-[-0.015em] text-[color:var(--ink)]"
          id="coach-settings-question"
        >
          Where do you want to be told?
        </h2>

        {state.kind === "loading" ? (
          <p aria-live="polite" className={`m-0 ${COACH_LEAD_CLASS}`} role="status">
            Reading your current choice.
          </p>
        ) : null}
        {/*
          Absence stated in the place the answer would be, per the canvas rule. An unreadable
          preference and a preference of "email" are different facts and the screen must not draw
          them the same way, so nothing is shown as chosen and the sentence says why.
        */}
        {state.kind === "unreadable" ? (
          <p className={`m-0 max-w-[var(--measure-prose)] text-[20px] leading-[1.35] font-medium text-[color:var(--muted)]`}>
            We cannot tell which of these your account is on right now. Choosing one below settles it.
          </p>
        ) : null}
        {state.kind === "error" ? (
          <p className={`m-0 max-w-[var(--measure-prose)] text-[20px] leading-[1.35] font-medium text-[color:var(--muted)]`}>
            {enabled
              ? "Your choice could not be read just now, so nothing here is safe to change."
              : "This workspace is not sending notifications yet, so there is nothing to choose."}
          </p>
        ) : null}

        <div
          aria-labelledby="coach-settings-question"
          className="flex min-w-0 flex-col gap-[12px]"
          role="radiogroup"
        >
          {CHOICES.map((choice) => {
            const on = picked === choice.value;
            const selectable = enabled && choice.ready && state.kind !== "error";
            const Icon = choice.icon;
            return (
              <label
                className={`${CHOICE_ROW_CLASS} ${on ? CHOICE_ON_CLASS : CHOICE_OFF_CLASS}${selectable ? "" : " cursor-default"}`}
                data-choice={choice.value}
                data-chosen={on ? "true" : undefined}
                key={choice.value}
              >
                <input
                  checked={on}
                  className="sr-only"
                  disabled={!selectable}
                  name={groupName}
                  onChange={() => setPicked(choice.value)}
                  type="radio"
                  value={choice.value}
                />
                <span aria-hidden className={`${CHOICE_TILE_CLASS} ${CHOICE_CELL_TILE}`}>
                  <Icon size={24} strokeWidth={1.75} />
                </span>
                {/*
                  The name and its sentence are two grid children rather than one stacked column,
                  because below `sm` they belong on different rows with the radio between them.
                  DOM order is still name, sentence, pill, so the row reads in that order however
                  the two layouts place them.
                */}
                <span className={`${CHOICE_CELL_NAME} text-[17px] leading-[1.35] font-medium text-[color:var(--ink)]`}>
                  {choice.label}
                </span>
                <span className={`${CHOICE_CELL_SENTENCE} min-w-0 text-[16px] leading-[1.5] text-[color:var(--muted)]`}>
                  {choice.sentence}
                </span>
                {choice.ready ? null : (
                  <span className={`${CHOICE_CELL_PILL} ${PILL_CLASS} border-[var(--line)] bg-[var(--control-fill)] text-[color:var(--muted)]`}>
                    <span aria-hidden className="size-[8px] flex-none rounded-full bg-[var(--faint)]" />
                    Not ready yet
                  </span>
                )}
                {on ? (
                  <span
                    aria-hidden
                    className={`${CHOICE_CELL_MARK} grid size-[28px] flex-none place-items-center rounded-full border border-[var(--accent-edge)] bg-[var(--accent-wash-strong)] text-[color:var(--accent-text)]`}
                  >
                    <Check size={16} strokeWidth={2.4} />
                  </span>
                ) : (
                  <span
                    aria-hidden
                    className={`${CHOICE_CELL_MARK} size-[28px] flex-none rounded-full border border-[var(--line-input)] bg-[var(--card-top)]`}
                  />
                )}
              </label>
            );
          })}
        </div>
      </section>

      {/*
        The second half of the screen, and the reason the first half is one question: everything
        below is a decision the platform has made, so it is written as statements with nothing
        pressable beside them. This is the counted-sentence pattern the owner console landed and
        the audit says was never carried across -- one sentence in place of "Required" printed
        eight times with a lock glyph beside every locked box.
      */}
      <DeckPanel
        eyebrow="Nothing here is a setting"
        headingId="coach-settings-already-sent"
        name="What we already send you"
      >
        <p className="m-0 max-w-[var(--measure-prose)] text-[16px] leading-[1.55] text-[color:var(--muted)]">
          There are {ALREADY_SENT.length} of these, and only {ALREADY_SENT.length}. We send nothing
          else, so there is nothing here to switch off.
        </p>
        <ul className="m-0 mt-[4px] flex list-none flex-col p-0">
          {ALREADY_SENT.map((row) => {
            const Icon = row.icon;
            return (
              <li
                className="flex min-h-[60px] items-start gap-[14px] border-t border-[var(--line-soft)] py-[16px]"
                key={row.id}
              >
                <span
                  aria-hidden
                  className="mt-[1px] grid size-[26px] flex-none place-items-center rounded-full border border-[var(--good-line)] bg-[var(--good-wash)] text-[color:var(--good-text)]"
                >
                  <Icon size={15} strokeWidth={1.75} />
                </span>
                <span className="text-[16px] leading-[1.55] text-[color:var(--body)]">
                  {row.statement}
                </span>
              </li>
            );
          })}
        </ul>
      </DeckPanel>

      <div className="flex min-w-0 flex-wrap items-center gap-[20px]">
        <button
          className={SAVE_CLASS}
          disabled={!dirty || saving}
          onClick={() => void save()}
          type="button"
        >
          {saving ? "Saving" : "Save"}
        </button>
        <p className={`m-0 ${COACH_FOOTNOTE_CLASS}`}>
          Your choice takes effect on the next thing we send you.
        </p>
      </div>

      {receipt ? (
        <p
          className={`m-0 text-[16px] leading-[1.5] ${receipt.ok ? "text-[color:var(--good-text)]" : "text-[color:var(--warning-text)]"}`}
          role={receipt.ok ? "status" : "alert"}
        >
          {receipt.message}
        </p>
      ) : null}
    </div>
    </AppShell>
  );
}
