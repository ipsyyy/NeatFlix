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
import { validateGovernorReview } from "@/agents/handoff/governor-review";
import { evaluatePreviewEvidence } from "@/agents/media/preview-evidence";
import { PersistentSourceFrameRegistry } from "@/agents/persistence/source-frames";
import { PersistentPreviewRegistry } from "@/agents/persistence/workflow";
import { AcceptedPlanRegistry } from "@/agents/runtime/accepted-plans";
import { toolsForRole } from "@/agents/tools/evidence-tools";
import { extractHandoffs } from "@/agents/handoff/protocol";
import { stampOutgoingContent } from "@/agents/handoff/stamp";
import { canonical } from "@/agents/persistence/workflow";
import { buildDirectorDelivery, guardedSaveGovernorReview, preflightGovernorDelivery, type DeliveryPin } from "@/agents/runtime/governor-delivery";
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
  constructor(private readonly behave: "ok" | "fail" | "empty" | "four-chunks" | "fail-after-ready" | "fail-before-ready" | "fail-unclosed" | "fail-download" | "fragmented" | "marker-mismatch" | "closed-late" = "ok") {}
  async generate(input: { image: Uint8Array; prompt: string; seed: number; resolution: string }): Promise<MotionPreviewResult> {
    this.inputs.push(input);
    if (this.behave === "fail") throw new ProviderError("Reactor session stopped at connect: refused.");
    const base = { sessionId: "sess_fail_1", commandsSent: ["set_resolution"], generatedSeconds: 0, resolution: null, startAcknowledgedBy: null, clip: null, download: null, sessionClosedAt: null, clipRequestAcknowledgedAt: null };
    if (this.behave === "fail-after-ready") throw new ProviderRunError("Reactor session stopped at resolution: rejected.", { ...base, errorCategory: "resolution", message: "rejected", reachedReady: true, readyToCloseSeconds: 20.4 });
    if (this.behave === "fail-before-ready") throw new ProviderRunError("Reactor session stopped at connect: timed out.", { ...base, sessionId: null, commandsSent: [], errorCategory: "connect", message: "timed out", reachedReady: false, readyToCloseSeconds: null });
    if (this.behave === "fail-download")
      throw new ProviderRunError("Reactor session stopped at download: Timed out waiting for the clip download.", {
        ...base, commandsSent: ["set_resolution", "set_seed", "set_image", "set_prompt", "start", "pause"], errorCategory: "download", message: "timed out", reachedReady: true, readyToCloseSeconds: 41.2, generatedSeconds: 3.667,
        startAcknowledgedBy: "broadcast", clip: { kind: "snap", startMarker: 6.1, endMarker: 10, nowMarker: 10, predictedReadyInMs: 4200 }, download: { deadlineMs: 34_200, waitMs: 34_210, outcome: "deadline" }, sessionClosedAt: "2026-10-16T18:00:07.000Z", clipRequestAcknowledgedAt: "2026-10-16T18:00:06.500Z",
      });
    if (this.behave === "fail-unclosed") throw new ProviderRunError("The session did not finish within 240 s.", { ...base, errorCategory: "timeout", message: "timeout", reachedReady: true, readyToCloseSeconds: null });
    const chunks = [0, 33, 33, ...(this.behave === "four-chunks" ? [33] : [])].map((framesEmitted, index) => ({ index, framesEmitted, audioSamples: 88000, atMs: 1000 + index * 1833 }));
    return {
      sessionId: "sess_test_1",
      video: this.behave === "empty" ? new Uint8Array() : this.behave === "fragmented" ? FRAGMENTED : VIDEO,
      videoMimeType: "video/mp4",
      requestedClipSeconds: 3.916,
      clip: { kind: "snap", startMarker: 0, endMarker: this.behave === "marker-mismatch" ? 4.6 : 3.667, nowMarker: 4.6, predictedReadyInMs: 4200 },
      startAcknowledgedBy: "broadcast",
      download: { deadlineMs: 34_200, waitMs: 5100 },
      clipRequestAcknowledgedAt: "2026-10-16T18:00:29.500Z",
      sessionClosedAt: this.behave === "closed-late" ? "2026-10-16T18:02:00.000Z" : "2026-10-16T18:00:30.000Z",
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
    assert.equal(r.run?.clipRequestAcknowledgedAt, "2026-10-16T18:00:06.500Z");
    assert.deepEqual(r.run?.download, { deadlineMs: 34_200, waitMs: 34_210, outcome: "deadline" });
    assert.equal(r.run?.sessionClosedAt, "2026-10-16T18:00:07.000Z");
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
    assert.deepEqual([p.recording.predictedReadyInMs, p.recording.downloadDeadlineMs, p.recording.postCloseWaitMs, p.recording.postCloseResult], [4200, 34_200, 5100, "downloaded"]);
    assert.equal(p.recording.sessionClosedBeforeDownload, true);
    assert.equal(p.recording.clipRequestAcknowledgedAt, "2026-10-16T18:00:29.500Z");
    assert.equal(JSON.stringify(p).includes("playlist"), false, "no clip URL in provenance");
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
      ["video does not match the clip markers", { provider: new FakeProvider("marker-mismatch") }],
      ["session not closed right after the clip request", { provider: new FakeProvider("closed-late") }],
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

describe("human visual review of a Reactor generated preview", () => {
  it("records one immutable review of a revalidated Reactor preview, and refuses tampered bytes", async () => {
    const w = await world();
    const created = await executeMotionPreview(w.req, w.deps());
    assert.ok(created.ok, JSON.stringify(created));
    const id = w.req.outputAssetId;
    const reviewOf = () => recordVisualReview({ workflow: w.workflow, store: w.store, storage: w.storage, assetId: id, decision: "rejected", reasons: ["Actor identity drifts."], reviewer: OWNER, ownerUserId: OWNER.id });
    const bytes = w.storage.objects.get(w.req.outputStorageRef)!;
    w.storage.objects.set(w.req.outputStorageRef, new Uint8Array([1]));
    assert.equal((await reviewOf()).ok, false, "tampered stored bytes");
    w.storage.objects.set(w.req.outputStorageRef, bytes);
    const r = await reviewOf();
    assert.ok(r.ok && r.status === "created", JSON.stringify(r));
    assert.equal(r.review.asset_checksum, (await w.store.getMediaAsset(id))!.checksum);
    assert.equal((await recordVisualReview({ workflow: w.workflow, store: w.store, storage: w.storage, assetId: id, decision: "approved", reasons: [], reviewer: OWNER, ownerUserId: OWNER.id })).ok, false, "immutable");
  });
});

describe("Release Governor preview evidence (preview-visual-quality)", () => {
  /** A world with the Reactor preview registered, optionally with the owner's visual review of it. */
  async function registered(review?: "approved" | "rejected") {
    const w = await world();
    const created = await executeMotionPreview(w.req, w.deps());
    assert.ok(created.ok, JSON.stringify(created));
    const id = w.req.outputAssetId;
    if (review) {
      const r = await recordVisualReview({ workflow: w.workflow, store: w.store, storage: w.storage, assetId: id, decision: review, reasons: ["Owner decision."], reviewer: OWNER, ownerUserId: OWNER.id });
      assert.ok(r.ok, JSON.stringify(r));
    }
    const evidence = () => evaluatePreviewEvidence({ workflow: w.workflow, store: w.store, storage: w.storage }, w.v3.planId);
    return { ...w, id, row: (await w.store.getMediaAsset(id))!, evidence };
  }

  it("is not-evaluated only when no preview is registered", async () => {
    const w = await world();
    const e = await evaluatePreviewEvidence({ workflow: w.workflow, store: w.store, storage: w.storage }, w.v3.planId);
    assert.deepEqual([e.outcome, e.assetId, e.checksum, e.visualReviewId], ["not-evaluated", null, null, null]);
  });

  it("passes for a revalidated preview with an approved review of its exact asset and checksum", async () => {
    const w = await registered("approved");
    const e = await w.evidence();
    assert.equal(e.outcome, "pass", e.detail);
    assert.deepEqual([e.assetId, e.checksum, e.visualReviewId], [w.id, w.row.checksum, (await w.store.getVisualReview(w.id))!.review_id]);
  });

  it("fails without a review, with a rejected review, or with a review naming other bytes or another asset", async () => {
    assert.match((await (await registered()).evidence()).detail, /no recorded human visual review/);
    assert.equal((await (await registered()).evidence()).outcome, "fail", "missing review");
    const rejected = await (await registered("rejected")).evidence();
    assert.equal(rejected.outcome, "fail", "rejected review");
    assert.match(rejected.detail, /"rejected"/);

    // Mismatches the store itself refuses on insert, injected directly to prove the check does not trust the row.
    const w = await registered("approved");
    const good = (await w.store.getVisualReview(w.id))!;
    w.store.visualReviews.set(w.id, { ...good, asset_checksum: `sha256:${"0".repeat(64)}` });
    assert.equal((await w.evidence()).outcome, "fail", "review names other bytes");
    w.store.visualReviews.set(w.id, { ...good, asset_id: "asset:luv-hypothesis:edited-still:luv-scene-1:v3" });
    assert.equal((await w.evidence()).outcome, "fail", "review names another asset");
    w.store.visualReviews.set(w.id, { ...good, case_id: "NF-DEMO-PRO-0001" });
    assert.equal((await w.evidence()).outcome, "fail", "review in another case");
    w.store.visualReviews.set(w.id, good);
    assert.equal((await w.evidence()).outcome, "pass", "restored");
  });

  it("fails when the private bytes differ, storage is unavailable, or the preview cannot be chosen", async () => {
    const w = await registered("approved");
    const bytes = w.storage.objects.get(w.req.outputStorageRef)!;
    w.storage.objects.set(w.req.outputStorageRef, new Uint8Array([7]));
    const altered = await w.evidence();
    assert.equal(altered.outcome, "fail", "altered bytes");
    assert.match(altered.detail, /does not revalidate/);
    w.storage.objects.delete(w.req.outputStorageRef);
    assert.equal((await w.evidence()).outcome, "fail", "missing object");
    w.storage.objects.set(w.req.outputStorageRef, bytes);
    assert.equal((await evaluatePreviewEvidence({ workflow: w.workflow, store: w.store }, w.v3.planId)).outcome, "fail", "no storage to check the bytes");
    assert.equal((await w.evidence()).outcome, "pass", "restored");
    await w.store.insertMediaAsset({ ...w.row, asset_id: `${w.id}-other`, storage_ref: `${w.row.storage_ref}.other` });
    assert.equal((await w.evidence()).outcome, "fail", "two previews: never choose");
  });

  it("drives the Governor's technical check, and a review copying the tool results verbatim validates", async () => {
    const w = await registered("approved");
    const previews = new PersistentPreviewRegistry(w.workflow);
    await previews.refresh(w.v3.planId);
    const frames = new PersistentSourceFrameRegistry(w.workflow);
    await frames.refreshScene(CASE, "luv-scene-1");
    const toolsWith = (previewEvidence?: (planId: string) => ReturnType<typeof w.evidence>) =>
      toolsForRole("release-governor", { plans: new AcceptedPlanRegistry(w.workflow), previews, frames, ...(previewEvidence ? { previewEvidence } : {}) });
    type CheckResult = { checks: { id: string; category: "policy" | "technical"; outcome: "pass" | "fail" | "not-evaluated"; detail: string }[]; source: string };
    const run = async (tools: ReturnType<typeof toolsWith>) => (await tools.find((t) => t.name === "nativeframe_check_placement_plan")!.handler({ planId: w.v3.planId })) as CheckResult;

    const unverified = (await run(toolsWith())).checks.find((c) => c.id === "preview-visual-quality")!;
    assert.equal(unverified.outcome, "fail", "a registered preview without an evidence source fails closed");
    const result = await run(toolsWith(() => w.evidence()));
    assert.ok(result.checks.every((c) => c.outcome === "pass"), JSON.stringify(result.checks));
    assert.ok(!/No generated preview exists/.test(JSON.stringify(result)), "no stale wording");

    const status = (await toolsWith().find((t) => t.name === "nativeframe_get_preview_status")!.handler({ planId: w.v3.planId })) as Record<string, unknown>;
    assert.equal(status.previewExists, true);
    const review = {
      kind: "governor-review", version: 1, reviewId: `review:${w.v3.planId}:r1`, caseId: CASE,
      subject: { titleId: "luv-hypothesis", sceneId: "luv-scene-1", campaignId: "daybreak-cold-brew", planId: w.v3.planId },
      decision: "approve-for-human-review",
      hhh: { helpful: { outcome: "pass", rationale: "Actionable." }, honest: { outcome: "pass", rationale: "Cites tools." }, harmless: { outcome: "pass", rationale: "No veto." } },
      checks: result.checks.map((c) => ({ ...c, source: `nativeframe_check_placement_plan.checks[${c.id}]` })),
      evidence: [{ claim: result.source, source: "nativeframe_check_placement_plan.source" }],
      blockers: [], corrections: [], assumptions: ["Demo fixtures."], uncertainty: "Human approval is still required.",
      preview: { status: "provided", assetRef: status.assetRef, provenance: status.provenance, generationMetadata: status.generationMetadata },
      humanApproval: { status: "pending" },
    };
    const ctx = { caseId: CASE, decision: review.decision, artifactId: w.v3.planId };
    assert.deepEqual(validateGovernorReview(review, ctx, previews), [], "the tool's wording passes every honesty rule");
    const downgraded = { ...review, checks: review.checks.map((c) => (c.id === "preview-visual-quality" ? { ...c, outcome: "not-evaluated" } : c)) };
    assert.ok(validateGovernorReview(downgraded, ctx, previews).some((e) => /every check/.test(e)), "approval still requires the technical pass");
  });
});

describe("bounded plan delivery to the Release Governor (preflight and save-time guard)", () => {
  /** Plan v3 with its registered preview and (optionally) the owner's review, pinned to those exact records. */
  async function pinned(review: "approved" | "rejected" | null = "approved") {
    const w = await world();
    assert.ok((await executeMotionPreview(w.req, w.deps())).ok);
    const id = w.req.outputAssetId;
    if (review) assert.ok((await recordVisualReview({ workflow: w.workflow, store: w.store, storage: w.storage, assetId: id, decision: review, reasons: ["Owner decision."], reviewer: OWNER, ownerUserId: OWNER.id })).ok);
    const row = (await w.store.getMediaAsset(id))!;
    const stored = await w.workflow.loadPlan(w.v3.planId);
    assert.ok(stored.ok);
    const pin: DeliveryPin = {
      caseId: CASE,
      planId: w.v3.planId,
      planSha256: sha256Hex(canonical(stored.value)),
      previewAssetId: id,
      previewChecksum: row.checksum,
      visualReviewId: (await w.store.getVisualReview(id))?.review_id ?? "none",
    };
    const deps = { workflow: w.workflow, store: w.store, evidence: (planId: string) => evaluatePreviewEvidence({ workflow: w.workflow, store: w.store, storage: w.storage }, planId) };
    const frames = new PersistentSourceFrameRegistry(w.workflow);
    await frames.refreshScene(CASE, "luv-scene-1");
    return { ...w, id, row, pin, deps, frames, plan: stored.value };
  }

  /** An approve-for-human-review that copies the Governor's tool results verbatim. */
  async function approval(p: Awaited<ReturnType<typeof pinned>>, over: Record<string, unknown> = {}) {
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
  async function refused(p: Awaited<ReturnType<typeof pinned>>, result: { ok: boolean }, name: string, status = "open") {
    assert.equal(result.ok, false, name);
    assert.equal(p.store.reviews.size, 0, `${name}: no review written`);
    assert.equal((await p.store.getCase(CASE))!.status, status, `${name}: case status unchanged`);
  }

  it("delivers the stored plan byte-identically and saves one approval only through the guard", async () => {
    const p = await pinned();
    const pre = await preflightGovernorDelivery(p.deps, p.pin);
    assert.ok(pre.ok, JSON.stringify(pre));
    const draft = buildDirectorDelivery(pre.value.plan, { governorMention: "@release-governor", frames: p.frames });
    assert.ok(draft.ok, JSON.stringify(draft));
    const stamped = stampOutgoingContent(draft.value.draftContent, new Date(), { frames: p.frames });
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

    // Duplicate delivery: the preflight and the guard both refuse, and the one review stays.
    const again = await preflightGovernorDelivery(p.deps, p.pin);
    assert.equal(again.ok, false);
    assert.ok((again as { errors: string[] }).errors.some((e) => /already has a Governor review/.test(e)) && (again as { errors: string[] }).errors.some((e) => /not "open"/.test(e)));
    assert.equal((await guardedSaveGovernorReview(p.deps, p.pin, await approval(p, { reviewId: `review:${p.pin.planId}:r2` }))).ok, false);
    assert.equal(p.store.reviews.size, 1);
  });

  it("refuses an altered plan or plan hash", async () => {
    const p = await pinned();
    await refused(p, await guardedSaveGovernorReview(p.deps, { ...p.pin, planSha256: "0".repeat(64) }, await approval(p)), "wrong pinned hash");
    const planRow = p.store.plans.get(p.pin.planId)!;
    p.store.plans.set(p.pin.planId, { ...planRow, plan: { ...planRow.plan as object, assumptions: ["Altered."] } });
    const pre = await preflightGovernorDelivery(p.deps, p.pin);
    assert.equal(pre.ok, false, "altered stored plan bytes");
    await refused(p, await guardedSaveGovernorReview(p.deps, p.pin, await approval(p)), "altered stored plan");
  });

  it("refuses when the case is no longer open or a Governor review already exists", async () => {
    const p = await pinned();
    await p.store.setCaseStatus(CASE, "stopped");
    assert.equal((await preflightGovernorDelivery(p.deps, p.pin)).ok, false);
    await refused(p, await guardedSaveGovernorReview(p.deps, p.pin, await approval(p)), "case stopped", "stopped");

    const q = await pinned();
    await q.store.insertReview({ review_id: "review:earlier:r1", case_id: CASE, plan_id: q.pin.planId, preview_asset_id: null, decision: "revise", review: {} });
    assert.equal((await preflightGovernorDelivery(q.deps, q.pin)).ok, false);
    const r = await guardedSaveGovernorReview(q.deps, q.pin, await approval(q));
    assert.equal(r.ok, false);
    assert.equal(q.store.reviews.size, 1, "only the earlier review");
  });

  it("refuses a changed preview checksum or altered preview bytes", async () => {
    const p = await pinned();
    await refused(p, await guardedSaveGovernorReview(p.deps, { ...p.pin, previewChecksum: `sha256:${"0".repeat(64)}` }, await approval(p)), "pinned checksum differs");
    const env = await approval(p);
    p.storage.objects.set(p.req.outputStorageRef, new Uint8Array([1]));
    assert.equal((await preflightGovernorDelivery(p.deps, p.pin)).ok, false);
    await refused(p, await guardedSaveGovernorReview(p.deps, p.pin, env), "bytes altered after the Governor's turn");
  });

  it("refuses a missing or rejected visual review, or any non-passing evidence", async () => {
    for (const review of [null, "rejected"] as const) {
      const p = await pinned(review);
      assert.equal((await preflightGovernorDelivery(p.deps, p.pin)).ok, false, String(review));
    }
    const p = await pinned();
    const env = await approval(p);
    for (const outcome of ["fail", "not-evaluated"] as const) {
      const deps = { ...p.deps, evidence: async () => ({ outcome, detail: "Stub.", assetId: p.id, checksum: p.row.checksum, visualReviewId: p.pin.visualReviewId }) };
      await refused(p, await guardedSaveGovernorReview(deps, p.pin, env), `evidence ${outcome} at save time`);
    }
    await refused(p, await guardedSaveGovernorReview(p.deps, { ...p.pin, visualReviewId: "another-review" }, env), "a different approved review");
  });

  it("refuses every Governor result other than a passing approve-for-human-review", async () => {
    const p = await pinned();
    const env = await approval(p);
    const revise = { ...env, decision: "revise", recipientRole: "placement-director", artifact: { ...env.artifact, decision: "revise" } };
    await refused(p, await guardedSaveGovernorReview(p.deps, p.pin, revise), "revise");
    const stop = { ...env, decision: "stop", artifact: { ...env.artifact, decision: "stop" } };
    await refused(p, await guardedSaveGovernorReview(p.deps, p.pin, stop), "stop");
    const notEvaluated = await approval(p, { checks: env.artifact.checks.map((c) => (c.id === "preview-visual-quality" ? { ...c, outcome: "not-evaluated" } : c)) });
    await refused(p, await guardedSaveGovernorReview(p.deps, p.pin, notEvaluated), "technical check not passing");
    const otherPreview = await approval(p, { preview: { ...env.artifact.preview, assetRef: "storage://nf-media/other.mp4" } });
    await refused(p, await guardedSaveGovernorReview(p.deps, p.pin, otherPreview), "names another preview");
    await refused(p, await guardedSaveGovernorReview(p.deps, p.pin, { ...env, caseId: "NF-DEMO-PRO-0001" }), "another case");
    await refused(p, await guardedSaveGovernorReview(p.deps, p.pin, "not an envelope"), "malformed");
    assert.ok((await guardedSaveGovernorReview(p.deps, p.pin, env)).ok, "the passing approval still saves afterwards");
  });
});
