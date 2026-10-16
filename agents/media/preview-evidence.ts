import type { PrivateStorage } from "@/agents/persistence/private-storage";
import type { WorkflowStore } from "@/agents/persistence/store";
import type { WorkflowRegistry } from "@/agents/persistence/workflow";
import { loadVerifiedGeneratedPreview } from "./generated-preview";

/**
 * The Release Governor's technical evidence about a plan's generated preview
 * (PRODUCT_SOURCE_OF_TRUTH.md §7.3: human review owns the final visual
 * decision). "pass" only when the plan's one registered preview revalidates
 * exactly as the generated-preview visual-review path requires (plan and
 * prompt binding, approved source still, generator provenance, private bytes
 * matching the registered checksum) and the human owner's immutable visual
 * review of that exact asset and checksum is "approved". "not-evaluated" only
 * when no preview is registered for the plan. Every other state is "fail".
 * Read-only. The wording never claims that the Governor itself looked at media.
 */

export type PreviewEvidenceOutcome = "pass" | "fail" | "not-evaluated";
export type PreviewEvidence = {
  outcome: PreviewEvidenceOutcome;
  detail: string;
  assetId: string | null;
  checksum: string | null;
  visualReviewId: string | null;
};
/** Supplies preview evidence for a plan ID. */
export type PreviewEvidenceSource = (planId: string) => Promise<PreviewEvidence>;

export const NO_PREVIEW_DETAIL =
  "No generated preview is registered for this plan, so naturalness and preservation of faces and composition cannot be evaluated.";

export async function evaluatePreviewEvidence(
  deps: { workflow: WorkflowRegistry; store: WorkflowStore; storage?: PrivateStorage },
  planId: string,
): Promise<PreviewEvidence> {
  const fail = (detail: string, assetId: string | null = null, checksum: string | null = null, visualReviewId: string | null = null): PreviewEvidence => ({
    outcome: "fail",
    detail,
    assetId,
    checksum,
    visualReviewId,
  });
  const rows = await deps.store.listMediaAssetsForPlan(planId, "generated-preview", 2);
  if (rows.length === 0) return { outcome: "not-evaluated", detail: NO_PREVIEW_DETAIL, assetId: null, checksum: null, visualReviewId: null };
  if (rows.length > 1) return fail("Several generated previews are registered for this plan; one must be selected by asset ID before it can count as evidence.");
  const assetId = rows[0].asset_id;
  if (!deps.storage) return fail(`Generated preview ${assetId} is registered, but its private bytes cannot be checked here, so it is not evidence.`, assetId);

  const verified = await loadVerifiedGeneratedPreview(deps.workflow, deps.store, deps.storage, assetId);
  if (!verified.ok) return fail(`Generated preview ${assetId} does not revalidate: ${verified.errors.slice(0, 3).join(" ")}`, assetId);
  const { checksum, case_id: caseId } = verified.row;

  const review = await deps.store.getVisualReview(assetId);
  if (!review) return fail(`Generated preview ${assetId} has no recorded human visual review; the human owner must record one before it can count as evidence.`, assetId, checksum);
  if (review.asset_id !== assetId || review.asset_checksum !== checksum || review.case_id !== caseId) {
    return fail(`The human visual review ${review.review_id} does not name generated preview ${assetId} with checksum ${checksum} in case ${caseId}.`, assetId, checksum, review.review_id);
  }
  if (review.decision !== "approved") return fail(`The human owner's visual review ${review.review_id} of generated preview ${assetId} is "${review.decision}".`, assetId, checksum, review.review_id);
  return {
    outcome: "pass",
    detail:
      `Generated preview ${assetId} revalidates against its plan, motion prompt, approved source still, generator provenance, and private bytes (${checksum}). ` +
      `The human owner's immutable visual review ${review.review_id} of this exact asset and checksum records the decision "approved".`,
    assetId,
    checksum,
    visualReviewId: review.review_id,
  };
}
