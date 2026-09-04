"use client";

/**
 * `/coach/agent`, drawn as `design/coach/Agent.dc.html`.
 *
 * The argument of the screen is the sentence under its title: four things are yours, and SetterFi
 * runs everything else. So the page is four cards a coach edits in place, a read-only objections
 * rail beside them, one prose panel for the keyword a conversation starts on and the questions it
 * asks, one list of what the platform handles, and one Save bar.
 *
 * Three rules shape every decision below and each is worth stating once rather than repeating at
 * every callsite.
 *
 * **One Save, no publish.** `SIMPLIFICATION-SPEC.md` Q4's default is that a coach never meets the
 * word publish: they save, and what they saved is what their leads meet. So Save writes the offer
 * draft and then publishes it in the same press, and the bar says "Changes go live when you save"
 * because that is what the press does. The platform review still runs behind it; it is simply not
 * the coach's verb.
 *
 * **Everything on the page is one edit.** Questions, keywords and the offer layer are three write
 * paths in the backend, and a screen with one Save bar cannot have two of them writing on click
 * while the third waits. Every control edits local state, `dirty` is true when any of the three
 * differs from what storage last reported, and Save flushes them in order. Undo my changes puts
 * all three back to the last readback, which is the only honest thing an undo on this page can
 * mean.
 *
 * **Nothing here queries.** The offer layer, the question library and the objections rollup all
 * arrive from the page as props. Keyword goals load once from the tenant-scoped route that already
 * exists for them, because that is where they live and the page has no other reader.
 */

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { ArrowDown, ArrowUp, Check, ChatIcon, ShieldCheck, X } from "@/components/kit/icons";
import { DeckPanel } from "@/components/kit/deck-panel";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import {
  COACH_EYEBROW_CLASS,
  COACH_FOOTNOTE_CLASS,
  COACH_LEAD_CLASS,
  COACH_READING_CLASS,
  COACH_ROW_NAME_CLASS,
} from "@/components/workspace/live/coach-type";
import {
  coachCadenceSchedule,
  type CoachCadenceChannel,
  type CoachCadenceScheduleClass,
} from "@/components/workspace/live/coach-agent";
import {
  publishedOfferView,
  savedDraftView,
  type CoachOfferInitialState,
} from "@/components/workspace/live/offer-view-models";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";
import { humanError } from "@/lib/copy/errors";
import { money } from "@/lib/format/metric";
import {
  OFFER_CADENCE_PURPOSE_LABELS,
  OFFER_CADENCE_PURPOSES,
  type CoachCadencePurposeInput,
  type CoachOfferDraftInput,
  type OfferCadencePurpose,
  type PersistedOfferLayer,
} from "@/lib/offer/types";
import type { CoachQuestion } from "@/lib/repositories/coach-questions";
import type { KeywordGoal } from "@/lib/repositories/keyword-goals";

/* ------------------------------------------------------------------ *
 * Props
 * ------------------------------------------------------------------ */

/** One row of the read-only objections rail, already reduced to what the panel draws. */
export type CoachAgentObjectionRow = {
  objectionId: string;
  label: string;
  /**
   * The share of leads who raised it and still booked, 0 to 1, or null when no rate is defined.
   * A null rate draws no bar: a missing definition and a zero share are different facts.
   */
  bookedRate: number | null;
  conversationCount: number;
};

export type CoachAgentObjections = {
  /** The length of the counted window in whole days, so the panel can name it rather than guess. */
  windowDays: number;
  rows: readonly CoachAgentObjectionRow[];
};

export type RehaulCoachAgentProps = {
  initialState: CoachOfferInitialState;
  /**
   * The merged question list for this tenant, in its stored order, or null when the read refused.
   * Null is not an empty library: the panel says it could not read rather than drawing no rows.
   */
  questions: readonly CoachQuestion[] | null;
  /** The objections rollup, or null when the read refused. An empty `rows` is a real answer. */
  objections: CoachAgentObjections | null;
  /**
   * The follow-up surface: whether live follow-up is switched on, and the connected channels the
   * schedule is grouped by. Timing and touch count are the platform's, so only the purpose of each
   * touch is editable.
   */
  cadence?: { enabled: boolean; channels: readonly CoachCadenceChannel[] };
  /** `phase7MeetAgentLive()`; the lead test lives on `/meet-agent` and is gated with it. */
  testEnabled: boolean;
  /** `phase8SupportLive()`; without it there is no thread for "Request a change" to open. */
  supportEnabled: boolean;
  /** Test seam. Omit and the component loads goals from the tenant-scoped route. */
  initialKeywordGoals?: readonly KeywordGoal[];
};

/* ------------------------------------------------------------------ *
 * Shape
 * ------------------------------------------------------------------ */

/** The 64px well a row of this page sits in, which is what every artboard row is drawn on. */
const WELL_ROW_CLASS =
  "flex min-h-[64px] flex-wrap items-center gap-[12px] rounded-[11px] border " +
  "border-[var(--line)] bg-[var(--well)] px-[16px] py-[10px]";
const ICON_BUTTON_CLASS =
  "grid size-[44px] flex-none place-items-center rounded-[10px] border border-[var(--line)] " +
  "bg-[var(--control-fill)] text-[color:var(--body)] hover:border-[var(--accent-edge)] " +
  "hover:text-[color:var(--ink)] disabled:opacity-40 disabled:hover:border-[var(--line)]";
const SECONDARY_BUTTON_CLASS =
  "inline-flex h-[48px] flex-none items-center justify-center gap-[10px] rounded-[9px] border " +
  "border-[var(--line)] bg-[var(--control-fill)] px-[22px] text-[16px] leading-none font-medium " +
  "text-[color:var(--body)] hover:border-[var(--accent-edge)] hover:text-[color:var(--ink)] " +
  "disabled:opacity-50";
const ACCENT_BUTTON_CLASS =
  "inline-flex h-[48px] flex-none items-center justify-center gap-[10px] rounded-[9px] border " +
  "border-[var(--accent-line)] [background:var(--accent-fill)] px-[32px] text-[16px] " +
  "leading-none font-semibold text-[color:var(--on-accent)] disabled:opacity-50";
const DASHED_ADD_CLASS =
  "flex h-[48px] w-full items-center justify-center gap-[10px] rounded-[9px] border " +
  "border-dashed border-[var(--accent-edge)] bg-[var(--accent-wash)] text-[16px] font-medium " +
  "text-[color:var(--accent-text)] hover:bg-[var(--accent-wash-strong)]";
/*
 * The field shell carries no font size, so a field that sets its own does not spell `font-size`
 * twice in one class list and leave the winner to source order. The money input is the one that
 * does: an amount is a figure and reads at 20px in the mono face, while every other field on the
 * page is body copy and takes `FIELD_CLASS`. `utility-collision.test.ts` holds this.
 */
const FIELD_SHELL_CLASS =
  "h-[48px] min-w-0 rounded-[9px] border border-[var(--line-input)] bg-[var(--card)] px-[14px] " +
  "text-[color:var(--ink)]";
const FIELD_CLASS = `${FIELD_SHELL_CLASS} text-[length:var(--coach-body)]`;
/**
 * The kit select trigger, re-cut to the coach's control size and sized to its own content.
 *
 * The trigger brings the console's 36px/12px recipe with it, which is a different density for a
 * different audience. Height, padding and type are restated here rather than in the stylesheet
 * because a shared rule would move every select in the product to fix four on this page.
 */
const SELECT_TRIGGER_CLASS =
  "h-[48px] w-auto min-w-0 gap-[10px] rounded-[9px] border-[var(--line-input)] " +
  "bg-[var(--well)] px-[16px] text-[length:var(--coach-body)] font-medium text-[color:var(--ink)]";
const MONO_CLASS = "font-mono [font-variant-numeric:tabular-nums_lining-nums]";

/*
 * The absence sentence: a missing figure stated in words, in the figure's own slot. Written once
 * because seven slots on this page say it, and set on `--measure-caption` because it is a caption
 * beside an empty card, not a paragraph. `measures.test.ts` holds every measure to a token.
 */
const ABSENCE_CLASS =
  "m-0 max-w-[var(--measure-caption)] text-[20px] font-medium text-[color:var(--muted)]";

/** The one state pill this page draws: a card's face saying whether the coach has set it. */
function StatePill({ set, label }: { set: boolean; label: string }) {
  return (
    <span
      className={
        "inline-flex h-[32px] items-center gap-[8px] rounded-full border px-[12px] text-[15px] " +
        "font-medium whitespace-nowrap " +
        (set
          ? "border-[var(--good-line)] bg-[var(--good-wash)] text-[color:var(--good-text)]"
          : "border-[var(--waiting-line)] bg-[var(--waiting-wash)] text-[color:var(--waiting-text)]")
      }
    >
      <span
        aria-hidden
        className={
          "size-[8px] flex-none rounded-full " + (set ? "bg-[var(--good)]" : "bg-[var(--waiting)]")
        }
      />
      {label}
    </span>
  );
}

/** Plus and minus, drawn rather than imported: the icon set carries neither. */
function Sign({ minus }: { minus?: boolean }) {
  return (
    <svg
      aria-hidden
      fill="none"
      height="20"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.75"
      viewBox="0 0 24 24"
      width="20"
    >
      <path d="M5 12h14" />
      {minus ? null : <path d="M12 5v14" />}
    </svg>
  );
}

/**
 * The standing accountability line for a control that records what it did.
 *
 * `LoggedButton` carries this under a button, but its caption is `.text-over`, which is uppercase,
 * and `SIMPLIFICATION-SPEC.md` section 5 bans uppercase on the coach surface. So the same registry
 * words and the same aria label render in the sentence face instead.
 */
function LoggedNote({
  actionKey,
  children,
}: {
  actionKey: keyof typeof AUDIT_ACTIONS;
  children?: ReactNode;
}) {
  const accountability = AUDIT_ACTIONS[actionKey];
  return (
    <span
      aria-label={accountability.ariaLabel}
      className="inline-flex items-center gap-[8px] text-[15px] text-[color:var(--muted)]"
    >
      <ShieldCheck aria-hidden className="size-[16px] flex-none" />
      {children ?? accountability.microcopy}
    </span>
  );
}

/**
 * A two-way choice, which is a segmented pair rather than a switch.
 *
 * The artboard draws both sides of every two-way with a word on it. A switch labelled only by the
 * row it sits in makes the reader work out what "on" means for that row, and both of the rows
 * using this ask a question whose two answers are not on and off.
 */
function TwoWay({
  ariaLabel,
  disabled,
  left,
  onChange,
  right,
  value,
}: {
  ariaLabel: string;
  disabled?: boolean;
  left: { value: string; label: string };
  right: { value: string; label: string };
  onChange(next: string): void;
  value: string | null;
}) {
  return (
    <div
      aria-label={ariaLabel}
      className="flex flex-none gap-[4px] rounded-[12px] border border-[var(--line)] bg-[var(--card)] p-[4px]"
      role="group"
    >
      {[left, right].map((option) => {
        const active = value === option.value;
        return (
          <button
            aria-pressed={active}
            className={
              "h-[44px] rounded-[9px] border px-[18px] text-[16px] leading-none whitespace-nowrap " +
              "disabled:opacity-50 " +
              (active
                ? "border-[var(--accent-edge)] bg-[var(--accent-wash-strong)] font-semibold text-[color:var(--ink)]"
                : "border-transparent font-medium text-[color:var(--muted)] hover:text-[color:var(--ink)]")
            }
            disabled={disabled}
            key={option.value}
            onClick={() => onChange(option.value)}
            type="button"
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** The Asked / Skipped switch: a word, then the 52x30 track the vocabulary draws. */
function RowSwitch({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange(next: boolean): void;
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={
        "inline-flex h-[44px] flex-none items-center gap-[10px] rounded-full border py-0 pr-[6px] " +
        "pl-[14px] text-[15px] font-semibold " +
        (checked
          ? "border-[var(--good-line)] bg-[var(--good-wash)] text-[color:var(--good-text)]"
          : "border-[var(--line)] bg-[var(--control-fill)] text-[color:var(--muted)]")
      }
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      {checked ? "Asked" : "Skipped"}
      <span
        aria-hidden
        className={
          "relative block h-[30px] w-[52px] rounded-full border " +
          (checked
            ? "border-[var(--good-line)] bg-[var(--good)]"
            : "border-[var(--line-input)] bg-[var(--card)]")
        }
      >
        <span
          className={
            "absolute top-[2px] size-[24px] rounded-full " +
            (checked ? "right-[2px] bg-[var(--on-accent)]" : "left-[2px] bg-[var(--faint)]")
          }
        />
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * The offer form
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

const BILLING_OPTIONS = [
  { value: "one_time", label: "one time" },
  { value: "monthly", label: "a month" },
  { value: "annual", label: "a year" },
] as const;

/**
 * The four numeric bounds, as steppers.
 *
 * `start` is what the first press of plus sets when nothing is saved. It is the coach's own press
 * that puts a number there, so no value is ever written that the coach did not ask for, and an
 * untouched row reads "Not set" rather than borrowing somebody else's floor.
 */
const BOUND_ROWS = [
  {
    key: "creditMin" as const,
    label: "Credit score at least",
    kind: "score" as const,
    step: 10,
    min: 300,
    max: 850,
    start: 600,
  },
  {
    key: "fundingGoalMinCents" as const,
    label: "Funding goal at least",
    kind: "money" as const,
    step: 500_000,
    min: 0,
    max: 100_000_000,
    start: 2_500_000,
  },
  {
    key: "fundingGoalMaxCents" as const,
    label: "Funding goal at most",
    kind: "money" as const,
    step: 2_500_000,
    min: 0,
    max: 500_000_000,
    start: 25_000_000,
  },
  {
    key: "monthlyRevenueMinCents" as const,
    label: "Monthly revenue at least",
    kind: "money" as const,
    step: 100_000,
    min: 0,
    max: 100_000_000,
    start: 800_000,
  },
];

type BoundKey = (typeof BOUND_ROWS)[number]["key"];

/**
 * Credit repair and refunds are four-value and three-value enums behind a two-way choice.
 *
 * The artboard asks one question with two answers, and the storage keeps more shades than that.
 * Collapsing them by writing one canonical value on every press would quietly rewrite a coach's
 * "extra fee" into "included" the first time they pressed the side they were already on. So each
 * side owns a group of stored values, the pressed side only writes its canonical value when the
 * current value is outside its own group, and a value already inside the group is left exactly as
 * it is.
 */
const CREDIT_REPAIR_FINE = ["yes_included", "yes_extra_fee"] as const;
const CREDIT_REPAIR_NOT = ["no_refer_out", "no_good_credit_only"] as const;
const REFUND_OFFERED = ["conditional", "published_policy"] as const;

function groupedChoice(
  current: string | null,
  group: readonly string[],
  canonical: string,
): string {
  return current !== null && group.includes(current) ? current : canonical;
}

const VOICE_STOPS = [
  { value: "friendly", label: "Friendly" },
  { value: "neutral", label: "Balanced" },
  { value: "professional", label: "Professional" },
] as const;

/**
 * The three short answers, in the artboard's wording.
 *
 * All three fields reach the reply pipeline as one unordered `voiceAnswers` list
 * (`src/lib/engine/pipeline.ts`), so no slot carries a meaning of its own at runtime and the
 * questions can be the plain ones the artboard asks rather than the field names.
 */
const VOICE_QUESTIONS = [
  {
    field: "voiceStyleAnswer" as const,
    label: "How do you describe what you do, in a sentence?",
  },
  {
    field: "voiceObjectionAnswer" as const,
    label: "What do clients usually walk away with?",
  },
  {
    field: "voiceFollowupAnswer" as const,
    label: "What should your agent never promise?",
  },
];

const PURPOSE_OPTIONS = OFFER_CADENCE_PURPOSES.map((value) => ({
  value,
  label: OFFER_CADENCE_PURPOSE_LABELS[value],
}));

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

/**
 * What SetterFi runs, as statements.
 *
 * `request` names the section a "Request a change" opens the support thread about. A statement
 * with no `request` is one nobody can change: quiet hours and opt-outs are compliance, and the
 * claim check is what stops the agent inventing a number.
 *
 * `proof` marks the one statement the saved proof points hang under. R4-20 ruled that proof is
 * never a destination of its own and moves without being copied, and `SIMPLIFICATION-SPEC.md` 2.4
 * then demoted the editor for it to an intake request. Both hold here: the coach reads what their
 * agent is allowed to cite in the same breath as the sentence saying it cites nothing else, and
 * there is no second place in the tree that draws it.
 */
const MANAGED_STATEMENTS: readonly {
  text: string;
  request: string | null;
  proof?: true;
}[] = [
  {
    text: "Your agent replies within a minute, day and night, on every channel that is live.",
    request: null,
  },
  {
    text: "It does not text anyone between 9 pm and 8 am in their own time zone.",
    request: null,
  },
  {
    text: "Anyone who says stop is opted out the same minute and never messaged again.",
    request: null,
  },
  {
    text:
      "It only claims what you have told us and never promises an approval, an amount or a " +
      "timeline.",
    request: null,
    proof: true,
  },
  {
    text: "A lead who asks for you by name is handed to you within a minute, and you get a text.",
    request: "Handing a lead to you",
  },
  {
    text: "Calls are booked into the open slots on your calendar as 30 minute appointments.",
    request: "How calls are booked",
  },
  {
    text: "Questions are written by SetterFi so every answer can be checked against your rules.",
    request: "The questions your agent asks",
  },
];

/* ------------------------------------------------------------------ *
 * Keyword goals
 * ------------------------------------------------------------------ */

type GoalRow = {
  /** Null for a keyword the coach has added on this visit and not yet saved. */
  id: string | null;
  localKey: string;
  keyword: string;
  goal: "resource" | "book";
  resourceUrl: string | null;
  resourceMessage: string | null;
  postBookingUrl: string | null;
  postBookingMessage: string | null;
};

function toGoalRow(goal: KeywordGoal): GoalRow {
  return {
    id: goal.id,
    localKey: goal.id,
    keyword: goal.keyword,
    goal: goal.goal,
    resourceUrl: goal.resourceUrl,
    resourceMessage: goal.resourceMessage,
    postBookingUrl: goal.postBookingUrl,
    postBookingMessage: goal.postBookingMessage,
  };
}

/** The reply a keyword gets: a booked call, or one of the links SetterFi holds for this coach. */
const BOOK_A_CALL = "book-a-call";

/* ------------------------------------------------------------------ *
 * The screen
 * ------------------------------------------------------------------ */

export function CoachAgent({
  cadence = { enabled: false, channels: [] },
  initialKeywordGoals,
  initialState,
  objections,
  questions,
  supportEnabled,
  testEnabled,
}: RehaulCoachAgentProps) {
  const loadedOffer = useMemo(
    () => editableOffer(initialState.draft ?? initialState.published),
    [initialState],
  );

  const [savedOffer, setSavedOffer] = useState(loadedOffer);
  const [draftId, setDraftId] = useState(initialState.draft?.id ?? null);
  const [contentHash, setContentHash] = useState(initialState.draft?.contentHash ?? null);
  const [form, setForm] = useState(loadedOffer);

  const [savedQuestions, setSavedQuestions] = useState(questions);
  const [questionRows, setQuestionRows] = useState(questions);

  const [savedGoals, setSavedGoals] = useState<readonly GoalRow[] | null>(
    initialKeywordGoals ? initialKeywordGoals.filter((row) => row.active).map(toGoalRow) : null,
  );
  const [goalRows, setGoalRows] = useState<readonly GoalRow[] | null>(savedGoals);
  const [goalsFailed, setGoalsFailed] = useState(false);
  const [activeKeyword, setActiveKeyword] = useState<string | null>(
    savedGoals?.[0]?.localKey ?? null,
  );
  const [adding, setAdding] = useState(false);
  const [newKeyword, setNewKeyword] = useState("");

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [requested, setRequested] = useState<Record<string, "sent" | "failed">>({});
  const nextLocalKey = useRef(0);

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
        const rows = (loaded as KeywordGoal[]).filter((row) => row.active).map(toGoalRow);
        setSavedGoals(rows);
        setGoalRows(rows);
        setActiveKeyword(rows[0]?.localKey ?? null);
      })
      .catch(() => {
        if (alive) setGoalsFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [initialKeywordGoals]);

  /* ---------------- dirty and undo ---------------- */

  const offerDirty = JSON.stringify(form) !== JSON.stringify(savedOffer);
  const questionsDirty = JSON.stringify(questionRows) !== JSON.stringify(savedQuestions);
  const goalsDirty = JSON.stringify(goalRows) !== JSON.stringify(savedGoals);
  const dirty = offerDirty || questionsDirty || goalsDirty;

  function undo() {
    setForm(savedOffer);
    setQuestionRows(savedQuestions);
    setGoalRows(savedGoals);
    setActiveKeyword(savedGoals?.[0]?.localKey ?? null);
    setAdding(false);
    setNewKeyword("");
    setNotice(null);
  }

  function updateForm<K extends keyof CoachOfferDraftInput>(
    key: K,
    value: CoachOfferDraftInput[K],
  ) {
    setForm((current) => ({ ...current, [key]: value }));
    setNotice(null);
  }

  /* ---------------- bounds ---------------- */

  /**
   * A bound moved by one step, clamped to its own range and then to its partner's.
   *
   * The offer boundary refuses a draft whose funding floor is above its ceiling, so a press that
   * would cross the pair moves the other side with it rather than composing a payload the server
   * will reject after the coach has pressed Save.
   */
  function stepBound(row: (typeof BOUND_ROWS)[number], direction: 1 | -1) {
    const current = form[row.key];
    const next =
      typeof current === "number"
        ? Math.min(row.max, Math.max(row.min, current + direction * row.step))
        : row.start;
    const patch: Partial<CoachOfferDraftInput> = { [row.key]: next };
    if (row.key === "fundingGoalMinCents") {
      const ceiling = form.fundingGoalMaxCents;
      if (ceiling !== null && next > ceiling) patch.fundingGoalMaxCents = next;
    }
    if (row.key === "fundingGoalMaxCents") {
      const floor = form.fundingGoalMinCents;
      if (floor !== null && next < floor) patch.fundingGoalMinCents = next;
    }
    setForm((state) => ({ ...state, ...patch }));
    setNotice(null);
  }

  function boundText(row: (typeof BOUND_ROWS)[number]) {
    const value = form[row.key];
    if (typeof value !== "number") return null;
    return row.kind === "money" ? money(value, "USD") : String(value);
  }

  /* ---------------- prices ---------------- */

  function updatePrice(index: number, patch: Partial<CoachOfferDraftInput["prices"][number]>) {
    updateForm(
      "prices",
      form.prices.map((price, at) => (at === index ? { ...price, ...patch } : price)),
    );
  }

  /* ---------------- cadence ---------------- */

  const cadenceSchedule = useMemo(
    () => coachCadenceSchedule(cadence.channels),
    [cadence.channels],
  );

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
      form.cadencePurposes.map((row, at) => (at === index ? { ...row, purpose } : row)),
    );
  }

  const followUpsSet = cadenceSchedule.every((group) =>
    group.touches.every(
      (touch) => savedPurposeFor(form.cadencePurposes, group.channelClass, touch.touchNo) !== null,
    ),
  );

  /* ---------------- questions ---------------- */

  function moveQuestion(id: string, direction: -1 | 1) {
    const rows = questionRows;
    if (!rows) return;
    const index = rows.findIndex((question) => question.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target], next[index]];
    setQuestionRows(next);
    setNotice(null);
  }

  function toggleQuestion(id: string, enabled: boolean) {
    setQuestionRows((rows) =>
      (rows ?? []).map((question) => (question.id === id ? { ...question, enabled } : question)),
    );
    setNotice(null);
  }

  /* ---------------- keywords ---------------- */

  const activeGoal = (goalRows ?? []).find((row) => row.localKey === activeKeyword) ?? null;

  function updateGoal(localKey: string, patch: Partial<GoalRow>) {
    setGoalRows((rows) => (rows ?? []).map((row) => (row.localKey === localKey ? { ...row, ...patch } : row)));
    setNotice(null);
  }

  function addKeyword() {
    const keyword = newKeyword.trim();
    if (!keyword) return;
    nextLocalKey.current += 1;
    const localKey = `new-${nextLocalKey.current}`;
    setGoalRows((rows) => [
      ...(rows ?? []),
      {
        id: null,
        localKey,
        keyword,
        goal: "book",
        resourceUrl: null,
        resourceMessage: null,
        postBookingUrl: null,
        postBookingMessage: null,
      },
    ]);
    setActiveKeyword(localKey);
    setAdding(false);
    setNewKeyword("");
    setNotice(null);
  }

  /** The replies a keyword can get: a booked call, or one of the links SetterFi holds. */
  const replyOptions = useMemo(
    () => [
      { value: BOOK_A_CALL, label: "A booked call" },
      ...form.assets.map((asset) => ({ value: asset.url, label: asset.label })),
    ],
    [form.assets],
  );

  /**
   * The reply currently selected for a keyword.
   *
   * A resource whose link is not one of the saved ones resolves to nothing rather than to the
   * first option, so the trigger shows the placeholder and the coach is not told a link is
   * selected that is not the one stored.
   */
  function replyValue(goal: GoalRow): string | undefined {
    if (goal.goal === "book") return BOOK_A_CALL;
    return replyOptions.some((option) => option.value === goal.resourceUrl)
      ? (goal.resourceUrl as string)
      : undefined;
  }

  function setReply(goal: GoalRow, next: string | null) {
    if (next === null) return;
    if (next === BOOK_A_CALL) {
      updateGoal(goal.localKey, { goal: "book", resourceUrl: null, resourceMessage: null });
      return;
    }
    const asset = form.assets.find((entry) => entry.url === next);
    updateGoal(goal.localKey, {
      goal: "resource",
      resourceUrl: next,
      resourceMessage: goal.resourceMessage ?? asset?.label ?? null,
    });
  }

  /* ---------------- save ---------------- */

  /**
   * The one Save. Questions first, then keywords, then the offer, then the publish.
   *
   * The order is the cheapest-to-reason-about one rather than an optimisation: the two side
   * stores write per row, so a failure part way through leaves the rows that did save saved and
   * says which ones did not. The offer is last because it is the only one that is a single
   * transaction, so a refusal there leaves nothing half written.
   */
  async function save() {
    setBusy(true);
    setNotice(null);
    const failures: string[] = [];

    let nextQuestions = savedQuestions;
    if (questionsDirty && questionRows) {
      const orderChanged =
        JSON.stringify(questionRows.map((row) => row.id)) !==
        JSON.stringify((savedQuestions ?? []).map((row) => row.id));
      if (orderChanged) {
        const result = await writeQuestions("PUT", { questionIds: questionRows.map((r) => r.id) });
        if (result) nextQuestions = result;
        else failures.push("the order your questions are asked in");
      }
      for (const question of questionRows) {
        const before = (savedQuestions ?? []).find((row) => row.id === question.id);
        if (before && before.enabled === question.enabled) continue;
        const result = await writeQuestions("PATCH", {
          questionId: question.id,
          enabled: question.enabled,
        });
        if (result) nextQuestions = result;
        else failures.push(`whether your agent asks "${question.text}"`);
      }
    }

    let nextGoals = savedGoals ?? [];
    if (goalsDirty && goalRows) {
      for (const goal of goalRows) {
        const before = (savedGoals ?? []).find((row) => row.localKey === goal.localKey);
        if (before && JSON.stringify(before) === JSON.stringify(goal)) continue;
        const saved = await writeGoal(goal);
        if (!saved) {
          failures.push(`the keyword ${goal.keyword}`);
          continue;
        }
        nextGoals = [
          ...nextGoals.filter((row) => row.localKey !== goal.localKey && row.id !== saved.id),
          saved,
        ];
        if (activeKeyword === goal.localKey) setActiveKeyword(saved.localKey);
      }
    }

    let nextOffer = savedOffer;
    let nextDraftId = draftId;
    let nextHash = contentHash;
    if (offerDirty) {
      const result = await writeOffer();
      if (result) {
        nextOffer = form;
        nextDraftId = result.id;
        nextHash = result.contentHash;
      } else {
        failures.push("your prices, who qualifies, how you sound and your follow-ups");
      }
    }

    setSavedQuestions(nextQuestions);
    setQuestionRows(nextQuestions);
    setSavedGoals(nextGoals);
    setGoalRows(nextGoals);
    setSavedOffer(nextOffer);
    setForm(nextOffer);
    setDraftId(nextDraftId);
    setContentHash(nextHash);
    setBusy(false);
    setNotice(
      failures.length === 0
        ? "Saved. Your agent is using this now."
        : `Some of this did not save: ${failures.join("; ")}. Nothing else was changed.`,
    );
  }

  async function writeQuestions(method: "PUT" | "PATCH", body: unknown) {
    try {
      const response = await fetch("/api/coach/questions", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const value: unknown = await response.json().catch(() => null);
      const payload = value as { questions?: CoachQuestion[]; audit?: { auditId?: string } } | null;
      if (!response.ok || !Array.isArray(payload?.questions) || !payload.audit?.auditId) return null;
      return payload.questions;
    } catch {
      return null;
    }
  }

  async function writeGoal(goal: GoalRow): Promise<GoalRow | null> {
    try {
      const response = await fetch("/api/coach/keyword-goals", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: goal.id,
          keyword: goal.keyword,
          goal: goal.goal,
          resourceUrl: goal.goal === "resource" ? goal.resourceUrl : null,
          resourceMessage: goal.goal === "resource" ? goal.resourceMessage : null,
          postBookingUrl: goal.postBookingUrl,
          postBookingMessage: goal.postBookingMessage,
        }),
      });
      const value: unknown = await response.json().catch(() => null);
      const payload = value as { goal?: KeywordGoal; audit?: { auditId?: string } } | null;
      if (!response.ok || !payload?.goal || !payload.audit?.auditId) return null;
      return toGoalRow(payload.goal);
    } catch {
      return null;
    }
  }

  /** Save the draft, then publish it, because the coach pressed one button meaning both. */
  async function writeOffer(): Promise<{ id: string; contentHash: string } | null> {
    try {
      const response = await fetch("/api/coach/offer", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          draftId,
          expectedContentHash: contentHash,
          offer: form,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) return null;
      const result = savedDraftView(payload);
      if (!result.saved || !result.draft) return null;
      /*
       * The publish is confirmed from its own receipt rather than from the status line: the
       * release boundary says an action is complete when a read-back says so, never on a 200.
       */
      const published = await fetch("/api/coach/offer/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          draftId: result.draft.id,
          expectedContentHash: result.draft.contentHash,
        }),
      });
      const receipt = publishedOfferView(await published.json().catch(() => null));
      if (!published.ok || !receipt.published) return null;
      return { id: result.draft.id, contentHash: result.draft.contentHash };
    } catch {
      return null;
    }
  }

  /**
   * The program name the offer boundary requires and this screen no longer edits.
   *
   * `SIMPLIFICATION-SPEC.md` 2.4 demotes "Your program" to an intake request, so it is not a field
   * here, but `validateCoachOfferDraft` still requires it. A tenant whose offer has never been
   * created has no name to carry through, and a save would be refused for a field the coach cannot
   * see. That is stated on the bar rather than discovered on the press.
   */
  const programMissing = !form.programName.trim();

  async function requestChange(section: string) {
    setRequested((current) => ({ ...current, [section]: "sent" }));
    try {
      const response = await fetch("/api/support/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subject: `Change request: ${section}`,
          body: `I would like to change how SetterFi handles this for my agent: ${section}.`,
        }),
      });
      if (!response.ok) throw new Error("SUPPORT_THREAD_REFUSED");
    } catch {
      setRequested((current) => ({ ...current, [section]: "failed" }));
    }
  }

  const pricesSet = form.prices.length > 0;
  const qualifiesSet = BOUND_ROWS.some((row) => typeof form[row.key] === "number");
  const voiceSet = Boolean(form.brandVoice);

  return (
    <div className="relative flex min-w-0 flex-col gap-[24px] pb-[var(--coach-bubble-reserve)]">
      <div className="flex flex-wrap items-end justify-between gap-[24px]">
        <div className="min-w-0">
          <h1 className="coach-page-title m-0">Your agent</h1>
          <p className={`mt-[12px] mb-0 max-w-[var(--measure-wide)] ${COACH_LEAD_CLASS}`}>
            Four things are yours. We run everything else.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-[12px]">
          {testEnabled ? (
            <Link className={SECONDARY_BUTTON_CLASS} href="/meet-agent" prefetch={false}>
              <ChatIcon aria-hidden className="size-[18px]" />
              Try a conversation
            </Link>
          ) : null}
          <ContextEye
            copy="These are the four things only you can tell us: what you charge, who is worth a call, how you want to sound, and what each follow-up is for. Everything under Keywords and questions is the start of a conversation: the word a lead sends you, what your agent sends back, and the order it asks in. SetterFi writes the questions themselves, picks how often and when a quiet lead is chased, checks every reply against what you are allowed to claim, and keeps the twelve objections your industry hears most answered in your voice. Top objections is a read of the last month of real conversations, so it changes on its own and there is nothing to set on it. One Save at the bottom saves all of it at once, and what you save is what your leads meet."
            placement="header"
            scale="coach"
            screen="coach-agent"
          />
        </div>
      </div>

      {notice ? (
        <p
          className={`m-0 rounded-[14px] border border-[var(--line)] bg-[var(--well)] px-[20px] py-[14px] text-[color:var(--body)] ${COACH_READING_CLASS}`}
          role="status"
        >
          {notice}
        </p>
      ) : null}

      {/*
       * No `items-start` on either grid. `.coach-panel` is already a flex column whose body
       * is `flex: 1`, so a stretched panel fills its cell without any further help: the rail
       * runs the height of the card block beside it, and two cards in a row end level.
       * Starting them instead left the rail a short card against a tall column and the
       * prices card 160px shorter than the one next to it.
       */}
      <div className="grid min-w-0 gap-[20px] md:grid-cols-2">
        <div className="contents">
          {/*
           * `display: contents` rather than a column box: the board flows its four cards
           * row by row, so prices sits beside how you sound and who qualifies beside the
           * follow-ups. Two real column boxes stack the two short cards against the one
           * tall card and leave half a screen of dead space under them, and dropping the
           * wrappers entirely would reflow the whole block for a layout-only change.
           */}
          <div className="contents">
            {/* Your prices */}
            <DeckPanel
              eyebrow="Yours"
              meta={<StatePill label={pricesSet ? "Set" : "Not set yet"} set={pricesSet} />}
              name="Your prices"
            >
              {/*
                * `flex-1` plus `mt-auto` on the dashed row: prices is the shortest card in its
                * row, so once the grid stretches it to match its neighbour the add control would
                * otherwise sit halfway up a card with a void beneath it. Anchored to the bottom
                * it reads as the card's own footer at any height.
                */}
              <div className="flex flex-1 flex-col gap-[12px]">
                {form.prices.map((price, index) => (
                  <div className={WELL_ROW_CLASS} key={`price-${index}`}>
                    <Input
                      aria-label={`Name of price ${index + 1}`}
                      className={`${FIELD_CLASS} flex-1 basis-[160px]`}
                      onChange={(event) => updatePrice(index, { label: event.target.value })}
                      value={price.label}
                    />
                    <label className="flex items-center gap-[6px]">
                      <span className={`${MONO_CLASS} text-[20px] text-[color:var(--ink)]`}>$</span>
                      <span className="sr-only">{`Amount of ${price.label || `price ${index + 1}`}`}</span>
                      <Input
                        aria-label={`Amount of ${price.label || `price ${index + 1}`}`}
                        className={`${FIELD_SHELL_CLASS} ${MONO_CLASS} w-[110px] text-[20px] font-medium`}
                        inputMode="numeric"
                        onChange={(event) => {
                          const raw = event.target.value.replace(/[^0-9]/gu, "");
                          updatePrice(index, { amountCents: Number(raw || 0) * 100 });
                        }}
                        value={String(Math.round(price.amountCents / 100))}
                      />
                    </label>
                    <Select
                      onValueChange={(next) =>
                        updatePrice(index, {
                          billingPeriod: next as "one_time" | "monthly" | "annual",
                        })
                      }
                      value={price.billingPeriod ?? "one_time"}
                    >
                      <SelectTrigger
                        aria-label={`How often ${price.label || `price ${index + 1}`} is charged`}
                        className={SELECT_TRIGGER_CLASS}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent align="start" alignItemWithTrigger={false}>
                        {BILLING_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <button
                      aria-label={`Remove ${price.label || `price ${index + 1}`}`}
                      className={`${ICON_BUTTON_CLASS} ml-auto`}
                      onClick={() =>
                        updateForm(
                          "prices",
                          form.prices.filter((_, at) => at !== index),
                        )
                      }
                      type="button"
                    >
                      <X aria-hidden className="size-[20px]" />
                    </button>
                  </div>
                ))}
                {form.prices.length === 0 ? (
                  <p className={ABSENCE_CLASS}>
                    No price is saved, so your agent quotes none.
                  </p>
                ) : null}
                <button
                  className={`${DASHED_ADD_CLASS} mt-auto`}
                  onClick={() =>
                    updateForm("prices", [
                      ...form.prices,
                      { label: "", amountCents: 0, billingPeriod: "one_time" as const },
                    ])
                  }
                  type="button"
                >
                  <Sign />
                  Add a price
                </button>
              </div>
            </DeckPanel>

            {/* How you sound */}
            <DeckPanel
              eyebrow="Yours"
              meta={<StatePill label={voiceSet ? "Set" : "Not set yet"} set={voiceSet} />}
              name="How you sound"
            >
              <div className="flex flex-col gap-[16px]">
                <div
                  aria-label="How your agent sounds"
                  className="flex gap-[4px] rounded-[12px] border border-[var(--line)] bg-[var(--well)] p-[4px]"
                  role="group"
                >
                  {VOICE_STOPS.map((stop) => {
                    const active = form.brandVoice === stop.value;
                    return (
                      <button
                        aria-pressed={active}
                        className={
                          "h-[44px] flex-1 rounded-[9px] border px-[12px] text-[16px] leading-none " +
                          (active
                            ? "border-[var(--accent-edge)] bg-[var(--accent-wash-strong)] font-semibold text-[color:var(--ink)]"
                            : "border-transparent font-medium text-[color:var(--muted)] hover:text-[color:var(--ink)]")
                        }
                        key={stop.value}
                        onClick={() =>
                          updateForm(
                            "brandVoice",
                            stop.value as CoachOfferDraftInput["brandVoice"],
                          )
                        }
                        type="button"
                      >
                        {stop.label}
                      </button>
                    );
                  })}
                </div>
                {VOICE_QUESTIONS.map((question) => (
                  <label className="block" key={question.field}>
                    <span className={`mb-[6px] block ${COACH_READING_CLASS} text-[color:var(--muted)]`}>
                      {question.label}
                    </span>
                    <Input
                      className={`${FIELD_CLASS} w-full`}
                      onChange={(event) =>
                        updateForm(question.field, event.target.value.trim() ? event.target.value : null)
                      }
                      value={form[question.field] ?? ""}
                    />
                  </label>
                ))}
              </div>
            </DeckPanel>
          </div>

          <div className="contents">
            {/* Who qualifies */}
            <DeckPanel
              eyebrow="Yours"
              meta={<StatePill label={qualifiesSet ? "Set" : "Not set yet"} set={qualifiesSet} />}
              name="Who qualifies"
            >
              <div className="flex flex-col gap-[12px]">
                {BOUND_ROWS.map((row) => {
                  const text = boundText(row);
                  return (
                    <div className={WELL_ROW_CLASS} key={row.key}>
                      <span className={`min-w-0 flex-1 ${COACH_ROW_NAME_CLASS} font-normal text-[color:var(--body)]`}>
                        {row.label}
                      </span>
                      <button
                        aria-label={`Lower ${row.label.toLowerCase()}`}
                        className={ICON_BUTTON_CLASS}
                        disabled={text === null}
                        onClick={() => stepBound(row, -1)}
                        type="button"
                      >
                        <Sign minus />
                      </button>
                      {text === null ? (
                        <span className="min-w-[96px] text-center text-[16px] text-[color:var(--muted)]">
                          Not set
                        </span>
                      ) : (
                        <span
                          className={`${MONO_CLASS} min-w-[96px] text-center text-[22px] font-medium text-[color:var(--ink)]`}
                        >
                          {text}
                        </span>
                      )}
                      <button
                        aria-label={`Raise ${row.label.toLowerCase()}`}
                        className={ICON_BUTTON_CLASS}
                        onClick={() => stepBound(row, 1)}
                        type="button"
                      >
                        <Sign />
                      </button>
                    </div>
                  );
                })}
                <div className={WELL_ROW_CLASS}>
                  <span className={`min-w-0 flex-1 ${COACH_ROW_NAME_CLASS} font-normal text-[color:var(--body)]`}>
                    Needs credit repair first
                  </span>
                  <TwoWay
                    ariaLabel="A lead who needs credit repair first"
                    left={{ value: "fine", label: "Fine" }}
                    onChange={(next) =>
                      updateForm(
                        "creditRepair",
                        (next === "fine"
                          ? groupedChoice(form.creditRepair, CREDIT_REPAIR_FINE, "yes_included")
                          : groupedChoice(
                              form.creditRepair,
                              CREDIT_REPAIR_NOT,
                              "no_good_credit_only",
                            )) as CoachOfferDraftInput["creditRepair"],
                      )
                    }
                    right={{ value: "not", label: "Not a fit" }}
                    value={
                      form.creditRepair === null
                        ? null
                        : CREDIT_REPAIR_FINE.includes(
                              form.creditRepair as (typeof CREDIT_REPAIR_FINE)[number],
                            )
                          ? "fine"
                          : "not"
                    }
                  />
                </div>
                <div className={WELL_ROW_CLASS}>
                  <span className={`min-w-0 flex-1 ${COACH_ROW_NAME_CLASS} font-normal text-[color:var(--body)]`}>
                    Refunds
                  </span>
                  <TwoWay
                    ariaLabel="Whether you offer refunds"
                    left={{ value: "offered", label: "Offered" }}
                    onChange={(next) =>
                      updateForm(
                        "refundPosture",
                        (next === "offered"
                          ? groupedChoice(form.refundPosture, REFUND_OFFERED, "conditional")
                          : "none") as CoachOfferDraftInput["refundPosture"],
                      )
                    }
                    right={{ value: "none", label: "Not offered" }}
                    value={
                      form.refundPosture === null
                        ? null
                        : form.refundPosture === "none"
                          ? "none"
                          : "offered"
                    }
                  />
                </div>
              </div>
            </DeckPanel>

            {/* What each follow-up says */}
            <DeckPanel
              eyebrow="Yours"
              meta={
                <StatePill
                  label={followUpsSet ? "Set" : "Some left to set"}
                  set={followUpsSet}
                />
              }
              name="What each follow-up says"
            >
              <div className="flex flex-col gap-[14px]">
                <p className={`m-0 max-w-[var(--measure-tight)] ${COACH_LEAD_CLASS} text-[color:var(--body)]`}>
                  {cadence.enabled
                    ? "When a lead goes quiet, your agent follows up on our schedule and then stops. We pick the timing, you pick what each one is for."
                    : "Follow-up is not switched on yet, so nothing is being sent. What you set here is kept and used the day it is."}
                </p>
                {cadenceSchedule.map((group) => (
                  <div className="flex flex-col gap-[10px]" key={group.channelClass}>
                    <span className={`block ${COACH_EYEBROW_CLASS}`}>{group.channelLabel}</span>
                    {group.touches.map((touch) => (
                      /*
                       * The board runs the sentence and its field inline on one wrapping row,
                       * which works there because its timings are three invented short phrases.
                       * The real schedule says things like "22 hours before the reply window
                       * closes", so an inline row breaks on some touches and not others and the
                       * card reads as a ragged stack of half-lines. Stacking every touch keeps
                       * the board's one-field-per-touch shape and reads the same on all seven.
                       */
                      <div
                        className="flex flex-col items-start gap-[6px]"
                        data-touch={`${group.channelClass}:${touch.touchNo}`}
                        key={`${group.channelClass}:${touch.touchNo}`}
                      >
                        <span className={`${COACH_LEAD_CLASS} text-[color:var(--body)]`}>
                          {`${touch.when.charAt(0).toUpperCase()}${touch.when.slice(1)} it will`}
                        </span>
                        <Select
                          onValueChange={(next) =>
                            setCadencePurpose(
                              group.channelClass,
                              touch.touchNo,
                              (next || touch.defaultPurpose) as OfferCadencePurpose,
                            )
                          }
                          value={
                            savedPurposeFor(
                              form.cadencePurposes,
                              group.channelClass,
                              touch.touchNo,
                            ) ?? touch.defaultPurpose
                          }
                        >
                          <SelectTrigger
                            aria-label={`What ${group.channelLabel} follow-up ${touch.touchNo} says`}
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
                    ))}
                  </div>
                ))}
              </div>
            </DeckPanel>
          </div>
        </div>

      </div>

      {/*
       * The two list panels share a row rather than one of them standing as a third column beside
       * the cards. Both grow with the same kind of content, objection rows against keyword and
       * question rows, so their heights track each other on a populated tenant. A rail in its own
       * column had no such partner: stretched to the height of the card block it opened a 700px
       * hole between its rows and its closing line, and left short it read as a ragged stub.
       */}
      <div className="grid min-w-0 gap-[20px] md:grid-cols-2">
        <DeckPanel eyebrow="Read only" name="Top objections">
          <ObjectionsBody objections={objections} />
        </DeckPanel>

        <DeckPanel
          eyebrow="How a conversation starts"
          name="Keywords and questions"
        >
        <div className="flex flex-1 flex-col gap-[18px]">
          {goalsFailed ? (
            <p className={ABSENCE_CLASS}>
              Your keywords could not be read just now.
            </p>
          ) : goalRows === null ? (
            <p className={`m-0 ${COACH_READING_CLASS} text-[color:var(--muted)]`}>
              Reading your keywords.
            </p>
          ) : goalRows.length === 0 ? (
            <p className={ABSENCE_CLASS}>
              No keyword is set up yet.
            </p>
          ) : activeGoal ? (
            <div className={`flex flex-wrap items-center gap-[6px_10px] ${COACH_LEAD_CLASS} text-[color:var(--body)]`}>
              <span>When someone DMs you with</span>
              <Select
                onValueChange={(next) => setActiveKeyword(next)}
                value={activeGoal.localKey}
              >
                <SelectTrigger aria-label="Which keyword" className={SELECT_TRIGGER_CLASS}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start" alignItemWithTrigger={false}>
                  {goalRows.map((goal) => (
                    <SelectItem key={goal.localKey} value={goal.localKey}>
                      {goal.keyword}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span>your agent replies with</span>
              <Select
                onValueChange={(next) => setReply(activeGoal, next)}
                value={replyValue(activeGoal)}
              >
                <SelectTrigger aria-label="What your agent replies with" className={SELECT_TRIGGER_CLASS}>
                  <SelectValue placeholder="Choose a reply" />
                </SelectTrigger>
                <SelectContent align="start" alignItemWithTrigger={false}>
                  {replyOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span>and then asks these questions, in this order.</span>
            </div>
          ) : null}

          {/*
            The link list is SetterFi's to hold, not the coach's to type: "Marketing assets" is
            demoted to an intake request, so a coach with no saved link is told where one comes
            from rather than shown an empty field they cannot fill.
          */}
          {goalRows && goalRows.length > 0 && form.assets.length === 0 ? (
            <p className={`m-0 ${COACH_FOOTNOTE_CLASS}`}>
              We hold no links for you yet, so a booked call is the only reply your agent can send.
              Send us anything you want it to share and we will add it.
            </p>
          ) : null}

          <QuestionRows
            onMove={moveQuestion}
            onToggle={toggleQuestion}
            rows={questionRows}
          />

          <div className="mt-auto flex flex-wrap items-center gap-[12px]">
            {adding ? (
              <>
                <label className="flex min-w-0 flex-1 basis-[220px] items-center gap-[12px]">
                  <span className={`${COACH_READING_CLASS} flex-none text-[color:var(--muted)]`}>
                    New keyword
                  </span>
                  <Input
                    className={`${FIELD_CLASS} min-w-0 flex-1`}
                    onChange={(event) => setNewKeyword(event.target.value)}
                    value={newKeyword}
                  />
                </label>
                <button
                  className={SECONDARY_BUTTON_CLASS}
                  disabled={!newKeyword.trim()}
                  onClick={addKeyword}
                  type="button"
                >
                  Add it
                </button>
                <button
                  className={SECONDARY_BUTTON_CLASS}
                  onClick={() => {
                    setAdding(false);
                    setNewKeyword("");
                  }}
                  type="button"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                className={SECONDARY_BUTTON_CLASS}
                disabled={goalRows === null}
                onClick={() => setAdding(true)}
                type="button"
              >
                <Sign />
                Add another keyword
              </button>
            )}
          </div>
        </div>
        </DeckPanel>
      </div>

      {/* What SetterFi handles for you */}
      <DeckPanel eyebrow="We run everything else" name="What SetterFi handles for you">
        <ul className="m-0 flex list-none flex-col p-0">
          {MANAGED_STATEMENTS.map((statement) => (
            <li
              className="flex items-start gap-[12px] border-t border-[var(--line-soft)] py-[12px] first:border-t-0"
              key={statement.text}
            >
              <Check aria-hidden className="mt-[4px] size-[20px] flex-none text-[color:var(--good)]" />
              <span className={`${COACH_LEAD_CLASS} text-[color:var(--body)]`}>
                {statement.text}
                {statement.request && supportEnabled ? (
                  <>
                    {" "}
                    {requested[statement.request] === "sent" ? (
                      <span className="text-[color:var(--good-text)]">
                        Asked. Your success team will reply in Help.
                      </span>
                    ) : requested[statement.request] === "failed" ? (
                      <span className="text-[color:var(--warning-text)]">
                        That request did not reach us. Try again from Help.
                      </span>
                    ) : (
                      <button
                        className="my-[-10px] inline-flex min-h-[44px] items-center px-[2px] text-[color:var(--accent-text)] underline-offset-[3px] hover:underline"
                        onClick={() => void requestChange(statement.request as string)}
                        type="button"
                      >
                        Request a change
                      </button>
                    )}
                  </>
                ) : null}
                {statement.proof ? (
                  form.proof.length ? (
                    <ul className="mt-[8px] mb-0 flex list-none flex-col gap-[6px] p-0">
                      {form.proof.map((entry, index) => (
                        <li className={COACH_FOOTNOTE_CLASS} key={`${entry.title}-${index}`}>
                          {`${entry.title}: ${entry.detail}`}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className={`mt-[8px] mb-0 ${COACH_FOOTNOTE_CLASS}`}>
                      You have sent us no proof points yet, so it cites none.
                    </p>
                  )
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </DeckPanel>

      {/*
       * One Save. No draft, no publish.
       *
       * `--coach-bubble-reserve` reserves the launcher's corner as page padding, which keeps a
       * document-flow page clear of it. A bar pinned to the viewport bottom is not in that flow, so
       * without a horizontal reserve the 60px launcher at its 32px offset lands on top of Save.
       * The reserve is on the bar rather than in `coach.css` because the CSS is frozen for this
       * round; the shared rule this wants is recorded in the report.
       */}
      <div
        className={
          "sticky bottom-0 z-[1] -mx-[var(--s-5)] flex flex-wrap items-center justify-between "
          + "gap-[16px] border-t border-[var(--line)] bg-[var(--pane)] px-[var(--s-5)] py-[18px] "
          + (supportEnabled ? "pe-[calc(var(--s-5)+108px)]" : "")
        }
      >
        <div className="flex min-w-0 flex-col gap-[4px]">
          <span className={`${COACH_READING_CLASS} text-[color:var(--muted)]`}>
            {programMissing
              ? "Your program details have not reached us yet, so nothing here can be saved. Ask your success team to add them."
              : "Changes go live when you save."}
          </span>
          <LoggedNote actionKey="offer.published">Every save is recorded.</LoggedNote>
        </div>
        <div className="flex flex-wrap gap-[12px]">
          <button
            className={SECONDARY_BUTTON_CLASS}
            disabled={busy || !dirty}
            onClick={undo}
            type="button"
          >
            Undo my changes
          </button>
          <button
            className={ACCENT_BUTTON_CLASS}
            disabled={busy || !dirty || programMissing}
            onClick={() => void save()}
            type="button"
          >
            {busy ? "Saving" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The question rows
 * ------------------------------------------------------------------ */

/**
 * The ordered question list, with arrows rather than drag.
 *
 * `SIMPLIFICATION-SPEC.md` Q3's recommended default was a sentence and a change request; the
 * client asked again for a control, and the playbook records that reversal as awaiting his word.
 * The control is Asana's: an explicit up and a down button at a full target beside a labelled
 * switch. Drag is the shortcut for people who can drag; arrows are the path everybody has.
 */
function QuestionRows({
  onMove,
  onToggle,
  rows,
}: {
  onMove(id: string, direction: -1 | 1): void;
  onToggle(id: string, enabled: boolean): void;
  rows: readonly CoachQuestion[] | null;
}) {
  if (rows === null) {
    return (
      <p className={ABSENCE_CLASS}>
        Your questions could not be read just now.
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className={ABSENCE_CLASS}>
        No question is set up yet.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-[10px]">
      {rows.map((question, index) => (
        <div
          className={`${WELL_ROW_CLASS} gap-[14px]`}
          data-question={question.id}
          key={question.id}
        >
          <span className={`${MONO_CLASS} w-[28px] flex-none text-[17px] text-[color:var(--muted)]`}>
            {index + 1}
          </span>
          <span
            className={
              "min-w-0 flex-1 basis-[240px] " +
              COACH_ROW_NAME_CLASS +
              (question.enabled ? "" : " text-[color:var(--muted)]!")
            }
          >
            {question.text}
          </span>
          <span className="flex flex-none items-center gap-[6px]">
            <button
              aria-label={`Ask "${question.text}" earlier`}
              className={ICON_BUTTON_CLASS}
              disabled={index === 0}
              onClick={() => onMove(question.id, -1)}
              type="button"
            >
              <ArrowUp aria-hidden className="size-[20px]" />
            </button>
            <button
              aria-label={`Ask "${question.text}" later`}
              className={ICON_BUTTON_CLASS}
              disabled={index === rows.length - 1}
              onClick={() => onMove(question.id, 1)}
              type="button"
            >
              <ArrowDown aria-hidden className="size-[20px]" />
            </button>
          </span>
          <RowSwitch
            checked={question.enabled}
            label={`Ask "${question.text}"`}
            onChange={(next) => onToggle(question.id, next)}
          />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The objections rail
 * ------------------------------------------------------------------ */

/**
 * The read-only rail. A share bar per objection, and a sentence saying what the share is.
 *
 * A row whose booked rate is undefined draws no bar. The artboard prints a percentage and a
 * qualitative clause beside it ("Most of them booked anyway"), which is the same fact twice on one
 * line, so the clause is dropped and the percentage stays.
 */
function ObjectionsBody({ objections }: { objections: CoachAgentObjections | null }) {
  if (objections === null) {
    return (
      <p className={ABSENCE_CLASS}>
        Your objections could not be read just now.
      </p>
    );
  }
  if (objections.rows.length === 0) {
    return (
      <p className={ABSENCE_CLASS}>
        No lead has pushed back yet in this period.
      </p>
    );
  }
  return (
    <>
      <div className="flex flex-col">
        {objections.rows.map((row) => (
          <div
            className="border-t border-[var(--line-soft)] py-[16px] first:border-t-0 first:pt-0"
            data-objection={row.objectionId}
            key={row.objectionId}
          >
            <div className="mb-[8px] flex items-baseline justify-between gap-[12px]">
              <span className={COACH_ROW_NAME_CLASS}>{`“${row.label}”`}</span>
              {row.bookedRate === null ? null : (
                <span className={`${MONO_CLASS} flex-none text-[17px] text-[color:var(--ink)]`}>
                  {`${Math.round(row.bookedRate * 100)}%`}
                </span>
              )}
            </div>
            {row.bookedRate === null ? null : (
              <div className="mb-[8px] h-[8px] overflow-hidden rounded-full bg-[var(--band)]">
                <div
                  className="h-full rounded-full bg-[var(--accent)] opacity-55"
                  style={{ width: `${Math.round(row.bookedRate * 100)}%` }}
                />
              </div>
            )}
            <p className={`m-0 ${COACH_FOOTNOTE_CLASS}`}>
              {row.bookedRate === null
                ? `Said ${row.conversationCount} times in the last ${objections.windowDays} days. No booking share is defined for it yet.`
                : `Said ${row.conversationCount} times in the last ${objections.windowDays} days.`}
            </p>
          </div>
        ))}
      </div>
      <p className={`mt-auto mb-0 border-t border-[var(--line-soft)] pt-[16px] ${COACH_FOOTNOTE_CLASS}`}>
        The share is how many of the leads who said it still booked a call.
      </p>
    </>
  );
}
