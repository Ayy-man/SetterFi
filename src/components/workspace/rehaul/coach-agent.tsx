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

import { DayCounter } from "@/components/kit/day-counter";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import { LoggedButton } from "@/components/kit/logged-button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { COACH_EYEBROW_CLASS } from "@/components/workspace/live/coach-type";
import {
  savedDraftView,
  type CoachOfferInitialState,
} from "@/components/workspace/live/offer-view-models";
import { humanError } from "@/lib/copy/errors";
import { money } from "@/lib/format/metric";
import { DURABLE_TOUCHES } from "@/lib/followups/touch-lists";
import { CARRIER_TYPICAL_DAYS } from "@/lib/onboarding/contracts";
import type { CoachOfferDraftInput, PersistedOfferLayer } from "@/lib/offer/types";
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
const QUIET_BUTTON_CLASS =
  "inline-flex h-[46px] shrink-0 items-center justify-center gap-[8px] rounded-[12px] border " +
  "border-[var(--line-input)] bg-[var(--control-fill)] px-[20px] text-[length:var(--coach-body)] " +
  "leading-none font-medium text-[color:var(--body)] hover:border-[var(--accent-edge)] " +
  "hover:text-[color:var(--ink)]";
const PRIMARY_BUTTON_CLASS =
  "inline-flex h-[46px] shrink-0 items-center justify-center gap-[8px] rounded-[12px] border " +
  "border-[var(--accent-line)] bg-[var(--accent-fill)] px-[20px] text-[length:var(--coach-body)] " +
  "leading-none font-semibold text-[color:var(--on-accent)]";

const DOT_TONE: Record<"good" | "amber" | "grey", string> = {
  amber: "bg-[var(--warning)]",
  good: "bg-[var(--good)]",
  grey: "bg-[var(--dim,var(--line-input))]",
};

function Dot({ tone }: { tone: "good" | "amber" | "grey" }) {
  return <span aria-hidden className={`size-[8px] shrink-0 rounded-full ${DOT_TONE[tone]}`} />;
}

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
 * What the agent may ask about, and why these six rows are the rung rather than a question list.
 *
 * `CoachAgent.body.html` draws step 3 as five draggable questions with an on/off switch each. No
 * such storage exists: `coach-offer.tsx` records that the questions and their order live in the
 * platform brain, "admin edited, with no tenant column", so a control here would offer a setting
 * a coach cannot have. What a coach does own is the six numbers the answers are judged against,
 * and those are the rows below -- the same columns the old page's qualification card wrote, in the
 * same order, with the same save path. A row with a saved value is a fact the agent reads; a row
 * left empty stays unknown and the agent never guesses at it.
 */
const FACT_ROWS: readonly {
  key: string;
  question: string;
  tag: string;
  kind: "integer" | "cents" | "choice";
  field: keyof CoachOfferDraftInput;
  options?: readonly { value: string; label: string }[];
}[] = [
  {
    key: "creditMin",
    question: "Do you know your credit score roughly?",
    tag: "credit score",
    kind: "integer",
    field: "creditMin",
  },
  {
    key: "fundingGoalMinCents",
    question: "Roughly how much are you looking for?",
    tag: "funding amount",
    kind: "cents",
    field: "fundingGoalMinCents",
  },
  {
    key: "fundingGoalMaxCents",
    question: "Is there a ceiling on what you need?",
    tag: "funding ceiling",
    kind: "cents",
    field: "fundingGoalMaxCents",
  },
  {
    key: "monthlyRevenueMinCents",
    question: "Are you running a business today?",
    tag: "business revenue",
    kind: "cents",
    field: "monthlyRevenueMinCents",
  },
  {
    key: "creditRepair",
    question: "Does your credit need work first?",
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
    question: "What if it does not work out?",
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
  connections,
  initialKeywordGoals,
  initialState,
  publishedDateLabel,
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
          <button
            className={dirty ? PRIMARY_BUTTON_CLASS : QUIET_BUTTON_CLASS}
            disabled={busy || !dirty}
            onClick={saveOffer}
            type="button"
          >
            {busy ? "Saving..." : "Save"}
          </button>
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
              <Panel eyebrow="Step 1" name="Keywords">
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
                        </div>
                      );
                    })}
                  </div>
                )}
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
                        column -- so this states what we do rather than offering a switch that
                        would write nowhere.
                      */}
                      <p className="flex items-center gap-[10px] border-t border-[var(--line-soft)] pt-[12px] text-[length:var(--coach-body)] text-[color:var(--muted)]">
                        <Dot tone="good" />
                        SetterFi checks in if they go quiet, on our schedule.
                      </p>
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
              <Panel eyebrow="Step 3 · we choose the order" name="What your agent asks about">
                <div className="flex flex-col">
                  {FACT_ROWS.map((row) => {
                    const value = form[row.field];
                    const set = value !== null && value !== "";
                    return (
                      <div className={ROW_CLASS} key={row.key}>
                        <span className="min-w-[220px] flex-1 text-[length:var(--coach-body)] text-[color:var(--ink)]">
                          {row.question}
                        </span>
                        <span className={`${MONO_CLASS} text-[14px] text-[color:var(--faint)]`}>
                          {row.tag}
                        </span>
                        <div className="w-[200px] shrink-0">
                          {row.kind === "choice" ? (
                            <select
                              aria-label={row.question}
                              className={FIELD_CLASS}
                              onChange={(event) =>
                                updateForm(
                                  row.field,
                                  (event.target.value ||
                                    null) as CoachOfferDraftInput[typeof row.field],
                                )
                              }
                              value={typeof value === "string" ? value : ""}
                            >
                              <option value="">Not set</option>
                              {(row.options ?? []).map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <Input
                              aria-label={row.question}
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
              </Panel>
            </Step>

            {/* Step 4 */}
            <Step icon={<Glyph d="M12 3v6m0 0-5 5m5-5 5 5M7 14v7m10-7v7" />} tone="violet">
              <Panel eyebrow="Step 4" name="How qualified are they?">
                <div className="grid grid-cols-1 md:grid-cols-3">
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
                      <p className="mt-[6px] mb-0 max-w-[34ch] text-[15px] text-[color:var(--muted)]">
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
                    <p className="mt-[6px] mb-0 max-w-[34ch] text-[15px] text-[color:var(--muted)]">
                      Sent to Meta when it happens, never twice.
                    </p>
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

            <Panel eyebrow="What you charge" name="Prices your agent can quote">
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
          </div>
        </div>
      )}

      {/*
        Every sentence the old page printed as help text under a heading lives here instead. The
        page states facts and controls; the eye carries the words about them.
      */}
      <ContextEye
        copy="This is your setter read top to bottom, in the order a lead meets it. You set the keywords, the resource it sends, the facts it asks about, your voice and your prices. SetterFi sets the questions and the order they come in, decides when it follows up and when it stops, and checks every reply against what you are allowed to claim. Saving keeps a draft; publishing is what your leads meet, and it is logged."
        screen="coach-agent"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Connections tab
 * ------------------------------------------------------------------ */

function ConnectionCard({ card }: { card: RehaulConnectionCard }) {
  return (
    <section className={`${PANEL_CLASS} min-h-[300px]`}>
      <div className={BAND_CLASS}>
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
          <p className="m-0 max-w-[34ch] text-[length:var(--coach-body)] text-[color:var(--muted)]">
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
          <section className={`${PANEL_CLASS} min-h-[300px]`}>
            <div className={BAND_CLASS}>
              <div className="min-w-0">
                <span className={`block ${COACH_EYEBROW_CLASS}`}>{sms.eyebrow}</span>
                <h2 className={NAME_CLASS}>{sms.label}</h2>
              </div>
              {/*
                The pill states the carrier registration, not the channel row: a coach waiting on
                a carrier review is told about the review, and the connection underneath it has no
                separate state to claim until the registration clears.
              */}
              <span className="ml-auto inline-flex h-[30px] shrink-0 items-center gap-[8px] rounded-full border border-[var(--warning-line)] bg-[var(--warning-wash)] px-[12px] text-[14px] text-[color:var(--warning-text)]">
                <Dot tone={surface.sms ? "amber" : sms.tone} />
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
              <p className="m-0 max-w-[52ch] text-[length:var(--coach-body)] text-[color:var(--muted)]">
                The carrier owns this review, so there is nothing here to test or press yet.
              </p>
            </div>
          </section>
        ) : null}
        {surface.calendar ? <ConnectionCard card={surface.calendar} /> : null}
      </div>
    </div>
  );
}
