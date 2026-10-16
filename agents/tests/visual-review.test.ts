import assert from "node:assert/strict";
import { describe, it } from "node:test";
import sharp from "sharp";
import { validatePlacementPlan, type PlacementPlan } from "@/agents/handoff/placement-plan";
import { SOURCE_FRAME_DISCLOSURE } from "@/agents/handoff/source-frames";
import { loadVerifiedEditedStill, sha256Hex } from "@/agents/media/edited-still";
import type { ImageEditProvider, ProviderEditResult } from "@/agents/media/gemini-provider";
import { buildRevisedPlan, LUV_PLAN_V2 } from "@/agents/media/plan-revisions";
import { executeStillEdit, type StillEditRequest } from "@/agents/media/still-edit";
import { currentVisualDecision, recordVisualReview } from "@/agents/media/visual-review";
import type { PrivateStorage } from "@/agents/persistence/private-storage";
import { IntegrityError } from "@/agents/persistence/store";
import { canonical, staticFrameRegistry, WorkflowRegistry } from "@/agents/persistence/workflow";
import { validPlacementPlan } from "./fixtures";
import { MemoryWorkflowStore } from "./memory-store";

const CASE = "NF-DEMO-0001";
const VIDEO_ID = "asset:luv-hypothesis:source-video:v1";
const VIDEO_REF = "storage://nf-media/Luv-Hypothesis/Luv.mp4";
const VIDEO_SUM = `sha256:${"1".repeat(64)}`;
const FRAME_ID = "asset:luv-hypothesis:source-frame:luv-scene-1:v1";
const FRAME_REF = "storage://nf-media/frames/luv-hypothesis/luv-scene-1-8s.png";
const target = (v: "v1" | "v2"): StillEditRequest => ({
  planId: `plan:daybreak-cold-brew:luv-scene-1:${v}`,
  sourceFrameAssetId: FRAME_ID,
  sourceFrameStorageRef: FRAME_REF,
  outputAssetId: `asset:luv-hypothesis:edited-still:luv-scene-1:${v}`,
  outputStorageRef: `storage://nf-media/edits/luv-hypothesis/daybreak-cold-brew-luv-scene-1-${v}/edited-still-${v}.png`,
});
const OWNER = { id: "owner-user", type: "User", role: null, name: "NativeFrame project owner" };
const REASONS = ["The inserted cup hides part of the woman's left forearm and sweater sleeve.", "The inserted cup is about 20–25% taller than the existing cups."];
const image = (w: number, h: number, shade = 120) => sharp({ create: { width: w, height: h, channels: 3, background: { r: shade, g: 90, b: 60 } } }).png().toBuffer();

class MemoryPrivateStorage implements PrivateStorage {
  readonly objects = new Map<string, Uint8Array>();
  async download(ref: string) {
    return this.objects.get(ref) ?? null;
  }
  async uploadNew(ref: string, bytes: Uint8Array) {
    if (this.objects.has(ref)) return "exists" as const;
    this.objects.set(ref, new Uint8Array(bytes));
    return "created" as const;
  }
}
const provider = (shade: number): ImageEditProvider & { calls: number; prompts: string[] } => {
  const p = {
    provider: "google-gemini" as const,
    model: "gemini-nano-banana-2.1",
    calls: 0,
    prompts: [] as string[],
    async edit(input: { prompt: string }): Promise<ProviderEditResult> {
      p.calls++;
      p.prompts.push(input.prompt);
      return { responseId: `r${p.calls}`, images: [{ mimeType: "image/png", data: await image(1376, 768, shade) }], text: null, usage: null };
    },
  };
  return p;
};

/** Registry seeded like production, with plan v1 persisted and edited still v1 generated. */
async function setup() {
  const store = new MemoryWorkflowStore();
  const workflow = new WorkflowRegistry(store);
  const storage = new MemoryPrivateStorage();
  const frame = await image(1280, 720);
  const frameSum = `sha256:${sha256Hex(frame)}`;
  await store.ensureCase({ case_id: CASE, title_id: "luv-hypothesis", status: "open" });
  await store.insertMediaAsset({ asset_id: VIDEO_ID, case_id: CASE, plan_id: null, kind: "source-video", storage_ref: VIDEO_REF, mime_type: "video/mp4", duration_seconds: 20.064, generator: null, model: null, generated_at: null, latency_ms: null, cost_usd: null, checksum: VIDEO_SUM, provenance: { titleId: "luv-hypothesis" } });
  await store.insertMediaAsset({ asset_id: FRAME_ID, case_id: CASE, plan_id: null, kind: "source-frame", storage_ref: FRAME_REF, mime_type: "image/png", duration_seconds: null, generator: null, model: null, generated_at: null, latency_ms: null, cost_usd: null, checksum: frameSum, provenance: { sourceAssetId: VIDEO_ID, sourceStorageRef: VIDEO_REF, sourceChecksum: VIDEO_SUM, sceneId: "luv-scene-1", timestampSeconds: 8 } });
  storage.objects.set(FRAME_REF, frame);
  const v1 = validPlacementPlan({ sourceMedia: { kind: "registered-source-frame", isSceneFrame: true, assetId: FRAME_ID, storageRef: FRAME_REF, checksum: frameSum, sourceAssetId: VIDEO_ID, timestampSeconds: 8, note: SOURCE_FRAME_DISCLOSURE } as PlacementPlan["sourceMedia"] });
  assert.equal((await workflow.savePlan(v1)).ok, true);
  const first = await executeStillEdit(target("v1"), { workflow, store, storage, provider: provider(150) });
  assert.ok(first.ok, JSON.stringify(first));
  return { store, workflow, storage, v1 };
}
const review = (ctx: Awaited<ReturnType<typeof setup>>, over: Partial<Parameters<typeof recordVisualReview>[0]> = {}) =>
  recordVisualReview({ workflow: ctx.workflow, store: ctx.store, assetId: target("v1").outputAssetId, decision: "rejected", reasons: REASONS, reviewer: OWNER, ownerUserId: OWNER.id, ...over });

describe("human visual review of edited stills", () => {
  it("records the owner's rejection append-only, leaving the v1 record unchanged and valid", async () => {
    const ctx = await setup();
    const before = await ctx.store.getMediaAsset(target("v1").outputAssetId);
    const r = await review(ctx);
    assert.ok(r.ok && r.status === "created" && r.review.decision === "rejected" && r.review.asset_checksum === before!.checksum);
    assert.deepEqual(await ctx.store.getMediaAsset(target("v1").outputAssetId), before, "v1 media record untouched");
    assert.equal((await loadVerifiedEditedStill(ctx.workflow, ctx.store, target("v1").outputAssetId)).ok, true, "v1 still revalidates");
    assert.equal(await currentVisualDecision(ctx.store, target("v1").outputAssetId), "rejected");
    assert.equal((before!.provenance as { humanVisualReview: string }).humanVisualReview, "pending", "generation-time status is preserved");
  });

  it("is idempotent for the identical review and refuses a different one", async () => {
    const ctx = await setup();
    await review(ctx);
    const again = await review(ctx);
    assert.ok(again.ok && again.status === "existing");
    assert.equal((await review(ctx, { decision: "approved", reasons: [] })).ok, false);
    assert.equal((await review(ctx, { reasons: ["A different reason."] })).ok, false);
  });

  it("accepts reviews only from the human owner, with reasons for a rejection, of a valid edited still", async () => {
    const ctx = await setup();
    assert.equal((await review(ctx, { reviewer: { ...OWNER, type: "Agent", role: "release-governor" } })).ok, false, "agent");
    assert.equal((await review(ctx, { reviewer: { ...OWNER, id: "someone-else" } })).ok, false, "another human");
    assert.equal((await review(ctx, { reasons: [] })).ok, false, "rejection without reasons");
    assert.equal((await review(ctx, { assetId: FRAME_ID })).ok, false, "not an edited still");
    ctx.store.tamper("media", target("v1").outputAssetId, { checksum: `sha256:${"9".repeat(64)}` });
    assert.equal((await review(ctx)).ok, false, "a record that no longer revalidates");
  });

  it("makes the reviewed asset immutable and rejects a review naming the wrong checksum", async () => {
    const ctx = await setup();
    await assert.rejects(ctx.store.insertVisualReview({ review_id: "x", asset_id: target("v1").outputAssetId, case_id: CASE, decision: "rejected", reasons: REASONS, asset_checksum: `sha256:${"8".repeat(64)}`, reviewer_user_id: OWNER.id, reviewer_name: "x" }), IntegrityError);
    await review(ctx);
    await assert.rejects(ctx.store.updateMediaAsset(target("v1").outputAssetId, { mime_type: "image/png" }), IntegrityError);
  });
});

describe("human-directed plan v2 and edited still v2", () => {
  it("builds v2 from persisted v1, changing only the still prompt, placement description, and one assumption", async () => {
    const { v1, workflow } = await setup();
    const v2 = buildRevisedPlan(v1, LUV_PLAN_V2);
    const strip = (p: PlacementPlan) => ({ ...p, planId: "", placement: { ...p.placement, description: "" }, prompts: { ...p.prompts, stillImageEdit: { ...p.prompts.stillImageEdit, prompt: "" } }, assumptions: [] });
    assert.equal(canonical(strip(v2)), canonical(strip(v1)), "nothing else changes");
    assert.deepEqual(v2.assumptions, [...v1.assumptions, LUV_PLAN_V2.assumption]);
    assert.equal(v2.prompts.stillImageEdit.status, "not-executed");
    const frames = staticFrameRegistry(CASE, "luv-scene-1", await workflow.loadSourceFramesForScene(CASE, "luv-scene-1"));
    assert.deepEqual(validatePlacementPlan(v2, CASE, frames), []);
    assert.throws(() => buildRevisedPlan({ ...v1, planId: "plan:x:y:v1" }, LUV_PLAN_V2));
  });

  it("edits v2 once with its own exact prompt into its own asset and path, never touching v1", async () => {
    const ctx = await setup();
    await review(ctx);
    const v1Before = await ctx.store.getMediaAsset(target("v1").outputAssetId);
    const v1Bytes = ctx.storage.objects.get(target("v1").outputStorageRef);
    const v2 = buildRevisedPlan(ctx.v1, LUV_PLAN_V2);
    assert.equal((await ctx.workflow.savePlan(v2)).ok, true);
    const p = provider(60);
    const r = await executeStillEdit(target("v2"), { workflow: ctx.workflow, store: ctx.store, storage: ctx.storage, provider: p });
    assert.ok(r.ok && r.status === "created" && r.assetId === target("v2").outputAssetId, JSON.stringify(r));
    assert.equal(p.calls, 1);
    assert.equal(p.prompts[0], LUV_PLAN_V2.stillPrompt);
    const v2Record = await loadVerifiedEditedStill(ctx.workflow, ctx.store, target("v2").outputAssetId);
    assert.ok(v2Record.ok && (v2Record.row.provenance as { humanVisualReview: string }).humanVisualReview === "pending");
    assert.equal(await currentVisualDecision(ctx.store, target("v2").outputAssetId), "pending");
    assert.deepEqual(await ctx.store.getMediaAsset(target("v1").outputAssetId), v1Before);
    assert.deepEqual(ctx.storage.objects.get(target("v1").outputStorageRef), v1Bytes);
    assert.equal(await currentVisualDecision(ctx.store, target("v1").outputAssetId), "rejected");
    const plan1 = await ctx.workflow.loadPlan(ctx.v1.planId);
    assert.ok(plan1.ok && canonical(plan1.value) === canonical(ctx.v1), "plan v1 unchanged");
  });
});
