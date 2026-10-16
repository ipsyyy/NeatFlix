/**
 * Scene-candidate records — the single editable source for scene analysis.
 *
 * DEMO FIXTURES: these records are hand-authored stand-ins until real scene
 * analysis is connected. The UI labels them as fixtures everywhere they appear.
 */

import { catalogue } from "@/data/catalogue";
import type { SceneReview } from "@/lib/scenes/types";

/**
 * Fails the build if a fixture breaks the review rules:
 * scenes sit inside the title's runtime, a failed guardrail always means
 * rejection (harmlessness is a hard gate, §7.1), and every rejection cites a failure.
 */
function defineSceneReview(review: SceneReview): SceneReview {
  const title = catalogue.find((t) => t.id === review.titleId);
  if (!title) throw new Error(`Scene review references unknown title: ${review.titleId}`);

  for (const s of review.scenes) {
    if (s.startSeconds < 0 || s.endSeconds <= s.startSeconds || s.endSeconds > title.durationSeconds) {
      throw new Error(`${s.id} timestamps fall outside ${title.title}'s runtime.`);
    }
    if (s.representativeFrameSeconds !== undefined && (s.representativeFrameSeconds < s.startSeconds || s.representativeFrameSeconds > s.endSeconds)) {
      throw new Error(`${s.id} representative frame falls outside its window.`);
    }
    const failed = s.checks.some((c) => c.outcome === "fail");
    if (failed && s.decision !== "rejected") {
      throw new Error(`${s.id} fails a guardrail, so it must be rejected.`);
    }
    if (s.decision === "rejected" && (!failed || s.rank !== null)) {
      throw new Error(`${s.id} is rejected; it needs a failing check as evidence and no rank.`);
    }
  }
  if (review.scenes.filter((s) => s.decision === "recommended").length !== 1) {
    throw new Error(`${review.titleId} must have exactly one recommended scene.`);
  }
  return review;
}

const sceneReviews: SceneReview[] = [
  defineSceneReview({
    titleId: "luv-hypothesis",
    caseId: "NF-DEMO-0001",
    source: "demo-fixture",
    // Windows observed in the registered source clip asset:luv-hypothesis:source-video:v1
    // (20.064 s, 1280×720): 00:00–00:04 single close-up; about 00:04.25–00:06.75
    // a different couple standing at the counter; about 00:07–00:14.25 the café
    // table; about 00:14.5–00:20 a close two-shot.
    scenes: [
      {
        id: "luv-scene-1",
        name: "Café table conversation",
        startSeconds: 7,
        endSeconds: 10,
        representativeFrameSeconds: 8,
        decision: "recommended",
        rank: 1,
        rationale:
          "A steady medium-wide shot of both seated actors with a clear front-right tabletop area, though the table already holds two takeaway cups and a pastry.",
        tone: "Light, playful",
        camera: "Stable medium-wide shot of the café table",
        surface: "Café table; front-right tabletop area clear and in frame",
        opportunities: ["Coffee cup", "Beverage"],
        checks: [
          { id: "tone", outcome: "pass", evidence: "A light, comic exchange: he reacts with exaggerated surprise while she stirs her drink. No sensitive moment." },
          { id: "camera-motion", outcome: "pass", evidence: "The camera holds the same medium-wide framing of the table from 00:07 to 00:10." },
          {
            id: "placement-surface",
            outcome: "pass",
            evidence:
              "The front-right tabletop, right of her cup toward the near edge, is clear of faces, hands, and props. The table is not empty: two existing takeaway cups and a pastry plate sit at its centre.",
          },
          {
            id: "face-framing",
            outcome: "pass",
            evidence:
              "Both faces are medium-wide and well above the table. She holds the straw in her own cup, his left hand rests near the front-left edge, and his hand starts rising at about 00:09.75, away from the front-right area.",
          },
          { id: "actor-restrictions", outcome: "pass", evidence: "No actor restriction recorded for anyone in the shot." },
        ],
      },
      {
        id: "luv-scene-2",
        name: "Counter two-shot",
        startSeconds: 5,
        endSeconds: 6,
        decision: "rejected",
        rank: null,
        rationale: "A different couple stands at the café counter in a medium close-up with no surface in frame, so an object has nowhere to sit.",
        tone: "Cheerful",
        camera: "Medium close-up two-shot at the counter, after a cut at about 00:04.25",
        surface: "None in frame",
        opportunities: [],
        checks: [
          { id: "tone", outcome: "pass", evidence: "Both smile and react cheerfully; no sensitive moment." },
          { id: "camera-motion", outcome: "caution", evidence: "The shot opens on him moving toward the camera before settling into the two-shot." },
          { id: "placement-surface", outcome: "fail", evidence: "No table or counter surface is visible below the two actors." },
          { id: "face-framing", outcome: "fail", evidence: "Medium close-up: their faces and shoulders fill most of the frame." },
          { id: "actor-restrictions", outcome: "pass", evidence: "No actor restriction recorded for anyone in the shot." },
        ],
      },
      {
        id: "luv-scene-3",
        name: "Close two-shot",
        startSeconds: 15,
        endSeconds: 20,
        decision: "rejected",
        rank: null,
        rationale: "The table drops out of frame and the shot tightens on both faces, so any product would intrude on them.",
        tone: "Warm, conversational",
        camera: "Close two-shot after a cut at about 00:14.5",
        surface: "None in frame",
        opportunities: [],
        checks: [
          { id: "tone", outcome: "pass", evidence: "A warm, smiling conversation; no sensitive moment." },
          { id: "camera-motion", outcome: "not-assessed", evidence: "Not measured; sampled frames show similar framing throughout." },
          { id: "placement-surface", outcome: "fail", evidence: "The tabletop is out of frame." },
          { id: "face-framing", outcome: "fail", evidence: "Close framing: both faces fill the frame." },
          { id: "actor-restrictions", outcome: "pass", evidence: "No actor restriction recorded for anyone in the shot." },
        ],
      },
    ],
  }),
];

export function getSceneReview(titleId: string): SceneReview | undefined {
  return sceneReviews.find((r) => r.titleId === titleId);
}
