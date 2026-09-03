"use client";

/**
 * `/coach/agent`, drawn as the vertical ladder of `CoachAgent.body.html` with the connection
 * cards of `CoachConnections.body.html` behind a segmented tab on the same route.
 *
 * The ladder is the argument: a coach reads their setter top to bottom in the order a lead meets
 * it -- the keyword that starts it, the resource it sends, what it asks, how it grades the answer,
 * the call it books, the message after. Every rung writes to storage that already exists, and the
 * two rungs the artboard draws against storage that does not exist are drawn as statements of what
 * SetterFi does instead of as controls that would promise a setting nobody can save. Those are
 * named in the header comment of each rung.
 *
 * Nothing here queries. The offer layer arrives as `initialState` from the page, the connection
 * surface arrives as `connections`, and keyword goals load from the same
 * `/api/coach/keyword-goals` route `coach-keyword-goals.tsx` reads -- the tenant-scoped loader
 * that already exists for them, not a new one.
 */

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { AUDIT_ACTIONS } from "@/lib/audit/actions";
import { DayCounter } from "@/components/kit/day-counter";
import { ArrowDown, ArrowUp, ShieldCheck } from "@/components/kit/icons";
import { ExportMenu } from "@/components/kit/export-menu";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import { LoggedButton } from "@/components/kit/logged-button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { COACH_EYEBROW_CLASS } from "@/components/workspace/live/coach-type";
import {
  coachCadenceExportRows,
  coachCadenceSchedule,
  type CoachCadenceChannel,
  type CoachCadenceScheduleClass,
} from "@/components/workspace/live/coach-agent";
import {
  savedDraftView,
  type CoachOfferInitialState,
} from "@/components/workspace/live/offer-view-models";
import { humanError } from "@/lib/copy/errors";
import { money } from "@/lib/format/metric";
import { DURABLE_TOUCHES } from "@/lib/followups/touch-lists";
import { CARRIER_TYPICAL_DAYS } from "@/lib/onboarding/contracts";
import {
  OFFER_CADENCE_CHANNEL_LABELS,
  OFFER_CADENCE_PURPOSE_LABELS,
  OFFER_CADENCE_PURPOSES,
  type CoachCadencePurposeInput,
  type CoachOfferDraftInput,
  type OfferCadencePurpose,
  type PersistedOfferLayer,
} from "@/lib/offer/types";
import type { CoachQuestion } from "@/lib/repositories/coach-questions";
import type { KeywordGoal, KeywordGoalMode } from "@/lib/repositories/keyword-goals";

/* ------------------------------------------------------------------ *
 * Props
 * ------------------------------------------------------------------ */

/** One channel or calendar card on the Connections tab, already reduced to what it draws. */
export type RehaulConnectionCard = {
  key: string;
  /** "Instagram", "Messenger", "WhatsApp", "SMS", "Google Calendar". Never a vendor of ours. */
  label: string;
  eyebrow: string;
  tone: "good" | "amber" | "grey";
  stateLabel: string;
  /** One sentence naming the receipt the state is claimed from, or null when none is recorded. */
  sentence: string | null;
  /** The eyebrow/value pair in the foot of the card, when a timestamp was actually recorded. */
  footLabel: string | null;
  footValue: string | null;
  /** The one action a coach owns on this card, or null when the wait is not theirs. */
  action: { label: "Connect" | "Reconnect"; href: string } | null;
  rows: readonly { label: string; value: string }[];
};

export type RehaulSmsRegistration = {
  /** ISO submission time, or null when the filing date was never recorded. */
  submittedAt: string | null;
  /** True once the registration reached a terminal refusal, which is not a wait any more. */
  rejected: boolean;
  /** Amber only while the carrier still owns the wait; a refusal is not a pending state. */
  tone: "good" | "amber" | "grey";
  stateLabel: string;
};

export type RehaulConnectionSurface = {
  /** null when the channel read did not answer, which is different from "nothing connected". */
  cards: readonly RehaulConnectionCard[] | null;
  calendar: RehaulConnectionCard | null;
  sms: RehaulSmsRegistration | null;
  /** What the ad platform is told, and whether the dataset behind it is actually connected. */
  adPlatform: { connected: boolean; label: string } | null;
};

export type RehaulCoachAgentProps = {
  initialState: CoachOfferInitialState;
  /** The date the live offer was published, or null while nothing is published. */
  publishedDateLabel: string | null;
  connections: RehaulConnectionSurface | null;
  tab: "ladder" | "connections";
  /** `phase7MeetAgentLive()`; the lead test lives on `/meet-agent` and is gated with it. */
  testEnabled: boolean;
  /**
   * The merged question list for this tenant, in its stored order, or null when the read refused.
   * Null is not an empty library: the panel says it could not read rather than drawing no rows.
   */
  questions: readonly CoachQuestion[] | null;
  /**
   * The follow-up surface behind step 7: whether live follow-up is switched on, and the connected
   * channels the schedule groups are built from. Timing and touch count are the platform's, so
   * only the purpose of each touch is editable, and an absent read draws no channel rather than
   * claiming none is connected.
   */
  cadence?: { enabled: boolean; channels: readonly CoachCadenceChannel[] };
  /** Test seam. Omit and the component loads goals from the tenant-scoped route. */
  initialKeywordGoals?: readonly KeywordGoal[];
};

/* ------------------------------------------------------------------ *
 * Shape
 * ------------------------------------------------------------------ */

const PANEL_CLASS =
  "flex min-w-0 flex-col overflow-hidden rounded-[24px_24px_17px_17px] border " +
  "border-[var(--line)] bg-[var(--card)]";
const BAND_CLASS =
  "flex min-h-[78px] items-center gap-[12px] border-b border-[var(--line)] px-[20px] py-[19px]";
const NAME_CLASS = "text-[17px] leading-[1.3] font-semibold tracking-[-0.01em] text-[color:var(--ink)]";
const ROW_CLASS =
  "flex min-h-[var(--coach-target)] flex-wrap items-center gap-[16px] border-b " +
  "border-[var(--line-soft)] px-[20px] py-[16px] last:border-b-0";
const MONO_CLASS = "font-mono font-medium tracking-[-0.05em]";
const FIELD_CLASS =
  "h-[48px] w-full rounded-[10px] border border-[var(--line-input)] bg-[var(--well)] px-[14px] " +
  "text-[length:var(--coach-body)] text-[color:var(--ink)]";
/*
 * The same face as FIELD_CLASS on the kit's select trigger, which brings its own smaller console
 * sizing. The trigger is a <button>, so coach.css raises it to --coach-target on its own; the type
 * size is restated here because the kit's `text-xs` sits under the coach surface's 14px floor.
 */
const SELECT_TRIGGER_CLASS =
  "h-[48px] w-full rounded-[10px] border-[var(--line-input)] bg-[var(--well)] px-[14px] " +
  "text-[length:var(--coach-body)] text-[color:var(--ink)]";
const QUIET_BUTTON_CLASS =
  "inline-flex h-[46px] shrink-0 items-center justify-center gap-[8px] rounded-[12px] border " +
  "border-[var(--line-input)] bg-[var(--control-fill)] px-[20px] text-[length:var(--coach-body)] " +
  "leading-none font-medium text-[color:var(--body)] hover:border-[var(--accent-edge)] " +
  "hover:text-[color:var(--ink)]";

const DOT_TONE: Record<"good" | "amber" | "grey", string> = {
  amber: "bg-[var(--warning)]",
  good: "bg-[var(--good)]",
  grey: "bg-[var(--dim,var(--line-input))]",
};

/** The pill face for the same three tones, so a state never wears a palette it did not earn. */
const PILL_TONE: Record<"good" | "amber" | "grey", string> = {
  amber: "border-[var(--warning-line)] bg-[var(--warning-wash)] text-[color:var(--warning-text)]",
  good: "border-[var(--good-line)] bg-[var(--good-wash)] text-[color:var(--good-text)]",
  grey: "border-[var(--line)] bg-[var(--well)] text-[color:var(--muted)]",
};

function Dot({ tone }: { tone: "good" | "amber" | "grey" }) {
  return <span aria-hidden className={`size-[8px] shrink-0 rounded-full ${DOT_TONE[tone]}`} />;
}

/**
 * The standing accountability line for a control that writes on click.
 *
 * `LoggedButton` carries this caption under a button; the keyword-goal segmented group writes the
 * moment a segment is pressed and has no button to hang it on, so the same registry microcopy and
 * the same aria label render beside the group instead of after the fact.
 */
function LoggedNote({ actionKey }: { actionKey: keyof typeof AUDIT_ACTIONS }) {
  const accountability = AUDIT_ACTIONS[actionKey];
  return (
    <span
      aria-label={accountability.ariaLabel}
      className="inline-flex shrink-0 items-center gap-[6px] text-[14px] text-[color:var(--muted)]"
    >
      <ShieldCheck aria-hidden className="size-[14px]" />
      {accountability.microcopy}
    </span>
  );
}

/**
 * The accountability line for the two question writes.
 *
 * The reorder arrows and the per-row switch write two different keys --
 * `coach.question_order.saved` and `coach.question.enabled.changed` -- so the header carries two
 * notes rather than one joined string. Both now live in `POST_SEED_UI_ACTIONS`, mirrored from
 * `20261009000004_tenant_question_settings.sql`, so `LoggedNote` reads the words from the registry
 * and there is nothing hand-copied left here to drift from the row it describes.
 */
function QuestionLoggedNote() {
  return (
    <span className="inline-flex shrink-0 items-center gap-[12px]">
      <LoggedNote actionKey="coach.question_order.saved" />
      <LoggedNote actionKey="coach.question.enabled.changed" />
    </span>
  );
}

/**
 * The 52x30 track `_coach.css` draws for an on/off row, as a real `role="switch"` button.
 *
 * The artboard's `.sw` is a decorative span; a coach has to be able to reach it with a keyboard,
 * so this is a button that reports its own state rather than a div with a click handler.
 */
function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange(next: boolean): void;
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={
        "relative h-[30px] w-[52px] shrink-0 rounded-full border transition-colors " +
        "disabled:opacity-60 " +
        (checked
          ? "border-[var(--accent-line)] [background:var(--accent-fill)]"
          : "border-[var(--line-input)] bg-[var(--line-input)]")
      }
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span
        aria-hidden
        className={
          "absolute top-[2px] size-[24px] rounded-full bg-[var(--card)] transition-all " +
          (checked ? "left-[25px]" : "left-[2px]")
        }
      />
    </button>
  );
}

/** The move controls beside a question row; disabled at the end of the list they cannot leave. */
const MOVE_BUTTON_CLASS =
  "inline-flex size-[36px] shrink-0 items-center justify-center rounded-[10px] border " +
  "border-[var(--line-input)] bg-[var(--control-fill)] text-[color:var(--body)] " +
  "hover:border-[var(--accent-edge)] hover:text-[color:var(--ink)] " +
  "disabled:opacity-40 disabled:hover:border-[var(--line-input)]";

function Panel({
  children,
  eyebrow,
  name,
  action,
}: {
  children: ReactNode;
  eyebrow: string;
  name: string;
  action?: ReactNode;
}) {
  return (
    <section className={PANEL_CLASS}>
      <div className={BAND_CLASS}>
        <div className="min-w-0">
          <span className={`block ${COACH_EYEBROW_CLASS}`}>{eyebrow}</span>
          <h2 className={NAME_CLASS}>{name}</h2>
        </div>
        {action ? <div className="ml-auto flex items-center gap-[10px]">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * The rung marker on the ladder rail. Decorative: the panel's own eyebrow says which step it is,
 * so the marker asserts nothing a screen reader has to hear twice.
 */
function Rung({ children, tone }: { children: ReactNode; tone: "accent" | "good" | "violet" | "grey" }) {
  const face: Record<typeof tone, string> = {
    accent: "border-[var(--accent-line)] bg-[var(--accent-wash)] text-[color:var(--accent-text)]",
    good: "border-[var(--good-line)] bg-[var(--good-wash)] text-[color:var(--good-text)]",
    grey: "border-[var(--line)] bg-[var(--control-fill)] text-[color:var(--muted)]",
    violet: "border-[var(--line)] bg-[var(--control-fill)] text-[color:var(--body)]",
  };
  return (
    <span
      aria-hidden
      className={
        "relative z-[1] flex size-[64px] shrink-0 items-center justify-center rounded-[16px] " +
        `border ${face[tone]}`
      }
    >
      {children}
    </span>
  );
}

function Step({
  children,
  icon,
  tone,
}: {
  children: ReactNode;
  icon: ReactNode;
  tone: "accent" | "good" | "violet" | "grey";
}) {
  return (
    <div className="flex min-w-0 items-start gap-[20px]">
      <Rung tone={tone}>{icon}</Rung>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Glyph({ d }: { d: string }) {
  return (
    <svg
      fill="none"
      height="24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
      width="24"
    >
      <path d={d} />
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * Offer form
 * ------------------------------------------------------------------ */

function editableOffer(offer: PersistedOfferLayer | null): CoachOfferDraftInput {
  if (!offer) {
    return {
      programName: "",
      programDescription: null,
      creditMin: null,
      fundingGoalMinCents: null,
      fundingGoalMaxCents: null,
      monthlyRevenueMinCents: null,
      creditRepair: null,
      products: [],
      bookingHorizonDays: 21,
      bookingMode: "direct",
      brandVoice: null,
      resultsTimelineMinDays: null,
      resultsTimelineMaxDays: null,
      refundPosture: null,
      voiceStyleAnswer: null,
      voiceObjectionAnswer: null,
      voiceFollowupAnswer: null,
      prices: [],
      proof: [],
      assets: [],
      cadencePurposes: [],
    };
  }
  return {
    programName: offer.programName,
    programDescription: offer.programDescription,
    creditMin: offer.creditMin,
    fundingGoalMinCents: offer.fundingGoalMinCents,
    fundingGoalMaxCents: offer.fundingGoalMaxCents,
    monthlyRevenueMinCents: offer.monthlyRevenueMinCents,
    creditRepair: offer.creditRepair,
    products: [...offer.products],
    bookingHorizonDays: offer.bookingHorizonDays,
    bookingMode: offer.bookingMode,
    brandVoice: offer.brandVoice,
    resultsTimelineMinDays: offer.resultsTimelineMinDays,
    resultsTimelineMaxDays: offer.resultsTimelineMaxDays,
    refundPosture: offer.refundPosture,
    voiceStyleAnswer: offer.voiceStyleAnswer,
    voiceObjectionAnswer: offer.voiceObjectionAnswer,
    voiceFollowupAnswer: offer.voiceFollowupAnswer,
    prices: offer.offerPrices.map(({ label, amountCents, billingPeriod }) => ({
      label,
      amountCents,
      billingPeriod,
    })),
    proof: offer.proof.map(({ title, detail }) => ({ title, detail })),
    assets: offer.assets.map(({ slug, label, url }) => ({ slug, label, url })),
    cadencePurposes: [...offer.cadencePurposes],
  };
}

/**
 * The six numbers the answers are judged against, which is what step 4's tiers are computed from.
 *
 * These rows used to stand in for step 3 while no per-tenant question storage existed. It exists
 * now -- `tenant_question_settings` and the merged read in `@/lib/repositories/coach-questions` --
 * so step 3 draws the real questions and these thresholds moved to the rung that reads them. Each
 * row is named for the fact it stores. A row with a saved value is a fact the agent judges
 * against; a row left empty stays unknown and the agent never guesses at it.
 */
const FACT_ROWS: readonly {
  key: string;
  /** The fact's own name. The question the agent asks in it is the brain's wording, not ours. */
  label: string;
  tag: string;
  kind: "integer" | "cents" | "choice";
  field: keyof CoachOfferDraftInput;
  options?: readonly { value: string; label: string }[];
}[] = [
  {
    key: "creditMin",
    label: "Credit score",
    tag: "credit score",
    kind: "integer",
    field: "creditMin",
  },
  {
    key: "fundingGoalMinCents",
    label: "Funding amount",
    tag: "funding amount",
    kind: "cents",
    field: "fundingGoalMinCents",
  },
  {
    key: "fundingGoalMaxCents",
    label: "Funding ceiling",
    tag: "funding ceiling",
    kind: "cents",
    field: "fundingGoalMaxCents",
  },
  {
    key: "monthlyRevenueMinCents",
    label: "Monthly business revenue",
    tag: "business revenue",
    kind: "cents",
    field: "monthlyRevenueMinCents",
  },
  {
    key: "creditRepair",
    label: "Credit repair",
    tag: "credit repair",
    kind: "choice",
    field: "creditRepair",
    options: [
      { value: "yes_included", label: "Included" },
      { value: "yes_extra_fee", label: "Extra fee" },
      { value: "no_refer_out", label: "Refer them out" },
      { value: "no_good_credit_only", label: "Good credit only" },
    ],
  },
  {
    key: "refundPosture",
    label: "Refunds",
    tag: "refunds",
    kind: "choice",
    field: "refundPosture",
    options: [
      { value: "none", label: "No refunds" },
      { value: "conditional", label: "Conditional" },
      { value: "published_policy", label: "Published policy" },
    ],
  },
];

/**
 * The three tiers of step 4, written from stored numbers only.
 *
 * Deciding the outcome is the platform's: these sentences say what the agent KNOWS, never what it
 * enforces, which is the same line `THRESHOLD_TEMPLATES` holds on the old page. A tier whose
 * numbers are unsaved says so instead of printing somebody else's 700 and 600.
 */
function tiers(form: CoachOfferDraftInput) {
  const credit = form.creditMin;
  const revenue = form.monthlyRevenueMinCents;
  const goal = form.fundingGoalMinCents;
  return [
    {
      key: "ready",
      tone: "good" as const,
      label: "Ready",
      sentence:
        credit === null && revenue === null
          ? "No credit floor or revenue floor is saved yet."
          : [
              credit === null ? null : `Credit ${credit} or more`,
              revenue === null ? null : `${money(revenue, "USD")} a month or more`,
            ]
              .filter(Boolean)
              .join(", or ") + ".",
      outcome: "Book a call",
      outcomeTone: "text-[color:var(--good-text)]",
    },
    {
      key: "maybe",
      tone: "amber" as const,
      label: "Maybe",
      sentence:
        goal === null
          ? "No minimum funding goal is saved yet."
          : `Asking for at least ${money(goal, "USD")} without meeting a floor above.`,
      outcome: "Keep qualifying",
      outcomeTone: "text-[color:var(--warning-text)]",
    },
    {
      key: "no",
      tone: "grey" as const,
      label: "Not a fit",
      sentence:
        credit === null && goal === null
          ? "Nothing is saved that would turn a lead away."
          : "Under every floor you saved.",
      outcome: "Turned away politely",
      outcomeTone: "text-[color:var(--muted)]",
    },
  ];
}

/**
 * "What SetterFi handles", with a real value beside every claim.
 *
 * The artboard prints five figures and three of them are inventions: there is no reply-delay
 * setting to quote seconds from, no booking reminder anywhere in the send path, and the follow-up
 * window is fourteen days rather than six. So each row states the platform fact the old page
 * already states in prose, and the follow-up count is read off `DURABLE_TOUCHES` rather than
 * typed, which is the list that actually schedules them.
 */
function managedRows() {
  const touches = DURABLE_TOUCHES.length;
  const lastOffsetDays = Math.round(
    (DURABLE_TOUCHES[touches - 1]?.offsetMs ?? 0) / (24 * 60 * 60 * 1_000),
  );
  return [
    { label: "Replies", value: "As soon as the channel accepts" },
    { label: "Follows up", value: `${touches} times over ${lastOffsetDays} days` },
    { label: "Stops when", value: "They reply or opt out" },
    { label: "Quotes a price", value: "Only prices you saved" },
    { label: "Hands to you when", value: "It goes off script" },
  ];
}

const VOICE_OPTIONS = [
  { value: "professional", label: "Professional" },
  { value: "neutral", label: "Balanced" },
  { value: "friendly", label: "Friendly" },
] as const;

const BILLING_LABELS: Record<string, string> = {
  annual: "a year",
  monthly: "a month",
  one_time: "once",
};

/* ------------------------------------------------------------------ *
 * Follow-up cadence
 * ------------------------------------------------------------------ */

/**
 * The purpose a coach actually saved for a fixed platform touch, or null when none is saved.
 *
 * A saved row is keyed by class and touch number, never by channel, because two channels that
 * resolve to the same cadence class share one schedule. Absence is a real answer here: it means
 * the touch still runs on the platform default, which the row says out loud rather than drawing
 * the default as if the coach had chosen it.
 */
function savedPurposeFor(
  rows: readonly CoachCadencePurposeInput[],
  channelClass: CoachCadenceScheduleClass,
  touchNo: number,
): OfferCadencePurpose | null {
  return (
    rows.find((row) => row.channelClass === channelClass && row.touchNo === touchNo)?.purpose ??
    null
  );
}

const PURPOSE_OPTIONS = OFFER_CADENCE_PURPOSES.map((value) => ({
  value,
  label: OFFER_CADENCE_PURPOSE_LABELS[value],
}));

/* ------------------------------------------------------------------ *
 * Keyword goals
 * ------------------------------------------------------------------ */

type GoalDraft = {
  id: string | null;
  keyword: string;
  goal: KeywordGoalMode;
  resourceUrl: string;
  resourceMessage: string;
  postBookingUrl: string;
  postBookingMessage: string;
};

function toGoalDraft(goal: KeywordGoal): GoalDraft {
  return {
    id: goal.id,
    keyword: goal.keyword,
    goal: goal.goal,
    resourceUrl: goal.resourceUrl ?? "",
    resourceMessage: goal.resourceMessage ?? "",
    postBookingUrl: goal.postBookingUrl ?? "",
    postBookingMessage: goal.postBookingMessage ?? "",
  };
}

/* ------------------------------------------------------------------ *
 * The screen
 * ------------------------------------------------------------------ */

export function CoachAgent({
  cadence = { enabled: false, channels: [] },
  connections,
  initialKeywordGoals,
  initialState,
  publishedDateLabel,
  questions,
  tab,
  testEnabled,
}: RehaulCoachAgentProps) {
  const [offers, setOffers] = useState(initialState);
  const [form, setForm] = useState(() => editableOffer(initialState.draft ?? initialState.published));
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [goals, setGoals] = useState<readonly KeywordGoal[] | null>(initialKeywordGoals ?? null);
  const [goalsFailed, setGoalsFailed] = useState(false);
  const [draft, setDraft] = useState<GoalDraft | null>(
    initialKeywordGoals?.[0] ? toGoalDraft(initialKeywordGoals[0]) : null,
  );
  const [goalNotice, setGoalNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newKeyword, setNewKeyword] = useState("");

  /** The orphan row a coach has pressed Remove on, held until they confirm it. */
  const [cadenceRemoval, setCadenceRemoval] = useState<number | null>(null);

  const [questionRows, setQuestionRows] = useState<readonly CoachQuestion[] | null>(questions);
  const [questionNotice, setQuestionNotice] = useState<string | null>(null);
  const [questionBusy, setQuestionBusy] = useState(false);

  useEffect(() => {
    if (initialKeywordGoals !== undefined) return;
    let alive = true;
    void fetch("/api/coach/keyword-goals", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("KEYWORD_GOALS_LOAD_FAILED");
        const value: unknown = await response.json();
        const loaded = (value as { goals?: unknown })?.goals;
        if (!Array.isArray(loaded)) throw new Error("KEYWORD_GOALS_LOAD_FAILED");
        if (!alive) return;
        const rows = loaded as KeywordGoal[];
        setGoals(rows);
        setDraft(rows[0] ? toGoalDraft(rows[0]) : null);
      })
      .catch(() => {
        if (alive) setGoalsFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [initialKeywordGoals]);

  const activeGoals = useMemo(
    () => (goals ?? []).filter((goal) => goal.active),
    [goals],
  );
  const resourceKeywords = activeGoals
    .filter((goal) => goal.goal === "resource")
    .map((goal) => goal.keyword);

  function updateForm<K extends keyof CoachOfferDraftInput>(key: K, value: CoachOfferDraftInput[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setDirty(true);
    setNotice(null);
  }

  /*
   * The schedule the coach edits against, and the export built from the same rows the panel draws.
   * `coachCadenceSchedule` owns the touch list and its timing, so a purpose can only ever be saved
   * against a slot the platform actually schedules; anything already stored outside it is listed
   * separately rather than silently dropped, because the draft still carries it.
   */
  const cadenceSchedule = useMemo(
    () => coachCadenceSchedule(cadence.channels),
    [cadence.channels],
  );
  const cadenceExportRows = useMemo(
    () => coachCadenceExportRows(cadenceSchedule, form.cadencePurposes),
    [cadenceSchedule, form.cadencePurposes],
  );
  const scheduledSlots = useMemo(
    () =>
      new Set(
        cadenceSchedule.flatMap((group) =>
          group.touches.map((touch) => `${group.channelClass}:${touch.touchNo}`),
        ),
      ),
    [cadenceSchedule],
  );
  const orphanCadencePurposes = form.cadencePurposes
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => !scheduledSlots.has(`${row.channelClass}:${row.touchNo}`));

  /**
   * Save one touch's purpose into the draft, replacing the row for that slot rather than adding a
   * second one: the storage keeps at most one purpose per class and touch number, and two rows for
   * the same slot would make the agent's next read arbitrary.
   */
  function setCadencePurpose(
    channelClass: CoachCadenceScheduleClass,
    touchNo: number,
    purpose: OfferCadencePurpose,
  ) {
    const index = form.cadencePurposes.findIndex(
      (row) => row.channelClass === channelClass && row.touchNo === touchNo,
    );
    if (index < 0) {
      updateForm("cadencePurposes", [
        ...form.cadencePurposes,
        { channelClass, touchNo, purpose, assetId: null },
      ]);
      return;
    }
    updateForm(
      "cadencePurposes",
      form.cadencePurposes.map((row, rowIndex) =>
        rowIndex === index ? { ...row, purpose } : row,
      ),
    );
  }

  function removeCadencePurpose(index: number) {
    updateForm(
      "cadencePurposes",
      form.cadencePurposes.filter((_, rowIndex) => rowIndex !== index),
    );
    setCadenceRemoval(null);
  }

  async function saveOffer() {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/coach/offer", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          draftId: offers.draft?.id ?? null,
          expectedContentHash: offers.draft?.contentHash ?? null,
          offer: form,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const code = (payload as { code?: unknown })?.code;
        throw new Error(typeof code === "string" ? code : `HTTP_${response.status}`);
      }
      const result = savedDraftView(payload);
      if (!result.saved || !result.draft) throw new Error("OFFER_DRAFT_READBACK_INCOMPLETE");
      setOffers((current) => ({ ...current, draft: result.draft }));
      setDirty(false);
      setNotice("Draft saved.");
    } catch (cause) {
      setNotice(humanError(cause instanceof Error ? cause.message : "OFFER_SAVE_REFUSED").body);
    } finally {
      setBusy(false);
    }
  }

  const publishBlocked = busy || dirty || !offers.draft;

  async function publishOffer() {
    if (!offers.draft) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/coach/offer/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          draftId: offers.draft.id,
          expectedContentHash: offers.draft.contentHash,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const code = (payload as { code?: unknown })?.code;
        throw new Error(typeof code === "string" ? code : `HTTP_${response.status}`);
      }
      setNotice("Published and logged.");
      setDirty(false);
    } catch (cause) {
      setNotice(humanError(cause instanceof Error ? cause.message : "OFFER_PUBLISH_REFUSED").body);
    } finally {
      setBusy(false);
    }
  }

  /** The one write path for a keyword goal, shared by the goal seg and both message rungs. */
  const saveGoal = useCallback(
    async (next: GoalDraft) => {
      setGoalNotice(null);
      const response = await fetch("/api/coach/keyword-goals", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: next.id,
          keyword: next.keyword.trim(),
          goal: next.goal,
          resourceUrl: next.goal === "resource" ? next.resourceUrl.trim() || null : null,
          resourceMessage: next.goal === "resource" ? next.resourceMessage.trim() || null : null,
          postBookingUrl: next.postBookingUrl.trim() || null,
          postBookingMessage: next.postBookingMessage.trim() || null,
        }),
      });
      const value: unknown = await response.json().catch(() => null);
      const payload = value as
        | { goal?: KeywordGoal; audit?: { actionKey?: string; auditId?: string } }
        | null;
      if (
        !response.ok ||
        !payload?.goal ||
        payload.audit?.actionKey !== "keyword_goal.saved" ||
        !payload.audit.auditId
      ) {
        setGoalNotice("This keyword was not saved. Try again.");
        throw new Error("KEYWORD_GOAL_SAVE_REFUSED");
      }
      const saved = payload.goal;
      setGoals((current) => (current ?? []).map((row) => (row.id === saved.id ? saved : row)));
      setDraft(toGoalDraft(saved));
      setGoalNotice("Saved and logged.");
    },
    [],
  );

  /**
   * A new trigger word, through the same route and the same audited action key the segments use.
   *
   * `saveGoal` updates a row it already has; a create has no row to update, so the readback is
   * appended here and the new goal becomes the selected draft, which is what the rungs below it
   * are editing.
   */
  const addKeyword = useCallback(async () => {
    const keyword = newKeyword.trim();
    if (!keyword) return;
    setGoalNotice(null);
    const response = await fetch("/api/coach/keyword-goals", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: null,
        keyword,
        goal: "book",
        resourceUrl: null,
        resourceMessage: null,
        postBookingUrl: null,
        postBookingMessage: null,
      }),
    });
    const value: unknown = await response.json().catch(() => null);
    const payload = value as
      | { goal?: KeywordGoal; audit?: { actionKey?: string; auditId?: string } }
      | null;
    if (
      !response.ok ||
      !payload?.goal ||
      payload.audit?.actionKey !== "keyword_goal.saved" ||
      !payload.audit.auditId
    ) {
      setGoalNotice("This keyword was not saved. Try again.");
      throw new Error("KEYWORD_GOAL_SAVE_REFUSED");
    }
    const saved = payload.goal;
    setGoals((current) => [...(current ?? []), saved]);
    setDraft(toGoalDraft(saved));
    setAdding(false);
    setNewKeyword("");
    setGoalNotice("Saved and logged.");
  }, [newKeyword]);

  /**
   * The one write path for step 3: send the request, then redraw from what the route read back.
   *
   * Both writes return the canonical merged list, so nothing here reorders or flips a row locally
   * first. A refused write leaves the rows exactly as storage last reported them and says so.
   */
  const writeQuestions = useCallback(
    async (method: "PUT" | "PATCH", body: unknown, actionKey: string) => {
      setQuestionBusy(true);
      setQuestionNotice(null);
      try {
        const response = await fetch("/api/coach/questions", {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const value: unknown = await response.json().catch(() => null);
        const payload = value as
          | { questions?: CoachQuestion[]; audit?: { actionKey?: string; auditId?: string } }
          | null;
        if (
          !response.ok ||
          !Array.isArray(payload?.questions) ||
          payload.audit?.actionKey !== actionKey ||
          !payload.audit.auditId
        ) {
          setQuestionNotice("This question was not changed. Try again.");
          return;
        }
        setQuestionRows(payload.questions);
        setQuestionNotice("Saved and logged.");
      } catch {
        setQuestionNotice("This question was not changed. Try again.");
      } finally {
        setQuestionBusy(false);
      }
    },
    [],
  );

  const moveQuestion = useCallback(
    async (questionId: string, direction: -1 | 1) => {
      const current = questionRows ?? [];
      const index = current.findIndex((question) => question.id === questionId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return;
      const ids = current.map((question) => question.id);
      [ids[index], ids[target]] = [ids[target], ids[index]];
      await writeQuestions("PUT", { questionIds: ids }, "coach.question_order.saved");
    },
    [questionRows, writeQuestions],
  );

  const toggleQuestion = useCallback(
    async (questionId: string, enabled: boolean) => {
      await writeQuestions(
        "PATCH",
        { questionId, enabled },
        "coach.question.enabled.changed",
      );
    },
    [writeQuestions],
  );

  const statusTone: "good" | "amber" = offers.published ? "good" : "amber";
  const statusLabel = offers.published
    ? publishedDateLabel
      ? `Live, published ${publishedDateLabel}`
      : "Live"
    : "Nothing published yet";

  return (
    <div className="relative flex min-w-0 flex-col gap-[var(--s-6)]">
      <div className="flex flex-wrap items-end gap-[24px]">
        <div className="min-w-0">
          <h1 className="coach-page-title m-0">Your agent</h1>
          <p className="mt-[10px] flex flex-wrap items-center gap-[8px] text-[length:var(--coach-body)] text-[color:var(--muted)]">
            <Dot tone={statusTone} />
            {statusLabel}
            {dirty ? " · unsaved changes" : null}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-[10px]">
          <nav
            aria-label="Agent views"
            className="inline-flex rounded-[10px] border border-[var(--line)] bg-[var(--card)] p-[3px]"
          >
            {(
              [
                { key: "ladder", label: "Ladder", href: "/coach/agent" },
                { key: "connections", label: "Connections", href: "/coach/agent?tab=connections" },
              ] as const
            ).map((entry) => (
              <Link
                aria-current={tab === entry.key ? "page" : undefined}
                className={
                  "flex h-[38px] items-center rounded-[8px] px-[16px] text-[15px] leading-none " +
                  (tab === entry.key
                    ? "bg-[var(--accent-wash-strong)] font-medium text-[color:var(--accent-text)]"
                    : "text-[color:var(--muted)]")
                }
                href={entry.href}
                key={entry.key}
                prefetch={false}
              >
                {entry.label}
              </Link>
            ))}
          </nav>
          {testEnabled ? (
            <Link className={QUIET_BUTTON_CLASS} href="/meet-agent" prefetch={false}>
              Test as a lead
            </Link>
          ) : null}
          {/*
            * Save writes an `offer.draft.saved` row inside `save_offer_draft` itself, in the same
            * transaction as the draft, so the caption under it is a fact about what a successful
            * press leaves behind rather than a promise. It sits on a `LoggedButton` for the same
            * reason Publish does, and at the same `coach` scale, so the pair reads as one row of
            * controls that both record.
            */}
          <LoggedButton
            actionKey="offer.draft.saved"
            disabled={busy || !dirty}
            onClick={saveOffer}
            scale="coach"
            type="button"
            variant={dirty ? "primary" : "secondary"}
          >
            {busy ? "Saving..." : "Save"}
          </LoggedButton>
          <LoggedButton
            actionKey="offer.published"
            disabled={publishBlocked}
            onClick={publishOffer}
            scale="coach"
            type="button"
            variant="secondary"
          >
            Publish
          </LoggedButton>
        </div>
      </div>

      {notice ? (
        <p
          className="m-0 rounded-[14px] border border-[var(--line)] bg-[var(--well)] px-[20px] py-[14px] text-[length:var(--coach-body)] text-[color:var(--body)]"
          role="status"
        >
          {notice}
        </p>
      ) : null}

      {tab === "connections" ? (
        <ConnectionsTab surface={connections} />
      ) : (
        <div className="grid min-w-0 grid-cols-1 items-start gap-[32px] xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="relative flex min-w-0 flex-col gap-[24px]">
            <span
              aria-hidden
              className="absolute top-[24px] bottom-[24px] left-[31px] w-[2px] bg-[var(--line)]"
            />

            {/* Step 1 */}
            <Step icon={<Glyph d="M4 7h16M4 12h16M4 17h10" />} tone="good">
              <Panel
                action={
                  goals === null || goalsFailed ? null : (
                    <button
                      className={QUIET_BUTTON_CLASS}
                      onClick={() => {
                        setAdding((current) => !current);
                        setNewKeyword("");
                        setGoalNotice(null);
                      }}
                      type="button"
                    >
                      {adding ? "Cancel" : "Add a keyword"}
                    </button>
                  )
                }
                eyebrow="Step 1"
                name="Keywords"
              >
                {goalsFailed ? (
                  <p className="px-[20px] py-[16px] text-[length:var(--coach-body)] text-[color:var(--muted)]">
                    Your keywords could not be read just now.
                  </p>
                ) : goals === null ? (
                  <p className="px-[20px] py-[16px] text-[length:var(--coach-body)] text-[color:var(--muted)]">
                    Reading your keywords.
                  </p>
                ) : activeGoals.length === 0 ? (
                  <p className="px-[20px] py-[16px] text-[length:var(--coach-body)] text-[color:var(--muted)]">
                    No keyword is set up yet.
                  </p>
                ) : (
                  <div className="flex flex-col">
                    {activeGoals.map((goal) => {
                      const selected = draft?.id === goal.id;
                      const current = selected && draft ? draft.goal : goal.goal;
                      return (
                        <div className={ROW_CLASS} data-keyword={goal.keyword} key={goal.id}>
                          <button
                            className={`${MONO_CLASS} w-[120px] shrink-0 text-left text-[17px] ${
                              selected ? "text-[color:var(--accent-text)]" : "text-[color:var(--ink)]"
                            }`}
                            onClick={() => {
                              setDraft(toGoalDraft(goal));
                              setGoalNotice(null);
                            }}
                            type="button"
                          >
                            {goal.keyword}
                          </button>
                          <div
                            className="inline-flex rounded-[10px] border border-[var(--line)] bg-[var(--card)] p-[3px]"
                            role="group"
                          >
                            {(
                              [
                                { value: "resource", label: "Send a resource" },
                                { value: "book", label: "Book a call" },
                              ] as const
                            ).map((option) => (
                              <button
                                aria-pressed={current === option.value}
                                className={
                                  "flex h-[38px] items-center rounded-[8px] px-[16px] text-[15px] leading-none " +
                                  (current === option.value
                                    ? "bg-[var(--accent-wash-strong)] font-medium text-[color:var(--accent-text)]"
                                    : "text-[color:var(--muted)]")
                                }
                                key={option.value}
                                onClick={() => {
                                  const next = { ...toGoalDraft(goal), goal: option.value };
                                  setDraft(next);
                                  void saveGoal(next).catch(() => undefined);
                                }}
                                type="button"
                              >
                                {option.label}
                              </button>
                            ))}
                          </div>
                          {/*
                            The segments write on click, so the accountability line stands in the
                            row itself rather than arriving underneath the panel afterwards.
                          */}
                          <span className="ml-auto">
                            <LoggedNote actionKey="keyword_goal.saved" />
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {adding ? (
                  <div className={ROW_CLASS}>
                    <label className="min-w-0 flex-1">
                      <span className={`mb-[6px] block ${COACH_EYEBROW_CLASS}`}>New keyword</span>
                      <Input
                        className={`${FIELD_CLASS} ${MONO_CLASS}`}
                        onChange={(event) => setNewKeyword(event.target.value)}
                        value={newKeyword}
                      />
                    </label>
                    <LoggedButton
                      actionKey="keyword_goal.saved"
                      disabled={!newKeyword.trim()}
                      onClick={() => addKeyword()}
                      scale="coach"
                      type="button"
                      variant="secondary"
                    >
                      Save the keyword
                    </LoggedButton>
                  </div>
                ) : null}
                {goalNotice ? (
                  <p
                    className="border-t border-[var(--line-soft)] px-[20px] py-[12px] text-[15px] text-[color:var(--muted)]"
                    role="status"
                  >
                    {goalNotice}
                  </p>
                ) : null}
              </Panel>
            </Step>

            {/* Step 2 */}
            <Step
              icon={
                <Glyph d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
              }
              tone="accent"
            >
              <Panel
                eyebrow={
                  resourceKeywords.length
                    ? `Step 2 · for ${resourceKeywords.join(", ")}`
                    : "Step 2"
                }
                name="The resource"
              >
                <div className="flex flex-col gap-[16px] p-[20px]">
                  {draft ? (
                    <>
                      <div className="grid gap-[16px] md:grid-cols-2">
                        <label className="min-w-0">
                          <span className={`mb-[6px] block ${COACH_EYEBROW_CLASS}`}>Link</span>
                          <Input
                            className={`${FIELD_CLASS} ${MONO_CLASS}`}
                            onChange={(event) =>
                              setDraft({ ...draft, resourceUrl: event.target.value })
                            }
                            value={draft.resourceUrl}
                          />
                        </label>
                        <label className="min-w-0">
                          <span className={`mb-[6px] block ${COACH_EYEBROW_CLASS}`}>Message</span>
                          <Input
                            className={FIELD_CLASS}
                            onChange={(event) =>
                              setDraft({ ...draft, resourceMessage: event.target.value })
                            }
                            value={draft.resourceMessage}
                          />
                        </label>
                      </div>
                      {/*
                        The artboard puts a switch here reading "Check in after 1 day if they
                        haven't replied". Cadence timing is platform-owned -- `DURABLE_TOUCHES`
                        fixes the first chase at two hours and there is no per-keyword override
                        column -- so the fact that SetterFi owns the chase is stated in the eye
                        rather than offered here as a switch that would write nowhere.
                      */}
                      <div className="flex items-center gap-[12px]">
                        <LoggedButton
                          actionKey="keyword_goal.saved"
                          onClick={() => saveGoal(draft)}
                          scale="coach"
                          type="button"
                          variant="secondary"
                        >
                          Save the resource
                        </LoggedButton>
                      </div>
                    </>
                  ) : (
                    <p className="m-0 text-[length:var(--coach-body)] text-[color:var(--muted)]">
                      Pick a keyword above to set its resource.
                    </p>
                  )}
                </div>
              </Panel>
            </Step>

            {/* Step 3 */}
            <Step
              icon={<Glyph d="M9 9a3 3 0 1 1 4 2.8c-.7.3-1 .9-1 1.7V15M12 18h.01" />}
              tone="good"
            >
              <Panel
                action={<QuestionLoggedNote />}
                eyebrow="Step 3 · reorder or turn off"
                name="Questions your agent asks"
              >
                {questionRows === null ? (
                  <p className="m-0 px-[20px] py-[16px] text-[length:var(--coach-body)] text-[color:var(--muted)]">
                    {"Your agent's questions could not be read just now."}
                  </p>
                ) : questionRows.length === 0 ? (
                  <p className="m-0 px-[20px] py-[16px] text-[length:var(--coach-body)] text-[color:var(--muted)]">
                    No questions are published yet.
                  </p>
                ) : (
                  <div className="flex flex-col">
                    {questionRows.map((question, index) => (
                      <div
                        className={`${ROW_CLASS} ${question.enabled ? "" : "text-[color:var(--muted)]"}`}
                        key={question.id}
                      >
                        <span
                          className={
                            "min-w-[220px] flex-1 text-[length:var(--coach-body)] " +
                            (question.enabled
                              ? "text-[color:var(--ink)]"
                              : "text-[color:var(--muted)]")
                          }
                        >
                          {question.text}
                        </span>
                        <span className={`${MONO_CLASS} text-[14px] text-[color:var(--muted)]`}>
                          {question.tag}
                        </span>
                        <span className="flex shrink-0 items-center gap-[8px]">
                          <button
                            aria-label={`Move "${question.text}" earlier`}
                            className={MOVE_BUTTON_CLASS}
                            disabled={questionBusy || index === 0}
                            onClick={() => void moveQuestion(question.id, -1)}
                            type="button"
                          >
                            <ArrowUp aria-hidden className="size-[16px]" />
                          </button>
                          <button
                            aria-label={`Move "${question.text}" later`}
                            className={MOVE_BUTTON_CLASS}
                            disabled={questionBusy || index === questionRows.length - 1}
                            onClick={() => void moveQuestion(question.id, 1)}
                            type="button"
                          >
                            <ArrowDown aria-hidden className="size-[16px]" />
                          </button>
                          <Switch
                            checked={question.enabled}
                            disabled={questionBusy}
                            label={`Ask "${question.text}"`}
                            onChange={(next) => void toggleQuestion(question.id, next)}
                          />
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {questionNotice ? (
                  <p
                    className="m-0 border-t border-[var(--line-soft)] px-[20px] py-[14px] text-[length:var(--coach-body)] text-[color:var(--body)]"
                    role="status"
                  >
                    {questionNotice}
                  </p>
                ) : null}
              </Panel>
            </Step>

            {/* Step 4 */}
            <Step icon={<Glyph d="M12 3v6m0 0-5 5m5-5 5 5M7 14v7m10-7v7" />} tone="violet">
              <Panel eyebrow="Step 4" name="How qualified are they?">
                <div className="flex flex-col">
                  {FACT_ROWS.map((row) => {
                    const value = form[row.field];
                    const set = value !== null && value !== "";
                    return (
                      <div className={ROW_CLASS} key={row.key}>
                        <span className="min-w-[220px] flex-1 text-[length:var(--coach-body)] text-[color:var(--ink)]">
                          {row.label}
                        </span>
                        <div className="w-[200px] shrink-0">
                          {row.kind === "choice" ? (
                            <Select
                              onValueChange={(next) =>
                                updateForm(
                                  row.field,
                                  ((next as string) ||
                                    null) as CoachOfferDraftInput[typeof row.field],
                                )
                              }
                              value={typeof value === "string" ? value : ""}
                            >
                              <SelectTrigger
                                aria-label={row.label}
                                className={SELECT_TRIGGER_CLASS}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent align="start" alignItemWithTrigger={false}>
                                <SelectItem value="">Not set</SelectItem>
                                {(row.options ?? []).map((option) => (
                                  <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <Input
                              aria-label={row.label}
                              className={`${FIELD_CLASS} ${MONO_CLASS}`}
                              inputMode="numeric"
                              onChange={(event) => {
                                const raw = event.target.value.trim();
                                if (!raw) {
                                  updateForm(
                                    row.field,
                                    null as CoachOfferDraftInput[typeof row.field],
                                  );
                                  return;
                                }
                                const parsed = Number(raw);
                                if (!Number.isSafeInteger(parsed)) return;
                                updateForm(
                                  row.field,
                                  (row.kind === "cents"
                                    ? parsed * 100
                                    : parsed) as CoachOfferDraftInput[typeof row.field],
                                );
                              }}
                              value={
                                typeof value === "number"
                                  ? String(row.kind === "cents" ? value / 100 : value)
                                  : ""
                              }
                            />
                          )}
                        </div>
                        <span
                          className={`${MONO_CLASS} w-[86px] shrink-0 text-right text-[14px] ${
                            set ? "text-[color:var(--accent-text)]" : "text-[color:var(--muted)]"
                          }`}
                        >
                          {set ? "set by you" : "unknown"}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div className="grid grid-cols-1 border-t border-[var(--line-soft)] md:grid-cols-3">
                  {tiers(form).map((tier, index) => (
                    <div
                      className={
                        "p-[20px] " +
                        (index < 2 ? "border-b border-[var(--line-soft)] md:border-r md:border-b-0" : "")
                      }
                      key={tier.key}
                    >
                      <p className="m-0 flex items-center gap-[8px] text-[length:var(--coach-body)] font-semibold text-[color:var(--ink)]">
                        <Dot tone={tier.tone} />
                        {tier.label}
                      </p>
                      <p className="mt-[6px] mb-0 max-w-[var(--measure-deck)] text-[15px] text-[color:var(--muted)]">
                        {tier.sentence}
                      </p>
                      <p className={`${MONO_CLASS} mt-[12px] mb-0 text-[14px] ${tier.outcomeTone}`}>
                        {tier.outcome}
                      </p>
                    </div>
                  ))}
                </div>
              </Panel>
            </Step>

            {/* Step 5 */}
            <Step
              icon={
                <svg
                  fill="none"
                  height="24"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                  width="24"
                >
                  <rect height="16" rx="3" width="18" x="3" y="5" />
                  <path d="M3 10h18M8 3v4M16 3v4" />
                </svg>
              }
              tone="accent"
            >
              <Panel eyebrow="Step 5" name="Book the call">
                <div className="grid grid-cols-1 md:grid-cols-2">
                  <div className="border-b border-[var(--line-soft)] p-[20px] md:border-r md:border-b-0">
                    <span className={`block ${COACH_EYEBROW_CLASS}`}>Calendar</span>
                    {connections?.calendar ? (
                      <p className="mt-[6px] mb-0 flex items-center gap-[10px] text-[length:var(--coach-body)] font-medium text-[color:var(--ink)]">
                        <Dot tone={connections.calendar.tone} />
                        {connections.calendar.stateLabel}
                      </p>
                    ) : (
                      <p className="mt-[6px] mb-0 flex items-center gap-[10px] text-[length:var(--coach-body)] text-[color:var(--muted)]">
                        <Dot tone="grey" />
                        No calendar is connected.
                      </p>
                    )}
                    <label className="mt-[14px] block">
                      <span className={`mb-[6px] block ${COACH_EYEBROW_CLASS}`}>
                        Days a lead can book ahead
                      </span>
                      <Input
                        className={`${FIELD_CLASS} ${MONO_CLASS}`}
                        inputMode="numeric"
                        onChange={(event) =>
                          updateForm(
                            "bookingHorizonDays",
                            Math.max(1, Number(event.target.value) || 1),
                          )
                        }
                        value={String(form.bookingHorizonDays)}
                      />
                    </label>
                  </div>
                  <div className="p-[20px]">
                    <span className={`block ${COACH_EYEBROW_CLASS}`}>Ad platform hears</span>
                    {connections?.adPlatform ? (
                      <p className="mt-[6px] mb-0 flex items-center gap-[10px] text-[length:var(--coach-body)] font-medium text-[color:var(--ink)]">
                        <Dot tone={connections.adPlatform.connected ? "good" : "grey"} />
                        {connections.adPlatform.label}
                      </p>
                    ) : (
                      <p className="mt-[6px] mb-0 flex items-center gap-[10px] text-[length:var(--coach-body)] text-[color:var(--muted)]">
                        <Dot tone="grey" />
                        Conversion tracking is not set up.
                      </p>
                    )}
                  </div>
                </div>
              </Panel>
            </Step>

            {/* Step 6 */}
            <Step icon={<Glyph d="m5 12 5 5L20 7" />} tone="grey">
              <Panel eyebrow="Step 6" name="After they book">
                <div className="flex flex-col gap-[16px] p-[20px]">
                  {draft ? (
                    <>
                      <div className="grid gap-[16px] md:grid-cols-2">
                        <label className="min-w-0">
                          <span className={`mb-[6px] block ${COACH_EYEBROW_CLASS}`}>Message</span>
                          <Textarea
                            className="min-h-[48px] w-full rounded-[10px] border border-[var(--line-input)] bg-[var(--well)] px-[14px] py-[12px] text-[length:var(--coach-body)] text-[color:var(--ink)]"
                            onChange={(event) =>
                              setDraft({ ...draft, postBookingMessage: event.target.value })
                            }
                            value={draft.postBookingMessage}
                          />
                        </label>
                        <label className="min-w-0">
                          <span className={`mb-[6px] block ${COACH_EYEBROW_CLASS}`}>Link</span>
                          <Input
                            className={`${FIELD_CLASS} ${MONO_CLASS}`}
                            onChange={(event) =>
                              setDraft({ ...draft, postBookingUrl: event.target.value })
                            }
                            value={draft.postBookingUrl}
                          />
                        </label>
                      </div>
                      <div>
                        <LoggedButton
                          actionKey="keyword_goal.saved"
                          onClick={() => saveGoal(draft)}
                          scale="coach"
                          type="button"
                          variant="secondary"
                        >
                          Save this message
                        </LoggedButton>
                      </div>
                    </>
                  ) : (
                    <p className="m-0 text-[length:var(--coach-body)] text-[color:var(--muted)]">
                      Pick a keyword above to set what follows a booking.
                    </p>
                  )}
                </div>
              </Panel>
            </Step>

            {/*
              Step 7, the rung the rehaul dropped when it dropped `coach-offer.tsx`.

              Timing is platform-owned: `DURABLE_TOUCHES` and `WINDOW_BOUND_TOUCHES` fix how many
              touches a class gets and when each fires, and there is no per-tenant column for
              either. What each touch is FOR is the coach's, stored in `offer_cadence_purposes`,
              and it saves and publishes through the same draft lifecycle as every other offer
              field on this screen -- there is no second write path here.
            */}
            <Step
              icon={<Glyph d="M12 7v5l3 2M3 12a9 9 0 1 0 9-9 9 9 0 0 0-9 9Z" />}
              tone="violet"
            >
              <Panel
                action={
                  <ExportMenu
                    filename="setterfi-followup-schedule"
                    label="Export schedule"
                    mode="local"
                    rows={cadenceExportRows}
                  />
                }
                eyebrow="Step 7 · timing is ours, purpose is yours"
                name="If they go quiet"
              >
                {cadence.enabled ? null : (
                  <div
                    className="flex flex-col gap-[8px] border-b border-[var(--line-soft)] px-[20px] py-[16px]"
                    role="status"
                  >
                    <span className="inline-flex h-[30px] w-fit items-center gap-[8px] rounded-full border border-[var(--warning-line)] bg-[var(--warning-wash)] px-[12px] text-[14px] text-[color:var(--warning-text)]">
                      <Dot tone="amber" />
                      Not sending yet
                    </span>
                    <p className="m-0 max-w-[var(--measure-deck)] text-[length:var(--coach-body)] text-[color:var(--muted)]">
                      Live follow-up is not switched on, so nothing below claims a message was
                      sent. A purpose you save now is kept and used once it is.
                    </p>
                  </div>
                )}

                {cadenceSchedule.map((group) => (
                  <div key={group.channelClass}>
                    <div className="border-b border-[var(--line-soft)] px-[20px] py-[14px]">
                      <span className={`block ${COACH_EYEBROW_CLASS}`}>{group.channelNote}</span>
                      <h3 className="m-0 mt-[4px] text-[length:var(--coach-body)] font-semibold text-[color:var(--ink)]">
                        {group.channelLabel}
                      </h3>
                      {group.humanOnlyAfterWindow ? (
                        <p className="m-0 mt-[6px] flex items-center gap-[8px] text-[15px] text-[color:var(--muted)]">
                          <ShieldCheck aria-hidden className="size-[16px] shrink-0" />
                          After the reply window, follow-up stays human-only.
                        </p>
                      ) : null}
                    </div>
                    {group.touches.map((touch) => {
                      const saved = savedPurposeFor(
                        form.cadencePurposes,
                        group.channelClass,
                        touch.touchNo,
                      );
                      return (
                        <div
                          className={ROW_CLASS}
                          data-purpose-set={saved ? "true" : "false"}
                          key={`${group.channelClass}:${touch.touchNo}`}
                        >
                          <span className="min-w-[220px] flex-1 text-[length:var(--coach-body)] text-[color:var(--ink)]">
                            Touch {touch.touchNo}
                            <span className="ml-[10px] text-[color:var(--muted)]">{touch.when}</span>
                          </span>
                          <div className="w-[200px] shrink-0">
                            <Select
                              onValueChange={(next) =>
                                setCadencePurpose(
                                  group.channelClass,
                                  touch.touchNo,
                                  (next || touch.defaultPurpose) as OfferCadencePurpose,
                                )
                              }
                              value={saved ?? touch.defaultPurpose}
                            >
                              <SelectTrigger
                                aria-label={`${group.channelLabel} touch ${touch.touchNo} purpose`}
                                className={SELECT_TRIGGER_CLASS}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent align="start" alignItemWithTrigger={false}>
                                {PURPOSE_OPTIONS.map((option) => (
                                  <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <span
                            className={`${MONO_CLASS} w-[86px] shrink-0 text-right text-[14px] ${
                              saved ? "text-[color:var(--accent-text)]" : "text-[color:var(--muted)]"
                            }`}
                          >
                            {saved ? "set by you" : "our default"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ))}

                {/*
                  A purpose stored against a slot the platform no longer schedules. The agent
                  cannot reach it, so it is drawn as something to remove rather than as a row the
                  coach can still edit, and the removal goes into the same draft as everything
                  above it.
                */}
                {orphanCadencePurposes.length ? (
                  <div className="border-t border-[var(--line)]">
                    <div className="px-[20px] py-[14px]">
                      <h3 className="m-0 text-[length:var(--coach-body)] font-semibold text-[color:var(--ink)]">
                        Saved outside this schedule
                      </h3>
                    </div>
                    {orphanCadencePurposes.map(({ row, index }) => (
                      <div className={ROW_CLASS} key={`${row.channelClass}:${row.touchNo}:${index}`}>
                        <span className="min-w-[220px] flex-1 text-[length:var(--coach-body)] text-[color:var(--muted)]">
                          {OFFER_CADENCE_CHANNEL_LABELS[row.channelClass]}, touch {row.touchNo},{" "}
                          {OFFER_CADENCE_PURPOSE_LABELS[row.purpose]}
                        </span>
                        {cadenceRemoval === index ? (
                          <span className="flex shrink-0 items-center gap-[10px]">
                            <span className="text-[15px] text-[color:var(--body)]">
                              Remove it?
                            </span>
                            <button
                              className={QUIET_BUTTON_CLASS}
                              onClick={() => removeCadencePurpose(index)}
                              type="button"
                            >
                              Remove
                            </button>
                            <button
                              className={QUIET_BUTTON_CLASS}
                              onClick={() => setCadenceRemoval(null)}
                              type="button"
                            >
                              Keep
                            </button>
                          </span>
                        ) : (
                          <button
                            aria-label={`Remove ${OFFER_CADENCE_CHANNEL_LABELS[row.channelClass]} touch ${row.touchNo}`}
                            className={QUIET_BUTTON_CLASS}
                            onClick={() => setCadenceRemoval(index)}
                            type="button"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                ) : null}
              </Panel>
            </Step>
          </div>

          <div className="flex min-w-0 flex-col gap-[20px]">
            <Panel eyebrow="Set for you" name="What SetterFi handles">
              <dl className="m-0 flex flex-col text-[length:var(--coach-body)]">
                {managedRows().map((row) => (
                  <div
                    className="flex items-baseline justify-between gap-[12px] border-b border-[var(--line-soft)] px-[20px] py-[14px] last:border-b-0"
                    key={row.label}
                  >
                    <dt className="text-[color:var(--body)]">{row.label}</dt>
                    <dd className={`${MONO_CLASS} m-0 text-right text-[color:var(--ink)]`}>
                      {row.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </Panel>

            <Panel eyebrow="Your voice" name="How you sound">
              <div className="flex flex-col gap-[14px] p-[20px]">
                <div
                  className="flex rounded-[10px] border border-[var(--line)] bg-[var(--card)] p-[3px]"
                  role="group"
                >
                  {VOICE_OPTIONS.map((option) => (
                    <button
                      aria-pressed={form.brandVoice === option.value}
                      className={
                        "flex h-[38px] flex-1 items-center justify-center rounded-[8px] px-[12px] text-[15px] leading-none " +
                        (form.brandVoice === option.value
                          ? "bg-[var(--accent-wash-strong)] font-medium text-[color:var(--accent-text)]"
                          : "text-[color:var(--muted)]")
                      }
                      key={option.value}
                      onClick={() =>
                        updateForm(
                          "brandVoice",
                          option.value as CoachOfferDraftInput["brandVoice"],
                        )
                      }
                      type="button"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <p className="m-0 text-[15px] text-[color:var(--muted)]">
                  {form.brandVoice ? "Your voice, saved." : "Running on our standard voice."}
                </p>
              </div>
            </Panel>

            {/*
              The offer layer's four exports, back on the surface that replaced the offer page.

              `coach-offer.tsx` carried one on each of prices, proof and assets, and one on the
              objection rollup, and the rehaul dropped all four when it dropped that file --
              leaving four server routes a tenant is entitled to with no control that calls them.
              Every one of them is `mode="server"`, so the file is what the route can see rather
              than the rows this column happens to draw, and the "Logged" microcopy under each
              format comes from the shared menu because a server export writes an audit row.

              Proof and assets are drawn here as read-only wells for the same reason prices are:
              the ladder to the left is where a coach edits their agent, and this column is the
              statement of what it is allowed to say.
            */}
            <Panel
              action={
                <ExportMenu
                  filename="setterfi-offer-prices"
                  label="Export prices"
                  mode="server"
                  query={{ order: "created_desc" }}
                  resource="offer-prices"
                />
              }
              eyebrow="What you charge"
              name="Prices your agent can quote"
            >
              {form.prices.length ? (
                <dl className="m-0 flex flex-col text-[length:var(--coach-body)]">
                  {form.prices.map((price, index) => (
                    <div
                      className="flex items-baseline justify-between gap-[12px] border-b border-[var(--line-soft)] px-[20px] py-[14px] last:border-b-0"
                      key={`${price.label}:${index}`}
                    >
                      <dt className="min-w-0 text-[color:var(--body)]">{price.label}</dt>
                      <dd className={`${MONO_CLASS} m-0 text-right text-[color:var(--ink)]`}>
                        {[
                          money(price.amountCents, "USD"),
                          price.billingPeriod ? BILLING_LABELS[price.billingPeriod] : null,
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="m-0 px-[20px] py-[16px] text-[length:var(--coach-body)] text-[color:var(--muted)]">
                  No price is saved, so your agent quotes none.
                </p>
              )}
            </Panel>

            <Panel
              action={
                <ExportMenu
                  filename="setterfi-offer-proof"
                  label="Export proof"
                  mode="server"
                  query={{ order: "created_desc" }}
                  resource="offer-proof"
                />
              }
              eyebrow="What you can claim"
              name="Proof your agent can cite"
            >
              {form.proof.length ? (
                <ul className="m-0 flex list-none flex-col p-0">
                  {form.proof.map((entry, index) => (
                    <li className={ROW_CLASS} key={`${entry.title}:${index}`}>
                      <span className="min-w-0 flex-1 text-[length:var(--coach-body)] text-[color:var(--ink)]">
                        {entry.title}
                      </span>
                      <span className="min-w-0 flex-1 text-[length:var(--coach-body)] text-[color:var(--muted)]">
                        {entry.detail}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0 px-[20px] py-[16px] text-[length:var(--coach-body)] text-[color:var(--muted)]">
                  No proof is saved, so your agent cites none.
                </p>
              )}
            </Panel>

            <Panel
              action={
                <ExportMenu
                  filename="setterfi-offer-assets"
                  label="Export links"
                  mode="server"
                  query={{ order: "created_desc" }}
                  resource="offer-assets"
                />
              }
              eyebrow="What it sends"
              name="Links your agent can send"
            >
              {form.assets.length ? (
                <ul className="m-0 flex list-none flex-col p-0">
                  {form.assets.map((asset, index) => (
                    <li className={ROW_CLASS} key={`${asset.slug}:${index}`}>
                      <span className="min-w-0 flex-1 text-[length:var(--coach-body)] text-[color:var(--ink)]">
                        {asset.label}
                      </span>
                      <span className={`${MONO_CLASS} min-w-0 flex-1 truncate text-right text-[length:var(--coach-body)] text-[color:var(--muted)]`}>
                        {asset.url}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0 px-[20px] py-[16px] text-[length:var(--coach-body)] text-[color:var(--muted)]">
                  No link is saved, so your agent sends none.
                </p>
              )}
            </Panel>

            {/*
              The objection rollup is a download and not a table, and the panel says so.

              `coach-offer.tsx` drew the last thirty days of objections as a list beside its
              export. Nothing on this route reads that rollup -- the page passes the offer layer,
              the connection surface and the question library, and adding a fifth query to a
              screen whose whole argument is that it does not query is not a trade worth making.
              So the control stays and the list does not, and the panel states what the file
              holds rather than drawing an empty table where a rollup would go.
            */}
            <Panel
              action={
                <ExportMenu
                  filename="setterfi-top-objections"
                  label="Export objections"
                  mode="server"
                  query={{ order: "created_desc" }}
                  resource="coach-top-objections"
                />
              }
              eyebrow="What they push back on"
              name="Objections, last 30 days"
            >
              <p className="m-0 px-[20px] py-[16px] text-[length:var(--coach-body)] text-[color:var(--muted)]">
                One row per objection a lead raised in the last thirty days, with how many
                conversations it appeared in and how often a call was still booked after it.
              </p>
            </Panel>
          </div>
        </div>
      )}

      {/*
        Every sentence the old page printed as help text under a heading lives here instead. The
        page states facts and controls; the eye carries the words about them.
      */}
      <ContextEye
        copy="This is your setter read top to bottom, in the order a lead meets it. You set the keywords, the resource it sends, which questions it asks and the order they come in, the facts an answer is judged against, your voice, your prices, and what each follow-up is for. SetterFi writes the questions themselves, checks in if a lead goes quiet on our own schedule, decides when it stops, and checks every reply against what you are allowed to claim. A qualified lead and a booked call are sent to Meta when they happen, never twice. Texting registration sits with the carrier, who owns that review, so there is nothing on this page to test or press while it runs. Saving keeps a draft; publishing is what your leads meet, and it is logged."
        screen="coach-agent"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Connections tab
 * ------------------------------------------------------------------ */

/**
 * The 48px channel mark the Connections artboard puts at the head of each card.
 *
 * Decorative, and deliberately fixed per channel rather than tinted by state: the pill beside it
 * is what carries the state, and a mark that changed colour with the connection would say the same
 * thing twice in a palette that is only allowed to mean one thing.
 */
const CHANNEL_MARKS: Record<string, { face: string; paths: ReactNode }> = {
  calendar: {
    face: "border-[var(--accent-line)] bg-[var(--accent-wash)] text-[color:var(--accent-text)]",
    paths: (
      <>
        <rect height="16" rx="3" width="18" x="3" y="5" />
        <path d="M3 10h18M8 3v4M16 3v4" />
      </>
    ),
  },
  instagram: {
    face: "border-[var(--line)] bg-[var(--control-fill)] text-[color:var(--body)]",
    paths: (
      <>
        <rect height="18" rx="5" width="18" x="3" y="3" />
        <circle cx="12" cy="12" r="4" />
        <path d="M17.5 6.5h.01" />
      </>
    ),
  },
  messenger: {
    face: "border-[var(--accent-line)] bg-[var(--accent-wash)] text-[color:var(--accent-text)]",
    paths: (
      <>
        <path d="M12 3c-4.97 0-9 3.7-9 8.26 0 2.6 1.31 4.91 3.36 6.42V21l3.07-1.69c.82.23 1.69.35 2.57.35 4.97 0 9-3.7 9-8.26S16.97 3 12 3Z" />
        <path d="m7.5 13 2.6-2.8 2.1 2 2.3-2.4" />
      </>
    ),
  },
  sms: {
    face: "border-[var(--warning-line)] bg-[var(--warning-wash)] text-[color:var(--warning-text)]",
    paths: (
      <>
        <rect height="19" rx="3" width="12" x="6" y="2.5" />
        <path d="M10.5 18.5h3" />
      </>
    ),
  },
  whatsapp: {
    face: "border-[var(--good-line)] bg-[var(--good-wash)] text-[color:var(--good-text)]",
    paths: (
      <>
        <path d="M3.5 20.5 5 16.4A8.2 8.2 0 1 1 8.2 19.6l-4.7.9Z" />
        <path d="M9 9.5c.4 2.4 3.1 5.1 5.5 5.5l1.2-1.4 1.8.9v1.6c-2.9.5-7.9-3.6-8.7-7.4l1.4-1.1.9 1.8Z" />
      </>
    ),
  },
};

function ChannelMark({ channel }: { channel: string }) {
  const mark = CHANNEL_MARKS[channel];
  if (!mark) return null;
  return (
    <span
      aria-hidden
      className={`flex size-[48px] shrink-0 items-center justify-center rounded-[13px] border ${mark.face}`}
    >
      <svg
        fill="none"
        height="22"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        viewBox="0 0 24 24"
        width="22"
      >
        {mark.paths}
      </svg>
    </span>
  );
}

function ConnectionCard({ card }: { card: RehaulConnectionCard }) {
  return (
    <section className={`${PANEL_CLASS} min-h-[347px]`}>
      <div className={BAND_CLASS}>
        <ChannelMark channel={card.key} />
        <div className="min-w-0">
          <span className={`block ${COACH_EYEBROW_CLASS}`}>{card.eyebrow}</span>
          <h2 className={NAME_CLASS}>{card.label}</h2>
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-[10px] p-[20px]">
        <span className="inline-flex h-[30px] shrink-0 items-center gap-[8px] self-start rounded-full border border-[var(--line)] bg-[var(--well)] px-[12px] text-[14px] text-[color:var(--muted)]">
          <Dot tone={card.tone} />
          {card.stateLabel}
        </span>
        {card.sentence ? (
          <p className="m-0 max-w-[var(--measure-deck)] text-[length:var(--coach-body)] text-[color:var(--muted)]">
            {card.sentence}
          </p>
        ) : null}
        {card.rows.length ? (
          <dl className="m-0 flex flex-col">
            {card.rows.map((row) => (
              <div
                className="flex items-baseline justify-between gap-[12px] border-b border-[var(--line-soft)] py-[14px] last:border-b-0"
                key={row.label}
              >
                <dt className="text-[length:var(--coach-body)] text-[color:var(--body)]">
                  {row.label}
                </dt>
                <dd className={`${MONO_CLASS} m-0 text-right text-[15px] text-[color:var(--ink)]`}>
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        <div className="mt-auto flex flex-col gap-[6px]">
          {card.footLabel && card.footValue ? (
            <>
              <span className={COACH_EYEBROW_CLASS}>{card.footLabel}</span>
              <span className={`${MONO_CLASS} text-[15px] text-[color:var(--ink)]`}>
                {card.footValue}
              </span>
            </>
          ) : null}
          {card.action ? (
            <Link
              className={`${QUIET_BUTTON_CLASS} w-full`}
              href={card.action.href}
              prefetch={false}
            >
              {card.action.label}
            </Link>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ConnectionsTab({ surface }: { surface: RehaulConnectionSurface | null }) {
  if (!surface || surface.cards === null) {
    return (
      <p className="m-0 rounded-[14px] border border-[var(--line)] bg-[var(--well)] px-[20px] py-[16px] text-[length:var(--coach-body)] text-[color:var(--muted)]">
        Your connections could not be read just now.
      </p>
    );
  }

  const messaging = surface.cards.filter((card) => card.key !== "sms");
  const sms = surface.cards.find((card) => card.key === "sms") ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-[20px]">
      <div className="grid min-w-0 grid-cols-1 gap-[20px] md:grid-cols-2 xl:grid-cols-3">
        {messaging.map((card) => (
          <ConnectionCard card={card} key={card.key} />
        ))}
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-[20px] lg:grid-cols-2">
        {sms ? (
          <section className={`${PANEL_CLASS} min-h-[347px]`}>
            <div className={BAND_CLASS}>
              <ChannelMark channel="sms" />
              <div className="min-w-0">
                <span className={`block ${COACH_EYEBROW_CLASS}`}>{sms.eyebrow}</span>
                <h2 className={NAME_CLASS}>{sms.label}</h2>
              </div>
              {/*
                The pill states the carrier registration, not the channel row: a coach waiting on
                a carrier review is told about the review, and the connection underneath it has no
                separate state to claim until the registration clears.
              */}
              <span
                className={
                  "ml-auto inline-flex h-[30px] shrink-0 items-center gap-[8px] rounded-full " +
                  `border px-[12px] text-[14px] ${PILL_TONE[surface.sms ? surface.sms.tone : sms.tone]}`
                }
              >
                <Dot tone={surface.sms ? surface.sms.tone : sms.tone} />
                {surface.sms ? surface.sms.stateLabel : sms.stateLabel}
              </span>
            </div>
            <div className="flex flex-1 flex-col gap-[16px] p-[20px]">
              {/*
                A day counter, never a percentage and never a predicted date: the carrier owns this
                review and `DayCounter` is the one component allowed to state how long it has run.
              */}
              {surface.sms?.submittedAt && !surface.sms.rejected ? (
                <DayCounter since={surface.sms.submittedAt} typicalDays={CARRIER_TYPICAL_DAYS} />
              ) : (
                <p className="m-0 text-[length:var(--coach-body)] text-[color:var(--muted)]">
                  {surface.sms?.rejected
                    ? "The carrier refused this registration, so there is no wait to count."
                    : "The filing date was not recorded, so no day count is shown."}
                </p>
              )}
            </div>
          </section>
        ) : null}
        {surface.calendar ? <ConnectionCard card={surface.calendar} /> : null}
      </div>
    </div>
  );
}
