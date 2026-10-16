import type { ApprovalPin } from "./human-approval-recorder";

/** The pinned records of the human owner's final approval of LUV plan v3 (case NF-DEMO-0001). */
export const PIN: ApprovalPin = Object.freeze({
  caseId: "NF-DEMO-0001",
  planId: "plan:daybreak-cold-brew:luv-scene-1:v3",
  planSha256: "8643a97e76b3b9c9c4f2381db65f1d89e5c6ca24736393f6c7f3ec2283d6f579",
  reviewId: "review:plan:daybreak-cold-brew:luv-scene-1:v3:r1",
  previewAssetId: "asset:luv-hypothesis:generated-preview:luv-scene-1:v3-fallback",
  previewChecksum: "sha256:4188bc88b082bce4a402132239bcae06348414e84b3027741281d61330af6bff",
  visualReviewId: "56f9e9f9-d22c-44ec-bf93-fc0855a7c741",
});

/** The six reasons the human owner authorized, exactly. */
export const AUTHORIZED_REASONS: readonly string[] = Object.freeze([
  "The approved output contains exactly the original two takeaway cups and introduces no third cup or new product object.",
  "Both existing cup surfaces carry the intended Daybreak Cold Brew branding while the people, setting and scene remain materially consistent.",
  "The approved primary motion preview is the deterministic local FFmpeg fallback, whose registered bytes, checksum, provenance and visual review have been verified.",
  "The Release Governor’s HHH, policy, campaign, scene-guardrail and technical preview checks passed with no blocker.",
  "The Governor review’s references to generation prompts being “not-executed” are stale historical plan labels, not the current execution facts: Gemini produced the approved edited still, and FFmpeg produced the approved fallback motion preview. This human approval records that correction without modifying the immutable Governor review.",
  "The recovered Reactor clips remain secondary integration evidence only because their moving cup lettering is visually distorted; they are not the approved primary output.",
]);
