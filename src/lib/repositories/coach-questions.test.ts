import { describe, expect, it, vi } from "vitest";

import {
  readCoachQuestions,
  reorderCoachQuestions,
  setCoachQuestionEnabled,
  type CoachQuestionActor,
} from "./coach-questions";

const actor: CoachQuestionActor = {
  userId: "72000000-0000-4000-8000-000000000004",
  tenantId: "71000000-0000-4000-8000-000000000004",
};

function fixture() {
  return {
    tenantId: actor.tenantId,
    questions: [
      { id: "question-goal", text: "What is your funding goal?", tag: "Funding Qs", enabled: true, position: 0 },
      { id: "question-credit", text: "What is your credit score?", tag: "Credit", enabled: false, position: 1 },
    ],
  };
}

describe("coach question repository", () => {
  it("maps the merged fixture rows into the ordered series returned to the coach", async () => {
    const source = vi.fn(async () => fixture());
    await expect(readCoachQuestions(actor, source)).resolves.toEqual([
      { id: "question-goal", text: "What is your funding goal?", tag: "Funding Qs", enabled: true, position: 0 },
      { id: "question-credit", text: "What is your credit score?", tag: "Credit", enabled: false, position: 1 },
    ]);
    expect(source).toHaveBeenCalledWith(actor.userId, actor.tenantId);
  });

  it("refuses a cross-tenant or non-series response before it reaches a client surface", async () => {
    await expect(readCoachQuestions(actor, async () => ({ ...fixture(), tenantId: "another-tenant" })))
      .rejects.toThrow("COACH_QUESTION_SCOPE_MISMATCH");
    await expect(readCoachQuestions(actor, async () => ({
      ...fixture(), questions: [...fixture().questions].reverse(),
    }))).rejects.toThrow("COACH_QUESTION_SNAPSHOT_INVALID");
  });

  it("uses the two audited writes and proves their merged read-back", async () => {
    const reorder = vi.fn(async () => [{ audit_id: 81 }]);
    const toggle = vi.fn(async () => [{ audit_id: 82 }]);
    const read = vi.fn(async () => fixture());
    const dependencies = { read, write: { reorder, toggle } };

    await expect(reorderCoachQuestions(actor, ["question-goal", "question-credit"], dependencies))
      .resolves.toMatchObject({ auditId: "81", questions: fixture().questions });
    await expect(setCoachQuestionEnabled(actor, "question-credit", false, dependencies))
      .resolves.toMatchObject({ auditId: "82", questions: fixture().questions });
    expect(reorder).toHaveBeenCalledWith(actor.userId, actor.tenantId, ["question-goal", "question-credit"]);
    expect(toggle).toHaveBeenCalledWith(actor.userId, actor.tenantId, "question-credit", false);
  });
});
