import type { PrivateStorage } from "@/agents/persistence/private-storage";
import type { MediaAssetRow, WorkflowStore } from "@/agents/persistence/store";
import { CHECKSUM, type WorkflowRegistry } from "@/agents/persistence/workflow";
import { loadVerifiedEditedStill, sha256Hex } from "./edited-still";
import { parseTopLevelBoxes, type VideoProbe } from "./mp4-validate";
import { FULL_SCENE_LABEL } from "@/lib/demo/snapshot";
import { ALEPH_EDIT_PROMPT, RUNWAY_MAX_COST_USD, RUNWAY_MODEL, RUNWAY_USD_PER_CREDIT } from "./runway-aleph";

/**
 * Registers the one human-accepted Runway Aleph full-scene edit of the LUV
 * source video (agents/scripts/full-scene-edit.ts, attempt 1) as its own
 * immutable "full-scene-video" asset, and revalidates it on every read.
 *
 * No provider is called here: the downloaded bytes, the local attempt ledger,
 * and the registry must all agree with the pinned attempt below before
 * anything is uploaded or registered. The asset never takes, replaces, or
 * blocks an earlier identity (the v1–v3 stills or the approved 3.5 s
 * fallback), and it is not a plan's generated preview.
 *
 * The edited cup typography is generated and not production-final; the
 * disclosure says so, and the human review records the limitation.
 */

export const RUNWAY_GENERATOR = "runway";
export const RUNWAY_FULL_SCENE_ORIGIN = "runway-aleph-full-scene-edit";
export { FULL_SCENE_LABEL };
export const FULL_SCENE_DISCLOSURE =
  "Runway Aleph (aleph2) edited the complete 20-second LUV source scene to apply Daybreak Cold Brew branding to the two existing takeaway cups, guided by the approved v3 edited still. " +
  "This is a generated preview, not production-final: the generated cup lettering is not final typography.";
export const FULL_SCENE_LIMITATION = "Fine generated cup lettering shows minor temporal instability during motion.";
/** Versioned full-scene video asset IDs: asset:<title>:full-scene-video:<scene>:v<n>-<variant>. */
export const FULL_SCENE_ASSET_ID = /^asset:[a-z0-9-]+:full-scene-video:[a-z0-9-]+:v[0-9]+-[a-z0-9]+$/;

/** At most one frame (at 24 fps) shorter or longer than the source. */
export const DURATION_TOLERANCE_SECONDS = 1 / 24;

export type FullSceneRequest = {
  caseId: string;
  planId: string;
  authorization: string;
  outputAssetId: string;
  outputStorageRef: string;
  sourceVideoAssetId: string;
  sourceVideoChecksum: string;
  referenceStillAssetId: string;
  referenceStillChecksum: string;
  referenceReviewId: string;
  taskId: string;
  model: typeof RUNWAY_MODEL;
  estimatedCredits: number;
  chargedCredits: number;
  outputChecksum: string;
  authorizedAt: string;
  video: { width: number; height: number; codec: string; frameRate: number; audioCodec: string };
  /** Identities this registration must never write: earlier stills and the approved fallback. */
  protectedAssetIds: readonly string[];
  protectedStorageRefs: readonly string[];
};

/** The accepted attempt: task, credits, and checksums exactly as the attempt ledger recorded them. */
export const LUV_V4_RUNWAY: Readonly<FullSceneRequest> = Object.freeze({
  caseId: "NF-DEMO-0001",
  planId: "plan:daybreak-cold-brew:luv-scene-1:v3",
  authorization: "plan:daybreak-cold-brew:luv-scene-1:v4-runway",
  outputAssetId: "asset:luv-hypothesis:full-scene-video:luv-scene-1:v4-runway",
  outputStorageRef: "storage://nf-media/full-scene/luv-hypothesis/daybreak-cold-brew-luv-scene-1-v4-runway/full-scene-video-v4-runway.mp4",
  sourceVideoAssetId: "asset:luv-hypothesis:source-video:v1",
  sourceVideoChecksum: "sha256:8cbe5186c7bcea0348a336f41f0318168f8ed15c635c89a195b0b2ad93324ddc",
  referenceStillAssetId: "asset:luv-hypothesis:edited-still:luv-scene-1:v3",
  referenceStillChecksum: "sha256:be7a04de0a59446f6a2c47ae5b29d6c3af04a29be1f7d471eb3e12d38e8ab73f",
  referenceReviewId: "fd0b60da-42e2-4995-a4da-71cc2b6bbe43",
  taskId: "fcc20fc6-7275-4a6c-9f8c-51d2538221a4",
  model: RUNWAY_MODEL,
  estimatedCredits: 308,
  chargedCredits: 308,
  outputChecksum: "sha256:112b183bba60b8056ea6a4d54b583e81f55086dd203b8aba9b2514f94ca7ce72",
  authorizedAt: "2026-10-19T22:13:27.453Z",
  video: Object.freeze({ width: 1280, height: 720, codec: "h264", frameRate: 24, audioCodec: "aac" }),
  protectedAssetIds: Object.freeze([
    "asset:luv-hypothesis:edited-still:luv-scene-1:v1",
    "asset:luv-hypothesis:edited-still:luv-scene-1:v2",
    "asset:luv-hypothesis:edited-still:luv-scene-1:v3",
    "asset:luv-hypothesis:generated-preview:luv-scene-1:v3-fallback",
  ]),
  protectedStorageRefs: Object.freeze([
    "storage://nf-media/edits/luv-hypothesis/daybreak-cold-brew-luv-scene-1-v1/edited-still-v1.png",
    "storage://nf-media/edits/luv-hypothesis/daybreak-cold-brew-luv-scene-1-v2/edited-still-v2.png",
    "storage://nf-media/edits/luv-hypothesis/daybreak-cold-brew-luv-scene-1-v3/edited-still-v3.png",
    "storage://nf-media/previews/luv-hypothesis/daybreak-cold-brew-luv-scene-1-v3/generated-preview-v3-fallback.mp4",
  ]),
});

/** The attempt ledger written by agents/scripts/full-scene-edit.ts after download. */
export type AttemptLedger = {
  state: string;
  authorization: string;
  taskId: string;
  estimatedCredits: number;
  chargedCredits: number;
  outputChecksum: string;
};

export type FullSceneVideo = {
  durationSeconds: number;
  sourceDurationSeconds: number;
  durationDeltaSeconds: number;
  width: number;
  height: number;
  codec: string;
  frameRate: number;
  frameCount: number;
  audio: { codec: string; sampleRate: number | null; channels: number | null };
  fastStart: boolean;
  bytes: number;
};

export type FullSceneProvenance = {
  origin: typeof RUNWAY_FULL_SCENE_ORIGIN;
  generator: typeof RUNWAY_GENERATOR;
  label: typeof FULL_SCENE_LABEL;
  disclosure: string;
  inputPlanId: string;
  caseId: string;
  authorization: string;
  runway: {
    taskId: string;
    model: string;
    estimatedCredits: number;
    chargedCredits: number;
    usdPerCredit: number;
    costUsd: number;
    ceilingUsd: number;
    promptSha256: string;
    attempt: 1;
    automaticRetries: 0;
  };
  sourceVideo: { assetId: string; storageRef: string; checksum: string };
  referenceStill: { assetId: string; storageRef: string; checksum: string };
  referenceReview: { reviewId: string; decision: "approved"; assetChecksum: string };
  outputChecksum: string;
  video: FullSceneVideo;
  authorizedAt: string;
  generatedAt: string;
  latencyMs: number;
  latencyBasis: string;
  productionFinal: false;
  humanVisualReview: "pending";
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const creditsToUsd = (credits: number) => Math.round(credits * RUNWAY_USD_PER_CREDIT * 100) / 100;

/** The pinned request must be self-consistent and must not touch an earlier identity. */
export function identityProblems(req: FullSceneRequest): string[] {
  const e: string[] = [];
  if (!FULL_SCENE_ASSET_ID.test(req.outputAssetId)) e.push("The output must be a versioned full-scene-video asset ID.");
  if (!/^storage:\/\/nf-media\/full-scene\/[a-z0-9/-]+\.mp4$/.test(req.outputStorageRef)) e.push("The output must be stored privately under storage://nf-media/full-scene/.");
  if (req.protectedAssetIds.includes(req.outputAssetId) || req.protectedStorageRefs.includes(req.outputStorageRef)) e.push("The output may not use an earlier still's or the approved fallback's identity.");
  for (const c of [req.sourceVideoChecksum, req.referenceStillChecksum, req.outputChecksum]) if (!CHECKSUM.test(c)) e.push("A pinned checksum is malformed.");
  if (creditsToUsd(req.chargedCredits) > RUNWAY_MAX_COST_USD) e.push("The charged credits exceed the hard cost ceiling.");
  return e;
}

/** The local attempt ledger must record exactly the pinned, downloaded attempt. */
export function ledgerProblems(ledger: unknown, req: FullSceneRequest): string[] {
  if (!isObj(ledger)) return ["The attempt ledger is missing or malformed."];
  const e: string[] = [];
  if (ledger.state !== "downloaded-pending-human-review") e.push(`The attempt ledger is "${String(ledger.state)}", not downloaded-pending-human-review.`);
  if (ledger.authorization !== req.authorization) e.push("The attempt ledger names a different authorization.");
  if (ledger.taskId !== req.taskId) e.push("The attempt ledger names a different Runway task.");
  if (ledger.estimatedCredits !== req.estimatedCredits || ledger.chargedCredits !== req.chargedCredits) e.push("The attempt ledger records different credits.");
  if (ledger.outputChecksum !== req.outputChecksum) e.push("The attempt ledger records a different output checksum.");
  return e;
}

/** Checks the exact downloaded bytes: checksum, container, codecs, resolution, audio, and full-scene duration. Nothing is repaired. */
export function validateFullSceneVideo(
  bytes: Uint8Array,
  probe: VideoProbe,
  req: FullSceneRequest,
  sourceDurationSeconds: number,
): { ok: true; video: FullSceneVideo } | { ok: false; errors: string[] } {
  const e: string[] = [];
  if (`sha256:${sha256Hex(bytes)}` !== req.outputChecksum) e.push("The video bytes differ from the accepted output checksum.");
  const boxes = parseTopLevelBoxes(bytes);
  if (!boxes.ok) return { ok: false, errors: [...e, boxes.error] };
  if (!probe.formatNames.includes("mp4")) e.push("Not an MP4.");
  if (probe.videoStreams !== 1 || !probe.video) e.push("Exactly one video stream is required.");
  const v = probe.video;
  if (v) {
    if (v.codec !== req.video.codec) e.push(`Video codec ${v.codec} is not ${req.video.codec}.`);
    if (v.width !== req.video.width || v.height !== req.video.height) e.push(`Resolution ${v.width}×${v.height} is not ${req.video.width}×${req.video.height}.`);
    if (v.frameRate !== req.video.frameRate) e.push(`Frame rate ${v.frameRate} is not ${req.video.frameRate} fps.`);
    if (!(v.frameCount > 0)) e.push("No video frames decoded.");
  }
  if (!probe.audio) e.push("The original audio track is missing.");
  else if (probe.audio.codec !== req.video.audioCodec) e.push(`Audio codec ${probe.audio.codec} is not ${req.video.audioCodec}.`);
  const d = probe.durationSeconds;
  const delta = d - sourceDurationSeconds;
  if (!Number.isFinite(d) || !(Math.abs(delta) <= DURATION_TOLERANCE_SECONDS)) {
    e.push(`Duration ${Number.isFinite(d) ? d.toFixed(3) : "?"} s is not the full ${sourceDurationSeconds.toFixed(3)} s source scene (±1 frame).`);
  }
  if (e.length > 0) return { ok: false, errors: e };
  const order = boxes.boxes.map((b) => b.type);
  return {
    ok: true,
    video: {
      durationSeconds: d,
      sourceDurationSeconds,
      durationDeltaSeconds: Math.round(delta * 1e6) / 1e6,
      width: v!.width,
      height: v!.height,
      codec: v!.codec,
      frameRate: v!.frameRate!,
      frameCount: v!.frameCount,
      audio: probe.audio!,
      fastStart: order.indexOf("moov") < order.indexOf("mdat"),
      bytes: bytes.byteLength,
    },
  };
}

/** Validates a registered row against the pinned attempt, before writing and on every read. */
export function validateFullSceneRow(row: unknown, req: FullSceneRequest, bound: { sourceStorageRef: string; referenceStorageRef: string }): string[] {
  if (!isObj(row)) return ["Full-scene video must be an object."];
  const p = isObj(row.provenance) ? row.provenance : {};
  const r = isObj(p.runway) ? p.runway : {};
  const v = isObj(p.video) ? p.video : {};
  const e: string[] = [];
  if (row.asset_id !== req.outputAssetId || row.kind !== "full-scene-video" || row.storage_ref !== req.outputStorageRef || row.mime_type !== "video/mp4") e.push("Not this full-scene video.");
  if (row.case_id !== req.caseId || row.plan_id !== req.planId || p.inputPlanId !== req.planId || p.caseId !== req.caseId) e.push("Not bound to this case and plan.");
  if (row.generator !== RUNWAY_GENERATOR || p.generator !== RUNWAY_GENERATOR || p.origin !== RUNWAY_FULL_SCENE_ORIGIN || row.model !== req.model || r.model !== req.model) e.push("Not a Runway Aleph full-scene edit.");
  if (p.authorization !== req.authorization || r.taskId !== req.taskId || r.attempt !== 1 || r.automaticRetries !== 0) e.push("Not the accepted Runway task.");
  if (r.estimatedCredits !== req.estimatedCredits || r.chargedCredits !== req.chargedCredits || r.usdPerCredit !== RUNWAY_USD_PER_CREDIT || r.ceilingUsd !== RUNWAY_MAX_COST_USD) e.push("Runway credits differ from the accepted task.");
  if (r.costUsd !== creditsToUsd(req.chargedCredits) || Number(row.cost_usd) !== r.costUsd) e.push("The recorded cost does not follow from the credits charged.");
  if (r.promptSha256 !== sha256Hex(ALEPH_EDIT_PROMPT)) e.push("Not bound to the committed Aleph prompt.");
  const src = isObj(p.sourceVideo) ? p.sourceVideo : {};
  if (src.assetId !== req.sourceVideoAssetId || src.checksum !== req.sourceVideoChecksum || src.storageRef !== bound.sourceStorageRef) e.push("Not bound to the registered source video.");
  const ref = isObj(p.referenceStill) ? p.referenceStill : {};
  if (ref.assetId !== req.referenceStillAssetId || ref.checksum !== req.referenceStillChecksum || ref.storageRef !== bound.referenceStorageRef) e.push("Not bound to the approved reference still.");
  const rev = isObj(p.referenceReview) ? p.referenceReview : {};
  if (rev.reviewId !== req.referenceReviewId || rev.decision !== "approved" || rev.assetChecksum !== req.referenceStillChecksum) e.push("Not bound to the reference still's approved review.");
  if (row.checksum !== req.outputChecksum || p.outputChecksum !== req.outputChecksum) e.push("Checksum differs from the accepted output.");
  if (v.width !== req.video.width || v.height !== req.video.height || v.codec !== req.video.codec || v.frameRate !== req.video.frameRate || !isObj(v.audio) || v.audio.codec !== req.video.audioCodec) e.push("Video metadata is not as accepted.");
  const d = v.durationSeconds;
  if (!(typeof d === "number" && typeof v.sourceDurationSeconds === "number" && Math.abs(d - v.sourceDurationSeconds) <= DURATION_TOLERANCE_SECONDS) || Number(row.duration_seconds) !== d) e.push("Duration is not the full source scene.");
  if (p.label !== FULL_SCENE_LABEL || p.disclosure !== FULL_SCENE_DISCLOSURE || p.productionFinal !== false) e.push("The preview disclosure is missing or claims production-final output.");
  if (p.humanVisualReview !== "pending") e.push("The asset record starts pending human review; the review is a separate record.");
  if (p.authorizedAt !== req.authorizedAt || !(Number.isInteger(row.latency_ms) && p.latencyMs === row.latency_ms) || new Date(String(p.generatedAt)).getTime() !== new Date(String(row.generated_at)).getTime()) e.push("Timing is inconsistent.");
  return e;
}

export type FullSceneDeps = { workflow: WorkflowRegistry; store: WorkflowStore; storage: PrivateStorage };

/**
 * The bindings every registration and read revalidates: the immutable plan, the
 * registered source video, and the reference still with its approved human
 * review of those exact bytes.
 */
async function verifyBindings(deps: FullSceneDeps, req: FullSceneRequest) {
  const plan = await deps.workflow.loadPlan(req.planId);
  if (!plan.ok) return { ok: false as const, errors: ["The plan does not revalidate.", ...plan.errors] };
  if (plan.value.caseId !== req.caseId) return { ok: false as const, errors: ["The plan belongs to another case."] };
  const source = await deps.store.getMediaAsset(req.sourceVideoAssetId);
  if (!source || source.kind !== "source-video" || source.case_id !== req.caseId || source.checksum !== req.sourceVideoChecksum || !(Number(source.duration_seconds) > 0)) {
    return { ok: false as const, errors: ["The registered source video is missing or differs from the edited source."] };
  }
  const still = await loadVerifiedEditedStill(deps.workflow, deps.store, req.referenceStillAssetId);
  if (!still.ok) return { ok: false as const, errors: ["The reference still does not revalidate.", ...still.errors] };
  if (still.row.checksum !== req.referenceStillChecksum) return { ok: false as const, errors: ["The reference still differs from the one sent to Runway."] };
  const review = await deps.store.getVisualReview(req.referenceStillAssetId);
  if (!review || review.review_id !== req.referenceReviewId || review.decision !== "approved" || review.asset_checksum !== still.row.checksum) {
    return { ok: false as const, errors: ["The reference still lacks its approved human review of these exact bytes."] };
  }
  return { ok: true as const, source, still: still.row, review, sourceDurationSeconds: Number(source.duration_seconds) };
}

/** The registered full-scene video, revalidated against its bindings and its private bytes. Read-only. */
export async function loadVerifiedFullScene(
  deps: FullSceneDeps,
  req: FullSceneRequest = LUV_V4_RUNWAY,
): Promise<{ ok: true; row: MediaAssetRow; bytes: Uint8Array } | { ok: false; errors: string[] }> {
  const row = await deps.store.getMediaAsset(req.outputAssetId);
  if (!row) return { ok: false, errors: [`No full-scene video is registered as ${req.outputAssetId}.`] };
  const bound = await verifyBindings(deps, req);
  if (!bound.ok) return bound;
  const errors = validateFullSceneRow(row, req, { sourceStorageRef: bound.source.storage_ref, referenceStorageRef: bound.still.storage_ref });
  if (errors.length > 0) return { ok: false, errors };
  const bytes = await deps.storage.download(row.storage_ref);
  if (!bytes || `sha256:${sha256Hex(bytes)}` !== row.checksum) return { ok: false, errors: ["The stored object is missing or differs from its checksum."] };
  return { ok: true, row, bytes };
}

export type RegisterInput = { bytes: Uint8Array; probe: VideoProbe; ledger: unknown; generatedAt: Date };
export type RegisterResult =
  | { ok: true; status: "created" | "reused"; row: MediaAssetRow; video: FullSceneVideo }
  | { ok: false; stage: string; errors: string[] };

const stop = (stage: string, ...errors: string[]): RegisterResult => ({ ok: false, stage, errors });

/**
 * Verifies the accepted local output against the pinned attempt and the
 * registry, uploads it privately without overwriting, registers it once, and
 * reads it back. An identical earlier registration is reused; anything
 * conflicting stops the run with nothing changed.
 */
export async function registerFullScene(deps: FullSceneDeps, input: RegisterInput, req: FullSceneRequest = LUV_V4_RUNWAY): Promise<RegisterResult> {
  const idErrors = identityProblems(req);
  if (idErrors.length > 0) return stop("identity", ...idErrors);
  const ledgerErrors = ledgerProblems(input.ledger, req);
  if (ledgerErrors.length > 0) return stop("ledger", ...ledgerErrors);
  const bound = await verifyBindings(deps, req);
  if (!bound.ok) return stop("bindings", ...bound.errors);
  const checked = validateFullSceneVideo(input.bytes, input.probe, req, bound.sourceDurationSeconds);
  if (!checked.ok) return stop("video", ...checked.errors);

  const existing = await deps.store.getMediaAsset(req.outputAssetId);
  if (existing) {
    const verified = await loadVerifiedFullScene(deps, req);
    if (!verified.ok) return stop("idempotency", `${req.outputAssetId} exists but does not revalidate; not overwriting.`, ...verified.errors);
    return { ok: true, status: "reused", row: verified.row, video: (verified.row.provenance as FullSceneProvenance).video };
  }

  const generatedAt = input.generatedAt.toISOString();
  const latencyMs = Math.max(0, input.generatedAt.getTime() - new Date(req.authorizedAt).getTime());
  const costUsd = creditsToUsd(req.chargedCredits);
  const provenance: FullSceneProvenance = {
    origin: RUNWAY_FULL_SCENE_ORIGIN,
    generator: RUNWAY_GENERATOR,
    label: FULL_SCENE_LABEL,
    disclosure: FULL_SCENE_DISCLOSURE,
    inputPlanId: req.planId,
    caseId: req.caseId,
    authorization: req.authorization,
    runway: {
      taskId: req.taskId,
      model: req.model,
      estimatedCredits: req.estimatedCredits,
      chargedCredits: req.chargedCredits,
      usdPerCredit: RUNWAY_USD_PER_CREDIT,
      costUsd,
      ceilingUsd: RUNWAY_MAX_COST_USD,
      promptSha256: sha256Hex(ALEPH_EDIT_PROMPT),
      attempt: 1,
      automaticRetries: 0,
    },
    sourceVideo: { assetId: req.sourceVideoAssetId, storageRef: bound.source.storage_ref, checksum: req.sourceVideoChecksum },
    referenceStill: { assetId: req.referenceStillAssetId, storageRef: bound.still.storage_ref, checksum: req.referenceStillChecksum },
    referenceReview: { reviewId: bound.review.review_id, decision: "approved", assetChecksum: bound.review.asset_checksum },
    outputChecksum: req.outputChecksum,
    video: checked.video,
    authorizedAt: req.authorizedAt,
    generatedAt,
    latencyMs,
    latencyBasis: "From the local paid-call authorization to the completed local download of the Runway output.",
    productionFinal: false,
    humanVisualReview: "pending",
  };
  const row: Omit<MediaAssetRow, "created_at"> = {
    asset_id: req.outputAssetId,
    case_id: req.caseId,
    plan_id: req.planId,
    kind: "full-scene-video",
    storage_ref: req.outputStorageRef,
    mime_type: "video/mp4",
    duration_seconds: checked.video.durationSeconds,
    generator: RUNWAY_GENERATOR,
    model: req.model,
    generated_at: generatedAt,
    latency_ms: latencyMs,
    cost_usd: costUsd,
    checksum: req.outputChecksum,
    provenance,
  };
  const problems = validateFullSceneRow(row, req, { sourceStorageRef: bound.source.storage_ref, referenceStorageRef: bound.still.storage_ref });
  if (problems.length > 0) return stop("validation", ...problems);

  const there = await deps.storage.download(req.outputStorageRef);
  if (there && `sha256:${sha256Hex(there)}` !== req.outputChecksum) return stop("upload", "A different object already exists at the full-scene path; not overwriting.");
  if (!there) {
    const uploaded = await deps.storage.uploadNew(req.outputStorageRef, input.bytes, "video/mp4");
    if (uploaded === "exists") {
      const raced = await deps.storage.download(req.outputStorageRef);
      if (!raced || `sha256:${sha256Hex(raced)}` !== req.outputChecksum) return stop("upload", "A different object appeared at the full-scene path; not overwriting.");
    }
  }
  const registered = await deps.workflow.registerMediaAsset({
    assetId: row.asset_id,
    caseId: row.case_id,
    planId: req.planId,
    kind: "full-scene-video",
    storageRef: row.storage_ref,
    mimeType: row.mime_type,
    durationSeconds: row.duration_seconds,
    generator: row.generator,
    model: row.model,
    generatedAt,
    latencyMs,
    costUsd,
    checksum: row.checksum,
    provenance,
  });
  if (!registered.ok) return stop("register", ...registered.errors);
  const back = await loadVerifiedFullScene(deps, req);
  if (!back.ok) return stop("read-back", ...back.errors);
  return { ok: true, status: "created", row: back.row, video: checked.video };
}
