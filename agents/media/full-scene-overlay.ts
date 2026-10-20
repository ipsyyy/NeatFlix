import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

/**
 * Zero-provider-cost path for this fixed-camera demo. It preserves the source
 * video and composites only the two cup regions from the approved v3 still.
 * This is a deterministic surface overlay, not generative video editing.
 */
export const FULL_SCENE_TARGET_SECONDS = 20.064;
export const DURATION_TOLERANCE_SECONDS = 0.08;
/** Shot-boundary scan of the registered source: cups are visible only here. */
export const TABLE_SHOT = Object.freeze({ startSeconds: 4.46, endSeconds: 14.79 });

export const APPROVED_CUP_REGIONS = Object.freeze([
  Object.freeze({ name: "left-cup", left: 543, top: 422, width: 94, height: 137 }),
  Object.freeze({ name: "right-cup", left: 858, top: 422, width: 91, height: 137 }),
] as const);

export function fullSceneFilterGraph(): string {
  return APPROVED_CUP_REGIONS.map((region, index) => {
    const input = index === 0 ? "[0:v][1:v]" : `[v${index}][${index + 1}:v]`;
    return `${input}overlay=${region.left}:${region.top}:eof_action=repeat:shortest=1:enable='between(t,${TABLE_SHOT.startSeconds},${TABLE_SHOT.endSeconds})'[v${index + 1}]`;
  }).join(";");
}

export type FullSceneProbe = { durationSeconds: number; width: number; height: number; videoCodec: string; hasAudio: boolean };

export function validateFullSceneProbe(probe: FullSceneProbe, sourceDuration = FULL_SCENE_TARGET_SECONDS): string[] {
  const errors: string[] = [];
  if (Math.abs(probe.durationSeconds - sourceDuration) > DURATION_TOLERANCE_SECONDS) errors.push(`Output duration ${probe.durationSeconds.toFixed(3)} s does not match source duration ${sourceDuration.toFixed(3)} s.`);
  if (probe.width !== 1280 || probe.height !== 720) errors.push(`Output must be 1280×720, not ${probe.width}×${probe.height}.`);
  if (probe.videoCodec !== "h264") errors.push(`Output video must be H.264, not ${probe.videoCodec}.`);
  return errors;
}

function run(tool: "ffmpeg" | "ffprobe", args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => execFile(tool, args, { encoding: "buffer", maxBuffer: 256 * 1024 * 1024, timeout: 240_000 }, (error, stdout, stderr) =>
    error ? reject(new Error(`${tool} failed: ${stderr.toString("utf8").trim().slice(0, 400)}`)) : resolve(stdout)));
}

async function probe(file: string): Promise<FullSceneProbe> {
  const raw = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  const data = JSON.parse(raw.toString("utf8")) as { format?: { duration?: string }; streams?: Array<Record<string, unknown>> };
  const video = data.streams?.find((stream) => stream.codec_type === "video");
  return { durationSeconds: Number(data.format?.duration), width: Number(video?.width), height: Number(video?.height), videoCodec: String(video?.codec_name ?? ""), hasAudio: Boolean(data.streams?.some((stream) => stream.codec_type === "audio")) };
}

export async function renderFullSceneOverlay(options: { sourceVideo: Uint8Array; approvedStill: Uint8Array; outputFile: string; expectedDurationSeconds?: number }): Promise<FullSceneProbe> {
  const dir = await mkdtemp(join(tmpdir(), "neatflix-full-scene-"));
  try {
    const source = join(dir, "source.mp4");
    await writeFile(source, options.sourceVideo, { mode: 0o600 });
    const inputs = ["-i", source];
    for (const [index, region] of APPROVED_CUP_REGIONS.entries()) {
      const patch = join(dir, `cup-${index}.png`);
      await sharp(options.approvedStill).extract(region).png().toFile(patch);
      inputs.push("-loop", "1", "-i", patch);
    }
    await run("ffmpeg", ["-v", "error", "-nostdin", "-y", ...inputs, "-filter_complex", fullSceneFilterGraph(), "-map", `[v${APPROVED_CUP_REGIONS.length}]`, "-map", "0:a?", "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", options.outputFile]);
    const result = await probe(options.outputFile);
    const errors = validateFullSceneProbe(result, options.expectedDurationSeconds ?? FULL_SCENE_TARGET_SECONDS);
    if (errors.length > 0) { await rm(options.outputFile, { force: true }); throw new Error(errors.join(" ")); }
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
