import sharp, { type Metadata } from "sharp";
import type { MediaAssetRow, WorkflowStore } from "@/agents/persistence/store";
import type { PrivateStorage } from "@/agents/persistence/private-storage";
import type { WorkflowRegistry } from "@/agents/persistence/workflow";
import {
  ASPECT_TOLERANCE,
  CROP_LIMIT,
  EDITED_STILL_HEIGHT,
  NEAR_16_9_METHOD,
  aspectDifference,
  type NormalizationRecord,
  EDITED_STILL_ORIGIN,
  EDITED_STILL_WIDTH,
  GEMINI_GENERATOR,
  STILL_PROMPT_FIELD,
  editContextFor,
  loadVerifiedEditedStill,
  sha256Hex,
  validateEditedStill,
  type EditedStillProvenance,
  type NormalizationMethod,
} from "./edited-still";
import { ProviderError, type ImageEditProvider } from "./gemini-provider";

/**
 * Executes exactly one approved still edit for a persisted placement plan:
 * verify the immutable plan and its registered source frame, send the frame's
 * verified pixels and the exact persisted prompt to the provider, accept exactly
 * one 16:9 image, normalize it to a 1280×720 PNG without cropping, upload it
 * privately without overwriting, and register it as a separate edited-still
 * asset. The plan is never modified. Every step fails closed.
 */

export const SHARP_TOOL = "sharp@0.35.5";
const ACCEPTED_INPUT_FORMATS = new Set(["png", "jpeg", "webp"]);
const MAX_PROVIDER_DIMENSION = 8192;

export type StillEditRequest = {
  planId: string;
  sourceFrameAssetId: string;
  sourceFrameStorageRef: string;
  outputAssetId: string;
  outputStorageRef: string;
};

export type StillEditDeps = {
  workflow: WorkflowRegistry;
  store: WorkflowStore;
  storage: PrivateStorage;
  provider: ImageEditProvider;
  timeoutMs?: number;
  clock?: () => Date;
};

export type StillEditResult =
  | { ok: true; status: "created" | "reused"; assetId: string; checksum: string; normalization: NormalizationMethod; originalResolution: { width: number; height: number } }
  | { ok: false; stage: string; errors: string[] };

const stop = (stage: string, ...errors: string[]): StillEditResult => ({ ok: false, stage, errors });

export type NormalizedStill = {
  ok: true;
  png: Buffer;
  original: { width: number; height: number; mimeType: string };
  method: NormalizationMethod;
  normalization: NormalizationRecord;
};

const PNG_OPTIONS = { compressionLevel: 9, adaptiveFiltering: false, palette: false } as const;

/**
 * Normalizes a provider image to a 1280×720 PNG, deterministically and without
 * any stretch:
 * - 1280×720 PNG: kept byte-for-byte. 1280×720 JPEG/WebP: re-encoded to PNG.
 * - Any other exact 16:9 size: Lanczos3 resize to 1280×720 (uniform by construction).
 * - Near 16:9 (|w/h − 16/9| ÷ 16/9 ≤ 1%): one uniform Lanczos3 scale so the image
 *   covers 1280×720 exactly on one axis — accepted only when that scale lands on
 *   whole pixels — then a centered 1280×720 crop (an odd excess puts the extra
 *   pixel on the right/bottom), removing at most 1% of either dimension.
 * - Anything else is rejected, never cropped further or stretched.
 */
export async function normalizeToStill(data: Uint8Array): Promise<NormalizedStill | { ok: false; error: string }> {
  let meta: Metadata;
  try {
    meta = await sharp(data, { failOn: "error" }).metadata();
  } catch {
    return { ok: false, error: "Provider image could not be decoded." };
  }
  const { width, height, format } = meta;
  if (!width || !height || !format || !ACCEPTED_INPUT_FORMATS.has(format)) return { ok: false, error: "Provider image is not a decodable PNG, JPEG, or WebP." };
  if (width > MAX_PROVIDER_DIMENSION || height > MAX_PROVIDER_DIMENSION) return { ok: false, error: "Provider image is too large." };
  const original = { width, height, mimeType: `image/${format}` };
  const aspect = aspectDifference(width, height);
  if (aspect > ASPECT_TOLERANCE) {
    return { ok: false, error: `Provider image is ${width}×${height}, ${(aspect * 100).toFixed(2)}% from 16:9 (limit ${ASPECT_TOLERANCE * 100}%); rejected rather than cropped or stretched.` };
  }
  const base = { tool: SHARP_TOOL, originalSha256: sha256Hex(data), aspectRatioDifference: aspect, scale: null, crop: null };
  const exact = width * 9 === height * 16;
  const finish = async (png: Buffer, method: NormalizationMethod, normalization: NormalizationRecord): Promise<NormalizedStill | { ok: false; error: string }> => {
    const out = await sharp(png).metadata();
    if (out.width !== EDITED_STILL_WIDTH || out.height !== EDITED_STILL_HEIGHT || out.format !== "png") return { ok: false, error: "Normalized image is not a 1280×720 PNG." };
    return { ok: true, png, original, method, normalization };
  };

  if (exact) {
    if (width === EDITED_STILL_WIDTH && height === EDITED_STILL_HEIGHT && format === "png") return finish(Buffer.from(data), "none", { method: "none", ...base });
    const at720 = width === EDITED_STILL_WIDTH && height === EDITED_STILL_HEIGHT;
    const method: NormalizationMethod = at720 ? "png-reencode" : "lanczos3-resize-to-1280x720-png";
    const pipeline = sharp(data, { failOn: "error" });
    const png = await (at720 ? pipeline : pipeline.resize(EDITED_STILL_WIDTH, EDITED_STILL_HEIGHT, { fit: "fill", kernel: "lanczos3" })).png(PNG_OPTIONS).toBuffer();
    return finish(png, method, { method, ...base });
  }

  // Near 16:9: one uniform scale to cover 1280×720, which must land on whole pixels.
  const wider = width * EDITED_STILL_HEIGHT > height * EDITED_STILL_WIDTH;
  const scaledWidth = wider ? (width * EDITED_STILL_HEIGHT) / height : EDITED_STILL_WIDTH;
  const scaledHeight = wider ? EDITED_STILL_HEIGHT : (height * EDITED_STILL_WIDTH) / width;
  if (!Number.isInteger(scaledWidth) || !Number.isInteger(scaledHeight)) {
    return { ok: false, error: `Provider image ${width}×${height} cannot be scaled uniformly to whole pixels; it cannot be normalized deterministically.` };
  }
  const factor = scaledHeight / height;
  const excessX = scaledWidth - EDITED_STILL_WIDTH;
  const excessY = scaledHeight - EDITED_STILL_HEIGHT;
  if (excessX / scaledWidth > CROP_LIMIT || excessY / scaledHeight > CROP_LIMIT) return { ok: false, error: "The centered crop would remove more than 1% of a dimension." };
  const left = Math.floor(excessX / 2);
  const top = Math.floor(excessY / 2);
  const removedScaled = { left, right: excessX - left, top, bottom: excessY - top };
  const scaledRect = { left, top, width: EDITED_STILL_WIDTH, height: EDITED_STILL_HEIGHT };
  const o = (v: number) => v / factor;
  const normalization: NormalizationRecord = {
    method: NEAR_16_9_METHOD,
    ...base,
    scale: { factor, scaledWidth, scaledHeight },
    crop: {
      scaled: scaledRect,
      original: { left: o(left), top: o(top), width: o(EDITED_STILL_WIDTH), height: o(EDITED_STILL_HEIGHT) },
      removedScaled,
      removedOriginal: { left: o(removedScaled.left), right: o(removedScaled.right), top: o(removedScaled.top), bottom: o(removedScaled.bottom) },
    },
  };
  const scaled = await sharp(data, { failOn: "error" }).resize(scaledWidth, scaledHeight, { fit: "fill", kernel: "lanczos3" }).png(PNG_OPTIONS).toBuffer();
  const png = await sharp(scaled).extract(scaledRect).png(PNG_OPTIONS).toBuffer();
  return finish(png, NEAR_16_9_METHOD, normalization);
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderError(`Provider call timed out after ${ms} ms.`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function executeStillEdit(req: StillEditRequest, deps: StillEditDeps): Promise<StillEditResult> {
  const clock = deps.clock ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? 180_000;

  // 1. The immutable plan, its registered frame binding, and the exact prompt.
  const ctx = await editContextFor(deps.workflow, req.planId);
  if (!ctx.ok) return stop("plan", ...ctx.errors);
  const { sourceFrame, prompt, promptSha256, caseId } = ctx.value;
  if (sourceFrame.assetId !== req.sourceFrameAssetId || sourceFrame.storageRef !== req.sourceFrameStorageRef) {
    return stop("plan", "The plan's source frame is not the approved source frame.");
  }
  const binding = { caseId, planId: req.planId, sourceFrame, promptSha256, storageRef: req.outputStorageRef };

  // 2. Idempotency: reuse an identical registered output; stop on any conflict.
  const existing = await deps.store.getMediaAsset(req.outputAssetId);
  if (existing) {
    const verified = await loadVerifiedEditedStill(deps.workflow, deps.store, req.outputAssetId);
    if (!verified.ok || validateEditedStill(existing, binding).length > 0) return stop("idempotency", `${req.outputAssetId} exists but does not match this plan, frame, and prompt; not overwriting.`);
    const stored = await deps.storage.download(req.outputStorageRef);
    if (!stored || `sha256:${sha256Hex(stored)}` !== existing.checksum) return stop("idempotency", "The registered output's stored object is missing or differs; not regenerating.");
    const prov = existing.provenance as EditedStillProvenance;
    return { ok: true, status: "reused", assetId: req.outputAssetId, checksum: existing.checksum, normalization: prov.normalization.method, originalResolution: { width: prov.originalResolution.width, height: prov.originalResolution.height } };
  }
  const others = await deps.store.listMediaAssetsForPlan(req.planId, "edited-still", 2);
  if (others.length > 0) return stop("idempotency", "Another edited still is already registered for this plan; not creating a second.");
  if (await deps.storage.download(req.outputStorageRef)) return stop("idempotency", "An object already exists at the output path without a registry record; not overwriting.");

  // 3. Verified source pixels.
  const frameBytes = await deps.storage.download(sourceFrame.storageRef);
  if (!frameBytes) return stop("source", "The source frame object is missing.");
  if (`sha256:${sha256Hex(frameBytes)}` !== sourceFrame.checksum) return stop("source", "The source frame bytes do not match the registered checksum.");
  const frameMeta = await sharp(frameBytes).metadata();
  if (frameMeta.width !== EDITED_STILL_WIDTH || frameMeta.height !== EDITED_STILL_HEIGHT || frameMeta.format !== "png") return stop("source", "The source frame is not a 1280×720 PNG.");
  if (sha256Hex(prompt) !== promptSha256) return stop("source", "Prompt hash mismatch.");

  // 4. Exactly one bounded provider call.
  const started = clock();
  let result;
  try {
    result = await withTimeout(deps.provider.edit({ image: frameBytes, mimeType: "image/png", prompt }, { timeoutMs }), timeoutMs);
  } catch (error) {
    return stop("provider", error instanceof ProviderError ? error.message : "Provider call failed.");
  }
  const latencyMs = Math.max(0, clock().getTime() - started.getTime());
  if (result.images.length === 0) return stop("response", result.text ? "Provider returned text without an image." : "Provider returned no image.");
  if (result.images.length > 1) return stop("response", `Provider returned ${result.images.length} images; exactly one is required.`);

  // 5. Exact 16:9, normalized to 1280×720 PNG.
  const normalized = await normalizeToStill(result.images[0].data);
  if (!normalized.ok) return stop("response", normalized.error);
  const checksum = `sha256:${sha256Hex(normalized.png)}`;
  const generatedAt = started.toISOString();

  // 6. The record, validated before anything is stored.
  const provenance: EditedStillProvenance = {
    origin: EDITED_STILL_ORIGIN,
    executionStatus: "completed",
    planId: req.planId,
    caseId,
    sourceFrameAssetId: sourceFrame.assetId,
    sourceFrameStorageRef: sourceFrame.storageRef,
    sourceFrameChecksum: sourceFrame.checksum,
    sourceFrameTimestampSeconds: sourceFrame.timestampSeconds,
    promptField: STILL_PROMPT_FIELD,
    promptSha256,
    provider: GEMINI_GENERATOR,
    model: deps.provider.model,
    responseId: result.responseId,
    generatedAt,
    latencyMs,
    costUsd: null,
    costBasis: "The Gemini Interactions API returns token usage but no price; cost is not computed here. Token usage is recorded.",
    usage: result.usage,
    originalResolution: normalized.original,
    finalResolution: { width: EDITED_STILL_WIDTH, height: EDITED_STILL_HEIGHT },
    normalization: normalized.normalization,
    outputChecksum: checksum,
    humanVisualReview: "pending",
  };
  const row: Omit<MediaAssetRow, "created_at"> = {
    asset_id: req.outputAssetId,
    case_id: caseId,
    plan_id: req.planId,
    kind: "edited-still",
    storage_ref: req.outputStorageRef,
    mime_type: "image/png",
    duration_seconds: null,
    generator: GEMINI_GENERATOR,
    model: deps.provider.model,
    generated_at: generatedAt,
    latency_ms: latencyMs,
    cost_usd: null,
    checksum,
    provenance,
  };
  const problems = validateEditedStill({ ...row, created_at: generatedAt }, binding);
  if (problems.length > 0) return stop("validation", ...problems);

  // 7. Private upload, never overwriting.
  const uploaded = await deps.storage.uploadNew(req.outputStorageRef, normalized.png, "image/png");
  if (uploaded === "exists") {
    const there = await deps.storage.download(req.outputStorageRef);
    if (!there || `sha256:${sha256Hex(there)}` !== checksum) return stop("upload", "A different object appeared at the output path; not overwriting.");
  }

  // 8. Register and read back.
  const registered = await deps.workflow.registerMediaAsset({
    assetId: row.asset_id,
    caseId,
    planId: req.planId,
    kind: "edited-still",
    storageRef: row.storage_ref,
    mimeType: row.mime_type,
    generator: row.generator,
    model: row.model,
    generatedAt,
    latencyMs,
    costUsd: null,
    checksum,
    provenance,
  });
  if (!registered.ok) return stop("register", ...registered.errors);
  const back = await loadVerifiedEditedStill(deps.workflow, deps.store, req.outputAssetId);
  if (!back.ok || back.row.checksum !== checksum) return stop("read-back", ...(back.ok ? ["Read-back checksum differs."] : back.errors));
  return { ok: true, status: "created", assetId: req.outputAssetId, checksum, normalization: normalized.method, originalResolution: { width: normalized.original.width, height: normalized.original.height } };
}
