"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  CalendarCheck,
  ChevronRight,
  CreditCard,
  FileText,
  LogOut,
  MessageSquare,
  Monitor,
  Shield,
  X,
} from "lucide-react";

import type { Preference } from "@/app/api/notification-preferences/handler";
import { LoggedPill } from "@/components/kit/confirm-flow";
import { MatrixCheckbox } from "@/components/kit/matrix-checkbox";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import {
  alertRuleViews,
  applyPreferenceReadBack,
  canChangePreference,
  loadNotificationPreferences,
  type AlertRuleView,
} from "@/components/workspace/live/notification-view-models";
import { useWorkspaceEnv } from "@/components/workspace/workspace-env";
import { Pill, StatusDot } from "@/components/workspace/rehaul/_primitives";
import { ADMIN_GUIDES } from "@/lib/admin-help-guides";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { workspaceDateFormat } from "@/lib/format/datetime";
import type { CoachSupportThreadRead } from "@/lib/repositories/support";
import {
  applyTheme,
  readStoredPreference,
  resolveTheme,
  storeThemePreference,
  systemTheme,
  type ThemePreference,
} from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * The account sheet: one 520px right panel that replaces four routes and a dropdown.
 *
 * Before this, a signed-in person reached their own account through an eleven-row dropdown that
 * scattered its destinations across `/admin/alerts`, `/admin/account-terms`, `/admin/help`,
 * `/coach/settings`, `/coach/help` and `/coach/tips` -- six full page loads out of whatever they
 * were reading, for settings that take one glance each. The artboards
 * (`OwnerSettings.body.html`, `CoachSettings.body.html`) draw all of it as one panel over the page
 * you are already on, which is what this is.
 *
 * Two variants rather than two components. The owner console runs 13-15px type on 34px targets and
 * shows the platform's own sections (account terms, operator guides); the coach app runs 16-17px on
 * a 44px floor and shows theirs (notifications by destination, support). Everything else -- the
 * identity block, the sign-out, the section scaffolding, the notification write path -- is the same
 * on both sides, and a fork would have duplicated the write path, which is the part with a server
 * round trip in it.
 *
 * No data is invented here. Notification rules come from `/api/notification-preferences` through
 * the same view models `alert-settings.tsx` uses; the operator guide list is the same
 * `ADMIN_GUIDES` module `/admin/help` renders; support counts come from `/api/support/threads`; and
 * the account terms registry is a server read, so it arrives as a prop and the section says nothing
 * about publication state when it has not been handed one.
 */

export type AccountSheetVariant = "owner" | "coach";

export type AccountSheetSection =
  | "account"
  | "settings"
  | "notifications"
  | "terms"
  | "help";

const OWNER_SECTIONS = ["account", "settings", "terms", "help"] as const;
const COACH_SECTIONS = ["account", "notifications", "help"] as const;

/**
 * The `?section=` value, or null.
 *
 * A section the other variant owns is not an error and not a fallback to "account": an owner link
 * pasted into a coach's browser should open the sheet at the top rather than at a section that
 * does not exist there, and a typo should do the same.
 */
export function accountSheetSection(
  variant: AccountSheetVariant,
  value: string | null | undefined,
): AccountSheetSection | null {
  const sections: readonly string[] = variant === "owner" ? OWNER_SECTIONS : COACH_SECTIONS;
  return value && sections.includes(value) ? (value as AccountSheetSection) : null;
}

function sectionDomId(section: AccountSheetSection) {
  return `account-sheet-${section}`;
}

export type AccountSheetTermsVersion = {
  versionKey: string;
  contentHash: string;
  createdAt: string;
  publishedAt: string | null;
};

export type AccountSheetTerms = {
  published: AccountSheetTermsVersion | null;
  drafts: readonly AccountSheetTermsVersion[];
  /** Whether signup actually asks a new coach to accept. The registry works either way. */
  acceptanceLive: boolean;
  /** Set when the registry could not be read, so the section states that rather than "none". */
  readError: string | null;
};

export type AccountSheetProps = {
  variant: AccountSheetVariant;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Scrolls this section into view when the sheet opens. */
  section?: AccountSheetSection | null;
  /** Owner only, and only where a server read supplied it. Absent from the topbar mount. */
  terms?: AccountSheetTerms;
};

/* ---------------------------------------------------------------------------------------------
 * Shared scaffolding
 * ------------------------------------------------------------------------------------------- */

const OWNER_OVERLINE =
  "font-mono text-[10.5px] uppercase tracking-[0.08em] text-[var(--faint)]";
const COACH_SECTION_NAME = "text-[17px] font-semibold tracking-[-0.01em] text-[var(--ink)]";

function SectionHead({
  variant,
  title,
  trailing,
}: {
  variant: AccountSheetVariant;
  title: string;
  trailing?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2",
        variant === "owner"
          ? "mb-2.5"
          : "h-[58px] flex-[0_0_58px] border-y border-[var(--line)] px-6",
      )}
    >
      <span className={variant === "owner" ? OWNER_OVERLINE : COACH_SECTION_NAME}>{title}</span>
      {trailing ? <span className="ml-auto flex items-center gap-2">{trailing}</span> : null}
    </div>
  );
}

function MonoMeta({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[11px] text-[var(--faint)]">{children}</span>;
}

const OWNER_ROW = "flex items-center gap-2.5 h-[34px] border-b border-[var(--line-soft)]";
const COACH_ROW =
  "flex items-center gap-4 min-h-[54px] px-6 border-b border-[var(--line-soft)] text-[16px]";

/* ---------------------------------------------------------------------------------------------
 * Identity
 * ------------------------------------------------------------------------------------------- */

function initialsFor(fullName: string | null | undefined, fallback: string) {
  const tokens = (fullName ?? "").split(/\s+/u).filter(Boolean).slice(0, 2);
  if (tokens.length === 0) return fallback;
  return tokens.map((token) => token[0]!.toUpperCase()).join("");
}

function ExitControl({
  mode,
  variant,
}: {
  mode: "open" | "password" | "supabase";
  variant: AccountSheetVariant;
}) {
  const face = cn(
    "inline-flex items-center gap-2 border border-[var(--line)]",
    "bg-[var(--card)] font-medium text-[var(--ink)] no-underline",
    variant === "owner" ? "h-8 rounded-lg px-3 text-[13px]" : "h-[44px] rounded-[12px] px-5 text-[16px]",
  );

  /*
   * There is no session to end in the open and password modes, so the exit is the same plain link
   * back to the view picker the account menu has always used rather than a sign-out post that
   * would have nothing to revoke.
   */
  if (mode !== "supabase") {
    return (
      <Link className={face} href="/">
        <LogOut aria-hidden="true" className="size-[15px]" strokeWidth={2} />
        Switch view
      </Link>
    );
  }

  /*
   * The receipt is the true word rather than a decoration: `/auth/signout` writes an
   * `auth.signed_out` row through `writeAuthAuditEvent` and refuses the sign-out outright when
   * that write fails, so the pill's words come from the registry entry for that exact key.
   *
   * It hangs off the supabase branch alone. The open and password modes end no session and write
   * no row, so a receipt there would claim a record that was never made.
   */
  return (
    <form action="/auth/signout?next=%2Flogin" className="flex items-center gap-2" method="post">
      <span data-slot="account-sheet-signout-logged">
        <LoggedPill actionKey="auth.signed_out" />
      </span>
      <button className={face} type="submit">
        <LogOut aria-hidden="true" className="size-[15px]" strokeWidth={2} />
        Sign out
      </button>
    </form>
  );
}

/* ---------------------------------------------------------------------------------------------
 * Notifications
 * ------------------------------------------------------------------------------------------- */

type LoadState = "loading" | "ready" | "error";

const OWNER_DESTINATIONS = [
  { destination: "bell" as const, label: "Bell" },
  { destination: "email" as const, label: "Email" },
  { destination: "slack" as const, label: "Slack" },
];

/*
 * Slack is deliberately absent from the coach's list. The API can store it and the console offers
 * it, but it is a platform destination pointed at SetterFi's own channel, and the one time a
 * Slack-destined rule reached coaches it was a hand-inserted demo row. The console keeps all three.
 */
const COACH_DESTINATIONS = [
  { destination: "bell" as const, label: "In the app" },
  { destination: "email" as const, label: "Email" },
];

const COACH_CATEGORY_ICON: Record<string, typeof Bot> = {
  agent: Bot,
  billing: CreditCard,
  booking: CalendarCheck,
  brain: Bot,
  channels: Monitor,
  conversation: MessageSquare,
  onboarding: Monitor,
  safety: Shield,
};

function useNotificationPreferences(active: boolean) {
  const [preferences, setPreferences] = useState<Preference[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [saving, setSaving] = useState<string | null>(null);
  const writeInFlight = useRef(false);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();

    void loadNotificationPreferences(true, controller.signal, fetchWithTimeout)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.kind === "ready") {
          setPreferences(result.preferences);
          setState("ready");
        } else {
          setState("error");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setState("error");
      });

    return () => controller.abort();
  }, [active]);

  const update = useCallback(async (preference: Preference, nextEnabled: boolean) => {
    if (writeInFlight.current || !canChangePreference(preference, nextEnabled)) return;
    const key = `${preference.ruleId}:${preference.destination}`;
    writeInFlight.current = true;
    setSaving(key);
    try {
      const response = await fetch("/api/notification-preferences", {
        method: "PUT",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ruleId: preference.ruleId,
          destination: preference.destination,
          enabled: nextEnabled,
        }),
      });
      if (!response.ok) return;
      const payload = (await response.json()) as {
        preference?: Pick<Preference, "ruleId" | "destination" | "enabled" | "locked">;
      };
      if (!payload.preference) return;
      // The server's read-back, never the value we asked for: a write the database clamped has to
      // land on screen as what it actually stored.
      setPreferences((current) => [...applyPreferenceReadBack(current, payload.preference!)]);
    } catch {
      // The row keeps the saved value it is already showing, which is the honest one.
    } finally {
      writeInFlight.current = false;
      setSaving(null);
    }
  }, []);

  const rules = useMemo(() => alertRuleViews(preferences), [preferences]);
  return { rules, saving, state, update };
}

/**
 * The coach app holds a 14px floor, so this line cannot take the console's 13px on that side. It
 * is the same sentence either way; only the size moves.
 */
function NotificationsUnavailable({
  state,
  variant,
}: {
  state: LoadState;
  variant: AccountSheetVariant;
}) {
  return (
    <p
      className={cn(
        "m-0 py-2 text-[var(--muted)]",
        variant === "owner" ? "text-[13px]" : "text-[16px]",
      )}
      data-slot="account-sheet-alerts-state"
    >
      {state === "loading" ? "Reading your notification settings" : "Your notification settings could not be read"}
    </p>
  );
}

function OwnerNotificationMatrix({
  rules,
  saving,
  state,
  onChange,
}: {
  rules: readonly AlertRuleView[];
  saving: string | null;
  state: LoadState;
  onChange(preference: Preference, enabled: boolean): void;
}) {
  if (state !== "ready" || rules.length === 0) {
    return <NotificationsUnavailable state={state} variant="owner" />;
  }

  return (
    <div data-slot="account-sheet-matrix">
      <div className="mb-1.5 flex h-[34px] items-center gap-2.5 border-b border-[var(--line)]">
        <span className="text-[13px] text-[var(--muted)]">Notifications</span>
        <LoggedPill actionKey="notification.preference.changed" />
        <div className="ml-auto flex">
          {OWNER_DESTINATIONS.map((column) => (
            <span
              className="w-11 text-center font-mono text-[10.5px] uppercase tracking-[0.06em] text-[var(--faint)]"
              key={column.destination}
            >
              {column.label}
            </span>
          ))}
        </div>
      </div>
      {rules.map((rule) => (
        <div className={OWNER_ROW} key={rule.ruleId}>
          <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ink)]">{rule.name}</span>
          {rule.required ? (
            <Pill className="px-1.5 py-px text-[11px]">Required</Pill>
          ) : null}
          <div className="flex">
            {OWNER_DESTINATIONS.map((column) => (
              <span className="flex w-11 justify-center" key={column.destination}>
                <MatrixCheckbox
                  busy={saving === `${rule.ruleId}:${column.destination}`}
                  checked={rule[column.destination].enabled}
                  columnLabel={column.label}
                  locked={rule[column.destination].locked}
                  lockedReason="Required notice"
                  onCheckedChange={(next) => onChange(rule[column.destination], next)}
                  rowLabel={rule.name}
                />
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function CoachNotificationList({
  rules,
  saving,
  state,
  onChange,
}: {
  rules: readonly AlertRuleView[];
  saving: string | null;
  state: LoadState;
  onChange(preference: Preference, enabled: boolean): void;
}) {
  const [destination, setDestination] = useState<"bell" | "email">("bell");

  return (
    <>
      <div className="flex h-[60px] flex-[0_0_60px] items-center gap-3 border-b border-[var(--line)] px-6">
        <span className={COACH_SECTION_NAME}>Notifications</span>
        <LoggedPill actionKey="notification.preference.changed" />
        <div
          aria-label="Where notices arrive"
          className="ml-auto inline-flex rounded-[10px] border border-[var(--line)] bg-[var(--card)] p-[3px]"
          role="group"
        >
          {COACH_DESTINATIONS.map((option) => (
            <button
              aria-pressed={destination === option.destination}
              className={cn(
                "inline-flex h-[38px] items-center rounded-lg px-4 text-[15px]",
                destination === option.destination
                  ? "bg-[var(--accent-wash)] font-medium text-[var(--accent-text)]"
                  : "text-[var(--muted)]",
              )}
              key={option.destination}
              onClick={() => setDestination(option.destination)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {state !== "ready" || rules.length === 0 ? (
        <div className="px-6">
          <NotificationsUnavailable state={state} variant="coach" />
        </div>
      ) : (
        rules.map((rule) => {
          const Glyph = COACH_CATEGORY_ICON[rule.category] ?? MessageSquare;
          const preference = rule[destination];
          return (
            <div className={COACH_ROW} key={rule.ruleId}>
              <Glyph
                aria-hidden="true"
                className={cn(
                  "size-[19px]",
                  rule.required ? "text-[var(--warning-text)]" : "text-[var(--accent-text)]",
                )}
                strokeWidth={1.75}
              />
              <span className="min-w-0 flex-1 truncate text-[var(--ink)]">{rule.name}</span>
              <MatrixCheckbox
                busy={saving === `${rule.ruleId}:${destination}`}
                checked={preference.enabled}
                className="min-h-[44px] gap-3 px-3 text-[16px]"
                columnLabel={COACH_DESTINATIONS.find((o) => o.destination === destination)!.label}
                locked={preference.locked}
                lockedReason="Required notice"
                onCheckedChange={(next) => onChange(preference, next)}
                rowLabel={rule.name}
              />
            </div>
          );
        })
      )}
    </>
  );
}

/* ---------------------------------------------------------------------------------------------
 * Account terms
 * ------------------------------------------------------------------------------------------- */

function displayDay(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date not recorded" : workspaceDateFormat.format(date);
}

function TermsRow({ version }: { version: AccountSheetTermsVersion }) {
  const published = version.publishedAt !== null;
  return (
    <div className="flex h-11 items-center gap-2.5 border-b border-[var(--line-soft)]">
      <FileText aria-hidden="true" className="size-[15px] text-[var(--faint)]" strokeWidth={1.75} />
      <span className="min-w-0">
        <span className="block font-mono text-[13px] font-medium text-[var(--ink)]">
          {version.versionKey}
        </span>
        <span className="block text-[12.5px] text-[var(--faint)]">
          {published ? "Published" : "Saved"} {displayDay(version.publishedAt ?? version.createdAt)}
          {" · "}
          <span className="font-mono">{version.contentHash.slice(0, 12)}</span>
        </span>
      </span>
      <span className="ml-auto">
        <Pill className="px-1.5 py-px text-[11px]">
          <StatusDot tone={published ? "good" : "grey"} />
          {published ? "Published" : "Draft"}
        </Pill>
      </span>
    </div>
  );
}

/* ---------------------------------------------------------------------------------------------
 * Support counts
 * ------------------------------------------------------------------------------------------- */

function useOpenSupportRequests(active: boolean) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();

    void (async () => {
      try {
        const response = await fetch("/api/support/threads", {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload = (await response.json()) as { threads?: unknown };
        if (!response.ok || !Array.isArray(payload.threads)) throw new Error("SUPPORT_READ_FAILED");
        if (controller.signal.aborted) return;
        const threads = payload.threads as CoachSupportThreadRead[];
        setCount(threads.filter((thread) => thread.status !== "resolved").length);
      } catch {
        // Null stays null: an unread count is not a count of zero.
      }
    })();

    return () => controller.abort();
  }, [active]);

  return count;
}

/* ---------------------------------------------------------------------------------------------
 * The sheet
 * ------------------------------------------------------------------------------------------- */

const THEME_CHOICES: ReadonlyArray<{ value: ThemePreference; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

export function AccountSheet({
  onOpenChange,
  open,
  section = null,
  terms,
  variant,
}: AccountSheetProps) {
  const isOwner = variant === "owner";
  const { account, mode } = useWorkspaceEnv();
  const initials = initialsFor(account?.fullName, isOwner ? "SF" : "ME");
  const { rules, saving, state, update } = useNotificationPreferences(open);
  const openRequests = useOpenSupportRequests(open && !isOwner);

  // Null until the stored preference has been read after paint, exactly as the topbar does it: the
  // boot script in the root layout has already painted from it, so reading during render would be
  // a second source of truth and a hydration mismatch.
  const [preference, setPreference] = useState<ThemePreference | null>(null);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setPreference(readStoredPreference()));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  /*
   * The deep link, resolved by id rather than by a ref map: the sheet is portalled to
   * `document.body`, it mounts its children only while it is open, and a ref callback that fires
   * during that mount is read here one frame later anyway. An id is the same lookup with nothing
   * to keep in step.
   */
  useEffect(() => {
    if (!open || !section) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(sectionDomId(section))?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, section]);

  function chooseTheme(next: ThemePreference) {
    setPreference(next);
    storeThemePreference(next);
    applyTheme(next === "system" ? systemTheme() : resolveTheme(next));
  }

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent
        aria-label="Account"
        className="gap-0 overflow-y-auto border-l border-[var(--line)] bg-[linear-gradient(180deg,var(--card-top),var(--card))] p-0"
        data-slot="account-sheet"
        data-variant={variant}
        showCloseButton={false}
        // Inline rather than a utility: the kit's right-side popup carries `w-3/4` and
        // `sm:max-w-sm`, both of which would have to be beaten on specificity to reach the
        // artboard's 520px. A style attribute states the width once and cannot be out-ordered.
        style={{ maxWidth: "520px", width: "100%" }}
      >
        <header
          className={cn(
            "flex flex-[0_0_auto] items-center gap-2.5 border-b border-[var(--line)]",
            isOwner ? "h-[52px] px-5" : "h-[76px] px-6",
          )}
        >
          <h2
            className={cn(
              "m-0 font-semibold text-[var(--ink)]",
              isOwner ? "text-[15px]" : "text-[19px]",
            )}
          >
            Account
          </h2>
          <button
            aria-label="Close account"
            className={cn(
              "ml-auto inline-flex items-center justify-center rounded-[10px] text-[var(--muted)]",
              isOwner ? "size-[30px]" : "size-11 bg-[var(--band)]",
            )}
            onClick={() => onOpenChange(false)}
            type="button"
          >
            <X aria-hidden="true" className={isOwner ? "size-4" : "size-[18px]"} strokeWidth={2} />
          </button>
        </header>

        <div className={cn("flex min-h-0 flex-col", isOwner ? "gap-[18px] px-5 py-[18px]" : "")}>
          {/* Account -------------------------------------------------------------------- */}
          <section
            data-section="account"
            id={sectionDomId("account")}
            className={
              isOwner
                ? "flex items-center gap-3 rounded-xl border border-[var(--line)] bg-[var(--well)] px-3.5 py-3"
                : "flex items-center gap-3.5 border-b border-[var(--line)] px-6 py-5"
            }
          >
            <span
              aria-hidden="true"
              className={cn(
                "inline-flex items-center justify-center rounded-[10px] border border-[var(--accent-edge)]",
                "bg-[var(--accent-wash)] font-mono text-[var(--accent-text)]",
                isOwner ? "size-[38px] text-[13px]" : "size-12 text-[16px]",
              )}
            >
              {initials}
            </span>
            <span className="min-w-0">
              <span
                className={cn(
                  "block truncate font-semibold tracking-[-0.01em] text-[var(--ink)]",
                  isOwner ? "text-[15px]" : "text-[17px]",
                )}
              >
                {account?.fullName ?? (isOwner ? "Platform account" : "Your account")}
              </span>
              <span
                className={cn(
                  "block truncate text-[var(--muted)]",
                  isOwner ? "text-[12.5px]" : "text-[15px]",
                )}
              >
                {account?.business ?? (isOwner ? "SetterFi platform" : "Your business")}
              </span>
            </span>
            <span className="ml-auto">
              <ExitControl mode={mode} variant={variant} />
            </span>
          </section>

          {/* Settings / Notifications --------------------------------------------------- */}
          {isOwner ? (
            <section data-section="settings" id={sectionDomId("settings")}>
              <SectionHead title="Settings" variant="owner" />
              <div className="flex h-[34px] items-center gap-2.5">
                <span className="text-[13px] text-[var(--muted)]">Theme</span>
                <div
                  aria-label="Theme"
                  className="ml-auto inline-flex rounded-lg border border-[var(--line)] bg-[var(--card)] p-0.5"
                  role="group"
                >
                  {THEME_CHOICES.map((choice) => (
                    <button
                      aria-pressed={preference === choice.value}
                      className={cn(
                        "rounded-md px-2.5 py-[5px] text-[12.5px]",
                        preference === choice.value
                          ? "bg-[var(--accent-wash)] font-medium text-[var(--accent-text)]"
                          : "text-[var(--muted)]",
                      )}
                      key={choice.value}
                      onClick={() => chooseTheme(choice.value)}
                      type="button"
                    >
                      {choice.label}
                    </button>
                  ))}
                </div>
              </div>
              <OwnerNotificationMatrix
                onChange={update}
                rules={rules}
                saving={saving}
                state={state}
              />
            </section>
          ) : (
            <section data-section="notifications" id={sectionDomId("notifications")}>
              <CoachNotificationList
                onChange={update}
                rules={rules}
                saving={saving}
                state={state}
              />
            </section>
          )}

          {/* Account terms -------------------------------------------------------------- */}
          {isOwner ? (
            <section data-section="terms" id={sectionDomId("terms")}>
              <SectionHead
                title="Account terms"
                trailing={
                  terms ? (
                    <Pill
                      className="px-1.5 py-px text-[11px]"
                      tone={terms.acceptanceLive ? "good" : "amber"}
                    >
                      <StatusDot tone={terms.acceptanceLive ? "good" : "amber"} />
                      {terms.acceptanceLive ? "Acceptance armed" : "Acceptance not armed"}
                    </Pill>
                  ) : null
                }
                variant="owner"
              />
              {terms?.readError ? (
                <p className="m-0 py-2 text-[13px] text-[var(--muted)]">{terms.readError}</p>
              ) : terms ? (
                <>
                  {terms.published ? <TermsRow version={terms.published} /> : null}
                  {terms.drafts.map((draft) => (
                    <TermsRow key={draft.versionKey} version={draft} />
                  ))}
                  {!terms.published && terms.drafts.length === 0 ? (
                    <p className="m-0 py-2 text-[13px] text-[var(--muted)]">
                      No version has been saved
                    </p>
                  ) : null}
                </>
              ) : (
                <Link
                  className="flex h-8 items-center gap-2.5 text-[13px] no-underline"
                  href="/account?section=terms"
                >
                  <span className="flex-1">Open the account terms registry</span>
                  <ChevronRight aria-hidden="true" className="size-3.5 text-[var(--faint)]" />
                </Link>
              )}
            </section>
          ) : null}

          {/* Help ----------------------------------------------------------------------- */}
          <section data-section="help" id={sectionDomId("help")}>
            {isOwner ? (
              <>
                <SectionHead
                  title="Help"
                  trailing={<MonoMeta>{ADMIN_GUIDES.length} guides</MonoMeta>}
                  variant="owner"
                />
                {ADMIN_GUIDES.slice(0, 5).map((guide) => (
                  <Link
                    className="flex h-8 items-center gap-2.5 text-[13px] no-underline"
                    href={`/admin/help?guide=${guide.id}`}
                    key={guide.id}
                  >
                    <span className="min-w-0 flex-1 truncate">{guide.title}</span>
                    <ChevronRight aria-hidden="true" className="size-3.5 text-[var(--faint)]" />
                  </Link>
                ))}
                <Link
                  className={cn(
                    "mt-2.5 flex h-8 items-center justify-center gap-2 rounded-lg",
                    "border border-[var(--line)] bg-[var(--card)] text-[13px] font-medium",
                    "text-[var(--ink)] no-underline",
                  )}
                  href="/admin/help"
                >
                  <FileText aria-hidden="true" className="size-3.5" strokeWidth={2} />
                  Operator handover package
                </Link>
              </>
            ) : (
              <>
                <SectionHead
                  title="Help"
                  trailing={
                    openRequests === null ? null : (
                      <span className="font-mono text-[14px] text-[var(--faint)]">
                        {openRequests} open
                      </span>
                    )
                  }
                  variant="coach"
                />
                <Link className={cn(COACH_ROW, "no-underline")} href="/coach/help">
                  <span className="flex-1 text-[var(--accent-text)]">Start a support request</span>
                  <ChevronRight aria-hidden="true" className="size-4 text-[var(--faint)]" />
                </Link>
                <Link className={cn(COACH_ROW, "no-underline")} href="/coach/help">
                  <span className="flex-1 text-[var(--accent-text)]">Your requests</span>
                  {openRequests === null ? null : (
                    <span className="font-mono text-[14px] text-[var(--faint)]">{openRequests}</span>
                  )}
                  <ChevronRight aria-hidden="true" className="size-4 text-[var(--faint)]" />
                </Link>
                <div className={cn(COACH_ROW, "text-[var(--faint)]")}>
                  <span className="flex-1">Operating guides</span>
                  <span className="flex items-center gap-2 text-[15px]">
                    <StatusDot tone="amber" />
                    Being written
                  </span>
                </div>
              </>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ---------------------------------------------------------------------------------------------
 * The /account mount
 * ------------------------------------------------------------------------------------------- */

export type AccountSheetRouteProps = {
  variant: AccountSheetVariant;
  /** Where closing the sheet goes, since /account is nothing but the sheet. */
  homeHref: string;
  terms?: AccountSheetTerms;
};

/**
 * `/account` is the sheet and nothing else, so closing it has to go somewhere. It goes to the
 * workspace home rather than `router.back()`: a sheet reached from a pasted link has no back entry
 * that belongs to this app, and landing on whatever tab was open before is worse than landing on a
 * page the reader recognises.
 */
export function AccountSheetRoute({ homeHref, terms, variant }: AccountSheetRouteProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(true);
  const section = accountSheetSection(variant, searchParams.get("section"));

  return (
    <AccountSheet
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) router.push(homeHref);
      }}
      open={open}
      section={section}
      terms={terms}
      variant={variant}
    />
  );
}
