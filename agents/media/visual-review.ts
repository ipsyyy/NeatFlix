import { randomUUID } from "node:crypto";
import type { ApprovalSender } from "@/agents/handoff/human-approval";
import { DuplicateRecordError, type VisualReviewRow, type WorkflowStore } from "@/agents/persistence/store";
import type { WorkflowRegistry } from "@/agents/persistence/workflow";
import { loadVerifiedEditedStill } from "./edited-still";

/**
 * Human visual review of a media asset (§7.3: human review owns the final
 * visual decision). One append-only review per asset, from the human owner
 * only. The asset's own record is never changed: its provenance keeps the
 * review status it had at generation, and this review is the current decision.
 */

export type VisualDecision = "approved" | "rejected";
const MAX_REASONS = 10;
const MAX_REASON_LENGTH = 500;

export async function recordVisualReview(options: {
  workflow: WorkflowRegistry;
  store: WorkflowStore;
  assetId: string;
  decision: VisualDecision;
  reasons: string[];
  reviewer: ApprovalSender & { name: string };
  ownerUserId: string;
}): Promise<{ ok: true; status: "created" | "existing"; review: VisualReviewRow } | { ok: false; errors: string[] }> {
  const { reviewer, decision } = options;
  const errors: string[] = [];
  if (reviewer.type !== "User" || reviewer.role !== null) errors.push("Only a human user can record a visual review.");
  if (!options.ownerUserId || reviewer.id !== options.ownerUserId) errors.push("Only the human owner can record a visual review.");
  if (!reviewer.name?.trim() || reviewer.name.length > 200) errors.push("The reviewer must be named.");
  if (decision !== "approved" && decision !== "rejected") errors.push('decision must be "approved" or "rejected".');
  const reasons = options.reasons.map((r) => r.trim());
  if (reasons.length > MAX_REASONS || reasons.some((r) => r.length === 0 || r.length > MAX_REASON_LENGTH)) errors.push("Each reason must be non-empty and at most 500 characters.");
  if (decision === "rejected" && reasons.length === 0) errors.push("A rejection must state its reasons.");
  if (errors.length > 0) return { ok: false, errors };

  // The asset must be a valid edited still: its record revalidates against its plan, frame, and prompt.
  const verified = await loadVerifiedEditedStill(options.workflow, options.store, options.assetId);
  if (!verified.ok) return { ok: false, errors: ["The asset is not a valid registered edited still.", ...verified.errors] };
  const asset = verified.row;

  const same = (r: VisualReviewRow) =>
    r.decision === decision && r.asset_checksum === asset.checksum && r.reviewer_user_id === reviewer.id && JSON.stringify(r.reasons) === JSON.stringify(reasons);
  const existing = await options.store.getVisualReview(options.assetId);
  if (existing) return same(existing) ? { ok: true, status: "existing", review: existing } : { ok: false, errors: ["This asset already has a different visual review; reviews are immutable."] };

  try {
    await options.store.insertVisualReview({
      review_id: randomUUID(),
      asset_id: options.assetId,
      case_id: asset.case_id,
      decision,
      reasons,
      asset_checksum: asset.checksum,
      reviewer_user_id: reviewer.id,
      reviewer_name: reviewer.name.trim(),
    });
  } catch (error) {
    if (error instanceof DuplicateRecordError) return { ok: false, errors: ["This asset already has a visual review; reviews are immutable."] };
    throw error;
  }
  const back = await options.store.getVisualReview(options.assetId);
  if (!back || !same(back)) return { ok: false, errors: ["The visual review did not read back identically."] };
  return { ok: true, status: "created", review: back };
}

/** The asset's current human visual decision: its review if one exists, otherwise pending. */
export async function currentVisualDecision(store: WorkflowStore, assetId: string): Promise<VisualDecision | "pending"> {
  const review = await store.getVisualReview(assetId);
  return review ? review.decision : "pending";
}
