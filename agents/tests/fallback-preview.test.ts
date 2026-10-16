import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import sharp from "sharp";
import type { PlacementPlan } from "@/agents/handoff/placement-plan";
import { SOURCE_FRAME_DISCLOSURE } from "@/agents/handoff/source-frames";
import { sha256Hex } from "@/agents/media/edited-still";
import {
  blankBorderFrames,
  ENCODING,
  executeFallbackPreview,
  filterGraph,
  identityProblems,
  KEEP_VISIBLE,
  localFfmpeg,
  MOVEMENT,
  validateFallbackRow,
  validateFallbackVideo,
  windowAt,
  type Ffmpeg,
  type FallbackProbe,
  type FallbackProvenance,
  type FallbackRequest,
} from "@/agents/media/fallback-preview";
import type { ImageEditProvider } from "@/agents/media/gemini-provider";
import { executeMotionPreview, type AttemptLedger, type MotionPreviewProvider } from "@/agents/media/motion-preview";
import { buildLuvRebrandPlanV3, buildRevisedPlan, LUV_PLAN_V2 } from "@/agents/media/plan-revisions";
import { executeStillEdit } from "@/agents/media/still-edit";
import { currentVisualDecision, recordVisualReview } from "@/agents/media/visual-review";
import type { PrivateStorage } from "@/agents/persistence/private-storage";
import { WorkflowRegistry } from "@/agents/persistence/workflow";
import { validPlacementPlan } from "./fixtures";
import { MemoryWorkflowStore } from "./memory-store";

const CASE = "NF-DEMO-0001";
const VIDEO_ID = "asset:luv-hypothesis:source-video:v1";
const VIDEO_REF = "storage://nf-media/Luv-Hypothesis/Luv.mp4";
const FRAME_ID = "asset:luv-hypothesis:source-frame:luv-scene-1:v1";
const FRAME_REF = "storage://nf-media/frames/luv-hypothesis/luv-scene-1-8s.png";
const STILL = { id: "asset:luv-hypothesis:edited-still:luv-scene-1:v3", ref: "storage://nf-media/edits/luv-hypothesis/daybreak-cold-brew-luv-scene-1-v3/edited-still-v3.png" };
const OWNER = { id: "owner-user", type: "User", role: null, name: "NativeFrame project owner" };
const BASE = "storage://nf-media/previews/luv-hypothesis/daybreak-cold-brew-luv-scene-1-v3";

/** A deterministic photo-like image (smooth gradients and soft detail): real edges, never flat padding. */
async function textured(width: number, height: number, phase = 0): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const soft = 30 * Math.sin(x / 41 + phase) * Math.cos(y / 37) + 12 * Math.sin((x + y) / 13);
      raw[i] = Math.max(0, Math.min(255, Math.round(60 + (x / width) * 140 + soft)));
      raw[i + 1] = Math.max(0, Math.min(255, Math.round(40 + (y / height) * 120 + soft * 0.8)));
      raw[i + 2] = Math.max(0, Math.min(255, Math.round(90 + 50 * Math.sin(x / 97) + 40 * Math.cos(y / 71) + soft * 0.5)));
    }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

class Storage implements PrivateStorage {
  readonly objects = new Map<string, Uint8Array>();
  uploads: string[] = [];
  async download(ref: string) {
    const o = this.objects.get(ref);
    return o ? new Uint8Array(o) : null;
  }
  async uploadNew(ref: string, bytes: Uint8Array) {
    this.uploads.push(ref);
    if (this.objects.has(ref)) return "exists" as const;
    this.objects.set(ref, new Uint8Array(bytes));
    return "created" as const;
  }
}

/** Counts every local FFmpeg invocation. */
const countingFfmpeg = () => {
  const calls: string[] = [];
  const ff: Ffmpeg = { version: () => localFfmpeg.version(), run: (tool, args) => (calls.push(tool), localFfmpeg.run(tool, args)) };
  return { ff, calls };
};

let sourceImage: Buffer;
async function world(options: { review?: "approved" | "rejected" } = {}) {
  const store = new MemoryWorkflowStore();
  const workflow = new WorkflowRegistry(store);
  const storage = new Storage();
  const frame = await sharp({ create: { width: 1280, height: 720, channels: 3, background: { r: 120, g: 90, b: 60 } } }).png().toBuffer();
  const frameSum = `sha256:${sha256Hex(frame)}`;
  const videoSum = `sha256:${"1".repeat(64)}`;
  await store.ensureCase({ case_id: CASE, title_id: "luv-hypothesis", status: "open" });
  await store.insertMediaAsset({ asset_id: VIDEO_ID, case_id: CASE, plan_id: null, kind: "source-video", storage_ref: VIDEO_REF, mime_type: "video/mp4", duration_seconds: 20.064, generator: null, model: null, generated_at: null, latency_ms: null, cost_usd: null, checksum: videoSum, provenance: { titleId: "luv-hypothesis" } });
  await store.insertMediaAsset({ asset_id: FRAME_ID, case_id: CASE, plan_id: null, kind: "source-frame", storage_ref: FRAME_REF, mime_type: "image/png", duration_seconds: null, generator: null, model: null, generated_at: null, latency_ms: null, cost_usd: null, checksum: frameSum, provenance: { sourceAssetId: VIDEO_ID, sourceStorageRef: VIDEO_REF, sourceChecksum: videoSum, sceneId: "luv-scene-1", timestampSeconds: 8 } });
  storage.objects.set(FRAME_REF, frame);
  const v1 = validPlacementPlan({ sourceMedia: { kind: "registered-source-frame", isSceneFrame: true, assetId: FRAME_ID, storageRef: FRAME_REF, checksum: frameSum, sourceAssetId: VIDEO_ID, timestampSeconds: 8, note: SOURCE_FRAME_DISCLOSURE } as PlacementPlan["sourceMedia"] });
  const v3 = buildLuvRebrandPlanV3(buildRevisedPlan(v1, LUV_PLAN_V2));
  for (const p of [v1, buildRevisedPlan(v1, LUV_PLAN_V2), v3]) assert.equal((await workflow.savePlan(p)).ok, true);
  const gemini: ImageEditProvider = { provider: "google-gemini", model: "gemini-nano-banana-2.1", edit: async () => ({ responseId: "r", images: [{ mimeType: "image/png", data: sourceImage }], text: null, usage: null }) };
  assert.ok((await executeStillEdit({ planId: v3.planId, sourceFrameAssetId: FRAME_ID, sourceFrameStorageRef: FRAME_REF, outputAssetId: STILL.id, outputStorageRef: STILL.ref }, { workflow, store, storage, provider: gemini })).ok);
  const review = await recordVisualReview({ workflow, store, assetId: STILL.id, decision: options.review ?? "approved", reasons: ["test review"], reviewer: OWNER, ownerUserId: OWNER.id });
  assert.ok(review.ok);
  const still = (await store.getMediaAsset(STILL.id))!;
  storage.uploads = [];
  const req: FallbackRequest = {
    planId: v3.planId,
    editedStillAssetId: STILL.id,
    editedStillStorageRef: STILL.ref,
    editedStillChecksum: still.checksum,
    visualReviewId: review.review.review_id,
    motionPromptSha256: sha256Hex(v3.prompts.motion.prompt),
    outputAssetId: "asset:luv-hypothesis:generated-preview:luv-scene-1:v3-fallback",
    outputStorageRef: `${BASE}/generated-preview-v3-fallback.mp4`,
    reservedReactorAssetId: "asset:luv-hypothesis:generated-preview:luv-scene-1:v3-reactor",
    reservedReactorStorageRef: `${BASE}/generated-preview-v3-reactor.mp4`,
  };
  return { store, workflow, storage, req, v3 };
}

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("fallback preview: identity and inputs", () => {
  before(async () => {
    sourceImage = await textured(1376, 768);
  });

  it("keeps the fallback identity apart from the reserved Reactor identity", () => {
    const req = {
      outputAssetId: "asset:luv-hypothesis:generated-preview:luv-scene-1:v3-fallback",
      outputStorageRef: `${BASE}/generated-preview-v3-fallback.mp4`,
      reservedReactorAssetId: "asset:luv-hypothesis:generated-preview:luv-scene-1:v3-reactor",
      reservedReactorStorageRef: `${BASE}/generated-preview-v3-reactor.mp4`,
    } as FallbackRequest;
    assert.deepEqual(identityProblems(req), []);
    assert.ok(identityProblems({ ...req, outputAssetId: req.reservedReactorAssetId }).length > 0, "may not take the Reactor ID");
    assert.ok(identityProblems({ ...req, outputStorageRef: req.reservedReactorStorageRef }).length > 0, "may not take the Reactor path");
    assert.ok(identityProblems({ ...req, outputAssetId: "asset:luv-hypothesis:generated-preview:luv-scene-1:v3" }).length > 0, "must be a -fallback ID");
    assert.ok(identityProblems({ ...req, outputStorageRef: "https://public.example/generated-preview-v3-fallback.mp4" }).length > 0, "private storage only");
  });

  it("refuses before rendering when the source is unapproved, mismatched, or tampered", async () => {
    const cases: [string, () => Promise<{ req: FallbackRequest; deps: Parameters<typeof executeFallbackPreview>[1] }>, string][] = [
      ["unapproved", async () => { const w = await world({ review: "rejected" }); return { req: w.req, deps: w }; }, "review"],
      ["checksum mismatch", async () => { const w = await world(); return { req: { ...w.req, editedStillChecksum: `sha256:${"9".repeat(64)}` }, deps: w }; }, "still"],
      ["tampered stored bytes", async () => { const w = await world(); w.storage.objects.set(STILL.ref, await textured(1280, 720, 1)); return { req: w.req, deps: w }; }, "still"],
      ["another plan", async () => { const w = await world(); return { req: { ...w.req, planId: "plan:daybreak-cold-brew:luv-scene-1:v2" }, deps: w }; }, "plan"],
      ["wrong prompt hash", async () => { const w = await world(); return { req: { ...w.req, motionPromptSha256: "0".repeat(64) }, deps: w }; }, "plan"],
    ];
    for (const [name, make, stage] of cases) {
      const { req, deps } = await make();
      const { ff, calls } = countingFfmpeg();
      const r = await executeFallbackPreview(req, { ...deps, ffmpeg: ff });
      assert.equal(r.ok, false, name);
      assert.equal((r as { stage: string }).stage, stage, name);
      assert.deepEqual(calls, [], `${name}: no render`);
      assert.equal(await deps.store.getMediaAsset(req.outputAssetId), null, `${name}: nothing registered`);
    }
  });
});

describe("fallback preview: output validation", () => {
  const box = (type: string, payload: number) => {
    const b = Buffer.alloc(8 + payload);
    b.writeUInt32BE(8 + payload, 0);
    b.write(type, 4, "ascii");
    return b;
  };
  const faststart = new Uint8Array(Buffer.concat([box("ftyp", 16), box("moov", 64), box("mdat", 20_000)]));
  const good: FallbackProbe = {
    formatNames: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"],
    durationSeconds: 3.5,
    streams: [{ codecType: "video", codec: "h264", profile: "High", pixFmt: "yuv420p", width: 1280, height: 720, rFrameRate: "30/1", avgFrameRate: "30/1", frames: 105 }],
  };
  const v = (over: Partial<FallbackProbe["streams"][0]>): FallbackProbe => ({ ...good, streams: [{ ...good.streams[0], ...over }] });

  it("accepts exactly the committed format", () => {
    const r = validateFallbackVideo(faststart, good);
    assert.ok(r.ok, JSON.stringify(r));
  });

  it("rejects wrong duration, resolution, codec, pixel format, frame rate, frame count, audio, or no fast-start", () => {
    const bad: [string, Uint8Array, FallbackProbe][] = [
      ["2.9 s", faststart, { ...good, durationSeconds: 2.9 }],
      ["4.1 s", faststart, { ...good, durationSeconds: 4.1 }],
      ["1920×1080", faststart, v({ width: 1920, height: 1080 })],
      ["hevc", faststart, v({ codec: "hevc" })],
      ["yuv444p", faststart, v({ pixFmt: "yuv444p" })],
      ["variable frame rate", faststart, v({ avgFrameRate: "2997/100" })],
      ["missing frames", faststart, v({ frames: 104 })],
      ["audio", faststart, { ...good, streams: [...good.streams, { ...good.streams[0], codecType: "audio", codec: "aac" }] }],
      ["moov after mdat", new Uint8Array(Buffer.concat([box("ftyp", 16), box("mdat", 20_000), box("moov", 64)])), good],
    ];
    for (const [name, bytes, probe] of bad) assert.equal(validateFallbackVideo(bytes, probe).ok, false, name);
  });

  it("flags any frame with a flat (blank) edge strip, and keeps the important content inside every window", () => {
    assert.deepEqual(blankBorderFrames([{ top: 200, bottom: 120, left: 8, right: 240 }]), [], "a dark but real edge is not blank");
    assert.deepEqual(blankBorderFrames([{ top: 200, bottom: 120, left: 8, right: 240 }, { top: 0, bottom: 120, left: 8, right: 240 }, { top: 90, bottom: 2, left: 30, right: 40 }]), [1, 2]);
    for (let n = 0; n < MOVEMENT.frames; n++) {
      const w = windowAt(n);
      assert.ok(w.zoom >= 1 && w.left >= 0 && w.top >= 0 && w.right <= 1280 + 1e-9 && w.bottom <= 720 + 1e-9, `frame ${n} stays inside the image`);
      assert.ok(w.left <= KEEP_VISIBLE.left && w.top <= KEEP_VISIBLE.top && w.right >= KEEP_VISIBLE.right && w.bottom >= KEEP_VISIBLE.bottom, `frame ${n} keeps the cups and faces`);
    }
    assert.deepEqual(windowAt(0), { zoom: 1, left: 0, top: 0, right: 1280, bottom: 720 }, "the first frame is the whole still");
    assert.match(filterGraph(), /^scale=5120:2880:flags=lanczos,zoompan=/);
    assert.ok(!/minterpolate|framerate|drawtext|overlay|pad=/.test(filterGraph()), "no interpolation, overlays, or padding");
    assert.ok(ENCODING.includes("-an") && ENCODING.includes("+faststart") && ENCODING.includes("yuv420p"));
  });
});

describe("fallback preview: deterministic generation (local FFmpeg)", { skip: hasFfmpeg ? false : "ffmpeg is not installed" }, () => {
  let created: { checksum: string; bytes: Uint8Array } | null = null;
  const realFetch = globalThis.fetch;
  let fetches = 0;
  let keep: string;
  before(async () => {
    sourceImage = await textured(1376, 768);
    keep = await mkdtemp(join(tmpdir(), "nf-fallback-keep-"));
    globalThis.fetch = (async () => {
      fetches++;
      throw new Error("no network in the fallback");
    }) as typeof fetch;
  });
  after(async () => {
    globalThis.fetch = realFetch;
    await rm(keep, { recursive: true, force: true });
  });

  it("renders, validates, uploads privately, registers once, reads back, and reuses without re-rendering", async () => {
    const w = await world();
    const { ff, calls } = countingFfmpeg();
    const r = await executeFallbackPreview(w.req, { ...w, ffmpeg: ff, keepDir: keep });
    assert.ok(r.ok && r.status === "created", JSON.stringify(r));
    assert.equal(fetches, 0, "no network or provider request");
    assert.deepEqual(w.storage.uploads, [w.req.outputStorageRef], "one private upload at the fallback path");
    const row = (await w.store.getMediaAsset(w.req.outputAssetId))!;
    assert.deepEqual(validateFallbackRow(row, w.req, CASE), []);
    const p = row.provenance as FallbackProvenance;
    assert.deepEqual(
      [p.generator, p.origin, p.fallback, p.externalProvider, p.paidApi, p.humanVisualReview, p.releaseStatus],
      ["local-ffmpeg", "deterministic-motion-preview", true, "none", false, "pending", "not reviewed and not approved"],
    );
    assert.deepEqual(p.sourceEditedStill, { assetId: STILL.id, storageRef: STILL.ref, checksum: w.req.editedStillChecksum });
    assert.equal(p.inputPlanId, w.v3.planId);
    assert.equal(p.motionPromptSha256, w.req.motionPromptSha256);
    assert.match(p.ffmpegVersion, /^ffmpeg version /);
    assert.equal(p.filterGraph, filterGraph());
    assert.deepEqual([p.video.width, p.video.height, p.video.codec, p.video.pixelFormat, p.video.frameRate, p.video.frameCount, p.video.audio], [1280, 720, "h264", "yuv420p", 30, 105, false]);
    assert.ok(p.durationSeconds >= 3 && p.durationSeconds <= 4);
    assert.equal(p.checks.blankBorderFrames, 0);
    assert.equal(p.checks.deterministicRenders, 2);
    assert.ok(p.checks.firstFramePsnrDb >= 35 && p.checks.finalFramePsnrDb >= 30);
    assert.match(p.reactorContext, /remained unavailable for download/);
    assert.equal(p.outputChecksum, row.checksum);
    assert.equal(JSON.stringify(row).includes("https://"), false, "no URLs in the record");
    assert.equal(Number(row.cost_usd), 0);
    const localCopy = await readFile(r.localCopy!);
    assert.equal(`sha256:${sha256Hex(localCopy)}`, row.checksum, "the inspection copy is the registered bytes");
    created = { checksum: row.checksum, bytes: new Uint8Array(localCopy) };

    // Isolation: the Reactor identity stays unused, and the fallback never blocks a Reactor run.
    assert.equal(await w.store.getMediaAsset(w.req.reservedReactorAssetId), null);
    assert.equal(w.storage.objects.has(w.req.reservedReactorStorageRef), false);
    const throwing: MotionPreviewProvider = { provider: "reactor", model: "reactor/visko-orbis-stable", generate: async () => Promise.reject(new Error("not called in this test")) };
    const ledger: AttemptLedger = { claim: async () => "claimed", has: async () => false, recordOutcome: async () => {} };
    const reactorRun = await executeMotionPreview(
      { ...w.req, outputAssetId: w.req.reservedReactorAssetId, outputStorageRef: w.req.reservedReactorStorageRef, seed: 42, resolution: "1080p" },
      { workflow: w.workflow, store: w.store, storage: w.storage, provider: throwing, ledger, probe: async () => Promise.reject(new Error("unused")), costRate: { usdPerSecond: 0.01, source: "test", retrievedAt: "2026-10-16T00:00:00.000Z" } },
    );
    assert.equal((reactorRun as { stage: string }).stage, "provider", "a Reactor run proceeds past idempotency: the fallback does not block it");
    assert.equal(fetches, 0);

    // With exactly one preview the per-plan loader resolves it; with two it refuses to choose (persistence tests).
    assert.equal((await w.workflow.loadGeneratedPreview(w.v3.planId)).ok, true, "one preview: the fallback");

    // Reuse: identical registered output, no FFmpeg at all.
    const callsBefore = calls.length;
    const again = await executeFallbackPreview(w.req, { ...w, ffmpeg: ff });
    assert.ok(again.ok && again.status === "reused" && again.checksum === row.checksum);
    assert.equal(calls.length, callsBefore, "reuse runs no FFmpeg");
    assert.deepEqual(w.storage.uploads, [w.req.outputStorageRef], "no second upload");
  });

  it("refuses a conflicting object at the fallback path, and registers nothing", async () => {
    const w = await world();
    w.storage.objects.set(w.req.outputStorageRef, new Uint8Array([1, 2, 3]));
    const r = await executeFallbackPreview(w.req, w);
    assert.equal(r.ok, false);
    assert.equal((r as { stage: string }).stage, "upload");
    assert.equal(await w.store.getMediaAsset(w.req.outputAssetId), null);
  });

  it("is deterministic across independent runs: identical source, identical checksum", async () => {
    assert.ok(created, "the first generation ran");
    const w = await world();
    w.storage.objects.set(w.req.outputStorageRef, created!.bytes);
    const r = await executeFallbackPreview(w.req, w);
    assert.ok(r.ok && r.status === "created", JSON.stringify(r));
    assert.equal(r.checksum, created!.checksum);
    assert.deepEqual(w.storage.uploads, [], "the identical object already there is not re-uploaded");
    // A second preview for the plan: the per-plan loader (used by the Governor) refuses to choose between them.
    const second = await w.workflow.registerMediaAsset({
      assetId: "asset:luv-hypothesis:generated-preview:luv-scene-1:v3-other", caseId: CASE, planId: w.v3.planId, kind: "generated-preview",
      storageRef: `${BASE}/other.mp4`, mimeType: "video/mp4", durationSeconds: 3.5, generator: "reactor", model: "reactor/visko-orbis-stable",
      generatedAt: "2026-10-16T18:00:00.000Z", latencyMs: 1, costUsd: 0.1, checksum: `sha256:${"2".repeat(64)}`,
      provenance: { generator: "reactor", generatedAt: "2026-10-16T18:00:00.000Z", inputPlanId: w.v3.planId },
    });
    assert.ok(second.ok);
    const chosen = await w.workflow.loadGeneratedPreview(w.v3.planId);
    assert.equal(chosen.ok, false);
    assert.match((chosen as { errors: string[] }).errors[0], /select one by asset ID/);
  });

  it("refuses a registered fallback whose record or bytes were altered", async () => {
    const w = await world();
    w.storage.objects.set(w.req.outputStorageRef, created!.bytes);
    assert.ok((await executeFallbackPreview(w.req, w)).ok);
    const row = (await w.store.getMediaAsset(w.req.outputAssetId))!;
    const p = row.provenance as FallbackProvenance;
    for (const [name, alt] of [
      ["generator", { ...row, generator: "reactor" }],
      ["fallback flag", { ...row, provenance: { ...p, fallback: false } }],
      ["source", { ...row, provenance: { ...p, sourceEditedStill: { ...p.sourceEditedStill, checksum: `sha256:${"0".repeat(64)}` } } }],
      ["filter", { ...row, provenance: { ...p, filterGraph: "scale=1280:720" } }],
      ["approved", { ...row, provenance: { ...p, humanVisualReview: "approved" } }],
      ["checksum", { ...row, provenance: { ...p, outputChecksum: `sha256:${"1".repeat(64)}` } }],
    ] as const) assert.ok(validateFallbackRow(alt, w.req, CASE).length > 0, name);
    w.storage.objects.set(w.req.outputStorageRef, new Uint8Array([9]));
    const r = await executeFallbackPreview(w.req, w);
    assert.equal(r.ok, false);
    assert.equal((r as { stage: string }).stage, "idempotency");
  });
  it("records one immutable human visual review of the registered fallback, revalidating every binding", async () => {
    const w = await world();
    w.storage.objects.set(w.req.outputStorageRef, created!.bytes);
    assert.ok((await executeFallbackPreview(w.req, w)).ok);
    const id = w.req.outputAssetId;
    const row = (await w.store.getMediaAsset(id))!;
    const reviewOf = (over: Partial<Parameters<typeof recordVisualReview>[0]> = {}) =>
      recordVisualReview({ workflow: w.workflow, store: w.store, storage: w.storage, assetId: id, decision: "approved", reasons: ["Disclosed local fallback."], reviewer: OWNER, ownerUserId: OWNER.id, ...over });

    assert.equal((await reviewOf({ storage: undefined })).ok, false, "a preview's private bytes must be revalidated");
    assert.equal((await reviewOf({ reviewer: { ...OWNER, id: "someone-else" } })).ok, false, "the human owner only");
    assert.equal((await reviewOf({ reviewer: { ...OWNER, type: "Agent" } })).ok, false, "a human only");
    assert.equal((await reviewOf({ assetId: w.req.reservedReactorAssetId })).ok, false, "an unregistered preview cannot be reviewed");
    assert.equal(await w.store.getVisualReview(id), null, "nothing written by refused reviews");

    const r = await reviewOf();
    assert.ok(r.ok && r.status === "created", JSON.stringify(r));
    assert.deepEqual([r.review.asset_id, r.review.decision, r.review.asset_checksum, r.review.case_id, r.review.reviewer_user_id], [id, "approved", row.checksum, CASE, OWNER.id]);
    assert.equal(await currentVisualDecision(w.store, id), "approved");
    const replay = await reviewOf();
    assert.ok(replay.ok && replay.status === "existing" && replay.review.review_id === r.review.review_id, "an identical replay returns the same review");
    assert.equal((await reviewOf({ decision: "rejected", reasons: ["Changed."] })).ok, false, "reviews are immutable");
    await assert.rejects(w.store.updateMediaAsset(id, { duration_seconds: 3.6 }), "a reviewed asset is immutable");
    assert.deepEqual(await w.store.getMediaAsset(id), row, "the asset record is unchanged");
    assert.equal((row.provenance as FallbackProvenance).humanVisualReview, "pending", "generation-time provenance is never rewritten");
    assert.equal(await w.store.getMediaAsset(w.req.reservedReactorAssetId), null, "the Reactor identity stays unused");
    assert.equal(await w.store.getVisualReview(w.req.reservedReactorAssetId), null);
  });

  it("refuses to review a fallback whose bytes or bindings no longer revalidate", async () => {
    const w = await world();
    w.storage.objects.set(w.req.outputStorageRef, created!.bytes);
    assert.ok((await executeFallbackPreview(w.req, w)).ok);
    const id = w.req.outputAssetId;
    const row = (await w.store.getMediaAsset(id))!;
    const p = row.provenance as FallbackProvenance;
    const reviewOf = () => recordVisualReview({ workflow: w.workflow, store: w.store, storage: w.storage, assetId: id, decision: "approved", reasons: [], reviewer: OWNER, ownerUserId: OWNER.id });
    const tampered: [string, Partial<typeof row>][] = [
      ["source still checksum", { provenance: { ...p, sourceEditedStill: { ...p.sourceEditedStill, checksum: `sha256:${"0".repeat(64)}` } } }],
      ["source still review", { provenance: { ...p, visualReview: { ...p.visualReview, reviewId: "another-review" } } }],
      ["motion prompt", { provenance: { ...p, motionPromptSha256: "0".repeat(64) } }],
      ["another plan", { plan_id: "plan:daybreak-cold-brew:luv-scene-1:v2" }],
      ["unknown generator", { generator: "something-else" }],
      ["not a fallback", { provenance: { ...p, fallback: false } }],
    ];
    for (const [name, patch] of tampered) {
      await w.store.updateMediaAsset(id, patch);
      assert.equal((await reviewOf()).ok, false, name);
      await w.store.updateMediaAsset(id, row);
    }
    w.storage.objects.set(w.req.outputStorageRef, new Uint8Array([9]));
    assert.equal((await reviewOf()).ok, false, "tampered stored bytes");
    assert.equal(await w.store.getVisualReview(id), null, "no review was recorded");
    w.storage.objects.set(w.req.outputStorageRef, created!.bytes);
    assert.ok((await reviewOf()).ok, "the restored, untampered fallback is reviewable");
  });
});
