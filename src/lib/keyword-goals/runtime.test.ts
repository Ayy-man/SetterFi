import { describe, expect, it } from "vitest";

import type { EngineTurnResult } from "@/lib/engine/types";
import { applyPinnedKeywordGoal, type PinnedKeywordGoal } from "./runtime";

function result(options: { booked?: boolean } = {}): EngineTurnResult {
  const body = options.booked ? "Your call is booked." : "What is your funding goal?";
  return {
    response: { reply: body, state: "agent", booking: null },
    commands: [
      { kind: "persist_agent_turn", body, disclosureConsumed: false },
      { kind: "send", body, approvedInput: false },
      ...(options.booked
        ? [{ kind: "record_booking_intent" as const, booking: {
            id: "appointment-1", startAt: "2026-09-02T12:00:00.000Z", timezone: "UTC",
          } }]
        : []),
    ],
    trace: {} as EngineTurnResult["trace"],
  };
}

const resource: PinnedKeywordGoal = {
  id: "goal-1",
  goal: "resource",
  resourceUrl: "https://example.com/guide",
  resourceMessage: "Here is the guide you asked for.",
  postBookingUrl: "https://example.com/thanks",
  postBookingMessage: "Please read this before we meet.",
};

describe("pinned keyword goal runtime", () => {
  it("places the resource and link before the first qualification question in one send", () => {
    const applied = applyPinnedKeywordGoal({ result: result(), goal: resource, firstQualificationTurn: true });
    const expected = "Here is the guide you asked for.\n\nhttps://example.com/guide\n\nWhat is your funding goal?";
    expect(applied.response.reply).toBe(expected);
    expect(applied.commands.filter((command) => command.kind === "send")).toEqual([
      expect.objectContaining({ body: expected }),
    ]);
    expect(applied.commands.filter((command) => command.kind === "persist_agent_turn")).toEqual([
      expect.objectContaining({ body: expected }),
    ]);
  });

  it("keeps the required automated-experience disclosure at the start", () => {
    const base = result();
    const disclosedBody = `I am an automated assistant.\n\n${base.response.reply}`;
    const disclosed: EngineTurnResult = {
      ...base,
      response: { ...base.response, reply: disclosedBody },
      commands: base.commands.map((command) => command.kind === "send"
        ? { ...command, body: disclosedBody }
        : command.kind === "persist_agent_turn"
          ? { ...command, body: disclosedBody, disclosureConsumed: true }
          : command),
    };
    const applied = applyPinnedKeywordGoal({
      result: disclosed, goal: resource, firstQualificationTurn: true,
    });
    expect(applied.response.reply).toBe(
      "I am an automated assistant.\n\nHere is the guide you asked for.\n\n" +
      "https://example.com/guide\n\nWhat is your funding goal?",
    );
    expect(applied.response.reply.startsWith("I am an automated assistant.")).toBe(true);
  });

  it("leaves book mode and later resource turns unchanged", () => {
    const book = { ...resource, goal: "book" as const, resourceUrl: null, resourceMessage: null };
    const bookTurn = result();
    expect(applyPinnedKeywordGoal({ result: bookTurn, goal: book, firstQualificationTurn: true }))
      .toBe(bookTurn);
    const later = result();
    expect(applyPinnedKeywordGoal({ result: later, goal: resource, firstQualificationTurn: false }))
      .toBe(later);
  });

  it("appends the configured post-booking copy to the one durable confirmation", () => {
    const applied = applyPinnedKeywordGoal({
      result: result({ booked: true }), goal: resource, firstQualificationTurn: false,
    });
    const expected = "Your call is booked.\n\nPlease read this before we meet.\n\nhttps://example.com/thanks";
    expect(applied.response.reply).toBe(expected);
    expect(applied.commands.filter((command) => command.kind === "send")).toHaveLength(1);
    expect(applied.commands.filter((command) => command.kind === "record_booking_intent")).toHaveLength(1);
  });

  it("rejects non-HTTPS published links instead of emitting them", () => {
    expect(() => applyPinnedKeywordGoal({
      result: result(), goal: { ...resource, resourceUrl: "http://example.com/guide" },
      firstQualificationTurn: true,
    })).toThrow("KEYWORD_GOAL_RESOURCE_URL_INVALID");
  });
});
