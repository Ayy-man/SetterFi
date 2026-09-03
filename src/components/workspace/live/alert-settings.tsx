"use client";

import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { Preference } from "@/app/api/notification-preferences/handler";
import { AppShell } from "@/components/kit/app-shell";
import {
  IconTile,
  KeyValueList,
  Status,
  StatusAbsent,
} from "@/components/kit/atomics";
import { Callout, type CalloutTone } from "@/components/kit/callout";
import { DataState } from "@/components/kit/data-state";
import { DataTable } from "@/components/kit/data-table";
import { DeckPanel } from "@/components/kit/deck-panel";
import {
  ArrowLeft,
  Bell,
  Bot,
  CalendarCheck,
  ChatIcon,
  Chats,
  FileText,
  Info,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkle,
} from "@/components/kit/icons";
import { MatrixCheckbox } from "@/components/kit/matrix-checkbox";
import { RecordSheet } from "@/components/kit/record-sheet";
import { ListPage } from "@/components/kit/templates/list-page";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import { workspaceNavigationFor } from "@/lib/workspace-navigation";

/*
 * The category and scope words live in one module now. This file, the coach settings page it also
 * renders, and the account sheet were each carrying their own copy of the mapping from
 * `alert_rules.category` to a heading, which is how the sheet ended up with an entry for
 * "channels", a value the column has never held.
 */
import { categoryLabel, scopeLabel } from "./notification-taxonomy";
import {
  alertRuleViews,
  applyPreferenceReadBack,
  canChangePreference,
  loadNotificationPreferences,
  type AlertRuleView,
} from "./notification-view-models";

type AlertSettingsProps = {
  affiliateAccess?: boolean;
  enabled: boolean;
  surface: "admin-alerts" | "coach-settings";
};

type Destination = "bell" | "email";

/**
 * What the last write actually did. A write that came back from the server and a write we could
 * not confirm are different facts, so they get different tones rather than one grey line of prose
 * that reads the same either way.
 */
type WriteFeedback = { tone: CalloutTone; title: string; body: string };

const WRITE_FEEDBACK = {
  refused: {
    tone: "critical",
    title: "Preference not changed",
    body: "This preference was not changed. The saved setting is still shown.",
  },
  saved: {
    tone: "good",
    title: "Preference saved",
    body: "Saved after the stored preference was read back.",
  },
  unconfirmed: {
    tone: "critical",
    title: "Change not confirmed",
    body: "We could not confirm this change. Reload to read the saved preference before trying again.",
  },
} as const satisfies Record<string, WriteFeedback>;

// "Platform" is a nav group rather than a page, and its first item is Audit, so linking the crumb
// would send the reader out of the group they are standing in. It stays plain text.
const ADMIN_CRUMBS = [{ label: "Platform" }, { label: "Notifications" }] as const;

const SCOPE_FACET_OPTIONS = [
  { label: "Platform", value: "Platform" },
  { label: "Client account", value: "Client account" },
] as const;

const COACH_CRUMBS = [
  { label: "Account" },
  { label: "Notification settings" },
] as const;

const DESTINATION_LABELS: Record<Destination, string> = {
  bell: "Bell",
  email: "Email",
};

/*
 * The coach half of this file, written at the coach surface's scale rather than the console's.
 *
 * Everything below the `COACH_` prefix exists because `alert-settings.tsx` renders two products
 * out of one component. The owner console is a permission matrix for somebody who lives in it all
 * day: 13px body, 26-34px controls, a nine-and-a-half-pixel uppercase overline over every group.
 * The coach side is for credit coaches over 55 who told us in round-1 demo feedback that they
 * could not read that, so `coach.css` raises the shell to 16px body and a 44px pressable floor,
 * and the canvas draws the page as deck panels with a 46px title. None of that reaches a class
 * whose size is an absolute pixel value, which is why these recipes are written out here instead
 * of being inherited: they are the same roles the kit owns, at the other density, and every one
 * of them is a token reference rather than a re-picked colour.
 *
 * They are local to this file on purpose. Redefining the kit's roles under
 * `[data-shell-role="coach"]` would move every coach surface in the product at once, including
 * the ones other lanes are porting in parallel, and the admin branch of this very component has
 * to render byte-identically after this change.
 */
const COACH_LEAD_CLASS =
  "m-0 max-w-[var(--measure-prose)] text-[17px] leading-[1.5] text-[color:var(--muted)]";
const COACH_PANEL_SUB_CLASS =
  "m-0 max-w-[var(--measure-prose)] text-[length:var(--coach-body)] leading-[1.5] text-[color:var(--muted)]";
const COACH_GROUP_TITLE_CLASS =
  "m-0 text-[18px] leading-[1.3] font-medium text-[color:var(--ink)]";
const COACH_ROW_TITLE_CLASS = "text-[17px] leading-[1.35] font-medium text-[color:var(--ink)]";
const COACH_SENTENCE_CLASS =
  "m-0 max-w-[var(--measure-prose)] text-[length:var(--coach-body)] leading-[1.5] text-[color:var(--body)]";
const COACH_FOOTNOTE_CLASS =
  "m-0 max-w-[var(--measure-prose)] text-[15px] leading-[1.5] text-[color:var(--muted)]";
/*
 * A counted fact said inside a sentence. Mono with tabular numerals so "0 by email" and "6 by
 * email" occupy the same width and a reader scanning the groups can compare them down the column
 * rather than re-reading each line.
 */
const COACH_MONO_CLASS =
  "font-[family-name:var(--font-mono)] font-medium text-[color:var(--ink)] [font-variant-numeric:tabular-nums_lining-nums]";
const COACH_SUMMARY_CLASS =
  "m-0 font-[family-name:var(--font-mono)] text-[14px] leading-[1.4] text-[color:var(--muted)] [font-variant-numeric:tabular-nums_lining-nums]";
/* A well, not a card: `.coach-panel` is the only card shape here and a card inside a card is out. */
const COACH_WELL_CLASS =
  "flex min-w-0 flex-col gap-[var(--s-3)] rounded-[14px] border border-[var(--line)] bg-[var(--well)] p-[18px]";
const COACH_DELIVERY_NAME_CLASS =
  "m-0 text-[22px] leading-[1.2] font-medium tracking-[-0.02em] text-[color:var(--ink)]";
/* The kit's pill is 11.5px, which is the exact size the demo feedback was about. */
const COACH_PILL_CLASS = "text-[14px] py-[6px] pr-[12px] pl-[10px]";
/*
 * The kit's `MatrixCheckbox` is sized for a table cell -- `--t-body` is 13px and its box is a
 * 26px target. Coach controls have a 44px floor and a 16px label, and the component takes a
 * className precisely so a surface can say so without the kit growing a second size.
 */
const COACH_CHECKBOX_CLASS =
  "min-h-[var(--coach-target)] gap-[var(--s-3)] px-[var(--s-3)] text-[length:var(--coach-body)]";

/**
 * What a coach calls each destination, and what it looks like.
 *
 * "Bell" is the console's word for a column in a matrix; on this side the same destination is
 * "In the app", because the coach's question is where a notice turns up rather than which row of
 * `notification_preferences` it writes. The admin branch keeps `DESTINATION_LABELS` untouched, so
 * its column headers and its "Email for Appointment booked" accessible names do not move.
 *
 * There is deliberately no "Text message" here. `notification_preferences.destination` is
 * `bell | email`; there is no column an SMS preference could be written to, so the
 * artboard's third card would have been a control over nothing. Nor is there a carrier-review day
 * counter: this page loads notification rules and nothing else, so it holds no provisioning date
 * to count elapsed days from, and a counter invented here would be exactly the predicted number
 * the honest-states rule exists to forbid.
 */
const COACH_DESTINATIONS = [
  {
    destination: "bell" as const,
    glyph: <Bell />,
    label: "In the app",
    /** Reads after the count: "4 of the 16 notices appear here in your bell." */
    tail: "appear here in your bell.",
  },
  {
    destination: "email" as const,
    glyph: <Send />,
    label: "Email",
    tail: "arrive by email.",
  },
];

const NOTIFICATION_EXPORT_COLUMNS = [
  "event",
  "scope",
  "bell",
  "email",
  "required",
] as const;

function destinationState(preference: Preference) {
  return preference.enabled ? "On" : "Off";
}

/**
 * What a category is about, in one line, for the section header.
 *
 * Each sentence is a claim about the category rather than about which rules happen to be in it,
 * because the rule set is a database table that grows. A blurb naming a specific notice would
 * quietly become a lie the first time that notice was retired.
 */
const CATEGORY_BLURBS: Record<string, string> = {
  agent: "Changes to your setter itself.",
  billing: "Charges, invoices and plan changes on your account.",
  booking: "Anything that happens to a call on your calendar.",
  brain: "Changes to The Brain your setter answers from.",
  channel: "Messages your setter could not send, and why.",
  compliance: "Consent and opt-out records.",
  conversation: "Threads your setter has handed to a person.",
  onboarding: "How your setup is going, and who it is waiting on.",
  safety: "Times your setter stopped a conversation and pulled you in.",
};

/**
 * The category seeded demo rules sit in.
 *
 * The route hides `demo` rules from coaches and deliberately leaves admins unfiltered, because
 * hiding the row from the only people who can delete it is how it survives. That leaves the admin
 * table printing a seeded rule beside sixteen real ones with nothing saying which is which, and
 * unlabelled test data on a live screen is a hard rule broken. The table says so instead.
 */
const SEEDED_CATEGORY = "demo";

const CATEGORY_ICONS: Record<string, typeof Info> = {
  agent: Bot,
  billing: FileText,
  brain: Sparkle,
  booking: CalendarCheck,
  channel: ChatIcon,
  compliance: ShieldCheck,
  conversation: Chats,
  onboarding: ShieldCheck,
  safety: ShieldAlert,
};

/**
 * The row's one-line consequence when the rule carries no authored sentence of its own.
 *
 * `alert_rules.description` is `not null`, so this should not fire in practice, but a row with a
 * blank description would otherwise draw an empty line exactly where the reader looks for the
 * consequence. Each phrasing names both destinations rather than saying "nothing is sent".
 */
function deliveryConsequence(rule: AlertRuleView) {
  const bell = rule.bell.enabled;
  const email = rule.email.enabled;
  if (bell && email) return "Appears here in the app and arrives by email.";
  if (bell) return "Appears here in the app, not by email.";
  if (email) return "Arrives by email, not here in the app.";
  return "Not shown in the app and not sent by email.";
}

/**
 * Whether the coach has moved this notice off the delivery SetterFi chose for it. The route builds
 * each preference's default from `default_destinations`, so the same comparison is what "the coach
 * touched this" means on the server.
 */
/**
 * What the row says under its name: the sentence the platform authored for this rule, and the
 * derived delivery line only when there is no authored one. `rowDescription` never returns an empty
 * string, so `SettingRow` can render its description slot unconditionally.
 */
function rowDescription(rule: AlertRuleView) {
  const authored = rule.description.trim();
  return authored === "" ? deliveryConsequence(rule) : authored;
}

function coachOwned(rule: AlertRuleView) {
  return (["bell", "email"] as const).some(
    (destination) =>
      rule[destination].enabled !== rule[destination].defaultDestinations.includes(destination),
  );
}

const plural = (count: number, singular: string, many: string) => (count === 1 ? singular : many);

/**
 * What a group of notices says under its name, in mono: the delivery it currently holds.
 *
 * Every number here is counted off the group's own rules, so a group with nothing reaching email
 * reads `0 by email` rather than dropping the word. A summary that can express "some" but not
 * "none" leaves the reader to check every row to find out, which is the scroll the summary exists
 * to remove -- and on the coach side the rows are all open, so the summary is the only place that
 * measured zero can be said at a glance.
 */
function sectionSummary(rules: readonly AlertRuleView[]) {
  const bell = rules.filter((rule) => rule.bell.enabled).length;
  const email = rules.filter((rule) => rule.email.enabled).length;
  const owned = rules.filter(coachOwned).length;
  const parts = [`${bell} in the app`, `${email} by email`];
  if (owned > 0) parts.push(`${owned} you changed`);
  return parts.join(" \u00b7 ");
}

/**
 * The section header's sentence: what the group is about, plus the one derived fact the reader
 * cannot get from the summary -- that some of these cannot be switched off.
 */
function sectionDescription(category: string, rules: readonly AlertRuleView[]) {
  const blurb = CATEGORY_BLURBS[category]
    ?? `${rules.length} ${plural(rules.length, "notice", "notices")} in this group.`;
  const required = rules.filter((rule) => rule.required).length;
  if (required === 0) return blurb;
  if (required === rules.length) {
    return required === 1
      ? `${blurb} This one is required and stays on.`
      : `${blurb} All ${required} are required and stay on.`;
  }
  return `${blurb} ${required} of the ${rules.length} ${plural(required, "is", "are")} required and ${plural(required, "stays", "stay")} on.`;
}

function categoryGlyph(category: string) {
  const Glyph = CATEGORY_ICONS[category] ?? Info;
  return <Glyph />;
}

/**
 * One destination cell, in both layouts.
 *
 * The kit's `MatrixCheckbox` carries the full "<destination> for <rule>" accessible name in a
 * hidden span and shows the column word only where there is no column header to say it, so the
 * admin table stops printing "Bell" under BELL on every one of its rows while a screen reader
 * still hears the whole pairing. A locked row shows a padlock, because a disabled-on box and a
 * disabled-off box read the same without one.
 */
function DestinationCell({
  destination,
  preference,
  saving,
  showColumnLabel = false,
  writesDisabled,
  onChange,
}: {
  destination: Destination;
  preference: Preference;
  saving: boolean;
  showColumnLabel?: boolean;
  writesDisabled: boolean;
  onChange(preference: Preference, enabled: boolean): void;
}) {
  return (
    <MatrixCheckbox
      busy={saving}
      checked={preference.enabled}
      columnLabel={DESTINATION_LABELS[destination]}
      disabled={writesDisabled}
      locked={preference.locked}
      lockedReason="Required notice"
      onCheckedChange={(nextChecked) => onChange(preference, nextChecked)}
      rowLabel={preference.name}
      showColumnLabel={showColumnLabel}
    />
  );
}

/**
 * Whether the rule can be switched off at all.
 *
 * A required notice gets a pill; an optional one gets an em-rule, not an "Optional" pill. An
 * absence expressed as a pill is a state the reader has to weigh against the real ones, and a
 * column of "Optional" lozenges out-weighs the handful of rows that genuinely cannot be changed.
 */
function RequiredState({ rule }: { rule: AlertRuleView }) {
  return rule.required
    ? <Status dot={false} label="Required" tone="neutral" />
    : <StatusAbsent label="Can be switched off" />;
}

/**
 * The mark on a rule that was seeded rather than authored. `draft` is the non-production tone, so
 * a reader can tell at a glance that this row is not part of the live notification set.
 */
function SeededMark() {
  return <Status label="Test data" tone="draft" />;
}

function RuleSummary({ rule }: { rule: AlertRuleView }) {
  return (
    <KeyValueList
      rows={(["bell", "email"] as const).map((destination) => ({
        label: DESTINATION_LABELS[destination],
        value: destinationState(rule[destination]),
      }))}
    />
  );
}

/**
 * The page head, at the coach side's scale rather than the console's.
 *
 * A local head rather than `PageHeader` for the same reason `LeadsSurface` writes its own: the kit
 * header sets its title with `.t-page-title`, which is the console's 20px, and no prop moves it.
 * The canvas draws every coach page at `--coach-page-title` -- 46px -- and that size is not
 * decoration, it is the first thing a reader over 55 sees. The crumbs are not repeated here
 * because `AppShell` already renders them above from its own `crumbs` prop.
 */
function CoachSettingsHead() {
  return (
    <header className="flex min-w-0 flex-col gap-[var(--s-4)]" data-page-head="coach-settings">
      {/*
        The way back, as the artboard draws it: a bordered chip rather than the bare text link
        Setup and Tips use, because this page is reached from the account menu and the topbar bell,
        neither of which leaves a trail on the page.

        It says "Back to Home", not the artboard's "Settings". The artboard's chip points at a
        settings hub that does not exist -- this page IS the coach's settings -- so a chip labelled
        Settings would either lead here, to itself, or name a destination the product does not
        have. Home is where the coach actually came from and is what the shipped nav calls it.
      */}
      <Link
        className="inline-flex h-[44px] w-fit items-center gap-[10px] rounded-[10px] border border-[var(--line)] bg-[var(--well)] px-[16px] pl-[12px] text-[16px] leading-none font-medium text-[color:var(--body)] no-underline hover:border-[var(--accent-edge)] hover:text-[color:var(--ink)]"
        data-slot="coach-settings-back"
        href="/coach/home"
      >
        <ArrowLeft aria-hidden size={18} strokeWidth={1.75} />
        Back to Home
      </Link>
      <div className="flex min-w-0 flex-col gap-[var(--s-2)]">
        {/*
          The question is the page, not a panel name. The artboard puts "Where should we tell you?"
          at 46px because it is the thing the coach came here to answer; it was a heading four
          panels down while the h1 said "Settings", which is the name of the box rather than the
          question inside it.
        */}
        <h1 className="coach-page-title m-0">Where should we tell you?</h1>
        <p className={COACH_LEAD_CLASS}>
          Every notice below says where it arrives, and you choose that one notice at a time.
        </p>
      </div>
    </header>
  );
}

/**
 * One destination, stated rather than offered.
 *
 * The artboard draws these three as a pick-one control, and that is the one thing this page cannot
 * honestly be: the preference this component writes is per notice and per destination -- one row
 * of `notification_preferences` for each pairing -- so there is no single account-level
 * destination a card could set. Turning the cards into a bulk write over every rule would invent a
 * setting the API does not have and would silently overwrite choices the coach had already made
 * further down the page.
 *
 * So a card says what is true right now, counted off the rules underneath it, and the choosing
 * stays in the rows where the stored value actually lives. The count is mono for the same reason
 * every other figure on the coach side is: two cards side by side are meant to be compared.
 */
function CoachDeliveryCard({
  destination,
  glyph,
  label,
  on,
  tail,
  total,
}: {
  destination: Destination;
  glyph: ReactNode;
  label: string;
  on: number;
  tail: string;
  total: number;
}) {
  const inUse = on > 0;
  return (
    <div className={COACH_WELL_CLASS} data-destination={destination} data-slot="coach-delivery-card">
      <div className="flex items-start justify-between gap-[var(--s-3)]">
        <IconTile size="lg" tone={inUse ? "accent" : "neutral"}>{glyph}</IconTile>
        <Status
          className={COACH_PILL_CLASS}
          label={inUse ? "In use" : "Not in use"}
          tone={inUse ? "good" : "neutral"}
        />
      </div>
      <div className="flex min-w-0 flex-col gap-[6px]">
        <p className={COACH_DELIVERY_NAME_CLASS}>{label}</p>
        <p className={COACH_SENTENCE_CLASS}>
          <span className={COACH_MONO_CLASS}>{on}</span>
          {` of the ${total} ${plural(total, "notice", "notices")} ${tail}`}
        </p>
      </div>
    </div>
  );
}

/**
 * One notice, in the artboard's sentence-per-row shape.
 *
 * The three parts stack rather than sharing a line, and that is a decision rather than a default.
 * The inbox shipped a row that put a 17px name and a shrink-0 mono clock on one flex line inside a
 * 324px column, and every lead on the screen rendered as "Jo...", "M...", "La..." -- `truncate` is
 * invisible to jsdom, so nothing went red. At coach scale the name is 17px, the sentence is 16px
 * and the two controls carry visible words, so anything that shared a line here would hit the same
 * wall on the first narrow viewport. Name, then sentence, then controls, each on its own line.
 *
 * The tile is the one place accent is spent in the rows: it takes the accent pair only where the
 * coach has moved this notice off the delivery SetterFi chose for it, so teal means "you changed
 * this" instead of decorating all sixteen rows.
 */
function CoachNoticeRow({
  onChange,
  rule,
  saving,
  writesDisabled,
}: {
  onChange(preference: Preference, enabled: boolean): void;
  rule: AlertRuleView;
  saving: string | null;
  writesDisabled: boolean;
}) {
  return (
    <li
      className="flex min-w-0 gap-[var(--s-3)] border-t border-[var(--line-soft)] pt-[var(--s-4)] first:border-t-0 first:pt-0"
      data-slot="coach-notice-row"
    >
      <IconTile
        className="mt-[3px]"
        size="lg"
        tone={coachOwned(rule) ? "accent" : "neutral"}
      >
        {categoryGlyph(rule.category)}
      </IconTile>
      <div className="flex min-w-0 flex-1 flex-col gap-[6px]">
        <span className="flex flex-wrap items-center gap-[var(--s-2)]">
          <span className={COACH_ROW_TITLE_CLASS}>{rule.name}</span>
          {rule.required ? (
            <Status className={COACH_PILL_CLASS} dot={false} label="Required" tone="neutral" />
          ) : null}
        </span>
        <p className={COACH_SENTENCE_CLASS} data-slot="coach-notice-sentence">
          {rowDescription(rule)}
        </p>
        <div
          className="mt-[2px] flex flex-wrap items-center gap-[var(--s-2)]"
          data-slot="coach-notice-controls"
        >
          {COACH_DESTINATIONS.map(({ destination, label }) => (
            <MatrixCheckbox
              busy={saving === `${rule.ruleId}:${destination}`}
              checked={rule[destination].enabled}
              className={COACH_CHECKBOX_CLASS}
              columnLabel={label}
              disabled={writesDisabled}
              key={destination}
              locked={rule[destination].locked}
              lockedReason="Required notice"
              onCheckedChange={(nextChecked) => onChange(rule[destination], nextChecked)}
              rowLabel={rule.name}
              showColumnLabel
            />
          ))}
        </div>
      </div>
    </li>
  );
}

export function AlertSettings({
  affiliateAccess = false,
  enabled,
  surface,
}: AlertSettingsProps) {
  const [preferences, setPreferences] = useState<Preference[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [reloadCount, setReloadCount] = useState(0);
  const [saving, setSaving] = useState<string | null>(null);
  const writeInFlight = useRef(false);
  const [feedback, setFeedback] = useState<WriteFeedback | null>(null);
  const [selectedRuleId, setSelectedRuleId] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();

    void loadNotificationPreferences(
      enabled,
      controller.signal,
      fetchWithTimeout,
    ).then((result) => {
      if (controller.signal.aborted) return;
      if (result.kind === "ready") {
        setPreferences(result.preferences);
        setState("ready");
      } else if (result.kind === "error") {
        setState("error");
      }
    }).catch(() => {
      if (!controller.signal.aborted) setState("error");
    });

    return () => controller.abort();
  }, [enabled, reloadCount]);

  const rules = useMemo(() => alertRuleViews(preferences), [preferences]);
  // Grouped in the order the categories first appear, so the sections follow the server's own
  // ordering rather than an alphabet nobody asked for. Every count on the surface comes off one of
  // these lists, never a literal.
  const ruleGroups = useMemo(() => {
    const groups = new Map<string, AlertRuleView[]>();
    for (const rule of rules) {
      const current = groups.get(rule.category);
      if (current) current.push(rule);
      else groups.set(rule.category, [rule]);
    }
    return [...groups].map(([category, categoryRules]) => ({ category, rules: categoryRules }));
  }, [rules]);
  const requiredRules = useMemo(() => rules.filter((rule) => rule.required), [rules]);
  const selectedRule = useMemo(
    () => rules.find((rule) => rule.ruleId === selectedRuleId) ?? null,
    [rules, selectedRuleId],
  );

  function retryLoad() {
    setState("loading");
    setFeedback(null);
    setReloadCount((current) => current + 1);
  }

  async function updatePreference(preference: Preference, nextEnabled: boolean) {
    if (writeInFlight.current || !canChangePreference(preference, nextEnabled)) return;
    const key = `${preference.ruleId}:${preference.destination}`;
    writeInFlight.current = true;
    setSaving(key);
    setFeedback(null);

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
      if (!response.ok) {
        setFeedback(WRITE_FEEDBACK.refused);
        return;
      }
      const payload = await response.json() as {
        preference?: Pick<Preference, "ruleId" | "destination" | "enabled" | "locked">;
      };
      if (!payload.preference) throw new Error("PREFERENCE_READ_BACK_MISSING");
      const persistedPreference = payload.preference;
      setPreferences((current) => [...applyPreferenceReadBack(current, persistedPreference)]);
      setFeedback(WRITE_FEEDBACK.saved);
    } catch {
      setFeedback(WRITE_FEEDBACK.unconfirmed);
    } finally {
      writeInFlight.current = false;
      setSaving(null);
    }
  }

  const adminColumns = useMemo<ColumnDef<AlertRuleView>[]>(() => [
    {
      accessorKey: "name",
      header: "Notification",
      meta: { cellKind: "identity", label: "Notification" },
      // A seeded rule is named beside its own row, not in a legend elsewhere on the page: an
      // admin scanning seventeen rows for the one that is not real has to see it in the row.
      cell: ({ row }) => (
        <span className="flex min-w-0 flex-wrap items-center gap-[var(--s-2)]">
          <span className="min-w-0 truncate">{row.original.name}</span>
          {row.original.category === SEEDED_CATEGORY ? <SeededMark /> : null}
        </span>
      ),
    },
    {
      id: "scope",
      accessorFn: (rule) => scopeLabel(rule.scope),
      filterFn: "arrIncludesSome",
      header: "Scope",
      meta: { cellKind: "secondary", defaultHidden: true, label: "Scope" },
    },
    ...(["bell", "email"] as const).map((destination): ColumnDef<AlertRuleView> => ({
      id: destination,
      enableSorting: false,
      header: DESTINATION_LABELS[destination],
      meta: { label: DESTINATION_LABELS[destination] },
      cell: ({ row }) => (
        <DestinationCell
          destination={destination}
          onChange={updatePreference}
          preference={row.original[destination]}
          saving={saving === `${row.original.ruleId}:${destination}`}
          writesDisabled={saving !== null}
        />
      ),
    })),
    {
      id: "required",
      header: "Control",
      cell: ({ row }) => <RequiredState rule={row.original} />,
      meta: { cellKind: "state", label: "Control" },
    },
  ], [saving]);

  const role = surface === "admin-alerts" ? "admin" : "coach";
  const isAdmin = surface === "admin-alerts";
  const activePath = isAdmin ? "/admin/alerts" : "/coach/settings";
  const crumbs = isAdmin ? ADMIN_CRUMBS : COACH_CRUMBS;
  // The console's own head. The coach side has `CoachSettingsHead` instead, because the kit header
  // sets its title at the console's 20px and the coach canvas draws a page title at 46px.
  const title = "Notifications";
  const description = "Choose where platform notices are delivered.";
  const navigation = [
    ...workspaceNavigationFor(role),
    ...(surface === "coach-settings" && affiliateAccess
      ? workspaceNavigationFor("affiliate")
      : []),
  ];

  // The three non-row states read the same on both surfaces; only the rows differ.
  const blockingState = !enabled ? (
    <DataState
      body="Notification preferences are not enabled in this environment."
      kind="unavailable"
      title="Notification preferences are not enabled"
    />
  ) : state === "loading" ? (
    <DataState kind="loading" rows={4} />
  ) : state === "error" ? (
    <DataState
      body="Notification preferences could not be read."
      kind="unavailable"
      retry={retryLoad}
      title="Notification preferences unavailable"
    />
  ) : null;

  // One node for both surfaces. The coach page used to render its own copy of this box, so the
  // same write reported itself in two different shapes depending on who was reading it.
  const feedbackNote = feedback ? (
    <div className="max-w-[var(--measure-prose)]" role="status">
      <Callout body={feedback.body} title={feedback.title} tone={feedback.tone} />
    </div>
  ) : null;

  const emptyRules = (
    <DataState
      body="Available notification rules will appear here after they are added to this account."
      kind="empty"
      title="No notification preferences"
    />
  );

  return (
    <AppShell
      activePath={activePath}
      crumbs={crumbs}
      nav={navigation}
      role={role}
    >
      {isAdmin ? (
        <ListPage
          description={description}
          provenance="A change is saved once it comes back from the server."
          title={title}
        >
          <div className="flex min-h-0 min-w-0 flex-col gap-[var(--s-3)]">
            {feedbackNote}
            {blockingState ?? (
              <DataTable
                ariaLabel="Notification rules"
                columns={adminColumns}
                data={rules}
                emptyState={emptyRules}
                exportResource={{
                  filename: "setterfi-notification-rules",
                  mode: "server",
                  query: {
                    columns: [...NOTIFICATION_EXPORT_COLUMNS],
                    order: "event_asc",
                    reason: "Notification rule export from Admin Notifications",
                  },
                  resource: "notification-rules",
                }}
                facets={[{
                  columnId: "scope",
                  options: [...SCOPE_FACET_OPTIONS],
                  title: "Scope",
                }]}
                getRowId={(rule) => rule.ruleId}
                onRowOpen={(rule) => setSelectedRuleId(rule.ruleId)}
                rowLabel={{ singular: "notification rule", plural: "notification rules" }}
                search={{ columnId: "name", placeholder: "Search notifications" }}
              />
            )}
          </div>
        </ListPage>
      ) : (
        <>
          <CoachSettingsHead />

          {blockingState}

          {blockingState === null && rules.length === 0 ? emptyRules : null}

          {blockingState === null && rules.length > 0 ? (
            <div className="grid min-w-0 gap-[var(--s-4)]">
              {feedbackNote}

              {/*
                * The canvas's first panel, with the destinations the store can actually hold. The
                * artboard offers three -- email, text message, both -- and two of those would be
                * controls over nothing: `notification_preferences.destination` is
                * `bell | email`, so there is no column an SMS preference writes to, and
                * nothing on this page carries a carrier-review start date to count elapsed days
                * from. See `COACH_DESTINATIONS` for the full argument.
                */}
              <DeckPanel
                eyebrow="Delivery"
                headingId="coach-settings-delivery"
                name="Where each notice arrives"
                sentence={
                  <>
                    Two places, and each notice below says which of them it uses. There is nothing
                    to set here; these count what the notices are doing right now.
                  </>
                }
              >
                <div className="mt-[var(--s-4)] grid min-w-0 gap-[var(--s-3)] sm:grid-cols-2">
                  {COACH_DESTINATIONS.map((entry) => (
                    <CoachDeliveryCard
                      destination={entry.destination}
                      glyph={entry.glyph}
                      key={entry.destination}
                      label={entry.label}
                      on={rules.filter((rule) => rule[entry.destination].enabled).length}
                      tail={entry.tail}
                      total={rules.length}
                    />
                  ))}
                </div>
              </DeckPanel>

              {/*
                * The canvas's second panel: statements, not a control panel. Its lead sentence is
                * counted rather than written, because the artboard's "four things, and only these
                * four" is a claim about a database table that grows -- `alert_rules` is seeded and
                * edited by the client's own team, and the sentence has to stay true the day a
                * seventeenth rule lands.
                */}
              <DeckPanel
                eyebrow="Notices"
                footer={
                  <p className={COACH_FOOTNOTE_CLASS}>
                    There is no Save on this page. Each box saves the moment you tick it, once the
                    stored setting comes back from us, and takes effect on the next thing we send.
                  </p>
                }
                headingId="coach-settings-notices"
                name="What we tell you about"
                sentence={
                  <>
                    {`${rules.length} ${plural(rules.length, "notice", "notices")}, and only these; we do not send anything else. `}
                    {requiredRules.length === 0
                      ? "You choose where each one arrives."
                      : `${requiredRules.length} of them ${plural(requiredRules.length, "is", "are")} required and ${plural(requiredRules.length, "stays", "stay")} on; you choose where the rest arrive.`}
                  </>
                }
              >
                <div className="mt-[var(--s-4)] grid min-w-0 gap-[var(--s-5)]">
                  {ruleGroups.map((group) => {
                    const headingId = `notice-group-${group.category}`;
                    return (
                      <section
                        aria-labelledby={headingId}
                        className="min-w-0"
                        data-slot="coach-notice-group"
                        key={group.category}
                      >
                        <h3 className={COACH_GROUP_TITLE_CLASS} id={headingId}>
                          {categoryLabel(group.category)}
                        </h3>
                        <p className={`${COACH_PANEL_SUB_CLASS} mt-[4px]`}>
                          {sectionDescription(group.category, group.rules)}
                        </p>
                        <p
                          className={`${COACH_SUMMARY_CLASS} mt-[6px]`}
                          data-slot="coach-notice-group-summary"
                        >
                          {sectionSummary(group.rules)}
                        </p>
                        <ul className="mt-[var(--s-4)] grid min-w-0 list-none gap-[var(--s-4)] p-0">
                          {group.rules.map((rule) => (
                            <CoachNoticeRow
                              key={rule.ruleId}
                              onChange={updatePreference}
                              rule={rule}
                              saving={saving}
                              writesDisabled={saving !== null}
                            />
                          ))}
                        </ul>
                      </section>
                    );
                  })}
                </div>
              </DeckPanel>
            </div>
          ) : null}
        </>
      )}

      <RecordSheet
        onOpenChange={(open) => {
          if (!open) setSelectedRuleId(null);
        }}
        open={isAdmin && Boolean(selectedRule)}
        sections={selectedRule ? [
          {
            title: "Rule",
            body: (
              <div className="flex flex-wrap items-center gap-[var(--s-2)]">
                <span className="text-[var(--body)]">{scopeLabel(selectedRule.scope)}</span>
                <RequiredState rule={selectedRule} />
              </div>
            ),
          },
          {
            title: "Delivery",
            body: <RuleSummary rule={selectedRule} />,
          },
        ] : []}
        subtitle="Saved notification rule"
        technical={selectedRule ? [
          { label: "Rule ID", value: selectedRule.ruleId },
          { label: "Event key", value: selectedRule.event },
          { label: "Scope", value: selectedRule.scope },
          { label: "Category", value: selectedRule.category },
          { label: "Audience", value: selectedRule.audience || "Not configured" },
        ] : undefined}
        title={selectedRule?.name ?? "Notification rule"}
      />
    </AppShell>
  );
}
