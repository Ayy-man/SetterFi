import type { EngineCommand, EngineTurnResult } from "@/lib/engine/types";

export type PinnedKeywordGoal = {
  id: string;
  goal: "resource" | "book";
  resourceUrl: string | null;
  resourceMessage: string | null;
  postBookingUrl: string | null;
  postBookingMessage: string | null;
};

function https(value: string | null, code: string) {
  if (value === null) return null;
  const normalized = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(code);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error(code);
  return normalized;
}

function optional(value: string | null) {
  return value?.trim() || null;
}

function replaceOutbound(result: EngineTurnResult, body: string): EngineTurnResult {
  let sendCount = 0;
  let persistCount = 0;
  const commands = result.commands.map((command): EngineCommand => {
    if (command.kind === "send") {
      sendCount += 1;
      return { ...command, body };
    }
    if (command.kind === "persist_agent_turn") {
      persistCount += 1;
      return { ...command, body };
    }
    return command;
  });
  if (sendCount !== 1 || persistCount !== 1) {
    throw new Error("KEYWORD_GOAL_OUTBOUND_COMMAND_INVALID");
  }
  return { ...result, response: { ...result.response, reply: body }, commands };
}

function joined(parts: readonly (string | null)[]) {
  return parts.filter((part): part is string => Boolean(part)).join("\n\n");
}

/** Applies a conversation-pinned goal to the already approved single outbound turn. */
export function applyPinnedKeywordGoal(input: {
  result: EngineTurnResult;
  goal: PinnedKeywordGoal | null;
  firstQualificationTurn: boolean;
}): EngineTurnResult {
  if (!input.goal) return input.result;
  const goal = input.goal;
  let body = input.result.response.reply.trim();
  if (!body) throw new Error("KEYWORD_GOAL_BASE_REPLY_REQUIRED");

  if (input.firstQualificationTurn && goal.goal === "resource") {
    const resourceUrl = https(goal.resourceUrl, "KEYWORD_GOAL_RESOURCE_URL_INVALID");
    if (!resourceUrl) throw new Error("KEYWORD_GOAL_RESOURCE_URL_REQUIRED");
    const persisted = input.result.commands.find((command) => command.kind === "persist_agent_turn");
    if (persisted?.kind === "persist_agent_turn" && persisted.disclosureConsumed) {
      const boundary = body.indexOf("\n\n");
      if (boundary < 1 || boundary + 2 >= body.length) {
        throw new Error("KEYWORD_GOAL_DISCLOSURE_BOUNDARY_INVALID");
      }
      const disclosure = body.slice(0, boundary);
      const qualificationQuestion = body.slice(boundary + 2);
      body = joined([
        disclosure,
        optional(goal.resourceMessage),
        resourceUrl,
        qualificationQuestion,
      ]);
    } else {
      body = joined([optional(goal.resourceMessage), resourceUrl, body]);
    }
  }

  const booked = input.result.commands.some((command) => command.kind === "record_booking_intent");
  if (booked) {
    const postBookingUrl = https(goal.postBookingUrl, "KEYWORD_GOAL_POST_BOOKING_URL_INVALID");
    body = joined([body, optional(goal.postBookingMessage), postBookingUrl]);
  }

  return body === input.result.response.reply ? input.result : replaceOutbound(input.result, body);
}
