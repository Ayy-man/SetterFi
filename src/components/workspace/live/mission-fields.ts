/**
 * Human names for the mission fields.
 *
 * The Mission tab rendered the persisted column names as its labels -- identity,
 * goal, tone, criteria, guardrails, dq -- in 9.5px monospace over six empty
 * textareas, so the one field whose meaning is least guessable ("dq") was also
 * the one given the least to go on. The keys are what the row is stored under
 * and what the draft payload carries; they are not copy, and they stay exactly
 * as they are underneath.
 *
 * A key with no entry here falls back to itself rather than to an invented
 * label: a field nobody has written copy for should look unfinished, not
 * confidently named.
 */
export type MissionFieldCopy = { title: string; help: string };

export const MISSION_FIELD_COPY: Readonly<Record<string, MissionFieldCopy>> = {
  identity: {
    title: "Agent identity",
    help: "Who the agent says it is when a lead asks: its name, its role, and the coach it works for.",
  },
  goal: {
    title: "Conversation goal",
    help: "What a finished conversation looks like, so every reply has something to work toward.",
  },
  tone: {
    title: "Voice and tone",
    help: "How the agent should sound: pacing, formality, and the phrasing it should stay away from.",
  },
  criteria: {
    title: "Qualification criteria",
    help: "What makes a lead worth booking, written so the agent can check it against what it heard.",
  },
  guardrails: {
    title: "Guardrails",
    help: "What the agent must never say or promise, whatever the lead asks for.",
  },
  dq: {
    title: "Disqualification rules",
    help: "What rules a lead out, and how the agent closes the conversation when it does.",
  },
};

export function missionFieldCopy(key: string): MissionFieldCopy {
  return MISSION_FIELD_COPY[key] ?? { title: key, help: "" };
}
