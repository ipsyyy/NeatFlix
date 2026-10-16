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

/** v3 of the LUV placement: rebrand the two existing cups instead of inserting a cup (placement-strategy.ts). */
export const LUV_PLAN_V3 = Object.freeze({
  fromPlanId: "plan:daybreak-cold-brew:luv-scene-1:v2",
  planId: "plan:daybreak-cold-brew:luv-scene-1:v3",
  rejectedAssetIds: Object.freeze(["asset:luv-hypothesis:edited-still:luv-scene-1:v1", "asset:luv-hypothesis:edited-still:luv-scene-1:v2"]),
  stillPrompt:
    "This is a surface-branding edit of the two takeaway cups already on the café table, not an object insertion. " +
    "Replace only the printed branding on the exterior of both existing cup bodies with the same coherent Daybreak Cold Brew branding, aligned with each cup's existing perspective and curvature. " +
    "The image must contain exactly two cups, the same two cups as in the input image: the man's cup at centre-left and the woman's cup at centre-right. " +
    "Do not add a third cup or any other object. " +
    "Keep both cups exactly where they are, with the same size, shape, perspective, and lids, and keep the woman's straw exactly as it is. " +
    "Do not change either actor in any way: faces, mouths, expressions, identities, hair, glasses, hand positions, arms, and clothing stay exactly as in the input image. " +
    "Keep the pastry, plate, table, chairs, background, lighting, framing, and composition unchanged, preserving every other pixel as closely as possible. " +
    "No hand interaction. Apart from the Daybreak Cold Brew branding on the two cups, introduce no text, captions, watermarks, or logos.",
  motionPrompt:
    "Keep the scene as it is across the 3-second window (00:07–00:10): both rebranded cups stay stationary exactly where they are, with no hand interaction. " +
    "Preserve all existing actor motion, faces, expressions, and hand gestures exactly. No camera movement and no added text or logos.",
  placementDescription:
    "Nothing is added. The two existing takeaway cups on the café table, the man's cup at centre-left and the woman's cup with her straw at centre-right, keep their exact bodies, sizes, positions, perspective, and lids; only the printed branding on each cup's exterior becomes Daybreak Cold Brew.",
  assumption:
    "Human-directed revision of plan:daybreak-cold-brew:luv-scene-1:v2 after human contextual review: the selected scene already holds exactly two takeaway cups for two people, so adding a third cup is contextually wrong. v3 rebrands both existing cups instead. Edited stills v1 and v2 were rejected in human visual review (v2 also because the man's mouth and expression changed).",
});

/** Builds plan v3 (rebrand the two existing cups) from the persisted v2. The plan's scene, product, source frame, and evidence carry over. */
export function buildLuvRebrandPlanV3(from: PlacementPlan): PlacementPlan {
  if (from.planId !== LUV_PLAN_V3.fromPlanId) throw new Error("The v3 revision applies only to plan v2.");
  const plan = structuredClone(from);
  plan.planId = LUV_PLAN_V3.planId;
  plan.placement = { region: "visible café table", motion: "stationary", handInteraction: "none", mode: "rebrand-existing-cups", description: LUV_PLAN_V3.placementDescription };
  plan.rebrand = {
    cupsBefore: 2,
    cupsAfter: 2,
    addedObjects: 0,
    cups: [
      { id: "man-cup", branded: true, position: "unchanged", size: "unchanged", shape: "unchanged", lid: "unchanged", straw: "none" },
      { id: "woman-cup", branded: true, position: "unchanged", size: "unchanged", shape: "unchanged", lid: "unchanged", straw: "unchanged" },
    ],
  };
  plan.guidance = {
    scale: "Keep each cup's exact size; the branding follows each cup's existing dimensions.",
    perspective: "Wrap each label around its cup following that cup's existing perspective and curvature.",
    lighting: "Match the warm ambient café light already falling on each cup.",
    shadow: "Keep the existing shadows of both cups unchanged.",
    colorMatch: "Grade the Daybreak Cold Brew branding to the warm café palette so both labels read as printed on the cups.",
  };
  plan.preservation = {
    faces: ["Keep both actors' faces, mouths, expressions, identities, hair, and glasses exactly unchanged."],
    bodies: ["Keep both actors' hands, arms, poses, and clothing exactly unchanged."],
    background: ["Keep the pastry, plate, table, chairs, background, and lighting unchanged."],
    composition: ["Keep the framing and composition unchanged; both cups keep their positions, sizes, shapes, and lids, and the woman's straw stays as it is."],
  };
  plan.brandLegibility = [
    "Both cups carry the same Daybreak Cold Brew identity, readable at medium-wide framing and aligned with each cup's perspective.",
    "No text, captions, logos, or watermarks other than the Daybreak Cold Brew branding on the two cups.",
  ];
  plan.negativeConstraints = [
    "No hand interaction: no hand changes position or touches anything new.",
    "No face obstruction or alteration: faces, mouths, and expressions stay unchanged.",
    "No added text, captions, watermarks, or extra logos beyond the Daybreak Cold Brew cup branding.",
    "No third cup, no additional cups, and no other objects.",
    "Do not move, resize, reshape, remove, or duplicate either cup, and do not change either lid.",
    "Do not move, remove, or change the woman's straw.",
    "No camera movement; framing and composition unchanged.",
  ];
  plan.prompts.stillImageEdit.prompt = LUV_PLAN_V3.stillPrompt;
  plan.prompts.motion.prompt = LUV_PLAN_V3.motionPrompt;
  plan.assumptions = [...plan.assumptions, LUV_PLAN_V3.assumption];
  return plan;
}
