import type { PlacementPlan } from "@/agents/handoff/placement-plan";
import { PLACEMENT_REGION, PROMPT_NOT_EXECUTED_LABEL, STAND_IN_DISCLOSURE } from "@/agents/handoff/placement-plan";
import { SOURCE_FRAME_DISCLOSURE } from "@/agents/handoff/source-frames";

/**
 * Live-harness checks for a Placement Director plan bound to the registered
 * LUV source frame. Pure functions over the posted plan, its readable text,
 * and the persisted registry record, so they are unit-tested
 * (agents/tests/placement-frame-checks.test.ts).
 */

/** The registered frame the LUV placement must bind (checksum comes from the registry at run time). */
export const LUV_FRAME = Object.freeze({
  caseId: "NF-DEMO-0001",
  titleId: "luv-hypothesis",
  sceneId: "luv-scene-1",
  startSeconds: 7,
  endSeconds: 10,
  timestampSeconds: 8,
  assetId: "asset:luv-hypothesis:source-frame:luv-scene-1:v1",
  storageRef: "storage://nf-media/frames/luv-hypothesis/luv-scene-1-8s.png",
  sourceAssetId: "asset:luv-hypothesis:source-video:v1",
});

export type FrameCheck = [name: string, ok: boolean];

/** The checks that replace the harness's stand-in assertions. `registryChecksum` is read from the persisted frame record. */
export function frameChecks(plan: PlacementPlan | undefined, readable: string, registryChecksum: string | null): FrameCheck[] {
  const media = plan?.sourceMedia;
  const frame = media?.kind === "registered-source-frame" ? media : null;
  const placementText = plan
    ? [plan.placement.description, ...plan.negativeConstraints, ...Object.values(plan.preservation).flat(), plan.prompts.stillImageEdit.prompt].join("\n")
    : "";
  return [
    [
      `Plan binds the registered source frame ${LUV_FRAME.assetId} (${LUV_FRAME.storageRef}, registry checksum, ${LUV_FRAME.timestampSeconds} s, source ${LUV_FRAME.sourceAssetId})`,
      Boolean(
        frame &&
          registryChecksum &&
          frame.isSceneFrame === true &&
          frame.assetId === LUV_FRAME.assetId &&
          frame.storageRef === LUV_FRAME.storageRef &&
          frame.checksum === registryChecksum &&
          frame.timestampSeconds === LUV_FRAME.timestampSeconds &&
          frame.sourceAssetId === LUV_FRAME.sourceAssetId &&
          frame.note === SOURCE_FRAME_DISCLOSURE,
      ),
    ],
    [
      `Plan: ${LUV_FRAME.caseId} ${LUV_FRAME.titleId} ${LUV_FRAME.sceneId} 00:07–00:10; clear front-right café-table region, avoiding both actors, their hands, both existing cups and the pastry`,
      Boolean(
        plan &&
          plan.caseId === LUV_FRAME.caseId &&
          plan.sourceArtifacts.titleId === LUV_FRAME.titleId &&
          plan.scene.sceneId === LUV_FRAME.sceneId &&
          plan.scene.startSeconds === LUV_FRAME.startSeconds &&
          plan.scene.endSeconds === LUV_FRAME.endSeconds &&
          plan.placement.region.toLowerCase() === PLACEMENT_REGION &&
          /front[- ]right/i.test(plan.placement.description) &&
          /\bcups?\b/i.test(placementText) &&
          /pastry/i.test(placementText) &&
          /\bhands?\b/i.test(placementText) &&
          /\b(actors?|faces?)\b/i.test(placementText),
      ),
    ],
    [
      "Both prompts labelled not-executed; readable states the registered-frame sentence (no edit or generation run) and that the prompts have not been executed; no stand-in sentence",
      Boolean(
        plan &&
          plan.prompts.stillImageEdit.status === "not-executed" &&
          plan.prompts.motion.status === "not-executed" &&
          plan.prompts.stillImageEdit.label === PROMPT_NOT_EXECUTED_LABEL &&
          plan.prompts.motion.label === PROMPT_NOT_EXECUTED_LABEL &&
          readable.includes(SOURCE_FRAME_DISCLOSURE) &&
          /not (yet )?(been )?executed/i.test(readable) &&
          !readable.includes(STAND_IN_DISCLOSURE),
      ),
    ],
  ];
}
