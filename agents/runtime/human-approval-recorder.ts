import { approvalReasonErrors, recordHumanApprovalOfStoredReview, type ApprovalSender } from "@/agents/handoff/human-approval";
import { validateGovernorReview } from "@/agents/handoff/governor-review";
import { sha256Hex } from "@/agents/media/edited-still";
import type { PreviewEvidenceSource } from "@/agents/media/preview-evidence";
import type { ApprovalRow, ReviewRow, WorkflowStore } from "@/agents/persistence/store";
import { canonical, PersistentPreviewRegistry, type WorkflowRegistry } from "@/agents/persistence/workflow";

/**
 * Bounded recording of the human owner's final approval of one stored Release
 * Governor review, pinned to exact records. Everything is verified from the
 * registry: the plan's canonical hash, the stored approve-for-human-review and
 * its revalidation, the registered preview, its checksum and approved visual
 * review (preview evidence), the case awaiting human review, and no existing
 * approval. Only the exact expected reasons are accepted. One approval is
 * inserted; the store moves the case to approved in the same transaction.
 */

export type ApprovalPin = Readonly<{
  caseId: string;
  planId: string;
  /** sha256 hex of the stored plan's canonical JSON. */
  planSha256: string;
  reviewId: string;
  previewAssetId: string;
  previewChecksum: string;
  visualReviewId: string;
}>;

export type ApprovalDeps = { workflow: WorkflowRegistry; store: WorkflowStore; evidence: PreviewEvidenceSource };
type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** The supplied reasons must be valid and exactly the expected reasons, in order, character for character. */
export function checkApprovalReasons(reasons: readonly unknown[], expected: readonly string[]): string[] {
  const errors = approvalReasonErrors(reasons);
  if (errors.length > 0) return errors;
  if (reasons.length !== expected.length || reasons.some((r, i) => r !== expected[i])) return [`The reasons must be exactly the ${expected.length} authorized reasons, in order.`];
  return [];
}

/** Read-only: every precondition for approving the pinned review. */
export async function preflightHumanApproval(deps: ApprovalDeps, pin: ApprovalPin): Promise<Result<{ review: ReviewRow; previews: PersistentPreviewRegistry }>> {
  const plan = await deps.workflow.loadPlan(pin.planId);
  if (!plan.ok) return { ok: false, errors: [`Plan ${pin.planId} does not revalidate.`, ...plan.errors] };
  const errors: string[] = [];
  const planSha256 = sha256Hex(canonical(plan.value));
  if (planSha256 !== pin.planSha256) errors.push(`Plan ${pin.planId} has canonical sha256 ${planSha256}, not the approved ${pin.planSha256}.`);
  if (plan.value.caseId !== pin.caseId) errors.push(`Plan ${pin.planId} belongs to another case.`);

  const review = await deps.store.getReview(pin.reviewId);
  if (!review) return { ok: false, errors: [...errors, `Governor review ${pin.reviewId} is not stored.`] };
  if (review.decision !== "approve-for-human-review") errors.push(`Governor review ${pin.reviewId} is "${review.decision}", not approve-for-human-review.`);
  if (review.case_id !== pin.caseId || review.plan_id !== pin.planId || review.preview_asset_id !== pin.previewAssetId) errors.push("The Governor review is not bound to the pinned case, plan, and preview.");
  const previews = new PersistentPreviewRegistry(deps.workflow);
  const registered = await previews.refresh(pin.planId);
  const loaded = await deps.workflow.loadGeneratedPreview(pin.planId);
  if (!registered || !loaded.ok || loaded.value.assetId !== pin.previewAssetId) errors.push("The pinned preview is not the plan's registered preview.");
  const reviewErrors = validateGovernorReview(review.review, { caseId: pin.caseId, decision: "approve-for-human-review", artifactId: pin.planId }, previews);
  if (reviewErrors.length > 0) errors.push("The stored Governor review does not revalidate.", ...reviewErrors);

  const evidence = await deps.evidence(pin.planId);
  if (evidence.outcome !== "pass") errors.push(`Preview evidence is "${evidence.outcome}": ${evidence.detail}`);
  else if (evidence.assetId !== pin.previewAssetId || evidence.checksum !== pin.previewChecksum || evidence.visualReviewId !== pin.visualReviewId) {
    errors.push("Preview evidence does not pass for the pinned preview, checksum, and visual review.");
  }
  const caseRow = await deps.store.getCase(pin.caseId);
  if (caseRow?.status !== "awaiting-human-review") errors.push(`Case ${pin.caseId} is ${caseRow ? `"${caseRow.status}"` : "missing"}, not "awaiting-human-review".`);
  if (await deps.store.getApprovalForReview(pin.reviewId)) errors.push(`Governor review ${pin.reviewId} already has a human approval.`);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { review, previews } };
}

/**
 * Records the pinned approval for the authenticated owner with exactly the
 * expected reasons, then reads it back. Refuses, writing nothing, if any check
 * fails; the store refuses a second approval for the review.
 */
export async function recordPinnedHumanApproval(
  deps: ApprovalDeps,
  pin: ApprovalPin,
  options: { sender: ApprovalSender; ownerUserId: string; approverName: string; reasons: readonly unknown[]; expectedReasons: readonly string[] },
): Promise<Result<{ approval: ApprovalRow; caseStatus: string }>> {
  const reasonErrors = checkApprovalReasons(options.reasons, options.expectedReasons);
  if (reasonErrors.length > 0) return { ok: false, errors: reasonErrors };
  const pre = await preflightHumanApproval(deps, pin);
  if (!pre.ok) return pre;
  const approval = recordHumanApprovalOfStoredReview({
    sender: options.sender,
    ownerUserId: options.ownerUserId,
    approverName: options.approverName,
    review: pre.value.review.review,
    caseId: pin.caseId,
    planId: pin.planId,
    previews: pre.value.previews,
  });
  if (!approval.ok) return approval;
  const reasons = options.reasons as readonly string[];
  const saved = await deps.workflow.saveHumanApproval(approval.value, reasons);
  if (!saved.ok) return saved;

  const back = await deps.store.getApprovalForReview(pin.reviewId);
  const caseStatus = (await deps.store.getCase(pin.caseId))?.status ?? "missing";
  if (
    !back ||
    back.case_id !== pin.caseId ||
    back.preview_asset_id !== pin.previewAssetId ||
    back.reviewer_user_id !== options.sender.id ||
    back.decision !== "approve" ||
    JSON.stringify(back.reasons) !== JSON.stringify(reasons) ||
    caseStatus !== "approved"
  ) {
    return { ok: false, errors: ["The approval did not read back exactly, or the case is not approved."] };
  }
  return { ok: true, value: { approval: back, caseStatus } };
}
