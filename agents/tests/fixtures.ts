import type { HandoffEnvelope } from "@/agents/handoff/envelope";
import type { GovernorReview, PreviewRecord, PreviewRegistry, ReviewDecision } from "@/agents/handoff/governor-review";
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

export const PLAN_ID = "plan:daybreak-cold-brew:luv-scene-1:v1";

/** A preview the (future) media pipeline would record. Test-only: no such preview exists today. */
export const FUTURE_PREVIEW: PreviewRecord = {
  planId: PLAN_ID,
  assetRef: "storage://previews/luv-scene-1/daybreak-v1.mp4",
  provenance: { generator: "reactor", generatedAt: "2026-10-20T10:00:00Z", inputPlanId: PLAN_ID },
  generationMetadata: { model: "reactor-orbis", latencyMs: 41000, costUsd: 0.42 },
};
export const FUTURE_PREVIEWS: PreviewRegistry = { find: (planId) => (planId === PLAN_ID ? FUTURE_PREVIEW : null) };

/** A valid Release Governor review for each decision. Approval needs FUTURE_PREVIEWS. */
export function validGovernorReview(decision: ReviewDecision = "revise", overrides: Partial<GovernorReview> = {}): GovernorReview {
  const approve = decision === "approve-for-human-review";
  const stop = decision === "stop";
  return {
    kind: "governor-review",
    version: 1,
    reviewId: `review:${PLAN_ID}:r1`,
    caseId: "NF-DEMO-0001",
    subject: { titleId: "luv-hypothesis", sceneId: "luv-scene-1", campaignId: "daybreak-cold-brew", planId: PLAN_ID },
    decision,
    hhh: {
      helpful: { outcome: approve ? "pass" : "not-evaluated", rationale: "The plan is actionable; its visual result is the open question." },
      honest: { outcome: "pass", rationale: "The plan labels both prompts not executed and the artwork as a stand-in." },
      harmless: { outcome: stop ? "fail" : "pass", rationale: stop ? "Brand-safety rule failed." : "Rights, audience, and scene guardrails pass." },
    },
    checks: [
      { id: "campaign-match", category: "policy", outcome: stop ? "fail" : "pass", detail: "Deterministic match decision.", source: "nativeframe_check_placement_plan.checks[campaign-match]" },
      { id: "preview-visual-quality", category: "technical", outcome: approve ? "pass" : "not-evaluated", detail: approve ? "Naturalness evaluation recorded with the preview." : "No preview to evaluate.", source: approve ? "nativeframe_get_preview_status.assetRef" : "nativeframe_check_placement_plan.checks[preview-visual-quality]" },
    ],
    evidence: [
      { claim: "The plan meets every deterministic rule.", source: "nativeframe_check_placement_plan.checks[plan-rules]" },
      { claim: approve ? "A generated preview is recorded." : "No generated preview is recorded.", source: "nativeframe_get_preview_status.previewExists" },
    ],
    blockers: approve ? [] : stop ? ["Brand-safety veto."] : ["No generated preview exists to evaluate."],
    corrections:
      decision === "revise"
        ? [
            { kind: "generate-preview", issue: "No generated preview exists.", requiredAction: "Run the approved still-image and motion prompts and record the preview." },
            { kind: "provide-provenance", issue: "No provenance exists.", requiredAction: "Record generator, generation time, and input plan ID." },
            { kind: "provide-evaluation-evidence", issue: "No visual evaluation evidence.", requiredAction: "Provide naturalness and preservation evidence for the preview." },
          ]
        : [],
    assumptions: ["All data are fictional demo fixtures."],
    uncertainty: approve ? "Human review owns the final visual decision." : "Visual quality is unknown until a preview exists.",
    preview: approve
      ? { status: "provided", assetRef: FUTURE_PREVIEW.assetRef, provenance: { ...FUTURE_PREVIEW.provenance }, generationMetadata: { ...FUTURE_PREVIEW.generationMetadata } }
      : { status: "missing", assetRef: null, provenance: null, generationMetadata: null },
    humanApproval: { status: approve ? "pending" : "not-requested" },
    ...overrides,
  };
}

/** A valid Release Governor handoff carrying a review for its decision. */
export function governorHandoff(overrides: Partial<HandoffEnvelope> = {}): HandoffEnvelope {
  const decision = (overrides.decision ?? "approve-for-human-review") as ReviewDecision;
  const review = validGovernorReview(decision);
  return curatorApproval({
    artifactId: PLAN_ID,
    senderRole: "release-governor",
    recipientRole: decision === "revise" ? "placement-director" : "human-reviewer",
    decision,
    evidence: review.evidence,
    blockers: review.blockers,
    nextAction: decision === "revise" ? "Placement Director to generate the preview and return it with provenance." : "Human reviewer to approve or reject release.",
    artifact: review,
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
    scene: { sceneId: "luv-scene-1", name: "Café table conversation", startSeconds: 7, endSeconds: 10 },
    product: { campaignId: "daybreak-cold-brew", product: "Daybreak Cold Brew", format: "Branded takeaway coffee cup" },
    placement: {
      region: "visible café table",
      motion: "stationary",
      handInteraction: "none",
      description: "One Daybreak Cold Brew branded takeaway coffee cup rests upright on the clear front-right area of the visible café table, away from the existing cups, the pastry, and both actors.",
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
        prompt: "Insert one Daybreak Cold Brew branded takeaway coffee cup standing on the clear front-right area of the visible café table. No hand interaction. Keep everything else unchanged.",
      },
      motion: {
        target: "reactor",
        status: "not-executed",
        label: "Generation instruction — not yet executed",
        durationSeconds: 3,
        prompt: "Animate the scene for 3 seconds with the cup stationary on the table. No hand interaction and no camera movement.",
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
    evidence: [{ claim: "The front-right café table area is clear and in frame.", source: "nativeframe_get_selected_scene.scene.surface" }],
    ...overrides,
  };
}
