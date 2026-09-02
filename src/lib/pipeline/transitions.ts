import { COACH_PIPELINE_STAGES } from "@/components/workspace/live/measurement-view-models";

export const PIPELINE_STAGES = COACH_PIPELINE_STAGES.map((stage) => stage.key);

export type PipelineStage = (typeof COACH_PIPELINE_STAGES)[number]["key"];
export type StageSetter = "system" | "user";

export type StageChangeRequest = {
  from: PipelineStage;
  to: PipelineStage;
  setBy: StageSetter;
  currentSetBy: StageSetter;
  appointmentEvidence: {
    appointmentId: string;
    startAt: string;
    status: string;
  } | null;
};

export type StageChangeVerdict =
  | { allowed: true }
  | {
      allowed: false;
      code:
        | "PIPELINE_USER_STAGE_PROTECTED"
        | "PIPELINE_BOOKED_REQUIRES_APPOINTMENT"
        | "PIPELINE_NO_SHOW_REQUIRES_LATEST_APPOINTMENT"
        | "PIPELINE_SAME_STAGE";
    };

export function evaluateStageChange(req: StageChangeRequest): StageChangeVerdict {
  if (req.from === req.to) {
    return { allowed: false, code: "PIPELINE_SAME_STAGE" };
  }

  if (req.setBy === "system" && req.currentSetBy === "user" && req.to !== "booked") {
    return { allowed: false, code: "PIPELINE_USER_STAGE_PROTECTED" };
  }

  if (
    req.to === "no_show" &&
    (!req.appointmentEvidence || req.appointmentEvidence.status !== "no_show")
  ) {
    return {
      allowed: false,
      code: "PIPELINE_NO_SHOW_REQUIRES_LATEST_APPOINTMENT",
    };
  }

  if (req.to === "booked" && !req.appointmentEvidence) {
    return {
      allowed: false,
      code: "PIPELINE_BOOKED_REQUIRES_APPOINTMENT",
    };
  }

  return { allowed: true };
}
