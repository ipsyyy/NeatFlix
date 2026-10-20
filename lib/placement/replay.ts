import { HERO_PREVIEW_VIDEOS } from "@/lib/catalogue/hero-preview";

/**
 * A recorded placement case, replayed for the demo. Every step is the outcome
 * the five BAND agents recorded for the case; nothing is generated and no
 * provider is called. The approved video is the public, byte-identical copy of
 * the registered, human-reviewed Runway V4 full-scene video.
 */

export const REPLAY_DISCLOSURE = "Recorded pipeline replay — no provider is called during this demo.";

/** Delay before the first step, then the time each step takes: about 4.8 s in all. */
export const REPLAY_START_MS = 300;
export const REPLAY_STEP_MS = 900;

export type ReplayStep = { role: string; agent: string; outcome: string };

export type RecordedReplay = {
  caseId: string;
  titleId: string;
  sceneId: string;
  product: string;
  steps: readonly ReplayStep[];
  video: { src: string; generator: string; decision: "approved-with-limitation"; limitation: string };
  /** The human-approval step of the full case walkthrough. */
  approvalEvidenceHref: string;
  caseHref: string;
};

export const RECORDED_REPLAYS: readonly RecordedReplay[] = Object.freeze([
  {
    caseId: "NF-DEMO-0001",
    titleId: "luv-hypothesis",
    sceneId: "luv-scene-1",
    product: "Daybreak Cold Brew",
    steps: [
      { role: "content-curator", agent: "Content Curator", outcome: "Eligibility approved" },
      { role: "scene-scout", agent: "Scene Scout", outcome: "Café scene selected" },
      { role: "campaign-matcher", agent: "Campaign Matcher", outcome: "Daybreak Cold Brew recommended" },
      { role: "placement-director", agent: "Placement Director", outcome: "Rebrand the two existing cups" },
      { role: "release-governor", agent: "Release Governor", outcome: "Checks passed; sent for human review" },
    ],
    video: {
      src: HERO_PREVIEW_VIDEOS["luv-hypothesis"],
      generator: "Runway Aleph",
      decision: "approved-with-limitation",
      // Verbatim from the recorded human visual review of the V4 video.
      limitation: "Fine generated cup lettering shows minor temporal instability during motion.",
    },
    approvalEvidenceHref: "/demo#step-human",
    caseHref: "/demo",
  },
]);

export function recordedReplayFor(titleId: string, sceneId: string): RecordedReplay | undefined {
  return RECORDED_REPLAYS.find((r) => r.titleId === titleId && r.sceneId === sceneId);
}

export function placementPreviewPath(titleId: string, sceneId: string): string {
  return `/titles/${titleId}/scenes/${sceneId}/preview`;
}

export const replayDurationMs = (r: RecordedReplay) => REPLAY_START_MS + r.steps.length * REPLAY_STEP_MS;
