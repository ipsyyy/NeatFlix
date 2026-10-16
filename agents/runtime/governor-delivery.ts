import type { HandoffEnvelope } from "@/agents/handoff/envelope";
import { RELEASE_GOVERNOR_DISCLOSURE } from "@/agents/handoff/output-rules";
import type { PlacementPlan } from "@/agents/handoff/placement-plan";
import { HANDOFF_FENCE } from "@/agents/handoff/protocol";
import { SOURCE_FRAME_DISCLOSURE, type SourceFrameRegistry } from "@/agents/handoff/source-frames";
import { validateDraft } from "@/agents/handoff/stamp";
import { sha256Hex } from "@/agents/media/edited-still";
import type { PreviewEvidence, PreviewEvidenceSource } from "@/agents/media/preview-evidence";
import type { WorkflowStore } from "@/agents/persistence/store";
import { canonical, type WorkflowRegistry } from "@/agents/persistence/workflow";

/**
 * Bounded delivery of one persisted, human-directed placement plan to the
 * Release Governor, pinned to exact records. The plan is delivered exactly as
 * stored (the Governor's gate re-saves it, which is a no-op for an identical
 * copy and refused for any other), and a Governor review is persisted only
 * through guardedSaveGovernorReview: an approve-for-human-review whose preview
 * evidence, recomputed immediately before saving, still passes for the pinned
 * asset, checksum, and approved visual review. Everything else fails closed.
 */

export type DeliveryPin = Readonly<{
  caseId: string;
  planId: string;
  /** sha256 hex of the stored plan's canonical JSON. */
  planSha256: string;
  previewAssetId: string;
  previewChecksum: string;
  visualReviewId: string;
}>;

export type DeliveryDeps = { workflow: WorkflowRegistry; store: WorkflowStore; evidence: PreviewEvidenceSource };
type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Read-only: every precondition for delivering (and for saving a review of) the pinned plan. */
export async function preflightGovernorDelivery(
  deps: DeliveryDeps,
  pin: DeliveryPin,
): Promise<Result<{ plan: PlacementPlan; planSha256: string; evidence: PreviewEvidence }>> {
  const plan = await deps.workflow.loadPlan(pin.planId);
  if (!plan.ok) return { ok: false, errors: [`Plan ${pin.planId} does not revalidate.`, ...plan.errors] };
  const errors: string[] = [];
  const planSha256 = sha256Hex(canonical(plan.value));
  if (planSha256 !== pin.planSha256) errors.push(`Plan ${pin.planId} has canonical sha256 ${planSha256}, not the approved ${pin.planSha256}.`);
  if (plan.value.caseId !== pin.caseId) errors.push(`Plan ${pin.planId} belongs to case ${plan.value.caseId}, not ${pin.caseId}.`);
  const caseRow = await deps.store.getCase(pin.caseId);
  if (caseRow?.status !== "open") errors.push(`Case ${pin.caseId} is ${caseRow ? `"${caseRow.status}"` : "missing"}, not "open".`);
  if ((await deps.store.listReviewsForCase(pin.caseId, 1)).length > 0) errors.push(`Case ${pin.caseId} already has a Governor review.`);
  const evidence = await deps.evidence(pin.planId);
  if (evidence.outcome !== "pass") errors.push(`Preview evidence is "${evidence.outcome}": ${evidence.detail}`);
  else if (evidence.assetId !== pin.previewAssetId || evidence.checksum !== pin.previewChecksum || evidence.visualReviewId !== pin.visualReviewId) {
    errors.push(`Preview evidence passes for ${evidence.assetId} (${evidence.checksum}, review ${evidence.visualReviewId}), not the pinned asset, checksum, and review.`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { plan: plan.value, planSha256, evidence } };
}

/**
 * The Placement Director's instructions-ready handoff carrying the stored plan
 * unchanged, as an unstamped draft (postWithTrustedTimestamp stamps it at the
 * POST). Built in code, never by a model; validated as the send boundary will.
 */
export function buildDirectorDelivery(
  plan: PlacementPlan,
  options: { governorMention: string; frames: SourceFrameRegistry; now?: Date },
): Result<{ draftContent: string; envelope: Omit<HandoffEnvelope, "timestamp"> }> {
  const envelope: Omit<HandoffEnvelope, "timestamp"> = {
    caseId: plan.caseId,
    artifactId: plan.planId,
    senderRole: "placement-director",
    recipientRole: "release-governor",
    decision: "instructions-ready",
    evidence: [{ claim: `Plan ${plan.planId} is the persisted plan for case ${plan.caseId}, delivered unchanged.`, source: "handoff.artifact" }],
    confidence: 0.8,
    assumptions: ["The plan is the human-directed revision persisted in the workflow registry; this delivery does not change it."],
    blockers: [],
    nextAction: "Release Governor reviews the plan with its evidence tools.",
    artifact: plan,
  };
  const readable =
    `${options.governorMention} Delivery of the persisted placement plan ${plan.planId} for case ${plan.caseId}, unchanged. ` +
    `The plan record labels both generation prompts as not executed. ${SOURCE_FRAME_DISCLOSURE} ${RELEASE_GOVERNOR_DISCLOSURE}`;
  const checked = validateDraft(envelope, options.now ?? new Date(), readable, undefined, options.frames);
  if (!checked.ok) return { ok: false, errors: checked.errors };
  if (canonical(checked.value.artifact) !== canonical(plan)) return { ok: false, errors: ["The handoff would not carry the stored plan byte-for-byte."] };
  const block = "```" + HANDOFF_FENCE + "\n" + JSON.stringify(envelope, null, 2) + "\n```";
  return { ok: true, value: { draftContent: `${readable}\n\n${block}`, envelope } };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Persists a Release Governor review for the pinned plan only when it is an
 * approve-for-human-review whose preview-visual-quality check passes and whose
 * preview evidence, recomputed now, still passes for the pinned asset,
 * checksum, and visual review, with the plan, case, and review count still as
 * pinned. Then saveGovernorReview applies every existing rule. Otherwise, or on
 * any error, nothing is written.
 */
export async function guardedSaveGovernorReview(deps: DeliveryDeps, pin: DeliveryPin, envelope: unknown): Promise<Result<{ reviewId: string }>> {
  try {
    const env = isObj(envelope) ? envelope : {};
    const review = isObj(env.artifact) ? env.artifact : {};
    const subject = isObj(review.subject) ? review.subject : {};
    const preview = isObj(review.preview) ? review.preview : {};
    if (env.senderRole !== "release-governor" || env.decision !== "approve-for-human-review" || review.kind !== "governor-review" || review.decision !== "approve-for-human-review") {
      return { ok: false, errors: ["Only a Release Governor approve-for-human-review is persisted in this delivery."] };
    }
    if (env.caseId !== pin.caseId || env.artifactId !== pin.planId || review.caseId !== pin.caseId || subject.planId !== pin.planId) {
      return { ok: false, errors: ["The review is not for the pinned case and plan."] };
    }
    const checks = Array.isArray(review.checks) ? review.checks.filter(isObj) : [];
    if (!checks.some((c) => c.id === "preview-visual-quality" && c.category === "technical" && c.outcome === "pass")) {
      return { ok: false, errors: ["The review has no passing preview-visual-quality technical check."] };
    }
    // Recompute everything immediately before the write.
    const pre = await preflightGovernorDelivery(deps, pin);
    if (!pre.ok) return pre;
    const asset = await deps.store.getMediaAsset(pin.previewAssetId);
    const registered = await deps.workflow.loadGeneratedPreview(pin.planId);
    if (!asset || preview.status !== "provided" || preview.assetRef !== asset.storage_ref || !registered.ok || registered.value.assetId !== pin.previewAssetId) {
      return { ok: false, errors: ["The review does not name the pinned registered preview."] };
    }
    return await deps.workflow.saveGovernorReview(envelope);
  } catch (error) {
    return { ok: false, errors: [`The review was not persisted: ${error instanceof Error ? error.name : "unknown error"}.`] };
  }
}
