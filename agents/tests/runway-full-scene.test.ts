import assert from "node:assert/strict";
import { describe, it } from "node:test";
import sharp from "sharp";
import type { PlacementPlan } from "@/agents/handoff/placement-plan";
import { SOURCE_FRAME_DISCLOSURE } from "@/agents/handoff/source-frames";
import { sha256Hex } from "@/agents/media/edited-still";
import type { ImageEditProvider, ProviderEditResult } from "@/agents/media/gemini-provider";
import type { VideoProbe } from "@/agents/media/mp4-validate";
import { ALEPH_EDIT_PROMPT, RUNWAY_MODEL } from "@/agents/media/runway-aleph";
import {
  FULL_SCENE_DISCLOSURE,
  FULL_SCENE_LIMITATION,
  identityProblems,
  ledgerProblems,
  loadVerifiedFullScene,
  LUV_V4_RUNWAY,
  registerFullScene,
  validateFullSceneVideo,
  type FullSceneProvenance,
  type FullSceneRequest,
} from "@/agents/media/runway-full-scene";
import { executeStillEdit } from "@/agents/media/still-edit";
import { parseReviewArgs, recordVisualReview } from "@/agents/media/visual-review";
import type { PrivateStorage } from "@/agents/persistence/private-storage";
import { IntegrityError } from "@/agents/persistence/store";
import { WorkflowRegistry } from "@/agents/persistence/workflow";
import { FULL_SCENE_LABEL, selectPrimaryVideo, validateDemoSnapshot, type DemoFullScene, type DemoMedia } from "@/lib/demo/snapshot";
import { validPlacementPlan } from "./fixtures";
import { MemoryWorkflowStore } from "./memory-store";

const CASE = "NF-DEMO-0001";
const VIDEO_ID = "asset:luv-hypothesis:source-video:v1";
const VIDEO_REF = "storage://nf-media/Luv-Hypothesis/Luv.mp4";
const VIDEO_SUM = `sha256:${"1".repeat(64)}`;
const SOURCE_SECONDS = 20.064;
const FRAME_ID = "asset:luv-hypothesis:source-frame:luv-scene-1:v1";
const FRAME_REF = "storage://nf-media/frames/luv-hypothesis/luv-scene-1-8s.png";
const PLAN_ID = "plan:daybreak-cold-brew:luv-scene-1:v1";
const STILL_ID = "asset:luv-hypothesis:edited-still:luv-scene-1:v1";
const STILL_REF = "storage://nf-media/edits/luv-hypothesis/daybreak-cold-brew-luv-scene-1-v1/edited-still-v1.png";
const OWNER = { id: "owner-user", type: "User", role: null, name: "NativeFrame project owner" };
const ACCEPT_REASON = "The owner accepted the full-scene Runway output after visual review.";

const image = (w: number, h: number, shade = 120) => sharp({ create: { width: w, height: h, channels: 3, background: { r: shade, g: 90, b: 60 } } }).png().toBuffer();

class MemoryPrivateStorage implements PrivateStorage {
  readonly objects = new Map<string, Uint8Array>();
  uploads = 0;
  async download(ref: string) {
    return this.objects.get(ref) ?? null;
  }
  async uploadNew(ref: string, bytes: Uint8Array) {
    if (this.objects.has(ref)) return "exists" as const;
    this.uploads++;
    this.objects.set(ref, new Uint8Array(bytes));
    return "created" as const;
  }
}

const provider: ImageEditProvider = {
  provider: "google-gemini",
  model: "gemini-nano-banana-2.1",
  async edit(): Promise<ProviderEditResult> {
    return { responseId: "r1", images: [{ mimeType: "image/png", data: await image(1376, 768, 150) }], text: null, usage: null };
  },
};

/** A structurally complete, non-fast-start MP4 (ftyp, mdat, moov), like Runway's output. */
function mp4(payload = 7): Uint8Array {
  const box = (type: string, body: number[]) => [0, 0, 0, 8 + body.length, ...[...type].map((c) => c.charCodeAt(0)), ...body];
  return new Uint8Array([...box("ftyp", [105, 115, 111, 109, 0, 0, 2, 0]), ...box("mdat", Array(64).fill(payload)), ...box("moov", [0, 0, 0, 0])]);
}

const probe = (over: Partial<VideoProbe> = {}): VideoProbe => ({
  formatNames: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"],
  durationSeconds: 20.041667,
  videoStreams: 1,
  video: { codec: "h264", width: 1280, height: 720, frameCount: 481, frameRate: 24 },
  audio: { codec: "aac", sampleRate: 48000, channels: 2 },
  ...over,
});

/** A registry seeded like production: source video, plan, an edited reference still, and its approved review. */
async function setup() {
  const store = new MemoryWorkflowStore();
  const workflow = new WorkflowRegistry(store);
  const storage = new MemoryPrivateStorage();
  const frame = await image(1280, 720);
  const frameSum = `sha256:${sha256Hex(frame)}`;
  await store.ensureCase({ case_id: CASE, title_id: "luv-hypothesis", status: "open" });
  await store.insertMediaAsset({ asset_id: VIDEO_ID, case_id: CASE, plan_id: null, kind: "source-video", storage_ref: VIDEO_REF, mime_type: "video/mp4", duration_seconds: SOURCE_SECONDS, generator: null, model: null, generated_at: null, latency_ms: null, cost_usd: null, checksum: VIDEO_SUM, provenance: { titleId: "luv-hypothesis" } });
  await store.insertMediaAsset({ asset_id: FRAME_ID, case_id: CASE, plan_id: null, kind: "source-frame", storage_ref: FRAME_REF, mime_type: "image/png", duration_seconds: null, generator: null, model: null, generated_at: null, latency_ms: null, cost_usd: null, checksum: frameSum, provenance: { sourceAssetId: VIDEO_ID, sourceStorageRef: VIDEO_REF, sourceChecksum: VIDEO_SUM, sceneId: "luv-scene-1", timestampSeconds: 8 } });
  storage.objects.set(FRAME_REF, frame);
  const plan = validPlacementPlan({ sourceMedia: { kind: "registered-source-frame", isSceneFrame: true, assetId: FRAME_ID, storageRef: FRAME_REF, checksum: frameSum, sourceAssetId: VIDEO_ID, timestampSeconds: 8, note: SOURCE_FRAME_DISCLOSURE } as PlacementPlan["sourceMedia"] });
  assert.equal((await workflow.savePlan(plan)).ok, true);
  const still = await executeStillEdit({ planId: PLAN_ID, sourceFrameAssetId: FRAME_ID, sourceFrameStorageRef: FRAME_REF, outputAssetId: STILL_ID, outputStorageRef: STILL_REF }, { workflow, store, storage, provider });
  assert.ok(still.ok, JSON.stringify(still));
  const approved = await recordVisualReview({ workflow, store, assetId: STILL_ID, decision: "approved", reasons: [], reviewer: OWNER, ownerUserId: OWNER.id });
  assert.ok(approved.ok);
  const bytes = mp4();
  const req: FullSceneRequest = {
    ...LUV_V4_RUNWAY,
    planId: PLAN_ID,
    sourceVideoChecksum: VIDEO_SUM,
    referenceStillAssetId: STILL_ID,
    referenceStillChecksum: approved.review.asset_checksum,
    referenceReviewId: approved.review.review_id,
    outputChecksum: `sha256:${sha256Hex(bytes)}`,
    protectedAssetIds: [...LUV_V4_RUNWAY.protectedAssetIds, STILL_ID],
    protectedStorageRefs: [...LUV_V4_RUNWAY.protectedStorageRefs, STILL_REF],
  };
  const ledger = { state: "downloaded-pending-human-review", authorization: req.authorization, taskId: req.taskId, estimatedCredits: 308, chargedCredits: 308, outputChecksum: req.outputChecksum, output: "/x.mp4" };
  const deps = { workflow, store, storage };
  storage.uploads = 0;
  const input = { bytes, probe: probe(), ledger, generatedAt: new Date("2026-10-19T22:20:05.000Z") };
  return { store, workflow, storage, deps, req, bytes, ledger, input };
}

describe("Runway full-scene video: provenance", () => {
  it("registers the accepted output with its Runway task, model, credits, and every checksum", async () => {
    const ctx = await setup();
    const r = await registerFullScene(ctx.deps, ctx.input, ctx.req);
    assert.ok(r.ok && r.status === "created", JSON.stringify(r));
    const row = r.row;
    const p = row.provenance as FullSceneProvenance;
    assert.equal(row.kind, "full-scene-video");
    assert.equal(row.asset_id, "asset:luv-hypothesis:full-scene-video:luv-scene-1:v4-runway");
    assert.deepEqual([row.generator, row.model, p.runway.model], ["runway", RUNWAY_MODEL, "aleph2"]);
    assert.equal(p.runway.taskId, "fcc20fc6-7275-4a6c-9f8c-51d2538221a4");
    assert.deepEqual([p.runway.estimatedCredits, p.runway.chargedCredits, p.runway.costUsd, Number(row.cost_usd)], [308, 308, 3.08, 3.08]);
    assert.deepEqual([p.runway.attempt, p.runway.automaticRetries], [1, 0]);
    assert.equal(p.runway.promptSha256, sha256Hex(ALEPH_EDIT_PROMPT));
    assert.deepEqual(p.sourceVideo, { assetId: VIDEO_ID, storageRef: VIDEO_REF, checksum: VIDEO_SUM });
    assert.deepEqual(p.referenceStill, { assetId: STILL_ID, storageRef: STILL_REF, checksum: ctx.req.referenceStillChecksum });
    assert.equal(p.referenceReview.decision, "approved");
    assert.equal(p.outputChecksum, ctx.req.outputChecksum);
    assert.equal(row.checksum, ctx.req.outputChecksum);
    assert.equal(p.latencyMs, new Date("2026-10-19T22:20:05.000Z").getTime() - new Date(LUV_V4_RUNWAY.authorizedAt).getTime());
    assert.equal(p.productionFinal, false);
    assert.equal(p.disclosure, FULL_SCENE_DISCLOSURE);
    assert.match(FULL_SCENE_DISCLOSURE, /not production-final/);
    assert.doesNotMatch(FULL_SCENE_DISCLOSURE, /production-final typography|final typography is/i);
  });

  it("pins the accepted attempt exactly as the attempt ledger recorded it", () => {
    assert.deepEqual(identityProblems(LUV_V4_RUNWAY), []);
    assert.equal(LUV_V4_RUNWAY.taskId, "fcc20fc6-7275-4a6c-9f8c-51d2538221a4");
    assert.equal(LUV_V4_RUNWAY.outputChecksum, "sha256:112b183bba60b8056ea6a4d54b583e81f55086dd203b8aba9b2514f94ca7ce72");
    assert.equal(LUV_V4_RUNWAY.sourceVideoChecksum, "sha256:8cbe5186c7bcea0348a336f41f0318168f8ed15c635c89a195b0b2ad93324ddc");
    assert.equal(LUV_V4_RUNWAY.referenceStillChecksum, "sha256:be7a04de0a59446f6a2c47ae5b29d6c3af04a29be1f7d471eb3e12d38e8ab73f");
    assert.deepEqual([LUV_V4_RUNWAY.model, LUV_V4_RUNWAY.chargedCredits], ["aleph2", 308]);
  });

  it("refuses a ledger or bytes that differ from the accepted attempt, and records nothing", async () => {
    const ctx = await setup();
    for (const ledger of [{ ...ctx.ledger, taskId: "other" }, { ...ctx.ledger, chargedCredits: 309 }, { ...ctx.ledger, state: "authorized" }, { ...ctx.ledger, outputChecksum: `sha256:${"2".repeat(64)}` }, null]) {
      assert.ok(ledgerProblems(ledger, ctx.req).length > 0);
      const r = await registerFullScene(ctx.deps, { ...ctx.input, ledger }, ctx.req);
      assert.ok(!r.ok && r.stage === "ledger");
    }
    const other = await registerFullScene(ctx.deps, { ...ctx.input, bytes: mp4(9) }, ctx.req);
    assert.ok(!other.ok && other.stage === "video" && /accepted output checksum/.test(other.errors.join(" ")));
    assert.equal(await ctx.store.getMediaAsset(ctx.req.outputAssetId), null);
    assert.equal(ctx.storage.uploads, 0);
  });

  it("fails revalidation when any recorded provenance is altered", async () => {
    const ctx = await setup();
    assert.ok((await registerFullScene(ctx.deps, ctx.input, ctx.req)).ok);
    const row = (await ctx.store.getMediaAsset(ctx.req.outputAssetId))!;
    const p = row.provenance as FullSceneProvenance;
    for (const provenance of [{ ...p, runway: { ...p.runway, taskId: "x" } }, { ...p, runway: { ...p.runway, chargedCredits: 1 } }, { ...p, sourceVideo: { ...p.sourceVideo, checksum: `sha256:${"3".repeat(64)}` } }, { ...p, productionFinal: true }]) {
      ctx.store.tamper("media", row.asset_id, { provenance });
      assert.equal((await loadVerifiedFullScene(ctx.deps, ctx.req)).ok, false);
    }
    ctx.store.tamper("media", row.asset_id, { provenance: p });
    assert.equal((await loadVerifiedFullScene(ctx.deps, ctx.req)).ok, true);
    ctx.storage.objects.set(ctx.req.outputStorageRef, mp4(8));
    assert.equal((await loadVerifiedFullScene(ctx.deps, ctx.req)).ok, false, "stored bytes changed");
  });
});

describe("Runway full-scene video: immutable registration", () => {
  it("reuses an identical registration without a second upload or record", async () => {
    const ctx = await setup();
    const first = await registerFullScene(ctx.deps, ctx.input, ctx.req);
    const again = await registerFullScene(ctx.deps, ctx.input, ctx.req);
    assert.ok(first.ok && again.ok && again.status === "reused");
    assert.equal(ctx.storage.uploads, 1);
    assert.deepEqual(again.row, first.row);
  });

  it("never overwrites a conflicting object or record", async () => {
    const ctx = await setup();
    ctx.storage.objects.set(ctx.req.outputStorageRef, mp4(5));
    const r = await registerFullScene(ctx.deps, ctx.input, ctx.req);
    assert.ok(!r.ok && r.stage === "upload");
    assert.equal(await ctx.store.getMediaAsset(ctx.req.outputAssetId), null);

    const ctx2 = await setup();
    assert.ok((await registerFullScene(ctx2.deps, ctx2.input, ctx2.req)).ok);
    ctx2.store.tamper("media", ctx2.req.outputAssetId, { cost_usd: 0 });
    const conflicted = await registerFullScene(ctx2.deps, ctx2.input, ctx2.req);
    assert.ok(!conflicted.ok && conflicted.stage === "idempotency");
    assert.equal(Number((await ctx2.store.getMediaAsset(ctx2.req.outputAssetId))!.cost_usd), 0, "not overwritten");
  });

  it("leaves the earlier stills, the approved fallback, and every other record untouched", async () => {
    const ctx = await setup();
    const before = new Map([...ctx.store.media].map(([k, v]) => [k, structuredClone(v)]));
    const objects = new Map(ctx.storage.objects);
    assert.ok((await registerFullScene(ctx.deps, ctx.input, ctx.req)).ok);
    assert.deepEqual([...ctx.store.media.keys()].filter((k) => !before.has(k)), [ctx.req.outputAssetId]);
    for (const [k, v] of before) assert.deepEqual(ctx.store.media.get(k), v, k);
    assert.deepEqual([...ctx.storage.objects.keys()].filter((k) => !objects.has(k)), [ctx.req.outputStorageRef]);
    for (const [k, v] of objects) assert.equal(ctx.storage.objects.get(k), v, k);
  });

  it("refuses an identity that belongs to an earlier still or the approved fallback", () => {
    for (const outputAssetId of LUV_V4_RUNWAY.protectedAssetIds) assert.ok(identityProblems({ ...LUV_V4_RUNWAY, outputAssetId }).length > 0, outputAssetId);
    for (const outputStorageRef of LUV_V4_RUNWAY.protectedStorageRefs) assert.ok(identityProblems({ ...LUV_V4_RUNWAY, outputStorageRef }).length > 0, outputStorageRef);
    assert.ok(identityProblems({ ...LUV_V4_RUNWAY, chargedCredits: 601 }).length > 0, "above the $6 ceiling");
  });

  it("is a separate kind, so the plan's single generated preview is unchanged", async () => {
    const ctx = await setup();
    assert.ok((await registerFullScene(ctx.deps, ctx.input, ctx.req)).ok);
    assert.deepEqual(await ctx.store.listMediaAssetsForPlan(PLAN_ID, "generated-preview", 2), []);
    await assert.rejects(
      ctx.store.insertMediaAsset({ ...(await ctx.store.getMediaAsset(ctx.req.outputAssetId))!, asset_id: "asset:x:full-scene-video:y:v9-z", storage_ref: "storage://nf-media/full-scene/x.mp4", duration_seconds: null }),
      IntegrityError,
      "incomplete full-scene video",
    );
  });
});

describe("Runway full-scene video: duration and media checks", () => {
  const req = { ...LUV_V4_RUNWAY, outputChecksum: `sha256:${sha256Hex(mp4())}` };
  it("accepts the full scene within one frame of the source, with audio, at 1280×720 H.264", () => {
    const r = validateFullSceneVideo(mp4(), probe(), req, SOURCE_SECONDS);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.video.durationSeconds, 20.041667);
    assert.equal(r.video.durationDeltaSeconds, -0.022333);
    assert.deepEqual([r.video.width, r.video.height, r.video.codec, r.video.frameRate, r.video.audio.codec, r.video.fastStart], [1280, 720, "h264", 24, "aac", false]);
  });

  it("rejects a clip, a padded or truncated video, missing audio, or other formats", () => {
    const bad: [string, VideoProbe][] = [
      ["3.5 s clip", probe({ durationSeconds: 3.5 })],
      ["two frames short", probe({ durationSeconds: SOURCE_SECONDS - 2 / 24 })],
      ["two frames long", probe({ durationSeconds: SOURCE_SECONDS + 2 / 24 })],
      ["no duration", probe({ durationSeconds: NaN })],
      ["no audio", probe({ audio: null })],
      ["other audio", probe({ audio: { codec: "opus", sampleRate: 48000, channels: 2 } })],
      ["720p only in name", probe({ video: { codec: "h264", width: 1920, height: 1080, frameCount: 481, frameRate: 24 } })],
      ["other codec", probe({ video: { codec: "hevc", width: 1280, height: 720, frameCount: 481, frameRate: 24 } })],
      ["other frame rate", probe({ video: { codec: "h264", width: 1280, height: 720, frameCount: 601, frameRate: 30 } })],
    ];
    for (const [name, p] of bad) assert.equal(validateFullSceneVideo(mp4(), p, req, SOURCE_SECONDS).ok, false, name);
    assert.equal(validateFullSceneVideo(mp4().subarray(0, 40), probe(), req, SOURCE_SECONDS).ok, false, "truncated");
  });
});

describe("Runway full-scene video: human visual review", () => {
  const reviewOf = (ctx: Awaited<ReturnType<typeof setup>>, over: Partial<Parameters<typeof recordVisualReview>[0]> = {}) =>
    recordVisualReview({ ...ctx.deps, fullScene: ctx.req, assetId: ctx.req.outputAssetId, decision: "approved-with-limitation", reasons: [ACCEPT_REASON], limitations: [FULL_SCENE_LIMITATION], reviewer: OWNER, ownerUserId: OWNER.id, ...over });

  it("records approved-with-limitation append-only, with the limitation verbatim", async () => {
    const ctx = await setup();
    assert.ok((await registerFullScene(ctx.deps, ctx.input, ctx.req)).ok);
    const before = await ctx.store.getMediaAsset(ctx.req.outputAssetId);
    const r = await reviewOf(ctx);
    assert.ok(r.ok && r.status === "created", JSON.stringify(r));
    assert.equal(r.review.decision, "approved-with-limitation");
    assert.deepEqual(r.review.limitations, ["Fine generated cup lettering shows minor temporal instability during motion."]);
    assert.equal(r.review.asset_checksum, ctx.req.outputChecksum);
    assert.deepEqual(await ctx.store.getMediaAsset(ctx.req.outputAssetId), before, "the asset record is unchanged");
    assert.equal(((before!.provenance) as FullSceneProvenance).humanVisualReview, "pending", "generation-time status is preserved");
    const again = await reviewOf(ctx);
    assert.ok(again.ok && again.status === "existing");
    assert.equal((await reviewOf(ctx, { decision: "approved", limitations: [] })).ok, false, "a different review is refused");
    assert.equal((await reviewOf(ctx, { limitations: ["Another limitation."] })).ok, false);
    await assert.rejects(ctx.store.updateMediaAsset(ctx.req.outputAssetId, { cost_usd: 0 }), IntegrityError, "reviewed media is immutable");
  });

  it("requires the limitation, records it exactly, and allows it only with that decision", async () => {
    const ctx = await setup();
    assert.ok((await registerFullScene(ctx.deps, ctx.input, ctx.req)).ok);
    assert.equal((await reviewOf(ctx, { limitations: [] })).ok, false, "no limitation");
    assert.equal((await reviewOf(ctx, { limitations: [` ${FULL_SCENE_LIMITATION}`] })).ok, false, "not verbatim");
    assert.equal((await reviewOf(ctx, { decision: "approved" })).ok, false, "limitation on a plain approval");
    assert.equal((await reviewOf(ctx, { reviewer: { ...OWNER, type: "Agent", role: "release-governor" } })).ok, false, "agent");
    assert.equal((await reviewOf(ctx, { fullScene: undefined })).ok, false, "only against the attempt it was registered for");
    await assert.rejects(
      ctx.store.insertVisualReview({ review_id: "y", asset_id: ctx.req.outputAssetId, case_id: CASE, decision: "approved-with-limitation", reasons: [], asset_checksum: ctx.req.outputChecksum, reviewer_user_id: OWNER.id, reviewer_name: "x" }),
      IntegrityError,
      "the store refuses a limitation decision without limitations",
    );
  });

  it("parses the review command's repeatable --limitation", () => {
    const parsed = parseReviewArgs([`--asset=${LUV_V4_RUNWAY.outputAssetId}`, "--decision=approved-with-limitation", `--reason=${ACCEPT_REASON}`, `--limitation=${FULL_SCENE_LIMITATION}`]);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.value.limitations, [FULL_SCENE_LIMITATION]);
    assert.equal(parsed.value.decision, "approved-with-limitation");
    assert.equal(parseReviewArgs([`--asset=${LUV_V4_RUNWAY.outputAssetId}`, "--decision=maybe"]).ok, false);
  });
});

describe("demo UI selection of the primary video", () => {
  const sum = `sha256:${"a".repeat(64)}`;
  const fullScene: DemoFullScene = {
    assetId: LUV_V4_RUNWAY.outputAssetId, label: FULL_SCENE_LABEL, disclosure: FULL_SCENE_DISCLOSURE, productionFinal: false, checksum: sum,
    durationSeconds: 20.041667, sourceDurationSeconds: SOURCE_SECONDS, width: 1280, height: 720, videoCodec: "h264", frameRate: 24, audioCodec: "aac",
    generator: "runway", model: "aleph2", taskId: LUV_V4_RUNWAY.taskId, chargedCredits: 308, costUsd: 3.08,
    sourceVideoChecksum: sum, referenceStillChecksum: sum, decision: "approved-with-limitation", reasons: [ACCEPT_REASON], limitations: [FULL_SCENE_LIMITATION], reviewedAt: "",
  };
  const media = (over: Partial<DemoMedia> = {}): DemoMedia[] => [
    { key: "preview-v3", file: "preview-v3.mp4", mimeType: "video/mp4", sha256: `sha256:${"b".repeat(64)}`, bytes: 1, verified: true, label: "p" },
    { key: "full-scene-v4", file: "full-scene-v4.mp4", mimeType: "video/mp4", sha256: sum, bytes: 1, verified: true, label: FULL_SCENE_LABEL, ...over },
  ];

  it("plays the complete v4 full-scene video as the primary output when verified and human-reviewed", () => {
    assert.deepEqual(selectPrimaryVideo({ fullScene, media: media() }), { mediaKey: "full-scene-v4", kind: "full-scene" });
  });

  it("falls back to the approved 3.5 s preview otherwise", () => {
    const fallback = { mediaKey: "preview-v3", kind: "fallback" };
    assert.deepEqual(selectPrimaryVideo({ fullScene: null, media: media() }), fallback, "older snapshot");
    assert.deepEqual(selectPrimaryVideo({ fullScene: undefined, media: media() }), fallback);
    assert.deepEqual(selectPrimaryVideo({ fullScene, media: media({ verified: false }) }), fallback, "bytes unverified");
    assert.deepEqual(selectPrimaryVideo({ fullScene, media: media({ sha256: `sha256:${"c".repeat(64)}` }) }), fallback, "different bytes");
    assert.deepEqual(selectPrimaryVideo({ fullScene: { ...fullScene, decision: "rejected" }, media: media() }), fallback, "rejected");
    assert.deepEqual(selectPrimaryVideo({ fullScene: { ...fullScene, decision: "pending" }, media: media() }), fallback, "not reviewed");
  });

  it("refuses a snapshot that relabels the preview or claims production-final output", () => {
    const check = (f: unknown) => validateDemoSnapshot({ version: 1, agents: Array(5).fill({}), case: {}, plan: {}, preview: {}, governor: {}, approval: {}, masky: {}, langsmith: {}, media: [], fullScene: f });
    assert.deepEqual(check(fullScene), []);
    assert.deepEqual(check(null), []);
    assert.ok(check({ ...fullScene, productionFinal: true }).length > 0);
    assert.ok(check({ ...fullScene, label: "Runway Aleph full-scene — final" }).length > 0);
    assert.ok(check({ ...fullScene, limitations: [] }).length > 0);
  });
});
