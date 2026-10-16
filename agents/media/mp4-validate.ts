import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Fail-closed validation of a generated preview video: a structurally complete
 * MP4 (every top-level box accounted for, ftyp first, moov and mdat present),
 * then a full decode probe with ffprobe (every video packet decoded and
 * counted), then the preview limits: 3–5 seconds, finite, 16:9, reasonable
 * dimensions, an allowed codec, a bounded size. Nothing is trimmed or repaired.
 */

export const PREVIEW_MIN_SECONDS = 3;
export const PREVIEW_MAX_SECONDS = 5;
export const PREVIEW_ASPECT_TOLERANCE = 0.01;
export const PREVIEW_MIN_BYTES = 10_000;
export const PREVIEW_MAX_BYTES = 64 * 1024 * 1024;
const MIN_WIDTH = 640;
const MAX_WIDTH = 3840;
const MIN_HEIGHT = 360;
const MAX_HEIGHT = 2160;
const VIDEO_CODECS = new Set(["h264", "hevc", "vp9", "av1"]);
const PROBE_TIMEOUT_MS = 60_000;

export type Mp4Box = { type: string; size: number };

/** Top-level MP4 boxes, or why the bytes are not a complete MP4. Partial or padded files fail. */
export function parseTopLevelBoxes(bytes: Uint8Array): { ok: true; boxes: Mp4Box[] } | { ok: false; error: string } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: Mp4Box[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 8) return { ok: false, error: "Trailing bytes after the last MP4 box." };
    let size = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[\x20-\x7e]{4}$/.test(type)) return { ok: false, error: "Malformed MP4 box type." };
    let header = 8;
    if (size === 1) {
      if (bytes.byteLength - offset < 16) return { ok: false, error: "Truncated MP4 box header." };
      const big = view.getBigUint64(offset + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, error: "MP4 box is too large." };
      size = Number(big);
      header = 16;
    } else if (size === 0) {
      return { ok: false, error: "An MP4 box extends to end of file; its size is not declared." };
    }
    if (size < header) return { ok: false, error: "Malformed MP4 box size." };
    if (offset + size > bytes.byteLength) return { ok: false, error: `The ${type} box is truncated; the file is partial.` };
    boxes.push({ type, size });
    offset += size;
  }
  if (boxes[0]?.type !== "ftyp") return { ok: false, error: "Not an MP4: the first box is not ftyp." };
  if (!boxes.some((b) => b.type === "moov")) return { ok: false, error: "MP4 has no moov box." };
  if (!boxes.some((b) => b.type === "mdat")) return { ok: false, error: "MP4 has no media data." };
  return { ok: true, boxes };
}

/** What a decode probe reports about a video file. */
export type VideoProbe = {
  formatNames: string[];
  durationSeconds: number;
  video: { codec: string; width: number; height: number; frameCount: number; frameRate: number | null } | null;
  audio: { codec: string; sampleRate: number | null; channels: number | null } | null;
  videoStreams: number;
};

export type VideoMetadata = {
  container: "mp4";
  structure: "flat" | "fragmented";
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string;
  frameCount: number;
  frameRate: number | null;
  audio: { codec: string; sampleRate: number | null; channels: number | null } | null;
  bytes: number;
};

/** Applies the preview limits to a probe. Every failure is a reason to reject, never to repair. */
export function validatePreviewVideo(bytes: Uint8Array, probe: VideoProbe): { ok: true; metadata: VideoMetadata } | { ok: false; errors: string[] } {
  const e: string[] = [];
  const structure = parseTopLevelBoxes(bytes);
  if (!structure.ok) return { ok: false, errors: [structure.error] };
  if (bytes.byteLength < PREVIEW_MIN_BYTES) e.push("The video is implausibly small.");
  if (bytes.byteLength > PREVIEW_MAX_BYTES) e.push("The video exceeds the size limit.");
  if (!probe.formatNames.includes("mp4")) e.push("The probe does not identify the file as MP4.");
  if (probe.videoStreams !== 1 || !probe.video) e.push("The video must have exactly one video stream.");
  const d = probe.durationSeconds;
  if (!Number.isFinite(d) || d <= 0) e.push("The video duration is missing or not finite.");
  else if (d < PREVIEW_MIN_SECONDS || d > PREVIEW_MAX_SECONDS) e.push(`The video is ${d.toFixed(3)} s; a preview must be ${PREVIEW_MIN_SECONDS}–${PREVIEW_MAX_SECONDS} s.`);
  const v = probe.video;
  if (v) {
    if (!VIDEO_CODECS.has(v.codec)) e.push(`Video codec ${v.codec.slice(0, 20)} is not allowed.`);
    if (!Number.isInteger(v.width) || !Number.isInteger(v.height) || v.width < MIN_WIDTH || v.width > MAX_WIDTH || v.height < MIN_HEIGHT || v.height > MAX_HEIGHT) {
      e.push(`Video dimensions ${v.width}×${v.height} are outside ${MIN_WIDTH}×${MIN_HEIGHT}–${MAX_WIDTH}×${MAX_HEIGHT}.`);
    } else if (Math.abs(v.width / v.height / (16 / 9) - 1) > PREVIEW_ASPECT_TOLERANCE) {
      e.push(`Video is ${v.width}×${v.height}, not 16:9.`);
    }
    if (!Number.isInteger(v.frameCount) || v.frameCount <= 0) e.push("No video frames decoded.");
  }
  if (e.length > 0) return { ok: false, errors: e };
  return {
    ok: true,
    metadata: {
      container: "mp4",
      structure: structure.boxes.some((b) => b.type === "moof") ? "fragmented" : "flat",
      durationSeconds: d,
      width: v!.width,
      height: v!.height,
      videoCodec: v!.codec,
      frameCount: v!.frameCount,
      frameRate: v!.frameRate,
      audio: probe.audio,
      bytes: bytes.byteLength,
    },
  };
}

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const rate = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const [a, b] = v.split("/").map(Number);
  return Number.isFinite(a) && Number.isFinite(b) && b > 0 && a > 0 ? a / b : null;
};

/** Parses ffprobe's JSON output into a probe. */
export function parseFfprobe(json: unknown): VideoProbe {
  const root = (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>;
  const streams = Array.isArray(root.streams) ? (root.streams as Record<string, unknown>[]) : [];
  const format = (typeof root.format === "object" && root.format !== null ? root.format : {}) as Record<string, unknown>;
  const videos = streams.filter((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const v = videos[0];
  return {
    formatNames: typeof format.format_name === "string" ? format.format_name.split(",") : [],
    durationSeconds: num(format.duration) ?? NaN,
    videoStreams: videos.length,
    video: v
      ? {
          codec: String(v.codec_name ?? ""),
          width: num(v.width) ?? 0,
          height: num(v.height) ?? 0,
          frameCount: num(v.nb_read_frames) ?? 0,
          frameRate: rate(v.avg_frame_rate),
        }
      : null,
    audio: audio ? { codec: String(audio.codec_name ?? ""), sampleRate: num(audio.sample_rate), channels: num(audio.channels) } : null,
  };
}

/**
 * Probes a video with ffprobe, decoding every video frame (-count_frames), from
 * a private temporary file that is always removed. Any decode error fails the probe.
 */
export async function ffprobeVideo(bytes: Uint8Array, ffprobePath = "ffprobe"): Promise<VideoProbe> {
  const dir = await mkdtemp(join(tmpdir(), "nf-preview-probe-"));
  const file = join(dir, "preview.mp4");
  try {
    await writeFile(file, bytes, { mode: 0o600 });
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        ffprobePath,
        ["-v", "error", "-count_frames", "-print_format", "json", "-show_format", "-show_streams", file],
        { timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
        // Any decoder error output fails the probe, even when ffprobe exits 0.
        (error, out, err) => (error || String(err).trim() ? reject(new Error(`The video could not be decoded${String(err).trim() ? `: ${String(err).trim().slice(0, 200)}` : "."}`)) : resolve(out)),
      );
    });
    return parseFfprobe(JSON.parse(stdout));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
