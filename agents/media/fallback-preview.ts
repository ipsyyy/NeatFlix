import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaAssetRow, WorkflowStore } from "@/agents/persistence/store";
import type { PrivateStorage } from "@/agents/persistence/private-storage";
import { CHECKSUM, type WorkflowRegistry } from "@/agents/persistence/workflow";
import { EDITED_STILL_HEIGHT, EDITED_STILL_WIDTH, sha256Hex } from "./edited-still";
import { verifyMotionInputs } from "./motion-preview";
import { parseTopLevelBoxes } from "./mp4-validate";

/**
 * A deterministic, clearly disclosed local fallback motion preview
 * (PRODUCT_SOURCE_OF_TRUTH.md §12: keep one known-good generated output as a
 * clearly disclosed fallback). It renders the approved edited still with a
 * subtle eased push-in using only local FFmpeg: no generative editing,
 * interpolation, overlays, or audio, and no provider or network request.
 *
 * Every frame is a crop inside the (upscaled) still at zoom ≥ 1, so no frame can
 * expose a border. The fallback has its own immutable asset identity and private
 * path, separate from the identity reserved for a Reactor preview, which it never
 * occupies or blocks.
 */

export const FALLBACK_GENERATOR = "local-ffmpeg";
export const FALLBACK_ORIGIN = "deterministic-motion-preview";
export const FALLBACK_PROMPT_FIELD = "prompts.motion.prompt";

/** The movement: an eased push-in of at most 4 %, a slight drift right, anchored high to keep heads in frame. */
export const MOVEMENT = Object.freeze({
  fps: 30,
  frames: 105,
  maxZoom: 1.04,
  easing: "cosine ease-in-out",
  /** Fraction of the vertical trim taken from the top (the rest from the bottom). */
  verticalAnchor: 0.25,
  /** Extra share of the horizontal margin used for drift by the last frame (stays inside the image). */
  horizontalDrift: 0.25,
  upscale: 4,
});
export const OUTPUT = Object.freeze({ width: EDITED_STILL_WIDTH, height: EDITED_STILL_HEIGHT, minSeconds: 3, maxSeconds: 4 });

/** Source-coordinate box that must stay fully visible in every frame: both cups, both faces, hands at the cups. */
export const KEEP_VISIBLE = Object.freeze({ left: 400, top: 10, right: 1060, bottom: 600 });

/** Progress 0→1 with cosine easing, at frame n of the movement. */
const eased = (n: number) => 0.5 - 0.5 * Math.cos((Math.PI * n) / (MOVEMENT.frames - 1));

/** The source-coordinate window shown at frame n (what zoompan computes, in 1280×720 units). */
export function windowAt(n: number) {
  const p = eased(n);
  const zoom = 1 + (MOVEMENT.maxZoom - 1) * p;
  const w = OUTPUT.width / zoom;
  const h = OUTPUT.height / zoom;
  const left = ((OUTPUT.width - w) / 2) * (1 + MOVEMENT.horizontalDrift * p);
  const top = (OUTPUT.height - h) * MOVEMENT.verticalAnchor;
  return { zoom, left, top, right: left + w, bottom: top + h };
}

/** The exact FFmpeg filter graph for the movement. */
export function filterGraph(): string {
  const last = MOVEMENT.frames - 1;
  const p = `(0.5-0.5*cos(PI*on/${last}))`;
  const up = `${OUTPUT.width * MOVEMENT.upscale}:${OUTPUT.height * MOVEMENT.upscale}`;
  return [
    `scale=${up}:flags=lanczos`,
    `zoompan=z='1+${(MOVEMENT.maxZoom - 1).toFixed(2)}*${p}'` +
      `:x='(iw-iw/zoom)/2*(1+${MOVEMENT.horizontalDrift}*${p})'` +
      `:y='(ih-ih/zoom)*${MOVEMENT.verticalAnchor}'` +
      `:d=${MOVEMENT.frames}:s=${OUTPUT.width}x${OUTPUT.height}:fps=${MOVEMENT.fps}`,
    "format=yuv420p",
  ].join(",");
}

/** Encoding settings chosen for broad compatibility and bit-exact repeatability. */
export const ENCODING = Object.freeze([
  "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-profile:v", "high", "-level:v", "4.0",
  "-pix_fmt", "yuv420p", "-r", String(MOVEMENT.fps), "-fps_mode", "cfr", "-g", String(MOVEMENT.fps),
  "-threads", "1", "-x264-params", "threads=1:lookahead-threads=1:sliced-threads=0",
  "-an", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-movflags", "+faststart",
]);

export type FallbackRequest = {
  planId: string;
  editedStillAssetId: string;
  editedStillStorageRef: string;
  editedStillChecksum: string;
  visualReviewId: string;
  motionPromptSha256: string;
  outputAssetId: string;
  outputStorageRef: string;
  /** The identity reserved for a Reactor preview: never used here. */
  reservedReactorAssetId: string;
  reservedReactorStorageRef: string;
};

/** Local FFmpeg, injectable so tests can prove no network or provider is involved. */
export interface Ffmpeg {
  version(): Promise<string>;
  /** Runs ffmpeg/ffprobe with arguments only (no shell). */
  run(tool: "ffmpeg" | "ffprobe", args: string[]): Promise<{ stdout: Buffer }>;
}

export const localFfmpeg: Ffmpeg = {
  async version() {
    const { stdout } = await localFfmpeg.run("ffmpeg", ["-version"]);
    return stdout.toString("utf8").split("\n")[0].trim();
  },
  run(tool, args) {
    return new Promise((resolve, reject) =>
      execFile(tool, args, { encoding: "buffer", maxBuffer: 256 * 1024 * 1024, timeout: 180_000 }, (error, stdout, stderr) =>
        error ? reject(new Error(`${tool} failed: ${stderr.toString("utf8").trim().slice(0, 300)}`)) : resolve({ stdout }),
      ),
    );
  },
};

export type FallbackProbe = {
  formatNames: string[];
  durationSeconds: number;
  streams: { codecType: string; codec: string; profile: string; pixFmt: string; width: number; height: number; rFrameRate: string; avgFrameRate: string; frames: number }[];
};

export type FallbackVideo = {
  durationSeconds: number;
  width: number;
  height: number;
  codec: "h264";
  profile: string;
  pixelFormat: "yuv420p";
  frameRate: number;
  constantFrameRate: true;
  frameCount: number;
  audio: false;
  fastStart: true;
  bytes: number;
};

/** The output limits. Every failure rejects the video; nothing is repaired. */
export function validateFallbackVideo(bytes: Uint8Array, probe: FallbackProbe): { ok: true; video: FallbackVideo } | { ok: false; errors: string[] } {
  const e: string[] = [];
  const boxes = parseTopLevelBoxes(bytes);
  if (!boxes.ok) return { ok: false, errors: [boxes.error] };
  const order = boxes.boxes.map((b) => b.type);
  const fastStart = order.indexOf("moov") < order.indexOf("mdat");
  if (!fastStart) e.push("The MP4 is not fast-start (moov must precede mdat).");
  if (!probe.formatNames.includes("mp4")) e.push("Not an MP4.");
  if (probe.streams.some((s) => s.codecType === "audio")) e.push("The fallback must have no audio stream.");
  const videos = probe.streams.filter((s) => s.codecType === "video");
  if (videos.length !== 1 || probe.streams.length !== 1) e.push("Exactly one stream, a video stream, is required.");
  const v = videos[0];
  const d = probe.durationSeconds;
  if (!Number.isFinite(d) || d < OUTPUT.minSeconds || d > OUTPUT.maxSeconds) e.push(`Duration ${Number.isFinite(d) ? d.toFixed(3) : "?"} s is outside ${OUTPUT.minSeconds}–${OUTPUT.maxSeconds} s.`);
  if (v) {
    if (v.width !== OUTPUT.width || v.height !== OUTPUT.height) e.push(`Resolution ${v.width}×${v.height} is not exactly ${OUTPUT.width}×${OUTPUT.height}.`);
    if (v.codec !== "h264") e.push(`Codec ${v.codec} is not H.264.`);
    if (v.pixFmt !== "yuv420p") e.push(`Pixel format ${v.pixFmt} is not yuv420p.`);
    if (v.rFrameRate !== `${MOVEMENT.fps}/1` || v.avgFrameRate !== `${MOVEMENT.fps}/1`) e.push(`Frame rate is not a constant ${MOVEMENT.fps} fps.`);
    if (v.frames !== MOVEMENT.frames) e.push(`Decoded ${v.frames} frames; expected ${MOVEMENT.frames}.`);
  }
  if (e.length > 0) return { ok: false, errors: e };
  return {
    ok: true,
    video: { durationSeconds: d, width: v.width, height: v.height, codec: "h264", profile: v.profile, pixelFormat: "yuv420p", frameRate: MOVEMENT.fps, constantFrameRate: true, frameCount: v.frames, audio: false, fastStart: true, bytes: bytes.byteLength },
  };
}

/** A strip is blank when it is flat: padding is uniform, real image edges are not. */
export const BLANK_RANGE = 2;
export type EdgeStats = { top: number; bottom: number; left: number; right: number };

/** Per-frame value range of each 2-pixel edge strip; any strip at or below BLANK_RANGE is a blank border. */
export function blankBorderFrames(edges: EdgeStats[]): number[] {
  return edges.flatMap((s, i) => (Math.min(s.top, s.bottom, s.left, s.right) <= BLANK_RANGE ? [i] : []));
}

const EDGE_STRIPS: Record<keyof EdgeStats, string> = { top: "1280:2:0:0", bottom: "1280:2:0:718", left: "2:720:0:0", right: "2:720:1278:0" };

async function edgeRanges(ff: Ffmpeg, file: string): Promise<EdgeStats[]> {
  const out: Partial<Record<keyof EdgeStats, number[]>> = {};
  for (const [edge, crop] of Object.entries(EDGE_STRIPS) as [keyof EdgeStats, string][]) {
    const { stdout } = await ff.run("ffmpeg", ["-v", "error", "-i", file, "-vf", `crop=${crop},format=gray`, "-f", "rawvideo", "-"]);
    const size = edge === "top" || edge === "bottom" ? 1280 * 2 : 2 * 720;
    const ranges: number[] = [];
    for (let o = 0; o + size <= stdout.length; o += size) {
      let lo = 255;
      let hi = 0;
      for (let i = o; i < o + size; i++) {
        lo = Math.min(lo, stdout[i]);
        hi = Math.max(hi, stdout[i]);
      }
      ranges.push(hi - lo);
    }
    out[edge] = ranges;
  }
  const n = out.top!.length;
  if ([out.bottom, out.left, out.right].some((r) => r!.length !== n)) throw new Error("Edge analysis decoded inconsistent frame counts.");
  return Array.from({ length: n }, (_, i) => ({ top: out.top![i], bottom: out.bottom![i], left: out.left![i], right: out.right![i] }));
}

async function probe(ff: Ffmpeg, file: string): Promise<FallbackProbe> {
  const { stdout } = await ff.run("ffprobe", ["-v", "error", "-count_frames", "-print_format", "json", "-show_format", "-show_streams", file]);
  const j = JSON.parse(stdout.toString("utf8")) as { format?: Record<string, unknown>; streams?: Record<string, unknown>[] };
  return {
    formatNames: String(j.format?.format_name ?? "").split(","),
    durationSeconds: Number(j.format?.duration),
    streams: (j.streams ?? []).map((s) => ({
      codecType: String(s.codec_type),
      codec: String(s.codec_name),
      profile: String(s.profile ?? ""),
      pixFmt: String(s.pix_fmt ?? ""),
      width: Number(s.width),
      height: Number(s.height),
      rFrameRate: String(s.r_frame_rate),
      avgFrameRate: String(s.avg_frame_rate),
      frames: Number(s.nb_read_frames),
    })),
  };
}

/** PSNR (dB) between a decoded frame of the video and a reference image, both at 1280×720. */
async function psnr(ff: Ffmpeg, video: string, frame: number, reference: string, referenceFilter: string): Promise<number> {
  const { stdout } = await ff.run("ffmpeg", [
    "-v", "error", "-i", video, "-i", reference, "-filter_complex",
    `[0:v]select='eq(n\\,${frame})',format=yuv420p[a];[1:v]${referenceFilter},format=yuv420p[b];[a][b]psnr=stats_file=-`,
    "-f", "null", "-",
  ]);
  const m = /psnr_avg:([0-9.]+|inf)/.exec(stdout.toString("utf8"));
  if (!m) throw new Error("PSNR could not be measured.");
  return m[1] === "inf" ? Number.POSITIVE_INFINITY : Number(m[1]);
}

export type FallbackProvenance = {
  origin: typeof FALLBACK_ORIGIN;
  generator: typeof FALLBACK_GENERATOR;
  fallback: true;
  disclosure: string;
  inputPlanId: string;
  caseId: string;
  promptField: typeof FALLBACK_PROMPT_FIELD;
  motionPromptSha256: string;
  sourceEditedStill: { assetId: string; storageRef: string; checksum: string };
  visualReview: { reviewId: string; decision: "approved"; assetChecksum: string };
  ffmpegVersion: string;
  filterGraph: string;
  movement: typeof MOVEMENT & { firstWindow: ReturnType<typeof windowAt>; finalWindow: ReturnType<typeof windowAt>; keepVisible: typeof KEEP_VISIBLE };
  encoding: readonly string[];
  durationSeconds: number;
  video: FallbackVideo;
  checks: { blankBorderFrames: number; minEdgeRange: number; firstFramePsnrDb: number; finalFramePsnrDb: number; deterministicRenders: 2 };
  outputChecksum: string;
  generatedAt: string;
  latencyMs: number;
  externalProvider: "none";
  paidApi: false;
  reactorContext: string;
  humanVisualReview: "pending";
  releaseStatus: "not reviewed and not approved";
};

export const FALLBACK_DISCLOSURE =
  "Deterministic local FFmpeg fallback: a subtle camera push-in over the approved edited still. It is not a generated motion preview; no frames were synthesised.";
export const REACTOR_CONTEXT =
  "Reactor Visko Orbis Stable generated frames in earlier sessions, but its requested clip remained unavailable for download; this fallback does not replace a future Reactor preview.";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The fallback's identity must be its own: never the Reactor reservation. */
export function identityProblems(req: FallbackRequest): string[] {
  const e: string[] = [];
  if (!/^asset:[a-z0-9-]+:generated-preview:[a-z0-9-]+:v\d+-fallback$/.test(req.outputAssetId)) e.push("The fallback asset ID must be a versioned …-fallback generated-preview ID.");
  if (!req.outputStorageRef.startsWith("storage://") || !/\/generated-preview-v\d+-fallback\.mp4$/.test(req.outputStorageRef)) e.push("The fallback must be stored privately at …/generated-preview-v<n>-fallback.mp4.");
  if (req.outputAssetId === req.reservedReactorAssetId || req.outputStorageRef === req.reservedReactorStorageRef) e.push("The fallback may not use the identity reserved for a Reactor preview.");
  if (!/:v\d+-reactor$/.test(req.reservedReactorAssetId)) e.push("The reserved Reactor identity is malformed.");
  return e;
}

/** Validates a fallback row against its exact binding, before writing and on every read. */
export function validateFallbackRow(row: unknown, req: Omit<FallbackRequest, "reservedReactorAssetId" | "reservedReactorStorageRef">, caseId: string): string[] {
  if (!isObj(row)) return ["Fallback preview must be an object."];
  const p = isObj(row.provenance) ? row.provenance : {};
  const e: string[] = [];
  if (row.asset_id !== req.outputAssetId || row.kind !== "generated-preview" || row.storage_ref !== req.outputStorageRef || row.mime_type !== "video/mp4") e.push("Not this fallback preview.");
  if (row.case_id !== caseId || row.plan_id !== req.planId || p.inputPlanId !== req.planId || p.caseId !== caseId) e.push("Fallback is not bound to this case and plan.");
  if (row.generator !== FALLBACK_GENERATOR || p.generator !== FALLBACK_GENERATOR || p.origin !== FALLBACK_ORIGIN || p.fallback !== true) e.push("Not a disclosed local fallback.");
  if (p.externalProvider !== "none" || p.paidApi !== false || Number(row.cost_usd) !== 0) e.push("A fallback uses no provider and costs nothing.");
  const still = isObj(p.sourceEditedStill) ? p.sourceEditedStill : {};
  if (still.assetId !== req.editedStillAssetId || still.storageRef !== req.editedStillStorageRef || still.checksum !== req.editedStillChecksum) e.push("Fallback is not bound to the approved edited still.");
  const review = isObj(p.visualReview) ? p.visualReview : {};
  if (review.reviewId !== req.visualReviewId || review.decision !== "approved" || review.assetChecksum !== req.editedStillChecksum) e.push("Fallback is not bound to the approved visual review.");
  if (p.motionPromptSha256 !== req.motionPromptSha256 || p.promptField !== FALLBACK_PROMPT_FIELD) e.push("Fallback is not bound to the plan's motion prompt.");
  if (p.filterGraph !== filterGraph() || JSON.stringify(p.encoding) !== JSON.stringify(ENCODING)) e.push("Fallback transformation differs from the committed configuration.");
  const v = isObj(p.video) ? p.video : {};
  if (v.width !== OUTPUT.width || v.height !== OUTPUT.height || v.codec !== "h264" || v.pixelFormat !== "yuv420p" || v.audio !== false || v.frameCount !== MOVEMENT.frames) e.push("Fallback video metadata is not as required.");
  if (!(typeof v.durationSeconds === "number" && v.durationSeconds >= OUTPUT.minSeconds && v.durationSeconds <= OUTPUT.maxSeconds) || Number(row.duration_seconds) !== v.durationSeconds) e.push("Fallback duration is missing or outside 3–4 s.");
  if (typeof row.checksum !== "string" || !CHECKSUM.test(row.checksum) || p.outputChecksum !== row.checksum) e.push("Fallback checksum is missing or inconsistent.");
  const checks = isObj(p.checks) ? p.checks : {};
  if (checks.blankBorderFrames !== 0 || checks.deterministicRenders !== 2) e.push("Fallback checks are incomplete.");
  if (typeof p.ffmpegVersion !== "string" || !/^ffmpeg version /.test(p.ffmpegVersion)) e.push("Fallback FFmpeg version is not recorded.");
  if (p.humanVisualReview !== "pending" || p.releaseStatus !== "not reviewed and not approved") e.push("A fallback starts pending human review and unapproved.");
  if (typeof p.disclosure !== "string" || typeof p.reactorContext !== "string") e.push("Fallback disclosure is missing.");
  if (!(Number.isInteger(row.latency_ms) && p.latencyMs === row.latency_ms) || new Date(String(p.generatedAt)).getTime() !== new Date(String(row.generated_at)).getTime()) e.push("Fallback timing is inconsistent.");
  return e;
}

export type FallbackDeps = { workflow: WorkflowRegistry; store: WorkflowStore; storage: PrivateStorage; ffmpeg?: Ffmpeg; clock?: () => Date; keepDir?: string };
export type FallbackResult =
  | { ok: true; status: "created" | "reused"; assetId: string; checksum: string; video: FallbackVideo; provenance: FallbackProvenance; localCopy: string | null }
  | { ok: false; stage: string; errors: string[] };

const stop = (stage: string, ...errors: string[]): FallbackResult => ({ ok: false, stage, errors });

/** The registered fallback, revalidated against its binding and its stored bytes. */
export async function loadVerifiedFallback(deps: Pick<FallbackDeps, "store" | "storage">, req: FallbackRequest, caseId: string) {
  const row = await deps.store.getMediaAsset(req.outputAssetId);
  if (!row) return { ok: false as const, errors: ["No fallback is registered."] };
  const errors = validateFallbackRow(row, req, caseId);
  if (errors.length > 0) return { ok: false as const, errors };
  const bytes = await deps.storage.download(row.storage_ref);
  if (!bytes || `sha256:${sha256Hex(bytes)}` !== row.checksum) return { ok: false as const, errors: ["The fallback's stored object is missing or differs."] };
  return { ok: true as const, row, bytes };
}

/** Renders the movement from the verified still into dir/name and returns the bytes. */
async function render(ff: Ffmpeg, still: string, out: string): Promise<Uint8Array> {
  await ff.run("ffmpeg", ["-v", "error", "-nostdin", "-y", "-filter_threads", "1", "-i", still, "-vf", filterGraph(), "-frames:v", String(MOVEMENT.frames), ...ENCODING, out]);
  return new Uint8Array(await readFile(out));
}

export async function executeFallbackPreview(req: FallbackRequest, deps: FallbackDeps): Promise<FallbackResult> {
  const ff = deps.ffmpeg ?? localFfmpeg;
  const clock = deps.clock ?? (() => new Date());
  const idErrors = identityProblems(req);
  if (idErrors.length > 0) return stop("identity", ...idErrors);

  // 1. The immutable plan, the approved still, its approval, and its verified private bytes.
  const inputs = await verifyMotionInputs(req, deps);
  if (!inputs.ok) return stop(inputs.stage, ...inputs.errors);
  const caseId = inputs.caseId;

  // 2. Reuse an identical registered fallback; refuse anything conflicting.
  const existing = await deps.store.getMediaAsset(req.outputAssetId);
  if (existing) {
    const verified = await loadVerifiedFallback(deps, req, caseId);
    if (!verified.ok) return stop("idempotency", `${req.outputAssetId} exists but does not revalidate; not overwriting.`, ...verified.errors);
    const prov = verified.row.provenance as FallbackProvenance;
    return { ok: true, status: "reused", assetId: req.outputAssetId, checksum: verified.row.checksum, video: prov.video, provenance: prov, localCopy: null };
  }

  // 3. Render twice from the verified bytes; the outputs must be bit-identical.
  const dir = await mkdtemp(join(tmpdir(), "nf-fallback-"));
  try {
    const stillFile = join(dir, "still.png");
    await writeFile(stillFile, inputs.image, { mode: 0o600 });
    const ffmpegVersion = await ff.version();
    const started = clock();
    let first: Uint8Array;
    let second: Uint8Array;
    try {
      first = await render(ff, stillFile, join(dir, "a.mp4"));
      second = await render(ff, stillFile, join(dir, "b.mp4"));
    } catch (error) {
      return stop("render", (error as Error).message.slice(0, 300));
    }
    const latencyMs = Math.max(0, clock().getTime() - started.getTime());
    const checksum = `sha256:${sha256Hex(first)}`;
    if (checksum !== `sha256:${sha256Hex(second)}`) return stop("render", "Two renders of the committed configuration differ; the output is not deterministic.");
    const out = join(dir, "a.mp4");

    // 4. Validate the video and every frame.
    let checked: ReturnType<typeof validateFallbackVideo>;
    let edges: EdgeStats[];
    let firstPsnr: number;
    let finalPsnr: number;
    try {
      checked = validateFallbackVideo(first, await probe(ff, out));
      if (!checked.ok) return stop("validation", ...checked.errors);
      edges = await edgeRanges(ff, out);
      const fw = windowAt(MOVEMENT.frames - 1);
      firstPsnr = await psnr(ff, out, 0, stillFile, "null");
      // The reference is built as zoompan builds the frame: crop the 4× upscale at the committed final window.
      const u = MOVEMENT.upscale;
      const crop = [fw.right - fw.left, fw.bottom - fw.top, fw.left, fw.top].map((v) => Math.round(v * u)).join(":");
      finalPsnr = await psnr(ff, out, MOVEMENT.frames - 1, stillFile, `scale=${OUTPUT.width * u}:${OUTPUT.height * u}:flags=lanczos,crop=${crop},scale=${OUTPUT.width}:${OUTPUT.height}:flags=lanczos`);
    } catch (error) {
      return stop("validation", (error as Error).message.slice(0, 300));
    }
    if (edges.length !== MOVEMENT.frames) return stop("validation", `Edge analysis decoded ${edges.length} frames; expected ${MOVEMENT.frames}.`);
    const blanks = blankBorderFrames(edges);
    if (blanks.length > 0) return stop("validation", `Frames ${blanks.slice(0, 5).join(", ")} have a blank border.`);
    const fw = windowAt(MOVEMENT.frames - 1);
    if (fw.left > KEEP_VISIBLE.left || fw.top > KEEP_VISIBLE.top || fw.right < KEEP_VISIBLE.right || fw.bottom < KEEP_VISIBLE.bottom) return stop("validation", "The final frame would crop the scene's important content.");
    if (!(firstPsnr >= 35)) return stop("validation", `The first frame does not reproduce the approved still (PSNR ${firstPsnr.toFixed(1)} dB).`);
    if (!(finalPsnr >= 30)) return stop("validation", `The final frame does not match the committed final window (PSNR ${finalPsnr.toFixed(1)} dB).`);

    // 5. The record, validated before anything is stored.
    const generatedAt = started.toISOString();
    const provenance: FallbackProvenance = {
      origin: FALLBACK_ORIGIN,
      generator: FALLBACK_GENERATOR,
      fallback: true,
      disclosure: FALLBACK_DISCLOSURE,
      inputPlanId: req.planId,
      caseId,
      promptField: FALLBACK_PROMPT_FIELD,
      motionPromptSha256: req.motionPromptSha256,
      sourceEditedStill: { assetId: req.editedStillAssetId, storageRef: req.editedStillStorageRef, checksum: req.editedStillChecksum },
      visualReview: { reviewId: inputs.review.review_id, decision: "approved", assetChecksum: inputs.review.asset_checksum },
      ffmpegVersion,
      filterGraph: filterGraph(),
      movement: { ...MOVEMENT, firstWindow: windowAt(0), finalWindow: fw, keepVisible: KEEP_VISIBLE },
      encoding: ENCODING,
      durationSeconds: checked.video.durationSeconds,
      video: checked.video,
      checks: { blankBorderFrames: 0, minEdgeRange: Math.min(...edges.flatMap((s) => [s.top, s.bottom, s.left, s.right])), firstFramePsnrDb: Math.round(firstPsnr * 100) / 100, finalFramePsnrDb: Math.round(finalPsnr * 100) / 100, deterministicRenders: 2 },
      outputChecksum: checksum,
      generatedAt,
      latencyMs,
      externalProvider: "none",
      paidApi: false,
      reactorContext: REACTOR_CONTEXT,
      humanVisualReview: "pending",
      releaseStatus: "not reviewed and not approved",
    };
    const row: Omit<MediaAssetRow, "created_at"> = {
      asset_id: req.outputAssetId,
      case_id: caseId,
      plan_id: req.planId,
      kind: "generated-preview",
      storage_ref: req.outputStorageRef,
      mime_type: "video/mp4",
      duration_seconds: checked.video.durationSeconds,
      generator: FALLBACK_GENERATOR,
      model: `${ffmpegVersion.replace(/^ffmpeg version /, "ffmpeg ").split(" ").slice(0, 2).join(" ")} zoompan+libx264`,
      generated_at: generatedAt,
      latency_ms: latencyMs,
      cost_usd: 0,
      checksum,
      provenance,
    };
    const problems = validateFallbackRow({ ...row, created_at: generatedAt }, req, caseId);
    if (problems.length > 0) return stop("validation", ...problems);

    // 6. Private upload (never overwriting a different object), one registration, read-back.
    const there = await deps.storage.download(req.outputStorageRef);
    if (there && `sha256:${sha256Hex(there)}` !== checksum) return stop("upload", "A different object already exists at the fallback path; not overwriting.");
    if (!there) {
      const uploaded = await deps.storage.uploadNew(req.outputStorageRef, first, "video/mp4");
      if (uploaded === "exists") {
        const raced = await deps.storage.download(req.outputStorageRef);
        if (!raced || `sha256:${sha256Hex(raced)}` !== checksum) return stop("upload", "A different object appeared at the fallback path; not overwriting.");
      }
    }
    const registered = await deps.workflow.registerMediaAsset({
      assetId: row.asset_id,
      caseId,
      planId: req.planId,
      kind: "generated-preview",
      storageRef: row.storage_ref,
      mimeType: row.mime_type,
      durationSeconds: row.duration_seconds,
      generator: row.generator,
      model: row.model,
      generatedAt,
      latencyMs,
      costUsd: 0,
      checksum,
      provenance,
    });
    if (!registered.ok) return stop("register", ...registered.errors);
    const back = await loadVerifiedFallback(deps, req, caseId);
    if (!back.ok) return stop("read-back", ...back.errors);
    let localCopy: string | null = null;
    if (deps.keepDir) {
      localCopy = join(deps.keepDir, "generated-preview-v3-fallback.mp4");
      await writeFile(localCopy, back.bytes, { mode: 0o600 });
    }
    return { ok: true, status: "created", assetId: req.outputAssetId, checksum, video: checked.video, provenance, localCopy };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
