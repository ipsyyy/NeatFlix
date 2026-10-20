import { randomUUID } from "node:crypto";
import type { ApprovalSender } from "@/agents/handoff/human-approval";
import type { PrivateStorage } from "@/agents/persistence/private-storage";
import { DuplicateRecordError, type MediaAssetRow, type VisualReviewDecision, type VisualReviewRow, type WorkflowStore } from "@/agents/persistence/store";
import type { WorkflowRegistry } from "@/agents/persistence/workflow";
import { loadVerifiedEditedStill } from "./edited-still";
import { GENERATED_PREVIEW_ASSET_ID, loadVerifiedGeneratedPreview } from "./generated-preview";
import { FULL_SCENE_ASSET_ID, LUV_V4_RUNWAY, loadVerifiedFullScene, type FullSceneRequest } from "./runway-full-scene";

/**
 * Human visual review of a media asset (§7.3: human review owns the final
 * visual decision): a versioned edited still, generated preview, or full-scene
 * video. One append-only review per asset, from the human owner only. The
 * asset's own record is never changed: its provenance keeps the review status
 * it had at generation, and this review is the current decision.
 *
 * "approved-with-limitation" accepts the asset while recording, verbatim, the
 * visible limitations the owner disclosed; it never counts as a plain
 * "approved" anywhere that requires one.
 */

export type VisualDecision = VisualReviewDecision;
const DECISIONS: readonly VisualDecision[] = ["approved", "approved-with-limitation", "rejected"];
const MAX_REASONS = 10;
const MAX_REASON_LENGTH = 500;

export async function recordVisualReview(options: {
  workflow: WorkflowRegistry;
  store: WorkflowStore;
  /** Required to review a generated preview or full-scene video: its private bytes are revalidated. */
  storage?: PrivateStorage;
  /** The full-scene attempt contract to revalidate against; defaults to the accepted v4 Runway attempt. */
  fullScene?: FullSceneRequest;
  assetId: string;
  decision: VisualDecision;
  reasons: string[];
  /** Required, and only allowed, with "approved-with-limitation". */
  limitations?: string[];
  reviewer: ApprovalSender & { name: string };
  ownerUserId: string;
}): Promise<{ ok: true; status: "created" | "existing"; review: VisualReviewRow } | { ok: false; errors: string[] }> {
  const { reviewer, decision } = options;
  const errors: string[] = [];
  if (reviewer.type !== "User" || reviewer.role !== null) errors.push("Only a human user can record a visual review.");
  if (!options.ownerUserId || reviewer.id !== options.ownerUserId) errors.push("Only the human owner can record a visual review.");
  if (!reviewer.name?.trim() || reviewer.name.length > 200) errors.push("The reviewer must be named.");
  if (!DECISIONS.includes(decision)) errors.push('decision must be "approved", "approved-with-limitation", or "rejected".');
  if (!isReviewableAssetId(options.assetId)) errors.push("Only a versioned edited-still, generated-preview, or full-scene-video asset can be reviewed.");
  const reasons = options.reasons.map((r) => r.trim());
  if (reasons.length > MAX_REASONS || reasons.some((r) => r.length === 0 || r.length > MAX_REASON_LENGTH)) errors.push("Each reason must be non-empty and at most 500 characters.");
  if (decision === "rejected" && reasons.length === 0) errors.push("A rejection must state its reasons.");
  // Limitations are recorded exactly as given: never trimmed, rewritten, or deduplicated.
  const limitations = options.limitations ?? [];
  if (limitations.length > MAX_REASONS || limitations.some((l) => l.trim().length === 0 || l !== l.trim() || l.length > MAX_REASON_LENGTH)) errors.push("Each limitation must be non-empty, untrimmed text of at most 500 characters.");
  if (decision === "approved-with-limitation" && limitations.length === 0) errors.push("An approval with limitation must state the limitation.");
  if (decision !== "approved-with-limitation" && limitations.length > 0) errors.push('Only "approved-with-limitation" may record limitations.');
  if (errors.length > 0) return { ok: false, errors };

  // The asset must revalidate against everything it is bound to before it can be reviewed.
  const verified = await loadReviewableAsset(options, options.assetId);
  if (!verified.ok) return { ok: false, errors: ["The asset is not a valid registered reviewable asset.", ...verified.errors] };
  const asset = verified.row;

  const same = (r: VisualReviewRow) =>
    r.decision === decision &&
    r.asset_checksum === asset.checksum &&
    r.reviewer_user_id === reviewer.id &&
    JSON.stringify(r.reasons) === JSON.stringify(reasons) &&
    JSON.stringify(r.limitations ?? []) === JSON.stringify(limitations);
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
      ...(limitations.length > 0 ? { limitations } : {}),
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

/** Versioned edited-still asset IDs: asset:<title>:edited-still:<scene>:v<n>. */
export const EDITED_STILL_ASSET_ID = /^asset:[a-z0-9-]+:edited-still:[a-z0-9-]+:v[0-9]+$/;
export const isReviewableAssetId = (id: string) => EDITED_STILL_ASSET_ID.test(id) || GENERATED_PREVIEW_ASSET_ID.test(id) || FULL_SCENE_ASSET_ID.test(id);

/**
 * A reviewable asset, revalidated by its kind: an edited still against its plan,
 * frame, and prompt; a generated preview against its plan, approved source
 * still, generator contract, and private bytes.
 */
export async function loadReviewableAsset(
  deps: { workflow: WorkflowRegistry; store: WorkflowStore; storage?: PrivateStorage; fullScene?: FullSceneRequest },
  assetId: string,
): Promise<{ ok: true; row: MediaAssetRow } | { ok: false; errors: string[] }> {
  if (EDITED_STILL_ASSET_ID.test(assetId)) return loadVerifiedEditedStill(deps.workflow, deps.store, assetId);
  if (GENERATED_PREVIEW_ASSET_ID.test(assetId)) {
    if (!deps.storage) return { ok: false, errors: ["Reviewing a generated preview requires its private storage."] };
    return loadVerifiedGeneratedPreview(deps.workflow, deps.store, deps.storage, assetId);
  }
  if (FULL_SCENE_ASSET_ID.test(assetId)) {
    if (!deps.storage) return { ok: false, errors: ["Reviewing a full-scene video requires its private storage."] };
    // Only the pinned, accepted attempt has a revalidation contract.
    const req = deps.fullScene ?? LUV_V4_RUNWAY;
    if (assetId !== req.outputAssetId) return { ok: false, errors: [`${assetId} is not a known full-scene video.`] };
    const verified = await loadVerifiedFullScene({ workflow: deps.workflow, store: deps.store, storage: deps.storage }, req);
    return verified.ok ? { ok: true, row: verified.row } : verified;
  }
  return { ok: false, errors: ["Only a versioned edited-still, generated-preview, or full-scene-video asset can be reviewed."] };
}

export type ReviewArgs = { assetId: string; decision: VisualDecision; reasons: string[]; limitations: string[]; record: boolean };

/**
 * Parses the review command's explicit arguments:
 *   --asset=<reviewable asset ID> --decision=rejected|approved|approved-with-limitation --reason=<text> (repeatable)
 *   [--limitation=<text> (repeatable; only with approved-with-limitation)] [--record=<same asset ID>]
 * Writing requires --record to repeat the exact asset ID, so a review can never
 * be recorded for an asset other than the one named.
 */
export function parseReviewArgs(argv: readonly string[]): { ok: true; value: ReviewArgs } | { ok: false; errors: string[] } {
  const value = (name: string) => argv.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
  const errors: string[] = [];
  const assets = value("asset");
  const decisions = value("decision");
  const records = value("record");
  if (assets.length !== 1 || !isReviewableAssetId(assets[0])) errors.push("Pass exactly one --asset=<edited-still, generated-preview, or full-scene-video asset ID>.");
  if (decisions.length !== 1 || !DECISIONS.includes(decisions[0] as VisualDecision)) errors.push("Pass exactly one --decision=rejected, approved, or approved-with-limitation.");
  if (records.length > 1 || (records.length === 1 && records[0] !== assets[0])) errors.push("--record must repeat the exact --asset ID.");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { assetId: assets[0], decision: decisions[0] as VisualDecision, reasons: value("reason"), limitations: value("limitation"), record: records.length === 1 } };
}
