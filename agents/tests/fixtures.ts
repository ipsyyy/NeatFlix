import type { HandoffEnvelope } from "@/agents/handoff/envelope";
import type { PlacementPlan } from "@/agents/handoff/placement-plan";

/** A valid Content Curator → Scene Scout handoff to derive test cases from. */
export function curatorApproval(overrides: Partial<HandoffEnvelope> = {}): HandoffEnvelope {
  return {
    caseId: "NF-DEMO-0001",
    artifactId: "title:luv-hypothesis",
    senderRole: "content-curator",
    recipientRole: "scene-scout",
    decision: "approve",
    evidence: [{ claim: "Rights cleared for placement work", source: "catalogue.rightsStatus" }],
    confidence: 0.9,
    assumptions: [],
    blockers: [],
    nextAction: "Evaluate candidate scenes for The LUV Hypothesis.",
    // Runtime-style stamp: current UTC, as the send boundary would attach it.
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

export function governorHandoff(overrides: Partial<HandoffEnvelope> = {}): HandoffEnvelope {
  return curatorApproval({
    artifactId: "placement:luv-scene-1:v1",
    senderRole: "release-governor",
    recipientRole: "human-reviewer",
    decision: "approve-for-human-review",
    nextAction: "Human reviewer to approve or reject release.",
    ...overrides,
  });
}

/** Fake credential-shaped values. Not real secrets. */
export const FAKE_UUIDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
];

/** A placement plan that satisfies every rule, built from the approved fixtures. */
export function validPlacementPlan(overrides: Partial<PlacementPlan> = {}): PlacementPlan {
  return {
    kind: "placement-plan",
    version: 1,
    planId: "plan:daybreak-cold-brew:luv-scene-1:v1",
    caseId: "NF-DEMO-0001",
    sourceArtifacts: {
      matchArtifactId: "match:daybreak-cold-brew:luv-scene-1",
      sceneArtifactId: "scene:luv-scene-1",
      titleId: "luv-hypothesis",
    },
    scene: { sceneId: "luv-scene-1", name: "Lab desk discussion", startSeconds: 42, endSeconds: 47 },
    product: { campaignId: "daybreak-cold-brew", product: "Daybreak Cold Brew", format: "Branded takeaway coffee cup" },
    placement: {
      region: "visible lab desk",
      motion: "stationary",
      handInteraction: "none",
      description: "One Daybreak Cold Brew branded takeaway coffee cup rests upright on the visible lab desk, clear of both actors.",
    },
    guidance: {
      scale: "Match a real 16 oz takeaway cup relative to the desk and notebook.",
      perspective: "Align the cup base to the desk plane and the existing camera angle.",
      lighting: "Match the warm practical lamp light and cool window spill already in the scene.",
      shadow: "Add a soft contact shadow consistent with the existing light direction.",
      colorMatch: "Grade the cup to the scene's night-time color balance and contrast.",
    },
    preservation: {
      faces: ["Keep both actors' faces, expressions, and identities unchanged and unobstructed."],
      bodies: ["Keep both actors' poses, hands, and clothing exactly as they are."],
      background: ["Keep the windows, shelves, equipment, and lighting unchanged."],
      composition: ["Keep the framing, crop, and camera position unchanged."],
    },
    brandLegibility: ["Logo readable but small: no larger than the cup's printed band, no added text."],
    negativeConstraints: [
      "No hand interaction with the cup.",
      "No face obstruction or face alteration.",
      "No added text, captions, watermarks, or extra logos.",
      "No camera movement and no additional products.",
    ],
    prompts: {
      stillImageEdit: {
        target: "gemini-nano-banana",
        status: "not-executed",
        label: "Generation instruction — not yet executed",
        prompt: "Insert one Daybreak Cold Brew branded takeaway coffee cup standing on the visible lab desk. No hand interaction. Keep everything else unchanged.",
      },
      motion: {
        target: "reactor",
        status: "not-executed",
        label: "Generation instruction — not yet executed",
        durationSeconds: 5,
        prompt: "Animate the scene for 5 seconds with the cup stationary on the desk. No hand interaction and no camera movement.",
      },
    },
    sourceMedia: {
      kind: "title-artwork-stand-in",
      isSceneFrame: false,
      src: "/artwork/the-luv-hypothesis-hero.png",
      note: "The current visual is approved title artwork used as a stand-in, not a frame from the selected scene.",
    },
    assumptions: ["No video exists yet; the approved title artwork is a stand-in."],
    blockers: [],
    evidence: [{ claim: "The lab desk is clear and in frame.", source: "nativeframe_get_selected_scene.scene.surface" }],
    ...overrides,
  };
}
