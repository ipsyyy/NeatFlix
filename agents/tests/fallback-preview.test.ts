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
import { RELEASE_GOVERNOR_DISCLOSURE, validateResult } from "@/agents/handoff/output-rules";
import { extractHandoffs } from "@/agents/handoff/protocol";
import { stampOutgoingContent } from "@/agents/handoff/stamp";
import { deriveVisualDisclosure, staticDisclosureRegistry } from "@/agents/media/derived-disclosure";
import { evaluatePreviewEvidence } from "@/agents/media/preview-evidence";
import { PersistentSourceFrameRegistry } from "@/agents/persistence/source-frames";
import { canonical, PersistentPreviewRegistry } from "@/agents/persistence/workflow";
import { AcceptedPlanRegistry } from "@/agents/runtime/accepted-plans";
import { buildDirectorDelivery, guardedSaveGovernorReview, preflightGovernorDelivery, type DeliveryPin } from "@/agents/runtime/governor-delivery";
import { checkApprovalReasons, preflightHumanApproval, recordPinnedHumanApproval, type ApprovalPin } from "@/agents/runtime/human-approval-recorder";
import { AUTHORIZED_REASONS } from "@/agents/runtime/plan-v3-approval";
import { readFileSync } from "node:fs";
import { toolsForRole } from "@/agents/tools/evidence-tools";
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
    const evidence = () => evaluatePreviewEvidence({ workflow: w.workflow, store: w.store, storage: w.storage }, w.v3.planId);
    assert.equal((await evidence()).outcome, "fail", "the Governor's technical check fails until the owner's review exists");

    const r = await reviewOf();
    assert.ok(r.ok && r.status === "created", JSON.stringify(r));
    assert.deepEqual([r.review.asset_id, r.review.decision, r.review.asset_checksum, r.review.case_id, r.review.reviewer_user_id], [id, "approved", row.checksum, CASE, OWNER.id]);
    assert.equal(await currentVisualDecision(w.store, id), "approved");
    const passed = await evidence();
    assert.deepEqual([passed.outcome, passed.assetId, passed.checksum, passed.visualReviewId], ["pass", id, row.checksum, r.review.review_id], passed.detail);
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

/** The disclosure the human owner specified for plan v3, which the provenance must reproduce exactly. */
const V3_DISCLOSURE =
  "The current visual is derived from the registered LUV source frame. Gemini edited only the two existing cup surfaces to apply Daybreak Cold Brew branding, and the approved local FFmpeg fallback generated a deterministic motion preview. No new cup or product object was inserted.";

describe("plan delivery with a provenance-derived disclosure (local fallback)", { skip: hasFfmpeg ? false : "ffmpeg is not installed" }, () => {
  /** One real render, registered byte-identically in each world under that world's own still review. */
  let template: { row: Awaited<ReturnType<MemoryWorkflowStore["getMediaAsset"]>> & object; bytes: Uint8Array };
  before(async () => {
    sourceImage = await textured(1376, 768);
    const w = await world();
    const r = await executeFallbackPreview(w.req, w);
    assert.ok(r.ok, JSON.stringify(r));
    template = { row: (await w.store.getMediaAsset(w.req.outputAssetId))!, bytes: w.storage.objects.get(w.req.outputStorageRef)! };
  });

  async function pinned(options: { stillReview?: "approved" | "rejected"; previewReview?: "approved" | "rejected" | null } = {}) {
    const w = await world({ review: options.stillReview ?? "approved" });
    const { created_at: _created, ...row } = structuredClone(template.row);
    void _created;
    const p = row.provenance as FallbackProvenance;
    await w.store.insertMediaAsset({ ...row, provenance: { ...p, visualReview: { ...p.visualReview, reviewId: w.req.visualReviewId } } });
    w.storage.objects.set(w.req.outputStorageRef, template.bytes);
    const id = w.req.outputAssetId;
    const previewReview = options.previewReview === undefined ? "approved" : options.previewReview;
    if (previewReview) assert.ok((await recordVisualReview({ workflow: w.workflow, store: w.store, storage: w.storage, assetId: id, decision: previewReview, reasons: ["Owner decision."], reviewer: OWNER, ownerUserId: OWNER.id })).ok);
    const stored = await w.workflow.loadPlan(w.v3.planId);
    assert.ok(stored.ok);
    const pin: DeliveryPin = {
      caseId: CASE,
      planId: w.v3.planId,
      planSha256: sha256Hex(canonical(stored.value)),
      previewAssetId: id,
      previewChecksum: template.row.checksum,
      visualReviewId: (await w.store.getVisualReview(id))?.review_id ?? "none",
    };
    const evidence = (planId: string) => evaluatePreviewEvidence({ workflow: w.workflow, store: w.store, storage: w.storage }, planId);
    const deps = { workflow: w.workflow, store: w.store, evidence };
    const frames = new PersistentSourceFrameRegistry(w.workflow);
    await frames.refreshScene(CASE, "luv-scene-1");
    return { ...w, id, pin, deps, frames, plan: stored.value };
  }
  type Pinned = Awaited<ReturnType<typeof pinned>>;

  /** An approve-for-human-review that copies the Governor's tool results verbatim. */
  async function approval(p: Pinned, over: Record<string, unknown> = {}) {
    const previews = new PersistentPreviewRegistry(p.workflow);
    await previews.refresh(p.pin.planId);
    const tools = toolsForRole("release-governor", { plans: new AcceptedPlanRegistry(p.workflow), previews, frames: p.frames, previewEvidence: p.deps.evidence });
    const check = (await tools[0].handler({ planId: p.pin.planId })) as { checks: { id: string; category: string; outcome: string; detail: string }[] };
    const status = (await tools[1].handler({ planId: p.pin.planId })) as Record<string, unknown>;
    const review = {
      kind: "governor-review", version: 1, reviewId: `review:${p.pin.planId}:r1`, caseId: CASE,
      subject: { titleId: "luv-hypothesis", sceneId: "luv-scene-1", campaignId: "daybreak-cold-brew", planId: p.pin.planId },
      decision: "approve-for-human-review",
      hhh: { helpful: { outcome: "pass", rationale: "Actionable." }, honest: { outcome: "pass", rationale: "Cites tools." }, harmless: { outcome: "pass", rationale: "No veto." } },
      checks: check.checks.map((c) => ({ ...c, source: `nativeframe_check_placement_plan.checks[${c.id}]` })),
      evidence: [{ claim: "A preview is registered.", source: "nativeframe_get_preview_status" }],
      blockers: [], corrections: [], assumptions: ["Demo fixtures."], uncertainty: "Human approval is still required.",
      preview: { status: "provided", assetRef: status.assetRef, provenance: status.provenance, generationMetadata: status.generationMetadata },
      humanApproval: { status: "pending" },
      ...over,
    };
    return {
      caseId: CASE, artifactId: p.pin.planId, senderRole: "release-governor", recipientRole: "human-reviewer", decision: review.decision,
      evidence: review.evidence, confidence: 0.8, assumptions: [], blockers: [], nextAction: "Human owner decides.", timestamp: new Date().toISOString(), artifact: review,
    };
  }

  /** Asserts the guard refused and nothing was written. */
  async function refused(p: Pinned, result: { ok: boolean }, name: string, status = "open") {
    assert.equal(result.ok, false, name);
    assert.equal(p.store.reviews.size, 0, `${name}: no review written`);
    assert.equal((await p.store.getCase(CASE))!.status, status, `${name}: case status unchanged`);
  }

  it("derives exactly the specified v3 disclosure from registered provenance", async () => {
    const p = await pinned();
    const state = await deriveVisualDisclosure(p.deps, p.pin.planId);
    assert.ok(state.status === "derived", JSON.stringify(state));
    assert.equal(state.disclosure, V3_DISCLOSURE);
    assert.deepEqual(
      [state.facts.sourceFrameAssetId, state.facts.editedStill.assetId, state.facts.editedStill.visualReviewId, state.facts.preview.assetId, state.facts.preview.checksum, state.facts.cups, state.facts.brand],
      ["asset:luv-hypothesis:source-frame:luv-scene-1:v1", STILL.id, p.req.visualReviewId, p.id, template.row.checksum, 2, "Daybreak Cold Brew"],
    );
    assert.deepEqual(await deriveVisualDisclosure(p.deps, "plan:daybreak-cold-brew:luv-scene-1:v1"), { status: "unedited" }, "a plan with no derived media keeps the historical disclosure");
  });

  it("derives nothing when any provenance element is absent, mismatched, or unsupported", async () => {
    const invalid = async (p: Pinned, name: string) => assert.equal((await deriveVisualDisclosure(p.deps, p.pin.planId)).status, "invalid", name);
    await invalid(await pinned({ previewReview: null }), "preview review missing");
    await invalid(await pinned({ previewReview: "rejected" }), "preview review rejected");
    await invalid(await pinned({ stillReview: "rejected", previewReview: null }), "edited-still review rejected");

    const p = await pinned({ previewReview: null });
    const row = (await p.store.getMediaAsset(p.id))!;
    const prov = row.provenance as FallbackProvenance;
    assert.ok((await recordVisualReview({ workflow: p.workflow, store: p.store, storage: p.storage, assetId: p.id, decision: "approved", reasons: [], reviewer: OWNER, ownerUserId: OWNER.id })).ok);
    await invalid({ ...p, deps: { ...p.deps, evidence: undefined as never } }, "no evidence source");
    p.storage.objects.set(p.req.outputStorageRef, new Uint8Array([3]));
    await invalid(p, "preview bytes differ");
    p.storage.objects.set(p.req.outputStorageRef, template.bytes);
    assert.equal((await deriveVisualDisclosure(p.deps, p.pin.planId)).status, "derived", "restored");

    const q = await pinned({ previewReview: null });
    await q.store.updateMediaAsset(q.id, { provenance: { ...prov, visualReview: { ...prov.visualReview, reviewId: q.req.visualReviewId }, sourceEditedStill: { ...prov.sourceEditedStill, checksum: `sha256:${"0".repeat(64)}` } } });
    await invalid(q, "preview names other still bytes");
    const stillRow = (await q.store.getMediaAsset(STILL.id))!;
    q.store.media.set(STILL.id, { ...stillRow, generator: "another-editor" });
    await invalid(q, "unsupported editor");

    const r = await pinned();
    const planRow = r.store.plans.get(r.pin.planId)!;
    const plan = planRow.plan as { rebrand: Record<string, unknown> };
    r.store.plans.set(r.pin.planId, { ...planRow, plan: { ...plan, rebrand: { ...plan.rebrand, addedObjects: 1, cupsAfter: 3 } } });
    await invalid(r, "plan adds an object");

    const t = await pinned();
    await t.store.insertMediaAsset({ ...(await t.store.getMediaAsset(STILL.id))!, asset_id: `${STILL.id}-copy`, storage_ref: `${STILL.ref}.copy` });
    await invalid(t, "two edited stills");
  });

  it("requires the exact derived wording, never the historical sentence, and keeps the historical path unchanged", async () => {
    const p = await pinned();
    const pre = await preflightGovernorDelivery(p.deps, p.pin);
    assert.ok(pre.ok, JSON.stringify(pre));
    assert.equal(pre.value.disclosure, V3_DISCLOSURE);
    const draft = buildDirectorDelivery(pre.value.plan, { governorMention: "@release-governor", frames: p.frames, disclosure: pre.value.disclosure });
    assert.ok(draft.ok, JSON.stringify(draft));
    const readableText = draft.value.draftContent.slice(0, draft.value.draftContent.indexOf("```"));
    assert.ok(readableText.includes(V3_DISCLOSURE) && !readableText.includes(SOURCE_FRAME_DISCLOSURE), "the readable result states only the derived disclosure");
    const stamped = stampOutgoingContent(draft.value.draftContent, new Date(), draft.value.registries);
    assert.ok(stamped.ok, JSON.stringify(stamped));
    const [block] = extractHandoffs(stamped.content);
    assert.ok(block.ok);
    const envelope = block.value as Parameters<typeof validateResult>[0];
    const derived = { disclosures: staticDisclosureRegistry(p.pin.planId, { status: "derived", disclosure: V3_DISCLOSURE }) };
    const base = `Plan unchanged. The plan record labels both generation prompts as not executed. ${RELEASE_GOVERNOR_DISCLOSURE}`;
    assert.deepEqual(validateResult(envelope, `${base} ${V3_DISCLOSURE}`, derived), []);
    const errors = (readable: string, registries: Parameters<typeof validateResult>[2] = derived) => validateResult(envelope, readable, registries);
    assert.ok(errors(`${base} ${V3_DISCLOSURE.replace("two", "three")}`).some((e) => /must contain exactly/.test(e)), "altered wording");
    assert.ok(errors(`${base} ${SOURCE_FRAME_DISCLOSURE}`).length > 0, "the historical sentence alone");
    assert.ok(errors(`${base} ${V3_DISCLOSURE} ${SOURCE_FRAME_DISCLOSURE}`).some((e) => /do not state that no edit/.test(e)), "both sentences");
    assert.ok(errors(`${base} ${V3_DISCLOSURE} Reactor generated the preview.`).some((e) => /No generation has run/.test(e)), "a generation claim outside the derived sentence");
    const invalidState = { disclosures: staticDisclosureRegistry(p.pin.planId, { status: "invalid", errors: ["x"] }) };
    assert.ok(errors(`${base} ${SOURCE_FRAME_DISCLOSURE}`, invalidState).some((e) => /does not validate/.test(e)), "invalid provenance fails closed");
    // Historical path: no registry, or an unedited plan, still requires the original sentence and refuses generation claims.
    const unedited = { disclosures: staticDisclosureRegistry(p.pin.planId, { status: "unedited" }) };
    for (const registries of [{}, unedited]) {
      assert.deepEqual(errors(`${base} ${SOURCE_FRAME_DISCLOSURE}`, registries), []);
      assert.ok(errors(`${base} ${V3_DISCLOSURE}`, registries).some((e) => /must contain exactly/.test(e) || /No generation has run/.test(e)));
    }
    assert.equal(buildDirectorDelivery(pre.value.plan, { governorMention: "@g", frames: p.frames, disclosure: SOURCE_FRAME_DISCLOSURE }).ok, false, "the builder refuses the historical sentence");
  });

  it("delivers the stored plan byte-identically and saves one approval only through the guard", async () => {
    const p = await pinned();
    const pre = await preflightGovernorDelivery(p.deps, p.pin);
    assert.ok(pre.ok, JSON.stringify(pre));
    const draft = buildDirectorDelivery(pre.value.plan, { governorMention: "@release-governor", frames: p.frames, disclosure: pre.value.disclosure });
    assert.ok(draft.ok, JSON.stringify(draft));
    const stamped = stampOutgoingContent(draft.value.draftContent, new Date(), draft.value.registries);
    assert.ok(stamped.ok, JSON.stringify(stamped));
    const [block] = extractHandoffs(stamped.content);
    assert.ok(block.ok);
    const carried = (block.value as { artifact: unknown }).artifact;
    assert.equal(canonical(carried), canonical(p.plan), "the delivered plan is byte-identical to the stored plan");
    const plansBefore = structuredClone([...p.store.plans.values()]);
    assert.deepEqual(await new AcceptedPlanRegistry(p.workflow).record(carried as typeof p.plan), [], "the gate accepts it");
    assert.deepEqual([...p.store.plans.values()], plansBefore, "the gate's re-save writes nothing");

    const saved = await guardedSaveGovernorReview(p.deps, p.pin, await approval(p));
    assert.ok(saved.ok, JSON.stringify(saved));
    const row = (await p.store.getReview(`review:${p.pin.planId}:r1`))!;
    assert.deepEqual([row.decision, row.preview_asset_id, row.plan_id], ["approve-for-human-review", p.id, p.pin.planId]);
    assert.equal((await p.store.getCase(CASE))!.status, "awaiting-human-review");
    assert.equal(p.store.approvals.size, 0, "no human approval");

    const again = await preflightGovernorDelivery(p.deps, p.pin);
    assert.equal(again.ok, false, "duplicate delivery");
    assert.ok((again as { errors: string[] }).errors.some((e) => /already has a Governor review/.test(e)) && (again as { errors: string[] }).errors.some((e) => /not "open"/.test(e)));
    assert.equal((await guardedSaveGovernorReview(p.deps, p.pin, await approval(p, { reviewId: `review:${p.pin.planId}:r2` }))).ok, false);
    assert.equal(p.store.reviews.size, 1);
  });

  it("refuses an altered plan or hash, a changed case, an existing review, or a changed preview", async () => {
    const p = await pinned();
    await refused(p, await guardedSaveGovernorReview(p.deps, { ...p.pin, planSha256: "0".repeat(64) }, await approval(p)), "wrong pinned hash");
    await refused(p, await guardedSaveGovernorReview(p.deps, { ...p.pin, previewChecksum: `sha256:${"0".repeat(64)}` }, await approval(p)), "pinned checksum differs");
    const env = await approval(p);
    p.storage.objects.set(p.req.outputStorageRef, new Uint8Array([1]));
    await refused(p, await guardedSaveGovernorReview(p.deps, p.pin, env), "bytes altered after the Governor's turn");
    p.storage.objects.set(p.req.outputStorageRef, template.bytes);
    const planRow = p.store.plans.get(p.pin.planId)!;
    p.store.plans.set(p.pin.planId, { ...planRow, plan: { ...(planRow.plan as object), assumptions: ["Altered."] } });
    await refused(p, await guardedSaveGovernorReview(p.deps, p.pin, env), "altered stored plan");
    p.store.plans.set(p.pin.planId, planRow);
    await p.store.setCaseStatus(CASE, "stopped");
    await refused(p, await guardedSaveGovernorReview(p.deps, p.pin, env), "case stopped", "stopped");

    const q = await pinned();
    await q.store.insertReview({ review_id: "review:earlier:r1", case_id: CASE, plan_id: q.pin.planId, preview_asset_id: null, decision: "revise", review: {} });
    assert.equal((await preflightGovernorDelivery(q.deps, q.pin)).ok, false);
    assert.equal((await guardedSaveGovernorReview(q.deps, q.pin, await approval(q))).ok, false);
    assert.equal(q.store.reviews.size, 1, "only the earlier review");
  });

  it("refuses a missing or rejected visual review, non-passing evidence, or any non-approval result", async () => {
    for (const previewReview of [null, "rejected"] as const) {
      const p = await pinned({ previewReview });
      assert.equal((await preflightGovernorDelivery(p.deps, p.pin)).ok, false, String(previewReview));
    }
    const p = await pinned();
    const env = await approval(p);
    for (const outcome of ["fail", "not-evaluated"] as const) {
      const deps = { ...p.deps, evidence: async () => ({ outcome, detail: "Stub.", assetId: p.id, checksum: p.pin.previewChecksum, visualReviewId: p.pin.visualReviewId }) };
      await refused(p, await guardedSaveGovernorReview(deps, p.pin, env), `evidence ${outcome} at save time`);
    }
    await refused(p, await guardedSaveGovernorReview(p.deps, { ...p.pin, visualReviewId: "another-review" }, env), "a different approved review");
    await refused(p, await guardedSaveGovernorReview(p.deps, p.pin, { ...env, decision: "revise", recipientRole: "placement-director", artifact: { ...env.artifact, decision: "revise" } }), "revise");
    await refused(p, await guardedSaveGovernorReview(p.deps, p.pin, { ...env, decision: "stop", artifact: { ...env.artifact, decision: "stop" } }), "stop");
    const notEvaluated = await approval(p, { checks: env.artifact.checks.map((c) => (c.id === "preview-visual-quality" ? { ...c, outcome: "not-evaluated" } : c)) });
    await refused(p, await guardedSaveGovernorReview(p.deps, p.pin, notEvaluated), "technical check not passing");
    await refused(p, await guardedSaveGovernorReview(p.deps, p.pin, await approval(p, { preview: { ...env.artifact.preview, assetRef: "storage://nf-media/other.mp4" } })), "names another preview");
    await refused(p, await guardedSaveGovernorReview(p.deps, p.pin, { ...env, caseId: "NF-DEMO-PRO-0001" }), "another case");
    await refused(p, await guardedSaveGovernorReview(p.deps, p.pin, "not an envelope"), "malformed");
    assert.ok((await guardedSaveGovernorReview(p.deps, p.pin, env)).ok, "the passing approval still saves afterwards");
  });

  /** A world whose plan has a guarded approve-for-human-review, so the case awaits human review. */
  async function awaiting() {
    const p = await pinned();
    assert.ok((await guardedSaveGovernorReview(p.deps, p.pin, await approval(p))).ok);
    const pin: ApprovalPin = {
      caseId: CASE,
      planId: p.pin.planId,
      planSha256: p.pin.planSha256,
      reviewId: `review:${p.pin.planId}:r1`,
      previewAssetId: p.id,
      previewChecksum: p.pin.previewChecksum,
      visualReviewId: p.pin.visualReviewId,
    };
    const owner = { sender: { id: OWNER.id, type: "User", role: null }, ownerUserId: OWNER.id, approverName: "NativeFrame project owner" };
    return { ...p, approvalPin: pin, owner };
  }
  type Awaiting = Awaited<ReturnType<typeof awaiting>>;
  const record = (a: Awaiting, over: { pin?: Partial<ApprovalPin>; reasons?: readonly unknown[]; sender?: { id: string; type: string; role: string | null }; approverName?: string } = {}) =>
    recordPinnedHumanApproval(a.deps, { ...a.approvalPin, ...over.pin }, {
      ...a.owner,
      ...(over.sender ? { sender: over.sender } : {}),
      ...(over.approverName !== undefined ? { approverName: over.approverName } : {}),
      reasons: over.reasons ?? AUTHORIZED_REASONS,
      expectedReasons: AUTHORIZED_REASONS,
    });
  /** Asserts the recorder refused and nothing was written. */
  async function notApproved(a: Awaiting, result: { ok: boolean }, name: string, status = "awaiting-human-review") {
    assert.equal(result.ok, false, name);
    assert.equal(a.store.approvals.size, 0, `${name}: no approval written`);
    assert.equal((await a.store.getCase(CASE))!.status, status, `${name}: case status unchanged`);
  }

  it("holds exactly the six authorized reasons, each valid for the database check", () => {
    assert.equal(AUTHORIZED_REASONS.length, 6);
    assert.deepEqual(checkApprovalReasons(AUTHORIZED_REASONS, AUTHORIZED_REASONS), []);
    assert.ok(AUTHORIZED_REASONS.every((r) => r.trim() === r && r.length <= 500));
    assert.ok(AUTHORIZED_REASONS[4].includes("“not-executed”") && AUTHORIZED_REASONS[3].startsWith("The Release Governor’s "), "typographic characters kept exactly");
  });

  it("records one approval with exactly the authorized reasons and moves the case to approved", async () => {
    const a = await awaiting();
    assert.ok((await preflightHumanApproval(a.deps, a.approvalPin)).ok);
    const r = await record(a);
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(r.value.approval.reasons, [...AUTHORIZED_REASONS]);
    assert.deepEqual(
      [r.value.approval.review_id, r.value.approval.preview_asset_id, r.value.approval.case_id, r.value.approval.reviewer_user_id, r.value.approval.decision, r.value.caseStatus],
      [a.approvalPin.reviewId, a.id, CASE, OWNER.id, "approve", "approved"],
    );
    assert.equal(a.store.approvals.size, 1);
    // Duplicate: the preflight, the recorder, and the store all refuse a second approval.
    assert.equal((await preflightHumanApproval(a.deps, a.approvalPin)).ok, false);
    assert.equal((await record(a)).ok, false, "replay");
    assert.equal(a.store.approvals.size, 1);
  });

  it("refuses missing, altered, reordered, empty, oversized, duplicate, extra, or non-string reasons", async () => {
    const a = await awaiting();
    const six = [...AUTHORIZED_REASONS];
    const cases: [string, unknown[]][] = [
      ["none", []],
      ["missing one", six.slice(0, 5)],
      ["altered", [...six.slice(0, 5), six[5].replace("distorted", "fine")]],
      ["typography normalised", [...six.slice(0, 4), six[4].replace(/[“”]/g, '"'), six[5]]],
      ["reordered", [six[1], six[0], ...six.slice(2)]],
      ["empty", [...six.slice(0, 5), "   "]],
      ["oversized", [...six.slice(0, 5), "x".repeat(501)]],
      ["duplicate", [...six.slice(0, 5), six[0]]],
      ["extra", [...six, "Another reason."]],
      ["non-string", [...six.slice(0, 5), 6]],
      ["eleven", [...six, "a", "b", "c", "d", "e"]],
    ];
    for (const [name, reasons] of cases) await notApproved(a, await record(a, { reasons }), name);
    assert.ok((await record(a)).ok, "the exact reasons still record afterwards");
  });

  it("refuses anyone but the human owner", async () => {
    const a = await awaiting();
    await notApproved(a, await record(a, { sender: { id: "someone-else", type: "User", role: null } }), "another user");
    await notApproved(a, await record(a, { sender: { id: OWNER.id, type: "Agent", role: "release-governor" } }), "an agent");
    await notApproved(a, await record(a, { approverName: "  " }), "unnamed approver");
  });

  it("refuses a changed plan hash, preview checksum, visual review, preview bytes, review, or case state", async () => {
    const a = await awaiting();
    await notApproved(a, await record(a, { pin: { planSha256: "0".repeat(64) } }), "plan hash");
    await notApproved(a, await record(a, { pin: { previewChecksum: `sha256:${"0".repeat(64)}` } }), "preview checksum");
    await notApproved(a, await record(a, { pin: { visualReviewId: "another-review" } }), "visual review");
    await notApproved(a, await record(a, { pin: { reviewId: "review:plan:daybreak-cold-brew:luv-scene-1:v3:r9" } }), "unknown review");
    a.storage.objects.set(a.req.outputStorageRef, new Uint8Array([5]));
    await notApproved(a, await record(a), "preview bytes altered");
    a.storage.objects.set(a.req.outputStorageRef, template.bytes);
    await a.store.setCaseStatus(CASE, "stopped");
    await notApproved(a, await record(a), "case stopped", "stopped");

    // A stored review that is not an approval cannot be approved.
    const b = await pinned();
    const reviseId = `review:${b.pin.planId}:r1`;
    await b.store.insertReview({ review_id: reviseId, case_id: CASE, plan_id: b.pin.planId, preview_asset_id: b.id, decision: "revise", review: { kind: "governor-review", reviewId: reviseId, decision: "revise" } });
    await b.store.setCaseStatus(CASE, "awaiting-human-review");
    const pin: ApprovalPin = { caseId: CASE, planId: b.pin.planId, planSha256: b.pin.planSha256, reviewId: reviseId, previewAssetId: b.id, previewChecksum: b.pin.previewChecksum, visualReviewId: b.pin.visualReviewId };
    const r = await recordPinnedHumanApproval(b.deps, pin, { sender: { id: OWNER.id, type: "User", role: null }, ownerUserId: OWNER.id, approverName: "Owner", reasons: AUTHORIZED_REASONS, expectedReasons: AUTHORIZED_REASONS });
    assert.equal(r.ok, false, "a revise review");
    assert.equal(b.store.approvals.size, 0);
  });

  it("enforces reasons and case state at the store, as the migration does", async () => {
    const a = await awaiting();
    const row = { approval_id: "a1", case_id: CASE, review_id: a.approvalPin.reviewId, preview_asset_id: a.id, reviewer_user_id: OWNER.id, reviewer_name: "Owner", decision: "approve" as const };
    await assert.rejects(a.store.insertApproval({ ...row, reasons: [] }), /reasons/);
    await assert.rejects(a.store.insertApproval({ ...row, reasons: ["Same.", "Same."] }), /reasons/);
    await a.store.setCaseStatus(CASE, "open");
    await assert.rejects(a.store.insertApproval({ ...row, reasons: ["Fine."] }), /awaiting human review/);
    await a.store.setCaseStatus(CASE, "awaiting-human-review");
    await a.store.insertApproval({ ...row, reasons: ["Fine."] });
    assert.equal((await a.store.getCase(CASE))!.status, "approved", "the insert moves the case atomically");
  });

  it("keeps the migration additive: empty-table guard, deny-all, append-only, one approval per review", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261017000000_human_approval_reasons.sql"), "utf8");
    assert.match(sql, /if exists \(select 1 from public\.human_approvals\) then\s+raise exception/);
    assert.match(sql, /add column reasons jsonb not null/);
    assert.match(sql, /between 1 and 10/);
    assert.match(sql, /> 500/);
    assert.match(sql, /count\(distinct e\.value\)/);
    assert.match(sql, /status is distinct from 'awaiting-human-review'|case_status is distinct from 'awaiting-human-review'/);
    assert.match(sql, /after insert on public\.human_approvals/);
    for (const forbidden of [/\bdrop\b/i, /disable row level security/i, /\bgrant\b[^;]*\b(anon|authenticated)\b/i, /update public\.human_approvals/i, /delete from/i, /human_approvals_append_only/]) {
      assert.ok(!forbidden.test(sql), `the migration never matches ${forbidden}`);
    }
  });
});
