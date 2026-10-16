/**
 * Scene-candidate model for the scene workspace (PRODUCT_SOURCE_OF_TRUTH.md §4.2, §9).
 * Every decision carries its evidence; there are no bare scores.
 */

/** "not-assessed" states uncertainty instead of inventing a result (§7.1 Honest). */
export type CheckOutcome = "pass" | "caution" | "fail" | "not-assessed";

/** The guardrails a scene is checked against before it can be selected. */
export type GuardrailId =
  | "tone"
  | "camera-motion"
  | "placement-surface"
  | "face-framing"
  | "actor-restrictions";

export type GuardrailCheck = {
  id: GuardrailId;
  outcome: CheckOutcome;
  /** What was observed in the scene, in plain language. */
  evidence: string;
};

export type SceneDecision = "recommended" | "acceptable" | "rejected";

/** Everyday objects a scene could hold naturally; campaigns match against these. */
export type PlacementObject = "Coffee cup" | "Phone" | "Laptop" | "Beverage" | "Food bag";

export type SceneCandidate = {
  id: string;
  name: string;
  startSeconds: number;
  endSeconds: number;
  decision: SceneDecision;
  /** Ranking among selectable scenes (1 = best); null when rejected. */
  rank: number | null;
  /** One-sentence rationale for the decision. */
  rationale: string;
  tone: string;
  camera: string;
  surface: string;
  /** Objects that could sit naturally in the scene. Empty when none. */
  opportunities: PlacementObject[];
  checks: GuardrailCheck[];
  /** Representative source-frame time for the recommended scene, inside its window. Not yet extracted. */
  representativeFrameSeconds?: number;
};

export type SceneReview = {
  titleId: string;
  /** Shared case ID that later workflow steps will carry forward (§5). */
  caseId: string;
  /** Where these records came from. Fixtures must be labelled in the UI. */
  source: "demo-fixture";
  scenes: SceneCandidate[];
};
