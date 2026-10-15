import type { HandoffEnvelope, ValidationResult } from "./envelope";
import { NO_GENERATED_PREVIEWS, type GovernorReview, type PreviewRegistry } from "./governor-review";
import { validateOutgoing } from "./protocol";

/**
 * Human release approval (PRODUCT_SOURCE_OF_TRUTH.md §5, §7.1, §11). Approval is
 * never parsed from chat text or handoffs: it exists only as a record created
 * by recordHumanApproval for the authenticated human owner of the NativeFrame
 * agents. Records are tracked by identity, so a look-alike object (from JSON,
 * an agent, or BAND plain text) is not an approval.
 */

export type HumanApproval = Readonly<{
  caseId: string;
  artifactId: string;
  reviewId: string;
  approverUserId: string;
  approverName: string;
  approvedAt: string;
}>;

const recorded = new WeakSet<object>();

/** Who BAND authenticated as the sender of the approval action. */
export type ApprovalSender = { id: string; type: string; role: string | null };

/**
 * Records a human's approval of a Release Governor "approve-for-human-review".
 * The sender must be the BAND `User` who owns the NativeFrame agents, never an
 * agent; the governor handoff must be a valid approval with a confirmed preview.
 */
export function recordHumanApproval(options: {
  sender: ApprovalSender;
  ownerUserId: string;
  approverName: string;
  governorHandoff: unknown;
  previews?: PreviewRegistry;
  now?: Date;
}): ValidationResult<HumanApproval> {
  const { sender } = options;
  const errors: string[] = [];
  if (sender.type !== "User" || sender.role !== null) errors.push("Only a human BAND user can approve release.");
  if (!options.ownerUserId || sender.id !== options.ownerUserId) errors.push("Only the human owner of the NativeFrame agents can approve release.");
  if (!options.approverName?.trim()) errors.push("Human approval must name the approver.");
  const governor = checkGovernorApproval(options.governorHandoff, options.previews);
  if (!governor.ok) errors.push(...governor.errors);
  if (errors.length > 0 || !governor.ok) return { ok: false, errors };

  const review = governor.value.artifact as GovernorReview;
  const approval: HumanApproval = Object.freeze({
    caseId: governor.value.caseId,
    artifactId: governor.value.artifactId,
    reviewId: review.reviewId,
    approverUserId: sender.id,
    approverName: options.approverName.trim(),
    approvedAt: (options.now ?? new Date()).toISOString(),
  });
  recorded.add(approval);
  return { ok: true, value: approval };
}

/** A valid Release Governor "approve-for-human-review" with no blockers, under the given preview registry. */
function checkGovernorApproval(governorHandoff: unknown, previews: PreviewRegistry = NO_GENERATED_PREVIEWS): ValidationResult<HandoffEnvelope> {
  const result = validateOutgoing(governorHandoff, { previews });
  if (!result.ok) return result;
  const env = result.value;
  const errors: string[] = [];
  if (env.senderRole !== "release-governor") errors.push("Only a Release Governor handoff can lead to release.");
  if (env.decision !== "approve-for-human-review") errors.push(`Governor decision is "${env.decision}", not approve-for-human-review.`);
  if (env.artifact?.kind !== "governor-review") errors.push("The governor handoff must carry its review.");
  return errors.length > 0 ? { ok: false, errors } : result;
}

/**
 * Release requires both a Release Governor "approve-for-human-review" (with a
 * confirmed generated preview and passing checks) and a recorded human
 * approval for the same case, artifact, and review. The governor alone can
 * never release.
 */
export function canRelease(
  governorHandoff: unknown,
  humanApproval: HumanApproval | null | undefined,
  options: { previews?: PreviewRegistry } = {},
): ValidationResult<true> {
  const governor = checkGovernorApproval(governorHandoff, options.previews);
  if (!governor.ok) return governor;
  const env = governor.value;
  const errors: string[] = [];
  if (!humanApproval) {
    errors.push("Explicit human approval is required before release.");
  } else if (!recorded.has(humanApproval)) {
    errors.push("Human approval was not recorded by the authenticated human owner.");
  } else if (
    humanApproval.caseId !== env.caseId ||
    humanApproval.artifactId !== env.artifactId ||
    humanApproval.reviewId !== (env.artifact as GovernorReview).reviewId
  ) {
    errors.push("Human approval does not match this case, artifact, and review.");
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: true };
}

/** No A/B test can begin without Release Governor clearance and recorded human approval (§5). */
export function canStartExperiment(
  governorHandoff: unknown,
  humanApproval: HumanApproval | null | undefined,
  options: { previews?: PreviewRegistry } = {},
): ValidationResult<true> {
  return canRelease(governorHandoff, humanApproval, options);
}
