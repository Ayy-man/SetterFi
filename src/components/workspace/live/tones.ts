import type { StateTone } from "@/lib/copy/states";

export type WorkspaceTone = "neutral" | "good" | "pending" | "bad";

export function toneToStateTone(tone: WorkspaceTone): StateTone {
  if (tone === "pending") return "warning";
  if (tone === "bad") return "critical";
  return tone;
}
