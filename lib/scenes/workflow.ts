import type { SceneCandidate } from "./types";

/**
 * A scene moves on to campaign matching only when it is selectable and every
 * guardrail passes. Cautions and unassessed checks must be resolved first.
 */
export function canProceedToCampaignMatching(scene: SceneCandidate): boolean {
  return scene.decision !== "rejected" && scene.checks.every((c) => c.outcome === "pass");
}

export function campaignWorkspacePath(titleId: string, sceneId: string): string {
  return `/titles/${titleId}/scenes/${sceneId}/campaign`;
}
