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
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";

import type { Preference } from "@/app/api/notification-preferences/handler";
import { MatrixCheckbox } from "@/components/kit/matrix-checkbox";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import {
  COACH_DESTINATION_LABELS,
  destinationColumns,
  groupRulesByCategory,
  scopeQualifiers,
  type DestinationColumn,
} from "@/components/workspace/live/notification-taxonomy";
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
import { AUDIT_ACTIONS, type AuditActionKey } from "@/lib/audit/actions";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { workspaceDateFormat } from "@/lib/format/datetime";
import { displayName } from "@/lib/format/display-name";
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

/*
 * Initials come off the read name, not the stored one. A seeded person is stored as
 * "Theo Brightwell (demo)", and the raw string's first two whitespace tokens are "Theo" and
 * "Brightwell" only by luck of where the marker sits; a one-word seeded name would have produced
 * "T(" here.
 */
function initialsFor(fullName: string | null | undefined, fallback: string) {
  const tokens = displayName(fullName ?? "").split(/\s+/u).filter(Boolean).slice(0, 2);
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
   * The receipt this control used to carry is now one line at the foot of the sheet. It said the
   * true thing -- `/auth/signout` writes an `auth.signed_out` row through `writeAuthAuditEvent`
   * and refuses the sign-out outright when that write fails -- but it said it in an uppercase
   * badge beside the person's own name, which is the loudest place on the panel and the last thing
   * a reader opening their account came to find out. See `AuditNote`.
   */
  return (
    <form action="/auth/signout?next=%2Flogin" className="flex items-center gap-2" method="post">
      <button className={face} type="submit">
        <LogOut aria-hidden="true" className="size-[15px]" strokeWidth={2} />
        Sign out
      </button>
    </form>
  );
}

/* ---------------------------------------------------------------------------------------------
 * The audit line
 * ------------------------------------------------------------------------------------------- */

/**
 * What this sheet writes to the audit log, said once, quietly, at the foot.
 *
 * The hard rule is that a privileged action carries visible "Logged" microcopy, and it still does:
 * every word here is the registry's own `microcopy` for the key, so the screen cannot claim a
 * record whose words the backend does not use. What changed is where it sits and how loudly. Two
 * uppercase pills at the top of the panel spent the two most valuable rows on the sheet saying
 * something no reader opens their account to learn, and the second of them sat beside the
 * Notifications heading where the destination columns needed to be.
 *
 * The sign-out key is only listed where there is a session to end: the open and password modes end
 * nothing and write no row, so naming it there would claim a record that was never made.
 */
function AuditNote({ actions, variant }: { actions: readonly AuditActionKey[]; variant: AccountSheetVariant }) {
  if (actions.length === 0) return null;

  return (
    <footer
      className={cn(
        "flex items-start gap-2 border-t border-[var(--line)] text-[var(--faint)]",
        variant === "owner" ? "-mx-5 px-5 py-3 text-[12px]" : "px-6 py-4 text-[14px]",
      )}
      data-slot="account-sheet-audit-note"
    >
      <ShieldCheck aria-hidden="true" className="mt-px size-3.5 shrink-0" strokeWidth={1.75} />
      <p className="m-0">
        Kept in the audit log:{" "}
        {actions.map((action, index) => (
          <span data-slot={`account-sheet-audit-${action}`} key={action}>
            {index > 0 ? ", " : null}
            <span aria-label={AUDIT_ACTIONS[action].ariaLabel}>
              {AUDIT_ACTIONS[action].microcopy}
            </span>
          </span>
        ))}
        .
      </p>
    </footer>
  );
}

/* ---------------------------------------------------------------------------------------------
 * Notifications
 * ------------------------------------------------------------------------------------------- */

type LoadState = "loading" | "ready" | "error";

/** Every stored preference, keyed `${ruleId}:${destination}`. */
type PreferenceIndex = ReadonlyMap<string, Preference>;

/*
 * One glyph per seeded `alert_rules.category`.
 *
 * The keys are the column's own values. This map used to carry "channels", which the column has
 * never held: every channel rule is seeded as `channel`, so those rows all fell through to the
 * conversation glyph while the entry that was meant for them matched nothing.
 */
const CATEGORY_ICON: Record<string, typeof Bot> = {
  agent: Bot,
  billing: CreditCard,
  booking: CalendarCheck,
  brain: Sparkles,
  channel: Monitor,
  compliance: ShieldCheck,
  conversation: MessageSquare,
  onboarding: Monitor,
  safety: Shield,
};

function categoryIcon(category: string) {
  return CATEGORY_ICON[category] ?? MessageSquare;
}

/**
 * The one sentence that replaced sixteen "Required" pills and their padlocks.
 *
 * Both facts a reader needed from that repetition are here: that some notices cannot be changed,
 * and how many. Both numbers are counted off the rules on screen, so this stays true as
 * `alert_rules` grows, and a set with nothing required says nothing at all rather than printing a
 * sentence about an absence.
 */
function lockedSentence(rules: readonly AlertRuleView[]) {
  const required = rules.filter((rule) => rule.required).length;
  if (required === 0) return null;
  const noun = rules.length === 1 ? "notice" : "notices";
  const verb = required === 1 ? "is" : "are";
  return `${required} of the ${rules.length} ${noun} below ${verb} required. SetterFi fixes where a required notice arrives, so its boxes cannot be changed.`;
}

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
  /*
   * Every stored preference by rule and destination.
   *
   * The cells read from this rather than from `AlertRuleView`'s own `bell` and `email` fields,
   * which are two fixed keys: a destination the view model does not name would draw a column with
   * nothing behind it. Indexed, a column drawn from the payload is filled from the same payload,
   * and a rule with no row for that destination renders an empty cell rather than crashing.
   */
  const index = useMemo(() => {
    const byKey = new Map<string, Preference>();
    for (const item of preferences) byKey.set(`${item.ruleId}:${item.destination}`, item);
    return byKey;
  }, [preferences]);
  return { index, preferences, rules, saving, state, update };
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

/**
 * The name a row shows, and the qualifier that keeps two rows apart.
 *
 * `alert_rules` is unique on (event_key, scope), so a platform-scoped rule and its tenant-scoped
 * twin are two rules with two audiences and two sets of stored preferences. Three pairs were
 * seeded with the same `name` on both halves, and the console shows both scopes, so the matrix
 * printed what looked like one notification twice with two independent sets of boxes. The rows
 * were never duplicates. See `scopeQualifiers`.
 */
function RuleName({
  className,
  qualifier,
  rule,
  variant,
}: {
  className: string;
  qualifier: string | null;
  rule: AlertRuleView;
  variant: AccountSheetVariant;
}) {
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
      <span className={cn("min-w-0 truncate", className)}>{rule.name}</span>
      {qualifier ? (
        <span
          className={cn(
            "shrink-0 font-mono text-[var(--faint)]",
            // The coach surface holds a 14px floor; the console runs its metadata at 10.5px.
            variant === "owner" ? "text-[10.5px]" : "text-[14px]",
          )}
        >
          {qualifier}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The console matrix: a sticky column head, a section per category, and a checkbox per stored
 * destination.
 *
 * Three things about it are deliberate.
 *
 * **The columns are read off the payload.** `destinationColumns` returns the distinct destinations
 * the preferences API actually sent, in the order it sent them, so this component holds no list of
 * destinations to keep in step with the database. A destination that stops being stored stops
 * being drawn here with no edit; one that is added draws with its own label. The previous version
 * carried a literal, which is why removing Slack meant editing this file, the coach list, the
 * console table and the export columns.
 *
 * **The head sticks.** The full rule set is around forty rows inside a 520px panel, so the column
 * words used to scroll out of sight within the first section and every box below that was an
 * unlabelled square. The category band sticks under it at the head's own height.
 *
 * **A locked row is a disabled box and nothing else.** Sixteen "Required" pills and their padlocks
 * repeated one fact down the whole panel; the fact is now the sentence above the sections, said
 * once and counted.
 */
function OwnerNotificationMatrix({
  columns,
  index,
  rules,
  saving,
  state,
  onChange,
}: {
  columns: readonly DestinationColumn[];
  index: PreferenceIndex;
  rules: readonly AlertRuleView[];
  saving: string | null;
  state: LoadState;
  onChange(preference: Preference, enabled: boolean): void;
}) {
  const groups = useMemo(() => groupRulesByCategory(rules), [rules]);
  const qualifiers = useMemo(() => scopeQualifiers(rules), [rules]);
  const locked = lockedSentence(rules);

  if (state !== "ready" || rules.length === 0) {
    return <NotificationsUnavailable state={state} variant="owner" />;
  }

  return (
    <div data-slot="account-sheet-matrix">
      <div
        className={cn(
          "sticky top-0 z-20 -mx-5 flex h-[34px] items-center gap-2.5 px-5",
          "border-b border-[var(--line)] bg-[var(--card)]",
        )}
        data-slot="account-sheet-matrix-head"
      >
        <span className="text-[13px] text-[var(--muted)]">Notifications</span>
        <MonoMeta>{rules.length}</MonoMeta>
        <div className="ml-auto flex">
          {columns.map((column) => (
            <span
              className="w-11 text-center font-mono text-[10.5px] uppercase tracking-[0.06em] text-[var(--faint)]"
              key={column.destination}
            >
              {column.label}
            </span>
          ))}
        </div>
      </div>
      {locked ? (
        <p
          className="m-0 py-2 text-[12.5px] leading-[1.45] text-[var(--muted)]"
          data-slot="account-sheet-locked-note"
        >
          {locked}
        </p>
      ) : null}
      {groups.map((group) => (
        <section data-category={group.category} key={group.category}>
          <div
            className={cn(
              "sticky top-[34px] z-10 -mx-5 flex h-[26px] items-center gap-2 px-5",
              "bg-[var(--card)]",
            )}
            data-slot="account-sheet-matrix-group"
          >
            <span className={OWNER_OVERLINE}>{group.label}</span>
            <MonoMeta>{group.rules.length}</MonoMeta>
          </div>
          {group.rules.map((rule) => (
            <div className={OWNER_ROW} key={rule.ruleId}>
              <RuleName
                className="text-[13px] text-[var(--ink)]"
                qualifier={qualifiers.get(rule.ruleId) ?? null}
                rule={rule}
                variant="owner"
              />
              <div className="flex">
                {columns.map((column) => {
                  const preference = index.get(`${rule.ruleId}:${column.destination}`);
                  return (
                    <span className="flex w-11 justify-center" key={column.destination}>
                      {preference ? (
                        <MatrixCheckbox
                          busy={saving === `${rule.ruleId}:${column.destination}`}
                          checked={preference.enabled}
                          columnLabel={column.label}
                          disabled={preference.locked}
                          onCheckedChange={(next) => onChange(preference, next)}
                          rowLabel={rule.name}
                        />
                      ) : null}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

/**
 * The coach's list: one destination at a time, in sections, with the picker in the sticky head.
 *
 * A coach reads one question at a time, so this side asks "where does this arrive" for the
 * destination they picked rather than drawing a grid. The picker's options are the same
 * payload-derived columns the console matrix draws, under the coach's words for them, so this side
 * gains and loses destinations with the store exactly as the console does.
 */
function CoachNotificationList({
  columns,
  index,
  rules,
  saving,
  state,
  onChange,
}: {
  columns: readonly DestinationColumn[];
  index: PreferenceIndex;
  rules: readonly AlertRuleView[];
  saving: string | null;
  state: LoadState;
  onChange(preference: Preference, enabled: boolean): void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const groups = useMemo(() => groupRulesByCategory(rules), [rules]);
  const qualifiers = useMemo(() => scopeQualifiers(rules), [rules]);
  const locked = lockedSentence(rules);
  // The picked destination, or the first column, so the list is never asking about a destination
  // the store has stopped holding.
  const column = columns.find((option) => option.destination === picked) ?? columns[0] ?? null;

  return (
    <>
      <div
        className={cn(
          "sticky top-0 z-20 flex h-[60px] flex-[0_0_60px] items-center gap-3 px-6",
          "border-b border-[var(--line)] bg-[var(--card)]",
        )}
        data-slot="account-sheet-matrix-head"
      >
        <span className={COACH_SECTION_NAME}>Notifications</span>
        {columns.length > 0 ? (
          <div
            aria-label="Where notices arrive"
            className="ml-auto inline-flex rounded-[10px] border border-[var(--line)] bg-[var(--card)] p-[3px]"
            role="group"
          >
            {columns.map((option) => (
              <button
                aria-pressed={option.destination === column?.destination}
                className={cn(
                  "inline-flex h-[38px] items-center rounded-lg px-4 text-[15px]",
                  option.destination === column?.destination
                    ? "bg-[var(--accent-wash)] font-medium text-[var(--accent-text)]"
                    : "text-[var(--muted)]",
                )}
                key={option.destination}
                onClick={() => setPicked(option.destination)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {state !== "ready" || rules.length === 0 || !column ? (
        <div className="px-6">
          <NotificationsUnavailable state={state} variant="coach" />
        </div>
      ) : (
        <>
          {locked ? (
            <p
              className="m-0 border-b border-[var(--line-soft)] px-6 py-3 text-[15px] leading-[1.45] text-[var(--muted)]"
              data-slot="account-sheet-locked-note"
            >
              {locked}
            </p>
          ) : null}
          {groups.map((group) => (
            <section data-category={group.category} key={group.category}>
              <div
                className={cn(
                  "sticky top-[60px] z-10 flex h-[38px] items-center gap-2 px-6",
                  // 14px, not the console's 10.5px overline: the coach shell holds a 14px floor.
                  "bg-[var(--band)] text-[14px] uppercase tracking-[0.06em] text-[var(--faint)]",
                )}
                data-slot="account-sheet-matrix-group"
              >
                <span className="font-mono">{group.label}</span>
                <MonoMeta>{group.rules.length}</MonoMeta>
              </div>
              {group.rules.map((rule) => {
                const Glyph = categoryIcon(rule.category);
                const preference = index.get(`${rule.ruleId}:${column.destination}`);
                return (
                  <div className={COACH_ROW} key={rule.ruleId}>
                    <Glyph
                      aria-hidden="true"
                      className="size-[19px] shrink-0 text-[var(--accent-text)]"
                      strokeWidth={1.75}
                    />
                    <RuleName
                      className="text-[var(--ink)]"
                      qualifier={qualifiers.get(rule.ruleId) ?? null}
                      rule={rule}
                      variant="coach"
                    />
                    {preference ? (
                      <MatrixCheckbox
                        busy={saving === `${rule.ruleId}:${column.destination}`}
                        checked={preference.enabled}
                        className="min-h-[44px] gap-3 px-3 text-[16px]"
                        columnLabel={column.label}
                        disabled={preference.locked}
                        onCheckedChange={(next) => onChange(preference, next)}
                        rowLabel={rule.name}
                      />
                    ) : null}
                  </div>
                );
              })}
            </section>
          ))}
        </>
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
  const { index, preferences, rules, saving, state, update } = useNotificationPreferences(open);
  const columns = useMemo(
    () => destinationColumns(preferences, isOwner ? undefined : COACH_DESTINATION_LABELS),
    [isOwner, preferences],
  );
  const openRequests = useOpenSupportRequests(open && !isOwner);

  /*
   * The name as a person reads it, and the seeded marker it carried said once beside it.
   *
   * `scripts/fixtures/names.mjs` staples "(demo)" onto every seeded person and tenant, and this
   * panel printed the raw column: at 520px with a sign-out button and an uppercase audit badge on
   * the same line, "Theo Brightwell (demo)" truncated to "Theo Brightwell (de...", which is a name
   * cut mid-word to make room for a marker that a pill says better. Every other console surface
   * already strips it and shows a Demo pill; this one now does the same.
   *
   * The demo state is the tenant's `is_demo` column, resolved by the workspace layout. The marker
   * in the text is a fallback rather than the authority, because it is the only signal a platform
   * account has: an owner has no tenant to carry the flag, so a seeded owner would otherwise have
   * their marker stripped and nothing put in its place, which is the one thing
   * `lib/format/display-name.ts` says a stripping surface must not do.
   */
  const rawName = account?.fullName ?? null;
  const personName = rawName ? displayName(rawName) : null;
  const isDemoAccount = account?.isDemo === true
    || (rawName !== null && displayName(rawName) !== rawName.trim())
    || (account?.business != null && displayName(account.business) !== account.business.trim());

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
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    "min-w-0 truncate font-semibold tracking-[-0.01em] text-[var(--ink)]",
                    isOwner ? "text-[15px]" : "text-[17px]",
                  )}
                  data-slot="account-sheet-person"
                >
                  {personName ?? (isOwner ? "Platform account" : "Your account")}
                </span>
                {isDemoAccount ? (
                  <Pill
                    className={cn("shrink-0 px-1.5 py-px", isOwner ? "text-[11px]" : null)}
                    density={isOwner ? "owner" : "coach"}
                  >
                    Demo
                  </Pill>
                ) : null}
              </span>
              <span
                className={cn(
                  "block truncate text-[var(--muted)]",
                  isOwner ? "text-[12.5px]" : "text-[15px]",
                )}
              >
                {account?.business
                  ? displayName(account.business)
                  : (isOwner ? "SetterFi platform" : "Your business")}
              </span>
            </span>
            <span className="ml-auto shrink-0">
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
                columns={columns}
                index={index}
                onChange={update}
                rules={rules}
                saving={saving}
                state={state}
              />
            </section>
          ) : (
            <section data-section="notifications" id={sectionDomId("notifications")}>
              <CoachNotificationList
                columns={columns}
                index={index}
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

          <AuditNote
            actions={mode === "supabase"
              ? ["auth.signed_out", "notification.preference.changed"]
              : ["notification.preference.changed"]}
            variant={variant}
          />
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
