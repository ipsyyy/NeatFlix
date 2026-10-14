import type { CheckOutcome, GuardrailId, SceneDecision } from "./types";

/** Seconds to "mm:ss", e.g. 42 → "00:42". */
export function formatTimecode(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export const guardrailLabel: Record<GuardrailId, string> = {
  tone: "Emotional tone",
  "camera-motion": "Camera and motion",
  "placement-surface": "Placement surface",
  "face-framing": "Face framing",
  "actor-restrictions": "Actor restrictions",
};

export const outcomeLabel: Record<CheckOutcome, string> = {
  pass: "Pass",
  caution: "Caution",
  fail: "Fail",
  "not-assessed": "Not assessed",
};

export const decisionLabel: Record<SceneDecision, string> = {
  recommended: "Recommended",
  acceptable: "Acceptable",
  rejected: "Rejected",
};
