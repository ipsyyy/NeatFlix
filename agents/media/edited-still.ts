import { createHash } from "node:crypto";
import { PRIVATE_STORAGE_REF, SHA256, type SourceFrameRecord } from "@/agents/handoff/source-frames";
import type { MediaAssetRow, WorkflowStore } from "@/agents/persistence/store";
import { validateMediaRow, type WorkflowRegistry } from "@/agents/persistence/workflow";

/**
 * Edited stills: one provider image edit of a registered source frame, using
 * the exact persisted stillImageEdit prompt of an immutable placement plan.
 * Execution is recorded only on this media record; the plan never changes.
 */

export const EDITED_STILL_WIDTH = 1280;
export const EDITED_STILL_HEIGHT = 720;
export const STILL_PROMPT_FIELD = "prompts.stillImageEdit.prompt";
export const EDITED_STILL_ORIGIN = "gemini-image-edit";
export const GEMINI_GENERATOR = "google-gemini";
/** How a provider image became the stored 1280×720 PNG. */
export const NORMALIZATION_METHODS = ["none", "png-reencode", "lanczos3-resize-to-1280x720-png", "lanczos3-uniform-scale-center-crop-to-1280x720-png"] as const;
export type NormalizationMethod = (typeof NORMALIZATION_METHODS)[number];
export const NEAR_16_9_METHOD = "lanczos3-uniform-scale-center-crop-to-1280x720-png" satisfies NormalizationMethod;

/** Most a provider image's aspect ratio may differ from exact 16:9, as a fraction of 16:9. */
export const ASPECT_TOLERANCE = 0.01;
/** Most of either dimension a centered crop may remove, as a fraction of that dimension. */
export const CROP_LIMIT = 0.01;

export type Rect = { left: number; top: number; width: number; height: number };
export type Edges = { left: number; right: number; top: number; bottom: number };

/** Normalization record. Crop details are present only for the near-16:9 method. */
export type NormalizationRecord = {
  method: NormalizationMethod;
  tool: string;
  /** SHA-256 of the provider's image bytes as returned, before any processing. */
  originalSha256: string;
  /** |w/h − 16/9| ÷ (16/9). */
  aspectRatioDifference: number;
  scale: { factor: number; scaledWidth: number; scaledHeight: number } | null;
  crop: { scaled: Rect; original: Rect; removedScaled: Edges; removedOriginal: Edges } | null;
};

export type EditedStillProvenance = {
  origin: typeof EDITED_STILL_ORIGIN;
  executionStatus: "completed";
  planId: string;
  caseId: string;
  sourceFrameAssetId: string;
  sourceFrameStorageRef: string;
  sourceFrameChecksum: string;
  sourceFrameTimestampSeconds: number;
  promptField: typeof STILL_PROMPT_FIELD;
  promptSha256: string;
  provider: typeof GEMINI_GENERATOR;
  model: string;
  /** The provider's interaction ID when it supplies one; null only when it does not. */
  responseId: string | null;
  generatedAt: string;
  latencyMs: number;
  costUsd: number | null;
  /** Required when costUsd is null: why no cost is recorded. */
  costBasis: string;
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null } | null;
  originalResolution: { width: number; height: number; mimeType: string };
  finalResolution: { width: typeof EDITED_STILL_WIDTH; height: typeof EDITED_STILL_HEIGHT };
  normalization: NormalizationRecord;
  outputChecksum: string;
  humanVisualReview: "pending";
};

/** What an edited still must be bound to: the case, plan, revalidated source frame, prompt hash, and model. */
export type EditedStillContext = {
  caseId: string;
  planId: string;
  sourceFrame: SourceFrameRecord;
  promptSha256: string;
  model?: string;
  storageRef?: string;
};

export const sha256Hex = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIso = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v));
const sameInstant = (a: unknown, b: unknown) => isIso(a) && isIso(b) && Date.parse(String(a)) === Date.parse(String(b));
const posInt = (v: unknown) => Number.isInteger(v) && (v as number) > 0;

/** Validates an edited-still media row against the plan, frame, and prompt it must be bound to. */
export function validateEditedStill(row: unknown, ctx: EditedStillContext): string[] {
  const e = validateMediaRow(row);
  if (!isObj(row)) return e;
  if (row.kind !== "edited-still") e.push("kind must be edited-still.");
  if (row.mime_type !== "image/png") e.push("An edited still is stored as image/png.");
  if (row.case_id !== ctx.caseId) e.push("Edited still belongs to another case.");
  if (row.plan_id !== ctx.planId) e.push("Edited still belongs to another plan.");
  if (typeof row.storage_ref !== "string" || !PRIVATE_STORAGE_REF.test(row.storage_ref)) e.push("Edited still must use a private storage:// reference.");
  if (ctx.storageRef && row.storage_ref !== ctx.storageRef) e.push("Edited still storage reference is not the approved output path.");
  if (row.generator !== GEMINI_GENERATOR) e.push(`generator must be ${GEMINI_GENERATOR}.`);
  if (typeof row.model !== "string" || !row.model.trim()) e.push("model is required.");
  else if (ctx.model && row.model !== ctx.model) e.push("model is not the approved model.");
  if (!isIso(row.generated_at)) e.push("generated_at is required.");
  if (!Number.isInteger(row.latency_ms) || (row.latency_ms as number) < 0) e.push("latency_ms is required.");
  if (row.cost_usd !== null && !(typeof row.cost_usd === "number" && row.cost_usd >= 0)) e.push("cost_usd must be a non-negative number or null.");

  const p = isObj(row.provenance) ? row.provenance : {};
  const f = ctx.sourceFrame;
  if (p.origin !== EDITED_STILL_ORIGIN) e.push(`provenance.origin must be ${EDITED_STILL_ORIGIN}.`);
  if (p.executionStatus !== "completed") e.push('provenance.executionStatus must be "completed".');
  if (p.planId !== ctx.planId || p.caseId !== ctx.caseId) e.push("provenance must name the same case and plan.");
  if (p.sourceFrameAssetId !== f.assetId || p.sourceFrameStorageRef !== f.storageRef || p.sourceFrameChecksum !== f.checksum) {
    e.push("provenance must cite the registered source frame's asset ID, storage reference, and checksum.");
  }
  if (p.sourceFrameTimestampSeconds !== f.timestampSeconds) e.push("provenance.sourceFrameTimestampSeconds does not match the source frame.");
  if (p.promptField !== STILL_PROMPT_FIELD) e.push(`provenance.promptField must be ${STILL_PROMPT_FIELD}.`);
  if (typeof p.promptSha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.promptSha256) || p.promptSha256 !== ctx.promptSha256) {
    e.push("provenance.promptSha256 must be the SHA-256 of the exact persisted prompt.");
  }
  if (p.provider !== GEMINI_GENERATOR || p.model !== row.model) e.push("provenance provider and model must match the row.");
  if (p.responseId !== null && (typeof p.responseId !== "string" || !p.responseId.trim() || p.responseId.length > 300)) e.push("provenance.responseId must be the provider's ID or null.");
  if (!sameInstant(p.generatedAt, row.generated_at)) e.push("provenance.generatedAt must equal generated_at.");
  if (p.latencyMs !== row.latency_ms) e.push("provenance.latencyMs must equal latency_ms.");
  if (p.costUsd !== row.cost_usd) e.push("provenance.costUsd must equal cost_usd.");
  if (row.cost_usd === null && (typeof p.costBasis !== "string" || p.costBasis.trim().length < 10)) e.push("A null cost needs an explicit provenance.costBasis.");
  const orig = isObj(p.originalResolution) ? p.originalResolution : {};
  const fin = isObj(p.finalResolution) ? p.finalResolution : {};
  if (fin.width !== EDITED_STILL_WIDTH || fin.height !== EDITED_STILL_HEIGHT) e.push("provenance.finalResolution must be 1280×720.");
  const norm = isObj(p.normalization) ? p.normalization : {};
  if (!posInt(orig.width) || !posInt(orig.height) || typeof orig.mimeType !== "string") e.push("provenance.originalResolution needs width, height, and mimeType.");
  else e.push(...validateNormalization(norm, orig.width as number, orig.height as number, String(orig.mimeType)));
  if (typeof row.checksum !== "string" || !SHA256.test(row.checksum) || p.outputChecksum !== row.checksum) e.push("provenance.outputChecksum must equal the row checksum.");
  if (p.humanVisualReview !== "pending") e.push('provenance.humanVisualReview must be "pending".');
  return e;
}

/** |w/h − 16/9| ÷ (16/9). */
export function aspectDifference(width: number, height: number): number {
  return Math.abs(width / height - 16 / 9) / (16 / 9);
}

/** Checks a normalization record is consistent with the provider image it describes. */
export function validateNormalization(norm: Record<string, unknown>, width: number, height: number, mimeType: string): string[] {
  const e: string[] = [];
  const method = norm.method as NormalizationMethod;
  if (!NORMALIZATION_METHODS.includes(method) || typeof norm.tool !== "string" || !norm.tool.trim()) return ["provenance.normalization needs a known method and tool."];
  if (typeof norm.originalSha256 !== "string" || !/^[0-9a-f]{64}$/.test(norm.originalSha256)) e.push("provenance.normalization.originalSha256 is required.");
  const diff = aspectDifference(width, height);
  if (typeof norm.aspectRatioDifference !== "number" || Math.abs(norm.aspectRatioDifference - diff) > 1e-12) e.push("provenance.normalization.aspectRatioDifference does not match the original resolution.");
  const exact = width * 9 === height * 16;
  if (method !== NEAR_16_9_METHOD) {
    if (!exact) e.push(`Normalization "${method}" requires an exactly 16:9 original.`);
    if (norm.scale !== null || norm.crop !== null) e.push(`Normalization "${method}" records no scale or crop.`);
    if (method === "none" && (width !== EDITED_STILL_WIDTH || height !== EDITED_STILL_HEIGHT || mimeType !== "image/png")) e.push('Normalization "none" is only valid for a 1280×720 PNG.');
    if (method === "png-reencode" && (width !== EDITED_STILL_WIDTH || height !== EDITED_STILL_HEIGHT)) e.push('Normalization "png-reencode" is only valid at 1280×720.');
    return e;
  }
  if (exact) e.push("An exactly 16:9 original is resized, not cropped.");
  if (diff > ASPECT_TOLERANCE) e.push("The original is outside the 16:9 tolerance.");
  const scale = isObj(norm.scale) ? norm.scale : {};
  const crop = isObj(norm.crop) ? norm.crop : {};
  const sw = scale.scaledWidth as number;
  const sh = scale.scaledHeight as number;
  if (!posInt(sw) || !posInt(sh) || sw * height !== sh * width || typeof scale.factor !== "number" || Math.abs((scale.factor as number) - sh / height) > 1e-12) {
    e.push("provenance.normalization.scale must be one uniform factor to whole pixels.");
    return e;
  }
  if (Math.min(sw - EDITED_STILL_WIDTH, sh - EDITED_STILL_HEIGHT) !== 0 || sw < EDITED_STILL_WIDTH || sh < EDITED_STILL_HEIGHT) e.push("The scaled image must cover 1280×720 exactly on one axis.");
  const r = isObj(crop.scaled) ? crop.scaled : {};
  const rem = isObj(crop.removedScaled) ? crop.removedScaled : {};
  const ex = sw - EDITED_STILL_WIDTH;
  const ey = sh - EDITED_STILL_HEIGHT;
  const left = Math.floor(ex / 2);
  const top = Math.floor(ey / 2);
  if (r.left !== left || r.top !== top || r.width !== EDITED_STILL_WIDTH || r.height !== EDITED_STILL_HEIGHT) e.push("The crop must be the centered 1280×720 rectangle.");
  if (rem.left !== left || rem.right !== ex - left || rem.top !== top || rem.bottom !== ey - top) e.push("provenance must record the pixels removed from every edge.");
  if (ex / sw > CROP_LIMIT || ey / sh > CROP_LIMIT) e.push("The crop removes more than 1% of a dimension.");
  if (!isObj(crop.original) || !isObj(crop.removedOriginal)) e.push("provenance must record the crop in original pixels.");
  return e;
}

/**
 * Loads an edited still and revalidates it against the immutable plan it names,
 * that plan's registered source-frame binding, and the plan's exact prompt.
 */
export async function loadVerifiedEditedStill(
  workflow: WorkflowRegistry,
  store: WorkflowStore,
  assetId: string,
): Promise<{ ok: true; row: MediaAssetRow; context: EditedStillContext } | { ok: false; errors: string[] }> {
  const row = await store.getMediaAsset(assetId);
  if (!row) return { ok: false, errors: [`No edited still is registered as ${assetId}.`] };
  if (!row.plan_id) return { ok: false, errors: ["Edited still has no plan."] };
  const context = await editContextFor(workflow, row.plan_id);
  if (!context.ok) return context;
  const errors = validateEditedStill(row, context.value);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, row, context: context.value };
}

/** The binding context for a plan: its case, revalidated source frame, and exact still prompt. */
export async function editContextFor(
  workflow: WorkflowRegistry,
  planId: string,
): Promise<{ ok: true; value: EditedStillContext & { prompt: string } } | { ok: false; errors: string[] }> {
  const plan = await workflow.loadPlan(planId);
  if (!plan.ok) return { ok: false, errors: plan.errors };
  const media = plan.value.sourceMedia;
  if (media.kind !== "registered-source-frame") return { ok: false, errors: ["The plan is not bound to a registered source frame."] };
  const frame = await workflow.loadSourceFrame(media.assetId);
  if (!frame.ok) return { ok: false, errors: frame.errors };
  if (frame.value.storageRef !== media.storageRef || frame.value.checksum !== media.checksum || frame.value.caseId !== plan.value.caseId) {
    return { ok: false, errors: ["The plan's source-frame binding does not match the registry."] };
  }
  const prompt = plan.value.prompts.stillImageEdit.prompt;
  return { ok: true, value: { caseId: plan.value.caseId, planId, sourceFrame: frame.value, promptSha256: sha256Hex(prompt), prompt } };
}
