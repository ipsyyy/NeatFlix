import type { MediaAssetRow, WorkflowStore } from "@/agents/persistence/store";
import type { PrivateStorage } from "@/agents/persistence/private-storage";
import type { WorkflowRegistry } from "@/agents/persistence/workflow";
import { sha256Hex } from "./edited-still";
import { FALLBACK_GENERATOR, validateFallbackRow } from "./fallback-preview";
import { REACTOR_GENERATOR, validateMotionPreview, verifyMotionInputs } from "./motion-preview";

/** Versioned generated-preview asset IDs: asset:<title>:generated-preview:<scene>:v<n>[-<variant>]. */
export const GENERATED_PREVIEW_ASSET_ID = /^asset:[a-z0-9-]+:generated-preview:[a-z0-9-]+:v[0-9]+(-[a-z0-9]+)?$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * Loads a registered generated preview and revalidates it from the bindings its
 * own record claims, without trusting them: the immutable plan and its motion
 * prompt, the source edited still and its approved human visual review of
 * those exact bytes, its generator's exact record contract (a Reactor preview
 * or a disclosed local fallback), and its private stored bytes. Read-only.
 */
export async function loadVerifiedGeneratedPreview(
  workflow: WorkflowRegistry,
  store: WorkflowStore,
  storage: PrivateStorage,
  assetId: string,
): Promise<{ ok: true; row: MediaAssetRow } | { ok: false; errors: string[] }> {
  if (!GENERATED_PREVIEW_ASSET_ID.test(assetId)) return { ok: false, errors: ["Not a versioned generated-preview asset ID."] };
  const row = await store.getMediaAsset(assetId);
  if (!row) return { ok: false, errors: [`No generated preview is registered as ${assetId}.`] };
  if (row.kind !== "generated-preview" || !row.plan_id) return { ok: false, errors: ["The asset is not a generated preview of a plan."] };
  const p = isObj(row.provenance) ? row.provenance : {};
  const still = isObj(p.sourceEditedStill) ? p.sourceEditedStill : {};
  const review = isObj(p.visualReview) ? p.visualReview : {};
  const base = {
    planId: row.plan_id,
    editedStillAssetId: str(still.assetId),
    editedStillStorageRef: str(still.storageRef),
    editedStillChecksum: str(still.checksum),
    visualReviewId: str(review.reviewId),
    motionPromptSha256: str(p.motionPromptSha256),
    outputAssetId: row.asset_id,
    outputStorageRef: row.storage_ref,
  };

  const inputs = await verifyMotionInputs(base, { workflow, store, storage });
  if (!inputs.ok) return { ok: false, errors: [`The preview's ${inputs.stage} binding does not revalidate.`, ...inputs.errors] };

  let errors: string[];
  if (row.generator === FALLBACK_GENERATOR) {
    errors = validateFallbackRow(row, base, inputs.caseId);
    if (!/-fallback$/.test(row.asset_id)) errors.push("A local fallback must carry a …-fallback identity.");
  } else if (row.generator === REACTOR_GENERATOR) {
    const s = isObj(p.settings) ? p.settings : {};
    errors = validateMotionPreview(row, { caseId: inputs.caseId, req: { ...base, seed: Number(s.seed), resolution: str(s.resolution) } });
    if (/-fallback$/.test(row.asset_id)) errors.push("A Reactor preview may not carry a fallback identity.");
  } else {
    errors = ["The preview's generator is not recognised."];
  }
  if (errors.length > 0) return { ok: false, errors };

  const bytes = await storage.download(row.storage_ref);
  if (!bytes || `sha256:${sha256Hex(bytes)}` !== row.checksum) return { ok: false, errors: ["The preview's stored object is missing or differs from its checksum."] };
  return { ok: true, row };
}
