import type { PlacementPlan } from "@/agents/handoff/placement-plan";

/**
 * Human-directed plan revisions after a visual rejection. A revision is a new,
 * immutable plan version built from the persisted earlier version, changing
 * only the still-edit prompt and placement description. It is validated and
 * persisted through the production adapter like any plan; the earlier version
 * and its media are never changed.
 */
export type PlanRevision = {
  fromPlanId: string;
  planId: string;
  rejectedAssetId: string;
  stillPrompt: string;
  placementDescription: string;
  assumption: string;
};

/** v2 of the LUV placement, after the human visual rejection of edited-still v1. */
export const LUV_PLAN_V2: PlanRevision = Object.freeze({
  fromPlanId: "plan:daybreak-cold-brew:luv-scene-1:v1",
  planId: "plan:daybreak-cold-brew:luv-scene-1:v2",
  rejectedAssetId: "asset:luv-hypothesis:edited-still:luv-scene-1:v1",
  stillPrompt:
    "On the café table in this medium-wide shot, add exactly one Daybreak Cold Brew branded takeaway coffee cup standing upright near the front-right edge of the tabletop, " +
    "farther right and lower in the frame than the woman's existing cup, with clearly visible empty tabletop between the new cup and the woman's forearm and sweater. " +
    "Make the new cup the same apparent height and width as the man's existing takeaway cup. " +
    "The new cup is stationary, with no hand interaction. Nothing may overlap or touch it: not the actors, their arms or clothing, the two existing cups, the straw, the pastry, or the plate. " +
    "Fit its perspective to the slight downward camera angle so its base sits flush on the table, with warm ambient café lighting and a soft contact shadow beneath the base. " +
    "Keep the Daybreak Cold Brew logo legible. " +
    "Keep both actors' faces, expressions, hair, glasses, arms, hand positions, and clothing unchanged and fully visible. " +
    "Keep both existing cups, their lids, the straw, the pastry, the plate, the table, and the background unchanged. " +
    "Keep the framing and composition exactly as in the input image. Add no text, captions, watermarks, or extra logos. Do not cause any reflection.",
  placementDescription:
    "The Daybreak Cold Brew branded takeaway cup stands near the front-right edge of the café table, farther right and lower in the frame than the woman's existing cup, at the same apparent size as the man's cup, with empty tabletop between it and the woman's forearm and sweater, and away from the two existing cups, the pastry plate, and both actors.",
  assumption:
    "Human-directed revision of plan:daybreak-cold-brew:luv-scene-1:v1 after the human visual rejection of asset:luv-hypothesis:edited-still:luv-scene-1:v1: the inserted cup hid part of the woman's left forearm and sweater sleeve, and it was about 20–25% taller than the existing cups.",
});

/** Builds the revised plan from the persisted earlier version. Only the revision's fields change. */
export function buildRevisedPlan(from: PlacementPlan, revision: PlanRevision): PlacementPlan {
  if (from.planId !== revision.fromPlanId) throw new Error("The revision does not apply to this plan.");
  const plan = structuredClone(from);
  plan.planId = revision.planId;
  plan.placement.description = revision.placementDescription;
  plan.prompts.stillImageEdit.prompt = revision.stillPrompt;
  plan.assumptions = [...plan.assumptions, revision.assumption];
  return plan;
}
