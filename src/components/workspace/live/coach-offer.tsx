"use client";

import {
  Bot,
  CircleAlert,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

import { CurrencyInput } from "@/components/kit/currency-input";
import { TitlePanel } from "@/components/kit/deck-panel";
import { ExportMenu } from "@/components/kit/export-menu";
import { Field } from "@/components/kit/field";
import { LoggedButton } from "@/components/kit/logged-button";
import { StateBadge } from "@/components/kit/state-badge";
import { TechnicalDetail } from "@/components/kit/technical-detail";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/kit/tooltip";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select as BaseSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { COACH_SURFACE_TITLE_CLASS } from "@/components/workspace/live/coach-type";
import { OFFER_BOUNDS, OFFER_PRODUCTS } from "@/lib/brain/contracts";
import { money } from "@/lib/format/metric";
import { humanError } from "@/lib/copy/errors";
import {
  OFFER_CADENCE_CHANNEL_LABELS,
  OFFER_CADENCE_PURPOSE_LABELS,
  OFFER_CADENCE_PURPOSES,
  type CoachCadencePurposeInput,
  type CoachOfferDraftInput,
  type PersistedOfferLayer,
} from "@/lib/offer/types";
import type { TestAgentTurnReceipt } from "@/lib/repositories/test-agent";

import {
  coachCadenceSchedule,
  type CoachCadenceChannel,
  type CoachCadenceScheduleClass,
  type CoachCadenceScheduleGroup,
} from "./coach-agent";
import {
  BRAND_VOICE_LABELS,
  COACH_OWNED_SECTIONS,
  qualificationFacts,
} from "./coach-owned-sections";
import { CoachPageHead } from "./coach-page-head";
import { COACH_TOP_OBJECTION_COLUMNS } from "./measurement-view-models";
import { AvailabilityPanel, type AvailabilityPanelProps } from "./offer-editor-availability";
import { DisqualifiersPanel } from "./offer-editor-disqualifiers";
import { PricesPanel } from "./offer-editor-prices";
import { VoicePanel, type VoiceRegister } from "./offer-editor-voice";
import {
  nullableNumber,
  nullableNumberFieldError,
  publishedOfferView,
  savedDraftView,
  type CoachOfferInitialState,
} from "./offer-view-models";

type OfferTab =
  | "business"
  | "qualification"
  | "voice"
  | "prices"
  | "assets"
  | "cadence";

type EditableOfferTab = OfferTab;
type RepeatKind = "prices" | "assets" | "proof" | "cadencePurposes";
type RepeatIds = Record<RepeatKind, string[]>;
type Removal = { kind: RepeatKind; id: string; label: string } | null;
type TraceView = "conversation" | "trace";

type TraceTurn = {
  id: string;
  input: string;
  receipt: TestAgentTurnReceipt;
  gates: Array<{
    id: string;
    check: TestAgentTurnReceipt["trace"]["checks"][number];
  }>;
};

type SelectOption = {
  value: string;
  label: string;
};

/** What a section currently answers, and whether that answer came from the coach or from us. */
type SectionAnswerValue = { set: boolean; text: string };

const EMPTY_SELECT_VALUE = "__not_set__";
const TAB_LABELS: Record<OfferTab, string> = {
  business: "Your program",
  qualification: "Who qualifies",
  voice: "How you sound",
  prices: "Prices",
  assets: "Marketing assets",
  cadence: "Follow-up",
};
const TAB_ORDER: readonly OfferTab[] = [
  "business",
  "qualification",
  "voice",
  "prices",
  "assets",
  "cadence",
];
const OFFER_PRODUCT_LABELS: Record<(typeof OFFER_PRODUCTS)[number], string> = {
  "personal CC": "Personal credit cards",
  "personal loans": "Personal loans",
  "biz CC": "Business credit cards",
  "biz line of credit": "Business line of credit",
  "biz term loans": "Business term loans",
};

const BLANK_OFFER: CoachOfferDraftInput = {
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

function clientId() {
  return crypto.randomUUID();
}

function editableOffer(offer: PersistedOfferLayer | null): CoachOfferDraftInput {
  if (!offer) return BLANK_OFFER;
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

function repeatIds(offer: PersistedOfferLayer | null): RepeatIds {
  return {
    prices: offer?.offerPrices.map((row) => row.id) ?? [],
    assets: offer?.assets.map((row) => row.id) ?? [],
    proof: offer?.proof.map((row) => row.id) ?? [],
    cadencePurposes: offer?.cadencePurposes.map(() => clientId()) ?? [],
  };
}

class OfferRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function refusalCode(cause: unknown, fallback: string) {
  return cause instanceof OfferRequestError ? cause.code : fallback;
}

async function jsonRequest(
  path: string,
  method: "PUT" | "POST",
  body: Record<string, unknown>,
) {
  const response = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const value =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : {};
    throw new OfferRequestError(
      typeof value.code === "string" ? value.code : `HTTP_${response.status}`,
    );
  }
  return payload;
}

async function requestTestSession(signal: AbortSignal) {
  const response = await fetch("/api/agent", {
    cache: "no-store",
    signal,
  });
  const payload: unknown = await response.json();
  if (
    !response.ok ||
    !payload ||
    typeof payload !== "object" ||
    !("sessionId" in payload) ||
    typeof payload.sessionId !== "string"
  ) {
    const value =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : {};
    throw new OfferRequestError(
      typeof value.code === "string" ? value.code : `HTTP_${response.status}`,
    );
  }
  return payload.sessionId;
}

function isTestTurnReceipt(payload: unknown): payload is TestAgentTurnReceipt {
  if (!payload || typeof payload !== "object") return false;
  const value = payload as Partial<TestAgentTurnReceipt>;
  return (
    value.state === "persisted" &&
    value.isTest === true &&
    Boolean(value.turn) &&
    Boolean(value.trace)
  );
}

function responseErrorCode(payload: unknown, status: number) {
  const value =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  return typeof value.code === "string" ? value.code : `HTTP_${status}`;
}

async function consumeTestAgentStream(
  response: Response,
  onTrace: (receipt: TestAgentTurnReceipt) => void,
) {
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throw new OfferRequestError(responseErrorCode(payload, response.status));
  }
  // The runtime today answers with one buffered JSON trace receipt; a streaming transport, when
  // it exists, emits the same receipt as SSE trace events. Accept both, invent neither.
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const payload: unknown = await response.json().catch(() => null);
    if (!isTestTurnReceipt(payload)) {
      throw new OfferRequestError("TEST_AGENT_TRACE_EVENT_INVALID");
    }
    onTrace(payload);
    return;
  }
  if (!response.body) {
    throw new OfferRequestError("TEST_AGENT_STREAM_UNAVAILABLE");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let receivedTrace = false;

  function consumeFrame(frame: string) {
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (eventName !== "trace" || !dataLines.length) return;
    const payload: unknown = JSON.parse(dataLines.join("\n"));
    if (!isTestTurnReceipt(payload)) {
      throw new OfferRequestError("TEST_AGENT_TRACE_EVENT_INVALID");
    }
    receivedTrace = true;
    onTrace(payload);
  }

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      if (frame.trim()) consumeFrame(frame);
    }
    if (done) break;
  }
  if (buffer.trim()) consumeFrame(buffer);
  if (!receivedTrace) throw new OfferRequestError("TEST_AGENT_TRACE_EVENT_MISSING");
}

/** The purpose a coach actually saved for a fixed platform touch, or null when none is saved. */
function savedPurposeFor(
  rows: readonly CoachCadencePurposeInput[],
  channelClass: CoachCadenceScheduleClass,
  touchNo: number,
) {
  return (
    rows.find(
      (row) => row.channelClass === channelClass && row.touchNo === touchNo,
    )?.purpose ?? null
  );
}

/**
 * The escalation source for the attention queue, read on the server behind the same
 * `phase3Live() && inboxVerbsLive()` gate the claim writer is behind. Absent means the gate is
 * off or nothing is escalated; either way no count is advertised.
 */
export type CoachEscalationSummary = {
  count: number;
  /** The oldest waiting lead's name, or null when the contact row has none. */
  leadHandle: string | null;
  /** Time the oldest thread has waited, or null when `needs_human_at` is not set. */
  waitingLabel: string | null;
};

/**
 * The six qualification columns the agent actually reads. One list, so the setup blocker, the
 * section pill, and the rail count can never drift apart or from a literal, which is the same
 * stale-numeral failure as the strip's "nine" and the header's "five".
 */
function qualificationValues(form: CoachOfferDraftInput) {
  return qualificationFacts(form);
}

/**
/*
 * Artifact geometry, written once so every card takes an identical face and only its interior
 * differs. The thesis of the design is that no two card interiors are alike; the frame around
 * them has to be the constant that makes that legible.
 */
/*
 * `.surface-card` and `.surface-well` in globals.css carry the face, the radius, the shadow and
 * the padding, and `.surface-card[data-open="true"]` carries the open state, so the open card
 * needs no second class string: the attribute is the switch. What stays here is layout the
 * recipe has no opinion about, plus the container the editors inside size themselves against.
 */
const CARD_FACE_CLASS = "surface-card @container/card flex min-w-0 flex-col";
const WELL_CLASS = "surface-well min-w-0";

/*
 * The coach scale, and the reason it is written here rather than taken from the kit.
 *
 * Everything below used to be sized for the owner console: a 9.5px uppercase mono overline, 15px
 * card titles, 12.5px subtitles, 13px rows, a 29px Edit button and a 34px fill. That scale is for
 * someone in the product all day with a mouse, and it is the exact thing the round-1 coaches
 * described when they called this screen confusing. `coach.css` raises the body to 16px and the
 * pressable floor to 44px for the whole shell; these recipes carry the same decision into the
 * parts of a card the stylesheet has no selector for.
 *
 * The eyebrow is the load-bearing change. `OVERLINE_CLASS` was 9.5px uppercase mono, which is the
 * worst legibility case in the product, and it is replaced everywhere on this surface by 12px
 * sentence case. The atomic and `overline-size.test.ts` are untouched: the overline still exists
 * and is still 9.5px, it just has no callers here.
 */
const EYEBROW_CLASS =
  "block text-[length:var(--coach-eyebrow)] leading-[1.4] text-[color:var(--muted)]";
/* 44px, the floor `coach.css` states for anything a coach presses. There are no exceptions here. */
/*
 * What is left of `OfferCard` after the shape moved to `TitlePanel`, and it is deliberately a
 * class rather than a component.
 *
 * The three parts that were genuinely this page's stay here: the artboard's own `26px 28px`
 * padding, and the container name four editor grids inside these cards query with `@md/card:`.
 * The shape -- the 22px/600 title, its sentence, and the row that holds a status pill hard right
 * against them -- was an exact second copy of the recipe `deck-panel.tsx` now exports, down to the
 * tracking, and a second copy of a shape is how two cards that are meant to be one card drift.
 */
const OFFER_CARD_CLASS = "@container/card px-[28px] py-[26px]";
/* The statement rows under "What SetterFi handles for you": a check, then one plain sentence. */
const STATEMENT_CLASS =
  "flex items-start gap-[12px] text-[17px] leading-[1.5] text-[color:var(--body)]";

/**
 * The page's one primary, at `--coach-target-primary`. Exactly one control on the page may wear
 * it, and it is the save bar's live verb -- the thing a coach came here to press.
 */
const PRIMARY_FILL_CLASS =
  "inline-flex h-[var(--coach-target-primary)] items-center justify-center rounded-[9px] border border-[var(--accent-line)] bg-[var(--accent-fill)] px-[30px] text-[17px] leading-none font-semibold text-[color:var(--on-accent)] shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_8px_20px_-8px_var(--accent)]";
/** The neutral twin of the fill, for a secondary action at the same height. */
const QUIET_BUTTON_CLASS =
  "inline-flex h-[48px] items-center justify-center gap-[10px] rounded-[9px] border border-[var(--line)] bg-[var(--control-fill)] px-[22px] text-[length:var(--coach-body)] leading-none font-medium text-[color:var(--body)] hover:border-[var(--accent-edge)] hover:text-[color:var(--ink)]";

/**
 * One fixed template per threshold column, rendered from the stored number. Never free text and
 * never a paraphrase, so the line cannot drift from the value it reads. The wording deliberately
 * describes what the agent KNOWS rather than what it enforces: the disqualification outcome is
 * decided by the platform's own rules table, so a sentence promising this number turns a lead
 * away would claim an authority these columns do not carry.
 */
const THRESHOLD_TEMPLATES: readonly {
  key: string;
  label: string;
  sentence: (form: CoachOfferDraftInput) => { set: boolean; text: string };
}[] = [
  {
    key: "creditMin",
    label: "Minimum credit score",
    sentence: (form) => ({
      set: form.creditMin !== null,
      text:
        form.creditMin === null
          ? "Credit score below your minimum"
          : `Credit score below ${form.creditMin}`,
    }),
  },
  {
    key: "fundingGoalMinCents",
    label: "Minimum funding goal",
    sentence: (form) => ({
      set: form.fundingGoalMinCents !== null,
      text:
        form.fundingGoalMinCents === null
          ? "Looking for less than your minimum"
          : `Looking for less than ${money(form.fundingGoalMinCents, "USD")}`,
    }),
  },
  {
    key: "fundingGoalMaxCents",
    label: "Maximum funding goal",
    sentence: (form) => ({
      set: form.fundingGoalMaxCents !== null,
      text:
        form.fundingGoalMaxCents === null
          ? "Looking for more than your maximum"
          : `Looking for more than ${money(form.fundingGoalMaxCents, "USD")}`,
    }),
  },
  {
    key: "monthlyRevenueMinCents",
    label: "Minimum monthly revenue",
    sentence: (form) => ({
      set: form.monthlyRevenueMinCents !== null,
      text:
        form.monthlyRevenueMinCents === null
          ? "Making under your monthly minimum"
          : `Making under ${money(form.monthlyRevenueMinCents, "USD")} a month`,
    }),
  },
  {
    key: "creditRepair",
    label: "Credit repair",
    sentence: (form) => {
      const wording: Record<string, string> = {
        yes_included: "Needs credit repair first, and yours includes it",
        yes_extra_fee: "Needs credit repair first, which costs extra with you",
        no_refer_out: "Needs credit repair first, so you refer them out",
        no_good_credit_only: "Needs credit repair first, which you do not take on",
      };
      return {
        set: form.creditRepair !== null,
        text:
          form.creditRepair === null
            ? "Needs credit repair first"
            : wording[form.creditRepair] ?? "Needs credit repair first",
      };
    },
  },
];


function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Every section states its own answer beside its title, so an empty section announces itself
 * without being opened. `set` is true only where the coach actually saved something: a control
 * they have never touched stays neutral even when the platform has a default for it.
 */
function sectionAnswers(
  form: CoachOfferDraftInput,
  schedule: readonly CoachCadenceScheduleGroup[],
): Record<OfferTab, SectionAnswerValue> {
  const programName = form.programName.trim();
  const qualification = qualificationValues(form);
  const rules = qualification.filter((value) => value !== null).length;
  const voiceAnswers = [
    form.voiceStyleAnswer,
    form.voiceObjectionAnswer,
    form.voiceFollowupAnswer,
  ].filter((value) => Boolean(value && value.trim())).length;
  const voiceLabel = form.brandVoice ? BRAND_VOICE_LABELS[form.brandVoice] : null;
  const scheduledTouches = schedule.reduce(
    (total, group) => total + group.touches.length,
    0,
  );
  const chosenPurposes = schedule.reduce(
    (total, group) =>
      total +
      group.touches.filter(
        (touch) =>
          savedPurposeFor(
            form.cadencePurposes,
            group.channelClass,
            touch.touchNo,
          ) !== null,
      ).length,
    0,
  );

  return {
    business: programName
      ? { set: true, text: programName }
      : { set: false, text: "no program name saved" },
    qualification:
      rules > 0
        ? { set: true, text: `${rules} of ${qualification.length} qualifying facts` }
        : { set: false, text: "no qualifying rules saved" },
    voice:
      voiceLabel || voiceAnswers
        ? {
            set: true,
            text: [
              voiceLabel,
              voiceAnswers ? `${plural(voiceAnswers, "answer", "answers")} written` : null,
            ]
              .filter(Boolean)
              .join(", "),
          }
        : { set: false, text: "using our standard voice" },
    prices: form.prices.length
      ? {
          set: true,
          text: `${plural(form.prices.length, "price", "prices")} the agent may quote`,
        }
      : { set: false, text: "no price the agent can quote" },
    assets:
      form.assets.length || form.proof.length
        ? {
            set: true,
            text: `${plural(form.assets.length, "asset", "assets")}, ${plural(form.proof.length, "proof entry", "proof entries")}`,
          }
        : { set: false, text: "no assets or proof saved" },
    cadence: chosenPurposes
      ? {
          set: true,
          text: `${chosenPurposes} of ${scheduledTouches} touches given a purpose`,
        }
      : { set: false, text: "using our default purposes" },
  };
}

function SectionHeading({
  answer,
  description,
  title,
  action,
}: {
  answer?: SectionAnswerValue;
  description: string;
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-[12px]">
      <div className="min-w-[min(100%,32ch)] flex-1">
        <h2 className="text-[18px] leading-[1.35] font-semibold text-[color:var(--ink)]">
          {title}
        </h2>
        <p className="mt-[6px] max-w-[var(--measure-prose)] text-[length:var(--coach-body)] leading-[1.5] text-[color:var(--muted)]">
          {description}
        </p>
      </div>
      {answer ? <SectionAnswer answer={answer} /> : null}
      {action ? <div className="flex shrink-0 flex-wrap gap-[var(--s-2)]">{action}</div> : null}
    </div>
  );
}

/**
 * What a section already answers, stated beside its title so nothing has to be opened to find
 * out that it is empty. Accent means the coach set it; neutral means it is still ours or unset,
 * and the leading words carry the same distinction for anyone who cannot see the colour.
 */
function SectionAnswer({ answer }: { answer: SectionAnswerValue }) {
  return (
    <p
      className={
        answer.set
          ? "flex shrink-0 items-center gap-[8px] rounded-[999px] border border-[var(--accent-edge)] bg-[var(--accent-wash)] px-[13px] py-[6px] text-[15px] leading-[1.35] font-normal text-[color:var(--accent-text)]"
          : "flex shrink-0 items-center gap-[8px] rounded-[999px] border border-[var(--line)] px-[13px] py-[6px] text-[15px] leading-[1.35] font-normal text-[color:var(--muted)]"
      }
      data-set={answer.set ? "true" : "false"}
    >
      <span
        aria-hidden
        className={
          answer.set
            ? "size-[8px] shrink-0 rounded-full bg-[var(--accent-bright)]"
            : "size-[8px] shrink-0 rounded-full bg-[var(--dim)]"
        }
      />
      {answer.set ? "Set by you: " : "Not set: "}
      {answer.text}
    </p>
  );
}

function SettingsCard({
  action,
  answer,
  children,
  description,
  title,
}: {
  action?: ReactNode;
  answer?: SectionAnswerValue;
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <section className="min-w-0">
      <SectionHeading
        action={action}
        answer={answer}
        description={description}
        title={title}
      />
      <div className="mt-[16px] flex flex-col gap-[var(--s-4)] border-t border-[var(--line-soft)] pt-[16px]">
        {children}
      </div>
    </section>
  );
}

/**
 * Every setting the mockup's managed strip named, each carrying the one fact that decides whether
 * it belongs there: does a coach-writable store exist for it. The strip renders the entries where
 * none does, and its count comes from that filter rather than from a literal, so a setting that
 * gains a coach writer leaves the strip by changing this flag and nothing else. The old copy's
 * "nine" was four-ninths false for exactly the reason this list exists.
 */
const MANAGED_CANDIDATES: readonly {
  coachWritable: boolean;
  detail: string;
  title: string;
  /** Why it sits on this side of the line, kept next to the claim it justifies. */
  storage: string;
}[] = [
  {
    /*
     * `Agent.dc.html` lists "The questions your agent asks, and the order it asks them" among the
     * things SetterFi keeps current, and it was the one item on that list with no row here at
     * all. It belongs on this side of the line for the same reason objection handling does: the
     * qualification sequence lives in the platform brain, which has no tenant column, so there is
     * nothing a coach could edit even if the page offered them a control.
     *
     * What a coach does own is the numbers the sequence tests against, and those are the Who you
     * do not want card further up the page. The sentence says so, because a coach reading "we
     * choose the questions" without that would reasonably conclude the qualification bar was ours
     * too, which is the opposite of true.
     */
    title: "The questions your agent asks",
    coachWritable: false,
    storage: "Platform brain tables, admin edited, with no tenant column.",
    detail:
      "The questions and the order they come in are ours, and they stay current for every coach. The numbers they are judged against are yours, on Who you do not want.",
  },
  {
    /*
     * The follow-up half of the same claim. The Follow-up card already tells a coach that timing
     * is ours and the purpose of each touch is theirs, but that sentence lives inside a card a
     * coach only reads while editing; the artboard puts the fact on the managed list too, where
     * somebody scanning what they are not responsible for will see it.
     *
     * "and when it stops" is the part worth stating out loud. A cadence that ends is the
     * difference between a follow-up and being pestered, and it is the thing a coach worries
     * about on their own leads' behalf.
     */
    title: "When it follows up, and when it stops",
    coachWritable: false,
    storage:
      "Cadence timing is platform-set; offer_cadence_purposes stores only what each touch is for.",
    detail:
      "We decide when each touch goes out and when the sequence ends. What each one is for is yours, on How it follows up.",
  },
  {
    title: "Reply timing",
    coachWritable: false,
    storage: "No configuration exists; the only delay in the send path is retry backoff.",
    detail:
      "Your setter answers as soon as the channel accepts the message. There is no delay for you to tune.",
  },
  {
    title: "Objection handling",
    coachWritable: false,
    storage: "Platform brain tables, admin edited, with no tenant column.",
    detail:
      "How it answers objections about credit, cost and timing comes from The Brain, which SetterFi writes and keeps up to date for every coach.",
  },
  {
    title: "What the agent may claim",
    coachWritable: false,
    storage: "Global compliance rules, seeded once and enforced for every tenant.",
    detail:
      "Prices, guarantees, and outcomes are checked before every reply. Your setter stops short of any promise only you can make, and it cannot state a figure you have not saved.",
  },
  {
    title: "Spam and opt-outs",
    coachWritable: false,
    storage: "Rate limits and suppression lists are platform mechanisms, not tuned settings.",
    detail:
      "Sending limits, do-not-contact lists, and stop requests are enforced on every message we send.",
  },
  {
    title: "Quiet hours",
    coachWritable: false,
    storage: "A tenant row bounded by the platform, with no coach-facing writer.",
    detail:
      "We hold messages outside your workspace's sending window so a lead is never woken up by your setter.",
  },
  // The two rows screen 5c draws as "yours to set" that have nothing writable behind them. They
  // are here rather than absent because a coach who read the mockup will come looking for them,
  // and the honest answer is not silence: it is that we run them, and what we actually store.
  {
    title: "When you take calls",
    coachWritable: false,
    storage:
      "calendar_connections stores a timezone, slot_duration_minutes and min_notice_minutes. No weekday set and no hours window exist anywhere in the schema.",
    detail:
      "Booking goes straight onto your calendar, in your timezone. Your bookable hours come from the calendar you connected, so that is where you change them; we keep the slot length and the minimum notice it reported, and we never offer a lead an hour your calendar has not.",
  },
  {
    title: "Who gets hot leads",
    coachWritable: false,
    storage:
      "conversations.taken_over_by records who took a thread over after the fact. No column nominates a person in advance.",
    detail:
      "A thread that needs a person is flagged in your Inbox and waits there for whoever gets to it first. There is nobody to nominate ahead of time, and we record who took it over.",
  },
  // Below the line: real coach-writable storage exists, so `MANAGED_SETTINGS` filters them out and
  // none of them renders. Keeping them here records why they left the mockup's strip -- a strip
  // that lists what SetterFi decides must not list a thing the coach decides.
  //
  // Where each one actually went, because "these are cards on this page" was the note here and it
  // was true of two and not of the third. The titles are the concepts, not card names: "Follow-up
  // purposes" is the card titled "Chasing a quiet lead", and "Qualifying questions" is the one
  // titled "Who is worth your time" -- both on this page, neither under the name written here.
  // "Channel setup" is not on this page at all: `docs/REDESIGN-CANVAS.md` takes Integrations off
  // the coach rail and puts channel state on Home's setup card, so it is coach-writable, excluded
  // from the strip for that reason, and lives one screen away.
  {
    title: "Follow-up purposes",
    coachWritable: true,
    storage: "offer_cadence_purposes, edited on the Follow-up section of this page.",
    detail: "",
  },
  {
    title: "Qualifying questions",
    coachWritable: true,
    storage: "A tenant-scoped flow config described in its own comment as coming from the coach.",
    detail: "",
  },
  {
    title: "Channel setup",
    coachWritable: true,
    storage: "Channel and calendar connections, created by the coach's own sign-in during setup.",
    detail: "",
  },
];

const MANAGED_SETTINGS = MANAGED_CANDIDATES.filter((entry) => !entry.coachWritable);

const COUNT_WORDS = [
  "No",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
] as const;

/** Small counts read as words in a sentence; anything larger falls back to the numeral. */
function countWord(count: number) {
  return COUNT_WORDS[count] ?? String(count);
}

/**
 * "What SetterFi handles for you": the done-for-you half of the page, and the change the canvas
 * is really making.
 *
 * This was a strip of chips, each one a popover trigger. A chip is a control -- it is pressable,
 * it hides its content, and it reads as something you might change -- and every one of these is a
 * decision the coach does not own and cannot change from here. So the chips are gone and the
 * detail that was hidden behind them is on the page: a check, then one plain sentence per
 * setting, in two columns, with nothing to press except the one thing that is actually actionable
 * (asking a person to change one). That is the whole argument for the section. A coach who reads
 * it should come away knowing what they are not responsible for, which is what a done-for-you
 * product is selling.
 *
 * The list itself is unchanged and still filtered off `coachWritable`, so a setting that gains a
 * coach-facing writer leaves this section by flipping one flag. Nothing here states a
 * last-changed date: the audit-log source for it is still an open gap, and a plausible date is
 * worse than no date.
 */
function ManagedStrip() {
  return (
    <section
      aria-labelledby="managed-by-setterfi"
      className="col-span-full min-w-0 rounded-[22px_22px_17px_17px] border border-[var(--line)] bg-[var(--well)] px-[28px] py-[24px]"
    >
      <h2
        className={COACH_SURFACE_TITLE_CLASS}
        id="managed-by-setterfi"
      >
        What SetterFi handles for you
      </h2>
      {/* One string, not a fragment with a count spliced into it: `coach-offer.queue.test.tsx`
          reads this sentence whole to prove the numeral came off the list rather than a literal,
          and a sentence broken across text nodes is not findable as a sentence. */}
      <p className="mt-[6px] mb-[20px] max-w-[var(--measure-wide)] text-[length:var(--coach-body)] leading-[1.5] text-[color:var(--muted)]">
        {`${countWord(MANAGED_SETTINGS.length)} settings we run for you. They are the same for every coach and they stay current on their own. If one of them is wrong for your business, ask us and a person will change it.`}
      </p>
      {/*
        A description list, not a bullet list. Each entry is a named setting and the sentence that
        says what we decided about it, which is a term and its definition; `dl` is what announces
        that pairing to a screen reader instead of leaving two runs of text side by side.
      */}
      <dl className="m-0 grid grid-cols-1 gap-x-[40px] gap-y-[16px] md:grid-cols-2">
        {MANAGED_SETTINGS.map((entry) => (
          <div className={STATEMENT_CLASS} key={entry.title}>
            <ManagedCheck />
            <div className="min-w-0">
              <dt className="font-medium text-[color:var(--ink)]">{entry.title}</dt>
              <dd className="m-0 text-[color:var(--muted)]">{entry.detail}</dd>
            </div>
          </div>
        ))}
      </dl>
      {/*
        `prefetch={false}` because this link renders on every load rather than behind a popover,
        and Next's prefetch attaches an IntersectionObserver the moment it mounts. Help is one
        route a coach reaches rarely and deliberately; prefetching it buys nothing and costs an
        observer on a page that already runs several.
      */}
      <Link className={`${QUIET_BUTTON_CLASS} mt-[22px]`} href="/coach/help" prefetch={false}>
        Ask us to change something
      </Link>
    </section>
  );
}

/**
 * The check beside a managed statement. Drawn rather than imported so the section has no icon-set
 * dependency, and `aria-hidden` because it asserts nothing the sentence beside it does not: it is
 * a bullet that happens to look settled, not a claim that something passed a check.
 */
function ManagedCheck() {
  return (
    <svg
      aria-hidden="true"
      className="mt-[4px] size-[20px] shrink-0 text-[color:var(--good)]"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.75"
      viewBox="0 0 24 24"
    >
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

function SelectField({
  hint,
  label,
  onValueChange,
  options,
  value,
}: {
  hint?: string;
  label: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  value: string | null;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  const normalized = value || EMPTY_SELECT_VALUE;
  const normalizedOptions = options.some((option) => option.value === EMPTY_SELECT_VALUE)
    ? options
    : [{ value: EMPTY_SELECT_VALUE, label: "Not set" }, ...options];

  return (
    <div className="flex min-w-0 flex-col gap-[var(--distance-small)]">
      <span
        className="text-[length:var(--t-body)] leading-[var(--t-body-lh)] font-medium text-[color:var(--ink)]"
        data-slot="kit-field-label"
        id={labelId}
      >
        {label}
      </span>
      {hint ? (
        <p
          className="text-[length:var(--t-badge)] leading-[var(--t-body-lh)] font-normal text-[color:var(--muted)]"
          data-slot="kit-field-hint"
          id={hintId}
        >
          {hint}
        </p>
      ) : null}
      <BaseSelect
        onValueChange={(next) =>
          onValueChange(next === EMPTY_SELECT_VALUE || next === null ? "" : String(next))
        }
        value={normalized}
      >
        <SelectTrigger
          aria-describedby={hint ? hintId : undefined}
          aria-labelledby={labelId}
          className="h-[var(--row-h-dense)] w-full rounded-[var(--r-input)] border-[var(--line-strong)] bg-[var(--card)] px-[var(--s-2)] text-body text-[color:var(--ink)]"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--raised)] shadow-[var(--shadow-toast)]">
          {normalizedOptions.map((option) => (
            <SelectItem
              className="rounded-[var(--r-control)] text-body text-[color:var(--ink)] focus:bg-[var(--row-hover)]"
              key={option.value}
              value={option.value}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </BaseSelect>
    </div>
  );
}

function Select(props: {
  hint?: string;
  label: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  value: string | null;
}) {
  return <SelectField {...props} />;
}

/* ============================================================================
   Card faces. The rule the whole page is built on: no two card interiors are
   alike. Prices is two mono figures in wells, voice is a bubble exchange,
   qualification is a dash-led list, follow-up is a mono timing rail, the
   program is a spec sheet, and assets are link rows. Every one of them renders
   from a saved column; where no column exists, the shape renders empty and
   says so rather than drawing a plausible value.
   ========================================================================== */

/** A mono overline over a 22px mono figure, the artifact's price well. */
/** A spec sheet: a mono label gutter with the saved value beside it. */
/** Link rows: a mono handle, the coach's name for it, and the host it points at. */
/**
 * A timing rail: platform timing in the mono gutter, the coach's purpose beside it. The gutter
 * is what makes this card read as a schedule rather than as another list of rows.
 *
 * **Every sentence and every purpose label here is `--muted`, never `--dim`.** The ramp at the top
 * of `src/app/tokens.css` splits at `--faint`: the roles above it are the contract roles solved to
 * the dark palette's measured ratios, and the four below are label weight only -- 11px overlines,
 * the weekend letters in a calendar strip, icon strokes. `--dim` is the weekend-letter role and
 * measures 3.8:1, which is a glyph you scan rather than a sentence you read, and it is below AA for
 * body text at any size. This is the coach surface, whose reader is typically over 55 and told us
 * in round-1 demo feedback that the product was hard to read; a purpose the coach has not set yet
 * is secondary, not unreadable, so it takes `--muted` at 10.6:1 on the card. The set-versus-unset
 * distinction it used to carry in contrast still carries in weight of colour against `--body`, and
 * carries machine-readably in `data-set` besides.
 */
function CadenceFace({
  purposes,
  schedule,
}: {
  purposes: readonly CoachCadencePurposeInput[];
  schedule: readonly CoachCadenceScheduleGroup[];
}) {
  const touches = schedule.flatMap((group) =>
    group.touches.map((touch) => ({
      key: `${group.channelClass}:${touch.touchNo}`,
      when: touch.when,
      saved: savedPurposeFor(purposes, group.channelClass, touch.touchNo),
      fallback: touch.defaultPurpose,
    })),
  );
  const shown = touches.slice(0, 4);

  if (!shown.length) {
    return (
      <p className="text-[13px] leading-[1.5] text-[color:var(--muted)]">
        No channel is connected yet, so there is no schedule to give a purpose to.
      </p>
    );
  }

  return (
    <div className="flex min-w-0 flex-col">
      <ul className="flex list-none flex-col border-l border-[var(--line-soft)] p-0 pl-[11px]">
        {shown.map((touch) => (
          <li
            className="flex min-w-0 items-baseline gap-[10px] py-[7px]"
            data-set={touch.saved ? "true" : "false"}
            key={touch.key}
          >
            <span className="w-[118px] shrink-0 truncate font-[family-name:var(--font-mono)] text-[10.5px] leading-[1.4] text-[color:var(--overline)]">
              {touch.when}
            </span>
            <span
              className={
                touch.saved
                  ? "min-w-0 truncate text-[13px] text-[color:var(--body)]"
                  : "min-w-0 truncate text-[13px] text-[color:var(--muted)]"
              }
            >
              {OFFER_CADENCE_PURPOSE_LABELS[touch.saved ?? touch.fallback]}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-[12px] border-t border-[var(--line-soft)] pt-[11px] text-[12.5px] leading-[1.5] text-[color:var(--faint)]">
        <span className="font-[family-name:var(--font-mono)] text-[color:var(--accent-text)]">
          {touches.length} touches
        </span>{" "}
        <span>Timing is ours. What each touch is for is yours.</span>
      </p>
    </div>
  );
}

/**
 * The canvas's state pill: what this card currently answers, in a good tone when the coach set it
 * and a waiting tone when it is still ours or empty.
 *
 * It replaces the Edit button the tabbed build put on every card. With all four cards open there
 * is nothing left to open, so the top-right slot goes to the one thing a coach scanning the page
 * wants from it -- which of the four still needs them. The detail sentence rides inside the pill
 * rather than being dropped, because "Set" alone does not say what was set.
 */
function CardStatePill({ answer }: { answer: SectionAnswerValue }) {
  return (
    <p
      className={
        answer.set
          ? "flex shrink-0 items-center gap-[8px] rounded-[999px] border border-[var(--good-line)] bg-[var(--good-wash)] px-[13px] py-[6px] text-[15px] leading-[1.35] font-medium text-[color:var(--good-text)]"
          : "flex shrink-0 items-center gap-[8px] rounded-[999px] border border-[var(--waiting-line)] bg-[var(--waiting-wash)] px-[13px] py-[6px] text-[15px] leading-[1.35] font-medium text-[color:var(--waiting-text)]"
      }
      data-set={answer.set ? "true" : "false"}
      data-slot="offer-card-state"
    >
      <span
        aria-hidden
        className={
          answer.set
            ? "size-[8px] shrink-0 rounded-full bg-[var(--good)]"
            : "size-[8px] shrink-0 rounded-full bg-[var(--waiting)]"
        }
      />
      {answer.set ? "Set" : "Still to set"}
      <span className="sr-only">: {answer.text}</span>
    </p>
  );
}

/*
 * `OfferCard` was here, and what removed it is that the canvas has only two card shapes.
 *
 * It drew the title-led one -- a 22px/600 title, its sentence under it, a status pill hard right
 * and level with the title, no header band anywhere -- and it drew it as a private second copy of
 * a recipe that `deck-panel.tsx` now exports as `TitlePanel`, matching down to the `-0.015em`
 * tracking. Two copies of one shape is how one shape becomes two, so the four mounts below call
 * `TitlePanel` directly and carry `OFFER_CARD_CLASS` for the two things that really are this
 * page's own: the artboard's `26px 28px` padding, and the `@container/card` name four editor grids
 * inside these cards query with `@md/card:`.
 *
 * One claim in the note that stood here was not true and is worth recording as it goes. It said
 * the card kept the console's open/closed machinery, "`.surface-card[data-open="true"]` is the
 * switch the whole editor turns on", and that this was why the frame could not be `.coach-panel`.
 * The section never carried `data-open` -- that selector matched nothing on it. The open state
 * lives on the `SettingsCard`s inside, which keep their own `.surface-card` and are untouched.
 *
 * The `face` prop went with it: no mount ever passed one. Follow-up's timing rail, which the note
 * described as the only user of it, is passed as an ordinary first child.
 */

/**
 * The two sections `SIMPLIFICATION-SPEC.md` §2.4 demotes, kept as a closed disclosure.
 *
 * The spec sends "Your program" and "Marketing assets" to "an intake request", and the only intake
 * channel that exists is `/coach/help`, a support conversation with no structured field for a
 * program description or an asset link. Deleting these editors before that field exists would
 * strand `program_name`, `program_description`, `products`, `assets` and `proof` with no writer at
 * all, so what changes here is their weight: they stop being two of the six things the page is
 * about and become a shut drawer under the managed strip, opened once during setup and rarely
 * again. Whether they leave the surface entirely is Alec's call, recorded in `docs/GAPS.md`.
 */
function ProgramAndAssets({ children }: { children: ReactNode }) {
  return (
    /*
      `@container/card` because two of the fields in here query it. "Program name" and "Program
      description" are laid out with `@md/card:grid-cols-2` and `@md/card:col-span-2`, written
      while they still sat inside an offer card; the demote to this drawer left the queries behind
      with no named container to resolve against. A container query that resolves against nothing
      does not error -- it just never matches -- so both fields have been rendering single-column
      at every width since the demote, silently. Restoring the name is what those classes were
      written to mean.
    */
    <details className="@container/card rounded-[22px_22px_17px_17px] border border-[var(--line)] bg-[var(--control-fill)] px-[28px] py-[20px]">
      <summary className="cursor-pointer list-none text-[20px] leading-[1.35] font-semibold text-[color:var(--ink)] marker:content-none">
        Tell us about your program and send us your materials
      </summary>
      <p className="mt-[6px] max-w-[var(--measure-prose)] text-[length:var(--coach-body)] leading-[1.5] text-[color:var(--muted)]">
        Set these once when you join. Nothing here changes day to day, so it stays shut unless you
        need it.
      </p>
      <div className="mt-[var(--s-5)]">{children}</div>
    </details>
  );
}

/**
 * "What leads push back on", from `read_coach_top_objections_for_actor`.
 *
 * `Agent.dc.html` draws three rows, each with the objection, "said N times", a 190px meter and a
 * percentage. Two of those four are real today and two are not: the rollup returns a
 * `conversationCount` per objection, and a `bookedRate` that is null for every row while the
 * attribution state reads `awaiting_definition`. So a row with no rate draws no meter and no
 * percentage, and says which of the two reasons it is -- held safely, or awaiting a definition
 * Alec has not approved. Drawing a 0% bar for an undefined rate would be the invented figure this
 * page exists to refuse.
 */
export type CoachObjectionPushback = {
  objectionId: string;
  label: string;
  conversationCount: number;
  /** 0..1, or null while the rollup's attribution state is not `available`. */
  bookedRate: number | null;
  /** Why the rate is absent, in the coach's words. Null when a rate is present. */
  absence: string | null;
  conversationHref: string;
};

function ObjectionPushback({ rows }: { rows: readonly CoachObjectionPushback[] | null }) {
  if (!rows) return null;
  return (
    <section
      aria-labelledby="objection-pushback-title"
      className={`${CARD_FACE_CLASS} overflow-hidden rounded-[24px_24px_17px_17px] p-0`}
    >
      <div className="flex flex-wrap items-start justify-between gap-[var(--s-3)] border-b border-[var(--line-soft)] px-[28px] py-[22px]">
        <div className="min-w-0">
          <h2
            className="text-[20px] leading-[1.35] font-semibold text-[color:var(--ink)]"
            id="objection-pushback-title"
          >
            What leads push back on
          </h2>
          <p className="mt-[4px] max-w-[var(--measure-prose)] text-[length:var(--coach-body)] leading-[1.5] text-[color:var(--muted)]">
            The things people say most before they book, and how often your agent gets past it.
          </p>
        </div>
        <ExportMenu
          filename="setterfi-top-objections"
          mode="server"
          query={{ columns: [...COACH_TOP_OBJECTION_COLUMNS], order: "created_desc" }}
          resource="coach-top-objections"
        />
      </div>
      {rows.length ? (
        <ul className="m-0 flex list-none flex-col p-0">
          {rows.map((row) => (
            <li
              className="flex flex-wrap items-center gap-[24px] border-b border-[var(--line-soft)] px-[28px] py-[20px] last:border-b-0"
              data-rate={row.bookedRate === null ? "absent" : "present"}
              key={row.objectionId}
            >
              <a
                className="min-w-[min(100%,24ch)] flex-1 text-[18px] leading-[1.4] text-[color:var(--ink)] hover:underline"
                href={row.conversationHref}
              >
                &ldquo;{row.label}&rdquo;
              </a>
              <span className="shrink-0 text-[length:var(--coach-body)] text-[color:var(--muted)]">
                said {row.conversationCount === 1 ? "once" : `${row.conversationCount} times`}
              </span>
              {row.bookedRate === null ? (
                <span className="shrink-0 text-[length:var(--coach-body)] text-[color:var(--faint)]">
                  {row.absence}
                </span>
              ) : (
                <>
                  <span
                    className="h-[10px] w-[190px] shrink-0 overflow-hidden rounded-[999px] bg-[var(--well)]"
                    data-slot="objection-meter"
                  >
                    <span
                      className="block h-full rounded-[999px] bg-[var(--accent)]"
                      style={{ width: `${Math.round(row.bookedRate * 100)}%` }}
                    />
                  </span>
                  <span className="min-w-[62px] shrink-0 text-right font-[family-name:var(--font-mono)] text-[18px] text-[color:var(--ink)] tabular-nums">
                    {Math.round(row.bookedRate * 100)}%
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-[28px] py-[20px] text-[length:var(--coach-body)] leading-[1.5] text-[color:var(--muted)]">
          Your agent has not met a published objection yet, so there is nothing to rank.
        </p>
      )}
    </section>
  );
}

const ActionButton = Button;

function InlineRemoveConfirm({
  label,
  onCancel,
  onConfirm,
}: {
  label: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="col-span-full flex flex-wrap items-center gap-[var(--s-3)] rounded-[var(--r-card)] bg-[var(--critical-wash)] p-[var(--s-3)]"
      role="alert"
    >
      <CircleAlert aria-hidden className="size-[var(--s-4)] shrink-0 text-[color:var(--critical)]" />
      <p className="min-w-[min(100%,48ch)] flex-1 text-[length:var(--coach-body)] leading-[1.5] text-[color:var(--body)]">
        Remove <strong className="font-medium text-[color:var(--ink)]">{label}</strong>? The agent
        stops using it after this draft is reviewed and published. Past conversations keep what
        was said.
      </p>
      <Button onClick={onCancel} type="button" variant="ghost">
        Keep
      </Button>
      <Button onClick={onConfirm} type="button" variant="destructive">
        Remove
      </Button>
    </div>
  );
}

function DisabledAction({
  button,
  reason,
}: {
  button: ReactNode;
  reason: string | null;
}) {
  if (!reason) return <>{button}</>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{button}</TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

/**
 * An 8px retrieval hit: outline when the trace shows the item was matched but did not change
 * the answer, filled when it did. Never a check mark, because a trace records what happened
 * rather than passing judgement on it.
 */
function TraceHit({ used }: { used: boolean }) {
  return (
    <span
      aria-hidden
      className={
        used
          ? "mt-[var(--s-1)] size-[var(--distance-small)] shrink-0 rounded-full border border-[var(--ink)] bg-[var(--ink)]"
          : "mt-[var(--s-1)] size-[var(--distance-small)] shrink-0 rounded-full border border-[var(--muted)] bg-transparent"
      }
      data-used={used ? "true" : undefined}
    />
  );
}

function TraceLabel({ children, plain }: { children: string; plain?: string }) {
  return (
    <p className="flex items-baseline gap-[var(--s-2)] text-over text-[color:var(--muted)]">
      {children}
      {plain ? (
        <span className="text-[length:var(--t-badge)] font-normal tracking-normal normal-case text-[color:var(--faint)]">
          {plain}
        </span>
      ) : null}
    </p>
  );
}

function TraceTurnView({ turn, index }: { turn: TraceTurn; index: number }) {
  const { receipt } = turn;
  const sources = receipt.trace.sourceIds;
  const checks = turn.gates;

  return (
    <article className="flex flex-col gap-[var(--s-4)] border-b border-[var(--line)] pb-[var(--s-4)] last:border-b-0 last:pb-0">
      <div className="flex items-center gap-[var(--s-2)] border-b border-[var(--line)] pb-[var(--s-3)]">
        <span className="min-w-0 flex-1 truncate text-body italic text-[color:var(--body)]">
          &ldquo;{turn.input}&rdquo;
        </span>
        <span className="text-over shrink-0 text-[color:var(--faint)]">Turn {index + 1}</span>
      </div>

      <div className="flex flex-col gap-[var(--s-2)]">
        <TraceLabel plain={receipt.turn.grounded ? "grounded" : "no retrieval"}>
          Retrieved from The Brain
        </TraceLabel>
        {sources.length ? (
          <ul className="flex flex-col gap-[var(--s-2)]">
            {sources.map((sourceId, sourceIndex) => (
              <li
                className="flex items-start gap-[var(--s-2)] text-body text-[color:var(--ink)]"
                key={sourceId}
              >
                <TraceHit used />
                <span className="min-w-0">
                  <span className="block">Brain entry {sourceIndex + 1}</span>
                  <span className="mt-[var(--s-1)] block text-[length:var(--t-badge)] leading-[var(--t-body-lh)] font-normal text-[color:var(--muted)]">
                    Grounded this reply. The trace emits no title or score for it.
                  </span>
                  <TechnicalDetail
                    className="mt-[var(--s-1)]"
                    items={[{ label: "Brain entry id", value: sourceId }]}
                  />
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body text-[color:var(--muted)]">
            No brain entry grounded this answer
          </p>
        )}
      </div>

      <div className="flex flex-col gap-[var(--s-2)]">
        <TraceLabel plain={checks.length ? undefined : "none emitted"}>
          Checked before replying
        </TraceLabel>
        {checks.length ? (
          <ul className="flex flex-col gap-[var(--s-2)]">
            {checks.map(({ check, id }, checkIndex) => (
              <li
                className="flex items-start gap-[var(--s-2)] text-body text-[color:var(--ink)]"
                key={id}
              >
                <TraceHit used={!check.passed} />
                <span className="min-w-0">
                  <span className="block">
                    Gate decision {checkIndex + 1}: {check.passed ? "Passed" : "Held"}
                  </span>
                  <span className="mt-[var(--s-1)] block text-[length:var(--t-badge)] leading-[var(--t-body-lh)] font-normal text-[color:var(--muted)]">
                    {check.passed
                      ? "Ran without changing the reply."
                      : "Held the reply back from a claim it could not ground."}
                  </span>
                  <TechnicalDetail
                    className="mt-[var(--s-1)]"
                    items={[
                      { label: "Gate class", value: check.class },
                      {
                        label: "Rule ids",
                        value: check.ruleIds.length
                          ? check.ruleIds.join(", ")
                          : "None emitted",
                      },
                    ]}
                  />
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body text-[color:var(--muted)]">
            No gate decision was emitted for this turn.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-[var(--s-2)]">
        <TraceLabel>Answered by</TraceLabel>
        <p className="text-body text-[color:var(--ink)]">
          {receipt.turn.model || "Model missing from trace"}
        </p>
        <p className="text-[length:var(--t-badge)] leading-[var(--t-body-lh)] font-normal text-[color:var(--muted)]">
          Prompt version missing from trace. Latency missing from trace.
        </p>
        <TechnicalDetail
          items={[
            {
              label: "Prompt hash",
              value: receipt.trace.promptHash ?? "Not emitted",
            },
          ]}
        />
      </div>
    </article>
  );
}

function TestAgentPanel({
  enabled,
  publishedRuntimeAvailable,
}: {
  enabled: boolean;
  publishedRuntimeAvailable: boolean;
}) {
  const [view, setView] = useState<TraceView>("conversation");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<TraceTurn[]>([]);
  const [sending, setSending] = useState(false);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!enabled || !publishedRuntimeAvailable) return;
    const controller = new AbortController();
    requestRef.current = controller;
    void (async () => {
      try {
        setSessionId(await requestTestSession(controller.signal));
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setSessionError(humanError(refusalCode(cause, "TEST_AGENT_SESSION_REFUSED")).body);
      }
    })();
    return () => controller.abort();
  }, [enabled, publishedRuntimeAvailable]);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || !sessionId || sending) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setSending(true);
    setSessionError(null);
    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, sessionId }),
        signal: controller.signal,
      });
      await consumeTestAgentStream(response, (payload) => {
        setTurns((current) => [
          ...current,
          {
            id: payload.agentMessageId,
            input: message,
            receipt: payload,
            gates: payload.trace.checks.map((check) => ({ id: clientId(), check })),
          },
        ]);
      });
      setDraft("");
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setSessionError(humanError(refusalCode(cause, "TEST_AGENT_TURN_REFUSED")).body);
    } finally {
      setSending(false);
    }
  }

  async function startOver() {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setSessionId(null);
    setSessionError(null);
    setSending(true);
    setTurns([]);
    setDraft("");
    try {
      setSessionId(await requestTestSession(controller.signal));
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setSessionError(humanError(refusalCode(cause, "TEST_AGENT_SESSION_REFUSED")).body);
    } finally {
      if (requestRef.current === controller) setSending(false);
    }
  }

  const runtimeAvailable = enabled && publishedRuntimeAvailable;

  return (
    <aside
      aria-label="Test as a lead"
      className="surface-card min-w-0 lg:col-span-2 xl:col-span-1 xl:sticky xl:top-[var(--s-4)] xl:self-start"
    >
      <div className="border-b border-[var(--line-soft)] pb-[13px]">
        <div className="flex items-center justify-between gap-[var(--s-3)]">
          <div className="flex items-center gap-[var(--s-2)]">
            <Bot aria-hidden className="size-[var(--s-4)] text-[color:var(--muted)]" />
            <h2 className="text-section text-[color:var(--ink)]">Test as a lead</h2>
          </div>
          <StateBadge
            kind="tag"
            label={runtimeAvailable ? "Published runtime" : "Runtime unavailable"}
            tone={runtimeAvailable ? "good" : "warning"}
          />
        </div>
        <p className="mt-[var(--s-2)] text-body text-[color:var(--muted)]">
          {runtimeAvailable
            ? "Test data, excluded from real leads and analytics. Replies use the receipt-backed published runtime."
            : "Testing stays unavailable until it is enabled and a published offer is verified."}
        </p>
      </div>

      <Tabs onValueChange={(next) => setView(next as TraceView)} value={view}>
        <TabsList
          aria-label="Test view"
          className="h-auto w-full justify-start border-b border-[var(--line-soft)] bg-transparent p-0 data-[variant=line]:rounded-[var(--r-well)]"
          variant="line"
        >
          <TabsTrigger
            className="h-[var(--row-h-dense)] flex-none px-[var(--s-4)] text-body text-[color:var(--muted)] data-active:text-[color:var(--ink)]"
            value="conversation"
          >
            Conversation
          </TabsTrigger>
          <TabsTrigger
            className="h-[var(--row-h-dense)] flex-none px-[var(--s-4)] text-body text-[color:var(--muted)] data-active:text-[color:var(--ink)]"
            value="trace"
          >
            Trace
          </TabsTrigger>
        </TabsList>

        <TabsContent className="m-0" value="conversation">
          <div
            aria-live="polite"
            className="flex max-h-[calc(var(--row-h-comfortable)*8)] min-h-[calc(var(--row-h-comfortable)*5)] flex-col gap-[var(--s-3)] overflow-y-auto py-[13px]"
          >
            <p className="max-w-[85%] self-start rounded-[13px_13px_13px_4px] bg-[var(--band)] px-[12px] py-[9px] text-[12.5px] leading-[1.5] font-normal text-[color:var(--body)]">
              Ask a question the way a lead would.
            </p>
            {turns.map((turn) => (
              <div className="contents" key={turn.id}>
                <p
                  className="max-w-[85%] self-end rounded-[13px_13px_4px_13px] border border-[var(--line-input)] bg-[var(--well)] px-[12px] py-[9px] text-[12.5px] leading-[1.5] font-normal text-[color:var(--ink)]"
                  data-from="lead"
                >
                  {turn.input}
                </p>
                <p
                  className="max-w-[85%] self-start rounded-[13px_13px_13px_4px] bg-[var(--band)] px-[12px] py-[9px] text-[12.5px] leading-[1.5] font-normal text-[color:var(--body)]"
                  data-from="agent"
                >
                  {turn.receipt.turn.reply}
                </p>
              </div>
            ))}
            {sending ? (
              <p className="text-body text-[color:var(--muted)]" role="status">
                The agent is checking The Brain and your offer.
              </p>
            ) : null}
          </div>
        </TabsContent>

        <TabsContent className="m-0" value="trace">
          <div className="flex max-h-[calc(var(--row-h-comfortable)*10)] min-h-[calc(var(--row-h-comfortable)*5)] flex-col gap-[var(--s-4)] overflow-y-auto py-[13px]">
            {turns.length ? (
              turns.map((turn, index) => (
                <TraceTurnView index={index} key={turn.id} turn={turn} />
              ))
            ) : (
              <div className="flex min-h-[calc(var(--row-h-comfortable)*4)] flex-col items-start justify-center">
                <Sparkles aria-hidden className="size-[var(--s-5)] text-[color:var(--muted)]" />
                <h3 className="mt-[var(--s-3)] text-[length:var(--t-row)] font-[var(--t-row-w)] text-[color:var(--ink)]">
                  Run a conversation to see its trace
                </h3>
                <p className="mt-[var(--s-1)] text-body text-[color:var(--muted)]">
                  Each successful turn will show the evidence the route actually returned.
                </p>
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>

      <div className="border-t border-[var(--line-soft)] pt-[13px]">
        {sessionError ? (
          <p className="mb-[var(--s-3)] text-body text-[color:var(--critical)]" role="alert">
            {sessionError}
          </p>
        ) : null}
        {!enabled ? (
          <p className="text-body text-[color:var(--muted)]">
            Agent testing is not enabled for this workspace.
          </p>
        ) : !publishedRuntimeAvailable ? (
          <p className="text-body text-[color:var(--muted)]">
            Publish an offer before testing it as a lead.
          </p>
        ) : (
          <form className="flex flex-col gap-[var(--s-2)]" onSubmit={send}>
            <label className="sr-only" htmlFor="test-lead-message">
              Message as the test lead
            </label>
            <Textarea
              disabled={!sessionId || sending}
              id="test-lead-message"
              maxLength={800}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={sessionId ? "Ask as a lead would" : "Preparing a test session"}
              value={draft}
            />
            <div className="flex flex-wrap items-center justify-between gap-[var(--s-2)]">
              <Button
                disabled={!turns.length || sending}
                onClick={startOver}
                size="sm"
                type="button"
                variant="ghost"
              >
                <RefreshCw aria-hidden />
                Start over
              </Button>
              {/*
                Outline, not the default variant: the default resolves to bg-primary, which is a
                solid accent fill, and this button would then hold one permanently regardless of
                what the attention queue is doing. The page spends at most one fill and it belongs
                to the single live action, which is never a test-panel send.
              */}
              <Button
                disabled={!draft.trim() || !sessionId || sending}
                size="sm"
                type="submit"
                variant="outline"
              >
                <Send aria-hidden />
                Send
              </Button>
            </div>
          </form>
        )}
      </div>
    </aside>
  );
}

export type CoachOfferProps = {
  initialState: CoachOfferInitialState;
  /**
   * The objection rollup, already shaped for the page. Null when the brain-objections gate is off
   * or no reader identity is available, in which case the panel does not render at all rather
   * than rendering an empty one.
   */
  objections?: readonly CoachObjectionPushback[] | null;
  cadence?: {
    enabled: boolean;
    channels: readonly CoachCadenceChannel[];
  };
  publishedDateLabel?: string | null;
  testEnabled?: boolean;
  /**
   * The connected calendar's own hours, for the week readout on the program section. Absent
   * until the route loads it, and the readout is simply not rendered rather than drawn empty:
   * SetterFi stores no availability of its own, so there is nothing to show without a calendar.
   */
  availability?: Omit<AvailabilityPanelProps, "children"> | null;
};

export function CoachOffer({
  initialState,
  objections = null,
  cadence = { enabled: false, channels: [] },
  publishedDateLabel = null,
  testEnabled = false,
  availability = null,
}: CoachOfferProps) {
  const router = useRouter();
  const [offers, setOffers] = useState(initialState);
  const [publicationDate, setPublicationDate] = useState(publishedDateLabel);
  const [form, setForm] = useState(() =>
    editableOffer(initialState.draft ?? initialState.published),
  );
  const [ids, setIds] = useState(() =>
    repeatIds(initialState.draft ?? initialState.published),
  );
  const [busy, setBusy] = useState<"save" | "publish" | null>(null);
  const [dirtySections, setDirtySections] = useState<Set<EditableOfferTab>>(
    () => new Set(),
  );
  const [feedback, setFeedback] = useState<string | null>(null);
  const [publishPayload, setPublishPayload] = useState<unknown>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [priceInputs, setPriceInputs] = useState<Record<string, number | null>>({});
  const [removal, setRemoval] = useState<Removal>(null);

  const dirty = dirtySections.size > 0;
  const publishedReceipt = publishedOfferView(publishPayload);
  const dirtyLabels = TAB_ORDER
    .filter((section) => dirtySections.has(section))
    .map((section) => TAB_LABELS[section]);
  const cadenceSchedule = coachCadenceSchedule(cadence.channels);
  const answers = sectionAnswers(form, cadenceSchedule);
  const scheduledSlots = new Set(
    cadenceSchedule.flatMap((group) =>
      group.touches.map((touch) => `${group.channelClass}:${touch.touchNo}`),
    ),
  );
  const orphanCadencePurposes = form.cadencePurposes
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => !scheduledSlots.has(`${row.channelClass}:${row.touchNo}`));
  const publishedRuntimeAvailable =
    publishedReceipt.published || Boolean(offers.published && publicationDate);

  function markDirty(section: EditableOfferTab) {
    setDirtySections((current) => new Set(current).add(section));
    setFeedback(null);
    setPublishPayload(null);
  }

  function update<K extends keyof CoachOfferDraftInput>(
    key: K,
    value: CoachOfferDraftInput[K],
    section: EditableOfferTab,
  ) {
    setForm((current) => ({ ...current, [key]: value }));
    markDirty(section);
  }

  function updateInteger<K extends keyof CoachOfferDraftInput>(
    key: K,
    value: string,
    label: string,
    section: EditableOfferTab,
  ) {
    const result = nullableNumber(value);
    if (!result.ok) {
      setFieldErrors((current) => ({
        ...current,
        [String(key)]: nullableNumberFieldError(label, result.reason),
      }));
      return;
    }
    setFieldErrors((current) => {
      const next = { ...current };
      delete next[String(key)];
      return next;
    });
    update(key, result.value as CoachOfferDraftInput[K], section);
  }

  function addId(kind: RepeatKind) {
    setIds((current) => ({ ...current, [kind]: [...current[kind], clientId()] }));
  }

  function requestRemove(kind: RepeatKind, index: number, label: string) {
    setRemoval({ kind, id: ids[kind][index], label: label.trim() || "this row" });
  }

  function updatePrice(index: number, value: number | null) {
    const id = ids.prices[index];
    if (!id) return;
    const errorKey = `price:${id}`;
    setPriceInputs((current) => ({ ...current, [id]: value }));
    if (value === null) {
      setFieldErrors((current) => ({
        ...current,
        [errorKey]: "Enter a price before saving.",
      }));
      markDirty("prices");
      return;
    }
    setFieldErrors((current) => {
      const next = { ...current };
      delete next[errorKey];
      return next;
    });
    update(
      "prices",
      form.prices.map((item, itemIndex) =>
        itemIndex === index ? { ...item, amountCents: value } : item,
      ),
      "prices",
    );
  }

  function setCadencePurpose(
    channelClass: CoachCadenceScheduleClass,
    touchNo: number,
    purpose: string,
  ) {
    const index = form.cadencePurposes.findIndex(
      (row) => row.channelClass === channelClass && row.touchNo === touchNo,
    );
    if (index < 0) {
      addId("cadencePurposes");
      update(
        "cadencePurposes",
        [
          ...form.cadencePurposes,
          {
            channelClass,
            touchNo,
            purpose: purpose as (typeof OFFER_CADENCE_PURPOSES)[number],
            assetId: null,
          },
        ],
        "cadence",
      );
      return;
    }
    update(
      "cadencePurposes",
      form.cadencePurposes.map((row, rowIndex) =>
        rowIndex === index
          ? { ...row, purpose: purpose as typeof row.purpose }
          : row,
      ),
      "cadence",
    );
  }

  function confirmRemove() {
    if (!removal) return;
    const index = ids[removal.kind].indexOf(removal.id);
    if (index < 0) {
      setRemoval(null);
      return;
    }
    setIds((current) => ({
      ...current,
      [removal.kind]: current[removal.kind].filter((id) => id !== removal.id),
    }));
    if (removal.kind === "prices") {
      setPriceInputs((current) => {
        const next = { ...current };
        delete next[removal.id];
        return next;
      });
      setFieldErrors((current) => {
        const next = { ...current };
        delete next[`price:${removal.id}`];
        return next;
      });
      update(
        "prices",
        form.prices.filter((_, rowIndex) => rowIndex !== index),
        "prices",
      );
    } else if (removal.kind === "assets") {
      update(
        "assets",
        form.assets.filter((_, rowIndex) => rowIndex !== index),
        "assets",
      );
    } else if (removal.kind === "proof") {
      update(
        "proof",
        form.proof.filter((_, rowIndex) => rowIndex !== index),
        "assets",
      );
    } else {
      update(
        "cadencePurposes",
        form.cadencePurposes.filter((_, rowIndex) => rowIndex !== index),
        "cadence",
      );
    }
    setRemoval(null);
  }

  function discard() {
    const offer = offers.draft ?? offers.published;
    setForm(editableOffer(offer));
    setIds(repeatIds(offer));
    setDirtySections(new Set());
    setFieldErrors({});
    setPriceInputs({});
    setRemoval(null);
    setFeedback("Unsaved changes discarded.");
  }

  async function save() {
    setBusy("save");
    setFeedback(null);
    try {
      const payload = await jsonRequest("/api/coach/offer", "PUT", {
        draftId: offers.draft?.id ?? null,
        expectedContentHash: offers.draft?.contentHash ?? null,
        offer: form,
      });
      const result = savedDraftView(payload);
      if (!result.saved || !result.draft) {
        throw new OfferRequestError("OFFER_DRAFT_READBACK_INCOMPLETE");
      }
      setOffers((current) => ({ ...current, draft: result.draft }));
      setDirtySections(new Set());
      setPriceInputs({});
      setFeedback("Draft saved.");
      setPublishPayload(null);
    } catch (cause) {
      setFeedback(humanError(refusalCode(cause, "OFFER_SAVE_REFUSED")).body);
    } finally {
      setBusy(null);
    }
  }

  async function publishOffer() {
    if (!offers.draft) return;
    setBusy("publish");
    setFeedback(null);
    try {
      const payload = await jsonRequest("/api/coach/offer/publish", "POST", {
        draftId: offers.draft.id,
        expectedContentHash: offers.draft.contentHash,
      });
      const result = publishedOfferView(payload);
      if (!result.published || !result.offer) {
        throw new OfferRequestError("OFFER_PUBLISH_RECEIPT_INCOMPLETE");
      }
      setPublishPayload(payload);
      setOffers({ draft: null, published: result.offer });
      setPublicationDate(null);
      setDirtySections(new Set());
      setPriceInputs({});
      setFeedback("Offer published.");
      router.refresh();
    } catch (cause) {
      setFeedback(humanError(refusalCode(cause, "OFFER_PUBLISH_REFUSED")).body);
    } finally {
      setBusy(null);
    }
  }

  const saveReason =
    busy !== null
      ? "Wait for the current action to finish"
      : Object.keys(fieldErrors).length
        ? "Fix the highlighted fields first"
        : !dirty
          ? "Nothing to save"
          : null;
  const publishReason =
    busy !== null
      ? "Wait for the current action to finish"
      : dirty
        ? "Save your changes first"
        : !offers.draft
          ? "Nothing to publish yet"
          : null;
  /**
   * The page spends at most one solid accent fill, and it belongs to whatever single action is
   * live right now: the attention queue's verb while the queue has something in it, otherwise
   * Publish, and otherwise nothing at all. Publishing is the one irreversible action here, so it
   * has to be findable at the moment it is actually available, which is the only moment it
   * exists; it drops back to secondary the instant the queue has a claim on the fill.
   */
  const publishOwnsFill = !publishReason;
  const dirtyDescription = dirty
    ? `Unsaved draft changes: ${dirtyLabels.join(", ")}`
    : "Your agent: draft is saved";

  return (
    <div className="flex min-w-0 flex-col gap-[var(--s-6)]">
      <CoachPageHead
        action={
          <a className={QUIET_BUTTON_CLASS} href="#try-a-conversation">
            <Sparkles aria-hidden className="size-[18px] shrink-0" />
            Try a conversation
          </a>
        }
        sub={`${countWord(COACH_OWNED_SECTIONS.length)} things are yours to set. SetterFi handles everything else and keeps it current.`}
        surface="agent"
        title="Your agent"
      />

      {feedback ? (
        <div
          className="surface-well text-[length:var(--coach-body)] leading-[1.5] text-[color:var(--body)]"
          role="status"
        >
          {feedback}
        </div>
      ) : null}

      {/*
        Four cards, all open, no tabs.

        `Agent.dc.html` draws the whole surface as a 2x2 grid of open cards and
        `SIMPLIFICATION-SPEC.md` §2.4 rules the six-tab rail a MERGE to four. The two that left --
        "Your program" and "Marketing assets" -- are content the coach supplies once rather than
        settings they tune, so they sit in a closed disclosure under the managed strip instead of
        holding a quarter of the page. They are demoted rather than deleted: the spec sends them to
        "an intake request", and the only intake channel that exists today is `/coach/help`, which
        is a support conversation and cannot yet carry a program description or an asset link as a
        structured field. Deleting the editor before that field exists would strand every column it
        writes, so the editor keeps working where it is and the demote is the placement.
      */}
      <div className="grid min-w-0 grid-cols-1 items-start gap-[20px] md:grid-cols-2">
          <TitlePanel
            aside={<CardStatePill answer={answers.prices} />}
            className={OFFER_CARD_CLASS}
            headingId="offer-card-prices"
            sentence="Your agent quotes these exactly. It will never invent a price or offer a discount."
            title="What you charge"
          >
                  <SettingsCard
                    action={
                        <>
                          <ExportMenu
                            filename="setterfi-offer-prices"
                            mode="server"
                            query={{
                              order: "created_desc",
                              columns: [
                                "id",
                                "offerId",
                                "label",
                                "amountCents",
                                "billingPeriod",
                                "createdAt",
                              ],
                            }}
                            resource="offer-prices"
                          />
                          <Button
                            disabled={form.prices.length >= OFFER_BOUNDS.price.maxRows}
                            onClick={() => {
                              addId("prices");
                              update(
                                "prices",
                                [
                                  ...form.prices,
                                  {
                                    label: "",
                                    amountCents: 0,
                                    billingPeriod: null,
                                  },
                                ],
                                "prices",
                              );
                            }}
                            type="button"
                            variant="outline"
                          >
                            Add price
                          </Button>
                        </>
                      }
                    answer={answers.prices}
                    description="Only these figures can be said to a lead. If a price is not listed, the agent qualifies the lead first and says you will confirm the number on the call."
                    title="Prices your agent can quote"
                  >
                    <PricesPanel prices={form.prices}>
                    {form.prices.length ? (
                      /*
                        Not an ARIA table. The previous markup declared role="table" and
                        role="row" while never declaring a single role="cell", so a screen reader
                        announced rows with nothing in them, and the removal confirm below carries
                        role="alert" inside one of those rows. These are grouped form fields, so
                        they render as the divide-y row list the assets editor already uses, which
                        also leaves this file with one list idiom instead of three.
                      */
                      <div className="divide-y divide-[var(--line-soft)] border-y border-[var(--line)]">
                        {form.prices.map((row, index) => (
                          <div
                            className="grid gap-[var(--s-3)] py-[var(--s-4)] @md/card:grid-cols-2 @md/card:gap-[var(--s-4)]"
                            key={ids.prices[index]}
                          >
                            <Field label="Product name">
                              <Input
                                maxLength={OFFER_BOUNDS.price.labelMax}
                                onChange={(event) =>
                                  update(
                                    "prices",
                                    form.prices.map((item, itemIndex) =>
                                      itemIndex === index
                                        ? { ...item, label: event.target.value }
                                        : item,
                                    ),
                                    "prices",
                                  )
                                }
                                value={row.label}
                              />
                            </Field>
                            <CurrencyInput
                              currency="USD"
                              error={fieldErrors[`price:${ids.prices[index]}`]}
                              label="Price"
                              onChangeCents={(value) => updatePrice(index, value)}
                              valueCents={
                                Object.hasOwn(priceInputs, ids.prices[index])
                                  ? priceInputs[ids.prices[index]]
                                  : row.amountCents
                              }
                            />
                            <SelectField
                              label="Billing period"
                              onValueChange={(next) =>
                                update(
                                  "prices",
                                  form.prices.map((item, itemIndex) =>
                                    itemIndex === index
                                      ? {
                                          ...item,
                                          billingPeriod: (next ||
                                            null) as typeof item.billingPeriod,
                                        }
                                      : item,
                                  ),
                                  "prices",
                                )
                              }
                              options={[
                                { value: "one_time", label: "One time" },
                                { value: "monthly", label: "Monthly" },
                                { value: "annual", label: "Annual" },
                              ]}
                              value={row.billingPeriod}
                            />
                            <div className="flex justify-start @md/card:col-span-2">
                              <Button
                                aria-label={`Remove ${row.label || `price ${index + 1}`}`}
                                onClick={() =>
                                  requestRemove(
                                    "prices",
                                    index,
                                    row.label || `price ${index + 1}`,
                                  )
                                }
                                size="icon"
                                type="button"
                                variant="ghost"
                              >
                                <Trash2 aria-hidden />
                              </Button>
                            </div>
                            {removal?.kind === "prices" &&
                            removal.id === ids.prices[index] ? (
                              <InlineRemoveConfirm
                                label={removal.label}
                                onCancel={() => setRemoval(null)}
                                onConfirm={confirmRemove}
                              />
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className={WELL_CLASS}>
                        <h3 className="text-[13px] leading-[1.35] font-semibold text-[color:var(--ink)]">
                          No prices are saved
                        </h3>
                        <p className="mt-[4px] max-w-[var(--measure-prose)] text-[12.5px] leading-[1.5] text-[color:var(--faint)]">
                          Your setter will not quote a number until you set these. Until then it
                          answers a price question by qualifying the lead first and handing the number
                          back to you.
                        </p>
                      </div>
                    )}
                    </PricesPanel>
                  </SettingsCard>
          </TitlePanel>

          <TitlePanel
            aside={<CardStatePill answer={answers.qualification} />}
            className={OFFER_CARD_CLASS}
            headingId="offer-card-qualification"
            sentence="Anyone under these numbers is turned away politely, before it reaches you."
            title="Who is worth your time"
          >
                  <SettingsCard
                    answer={answers.qualification}
                    description="The agent can qualify only against these saved facts. A field you leave empty stays unknown, and the agent never guesses at it."
                    title="The rules for who qualifies"
                  >
                    <p className="max-w-[var(--measure-prose)] text-[12.5px] leading-[1.5] text-[color:var(--faint)]">
                      The sentences on the card are written from these numbers, so they always say
                      exactly what is saved. Deciding the outcome is ours: your setter reads these to
                      answer and to ask the right questions, and SetterFi runs the rules that settle
                      whether a lead is qualified.
                    </p>
                    <DisqualifiersPanel
                      lines={THRESHOLD_TEMPLATES.map((template) => ({
                        key: template.key,
                        ...template.sentence(form),
                      }))}
                    >
                    <div className="grid gap-[var(--s-4)] @md/card:grid-cols-2">
                      <Field
                        error={fieldErrors.creditMin}
                        hint="Your setter reads this when credit comes up, and asks accordingly."
                        label="Minimum credit score"
                      >
                        <Input
                          max={850}
                          min={300}
                          onChange={(event) =>
                            updateInteger(
                              "creditMin",
                              event.target.value,
                              "Minimum credit score",
                              "qualification",
                            )
                          }
                          type="number"
                          value={form.creditMin ?? ""}
                        />
                      </Field>
                      <CurrencyInput
                        currency="USD"
                        hint="The smallest amount you will take a call about."
                        label="Minimum funding goal"
                        onChangeCents={(value) =>
                          update("fundingGoalMinCents", value, "qualification")
                        }
                        valueCents={form.fundingGoalMinCents}
                      />
                      <CurrencyInput
                        currency="USD"
                        hint="Above this, your program is not the right fit."
                        label="Maximum funding goal"
                        onChangeCents={(value) =>
                          update("fundingGoalMaxCents", value, "qualification")
                        }
                        valueCents={form.fundingGoalMaxCents}
                      />
                      <CurrencyInput
                        currency="USD"
                        hint="Your setter reads this when revenue comes up, and asks accordingly."
                        label="Minimum monthly revenue"
                        onChangeCents={(value) =>
                          update("monthlyRevenueMinCents", value, "qualification")
                        }
                        valueCents={form.monthlyRevenueMinCents}
                      />
                      <SelectField
                        hint="What the agent says when a lead needs their credit fixed first."
                        label="Credit repair"
                        onValueChange={(next) =>
                          update(
                            "creditRepair",
                            (next || null) as CoachOfferDraftInput["creditRepair"],
                            "qualification",
                          )
                        }
                        options={[
                          { value: "yes_included", label: "Included" },
                          { value: "yes_extra_fee", label: "Available for an extra fee" },
                          { value: "no_refer_out", label: "Refer the lead out" },
                          { value: "no_good_credit_only", label: "Good credit required" },
                        ]}
                        value={form.creditRepair}
                      />
                      <Field
                        error={fieldErrors.resultsTimelineMinDays}
                        hint="The soonest a client of yours has seen a result. The agent states this as a range, never as a promise."
                        label="Shortest results timeline in days"
                      >
                        <Input
                          min={0}
                          onChange={(event) =>
                            updateInteger(
                              "resultsTimelineMinDays",
                              event.target.value,
                              "Shortest results timeline",
                              "qualification",
                            )
                          }
                          type="number"
                          value={form.resultsTimelineMinDays ?? ""}
                        />
                      </Field>
                      <Field
                        error={fieldErrors.resultsTimelineMaxDays}
                        hint="The far side of that same range."
                        label="Longest results timeline in days"
                      >
                        <Input
                          min={0}
                          onChange={(event) =>
                            updateInteger(
                              "resultsTimelineMaxDays",
                              event.target.value,
                              "Longest results timeline",
                              "qualification",
                            )
                          }
                          type="number"
                          value={form.resultsTimelineMaxDays ?? ""}
                        />
                      </Field>
                      <SelectField
                        hint="What the agent says when a lead asks about getting their money back."
                        label="Refund policy"
                        onValueChange={(next) =>
                          update(
                            "refundPosture",
                            (next || null) as CoachOfferDraftInput["refundPosture"],
                            "qualification",
                          )
                        }
                        options={[
                          { value: "none", label: "No refunds" },
                          { value: "conditional", label: "Conditional" },
                          { value: "published_policy", label: "Use the published policy" },
                        ]}
                        value={form.refundPosture}
                      />
                    </div>
                    </DisqualifiersPanel>
                  </SettingsCard>
          </TitlePanel>

          <TitlePanel
            aside={<CardStatePill answer={answers.voice} />}
            className={OFFER_CARD_CLASS}
            headingId="offer-card-voice"
            sentence="Pick the tone. Your agent writes every message in it."
            title="How your agent sounds"
          >
                  <SettingsCard
                    answer={answers.voice}
                    description="Give the agent a clear voice. None of this changes the facts, the safeguards, or the outcomes it is allowed to state."
                    title="How you sound"
                  >
                    <p className={`max-w-[var(--measure-prose)] text-[12.5px] leading-[1.5] text-[color:var(--faint)] ${WELL_CLASS}`}>
                      Until you change something here, the agent uses our standard voice for funding
                      offers. That voice is already live, so nothing is missing while this is untouched.
                    </p>
                    <VoicePanel
                      brandVoice={form.brandVoice}
                      onBrandVoiceChange={(next: VoiceRegister) =>
                        update(
                          "brandVoice",
                          next as CoachOfferDraftInput["brandVoice"],
                          "voice",
                        )
                      }
                      styleAnswer={form.voiceStyleAnswer}
                      writtenCount={
                        [
                          form.voiceStyleAnswer,
                          form.voiceObjectionAnswer,
                          form.voiceFollowupAnswer,
                        ].filter((value) => Boolean(value && value.trim())).length
                      }
                    >
                    <Field
                      hint="Describe how a reply should feel in one or two sentences."
                      label="What should your style sound like?"
                    >
                      <Textarea
                        maxLength={OFFER_BOUNDS.voiceAnswerMax}
                        onChange={(event) =>
                          update(
                            "voiceStyleAnswer",
                            event.target.value || null,
                            "voice",
                          )
                        }
                        value={form.voiceStyleAnswer ?? ""}
                      />
                    </Field>
                    <Field
                      hint="Give the tone you use when someone pushes back, without promising an outcome."
                      label="How do you answer an objection?"
                    >
                      <Textarea
                        maxLength={OFFER_BOUNDS.voiceAnswerMax}
                        onChange={(event) =>
                          update(
                            "voiceObjectionAnswer",
                            event.target.value || null,
                            "voice",
                          )
                        }
                        value={form.voiceObjectionAnswer ?? ""}
                      />
                    </Field>
                    <Field
                      hint="Describe a useful follow-up that still sounds like you."
                      label="How do you follow up?"
                    >
                      <Textarea
                        maxLength={OFFER_BOUNDS.voiceAnswerMax}
                        onChange={(event) =>
                          update(
                            "voiceFollowupAnswer",
                            event.target.value || null,
                            "voice",
                          )
                        }
                        value={form.voiceFollowupAnswer ?? ""}
                      />
                    </Field>
                    </VoicePanel>
                  </SettingsCard>
          </TitlePanel>

          <TitlePanel
            aside={<CardStatePill answer={answers.cadence} />}
            className={OFFER_CARD_CLASS}
            headingId="offer-card-cadence"
            sentence="SetterFi decides when to follow up. You decide what each message is for."
            title="Chasing a quiet lead"
          >
          <CadenceFace purposes={form.cadencePurposes} schedule={cadenceSchedule} />
                  <SettingsCard
                    answer={answers.cadence}
                    description="We set which channels follow up, how many touches they get, and when each one fires. You choose what each touch is for. Every sequence stops the moment the lead replies or opts out."
                    title="When your agent follows up"
                  >
                    {cadence.enabled ? null : (
                      <div
                        className="flex flex-col gap-[var(--s-2)] rounded-[var(--r-card)] border border-[var(--warning-line)] bg-[var(--warning-wash)] p-[var(--s-3)]"
                        role="status"
                      >
                        <p className="flex items-center gap-[var(--s-2)] text-over text-[color:var(--warning-text)]">
                          <span aria-hidden className="size-[5px] shrink-0 rounded-full bg-[var(--warning)]" />
                          Not sending yet
                        </p>
                        <p className="max-w-[var(--measure-prose)] text-body text-[color:var(--body)]">
                          Live follow-up is not switched on yet. You can save a purpose for every touch,
                          and this schedule makes no claim that a message has been sent.
                        </p>
                      </div>
                    )}

                    {/*
                      Stacked rows, not a table. The four-column grid was a full-width-panel
                      assumption: it needed 560px, and an open card is 390px to 540px, so it
                      survived the move to card width only as a sideways scrollbar. Every
                      attribution the column headers used to carry now rides on each touch
                      instead, because "we choose when, you choose what for" is the claim this
                      section exists to make and it cannot live in furniture that no longer
                      renders.
                    */}
                    <section
                      aria-label="Follow-up schedule"
                      className="flex min-w-0 flex-col gap-[var(--s-4)]"
                    >
                      {cadenceSchedule.map((group) => (
                        <div className="min-w-0" key={group.channelClass}>
                          <h3 className="text-[13px] leading-[1.35] font-semibold text-[color:var(--ink)]">
                            {group.channelLabel}
                          </h3>
                          <p className="mt-[4px] max-w-[var(--measure-prose)] text-[12.5px] leading-[1.5] text-[color:var(--faint)]">
                            {group.channelNote}
                          </p>
                          {group.humanOnlyAfterWindow ? (
                            <p className="mt-[6px] flex items-start gap-[6px] text-[12px] leading-[1.45] text-[color:var(--meta)]">
                              <ShieldCheck
                                aria-hidden
                                className="mt-[2px] size-[var(--s-3)] shrink-0"
                              />
                              Follow-up after the reply window stays human-only.
                            </p>
                          ) : null}
                          <ul className="mt-[10px] flex list-none flex-col p-0">
                            {group.touches.map((touch) => {
                              const saved = savedPurposeFor(
                                form.cadencePurposes,
                                group.channelClass,
                                touch.touchNo,
                              );
                              return (
                                <li
                                  className="grid min-w-0 gap-[10px] border-t border-[var(--line-soft)] py-[11px] @md/card:grid-cols-[minmax(0,1fr)_200px] @md/card:items-start"
                                  data-purpose-set={saved ? "true" : "false"}
                                  key={`${group.channelClass}:${touch.touchNo}`}
                                >
                                  <div className="min-w-0" data-timing="platform">
                                    <span className={`${EYEBROW_CLASS} mb-[6px]`}>
                                      Touch {touch.touchNo}, when{" "}
                                      <span className="tracking-normal normal-case">
                                        set by platform
                                      </span>
                                    </span>
                                    <span className="block text-[13px] leading-[1.45] text-[color:var(--body)]">
                                      {touch.when}
                                    </span>
                                  </div>
                                  <div className="min-w-0 [&_[data-slot=kit-field-label]]:sr-only">
                                    <span className={`${EYEBROW_CLASS} mb-[6px]`}>
                                      Purpose{" "}
                                      <span className="tracking-normal normal-case">yours</span>
                                    </span>
                                    <Select
                                      label={`${group.channelLabel} touch ${touch.touchNo} purpose`}
                                      onValueChange={(next) =>
                                        setCadencePurpose(
                                          group.channelClass,
                                          touch.touchNo,
                                          next || touch.defaultPurpose,
                                        )
                                      }
                                      options={OFFER_CADENCE_PURPOSES.map((value) => ({
                                        value,
                                        label: OFFER_CADENCE_PURPOSE_LABELS[value],
                                      }))}
                                      value={saved ?? touch.defaultPurpose}
                                    />
                                    <p
                                      className={
                                        saved
                                          ? "mt-[6px] flex items-center gap-[6px] font-[family-name:var(--font-mono)] text-[10.5px] leading-none text-[color:var(--accent-text)]"
                                          : "mt-[6px] flex items-center gap-[6px] font-[family-name:var(--font-mono)] text-[10.5px] leading-none text-[color:var(--meta)]"
                                      }
                                    >
                                      <span
                                        aria-hidden
                                        className={
                                          saved
                                            ? "size-[5px] shrink-0 rounded-full bg-[var(--accent-bright)]"
                                            : "size-[5px] shrink-0 rounded-full bg-[var(--dim)]"
                                        }
                                      />
                                      {saved ? "set by you" : "our default"}
                                    </p>
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      ))}
                    </section>

                    <p className="max-w-[var(--measure-wide)] text-[length:var(--t-badge)] leading-[var(--t-body-lh)] font-normal text-[color:var(--faint)]">
                      Timing cannot be changed here because message frequency is reviewed with each
                      platform release. A touch you have not chosen a purpose for uses the platform
                      default shown above.
                    </p>

                    {orphanCadencePurposes.length ? (
                      <div className="flex flex-col gap-[var(--s-3)]">
                        <h3 className="text-[length:var(--t-row)] font-[var(--t-row-w)] text-[color:var(--ink)]">
                          Saved purposes outside this schedule
                        </h3>
                        <p className="max-w-[var(--measure-wide)] text-body text-[color:var(--muted)]">
                          These were saved against a touch the platform no longer schedules, so the
                          agent cannot use them. Remove them to keep the draft clean.
                        </p>
                        <div className="border-y border-[var(--line)]">
                          {orphanCadencePurposes.map(({ row, index }) => (
                            <div
                              className="flex flex-wrap items-center justify-between gap-[var(--s-3)] border-b border-[var(--line)] py-[var(--s-3)] last:border-b-0"
                              key={ids.cadencePurposes[index]}
                            >
                              <span className="text-body text-[color:var(--body)]">
                                {OFFER_CADENCE_CHANNEL_LABELS[row.channelClass]}, touch {row.touchNo},{" "}
                                {OFFER_CADENCE_PURPOSE_LABELS[row.purpose]}
                              </span>
                              <Button
                                aria-label={`Remove touch ${row.touchNo}`}
                                onClick={() =>
                                  requestRemove(
                                    "cadencePurposes",
                                    index,
                                    `touch ${row.touchNo}`,
                                  )
                                }
                                size="icon"
                                type="button"
                                variant="ghost"
                              >
                                <Trash2 aria-hidden />
                              </Button>
                              {removal?.kind === "cadencePurposes" &&
                              removal.id === ids.cadencePurposes[index] ? (
                                <InlineRemoveConfirm
                                  label={removal.label}
                                  onCancel={() => setRemoval(null)}
                                  onConfirm={confirmRemove}
                                />
                              ) : null}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </SettingsCard>
          </TitlePanel>
      </div>

      <ManagedStrip />

      <ProgramAndAssets>
        <div className="flex flex-col gap-[var(--s-5)]">
                  <SettingsCard
                    answer={answers.business}
                    description="Name the program, choose the products it covers, and set how a qualified lead reaches your calendar."
                    title="Your program"
                  >
                    <div className="grid gap-[var(--s-4)] @md/card:grid-cols-2">
                      <Field
                        hint="The name the agent uses when a lead asks what you run."
                        label="Program name"
                      >
                        <Input
                          maxLength={OFFER_BOUNDS.programNameMax}
                          onChange={(event) => update("programName", event.target.value, "business")}
                          value={form.programName}
                        />
                      </Field>
                      <SelectField
                        hint="Whether the agent books the call itself or sends your booking link."
                        label="Booking method"
                        onValueChange={(next) =>
                          update("bookingMode", next as "direct" | "link", "business")
                        }
                        options={[
                          { value: "direct", label: "Book directly" },
                          { value: "link", label: "Send a booking link" },
                        ]}
                        value={form.bookingMode}
                      />
                      <div className="@md/card:col-span-2">
                        <Field
                          hint="A short description the agent can paraphrase. It never quotes a figure from this."
                          label="Program description"
                        >
                          <Textarea
                            maxLength={OFFER_BOUNDS.programDescriptionMax}
                            onChange={(event) =>
                              update(
                                "programDescription",
                                event.target.value || null,
                                "business",
                              )
                            }
                            value={form.programDescription ?? ""}
                          />
                        </Field>
                      </div>
                      <Field
                        hint="How far into the future a lead may pick a time."
                        label="Days a lead can book ahead"
                      >
                        <Input
                          min={1}
                          onChange={(event) =>
                            update(
                              "bookingHorizonDays",
                              Math.max(1, Number(event.target.value)),
                              "business",
                            )
                          }
                          type="number"
                          value={form.bookingHorizonDays}
                        />
                      </Field>
                    </div>

                    <fieldset>
                      <legend className="text-[length:var(--t-row)] font-[var(--t-row-w)] text-[color:var(--ink)]">
                        Products your program covers
                      </legend>
                      <p className="mt-[var(--s-1)] max-w-[var(--measure-prose)] text-[length:var(--t-badge)] leading-[var(--t-body-lh)] font-normal text-[color:var(--muted)]">
                        The agent only offers a product you tick here. Anything unticked, it treats as
                        something you do not do.
                      </p>
                      <div className="mt-[var(--s-3)] divide-y divide-[var(--line)] border-y border-[var(--line)]">
                        {OFFER_PRODUCTS.map((product) => (
                          <label
                            className="flex min-h-[var(--row-h)] cursor-pointer items-center gap-[var(--s-3)] px-[var(--s-2)] text-body text-[color:var(--body)] hover:bg-[var(--row-hover)]"
                            key={product}
                          >
                            <Checkbox
                              checked={form.products.includes(product)}
                              onCheckedChange={() =>
                                update(
                                  "products",
                                  form.products.includes(product)
                                    ? form.products.filter((value) => value !== product)
                                    : [...form.products, product],
                                  "business",
                                )
                              }
                            />
                            <span>{OFFER_PRODUCT_LABELS[product]}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>

                    {availability ? <AvailabilityPanel {...availability} /> : null}
                  </SettingsCard>

                  <div className="flex flex-col gap-[var(--s-4)]">
                    <SettingsCard
                      action={
                          <>
                            <ExportMenu
                              filename="setterfi-offer-assets"
                              mode="server"
                              query={{
                                order: "created_desc",
                                columns: [
                                  "id",
                                  "offerId",
                                  "slug",
                                  "label",
                                  "url",
                                  "createdAt",
                                ],
                              }}
                              resource="offer-assets"
                            />
                            <Button
                              disabled={form.assets.length >= OFFER_BOUNDS.asset.maxRows}
                              onClick={() => {
                                addId("assets");
                                update(
                                  "assets",
                                  [...form.assets, { slug: "", label: "", url: "" }],
                                  "assets",
                                );
                              }}
                              type="button"
                              variant="outline"
                            >
                              Add asset
                            </Button>
                          </>
                      }
                      answer={
                        form.assets.length
                          ? { set: true, text: plural(form.assets.length, "asset", "assets") }
                          : { set: false, text: "no asset saved" }
                      }
                      description="The lead magnets and videos a saved follow-up purpose may send. Links must use HTTPS."
                      title="Marketing assets"
                    >
                      <div className="divide-y divide-[var(--line)] border-y border-[var(--line)]">
                        {form.assets.map((row, index) => (
                          <div
                            className="grid gap-[var(--s-3)] py-[var(--s-4)] @md/card:grid-cols-2"
                            key={ids.assets[index]}
                          >
                            <Field
                              hint="What you call it. The agent never reads this to a lead."
                              label="Asset name"
                            >
                              <Input
                                maxLength={OFFER_BOUNDS.asset.labelMax}
                                onChange={(event) =>
                                  update(
                                    "assets",
                                    form.assets.map((item, itemIndex) =>
                                      itemIndex === index
                                        ? { ...item, label: event.target.value }
                                        : item,
                                    ),
                                    "assets",
                                  )
                                }
                                value={row.label}
                              />
                            </Field>
                            <Field
                              hint="A short handle you pick a follow-up purpose by."
                              label="Short reference"
                            >
                              <Input
                                maxLength={OFFER_BOUNDS.asset.slugMax}
                                onChange={(event) =>
                                  update(
                                    "assets",
                                    form.assets.map((item, itemIndex) =>
                                      itemIndex === index
                                        ? { ...item, slug: event.target.value }
                                        : item,
                                    ),
                                    "assets",
                                  )
                                }
                                value={row.slug}
                              />
                            </Field>
                            <div className="@md/card:col-span-2">
                              <Field
                                hint="Where the lead lands. This is the only link the agent will send for this asset."
                                label="HTTPS link"
                              >
                                <Input
                                  maxLength={OFFER_BOUNDS.asset.urlMax}
                                  onChange={(event) =>
                                    update(
                                      "assets",
                                      form.assets.map((item, itemIndex) =>
                                        itemIndex === index
                                          ? { ...item, url: event.target.value }
                                          : item,
                                      ),
                                      "assets",
                                    )
                                  }
                                  type="url"
                                  value={row.url}
                                />
                              </Field>
                            </div>
                            <Button
                              className="justify-self-start"
                              onClick={() =>
                                requestRemove(
                                  "assets",
                                  index,
                                  row.label || `asset ${index + 1}`,
                                )
                              }
                              type="button"
                              variant="ghost"
                            >
                              <Trash2 aria-hidden />
                              Remove
                            </Button>
                            {removal?.kind === "assets" &&
                            removal.id === ids.assets[index] ? (
                              <InlineRemoveConfirm
                                label={removal.label}
                                onCancel={() => setRemoval(null)}
                                onConfirm={confirmRemove}
                              />
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </SettingsCard>

                    <SettingsCard
                      action={
                          <>
                            <ExportMenu
                              filename="setterfi-offer-proof"
                              mode="server"
                              query={{
                                order: "created_desc",
                                columns: [
                                  "id",
                                  "offerId",
                                  "title",
                                  "detail",
                                  "createdAt",
                                ],
                              }}
                              resource="offer-proof"
                            />
                            <ActionButton
                              disabled={form.proof.length >= OFFER_BOUNDS.proof.maxRows}
                              onClick={() => {
                                addId("proof");
                                update(
                                  "proof",
                                  [...form.proof, { title: "", detail: "" }],
                                  "assets",
                                );
                              }}
                              type="button"
                              variant="outline"
                            >Add proof</ActionButton>
                          </>
                      }
                      answer={
                        form.proof.length
                          ? {
                              set: true,
                              text: plural(form.proof.length, "proof entry", "proof entries"),
                            }
                          : { set: false, text: "no proof saved" }
                      }
                      description="Proof can support an answer, but it never authorizes a price, a guarantee, or an outcome."
                      title="Proof and case studies"
                    >
                      <div className="divide-y divide-[var(--line)] border-y border-[var(--line)]">
                        {form.proof.map((row, index) => (
                          <div
                            className="grid gap-[var(--s-3)] py-[var(--s-4)]"
                            key={ids.proof[index]}
                          >
                            <Field
                              hint="How you refer to this story."
                              label="Title"
                            >
                              <Input
                                maxLength={OFFER_BOUNDS.proof.titleMax}
                                onChange={(event) =>
                                  update(
                                    "proof",
                                    form.proof.map((item, itemIndex) =>
                                      itemIndex === index
                                        ? { ...item, title: event.target.value }
                                        : item,
                                    ),
                                    "assets",
                                  )
                                }
                                value={row.title}
                              />
                            </Field>
                            <Field
                              hint="Write it the way the agent may repeat it. It cannot add a number or an outcome of its own."
                              label="What the agent may say"
                            >
                              <Textarea
                                maxLength={OFFER_BOUNDS.proof.detailMax}
                                onChange={(event) =>
                                  update(
                                    "proof",
                                    form.proof.map((item, itemIndex) =>
                                      itemIndex === index
                                        ? { ...item, detail: event.target.value }
                                        : item,
                                    ),
                                    "assets",
                                  )
                                }
                                value={row.detail}
                              />
                            </Field>
                            <Button
                              className="justify-self-start"
                              onClick={() =>
                                requestRemove(
                                  "proof",
                                  index,
                                  row.title || `proof entry ${index + 1}`,
                                )
                              }
                              type="button"
                              variant="ghost"
                            >
                              <Trash2 aria-hidden />
                              Remove
                            </Button>
                            {removal?.kind === "proof" &&
                            removal.id === ids.proof[index] ? (
                              <InlineRemoveConfirm
                                label={removal.label}
                                onCancel={() => setRemoval(null)}
                                onConfirm={() => {
                                  const removedId = ids.proof[index];
                                  setIds((current) => ({
                                    ...current,
                                    proof: current.proof.filter((id) => id !== removedId),
                                  }));
                                  setRemoval(null);
                                  update("proof", form.proof.filter((_, rowIndex) => rowIndex !== index), "assets");
                                }}
                              />
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </SettingsCard>
                  </div>
        </div>
      </ProgramAndAssets>

      <ObjectionPushback rows={objections} />

            {/*
              The save bar, drawn as the canvas's sticky footer: one sentence on the left saying
              what pressing something will do, the controls on the right, at coach sizes.

              WHAT THIS DOES NOT DO. The canvas collapses this to a single Save and drops the
              draft/publish lifecycle entirely. That is a behaviour change, not an appearance one,
              and `REDESIGN-CANVAS.md` is explicit that the canvas wins on appearance while
              `SIMPLIFICATION-SPEC.md` wins on behaviour -- where the spec still lists one-Save as
              open question Q4, unanswered by Alec. Publishing is also the seam the platform review
              of grounding, pricing, guarantees and outcomes hangs off, it carries its own audit
              action (`offer.published`), and `POST /api/coach/offer/publish` is a separate
              endpoint from the draft save. So the verbs stay two here and the copy stays honest
              about what each one does. Flipping this is one prop and one handler once Q4 is
              answered; inventing the answer on the way past would have been the expensive mistake.
            */}
            <div
                aria-label="Save and publish your agent"
                className="sticky bottom-[var(--s-4)] z-[var(--z-sticky)] mt-[var(--s-6)] rounded-[22px_22px_17px_17px] border border-[var(--line-strong)] bg-[var(--raised)] px-[24px] py-[18px] shadow-[var(--shadow-toast)]"
                role="region"
              >
                <div className="flex flex-wrap items-center justify-between gap-[var(--s-4)]">
                  <div className="min-w-[min(100%,36ch)] flex-1">
                    <p className="text-[18px] leading-[1.35] font-medium text-[color:var(--ink)]">
                      {dirtyDescription}
                    </p>
                    {/*
                      The lifecycle badges, moved out of the page head and down to the bar that
                      owns the lifecycle. `Agent.dc.html` draws no badge at all because the canvas
                      collapses publishing to one Save -- but that is spec Q4, still unanswered,
                      and while two verbs exist a coach has to be able to see which of them the
                      live agent is running. Beside the verbs is where that belongs.
                    */}
                    <div className="mt-[8px] flex flex-wrap items-center gap-[var(--s-3)]">
                      <StateBadge
                        detail={
                          offers.published
                            ? publicationDate
                              ? `live, published ${publicationDate}`
                              : "live, publication date unavailable"
                            : undefined
                        }
                        kind="lifecycle"
                        label={
                          offers.published
                            ? `Published v${offers.published.version}`
                            : "No published version"
                        }
                        tone={offers.published ? "good" : "neutral"}
                      />
                      {offers.draft ? (
                        <StateBadge kind="lifecycle" label="Draft, unpublished" tone="warning" />
                      ) : null}
                    </div>
                    <p className="mt-[6px] max-w-[var(--measure-prose)] text-[length:var(--coach-body)] leading-[1.5] text-[color:var(--muted)]">
                      Saving updates the draft. Publishing submits that saved draft for platform
                      review before it changes live replies.
                    </p>
                    <div className="mt-[8px] flex flex-col gap-[4px]">
                      {saveReason ? (
                        <p
                          className="text-[length:var(--coach-body)] leading-[1.5] text-[color:var(--muted)]"
                          data-disabled-reason="save"
                        >
                          Save draft: {saveReason}.
                        </p>
                      ) : null}
                      {publishReason ? (
                        <p
                          className="text-[length:var(--coach-body)] leading-[1.5] text-[color:var(--muted)]"
                          data-disabled-reason="publish"
                        >
                          Publish: {publishReason}.
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-[12px]">
                    <Button
                      disabled={!dirty || busy !== null}
                      onClick={discard}
                      type="button"
                      variant="ghost"
                    >
                      Discard
                    </Button>
                    <DisabledAction
                      button={
                        <Button
                          disabled={Boolean(saveReason)}
                          onClick={save}
                          type="button"
                          variant="outline"
                        >
                          {busy === "save" ? "Saving..." : "Save draft"}
                        </Button>
                      }
                      reason={saveReason}
                    />
                    <DisabledAction
                      button={
                        <LoggedButton
                          actionKey="offer.published"
                          className={publishOwnsFill ? PRIMARY_FILL_CLASS : undefined}
                          disabled={Boolean(publishReason)}
                          onClick={publishOffer}
                          type="button"
                          variant="secondary"
                        >
                          {publishedReceipt.logged
                            ? "Published"
                            : busy === "publish"
                              ? "Publishing..."
                              : "Publish"}
                        </LoggedButton>
                      }
                      reason={
                        publishReason
                      }
                    />
                  </div>
                </div>
              </div>

      <div id="try-a-conversation">
        <TestAgentPanel
          enabled={testEnabled}
          publishedRuntimeAvailable={publishedRuntimeAvailable}
        />
      </div>
    </div>
  );
}
