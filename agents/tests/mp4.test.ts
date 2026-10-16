import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ffprobeVideo, parseTopLevelBoxes, validatePreviewVideo, type VideoProbe } from "@/agents/media/mp4-validate";

const box = (type: string, payload = 0) => {
  const b = Buffer.alloc(8 + payload);
  b.writeUInt32BE(8 + payload, 0);
  b.write(type, 4, "ascii");
  return b;
};
/** A structurally complete MP4 shell (ftyp, moov, mdat) of a plausible size. */
const mp4Shell = (mdat = 20_000) => new Uint8Array(Buffer.concat([box("ftyp", 16), box("moov", 64), box("mdat", mdat)]));
const goodProbe = (over: Partial<VideoProbe> = {}, video: Partial<NonNullable<VideoProbe["video"]>> = {}): VideoProbe => ({
  formatNames: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"],
  durationSeconds: 3.667,
  videoStreams: 1,
  video: { codec: "h264", width: 1920, height: 1080, frameCount: 66, frameRate: 18, ...video },
  audio: { codec: "aac", sampleRate: 48000, channels: 1 },
  ...over,
});

describe("MP4 structure", () => {
  it("accepts a complete box sequence and records flat versus fragmented", () => {
    assert.equal(parseTopLevelBoxes(mp4Shell()).ok, true);
    const frag = new Uint8Array(Buffer.concat([box("ftyp", 16), box("moov", 64), box("moof", 32), box("mdat", 20_000)]));
    const r = validatePreviewVideo(frag, goodProbe());
    assert.ok(r.ok && r.metadata.structure === "fragmented");
  });

  it("rejects partial, padded, or non-MP4 bytes", () => {
    const full = mp4Shell();
    assert.match((parseTopLevelBoxes(full.subarray(0, full.length - 100)) as { error: string }).error, /truncated/);
    assert.equal(parseTopLevelBoxes(new Uint8Array([...full, 1, 2, 3])).ok, false);
    assert.equal(parseTopLevelBoxes(new Uint8Array(Buffer.concat([box("moov", 64), box("ftyp", 16), box("mdat", 100)]))).ok, false);
    assert.equal(parseTopLevelBoxes(new Uint8Array(Buffer.concat([box("ftyp", 16), box("mdat", 100)]))).ok, false, "no moov");
    assert.equal(parseTopLevelBoxes(new TextEncoder().encode("<html>not a video</html>")).ok, false);
  });
});

describe("preview limits", () => {
  it("accepts a 3–5 s 16:9 decodable MP4", () => {
    const r = validatePreviewVideo(mp4Shell(), goodProbe());
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.metadata.durationSeconds, 3.667);
  });

  it("rejects durations outside 3–5 s or not finite", () => {
    for (const d of [2.9, 5.1, Number.NaN, Number.POSITIVE_INFINITY, 0]) assert.equal(validatePreviewVideo(mp4Shell(), goodProbe({ durationSeconds: d })).ok, false, String(d));
  });

  it("rejects non-16:9 or unreasonable dimensions", () => {
    for (const [width, height] of [[1440, 1080], [1080, 1920], [320, 180], [7680, 4320]]) assert.equal(validatePreviewVideo(mp4Shell(), goodProbe({}, { width, height })).ok, false, `${width}×${height}`);
  });

  it("rejects missing or extra video streams, undecoded frames, unknown codecs, and size extremes", () => {
    assert.equal(validatePreviewVideo(mp4Shell(), goodProbe({ video: null, videoStreams: 0 })).ok, false);
    assert.equal(validatePreviewVideo(mp4Shell(), goodProbe({ videoStreams: 2 })).ok, false);
    assert.equal(validatePreviewVideo(mp4Shell(), goodProbe({}, { frameCount: 0 })).ok, false);
    assert.equal(validatePreviewVideo(mp4Shell(), goodProbe({}, { codec: "mjpeg" })).ok, false);
    assert.equal(validatePreviewVideo(mp4Shell(100), goodProbe()).ok, false, "implausibly small");
    assert.equal(validatePreviewVideo(mp4Shell(), goodProbe({ formatNames: ["matroska", "webm"] })).ok, false);
  });
});

const run = (bin: string, args: string[]) => new Promise<void>((resolve, reject) => execFile(bin, args, (e) => (e ? reject(e) : resolve())));
const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("decode probe (ffprobe)", { skip: hasFfmpeg ? false : "ffmpeg is not installed" }, () => {
  const make = async (dir: string, name: string, size: string, seconds: number) => {
    const file = join(dir, name);
    await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `testsrc=size=${size}:rate=18`, "-t", String(seconds), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", file]);
    return new Uint8Array(await readFile(file));
  };

  it("decodes a real MP4 and applies the limits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nf-mp4-test-"));
    try {
      const good = await make(dir, "good.mp4", "640x360", 3.667);
      const probe = await ffprobeVideo(good);
      const ok = validatePreviewVideo(good, probe);
      assert.ok(ok.ok, JSON.stringify(ok));
      assert.equal(ok.metadata.videoCodec, "h264");
      assert.equal(ok.metadata.frameCount, 66);
      const long = await make(dir, "long.mp4", "640x360", 6);
      assert.equal(validatePreviewVideo(long, await ffprobeVideo(long)).ok, false, "too long");
      const square = await make(dir, "square.mp4", "480x480", 3.667);
      assert.equal(validatePreviewVideo(square, await ffprobeVideo(square)).ok, false, "not 16:9");
      await assert.rejects(ffprobeVideo(good.subarray(0, Math.floor(good.length / 2))), /could not be decoded/, "a partial file does not decode");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
