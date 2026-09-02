import { describe, expect, it } from "vitest";

import {
  evaluateStageChange,
  PIPELINE_STAGES,
  type PipelineStage,
  type StageChangeRequest,
  type StageSetter,
} from "@/lib/pipeline/transitions";

const BOOKED_EVIDENCE = {
  appointmentId: "appointment-booked",
  startAt: "2026-08-23T10:00:00.000Z",
  status: "scheduled",
};

const NO_SHOW_EVIDENCE = {
  appointmentId: "appointment-no-show",
  startAt: "2026-08-22T10:00:00.000Z",
  status: "no_show",
};

function validEvidenceFor(to: PipelineStage): StageChangeRequest["appointmentEvidence"] {
  if (to === "booked") return BOOKED_EVIDENCE;
  if (to === "no_show") return NO_SHOW_EVIDENCE;
  return null;
}

const STAGE_PAIR_CASES = (["system", "user"] as const).flatMap((setBy) =>
  PIPELINE_STAGES.flatMap((from) =>
    PIPELINE_STAGES.map((to) => ({ setBy, from, to })),
  ),
);

describe("evaluateStageChange", () => {
  it.each(STAGE_PAIR_CASES)(
    "covers $setBy transition from $from to $to",
    ({ setBy, from, to }) => {
      const verdict = evaluateStageChange({
        from,
        to,
        setBy,
        currentSetBy: "system",
        appointmentEvidence: validEvidenceFor(to),
      });

      expect(verdict).toEqual(
        from === to
          ? { allowed: false, code: "PIPELINE_SAME_STAGE" }
          : { allowed: true },
      );
    },
  );

  it("protects a user-set long-term follow-up from system qualifying", () => {
    expect(
      evaluateStageChange({
        from: "long_term_followup",
        to: "qualifying",
        setBy: "system",
        currentSetBy: "user",
        appointmentEvidence: null,
      }),
    ).toEqual({ allowed: false, code: "PIPELINE_USER_STAGE_PROTECTED" });
  });

  it("lets system booking evidence overwrite a user-set no-show", () => {
    expect(
      evaluateStageChange({
        from: "no_show",
        to: "booked",
        setBy: "system",
        currentSetBy: "user",
        appointmentEvidence: BOOKED_EVIDENCE,
      }),
    ).toEqual({ allowed: true });
  });

  it("refuses a user booking without appointment evidence", () => {
    expect(
      evaluateStageChange({
        from: "qualifying",
        to: "booked",
        setBy: "user",
        currentSetBy: "system",
        appointmentEvidence: null,
      }),
    ).toEqual({
      allowed: false,
      code: "PIPELINE_BOOKED_REQUIRES_APPOINTMENT",
    });
  });

  it("allows a user to book a qualified no-buy when evidence exists", () => {
    expect(
      evaluateStageChange({
        from: "qualified_no_buy",
        to: "booked",
        setBy: "user",
        currentSetBy: "user",
        appointmentEvidence: BOOKED_EVIDENCE,
      }),
    ).toEqual({ allowed: true });
  });

  it.each(
    (["system", "user"] as const).flatMap((setBy) => [
      { setBy, appointmentEvidence: null },
      { setBy, appointmentEvidence: BOOKED_EVIDENCE },
    ]),
  )(
    "refuses a $setBy no-show without matching latest appointment evidence",
    ({ setBy, appointmentEvidence }) => {
      expect(
        evaluateStageChange({
          from: "qualifying",
          to: "no_show",
          setBy,
          currentSetBy: "system",
          appointmentEvidence,
        }),
      ).toEqual({
        allowed: false,
        code: "PIPELINE_NO_SHOW_REQUIRES_LATEST_APPOINTMENT",
      });
    },
  );

  it("mirrors the RPC by applying user-stage protection before appointment validation", () => {
    expect(
      evaluateStageChange({
        from: "qualifying",
        to: "no_show",
        setBy: "system",
        currentSetBy: "user",
        appointmentEvidence: null,
      }),
    ).toEqual({ allowed: false, code: "PIPELINE_USER_STAGE_PROTECTED" });
  });

  it("uses the existing setter vocabulary", () => {
    const setters = ["system", "user"] satisfies StageSetter[];

    expect(setters).toEqual(["system", "user"]);
  });
});
