import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { MediaAssetRow, WorkflowStore } from "@/agents/persistence/store";
import type { PrivateStorage } from "@/agents/persistence/private-storage";
import { CHECKSUM, type WorkflowRegistry } from "@/agents/persistence/workflow";
import { EDITED_STILL_HEIGHT, EDITED_STILL_WIDTH, loadVerifiedEditedStill, sha256Hex } from "./edited-still";
import { ProviderError } from "./gemini-provider";
import { PREVIEW_MAX_BYTES, validatePreviewVideo, type VideoMetadata, type VideoProbe } from "./mp4-validate";
import { CLIP_MAX_SECONDS, CLIP_MIN_SECONDS, FRAME_CHUNKS, MAX_CHUNKS, ORBIS_MODEL, type ChunkRecord } from "./reactor-session";

/**
 * Executes exactly one approved Reactor Orbis motion preview for the approved
 * edited still of an immutable placement plan, and registers it as one
 * immutable generated-preview asset. Before any provider connection it
 * revalidates the plan, the edited still's record and stored bytes, its plan
 * binding, and its approved append-only human visual review, and checks the
 * exact persisted motion prompt against its approved hash. A paid attempt is
 * claimed durably first, so no command run can ever make a second one. Every
 * step fails closed; the preview's human review stays pending.
 */

export const REACTOR_GENERATOR = "reactor";
export const MOTION_PREVIEW_ORIGIN = "reactor-orbis-motion-preview";
export const MOTION_PROMPT_FIELD = "prompts.motion.prompt";
export const IMAGE_PREPROCESSING = "none";
/** Container duration may round by up to a few frames against the recording markers. */
export const CLIP_DURATION_TOLERANCE_SECONDS = 0.2;

export type MotionPreviewRequest = {
  planId: string;
  editedStillAssetId: string;
  editedStillStorageRef: string;
  editedStillChecksum: string;
  visualReviewId: string;
  motionPromptSha256: string;
  outputAssetId: string;
  outputStorageRef: string;
  seed: number;
  resolution: string;
};

export type ProviderCostRate = { usdPerSecond: number; source: string; retrievedAt: string };

export type MotionPreviewResult = {
  sessionId: string;
  video: Uint8Array;
  videoMimeType: string;
  requestedClipSeconds: number;
  clip: { kind: string; startMarker: number; endMarker: number; nowMarker: number; predictedReadyInMs: number | null };
  chunks: ChunkRecord[];
  generation: Record<string, unknown>;
  startAcknowledgedBy: string;
  download: { deadlineMs: number; waitMs: number };
  sessionClosedAt: string;
  clipRequestAcknowledgedAt: string;
  imageAccepted: { width: number; height: number };
  availableResolutions: string[];
  commandsSent: string[];
  /** Wall-clock seconds from session ready to terminated, measured by the client. */
  sessionSeconds: number;
  generatedSeconds: number;
  runtime: { sdk: string; bundleSha256: string; browser: string };
};

/**
 * What a failed provider run leaves behind, for billing and audit. Never holds
 * credentials or media: only identifiers, command names, timings, and a
 * redacted error.
 */
export type ProviderRunRecord = {
  errorCategory: string;
  message: string;
  sessionId: string | null;
  commandsSent: string[];
  reachedReady: boolean;
  /** Client-measured seconds from ready to closed; null when ready was reached but the close was not observed. */
  readyToCloseSeconds: number | null;
  generatedSeconds: number;
  resolution: unknown;
  startAcknowledgedBy: string | null;
  /** Clip markers and expected readiness relative to the request; never the clip URL. */
  clip: { kind: string; startMarker: number; endMarker: number; nowMarker: number; predictedReadyInMs: number | null } | null;
  download: { deadlineMs: number | null; waitMs: number | null; outcome: string } | null;
  sessionClosedAt: string | null;
  clipRequestAcknowledgedAt: string | null;
};

/** A provider failure that carries its run record. */
export class ProviderRunError extends ProviderError {
  constructor(message: string, readonly run: ProviderRunRecord) {
    super(message);
    this.name = "ProviderRunError";
  }
}

/** A failed run with its billing estimate, as retained and reported. */
export type FailedRunReport = ProviderRunRecord & { billedSeconds: number | null; estimatedCostUsd: number | null; costRate: ProviderCostRate; costBasis: string; recordedAt: string };

/** One motion preview: the approved still and exact prompt in, one recorded clip out. */
export interface MotionPreviewProvider {
  readonly provider: typeof REACTOR_GENERATOR;
  readonly model: string;
  generate(input: { image: Uint8Array; mimeType: "image/png"; prompt: string; seed: number; resolution: string }, options: { timeoutMs: number }): Promise<MotionPreviewResult>;
}

/** Durable record of paid attempts. A claimed key can never be claimed again. */
export interface AttemptLedger {
  claim(key: string, record: Record<string, unknown>): Promise<"claimed" | "exists">;
  has(key: string): Promise<boolean>;
  /** Retains a claimed attempt's outcome beside its claim, which is never modified. */
  recordOutcome(key: string, record: Record<string, unknown>): Promise<void>;
}

/** A machine-local ledger outside the repository: one exclusively created file per attempt. */
export class FileAttemptLedger implements AttemptLedger {
  constructor(private readonly dir: string) {}
  private file(key: string) {
    return join(this.dir, `${sha256Hex(key)}.json`);
  }
  async claim(key: string, record: Record<string, unknown>) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      await writeFile(this.file(key), JSON.stringify({ key, ...record }, null, 1), { flag: "wx", mode: 0o600 });
      return "claimed" as const;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists" as const;
      throw error;
    }
  }
  async recordOutcome(key: string, record: Record<string, unknown>) {
    await writeFile(join(this.dir, `${sha256Hex(key)}.outcome.json`), JSON.stringify({ key, ...record }, null, 1), { flag: "wx", mode: 0o600 });
  }
  async has(key: string) {
    return readFile(this.file(key)).then(() => true, (e) => ((e as NodeJS.ErrnoException).code === "ENOENT" ? false : Promise.reject(e)));
  }
}

export type MotionPreviewDeps = {
  workflow: WorkflowRegistry;
  store: WorkflowStore;
  storage: PrivateStorage;
  provider: MotionPreviewProvider;
  ledger: AttemptLedger;
  probe: (bytes: Uint8Array) => Promise<VideoProbe>;
  costRate: ProviderCostRate;
  timeoutMs?: number;
  clock?: () => Date;
};

export type MotionPreviewProvenance = {
  origin: typeof MOTION_PREVIEW_ORIGIN;
  executionStatus: "completed";
  generator: typeof REACTOR_GENERATOR;
  provider: typeof REACTOR_GENERATOR;
  model: string;
  inputPlanId: string;
  caseId: string;
  sessionId: string;
  recording: {
    method: "requestClip+downloadClipAsFile";
    kind: string;
    requestedClipSeconds: number;
    startMarker: number;
    endMarker: number;
    nowMarker: number;
    predictedReadyInMs: number | null;
    clipRequestAcknowledgedAt: string;
    sessionClosedBeforeDownload: true;
    downloadDeadlineMs: number;
    /** Time spent retrieving the clip after the session closed (not billed). */
    postCloseWaitMs: number;
    postCloseResult: "downloaded";
  };
  startAcknowledgedBy: string;
  sessionClosedAt: string;
  sourceEditedStill: { assetId: string; storageRef: string; checksum: string };
  visualReview: { reviewId: string; decision: "approved"; assetChecksum: string };
  promptField: typeof MOTION_PROMPT_FIELD;
  motionPromptSha256: string;
  promptPassthrough: true;
  settings: { seed: number; resolution: string; audio: "model default"; framesPerChunk: number; fps: number; maxChunks: number; frameChunks: number };
  imagePreprocessing: { method: typeof IMAGE_PREPROCESSING; input: { width: number; height: number; mimeType: "image/png" }; providerAccepted: { width: number; height: number } };
  chunks: ChunkRecord[];
  commandsSent: string[];
  video: VideoMetadata & { mimeType: "video/mp4" };
  outputChecksum: string;
  generatedAt: string;
  latencyMs: number;
  usage: { sessionSeconds: number; billedSeconds: number; generatedSeconds: number; chunks: number; frameChunks: number };
  costUsd: number;
  costBasis: string;
  costRate: ProviderCostRate;
  runtime: { sdk: string; bundleSha256: string; browser: string };
  humanPreviewReview: "pending";
};

export type MotionPreviewResultSummary =
  | { ok: true; status: "created" | "reused"; assetId: string; checksum: string; durationSeconds: number; width: number; height: number; costUsd: number }
  | { ok: false; stage: string; errors: string[]; run?: FailedRunReport };

const stop = (stage: string, ...errors: string[]): MotionPreviewResultSummary => ({ ok: false, stage, errors });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const COST_BASIS =
  "Reactor bills session time: per second of wall-clock time from ready until the session is terminated (docs.reactor.inc/resources/billing). " +
  "Cost = whole billed seconds (client-measured ready-to-terminated, rounded up) × the per-second USD rate recorded in costRate. " +
  "Reactor has no programmatic usage endpoint yet, so this is an estimate to reconcile with the Reactor Dashboard.";

/** The key under which a request's single paid attempt is claimed. */
export const attemptKey = (req: MotionPreviewRequest) => `${req.planId}|${req.outputAssetId}|${req.motionPromptSha256}`;

export type PreviewBinding = { caseId: string; req: MotionPreviewRequest };

/** Validates a generated-preview row against its exact binding, before writing and after every read. */
export function validateMotionPreview(row: unknown, binding: PreviewBinding): string[] {
  if (!isObj(row)) return ["Preview must be an object."];
  const { req, caseId } = binding;
  const e: string[] = [];
  const p = isObj(row.provenance) ? row.provenance : {};
  const v = isObj(p.video) ? p.video : {};
  if (row.asset_id !== req.outputAssetId || row.kind !== "generated-preview") e.push("Not this request's generated preview.");
  if (row.case_id !== caseId || row.plan_id !== req.planId || p.caseId !== caseId || p.inputPlanId !== req.planId) e.push("Preview is not bound to this case and plan.");
  if (row.storage_ref !== req.outputStorageRef || row.mime_type !== "video/mp4" || v.mimeType !== "video/mp4") e.push("Preview storage reference or type differs.");
  if (row.generator !== REACTOR_GENERATOR || p.generator !== REACTOR_GENERATOR || p.provider !== REACTOR_GENERATOR || row.model !== ORBIS_MODEL || p.model !== ORBIS_MODEL) e.push("Preview provider or model differs.");
  if (p.origin !== MOTION_PREVIEW_ORIGIN || p.executionStatus !== "completed") e.push("Preview origin is not a completed Reactor motion preview.");
  if (typeof row.checksum !== "string" || !CHECKSUM.test(row.checksum) || p.outputChecksum !== row.checksum) e.push("Preview checksum is missing or inconsistent.");
  const still = isObj(p.sourceEditedStill) ? p.sourceEditedStill : {};
  if (still.assetId !== req.editedStillAssetId || still.storageRef !== req.editedStillStorageRef || still.checksum !== req.editedStillChecksum) e.push("Preview is not bound to the approved edited still.");
  const review = isObj(p.visualReview) ? p.visualReview : {};
  if (review.reviewId !== req.visualReviewId || review.decision !== "approved" || review.assetChecksum !== req.editedStillChecksum) e.push("Preview is not bound to the approved visual review.");
  if (p.promptField !== MOTION_PROMPT_FIELD || p.motionPromptSha256 !== req.motionPromptSha256 || p.promptPassthrough !== true) e.push("Preview is not bound to the approved motion prompt.");
  const s = isObj(p.settings) ? p.settings : {};
  if (s.seed !== req.seed || s.resolution !== req.resolution || s.maxChunks !== MAX_CHUNKS || s.frameChunks !== FRAME_CHUNKS) e.push("Preview settings differ from the request.");
  const pre = isObj(p.imagePreprocessing) ? p.imagePreprocessing : {};
  if (pre.method !== IMAGE_PREPROCESSING) e.push("Preview image preprocessing is not recorded as none.");
  const rec = isObj(p.recording) ? p.recording : {};
  const clipSeconds = rec.requestedClipSeconds;
  if (typeof p.sessionId !== "string" || !p.sessionId || rec.method !== "requestClip+downloadClipAsFile" || !(typeof clipSeconds === "number" && clipSeconds >= CLIP_MIN_SECONDS && clipSeconds <= CLIP_MAX_SECONDS)) e.push("Preview recording provenance is incomplete.");
  const d = v.durationSeconds;
  if (!(typeof d === "number" && Number.isFinite(d) && d >= CLIP_MIN_SECONDS && d <= CLIP_MAX_SECONDS) || Number(row.duration_seconds) !== d) e.push("Preview duration is missing or outside 3–5 seconds.");
  if (!(typeof v.width === "number" && typeof v.height === "number" && Math.abs(v.width / v.height / (16 / 9) - 1) <= 0.01)) e.push("Preview is not 16:9.");
  const chunks = Array.isArray(p.chunks) ? p.chunks.filter(isObj) : [];
  if (chunks.length < FRAME_CHUNKS || chunks.length > MAX_CHUNKS || chunks.filter((c) => Number(c.framesEmitted) > 0).length !== FRAME_CHUNKS) e.push("Preview chunk record is not one optional warm-up plus two frame-bearing chunks.");
  if (!(typeof p.costUsd === "number" && p.costUsd >= 0) || Number(row.cost_usd) !== p.costUsd || typeof p.costBasis !== "string" || !isObj(p.costRate)) e.push("Preview cost and its basis are missing.");
  if (!(Number.isInteger(p.latencyMs) && row.latency_ms === p.latencyMs)) e.push("Preview latency is missing or inconsistent.");
  if (p.generatedAt !== row.generated_at && new Date(String(p.generatedAt)).getTime() !== new Date(String(row.generated_at)).getTime()) e.push("Preview generation time is inconsistent.");
  if (p.humanPreviewReview !== "pending") e.push("A generated preview's human review must start pending.");
  return e;
}

/** The registered preview for a request, revalidated against its binding and stored bytes. */
export async function loadVerifiedMotionPreview(deps: Pick<MotionPreviewDeps, "store" | "storage">, binding: PreviewBinding): Promise<{ ok: true; row: MediaAssetRow } | { ok: false; errors: string[] }> {
  const row = await deps.store.getMediaAsset(binding.req.outputAssetId);
  if (!row) return { ok: false, errors: [`No preview is registered as ${binding.req.outputAssetId}.`] };
  const errors = validateMotionPreview(row, binding);
  if (errors.length > 0) return { ok: false, errors };
  const bytes = await deps.storage.download(row.storage_ref);
  if (!bytes || `sha256:${sha256Hex(bytes)}` !== row.checksum) return { ok: false, errors: ["The registered preview's stored object is missing or differs."] };
  return { ok: true, row };
}

/** Verified inputs for a request: everything checked before any provider connection. Read-only. */
export async function verifyMotionInputs(req: MotionPreviewRequest, deps: Pick<MotionPreviewDeps, "workflow" | "store" | "storage">) {
  // 1. The immutable plan and its exact motion prompt.
  const plan = await deps.workflow.loadPlan(req.planId);
  if (!plan.ok) return { ok: false as const, stage: "plan", errors: plan.errors };
  const motion = plan.value.prompts.motion;
  if (motion.target !== "reactor" || motion.status !== "not-executed" || typeof motion.prompt !== "string") return { ok: false as const, stage: "plan", errors: ["The plan's motion prompt is not an unexecuted Reactor instruction."] };
  if (sha256Hex(motion.prompt) !== req.motionPromptSha256) return { ok: false as const, stage: "plan", errors: ["The persisted motion prompt does not match the approved hash."] };
  if (!(motion.durationSeconds >= CLIP_MIN_SECONDS && motion.durationSeconds <= CLIP_MAX_SECONDS)) return { ok: false as const, stage: "plan", errors: ["The plan's motion duration is outside 3–5 seconds."] };
  const caseId = plan.value.caseId;

  // 2. The registered edited still, its plan binding, and its exact record.
  const still = await loadVerifiedEditedStill(deps.workflow, deps.store, req.editedStillAssetId);
  if (!still.ok) return { ok: false as const, stage: "still", errors: still.errors };
  if (still.row.plan_id !== req.planId || still.row.case_id !== caseId) return { ok: false as const, stage: "still", errors: ["The edited still is not bound to this plan and case."] };
  if (still.row.storage_ref !== req.editedStillStorageRef || still.row.checksum !== req.editedStillChecksum) return { ok: false as const, stage: "still", errors: ["The edited still is not the approved still."] };

  // 3. Its approved, append-only human visual review of these exact bytes.
  const review = await deps.store.getVisualReview(req.editedStillAssetId);
  if (!review || review.review_id !== req.visualReviewId) return { ok: false as const, stage: "review", errors: ["The approved visual review is not recorded for this still."] };
  if (review.decision !== "approved" || review.asset_checksum !== still.row.checksum || review.case_id !== caseId) return { ok: false as const, stage: "review", errors: ["The still's visual review is not an approval of these exact bytes."] };

  // 4. The private stored object.
  const bytes = await deps.storage.download(still.row.storage_ref);
  if (!bytes) return { ok: false as const, stage: "still", errors: ["The edited still's stored object is missing."] };
  if (`sha256:${sha256Hex(bytes)}` !== still.row.checksum) return { ok: false as const, stage: "still", errors: ["The edited still's stored bytes do not match its checksum."] };
  const meta = await sharp(bytes).metadata();
  if (meta.width !== EDITED_STILL_WIDTH || meta.height !== EDITED_STILL_HEIGHT || meta.format !== "png") return { ok: false as const, stage: "still", errors: ["The edited still is not a 1280×720 PNG."] };
  return { ok: true as const, caseId, prompt: motion.prompt, image: bytes, review };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderError(`Provider session did not finish within ${Math.round(ms / 1000)} s.`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export async function executeMotionPreview(req: MotionPreviewRequest, deps: MotionPreviewDeps): Promise<MotionPreviewResultSummary> {
  const clock = deps.clock ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? 240_000;

  const inputs = await verifyMotionInputs(req, deps);
  if (!inputs.ok) return stop(inputs.stage, ...inputs.errors);
  const binding: PreviewBinding = { caseId: inputs.caseId, req };

  // Idempotency: reuse the identical registered preview; never a second paid call.
  if (await deps.store.getMediaAsset(req.outputAssetId)) {
    const existing = await loadVerifiedMotionPreview(deps, binding);
    if (!existing.ok) return stop("idempotency", `${req.outputAssetId} exists but does not revalidate; not regenerating.`, ...existing.errors);
    const prov = existing.row.provenance as MotionPreviewProvenance;
    return { ok: true, status: "reused", assetId: req.outputAssetId, checksum: existing.row.checksum, durationSeconds: prov.video.durationSeconds, width: prov.video.width, height: prov.video.height, costUsd: prov.costUsd };
  }
  if ((await deps.store.listMediaAssetsForPlan(req.planId, "generated-preview", 2)).length > 0) return stop("idempotency", "Another generated preview is already registered for this plan; not creating a second.");
  if (await deps.storage.download(req.outputStorageRef)) return stop("idempotency", "An object already exists at the output path without a registry record; not overwriting.");
  const key = attemptKey(req);
  if (await deps.ledger.has(key)) return stop("idempotency", "A paid attempt for this request was already made and did not register a preview; not retrying.");
  const rate = deps.costRate;
  if (!(Number.isFinite(rate?.usdPerSecond) && rate.usdPerSecond >= 0 && rate.source)) return stop("cost", "No documented per-second rate is available; not starting a paid session.");

  // Claim the single attempt durably, then make exactly one bounded provider session.
  const started = clock();
  if ((await deps.ledger.claim(key, { planId: req.planId, outputAssetId: req.outputAssetId, claimedAt: started.toISOString() })) !== "claimed") {
    return stop("idempotency", "A paid attempt for this request was already claimed; not retrying.");
  }
  let result: MotionPreviewResult;
  try {
    result = await withTimeout(deps.provider.generate({ image: inputs.image, mimeType: "image/png", prompt: inputs.prompt, seed: req.seed, resolution: req.resolution }, { timeoutMs }), timeoutMs);
  } catch (error) {
    const message = error instanceof ProviderError ? error.message : "Provider session failed.";
    const run: ProviderRunRecord =
      error instanceof ProviderRunError
        ? error.run
        : { errorCategory: "provider", message, sessionId: null, commandsSent: [], reachedReady: false, readyToCloseSeconds: null, generatedSeconds: 0, resolution: null, startAcknowledgedBy: null, clip: null, download: null, sessionClosedAt: null, clipRequestAcknowledgedAt: null };
    const billedSeconds = !run.reachedReady ? 0 : run.readyToCloseSeconds === null ? null : Math.ceil(run.readyToCloseSeconds);
    const report: FailedRunReport = {
      ...run,
      billedSeconds,
      estimatedCostUsd: billedSeconds === null ? null : Math.round(billedSeconds * rate.usdPerSecond * 1e6) / 1e6,
      costRate: rate,
      costBasis: `${COST_BASIS} A session that never reached ready is not billed.`,
      recordedAt: clock().toISOString(),
    };
    await deps.ledger.recordOutcome(key, { outcome: "failed", ...report }).catch(() => {});
    return { ok: false, stage: "provider", errors: [message], run: report };
  }
  const latencyMs = Math.max(0, clock().getTime() - started.getTime());

  // The output: one decodable 3–5 s 16:9 MP4, nothing trimmed or repaired.
  if (!result || !(result.video instanceof Uint8Array) || result.video.byteLength === 0) return stop("response", "Provider returned no video.");
  if (result.video.byteLength > PREVIEW_MAX_BYTES) return stop("response", "Provider video exceeds the size limit.");
  if (!/^video\/mp4\b/.test(result.videoMimeType)) return stop("response", "Provider video is not MP4.");
  let probe: VideoProbe;
  try {
    probe = await deps.probe(result.video);
  } catch (error) {
    return stop("response", (error as Error)?.message?.slice(0, 300) ?? "The video could not be decoded.");
  }
  const checked = validatePreviewVideo(result.video, probe);
  if (!checked.ok) return stop("response", ...checked.errors);
  const frameChunks = result.chunks.filter((c) => c.framesEmitted > 0).length;
  const framesPerChunk = Number(result.generation.frames_per_chunk);
  const fps = Number(result.generation.fps);
  if (frameChunks !== FRAME_CHUNKS || result.chunks.length > MAX_CHUNKS) return stop("response", "The session did not stop after exactly two frame-bearing chunks.");
  // The decoded video must be the requested recording: its duration matches the clip's marker span.
  const span = result.clip.endMarker - result.clip.startMarker;
  if (!(Number.isFinite(span) && Math.abs(checked.metadata.durationSeconds - span) <= CLIP_DURATION_TOLERANCE_SECONDS)) {
    return stop("response", `The video lasts ${checked.metadata.durationSeconds.toFixed(3)} s but the requested clip spans ${Number.isFinite(span) ? span.toFixed(3) : "?"} s.`);
  }
  if (!(Date.parse(result.sessionClosedAt) <= Date.parse(result.clipRequestAcknowledgedAt) + 30_000)) return stop("response", "The session was not closed right after the clip request.");
  if (!(Number.isFinite(result.sessionSeconds) && result.sessionSeconds > 0)) return stop("response", "The session duration was not measured.");

  const checksum = `sha256:${sha256Hex(result.video)}`;
  const generatedAt = started.toISOString();
  const billedSeconds = Math.ceil(result.sessionSeconds);
  const costUsd = Math.round(billedSeconds * rate.usdPerSecond * 1e6) / 1e6;
  const provenance: MotionPreviewProvenance = {
    origin: MOTION_PREVIEW_ORIGIN,
    executionStatus: "completed",
    generator: REACTOR_GENERATOR,
    provider: REACTOR_GENERATOR,
    model: deps.provider.model,
    inputPlanId: req.planId,
    caseId: inputs.caseId,
    sessionId: result.sessionId,
    recording: {
      method: "requestClip+downloadClipAsFile",
      kind: result.clip.kind,
      requestedClipSeconds: result.requestedClipSeconds,
      startMarker: result.clip.startMarker,
      endMarker: result.clip.endMarker,
      nowMarker: result.clip.nowMarker,
      predictedReadyInMs: result.clip.predictedReadyInMs,
      clipRequestAcknowledgedAt: result.clipRequestAcknowledgedAt,
      sessionClosedBeforeDownload: true,
      downloadDeadlineMs: result.download.deadlineMs,
      postCloseWaitMs: result.download.waitMs,
      postCloseResult: "downloaded",
    },
    startAcknowledgedBy: result.startAcknowledgedBy,
    sessionClosedAt: result.sessionClosedAt,
    sourceEditedStill: { assetId: req.editedStillAssetId, storageRef: req.editedStillStorageRef, checksum: req.editedStillChecksum },
    visualReview: { reviewId: inputs.review.review_id, decision: "approved", assetChecksum: inputs.review.asset_checksum },
    promptField: MOTION_PROMPT_FIELD,
    motionPromptSha256: req.motionPromptSha256,
    promptPassthrough: true,
    settings: { seed: req.seed, resolution: req.resolution, audio: "model default", framesPerChunk, fps, maxChunks: MAX_CHUNKS, frameChunks: FRAME_CHUNKS },
    imagePreprocessing: { method: IMAGE_PREPROCESSING, input: { width: EDITED_STILL_WIDTH, height: EDITED_STILL_HEIGHT, mimeType: "image/png" }, providerAccepted: result.imageAccepted },
    chunks: result.chunks,
    commandsSent: result.commandsSent,
    video: { ...checked.metadata, mimeType: "video/mp4" },
    outputChecksum: checksum,
    generatedAt,
    latencyMs,
    usage: { sessionSeconds: result.sessionSeconds, billedSeconds, generatedSeconds: result.generatedSeconds, chunks: result.chunks.length, frameChunks },
    costUsd,
    costBasis: COST_BASIS,
    costRate: rate,
    runtime: result.runtime,
    humanPreviewReview: "pending",
  };
  const row: Omit<MediaAssetRow, "created_at"> = {
    asset_id: req.outputAssetId,
    case_id: inputs.caseId,
    plan_id: req.planId,
    kind: "generated-preview",
    storage_ref: req.outputStorageRef,
    mime_type: "video/mp4",
    duration_seconds: checked.metadata.durationSeconds,
    generator: REACTOR_GENERATOR,
    model: deps.provider.model,
    generated_at: generatedAt,
    latency_ms: latencyMs,
    cost_usd: costUsd,
    checksum,
    provenance,
  };
  const problems = validateMotionPreview({ ...row, created_at: generatedAt }, binding);
  if (problems.length > 0) return stop("validation", ...problems);

  // Private upload, never overwriting.
  const uploaded = await deps.storage.uploadNew(req.outputStorageRef, result.video, "video/mp4");
  if (uploaded === "exists") {
    const there = await deps.storage.download(req.outputStorageRef);
    if (!there || `sha256:${sha256Hex(there)}` !== checksum) return stop("upload", "A different object appeared at the output path; not overwriting.");
  }

  // Register one immutable generated-preview asset and read it back.
  const registered = await deps.workflow.registerMediaAsset({
    assetId: row.asset_id,
    caseId: inputs.caseId,
    planId: req.planId,
    kind: "generated-preview",
    storageRef: row.storage_ref,
    mimeType: row.mime_type,
    durationSeconds: row.duration_seconds,
    generator: row.generator,
    model: row.model,
    generatedAt,
    latencyMs,
    costUsd,
    checksum,
    provenance,
  });
  if (!registered.ok) return stop("register", ...registered.errors);
  const back = await loadVerifiedMotionPreview(deps, binding);
  if (!back.ok) return stop("read-back", ...back.errors);
  return { ok: true, status: "created", assetId: req.outputAssetId, checksum, durationSeconds: checked.metadata.durationSeconds, width: checked.metadata.width, height: checked.metadata.height, costUsd };
}
