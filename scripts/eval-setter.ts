/**
 * Multi-turn setter eval: five lead personas, each played by a model, talk to the published
 * demo coach's setter until they book, leave, or the turn cap lands. The setter runs the real
 * engine turn (`runEngineTurn` over the published runtime bundle, the active moderator, the real
 * ranking) and this script replays the production state machine between turns: qualification
 * commands update the typed state, a BOOK outcome appends calendar times exactly as
 * `withBookingSlotOffer` does live, and a lead who replies with a slot id gets the confirmed
 * booking the live path would produce. Nothing is written to the database.
 *
 * What it measures is the funnel, not facts: did the setter reach the coach's BOOK rule, did the
 * lead book, how many turns it took, how many times the moderator or a check held the reply, and
 * a rubric judge's read of the transcript (answered before asking, one question at a time,
 * momentum toward the call, objection handling, tone). The facts side is `eval-engine.ts` and
 * `eval-knowledge-modes.ts`.
 *
 * Invoke with the hosted project's variables and the real drivers, for example:
 *
 *   env -u SUPABASE_SERVICE_ROLE_KEY -u SUPABASE_ANON_KEY -u SUPABASE_JWT_SECRET zsh -c \
 *     'set -a; source .env.local; set +a; SETTERFI_OPENROUTER_DRIVER=real SETTERFI_EMBEDDINGS_DRIVER=real \
 *      npx --yes tsx --tsconfig tsconfig.json scripts/eval-setter.ts \
 *      [--generator <openrouter model>] [--only <persona-substring>] [--max-turns <n>] [--json <path>]'
 *
 * `--generator` picks the generator row in model_configs for that model (lowest reasoning effort
 * when several exist); the active pair is used when omitted. The lead and judge models are fixed
 * so two generator runs differ only in the setter. Exit code 1 when any conversation errored,
 * 2 on a configuration error. Credential values are never printed.
 */

import { writeFileSync } from "node:fs";

import type { PublishedRuntimeBundle } from "@/lib/brain/contracts";
import { activeModelConfigurations } from "@/lib/engine/model-config";
import {
  engineBrainFromRuntimeBundle,
  engineOfferFromRuntimeBundle,
  runEngineTurn,
  type EnginePipelineInput,
} from "@/lib/engine/pipeline";
import type {
  EngineCommand,
  EngineTurnResult,
  ModeratorClass,
  PromptMessage,
  RuntimeQualificationState,
} from "@/lib/engine/types";
import {
  createMockModelDriver,
  createMockModeratorDriver,
  createRealModelDriver,
  createRealModeratorDriver,
} from "@/lib/integrations/openrouter";
import { selectModelDrivers } from "@/lib/integrations/selector";
import type { ModelDriver, ModeratorDriver } from "@/lib/integrations/types";
import { resolveDemoCoachTenant } from "@/lib/operations/smoke";
import { loadPublishedRuntimeBundle } from "@/lib/repositories/brain-runtime";
import { heldClassOf, type TestTurnChannel } from "@/lib/repositories/brain-test-turn";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { loadApprovedPlatformAgentContent } from "@/lib/webhooks/live-preview";
import { withBookingSlotOffer } from "@/lib/webhooks/process-inbound";

const LEAD_MODEL = { model: "anthropic/claude-sonnet-5", params: { temperature: 0.8 } } as const;
const JUDGE_MODEL = { model: "anthropic/claude-sonnet-5", params: { temperature: 0 } } as const;
const DEFAULT_MAX_TURNS = 10;

const REQUIRED_NAMES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENROUTER_API_KEY",
  "SETTERFI_TAG_SECRET",
] as const;
const REQUIRED_VALUES = {
  SETTERFI_OPENROUTER_DRIVER: "real",
  SETTERFI_EMBEDDINGS_DRIVER: "real",
  SETTERFI_PHASE2_LIVE: "true",
} as const;

function requireEnvironment() {
  const missing = REQUIRED_NAMES.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) throw new Error(`SETTER_EVAL_ENV_MISSING:${missing.join(",")}`);
  for (const [name, expected] of Object.entries(REQUIRED_VALUES)) {
    if (process.env[name]?.trim() !== expected) throw new Error(`SETTER_EVAL_ENV_VALUE:${name}=${expected}`);
  }
  return {
    tagSecret: process.env.SETTERFI_TAG_SECRET as string,
    apiKey: process.env.OPENROUTER_API_KEY as string,
  };
}

function parseArguments(argv: readonly string[]) {
  let generator: string | null = null;
  let only: string | null = null;
  let maxTurns = DEFAULT_MAX_TURNS;
  let json: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--generator") {
      generator = argv[index + 1] ?? null;
      if (!generator || !generator.includes("/")) throw new Error("SETTER_EVAL_GENERATOR_INVALID");
      index += 1;
    } else if (argument === "--only") {
      only = argv[index + 1] ?? null;
      if (!only) throw new Error("SETTER_EVAL_ONLY_INVALID");
      index += 1;
    } else if (argument === "--max-turns") {
      maxTurns = Number(argv[index + 1]);
      if (!Number.isInteger(maxTurns) || maxTurns < 2 || maxTurns > 20) throw new Error("SETTER_EVAL_MAX_TURNS_INVALID");
      index += 1;
    } else if (argument === "--json") {
      json = argv[index + 1] ?? null;
      if (!json) throw new Error("SETTER_EVAL_JSON_INVALID");
      index += 1;
    } else {
      throw new Error(`SETTER_EVAL_UNKNOWN_ARGUMENT:${argument}`);
    }
  }
  return { generator, only, maxTurns, json };
}

// ---------------------------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------------------------

/**
 * A lead the simulator plays. `facts` are what the persona knows about itself and will reveal
 * when asked (in its own words, never as bare numbers); `brief` is how it behaves; `opening` is
 * its first message. `expectation` says what a good outcome looks like for this persona given
 * the demo coach's rules (BOOK at 680+ credit or $100k+ revenue, SOFT_DQ otherwise, HARD_DQ
 * below 580), so the script can score against the right bar rather than "everyone books".
 */
type Persona = {
  key: string;
  channel: TestTurnChannel;
  label: string;
  opening: string;
  brief: string;
  facts: Record<string, string>;
  expectation: "book" | "nurture" | "decline";
};

const PERSONAS: readonly Persona[] = [
  {
    key: "skeptic",
    channel: "instagram",
    label: "Skeptic who thinks it is a scam",
    opening: "saw your ad. how do i know this isn't a scam? everyone online promises funding",
    brief: [
      "You are suspicious and a little rude at first. You ask whether they are lenders, whether there are upfront fees,",
      "and whether this is a credit repair scheme. You warm up only if the answers are straight and you are not being sold to.",
      "You will not book until at least two of your doubts have been answered plainly. If a reply feels salesy or dodges,",
      "say so. You do want funding, so if the setter is honest and asks sensible questions you will answer and eventually book.",
    ].join(" "),
    facts: {
      "credit score": "about 705 as of last month",
      business: "a landscaping company, operating for four years",
      "annual revenue": "roughly 180k last year",
      "funding goal": "somewhere around 100k for two trucks",
      timeline: "next couple of months",
    },
    expectation: "book",
  },
  {
    key: "price-shopper",
    channel: "messenger",
    label: "Price shopper who wants the number first",
    opening: "How much does this cost? I'm comparing a few options",
    brief: [
      "You want a price before anything else and you push for it twice. You mention you are comparing programmes.",
      "If they explain honestly why the price comes on the call, or that it depends, you accept it after the second ask.",
      "You answer qualification questions briefly when asked, sometimes with a question back. You book if the setter",
      "keeps the conversation moving and does not stonewall you.",
    ].join(" "),
    facts: {
      "credit score": "around 690",
      business: "an online store, running about two years",
      "annual revenue": "about 9k a month",
      "funding goal": "50 to 60k",
      timeline: "as soon as possible really",
    },
    expectation: "book",
  },
  {
    key: "tire-kicker",
    channel: "sms",
    label: "Tire-kicker with no business yet",
    opening: "hey just looking for some info on business funding",
    brief: [
      "You are vague and non-committal. You answer questions with short, hedged replies and often deflect with another",
      "question. You have not started a business yet and your credit is middling. You are not ready to book and will say",
      "'maybe later' if pushed; you only agree to anything if the setter is honest that this may not be the right time and",
      "tells you what would need to change. Two or three vague replies in, you drift off unless there is a clear reason to stay.",
    ].join(" "),
    facts: {
      "credit score": "mid 600s, maybe 650",
      business: "no business yet, just an idea for a food truck",
      "annual revenue": "nothing yet",
      "funding goal": "not sure, maybe 30k",
      timeline: "no rush, just exploring",
    },
    expectation: "nurture",
  },
  {
    key: "ready-buyer",
    channel: "whatsapp",
    label: "Ready buyer who wants to get on the calendar",
    opening: "Hi, I run a small logistics business and need working capital. What's the process to get started?",
    brief: [
      "You are decisive and polite. You answer every question in one short message, in natural language (never a bare",
      "number). You want to book as soon as it is offered. If offered times, you pick the first one that is not the",
      "very first slot and reply with its exact slot id. If given a link, say you will book now. You do not raise objections.",
    ].join(" "),
    facts: {
      "credit score": "740, checked it last week",
      business: "a logistics company, six years in",
      "annual revenue": "just over 400k",
      "funding goal": "150k for a second vehicle and payroll cover",
      timeline: "within the next 30 days",
    },
    expectation: "book",
  },
  {
    key: "burned",
    channel: "instagram",
    label: "Burned before, objection-heavy, qualifies on revenue",
    opening: "I paid a 'funding consultant' $2,500 last year and got nothing. Why would this be any different?",
    brief: [
      "You have been burned and lead with objections: past bad experience, 'you'll just pull my credit', 'I don't want",
      "hard inquiries', 'is there a guarantee'. You are testing whether they will promise things. You respect a setter",
      "who refuses to guarantee outcomes and acknowledges the bad experience. Your credit is fair but your business is",
      "real and profitable. Book only after the setter has handled at least two objections without hype and asked about",
      "your business rather than just your credit.",
    ].join(" "),
    facts: {
      "credit score": "660ish, a couple of late payments from that period",
      business: "a two-location barbershop, been open five years",
      "annual revenue": "about 220k across both shops",
      "funding goal": "80k to open a third location",
      timeline: "three to six months",
    },
    expectation: "book",
  },
];

// ---------------------------------------------------------------------------------------------
// Lead simulator
// ---------------------------------------------------------------------------------------------

type LeadTurn = { message: string; done: boolean; leaving: boolean; bookIntent: boolean; slotId: string | null };

function leadSystemPrompt(persona: Persona, offeredSlotIds: readonly string[]) {
  const facts = Object.entries(persona.facts).map(([key, value]) => `- ${key}: ${value}`).join("\n");
  return [
    `You are role-playing a lead messaging a business-funding coach's team over ${persona.channel}. Stay in character.`,
    `Persona: ${persona.label}.`,
    persona.brief,
    "What you know about yourself (reveal only when asked, in your own words, never as a bare number):",
    facts,
    "Style: write like a real person on a phone, one to three sentences, casual punctuation, no bullet points, no",
    "narration or stage directions. Never mention that you are playing a role or that this is a test.",
    offeredSlotIds.length
      ? `You were just offered appointment times with these slot ids: ${offeredSlotIds.join(", ")}. If you want to book, reply with one exact slot id.`
      : "",
    "Return only JSON: {\"message\": string, \"done\": boolean, \"leaving\": boolean, \"book_intent\": boolean, \"slot_id\": string | null}.",
    "done is true when you have booked, been told it is not a fit and accepted that, or decided to stop replying.",
    "leaving is true when you are dropping the conversation without booking. book_intent is true when you have",
    "agreed to book (picked a slot, or said you will use the link). slot_id is the exact id you picked, else null.",
  ].filter(Boolean).join("\n");
}

/** A lead model that answers in prose instead of the JSON envelope still said something; take it as the message. */
function parseLeadTurn(raw: string): LeadTurn {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  let record: Record<string, unknown> = {};
  if (start >= 0 && end > start) {
    try {
      const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
      if (parsed && typeof parsed === "object") record = parsed as Record<string, unknown>;
    } catch {
      record = {};
    }
  }
  if (typeof record.message !== "string") {
    const plain = raw.replace(/```[a-z]*|```/g, "").trim();
    if (!plain) throw new Error("SETTER_EVAL_LEAD_MESSAGE_EMPTY");
    return { message: plain, done: false, leaving: false, bookIntent: false, slotId: null };
  }
  const message = typeof record.message === "string" ? record.message.trim() : "";
  if (!message) throw new Error("SETTER_EVAL_LEAD_MESSAGE_EMPTY");
  return {
    message,
    done: record.done === true,
    leaving: record.leaving === true,
    bookIntent: record.book_intent === true,
    slotId: typeof record.slot_id === "string" && record.slot_id.trim() ? record.slot_id.trim() : null,
  };
}

async function nextLeadTurn(
  lead: ModelDriver,
  persona: Persona,
  transcript: readonly PromptMessage[],
  offeredSlotIds: readonly string[],
): Promise<{ turn: LeadTurn; cost: number | null }> {
  // The lead's own lines are the assistant role in its transcript, the setter's are the user role.
  const messages: PromptMessage[] = [
    { role: "system", content: leadSystemPrompt(persona, offeredSlotIds) },
    ...transcript.map((message): PromptMessage => ({
      role: message.role === "user" ? "assistant" : "user",
      content: message.content,
    })),
  ];
  const generated = await lead.generate(messages, { model: LEAD_MODEL.model, params: { ...LEAD_MODEL.params } });
  return { turn: parseLeadTurn(generated.draft), cost: generated.provider.cost };
}

// ---------------------------------------------------------------------------------------------
// The production state machine, replayed in memory
// ---------------------------------------------------------------------------------------------

type ConversationState = {
  status: "agent" | "needs_human" | "nurture" | "closed";
  currentStep: string | null;
  currentStepAsks: number;
  disclosurePending: boolean;
  qualification: RuntimeQualificationState;
  bookOutcomeAt: number | null;
  bookedAt: number | null;
  offeredSlotIds: readonly string[];
  holds: { turn: number; class: ModeratorClass | null; reason: string | null }[];
};

const EMPTY_QUALIFICATION: RuntimeQualificationState = {
  credit: null, goal: null, timeline: null, businessStage: null, annualRevenueCents: null, outcome: null, dqReason: null,
};

/** Mirrors `qualificationTurnRpcInput` + `persistResult`: what the RPC would write after this turn. */
function applyCommands(state: ConversationState, commands: readonly EngineCommand[], turn: number): ConversationState {
  let next: ConversationState = { ...state, qualification: { ...state.qualification } };
  for (const command of commands) {
    if (command.kind === "persist_qualification") {
      const { field, value } = command.value;
      if (field === "credit") next.qualification.credit = value as RuntimeQualificationState["credit"];
      else if (field === "goal") next.qualification.goal = value;
      else if (field === "timeline") next.qualification.timeline = value;
      else if (field === "businessStage") next.qualification.businessStage = value;
      else next.qualification.annualRevenueCents = value;
    } else if (command.kind === "advance_step") {
      next = { ...next, currentStep: command.nextStepId ?? null, currentStepAsks: 0 };
    } else if (command.kind === "increment_step_asks") {
      next = { ...next, currentStep: command.stepId, currentStepAsks: command.nextAskCount };
    } else if (command.kind === "record_hard_dq") {
      next.qualification.outcome = "HARD_DQ";
      next.qualification.dqReason = command.reason;
      next = { ...next, status: "closed", currentStep: null };
    } else if (command.kind === "record_qualification_outcome") {
      next.qualification.outcome = command.outcome;
      if (command.outcome === "BOOK") next = { ...next, bookOutcomeAt: next.bookOutcomeAt ?? turn, currentStep: null };
      else next = { ...next, status: "nurture", currentStep: null };
    } else if (command.kind === "record_booking_intent") {
      next = { ...next, bookedAt: turn, status: "closed" };
    } else if (command.kind === "record_booking_slot_offer") {
      next = { ...next, offeredSlotIds: command.slotIds };
    } else if (command.kind === "persist_agent_turn" && command.disclosureConsumed) {
      next = { ...next, disclosurePending: false };
    } else if (command.kind === "transition") {
      next = { ...next, status: command.state };
    }
  }
  return next;
}

/** The slot list production would append on a BOOK turn: five fixed times inside the horizon. */
function fakeProposal(horizonDays: number) {
  const proposedAt = new Date();
  const slots = [1, 2, 3, 5, 6].map((offset, index) => {
    const start = new Date(proposedAt.getTime() + offset * 86_400_000);
    start.setUTCHours(15 + (index % 3), 0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60_000);
    return {
      id: `eval-slot-${index + 1}`,
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      timezone: "America/New_York",
      display: start.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
    };
  });
  return {
    calendarConnectionId: "eval-calendar",
    rangeStartAt: proposedAt.toISOString(),
    rangeEndAt: new Date(proposedAt.getTime() + horizonDays * 86_400_000).toISOString(),
    proposedAt: proposedAt.toISOString(),
    presentationTimezone: "America/New_York",
    slots,
  };
}

// ---------------------------------------------------------------------------------------------
// One conversation
// ---------------------------------------------------------------------------------------------

type Harness = {
  bundle: PublishedRuntimeBundle;
  content: Awaited<ReturnType<typeof loadApprovedPlatformAgentContent>>;
  modelConfigs: EnginePipelineInput["modelConfigs"];
  drivers: { model: ModelDriver; moderator: ModeratorDriver };
  lead: ModelDriver;
  judge: ModelDriver;
  tagSecret: string;
  linkWhitelist: readonly string[];
  maxTurns: number;
};

type TurnRecord = {
  turn: number;
  lead: string;
  setter: string;
  held: boolean;
  heldClass: ModeratorClass | null;
  heldReason: string | null;
  ruleFired: string | null;
  attempts: number;
  currentStepBefore: string | null;
  commands: readonly string[];
  questionMarks: number;
  cost: number | null;
  wallMs: number;
};

type Rubric = {
  answersBeforeAsking: number;
  oneQuestionAtATime: number;
  momentum: number;
  objectionHandling: number;
  tone: number;
  compliance: number;
  overall: number;
  verdict: string;
  worstMoment: string;
};

type ConversationReport = {
  persona: string;
  label: string;
  channel: TestTurnChannel;
  expectation: Persona["expectation"];
  /** `booked_link`: the coach books by link and the lead said they used it; the engine cannot see that booking. */
  outcome: "booked" | "booked_link" | "book_offered" | "nurture" | "hard_dq" | "held" | "lead_left" | "max_turns" | "error";
  metExpectation: boolean;
  turns: number;
  turnsToBook: number | null;
  holds: number;
  multiQuestionReplies: number;
  meanSetterChars: number;
  qualification: RuntimeQualificationState;
  transcript: TurnRecord[];
  rubric: Rubric | null;
  setterCost: number;
  leadCost: number;
  error: string | null;
};

function publishedLinkWhitelist(bundle: PublishedRuntimeBundle) {
  const urls = [bundle.renderSources.bookingUrl, ...Object.values(bundle.renderSources.assetUrlsBySlug)];
  return [...new Set(urls.flatMap((value) => {
    if (!value) return [];
    try {
      return [new URL(value).hostname];
    } catch {
      return [];
    }
  }))];
}

function questionMarks(text: string) {
  return (text.match(/\?/g) ?? []).length;
}

async function runConversation(harness: Harness, persona: Persona): Promise<ConversationReport> {
  const transcript: PromptMessage[] = [];
  const records: TurnRecord[] = [];
  let state: ConversationState = {
    status: "agent", currentStep: null, currentStepAsks: 0, disclosurePending: true,
    qualification: { ...EMPTY_QUALIFICATION }, bookOutcomeAt: null, bookedAt: null, offeredSlotIds: [], holds: [],
  };
  let setterCost = 0;
  let leadCost = 0;
  let outcome: ConversationReport["outcome"] = "max_turns";
  let error: string | null = null;
  let leadMessage = persona.opening;
  try {
    for (let turn = 1; turn <= harness.maxTurns; turn += 1) {
      transcript.push({ role: "user", content: leadMessage });
      const started = Date.now();
      const pickedSlot = state.offeredSlotIds.find((id) => leadMessage.includes(id)) ?? null;
      let result: EngineTurnResult = await runEngineTurn({
        mode: "test",
        channel: persona.channel,
        brain: engineBrainFromRuntimeBundle(harness.bundle),
        offer: engineOfferFromRuntimeBundle(harness.bundle),
        conversation: {
          state: "agent",
          currentStep: state.currentStep,
          currentStepAsks: state.currentStepAsks,
          disclosurePending: state.disclosurePending,
        },
        history: [...transcript],
        leadMessage: { id: `setter-eval:${persona.key}:${turn}`, body: leadMessage },
        tagSecret: harness.tagSecret,
        automatedExperienceDisclosure: harness.content.automatedExperienceDisclosure,
        heldReplies: harness.content.heldReplies,
        linkWhitelist: harness.linkWhitelist,
        roleBoundary: harness.content.roleBoundary,
        modelConfigs: harness.modelConfigs,
        currentQuestion: null,
        extractionCandidate: null,
        qualificationState: state.qualification,
        runtimeBundle: harness.bundle,
        ...(pickedSlot
          ? {
              bookingSelection: {
                kind: "booked" as const,
                booking: { id: pickedSlot, startAt: "the time you picked", timezone: "America/New_York" },
              },
            }
          : {}),
      }, { model: harness.drivers.model, moderator: harness.drivers.moderator });
      // Production appends the calendar times on the turn the BOOK rule matched, when booking is direct.
      const bookNow = result.commands.some((command) => command.kind === "record_qualification_outcome" && command.outcome === "BOOK");
      if (bookNow && harness.bundle.offer.bookingMode === "direct" && result.trace.screen.verdict !== "held") {
        result = withBookingSlotOffer(result, fakeProposal(harness.bundle.offer.bookingHorizonDays));
      }
      const held = result.trace.screen.verdict === "held";
      const heldClass = heldClassOf(result, harness.content.heldReplies) ?? null;
      const before = state.currentStep;
      state = applyCommands(state, result.commands, turn);
      if (held) state.holds.push({ turn, class: heldClass, reason: result.trace.screen.reason });
      setterCost += result.trace.cost ?? 0;
      const reply = result.response.reply;
      records.push({
        turn,
        lead: leadMessage,
        setter: reply,
        held,
        heldClass,
        heldReason: held ? result.trace.screen.reason : null,
        ruleFired: result.trace.ruleFired,
        attempts: result.trace.attempts,
        currentStepBefore: before,
        commands: result.commands.map((command) => command.kind === "persist_qualification"
          ? `persist:${command.value.field}=${String(command.value.value)}`
          : command.kind === "record_qualification_outcome"
            ? `outcome:${command.outcome}`
            : command.kind === "advance_step"
              ? `advance→${command.nextStepId ?? "done"}`
              : command.kind),
        questionMarks: questionMarks(reply),
        cost: result.trace.cost,
        wallMs: Date.now() - started,
      });
      transcript.push({ role: "assistant", content: reply });
      if (state.bookedAt !== null) { outcome = "booked"; break; }
      if (state.qualification.outcome === "HARD_DQ") { outcome = "hard_dq"; break; }
      if (held) { outcome = "held"; break; }
      if (state.status === "nurture" && turn >= 2) { outcome = "nurture"; break; }
      if (turn === harness.maxTurns) break;
      const lead = await nextLeadTurn(harness.lead, persona, transcript, state.offeredSlotIds);
      leadCost += lead.cost ?? 0;
      if (lead.turn.leaving) {
        outcome = "lead_left";
        records.push({ ...records[records.length - 1], turn: turn + 1, lead: lead.turn.message, setter: "", held: false, heldClass: null, heldReason: null, ruleFired: null, attempts: 0, currentStepBefore: state.currentStep, commands: [], questionMarks: 0, cost: null, wallMs: 0 });
        break;
      }
      leadMessage = lead.turn.slotId && state.offeredSlotIds.includes(lead.turn.slotId)
        ? lead.turn.slotId
        : lead.turn.message;
      if (lead.turn.bookIntent && state.offeredSlotIds.length === 0 && /https?:\/\//u.test(transcript[transcript.length - 1].content)) {
        outcome = "booked_link";
        records.push({ ...records[records.length - 1], turn: turn + 1, lead: leadMessage, setter: "", held: false, heldClass: null, heldReason: null, ruleFired: null, attempts: 0, currentStepBefore: state.currentStep, commands: [], questionMarks: 0, cost: null, wallMs: 0 });
        break;
      }
      if (lead.turn.done && !lead.turn.bookIntent && !lead.turn.slotId) {
        outcome = state.status === "nurture" ? "nurture" : "lead_left";
        records.push({ ...records[records.length - 1], turn: turn + 1, lead: leadMessage, setter: "", held: false, heldClass: null, heldReason: null, ruleFired: null, attempts: 0, currentStepBefore: state.currentStep, commands: [], questionMarks: 0, cost: null, wallMs: 0 });
        break;
      }
    }
    if (outcome === "max_turns" && state.bookOutcomeAt !== null) outcome = "book_offered";
  } catch (caught) {
    outcome = "error";
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const setterReplies = records.filter((record) => record.setter);
  const metExpectation = persona.expectation === "book"
    ? outcome === "booked" || outcome === "booked_link" || outcome === "book_offered"
    : persona.expectation === "nurture"
      ? outcome === "nurture" || (outcome === "lead_left" && state.qualification.outcome !== "BOOK")
      : outcome === "hard_dq";
  const rubric = error ? null : await judgeConversation(harness.judge, persona, records, outcome).catch((caught: unknown) => {
    process.stderr.write(`judge failed for ${persona.key}: ${caught instanceof Error ? caught.message : String(caught)}\n`);
    return null;
  });
  return {
    persona: persona.key,
    label: persona.label,
    channel: persona.channel,
    expectation: persona.expectation,
    outcome,
    metExpectation,
    turns: setterReplies.length,
    turnsToBook: state.bookOutcomeAt,
    holds: state.holds.length,
    multiQuestionReplies: setterReplies.filter((record) => record.questionMarks > 1).length,
    meanSetterChars: setterReplies.length
      ? Math.round(setterReplies.reduce((sum, record) => sum + record.setter.length, 0) / setterReplies.length)
      : 0,
    qualification: state.qualification,
    transcript: records,
    rubric,
    setterCost,
    leadCost,
    error,
  };
}

// ---------------------------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------------------------

function judgePrompt(persona: Persona, records: readonly TurnRecord[], outcome: ConversationReport["outcome"]) {
  const lines = records.flatMap((record) => [
    `LEAD: ${record.lead}`,
    ...(record.setter ? [`SETTER${record.held ? " (HELD, sent the platform's holding line)" : ""}: ${record.setter}`] : []),
  ]);
  return [
    "You are grading an appointment setter's side of a DM conversation for a business-funding coach.",
    "The setter is automated. It must never guarantee outcomes, state prices or numbers the coach has not published,",
    "or give credit repair, legal or tax advice; within those limits, a good setter answers what was asked, asks one",
    "qualification question at a time, handles objections without hype, keeps momentum toward a booked call, and",
    "sounds like a person on the coach's team rather than a script.",
    `The lead persona: ${persona.label}. Expected good outcome for this persona: ${persona.expectation}. Actual outcome: ${outcome}.`,
    "Score the SETTER only, 1 to 5 each (5 = a top human setter would not change it), on:",
    "answers_before_asking, one_question_at_a_time, momentum, objection_handling (5 if none arose and none were needed),",
    "tone, compliance (no promises, no invented facts), overall.",
    "Then give a one-sentence verdict and the single worst setter line with why.",
    "Return only JSON: {\"answers_before_asking\":n,\"one_question_at_a_time\":n,\"momentum\":n,\"objection_handling\":n,\"tone\":n,\"compliance\":n,\"overall\":n,\"verdict\":string,\"worst_moment\":string}",
    "",
    "TRANSCRIPT",
    ...lines,
  ].join("\n");
}

async function judgeConversation(
  judge: ModelDriver,
  persona: Persona,
  records: readonly TurnRecord[],
  outcome: ConversationReport["outcome"],
): Promise<Rubric> {
  const generated = await judge.generate(
    [{ role: "user", content: judgePrompt(persona, records, outcome) }],
    { model: JUDGE_MODEL.model, params: { ...JUDGE_MODEL.params } },
  );
  const raw = generated.draft;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  const score = (key: string) => {
    const value = Number(parsed[key]);
    if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error(`SETTER_EVAL_JUDGE_SCORE_INVALID:${key}`);
    return value;
  };
  return {
    answersBeforeAsking: score("answers_before_asking"),
    oneQuestionAtATime: score("one_question_at_a_time"),
    momentum: score("momentum"),
    objectionHandling: score("objection_handling"),
    tone: score("tone"),
    compliance: score("compliance"),
    overall: score("overall"),
    verdict: String(parsed.verdict ?? ""),
    worstMoment: String(parsed.worst_moment ?? ""),
  };
}

// ---------------------------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------------------------

async function loadModelConfigs(generator: string | null): Promise<EnginePipelineInput["modelConfigs"]> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.from("model_configs").select("id, role, openrouter_model, params, active");
  if (error) throw new Error(`SETTER_EVAL_MODEL_CONFIG_READ_FAILED:${error.message}`);
  const rows = (data ?? []).map((row) => ({
    id: row.id,
    role: row.role as "generator" | "moderator",
    openrouterModel: row.openrouter_model,
    params: (row.params ?? {}) as Record<string, unknown>,
    active: row.active,
  }));
  if (!generator) return rows;
  const effort = (params: Record<string, unknown>) => {
    const reasoning = params.reasoning as { effort?: string } | undefined;
    return reasoning?.effort === "low" ? 0 : reasoning?.effort === "medium" ? 1 : reasoning?.effort === "high" ? 2 : -1;
  };
  const candidates = rows
    .filter((row) => row.role === "generator" && row.openrouterModel === generator)
    .sort((a, b) => effort(a.params) - effort(b.params));
  if (candidates.length === 0) throw new Error(`SETTER_EVAL_GENERATOR_UNKNOWN:${generator}`);
  const chosen = candidates[0];
  return rows.map((row) => row.role === "generator" ? { ...row, active: row.id === chosen.id } : row);
}

async function selectDrivers(modelConfigs: EnginePipelineInput["modelConfigs"]) {
  return selectModelDrivers({
    loadActiveConfigurations: async () => activeModelConfigurations(modelConfigs),
    factories: {
      mockModel: createMockModelDriver,
      mockModerator: createMockModeratorDriver,
      realModel: (_configuration, apiKey) => createRealModelDriver(apiKey),
      realModerator: (configuration, apiKey) => createRealModeratorDriver(apiKey, configuration),
    },
  });
}

function mean(values: readonly number[]) {
  return values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100 : null;
}

function printReport(reports: readonly ConversationReport[], generator: string) {
  process.stdout.write(`\n=== setter eval, generator ${generator} ===\n`);
  for (const report of reports) {
    process.stdout.write(`\n--- ${report.persona} (${report.channel}): ${report.label}\n`);
    process.stdout.write(`outcome ${report.outcome}${report.metExpectation ? " ✓" : " ✗"} (expected ${report.expectation}), ${report.turns} setter turns` +
      `${report.turnsToBook !== null ? `, BOOK rule matched on turn ${report.turnsToBook}` : ""}, holds ${report.holds}, multi-question replies ${report.multiQuestionReplies}` +
      `, facts: credit ${report.qualification.credit ?? "?"} / revenue ${report.qualification.annualRevenueCents !== null ? `$${report.qualification.annualRevenueCents / 100}` : "?"}` +
      `${report.error ? `, ERROR ${report.error}` : ""}\n`);
    if (report.rubric) {
      const r = report.rubric;
      process.stdout.write(`judge: overall ${r.overall}/5 (answers-first ${r.answersBeforeAsking}, one-question ${r.oneQuestionAtATime}, momentum ${r.momentum}, objections ${r.objectionHandling}, tone ${r.tone}, compliance ${r.compliance})\n`);
      process.stdout.write(`  verdict: ${r.verdict}\n  worst: ${r.worstMoment}\n`);
    }
    for (const record of report.transcript) {
      process.stdout.write(`  [${record.turn}] LEAD: ${record.lead}\n`);
      if (record.setter) {
        const meta = [record.currentStepBefore ? `step ${record.currentStepBefore.replace("qualification:", "")}` : null, ...record.commands.filter((c) => c.startsWith("persist") || c.startsWith("outcome") || c === "record_booking_intent")].filter(Boolean).join(", ");
        process.stdout.write(`      SETTER${record.held ? ` [HELD ${record.heldClass ?? "?"}: ${record.heldReason ?? record.ruleFired ?? "?"}]` : ""}${meta ? ` {${meta}}` : ""}: ${record.setter.replace(/\n/g, " / ")}\n`);
      }
    }
  }
  const scored = reports.filter((report) => report.rubric);
  const summary = {
    conversations: reports.length,
    metExpectation: reports.filter((report) => report.metExpectation).length,
    booked: reports.filter((report) => report.outcome === "booked" || report.outcome === "booked_link").length,
    bookRuleReached: reports.filter((report) => report.turnsToBook !== null).length,
    meanTurnsToBook: mean(reports.flatMap((report) => report.turnsToBook === null ? [] : [report.turnsToBook])),
    holds: reports.reduce((sum, report) => sum + report.holds, 0),
    multiQuestionReplies: reports.reduce((sum, report) => sum + report.multiQuestionReplies, 0),
    setterTurns: reports.reduce((sum, report) => sum + report.turns, 0),
    judge: {
      overall: mean(scored.map((report) => report.rubric!.overall)),
      answersBeforeAsking: mean(scored.map((report) => report.rubric!.answersBeforeAsking)),
      oneQuestionAtATime: mean(scored.map((report) => report.rubric!.oneQuestionAtATime)),
      momentum: mean(scored.map((report) => report.rubric!.momentum)),
      objectionHandling: mean(scored.map((report) => report.rubric!.objectionHandling)),
      tone: mean(scored.map((report) => report.rubric!.tone)),
      compliance: mean(scored.map((report) => report.rubric!.compliance)),
    },
    setterCost: Math.round(reports.reduce((sum, report) => sum + report.setterCost, 0) * 10_000) / 10_000,
    errors: reports.filter((report) => report.error).length,
  };
  process.stdout.write(`\n${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const { tagSecret, apiKey } = requireEnvironment();
  const tenant = await resolveDemoCoachTenant();
  if (!tenant) throw new Error("SETTER_EVAL_DEMO_TENANT_MISSING");
  const [bundle, content, modelConfigs] = await Promise.all([
    loadPublishedRuntimeBundle(tenant.id),
    loadApprovedPlatformAgentContent(tenant.id),
    loadModelConfigs(args.generator),
  ]);
  const drivers = await selectDrivers(modelConfigs);
  const generator = activeModelConfigurations(modelConfigs).find((row) => row.role === "generator");
  const moderator = activeModelConfigurations(modelConfigs).find((row) => row.role === "moderator");
  const realDriver = createRealModelDriver(apiKey);
  const harness: Harness = {
    bundle,
    content,
    modelConfigs,
    drivers,
    lead: realDriver,
    judge: realDriver,
    tagSecret,
    linkWhitelist: publishedLinkWhitelist(bundle),
    maxTurns: args.maxTurns,
  };
  const selected = PERSONAS.filter((persona) => args.only === null || persona.key.includes(args.only));
  process.stderr.write(
    `tenant ${tenant.slug}, snapshot v${bundle.brainVersion} (${bundle.brain.knowledgeMode}), offer v${bundle.offerVersion} ` +
    `(${bundle.offer.bookingMode} booking, rules: ${bundle.renderSources.qualificationSummary}), ` +
    `generator ${generator?.model ?? "?"} ${JSON.stringify(generator?.params ?? {})}, moderator ${moderator?.model ?? "?"}, ` +
    `lead ${LEAD_MODEL.model}, judge ${JUDGE_MODEL.model}, ${selected.length} personas, max ${args.maxTurns} turns\n`,
  );
  const reports = await Promise.all(selected.map((persona) => runConversation(harness, persona)));
  const summary = printReport(reports, generator?.model ?? "?");
  if (args.json) {
    writeFileSync(args.json, JSON.stringify({ generator: generator?.model ?? null, moderator: moderator?.model ?? null, lead: LEAD_MODEL.model, judge: JUDGE_MODEL.model, summary, reports }, null, 2));
    process.stderr.write(`wrote ${args.json}\n`);
  }
  process.exitCode = summary.errors > 0 ? 1 : 0;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
