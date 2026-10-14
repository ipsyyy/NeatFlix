/** Placement workflow stages, in order (PRODUCT_SOURCE_OF_TRUTH.md §6). */
export const WORKFLOW_STAGES = [
  "Catalogue review",
  "Scene selection",
  "Campaign matching",
  "Placement preview",
  "Evaluation and approval",
  "Experiment",
] as const;

export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];
