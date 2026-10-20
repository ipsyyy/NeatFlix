import { FULL_SCENE_LABEL, type DemoMediaKey } from "@/lib/demo/snapshot";
import { getEligibility } from "./eligibility";
import type { CatalogueTitle } from "./types";

/**
 * Playable title media for the catalogue: each title's unedited source clip
 * under public/demo-videos/, and, for the title with a recorded placement case,
 * the approved Runway result served only through the checksum-verified demo
 * media route. Every label here is derived from catalogue or case records.
 */

/** Source clips by existing catalogue ID. Files live in public/demo-videos/. */
export const TITLE_SOURCE_VIDEOS: Readonly<Record<string, string>> = Object.freeze({
  "luv-hypothesis": "luv-hypothesis-original.mp4",
  "money-hoist": "money-hoist-original.mp4",
  "not-suitable-for-professionals": "not-suitable-for-professionals-original.mp4",
});

export const SOURCE_VIDEO_DIR = "demo-videos";

export const sourceVideoSrc = (file: string) => `/${SOURCE_VIDEO_DIR}/${file}`;

export const hasSourceVideo = (titleId: string) => Object.hasOwn(TITLE_SOURCE_VIDEOS, titleId);

/** The source clip of the recorded case is the registered source video asset. */
export const ORIGINAL_REGISTERED_SCENE_LABEL = "Original registered scene";
/** Any other title's clip: unedited, and not a registered pipeline asset. */
export const ORIGINAL_SOURCE_SCENE_LABEL = "Original source scene";
export const APPROVED_RESULT_HEADING = "Approved placement result";
/** The complete case and pipeline walkthrough. */
export const CASE_DEMO_PATH = "/demo";

/** The registered Runway V4 video's key; its bytes are re-checked on every request. */
export const PLACEMENT_RESULT_MEDIA_KEY: DemoMediaKey = "full-scene-v4";
export const placementResultSrc = `/demo/media/${PLACEMENT_RESULT_MEDIA_KEY}`;

/** Whether a source clip is a structurally complete MP4 the browser can be given. */
export type SourceVideoCheck = { ok: true; file: string; bytes: number } | { ok: false; file: string; reason: string };

/** The approved full-scene result, present only when its bytes still match the registered checksum. */
export type PlacementResult = {
  label: typeof FULL_SCENE_LABEL;
  decision: string;
  limitations: string[];
  disclosure: string;
};

export type RecordedCase = {
  caseId: string;
  status: string;
  titleId: string;
  sceneName: string;
  product: string;
  result: PlacementResult | null;
};

/** Case evidence comes from the local demo snapshot, which may not exist on every machine. */
export type CaseEvidence = { loaded: true; recordedCase: RecordedCase } | { loaded: false; reason: string };

export type TitleMedia = {
  sourceVideos: Record<string, SourceVideoCheck>;
  cases: CaseEvidence;
};

export type PlacementStage = "screened-out" | "review" | "selected";

export const PLACEMENT_STAGE_LABEL: Record<PlacementStage, string> = {
  "screened-out": "Screened out",
  review: "Needs review or caution",
  selected: "Selected for placement",
};

export type PlacementStatus = {
  stage: PlacementStage;
  /** The title's actual stored status, in a few words. */
  status: string;
  /** What that status means for placement work; never claims an agent decision that is not recorded. */
  detail: string;
};

/** The catalogue's own blocker labels (as on its status badges), in badge order. */
function blockers(title: CatalogueTitle): string[] {
  return [
    title.rightsStatus === "pending-review" ? "Rights in review" : title.rightsStatus === "not-cleared" ? "Rights not cleared" : null,
    title.actorRestriction === "restricted" ? "Actor restricted" : title.actorRestriction === "unknown" ? "Actor check needed" : null,
    title.contentSensitivity.level === "sensitive" ? "Sensitive content" : null,
  ].filter((b): b is string => b !== null);
}

const PROCESSING_STATUS: Record<CatalogueTitle["processingStatus"], string> = {
  "review-ready": "review ready",
  processing: "processing",
  "not-processed": "not processed",
};

/**
 * Where a title stands for placement, from its catalogue record and the
 * recorded case only. Ineligible titles are screened out by the catalogue
 * before any agent runs; an eligible title is "selected" only when a recorded
 * case names it; every other eligible title still needs review.
 */
export function placementStage(title: CatalogueTitle, cases: CaseEvidence): PlacementStatus {
  if (!getEligibility(title).eligible) {
    return {
      stage: "screened-out",
      status: [...blockers(title), "not eligible"].join(" · "),
      detail: "Catalogue screening prevents it from entering the placement pipeline, so no placement case is recorded for it.",
    };
  }
  if (cases.loaded && cases.recordedCase.titleId === title.id) {
    const c = cases.recordedCase;
    return {
      stage: "selected",
      status: `Eligible · selected for case ${c.caseId}`,
      detail: `Selected for the recorded placement case ${c.caseId} (${c.sceneName}, ${c.product}); case status: ${c.status}.`,
    };
  }
  const pipeline = title.pipelineEnabled ? "pipeline enabled" : "pipeline not enabled";
  return {
    stage: "review",
    status: `Eligible · ${PROCESSING_STATUS[title.processingStatus]} · ${pipeline}`,
    detail: cases.loaded
      ? "No caution is recorded in the catalogue. No placement case or agent decision is recorded for this title yet."
      : "No caution is recorded in the catalogue. Recorded case evidence is not available on this machine.",
  };
}

/** The label of a title's source clip: only the recorded case's clip is the registered asset. */
export function sourceSceneLabel(titleId: string, cases: CaseEvidence): string {
  return cases.loaded && cases.recordedCase.titleId === titleId ? ORIGINAL_REGISTERED_SCENE_LABEL : ORIGINAL_SOURCE_SCENE_LABEL;
}

/** The approved result to show for a title, only when its own recorded case verified one. */
export function placementResultFor(titleId: string, cases: CaseEvidence): PlacementResult | null {
  return cases.loaded && cases.recordedCase.titleId === titleId ? cases.recordedCase.result : null;
}
