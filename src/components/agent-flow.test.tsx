import { describe, expect, it } from "vitest";

import { agentFlowSnapshot } from "@/components/agent-flow";

const BASE = {
  sessionId: "session-1",
  current: "greeting" as const,
  done: [],
  thinking: false,
  brainUsed: false,
  guardrail: null,
  booked: null,
  decisionLabel: "In progress",
};

/** The follow-up node reads the published offer, so switching touches off shows on the map. */
describe("the follow-up node", () => {
  const node = (followUps: { sending: number; total: number } | null) =>
    agentFlowSnapshot({ ...BASE, followUps }).find((entry) => entry.id === "followup")!;

  it("names the count that still sends, and says so when it is switched off", () => {
    expect(node({ sending: 7, total: 7 }).sublabel).toBe("7 touches");
    expect(node({ sending: 3, total: 7 }).sublabel).toBe("3 of 7 touches");
    expect(node({ sending: 0, total: 7 }).sublabel).toBe("switched off");
    expect(node(null).sublabel).toBe("on our schedule");
  });

  it("is never walked by a turn", () => {
    expect(agentFlowSnapshot({ ...BASE, current: "book", done: ["greeting", "qualify"] })
      .find((entry) => entry.id === "followup")?.status).toBe("idle");
  });
});
