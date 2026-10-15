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
    scenes: [
      {
        id: "luv-scene-1",
        name: "Lab desk discussion",
        startSeconds: 42,
        endSeconds: 47,
        decision: "recommended",
        rank: 1,
        rationale:
          "Light, stable, and uncluttered, with a clear desk surface where an everyday object belongs.",
        tone: "Light, playful",
        camera: "Stable medium-wide shot",
        surface: "Lab desk, clear and in frame",
        opportunities: ["Coffee cup", "Phone", "Laptop"],
        checks: [
          { id: "tone", outcome: "pass", evidence: "Playful back-and-forth; no sensitive or emotional moment." },
          { id: "camera-motion", outcome: "pass", evidence: "Camera holds a stable medium-wide shot for the full five seconds." },
          { id: "placement-surface", outcome: "pass", evidence: "Desk surface is visible and unobstructed." },
          { id: "face-framing", outcome: "pass", evidence: "No close-up faces; both actors are framed medium-wide." },
          { id: "actor-restrictions", outcome: "pass", evidence: "No actor restriction recorded for anyone in the shot." },
        ],
      },
      {
        id: "luv-scene-2",
        name: "Campus café conversation",
        startSeconds: 78,
        endSeconds: 83,
        decision: "acceptable",
        rank: 2,
        rationale:
          "Relaxed and natural for a drink or takeaway bag, but background movement makes a clean insert harder.",
        tone: "Relaxed, conversational",
        camera: "Framing not yet recorded; moderate movement behind the table",
        surface: "Café table",
        opportunities: ["Beverage", "Food bag"],
        checks: [
          { id: "tone", outcome: "pass", evidence: "Easygoing conversation; no sensitive moment." },
          { id: "camera-motion", outcome: "caution", evidence: "Moderate background movement could make an inserted object harder to keep stable." },
          { id: "placement-surface", outcome: "pass", evidence: "Table surface is available in the shot." },
          { id: "face-framing", outcome: "not-assessed", evidence: "Face framing is not recorded in this fixture. Confirm before generation." },
          { id: "actor-restrictions", outcome: "pass", evidence: "No known actor restriction for the cast in this scene." },
        ],
      },
      {
        id: "luv-scene-3",
        name: "Hallway disagreement",
        startSeconds: 124,
        endSeconds: 129,
        decision: "rejected",
        rank: null,
        rationale:
          "Emotionally tense, tightly framed, and without a surface, so any product would intrude on the moment.",
        tone: "Emotionally tense",
        camera: "Close framing on the actors",
        surface: "None",
        opportunities: [],
        checks: [
          { id: "tone", outcome: "fail", evidence: "A tense disagreement; a product here risks undermining the scene and viewer trust." },
          { id: "camera-motion", outcome: "not-assessed", evidence: "Camera motion is not recorded in this fixture." },
          { id: "placement-surface", outcome: "fail", evidence: "No surface where an object could sit naturally." },
          { id: "face-framing", outcome: "fail", evidence: "Close framing on the actors leaves no room for an object without visual intrusion." },
          { id: "actor-restrictions", outcome: "pass", evidence: "No actor restriction recorded for anyone in the shot." },
        ],
      },
    ],
  }),
];

export function getSceneReview(titleId: string): SceneReview | undefined {
  return sceneReviews.find((r) => r.titleId === titleId);
}
