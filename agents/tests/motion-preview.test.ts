import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import sharp from "sharp";
import type { PlacementPlan } from "@/agents/handoff/placement-plan";
import { SOURCE_FRAME_DISCLOSURE } from "@/agents/handoff/source-frames";
import { sha256Hex } from "@/agents/media/edited-still";
import { ProviderError, type ImageEditProvider } from "@/agents/media/gemini-provider";
import {
  attemptKey,
  executeMotionPreview,
  ProviderRunError,
  FileAttemptLedger,
  loadVerifiedMotionPreview,
  validateMotionPreview,
  type AttemptLedger,
  type MotionPreviewDeps,
  type MotionPreviewProvenance,
  type MotionPreviewProvider,
  type MotionPreviewRequest,
  type MotionPreviewResult,
} from "@/agents/media/motion-preview";
import type { VideoProbe } from "@/agents/media/mp4-validate";
import { buildLuvRebrandPlanV3, buildRevisedPlan, LUV_PLAN_V2 } from "@/agents/media/plan-revisions";
import { executeStillEdit } from "@/agents/media/still-edit";
import { recordVisualReview } from "@/agents/media/visual-review";
import type { PrivateStorage } from "@/agents/persistence/private-storage";
import { WorkflowRegistry } from "@/agents/persistence/workflow";
import { validPlacementPlan } from "./fixtures";
import { MemoryWorkflowStore } from "./memory-store";

const CASE = "NF-DEMO-0001";
const VIDEO_ID = "asset:luv-hypothesis:source-video:v1";
const VIDEO_REF = "storage://nf-media/Luv-Hypothesis/Luv.mp4";
const VIDEO_SUM = `sha256:${"1".repeat(64)}`;
const FRAME_ID = "asset:luv-hypothesis:source-frame:luv-scene-1:v1";
const FRAME_REF = "storage://nf-media/frames/luv-hypothesis/luv-scene-1-8s.png";
const OWNER = { id: "owner-user", type: "User", role: null, name: "NativeFrame project owner" };
const stillTarget = (v: string) => ({
  planId: `plan:daybreak-cold-brew:luv-scene-1:${v}`,
  sourceFrameAssetId: FRAME_ID,
  sourceFrameStorageRef: FRAME_REF,
  outputAssetId: `asset:luv-hypothesis:edited-still:luv-scene-1:${v}`,
  outputStorageRef: `storage://nf-media/edits/luv-hypothesis/daybreak-cold-brew-luv-scene-1-${v}/edited-still-${v}.png`,
});
const image = (w: number, h: number, shade: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: shade, g: 90, b: 60 } } }).png().toBuffer();

class Storage implements PrivateStorage {
  readonly objects = new Map<string, Uint8Array>();
  uploads: { ref: string; mime: string }[] = [];
  async download(ref: string) {
    const o = this.objects.get(ref);
    return o ? new Uint8Array(o) : null;
  }
  async uploadNew(ref: string, bytes: Uint8Array, mime: string) {
    this.uploads.push({ ref, mime });
    if (this.objects.has(ref)) return "exists" as const;
    this.objects.set(ref, new Uint8Array(bytes));
    return "created" as const;
  }
}

class MemoryLedger implements AttemptLedger {
  readonly keys = new Set<string>();
  async claim(key: string) {
    if (this.keys.has(key)) return "exists" as const;
    this.keys.add(key);
    return "claimed" as const;
  }
  async has(key: string) {
    return this.keys.has(key);
  }
  readonly outcomes = new Map<string, Record<string, unknown>>();
  async recordOutcome(key: string, record: Record<string, unknown>) {
    assert.equal(this.outcomes.has(key), false, "an outcome is recorded once");
    this.outcomes.set(key, record);
  }
}

const box = (type: string, payload: number) => {
  const b = Buffer.alloc(8 + payload);
  b.writeUInt32BE(8 + payload, 0);
  b.write(type, 4, "ascii");
  return b;
};
const VIDEO = new Uint8Array(Buffer.concat([box("ftyp", 16), box("moov", 64), box("mdat", 30_000)]));
const FRAGMENTED = new Uint8Array(Buffer.concat([box("ftyp", 16), box("moov", 64), box("moof", 32), box("mdat", 30_000)]));
const PROBE: VideoProbe = { formatNames: ["mov", "mp4"], durationSeconds: 3.667, videoStreams: 1, video: { codec: "h264", width: 1920, height: 1080, frameCount: 66, frameRate: 18 }, audio: { codec: "aac", sampleRate: 48000, channels: 1 } };

class FakeProvider implements MotionPreviewProvider {
  readonly provider = "reactor" as const;
  readonly model = "reactor/visko-orbis-stable";
  readonly inputs: { image: Uint8Array; prompt: string; seed: number; resolution: string }[] = [];
  constructor(private readonly behave: "ok" | "fail" | "empty" | "four-chunks" | "fail-after-ready" | "fail-before-ready" | "fail-unclosed" | "fail-download" | "fragmented" = "ok") {}
  async generate(input: { image: Uint8Array; prompt: string; seed: number; resolution: string }): Promise<MotionPreviewResult> {
    this.inputs.push(input);
    if (this.behave === "fail") throw new ProviderError("Reactor session stopped at connect: refused.");
    const base = { sessionId: "sess_fail_1", commandsSent: ["set_resolution"], generatedSeconds: 0, resolution: null, startAcknowledgedBy: null, clip: null, download: null, sessionClosedAt: null };
    if (this.behave === "fail-after-ready") throw new ProviderRunError("Reactor session stopped at resolution: rejected.", { ...base, errorCategory: "resolution", message: "rejected", reachedReady: true, readyToCloseSeconds: 20.4 });
    if (this.behave === "fail-before-ready") throw new ProviderRunError("Reactor session stopped at connect: timed out.", { ...base, sessionId: null, commandsSent: [], errorCategory: "connect", message: "timed out", reachedReady: false, readyToCloseSeconds: null });
    if (this.behave === "fail-download")
      throw new ProviderRunError("Reactor session stopped at download: Timed out waiting for the clip download.", {
        ...base, commandsSent: ["set_resolution", "set_seed", "set_image", "set_prompt", "start", "pause"], errorCategory: "download", message: "timed out", reachedReady: true, readyToCloseSeconds: 41.2, generatedSeconds: 3.667,
        startAcknowledgedBy: "broadcast", clip: { kind: "snap", startMarker: 6.1, endMarker: 10, nowMarker: 10, predictedReadyInMs: 4200 }, download: { deadlineMs: 34_200, waitMs: 34_210, outcome: "deadline" }, sessionClosedAt: "2026-10-16T18:00:41.000Z",
      });
    if (this.behave === "fail-unclosed") throw new ProviderRunError("The session did not finish within 240 s.", { ...base, errorCategory: "timeout", message: "timeout", reachedReady: true, readyToCloseSeconds: null });
    const chunks = [0, 33, 33, ...(this.behave === "four-chunks" ? [33] : [])].map((framesEmitted, index) => ({ index, framesEmitted, audioSamples: 88000, atMs: 1000 + index * 1833 }));
    return {
      sessionId: "sess_test_1",
      video: this.behave === "empty" ? new Uint8Array() : this.behave === "fragmented" ? FRAGMENTED : VIDEO,
      videoMimeType: "video/mp4",
      requestedClipSeconds: 3.916,
      clip: { kind: "snap", startMarker: 6.1, endMarker: 10.0, nowMarker: 10.0, predictedReadyInMs: 4200 },
      startAcknowledgedBy: "broadcast",
      download: { deadlineMs: 34_200, waitMs: 5100 },
      sessionClosedAt: "2026-10-16T18:00:30.000Z",
      chunks,
      generation: { fps: 18, frames_per_chunk: 33, resolution: "1080p", image_conditioned: true },
      imageAccepted: { width: 832, height: 480 },
      availableResolutions: ["1080p", "2k", "4k"],
      commandsSent: ["set_resolution", "set_seed", "set_image", "set_prompt", "start", "pause"],
      sessionSeconds: 21.4,
      generatedSeconds: 3.667,
      runtime: { sdk: "@reactor-team/js-sdk@3.1.0", bundleSha256: "f".repeat(64), browser: "headless Chrome (local)" },
    };
  }
}

/** A registered v1–v3 world with v3's edited still and its approved visual review. */
async function world(options: { review?: "approved" | "rejected" | "none" } = {}) {
  const store = new MemoryWorkflowStore();
  const workflow = new WorkflowRegistry(store);
  const storage = new Storage();
  const frame = await image(1280, 720, 120);
  const frameSum = `sha256:${sha256Hex(frame)}`;
  await store.ensureCase({ case_id: CASE, title_id: "luv-hypothesis", status: "open" });
  await store.insertMediaAsset({ asset_id: VIDEO_ID, case_id: CASE, plan_id: null, kind: "source-video", storage_ref: VIDEO_REF, mime_type: "video/mp4", duration_seconds: 20.064, generator: null, model: null, generated_at: null, latency_ms: null, cost_usd: null, checksum: VIDEO_SUM, provenance: { titleId: "luv-hypothesis" } });
  await store.insertMediaAsset({ asset_id: FRAME_ID, case_id: CASE, plan_id: null, kind: "source-frame", storage_ref: FRAME_REF, mime_type: "image/png", duration_seconds: null, generator: null, model: null, generated_at: null, latency_ms: null, cost_usd: null, checksum: frameSum, provenance: { sourceAssetId: VIDEO_ID, sourceStorageRef: VIDEO_REF, sourceChecksum: VIDEO_SUM, sceneId: "luv-scene-1", timestampSeconds: 8 } });
  storage.objects.set(FRAME_REF, frame);
  const v1 = validPlacementPlan({ sourceMedia: { kind: "registered-source-frame", isSceneFrame: true, assetId: FRAME_ID, storageRef: FRAME_REF, checksum: frameSum, sourceAssetId: VIDEO_ID, timestampSeconds: 8, note: SOURCE_FRAME_DISCLOSURE } as PlacementPlan["sourceMedia"] });
  const v2 = buildRevisedPlan(v1, LUV_PLAN_V2);
  const v3 = buildLuvRebrandPlanV3(v2);
  for (const p of [v1, v2, v3]) assert.equal((await workflow.savePlan(p)).ok, true);
  const gemini: ImageEditProvider = { provider: "google-gemini", model: "gemini-nano-banana-2.1", edit: async () => ({ responseId: "r", images: [{ mimeType: "image/png", data: await image(1376, 768, 200) }], text: null, usage: null }) };
  for (const v of ["v2", "v3"]) assert.ok((await executeStillEdit(stillTarget(v), { workflow, store, storage, provider: gemini })).ok);
  let reviewId = "no-review";
  if (options.review !== "none") {
    const r = await recordVisualReview({ workflow, store, assetId: stillTarget("v3").outputAssetId, decision: options.review ?? "approved", reasons: ["test review"], reviewer: OWNER, ownerUserId: OWNER.id });
    assert.ok(r.ok);
    reviewId = r.review.review_id;
  }
  storage.uploads = [];
  const still = (await store.getMediaAsset(stillTarget("v3").outputAssetId))!;
  const req: MotionPreviewRequest = {
    planId: v3.planId,
    editedStillAssetId: still.asset_id,
    editedStillStorageRef: still.storage_ref,
    editedStillChecksum: still.checksum,
    visualReviewId: reviewId,
    motionPromptSha256: sha256Hex(v3.prompts.motion.prompt),
    outputAssetId: "asset:luv-hypothesis:generated-preview:luv-scene-1:v3",
    outputStorageRef: "storage://nf-media/previews/luv-hypothesis/daybreak-cold-brew-luv-scene-1-v3/generated-preview-v3.mp4",
    seed: 42,
    resolution: "1080p",
  };
  const provider = new FakeProvider();
  const ledger = new MemoryLedger();
  const deps = (over: Partial<MotionPreviewDeps> = {}): MotionPreviewDeps => ({
    workflow, store, storage, provider, ledger, probe: async () => PROBE,
    costRate: { usdPerSecond: 0.01, source: "test rate", retrievedAt: "2026-10-16T00:00:00.000Z" },
    clock: () => new Date("2026-10-16T18:00:00.000Z"),
    ...over,
  });
  return { store, workflow, storage, req, v3, provider, ledger, deps, still };
}

describe("Reactor motion preview: accepted inputs only", () => {
  it("creates one private, immutable, fully bound generated preview with pending human review", async () => {
    const w = await world();
    const r = await executeMotionPreview(w.req, w.deps());
    assert.ok(r.ok && r.status === "created", JSON.stringify(r));
    assert.equal(w.provider.inputs.length, 1);
    assert.equal(w.provider.inputs[0].prompt, w.v3.prompts.motion.prompt, "the exact persisted motion prompt");
    assert.equal(`sha256:${sha256Hex(w.provider.inputs[0].image)}`, w.req.editedStillChecksum, "the approved still's exact bytes, unpreprocessed");
    assert.deepEqual(w.storage.uploads, [{ ref: w.req.outputStorageRef, mime: "video/mp4" }]);
    const row = (await w.store.getMediaAsset(w.req.outputAssetId))!;
    const p = row.provenance as MotionPreviewProvenance;
    assert.equal(row.kind, "generated-preview");
    assert.equal(row.plan_id, w.v3.planId);
    assert.equal(row.case_id, CASE);
    assert.equal(row.model, "reactor/visko-orbis-stable");
    assert.equal(Number(row.duration_seconds), 3.667);
    assert.equal(p.humanPreviewReview, "pending");
    assert.equal(p.sessionId, "sess_test_1");
    assert.deepEqual(p.sourceEditedStill, { assetId: w.still.asset_id, storageRef: w.still.storage_ref, checksum: w.still.checksum });
    assert.equal(p.visualReview.reviewId, w.req.visualReviewId);
    assert.equal(p.motionPromptSha256, w.req.motionPromptSha256);
    assert.equal(p.imagePreprocessing.method, "none");
    assert.deepEqual(p.settings, { seed: 42, resolution: "1080p", audio: "model default", framesPerChunk: 33, fps: 18, maxChunks: 3, frameChunks: 2 });
    assert.equal(p.usage.billedSeconds, 22);
    assert.equal(p.costUsd, 0.22);
    assert.match(p.costBasis, /per second of wall-clock time/);
    assert.equal(p.video.videoCodec, "h264");
    assert.equal(validateMotionPreview(row, { caseId: CASE, req: w.req }).length, 0);
    const forGovernor = await w.workflow.loadGeneratedPreview(w.v3.planId);
    assert.ok(forGovernor.ok && forGovernor.value.generationMetadata.costUsd === 0.22);
    const duplicate = await w.workflow.registerMediaAsset({ assetId: row.asset_id, caseId: CASE, planId: w.v3.planId, kind: "generated-preview", storageRef: `${row.storage_ref}.copy`, mimeType: "video/mp4", durationSeconds: 3.667, generator: "reactor", model: row.model, generatedAt: row.generated_at, latencyMs: 1, costUsd: 0, checksum: row.checksum, provenance: row.provenance as Record<string, unknown> });
    assert.equal(duplicate.ok, false, "the preview ID cannot be registered twice");
  });

  it("reuses the identical registered preview and never makes a second paid call", async () => {
    const w = await world();
    assert.ok((await executeMotionPreview(w.req, w.deps())).ok);
    const again = await executeMotionPreview(w.req, w.deps({ costRate: { usdPerSecond: Number.NaN, source: "", retrievedAt: "" } }));
    assert.ok(again.ok && again.status === "reused");
    assert.equal(w.provider.inputs.length, 1);
  });

  it("refuses before any provider connection unless the plan, still, review, and prompt all bind", async () => {
    const cases: [string, (w: Awaited<ReturnType<typeof world>>) => Promise<MotionPreviewRequest> | MotionPreviewRequest, string][] = [
      ["another plan", (w) => ({ ...w.req, planId: "plan:daybreak-cold-brew:luv-scene-1:v2" }), "plan"],
      ["a prompt hash mismatch", (w) => ({ ...w.req, motionPromptSha256: "0".repeat(64) }), "plan"],
      ["another plan's still", (w) => ({ ...w.req, editedStillAssetId: stillTarget("v2").outputAssetId, editedStillStorageRef: stillTarget("v2").outputStorageRef }), "still"],
      ["a different still checksum", (w) => ({ ...w.req, editedStillChecksum: `sha256:${"9".repeat(64)}` }), "still"],
      ["another review ID", (w) => ({ ...w.req, visualReviewId: "00000000-0000-0000-0000-000000000000" }), "review"],
      ["tampered stored still bytes", async (w) => (w.storage.objects.set(w.req.editedStillStorageRef, await image(1280, 720, 10)), w.req), "still"],
      ["a missing stored still", (w) => (w.storage.objects.delete(w.req.editedStillStorageRef), w.req), "still"],
    ];
    for (const [name, mutate, stage] of cases) {
      const w = await world();
      const r = await executeMotionPreview(await mutate(w), w.deps());
      assert.equal(r.ok, false, name);
      assert.equal((r as { stage: string }).stage, stage, name);
      assert.equal(w.provider.inputs.length, 0, `${name}: no provider connection`);
      assert.equal(w.ledger.keys.size, 0, `${name}: no attempt claimed`);
    }
    for (const review of ["rejected", "none"] as const) {
      const w = await world({ review });
      const r = await executeMotionPreview(w.req, w.deps());
      assert.equal(r.ok, false, review);
      assert.equal((r as { stage: string }).stage, "review");
      assert.equal(w.provider.inputs.length, 0);
    }
  });

  it("stops before a paid session when no documented cost rate is available", async () => {
    const w = await world();
    const r = await executeMotionPreview(w.req, w.deps({ costRate: { usdPerSecond: Number.NaN, source: "", retrievedAt: "" } }));
    assert.equal(r.ok, false);
    assert.equal((r as { stage: string }).stage, "cost");
    assert.equal(w.provider.inputs.length, 0);
  });
});

describe("Reactor motion preview: one attempt, fail closed", () => {
  it("records a provider failure once and never retries it", async () => {
    const w = await world();
    const failing = new FakeProvider("fail");
    const r = await executeMotionPreview(w.req, w.deps({ provider: failing }));
    assert.equal(r.ok, false);
    assert.equal((r as { stage: string }).stage, "provider");
    const again = await executeMotionPreview(w.req, w.deps({ provider: failing }));
    assert.equal(again.ok, false);
    assert.match((again as { errors: string[] }).errors[0], /already made/);
    assert.equal(failing.inputs.length, 1, "exactly one provider session across runs");
    assert.equal(await w.store.getMediaAsset(w.req.outputAssetId), null);
  });

  it("retains each failed run's session, commands, billing estimate, and rate basis, beside the untouched claim", async () => {
    const w = await world();
    const r = await executeMotionPreview(w.req, w.deps({ provider: new FakeProvider("fail-after-ready") }));
    assert.equal(r.ok, false);
    const run = (r as { run?: Record<string, unknown> }).run!;
    assert.equal(run.errorCategory, "resolution");
    assert.equal(run.sessionId, "sess_fail_1");
    assert.deepEqual(run.commandsSent, ["set_resolution"]);
    assert.equal(run.readyToCloseSeconds, 20.4);
    assert.equal(run.billedSeconds, 21, "billed per whole second from ready to close");
    assert.equal(run.estimatedCostUsd, 0.21);
    assert.equal(run.generatedSeconds, 0);
    assert.equal((run.costRate as { source: string }).source, "test rate");
    assert.match(String(run.costBasis), /not billed/);
    const key = attemptKey(w.req);
    assert.equal(w.ledger.outcomes.get(key)?.outcome, "failed", "outcome retained");
    assert.equal(w.ledger.outcomes.get(key)?.sessionId, "sess_fail_1");
    assert.equal(await w.ledger.has(key), true, "the claim stays");
    assert.equal(JSON.stringify(run).includes("AAAA"), false);
    const again = await executeMotionPreview(w.req, w.deps());
    assert.equal(again.ok, false, "no second paid call");
    assert.equal(w.provider.inputs.length, 0);
  });

  it("retains a download failure's acknowledgement path, clip markers, expected readiness, wait, and close time — never the clip URL", async () => {
    const w = await world();
    const r = (await executeMotionPreview(w.req, w.deps({ provider: new FakeProvider("fail-download") }))) as { run?: Record<string, unknown> };
    assert.equal(r.run?.errorCategory, "download");
    assert.equal(r.run?.startAcknowledgedBy, "broadcast");
    assert.deepEqual(r.run?.clip, { kind: "snap", startMarker: 6.1, endMarker: 10, nowMarker: 10, predictedReadyInMs: 4200 });
    assert.deepEqual(r.run?.download, { deadlineMs: 34_200, waitMs: 34_210, outcome: "deadline" });
    assert.equal(r.run?.sessionClosedAt, "2026-10-16T18:00:41.000Z");
    assert.equal(r.run?.generatedSeconds, 3.667);
    assert.equal(r.run?.billedSeconds, 42);
    assert.equal(r.run?.estimatedCostUsd, 0.42);
    assert.equal(JSON.stringify(w.ledger.outcomes.get(attemptKey(w.req))).includes("playlist"), false);
    assert.equal(await w.store.getMediaAsset(w.req.outputAssetId), null);
  });

  it("bills nothing for a session that never became ready, and leaves an unmeasured close unknown rather than zero", async () => {
    const before = await world();
    const a = (await executeMotionPreview(before.req, before.deps({ provider: new FakeProvider("fail-before-ready") }))) as { run?: Record<string, unknown> };
    assert.deepEqual([a.run?.billedSeconds, a.run?.estimatedCostUsd, a.run?.reachedReady], [0, 0, false]);
    const unclosed = await world();
    const b = (await executeMotionPreview(unclosed.req, unclosed.deps({ provider: new FakeProvider("fail-unclosed") }))) as { run?: Record<string, unknown> };
    assert.deepEqual([b.run?.billedSeconds, b.run?.estimatedCostUsd, b.run?.errorCategory], [null, null, "timeout"]);
  });

  it("accepts a decodable fragmented MP4 and records its structure, acknowledgement, and download timing", async () => {
    const w = await world();
    const r = await executeMotionPreview(w.req, w.deps({ provider: new FakeProvider("fragmented") }));
    assert.ok(r.ok, JSON.stringify(r));
    const p = (await w.store.getMediaAsset(w.req.outputAssetId))!.provenance as MotionPreviewProvenance;
    assert.equal(p.video.structure, "fragmented");
    assert.equal(p.startAcknowledgedBy, "broadcast");
    assert.deepEqual([p.recording.predictedReadyInMs, p.recording.downloadDeadlineMs, p.recording.downloadWaitMs], [4200, 34_200, 5100]);
    assert.equal(p.sessionClosedAt, "2026-10-16T18:00:30.000Z");
    assert.equal(p.usage.generatedSeconds, 3.667);
  });

  it("rejects malformed, missing, out-of-range, or non-16:9 output without storing anything", async () => {
    const bad: [string, Partial<MotionPreviewDeps> | ((w: Awaited<ReturnType<typeof world>>) => Partial<MotionPreviewDeps>)][] = [
      ["empty video", { provider: new FakeProvider("empty") }],
      ["undecodable", { probe: async () => Promise.reject(new Error("The video could not be decoded.")) }],
      ["too short", { probe: async () => ({ ...PROBE, durationSeconds: 1.8 }) }],
      ["too long", { probe: async () => ({ ...PROBE, durationSeconds: 7.3 }) }],
      ["infinite", { probe: async () => ({ ...PROBE, durationSeconds: Number.POSITIVE_INFINITY }) }],
      ["4:3", { probe: async () => ({ ...PROBE, video: { ...PROBE.video!, width: 1440, height: 1080 } }) }],
      ["more than three chunks", { provider: new FakeProvider("four-chunks") }],
    ];
    for (const [name, over] of bad) {
      const w = await world();
      const r = await executeMotionPreview(w.req, w.deps(typeof over === "function" ? over(w) : over));
      assert.equal(r.ok, false, name);
      assert.equal((r as { stage: string }).stage, "response", name);
      assert.equal(w.storage.uploads.length, 0, `${name}: nothing uploaded`);
      assert.equal(await w.store.getMediaAsset(w.req.outputAssetId), null, `${name}: nothing registered`);
    }
  });

  it("never overwrites: an existing object at the output path stops the run before any session", async () => {
    const w = await world();
    w.storage.objects.set(w.req.outputStorageRef, new Uint8Array([1, 2, 3]));
    const r = await executeMotionPreview(w.req, w.deps());
    assert.equal(r.ok, false);
    assert.equal((r as { stage: string }).stage, "idempotency");
    assert.equal(w.provider.inputs.length, 0);
  });

  it("stops when a different object appears at the output path during the run", async () => {
    const w = await world();
    const racing = new FakeProvider();
    const original = racing.generate.bind(racing);
    racing.generate = async (input) => {
      const result = await original(input);
      w.storage.objects.set(w.req.outputStorageRef, new Uint8Array([9, 9, 9]));
      return result;
    };
    const r = await executeMotionPreview(w.req, w.deps({ provider: racing }));
    assert.equal(r.ok, false);
    assert.equal((r as { stage: string }).stage, "upload");
    assert.equal(await w.store.getMediaAsset(w.req.outputAssetId), null);
  });
});

describe("Reactor motion preview: provenance validation", () => {
  it("rejects a registered preview whose binding or provenance was altered", async () => {
    const w = await world();
    assert.ok((await executeMotionPreview(w.req, w.deps())).ok);
    const row = (await w.store.getMediaAsset(w.req.outputAssetId))!;
    const p = row.provenance as MotionPreviewProvenance;
    const altered: [string, unknown][] = [
      ["review", { ...row, provenance: { ...p, visualReview: { ...p.visualReview, reviewId: "other" } } }],
      ["still", { ...row, provenance: { ...p, sourceEditedStill: { ...p.sourceEditedStill, checksum: `sha256:${"0".repeat(64)}` } } }],
      ["prompt", { ...row, provenance: { ...p, motionPromptSha256: "0".repeat(64) } }],
      ["human review", { ...row, provenance: { ...p, humanPreviewReview: "approved" } }],
      ["cost", { ...row, cost_usd: 0, provenance: { ...p, costUsd: 0.5 } }],
      ["duration", { ...row, duration_seconds: 9, provenance: { ...p, video: { ...p.video, durationSeconds: 9 } } }],
      ["model", { ...row, model: "reactor/visko-orbis-dynamic" }],
    ];
    for (const [name, candidate] of altered) assert.ok(validateMotionPreview(candidate, { caseId: CASE, req: w.req }).length > 0, name);
    w.storage.objects.set(w.req.outputStorageRef, new Uint8Array([7]));
    const reread = await loadVerifiedMotionPreview(w.deps(), { caseId: CASE, req: w.req });
    assert.equal(reread.ok, false, "stored bytes are revalidated on every read");
  });
});

describe("file attempt ledger", () => {
  it("claims a key exactly once, durably", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nf-ledger-test-"));
    try {
      const key = attemptKey({ planId: "p:v3", outputAssetId: "asset:x", motionPromptSha256: "a".repeat(64) } as MotionPreviewRequest);
      assert.equal(await new FileAttemptLedger(dir).has(key), false);
      assert.equal(await new FileAttemptLedger(dir).claim(key, {}), "claimed");
      assert.equal(await new FileAttemptLedger(dir).claim(key, {}), "exists", "a fresh process sees the claim");
      assert.equal(await new FileAttemptLedger(dir).has(key), true);
      const claimFile = join(dir, `${sha256Hex(key)}.json`);
      const before = await readFile(claimFile, "utf8");
      await new FileAttemptLedger(dir).recordOutcome(key, { outcome: "failed", sessionId: "sess_1" });
      assert.equal(await readFile(claimFile, "utf8"), before, "the claim is never modified");
      assert.match(await readFile(join(dir, `${sha256Hex(key)}.outcome.json`), "utf8"), /"outcome": "failed"/);
      await assert.rejects(new FileAttemptLedger(dir).recordOutcome(key, { outcome: "again" }), /EEXIST/, "an outcome is written once");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

